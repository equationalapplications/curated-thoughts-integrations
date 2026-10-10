/**
 * index.ts — the OpenCode plugin entry point (spec §3 + 2026-10-09
 * cross-harness parity, OpenCode leg).
 *
 * Exports exactly one runtime binding, the named `CuratedThoughts` plugin.
 * No default export and no `{ server }` module form: OpenCode 1.18.31
 * invokes only `server` when a module has one and ignores the named export
 * (tests/host/compatibility.json → findings.exportForms).
 *
 * Hooks (per-host adapter contract, spec table — do not re-derive):
 *   - `experimental.chat.system.transform` — v0 health block (unchanged).
 *   - `chat.message`                       — N1 trigger + N2 delivery: the
 *     same invocation appends a `synthetic: true` text part carrying the
 *     wisdom block. The part is persisted by the host, so the ledger reads
 *     it back from the persisted history (decision 3; the wire-only
 *     `experimental.chat.messages.transform` is NOT the delivery channel).
 *   - `tool.execute.after`                 — N3: rewrite CT recall envelopes
 *     in the tool's persisted output (stub repeats + ct-fact trailers).
 *   - `experimental.session.compacting`    — decision 3 carry-forward:
 *     invalidate the advisory bootstrap memo and the turn cache so the next
 *     N1 rebuild reads the post-compaction history (surviving summary ids
 *     stay known; dropped ids are forgotten).
 *
 * Known caveat (accepted, per decision 3's aux-call note): auxiliary LLM
 * calls such as title generation re-read the session and will see delivered
 * wisdom parts. `experimental.chat.messages.transform` input carries no
 * primary/auxiliary signal (verified: `input: {}` in the 1.18.31 SDK), so no
 * wire-only suppression is attempted — a wrong guess there could strip the
 * block from a PRIMARY call, which would break delivery itself. Aux visibility
 * has no exactly-once impact: the ledger and the budget read the persisted
 * history, not the wire view.
 *
 * No `event` hook: 1.18.31 delivers no MCP status event to plugins
 * (findings.mcpStatusEvents = false), so `connection` stays honestly
 * 'unknown'. No skill registration either — OpenCode has no skill hook.
 *
 * Runtime imports: `@equational-applications/ct-wisdom-core` (vendored core;
 * `file:` dep — pnpm copies it at INSTALL time, so CI builds the core before
 * this package's install). `@opencode-ai/plugin` is types-only.
 */

import type { Plugin, PluginOptions } from '@opencode-ai/plugin';
import { Breaker } from '@equational-applications/ct-wisdom-core';
import { ENV_BRAIN_DIR, resolveBrainPaths } from '../scripts/ct_env.js';
import { formatStatusBlock, isStatusBlock } from './format.js';
import { createHealthCache } from './refresh.js';
import {
  OpenCodeWisdomAdapter,
  isRecallToolName,
  runToolResult,
  runUserTurn,
  userMessageText,
  type HistoryRow,
} from './wisdom-live/adapter.js';
import { keyOf, renderWisdom } from './wisdom.js';

/**
 * Brain dir precedence: options.brainDir → CURATED_BRAIN_DIR → ~/.brain.
 * The override is applied to a copy of the environment; process.env is never
 * mutated.
 */
function resolveEnv(options: PluginOptions | undefined): NodeJS.ProcessEnv {
  const brainDir = options?.['brainDir'];
  if (typeof brainDir === 'string' && brainDir.trim() !== '') {
    return { ...process.env, [ENV_BRAIN_DIR]: brainDir };
  }
  return { ...process.env };
}

/** Marker of OUR synthetic parts (identity + provenance in one string). */
const WISDOM_PART_MARKER = 'source.kind: curated-thoughts/wisdom';

function isWisdomPart(part: unknown): boolean {
  return (
    part !== null &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    (part as { synthetic?: unknown }).synthetic === true &&
    typeof (part as { text?: unknown }).text === 'string' &&
    (part as { text: string }).text.includes(WISDOM_PART_MARKER)
  );
}

/** One synthetic text part bound to the message being assembled. */
function wisdomPart(sessionID: string, messageID: string, id: string, block: string) {
  return {
    id,
    sessionID,
    messageID,
    type: 'text' as const,
    text: `${block}\n\n${WISDOM_PART_MARKER}`,
    synthetic: true,
  };
}

export const CuratedThoughts: Plugin = async (input, options) => {
  // Options arrive as the SECOND argument, only from the tuple form in config.
  // The v0 loader-file install passes none: `options === undefined` is the
  // primary path.
  const env = resolveEnv(options);
  const { brainDir } = resolveBrainPaths(env);

  // Lazy, bounded, fail-open. Nothing is probed until the first prompt.
  const cache = createHealthCache({ env, cwd: input.directory });

  // ── Wisdom live delivery (v1 bootstrap block + N1/N2/N3 + ledger) ──────
  const wisdomAdapter = new OpenCodeWisdomAdapter({
    env,
    fetchHistory: async (sessionId) => {
      // The persisted history IS the ledger record (host contract): the
      // {info, parts} rows of the session, oldest first. Any failure is a
      // null → empty ledger (fail-open); the core tolerates it.
      const res = await input.client.session.messages({
        path: { id: sessionId },
        query: { directory: input.directory },
      });
      if (res.error !== undefined) return null;
      const data: unknown = res.data;
      return Array.isArray(data) ? (data as HistoryRow[]) : null;
    },
  });
  const wisdomBreakers = new Map<string, Breaker>();
  const breakerFor = (sessionId: string): Breaker => {
    const existing = wisdomBreakers.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Breaker();
    wisdomBreakers.set(sessionId, created);
    // LRU-bounded like the adapter's turn cache.
    if (wisdomBreakers.size > 256) {
      const oldest = wisdomBreakers.keys().next();
      if (!oldest.done) wisdomBreakers.delete(oldest.value);
    }
    return created;
  };

  return {
    'experimental.chat.system.transform': async ({ sessionID }, output) => {
      // Session-less (auxiliary) calls neither refresh nor inject. Note: in
      // 1.18.31 the title-generation call also carries a sessionID, so this
      // guard does not exclude it; accepted for v0.
      if (!sessionID) return;

      // Fire-and-forget: the prompt path never awaits a filesystem probe.
      cache.requestRefresh();

      // Additive and idempotent: existing entries are never rewritten, and a
      // block already present is not appended twice.
      if (output.system.some(isStatusBlock)) return;
      output.system.push(formatStatusBlock(cache.current(), { brainDir }));
    },

    // ── N1 + N2: pre-LLM, once per turn, persisted append ─────────────────
    'chat.message': async ({ sessionID, agent }, output) => {
      if (!sessionID) return;
      try {
        // Idempotence guard: chat.message must deliver at most one wisdom
        // part per message, even if the host re-fires the hook.
        if (output.parts.some(isWisdomPart)) return;

        // v1 bootstrap block: seed-query recall memoized per agent (N5).
        // Runs BEFORE the live turn so a fresh agent still sees its memory;
        // the memo record joins the ledger via bootstrapIdsFor.
        const memoKey = keyOf({ agent }) || 'default';
        let memoRecord = wisdomAdapter.bootstrapMemo[sessionID];
        if (memoRecord === undefined) {
          const block = renderWisdom({ agent }, { env });
          memoRecord = { block, ids: [] };
          wisdomAdapter.bootstrapMemo[sessionID] = memoRecord;
          if (block !== '') {
            output.parts.push(
              wisdomPart(
                sessionID,
                output.message.id,
                `ctboot_${sessionID}_${memoKey}`,
                block,
              ),
            );
          }
        }

        // m5/m1: the ledger rebuild reads the PERSISTED history — never the
        // in-flight payload — and is cached before any early return.
        await wisdomAdapter.rebuildLedgerAsync({ id: sessionID });

        const query = userMessageText(output.parts);
        const block = await runUserTurn(
          wisdomAdapter,
          { id: sessionID },
          query,
          breakerFor(sessionID),
        );
        if (block !== null && block.trim() !== '') {
          // N2: persisted append — synthetic text part on THIS message.
          output.parts.push(
            wisdomPart(
              sessionID,
              output.message.id,
              `ctwisdom_${sessionID}_${output.parts.length}`,
              block,
            ),
          );
        }
      } catch {
        // Fail-open: a wisdom failure must never break the user's turn.
      }
    },

    // ── N3: CT recall envelope dedup on the persisted tool output ─────────
    'tool.execute.after': async ({ sessionID, tool }, output) => {
      if (!sessionID) return;
      try {
        // m4: N3 fires on the CT recall surface only.
        if (!isRecallToolName(tool)) return;
        const rewritten = runToolResult(
          wisdomAdapter,
          { id: sessionID },
          output.output,
        );
        if (typeof rewritten === 'string' && rewritten !== output.output) {
          output.output = rewritten;
        }
      } catch {
        // Fail-open: leave the tool result untouched on any error.
      }
    },

    // ── Decision 3 carry-forward: compaction invalidation ──────────────────
    'experimental.session.compacting': async ({ sessionID }) => {
      if (!sessionID) return;
      // The summary may drop the bootstrap block and prior deliveries: the
      // advisory memo bootstrap ids must not survive it. The next N1 rebuild
      // reads the post-compaction history — ids the summary preserved stay
      // known (no redelivery); dropped ids are forgotten.
      wisdomAdapter.beginCompaction(sessionID);
    },

    dispose: async () => {
      cache.dispose();
    },
  };
};

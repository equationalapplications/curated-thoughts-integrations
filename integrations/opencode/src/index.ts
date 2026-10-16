/**
 * index.ts — the OpenCode plugin entry point (spec §3 + 2026-10-09
 * cross-harness parity, OpenCode leg).
 *
 * Exports exactly one runtime binding, the named `CuratedThoughts` plugin.
 * No default export and no `{ server }` module form: OpenCode 1.18.31
 * invokes only `server` when a module has one and ignores the named export
 * (tests/host/compatibility.json → findings.exportForms).
 *
 * Hooks (parent spec OpenCode row, refined by the leg spec
 * docs/superpowers/specs/2026-10-16-opencode-wisdom-parity-leg-design.md):
 *   - `experimental.chat.system.transform` — v0 health block (unchanged).
 *   - `chat.message`                       — N1 trigger + N2 delivery: the
 *     same invocation pushes `synthetic: true` text parts (v1 bootstrap on the
 *     session's first turn, then the live block). The host persists them
 *     after the hook returns (H1), and the ledger reads them back from the
 *     persisted history (decision 3; the wire-only
 *     `experimental.chat.messages.transform` is NOT the delivery channel).
 *   - `tool.execute.after`                 — N3: rewrite CT recall envelopes
 *     inside the MCP CallToolResult `content[].text` the host persists (H5).
 *   - `experimental.session.compacting`    — decision 3 carry-forward:
 *     snapshot the pre-compaction ledger; it is never forgotten.
 *
 * Known caveat (accepted, per decision 3's aux-call note): auxiliary LLM
 * calls such as title generation re-read the session and will see delivered
 * wisdom parts. `experimental.chat.messages.transform` input carries no
 * primary/auxiliary signal (`input: {}`), so no wire-only suppression is
 * attempted — a wrong guess there could strip the block from a PRIMARY call.
 * Aux visibility has no exactly-once impact: the ledger and the budget read
 * the persisted history, not the wire view.
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
  BOOT_MARKER,
  LIVE_MARKER,
  OpenCodeWisdomAdapter,
  isOurPart,
  isRecallToolName,
  partId,
  runToolResult,
  runUserTurn,
  userQueryText,
  type HistoryRow,
} from './wisdom-live/adapter.js';
import { renderWisdom } from './wisdom.js';

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

/** One synthetic text part bound to the message being assembled (LD9 id). */
function wisdomPart(sessionID: string, messageID: string, block: string, markerLine: string) {
  return {
    id: partId(),
    sessionID,
    messageID,
    type: 'text' as const,
    text: `${block}\n\n${markerLine}`,
    synthetic: true,
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
    fetchSession: async (sessionId) => {
      // LD7: `parentID` marks a subagent (child) session. A failed lookup is
      // null → treated as a child (fail-safe: no delivery).
      const res = await input.client.session.get({
        path: { id: sessionId },
        query: { directory: input.directory },
      });
      if (res.error !== undefined) return null;
      const data: unknown = res.data;
      return isObj(data) ? (data as { parentID?: unknown }) : null;
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
    'chat.message': async ({ sessionID }, output) => {
      if (!sessionID) return;
      try {
        // LD8 (AC 11): one delivery per message even if the host re-fires.
        if (output.parts.some(isOurPart)) return;
        const session = { id: sessionID };
        const kind = await wisdomAdapter.sessionKind(sessionID);
        // m1/m5: rebuild from the PERSISTED history (child: ∪ parent) and
        // cache it for N3 before any early return.
        await wisdomAdapter.rebuildLedgerAsync(session);
        if (kind !== 'parent') return; // LD7: parent-only delivery
        // LD8: genuine user text only; an all-synthetic message is a no-op.
        const query = userQueryText(output.parts);
        if (query.trim() === '') return;
        const messageID = output.message.id;

        // LD4: v1 bootstrap on the session's FIRST turn only — later turns and
        // later processes find its ids in the persisted history.
        if (
          wisdomAdapter.bootstrapMemo[sessionID] === undefined &&
          !wisdomAdapter.hasUserHistory(sessionID)
        ) {
          const boot = renderWisdom({ agent: { id: sessionID } }, { env });
          wisdomAdapter.setBootstrap(sessionID, boot);
          if (boot !== '') output.parts.push(wisdomPart(sessionID, messageID, boot, BOOT_MARKER));
          // Memo ids join THIS turn's ledger before the live call.
          await wisdomAdapter.rebuildLedgerAsync(session);
        }

        const block = await runUserTurn(wisdomAdapter, session, query, breakerFor(sessionID));
        if (block !== null && block.trim() !== '') {
          output.parts.push(wisdomPart(sessionID, messageID, block, LIVE_MARKER));
        }
      } catch {
        // Fail-open: a wisdom failure must never break the user's turn.
      }
    },

    // ── N3: CT recall envelope dedup on the persisted tool output ─────────
    'tool.execute.after': async ({ sessionID, tool }, output) => {
      if (!sessionID) return;
      try {
        if (!isRecallToolName(tool)) return; // m4
        const session = { id: sessionID };
        if (wisdomAdapter.cachedLedger(session) === null) {
          await wisdomAdapter.sessionKind(sessionID);
          await wisdomAdapter.rebuildLedgerAsync(session);
        }
        // H5: for MCP tools the hook output is the CallToolResult; the host
        // derives the persisted text from `content` AFTER this hook.
        const raw = output as unknown;
        if (isObj(raw) && Array.isArray(raw.content)) {
          const rewritten = runToolResult(wisdomAdapter, session, raw);
          if (rewritten !== raw && isObj(rewritten) && Array.isArray(rewritten.content)) {
            raw.content = rewritten.content;
          }
        } else if (isObj(raw) && typeof raw.output === 'string') {
          const rewritten = runToolResult(wisdomAdapter, session, raw.output);
          if (typeof rewritten === 'string') raw.output = rewritten;
        }
      } catch {
        // Fail-open: leave the tool result untouched on any error.
      }
    },

    // ── Decision 3 carry-forward ──────────────────────────────────────────
    'experimental.session.compacting': async ({ sessionID }) => {
      if (!sessionID) return;
      try {
        await wisdomAdapter.snapshotForCompaction(sessionID);
      } catch {
        // Fail-open: compaction must proceed regardless.
      }
    },

    dispose: async () => {
      cache.dispose();
    },
  };
};

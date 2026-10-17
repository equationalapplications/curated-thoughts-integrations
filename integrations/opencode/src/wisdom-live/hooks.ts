/**
 * wisdom-live/hooks.ts — the OpenCode wisdom hooks (N1+N2 on
 * `chat.message`, N3 on `tool.execute.after`, decision-3 carry-forward on
 * `experimental.session.compacting`, and autonomous-work delivery planned on
 * `tool.execute.before` and delivered on `tool.execute.after`), built around
 * one OpenCodeWisdomAdapter. index.ts wires the host client into the
 * fetchers; tests inject spawns and the bootstrap renderer. Leg spec
 * 2026-10-16: LD1, LD2, LD4, LD5, LD7, LD8; activity: spec 2026-10-17.
 */

import type { Hooks } from '@opencode-ai/plugin';
import { Breaker } from '@equational-applications/ct-wisdom-core';
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
  type AdapterDeps,
} from './adapter.js';
import { renderWisdom } from '../wisdom.js';
import { OpenCodeActivity } from './activity.js';

export type WisdomHooks = Required<
  Pick<Hooks, 'chat.message' | 'tool.execute.before' | 'tool.execute.after' | 'experimental.session.compacting'>
>;

export interface WisdomHooksDeps extends AdapterDeps {
  /** v1 bootstrap renderer (tests); defaults to the DSH-parity renderWisdom. */
  renderBootstrap?: (sessionId: string) => string;
  /** Activity budget (tests); default TIMEOUT_MS. */
  budgetMs?: number;
  /** Activity debug lines (tests); unwired in index.ts. */
  log?: (line: string) => void;
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

export function createWisdomHooks(deps: WisdomHooksDeps): {
  adapter: OpenCodeWisdomAdapter;
  activity: OpenCodeActivity;
  hooks: WisdomHooks;
} {
  const { env } = deps;
  const wisdomAdapter = new OpenCodeWisdomAdapter(deps);
  const renderBootstrap =
    deps.renderBootstrap ?? ((sessionId: string) => renderWisdom({ agent: { id: sessionId } }, { env }));
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
  // Autonomous-work delivery shares the adapter (CT capability, N3 cache,
  // verbose recorder) and each session's breaker with the user-turn path.
  const activity = new OpenCodeActivity({
    adapter: wisdomAdapter,
    breakerFor,
    env,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.budgetMs !== undefined ? { budgetMs: deps.budgetMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });

  const hooks: WisdomHooks = {
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
          const boot = renderBootstrap(sessionID);
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

    // ── Autonomous work: plan only (OpenCode asks permission AFTER this) ──
    'tool.execute.before': async (input, output) => {
      if (!input?.sessionID) return;
      try {
        await activity.plan(input, output?.args);
      } catch {
        // Fail-open: planning never changes or blocks a tool call.
      }
    },

    // ── N3: CT recall envelope dedup on the persisted tool output; else
    //    autonomous-work delivery (the call was approved: a refused ask
    //    never reaches this hook) ─────────────────────────────────────────
    'tool.execute.after': async (input, output) => {
      const { sessionID, tool } = input ?? ({} as typeof input);
      if (!sessionID) return;
      try {
        if (!isRecallToolName(tool)) {
          await activity.deliver(input, output);
          return;
        }
        const session = { id: sessionID };
        // m2: the stub decision reads a FRESH persisted-history view (a
        // child's cache can predate deliveries its parent received since),
        // unioned with the turn cache's not-yet-persisted same-turn ids.
        await wisdomAdapter.sessionKind(sessionID);
        await wisdomAdapter.refreshForToolResult(session);
        // H5: for MCP tools the hook output is the CallToolResult; the host
        // derives the persisted text from `content` AFTER this hook.
        const raw = output as unknown;
        // The ids this result shows join the not-yet-persisted set, so a
        // parallel activity delivery of the same step cannot repeat them.
        wisdomAdapter.noteUnpersisted(
          sessionID,
          wisdomAdapter.envelopeFactIds(isObj(raw) && !Array.isArray(raw.content) ? raw.output : raw),
          typeof input.callID === 'string' ? input.callID : null,
        );
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

  };
  return { adapter: wisdomAdapter, activity, hooks };
}

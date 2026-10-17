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
import { ENV_BRAIN_DIR, resolveBrainPaths } from '../scripts/ct_env.js';
import { formatStatusBlock, isStatusBlock } from './format.js';
import { createHealthCache } from './refresh.js';
import type { HistoryRow } from './wisdom-live/adapter.js';
import { isObj } from './obj.js';
import { opencodeVerboseRecorder } from './verbose.js';
import { createWisdomHooks } from './wisdom-live/hooks.js';

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

export const CuratedThoughts: Plugin = async (input, options) => {
  // Options arrive as the SECOND argument, only from the tuple form in config.
  // The v0 loader-file install passes none: `options === undefined` is the
  // primary path.
  const env = resolveEnv(options);
  const { brainDir } = resolveBrainPaths(env);

  // Lazy, bounded, fail-open. Nothing is probed until the first prompt.
  const cache = createHealthCache({ env, cwd: input.directory });

  // ── Wisdom live delivery (v1 bootstrap block + N1/N2/N3 + ledger) ──────
  const { hooks: wisdomHooks } = createWisdomHooks({
    env,
    recordVerbose: opencodeVerboseRecorder(input.client, input.directory, env),
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

    ...wisdomHooks,

    dispose: async () => {
      cache.dispose();
    },
  };
};

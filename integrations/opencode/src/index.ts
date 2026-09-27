/**
 * index.ts — the OpenCode plugin entry point (spec §3).
 *
 * Exports exactly one runtime binding, the named `CuratedThoughts` plugin.
 * No default export and no `{ server }` module form: OpenCode 1.18.31 invokes
 * only `server` when a module has one and ignores the named export
 * (tests/host/compatibility.json → findings.exportForms).
 *
 * No `event` hook: 1.18.31 delivers no MCP status event to plugins
 * (findings.mcpStatusEvents = false), so `connection` stays honestly
 * 'unknown'. No skill registration either — OpenCode has no skill hook.
 *
 * Zero third-party runtime imports: `@opencode-ai/plugin` is used for types
 * only and is erased at compile time. The payload ships without node_modules.
 */

import type { Plugin, PluginOptions } from '@opencode-ai/plugin';
import { ENV_BRAIN_DIR, resolveBrainPaths } from '../scripts/ct_env.js';
import { formatStatusBlock, isStatusBlock } from './format.js';
import { createHealthCache } from './refresh.js';

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

    dispose: async () => {
      cache.dispose();
    },
  };
};

/**
 * verbose.ts — DeepSeek Harness wiring for Intuitive Wisdom verbose mode
 * (spec docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md).
 */

import {
  createVerboseRecorder,
  defaultVerboseLogPath,
  type VerboseTurn,
} from '@equational-applications/ct-wisdom-core';

/**
 * Verbose mode (spec 2026-10-16-wisdom-verbose-mode-design.md, D3/D4): with
 * CT_WISDOM_VERBOSE on, each live-delivery decision goes to the plugin's named
 * cordis logger (`ctx.logger('curated-thoughts')`, never the session) and to
 * $DSH_HOME/logs/ct-wisdom-verbose.jsonl. Undefined when off.
 */
export function dshVerboseRecorder(
  ctx: unknown,
  env: NodeJS.ProcessEnv,
): ((turn: VerboseTurn) => void) | undefined {
  return createVerboseRecorder({
    host: 'deepseek',
    channel: 'agent/pre-step',
    env,
    logPath: defaultVerboseLogPath('deepseek', env),
    notify: (text) => {
      const factory = (ctx as { logger?: unknown } | null)?.logger;
      if (typeof factory !== 'function') return;
      const named = (factory as (name: string) => { info?: (m: string) => void } | undefined).call(
        ctx,
        'curated-thoughts',
      );
      named?.info?.(text);
    },
  });
}

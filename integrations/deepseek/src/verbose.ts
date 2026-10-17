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
  logger: NamedLogger = namedLogger(ctx),
): ((turn: VerboseTurn) => void) | undefined {
  return createVerboseRecorder({
    host: 'deepseek',
    channel: 'agent/pre-step',
    env,
    logPath: defaultVerboseLogPath('deepseek', env),
    notify: (text) => logger.info(text),
  });
}

export interface NamedLogger {
  info(message: string): void;
  debug(message: string): void;
}

/**
 * The plugin's named cordis logger (`ctx.logger('curated-thoughts')`),
 * looked up on first use and reused once a lookup succeeds. A failed lookup
 * (no factory yet, a throw, no logger) is not cached, so the next call
 * retries. Every failure is a quiet no-op (INTENT rule 4).
 */
export function namedLogger(ctx: unknown): NamedLogger {
  type Logger = { info?: (m: string) => void; debug?: (m: string) => void };
  let resolved: Logger | null = null;
  const get = (): Logger | null => {
    if (resolved !== null) return resolved;
    try {
      const factory = (ctx as { logger?: unknown } | null)?.logger;
      if (typeof factory === 'function') {
        const out = (factory as (name: string) => Logger | null | undefined).call(ctx, 'curated-thoughts');
        if (out !== null && typeof out === 'object') resolved = out;
      }
    } catch {
      /* not cached: retried on the next call */
    }
    return resolved;
  };
  const call = (level: 'info' | 'debug', message: string) => {
    try {
      get()?.[level]?.(message);
    } catch {
      /* fail quietly */
    }
  };
  return { info: (m) => call('info', m), debug: (m) => call('debug', m) };
}

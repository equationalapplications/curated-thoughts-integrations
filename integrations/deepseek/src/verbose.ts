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
 * looked up once on first use and reused. A missing or throwing factory is
 * a quiet no-op (INTENT rule 4).
 */
export function namedLogger(ctx: unknown): NamedLogger {
  let resolved: { info?: (m: string) => void; debug?: (m: string) => void } | null | undefined;
  const get = () => {
    if (resolved === undefined) {
      resolved = null;
      try {
        const factory = (ctx as { logger?: unknown } | null)?.logger;
        if (typeof factory === 'function') {
          resolved = ((factory as (name: string) => typeof resolved).call(ctx, 'curated-thoughts')) ?? null;
        }
      } catch {
        resolved = null;
      }
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

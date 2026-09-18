/**
 * refresh.ts — lazy, bounded, fail-open health cache for the prompt path.
 *
 * The system-prompt hook reads `current()` synchronously and calls
 * `requestRefresh()` without awaiting it. A refresh:
 *
 * - runs at most once at a time per plugin instance (concurrent requests
 *   share the in-flight one);
 * - is skipped while the last attempt is inside the 30s freshness window;
 * - is abandoned after 2s (`AbortSignal.timeout`), keeping the previous value;
 * - never throws into the caller — probe errors keep the previous value.
 *
 * Zero third-party runtime imports: Node builtins and relative modules only.
 */

import { probeLocal, type LocalReadiness, type LocalSnapshot } from './status.js';

export interface HealthSnapshot {
  local: 'ready' | 'degraded' | 'unknown';
  connection: 'connected' | 'disabled' | 'failed' | 'unknown';
  preflight: 'not-checked';
  stale: boolean;
}

export interface HealthCache {
  current(): HealthSnapshot;
  requestRefresh(): void;
  dispose(): void;
}

/** A refresh that has not settled by this deadline is abandoned. */
export const REFRESH_DEADLINE_MS = 2_000;
/** A value (or failed attempt) younger than this is not re-probed. */
export const FRESHNESS_MS = 30_000;

export type LocalProbe = (
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
) => Promise<LocalSnapshot>;

export interface HealthCacheOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Injectable for tests; defaults to `probeLocal`. */
  probe?: LocalProbe;
}

export function createHealthCache(opts: HealthCacheOptions): HealthCache {
  const probe = opts.probe ?? probeLocal;

  let local: LocalReadiness = 'unknown';
  let lastSuccessAt: number | null = null;
  let lastAttemptAt: number | null = null;
  let inFlight: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | null =
    null;
  let disposed = false;

  function isFresh(since: number | null, now: number): boolean {
    return since !== null && now - since < FRESHNESS_MS;
  }

  function settle(run: NonNullable<typeof inFlight>): boolean {
    // Only the current, un-disposed run may write; a late or abandoned
    // result is dropped on the floor.
    if (disposed || inFlight !== run) return false;
    clearTimeout(run.timer);
    inFlight = null;
    lastAttemptAt = Date.now();
    return true;
  }

  function startRefresh(): void {
    const controller = new AbortController();
    // The 2s deadline: AbortSignal.timeout tells a cooperative probe to stop;
    // the timer below abandons a probe that ignores its signal.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REFRESH_DEADLINE_MS)]);
    const run = {
      controller,
      timer: setTimeout(() => {
        controller.abort();
      }, REFRESH_DEADLINE_MS),
    };
    inFlight = run;

    signal.addEventListener(
      'abort',
      () => {
        // Deadline hit (or disposed): abandon, keep the previous value.
        settle(run);
      },
      { once: true },
    );

    let pending: Promise<LocalSnapshot>;
    try {
      pending = probe(opts.env, opts.cwd, signal);
    } catch {
      settle(run);
      return;
    }
    pending.then(
      (snap) => {
        if (signal.aborted || !settle(run)) return;
        local = snap.readiness;
        lastSuccessAt = Date.now();
      },
      () => {
        // Fail-open: keep the previous value.
        settle(run);
      },
    );
  }

  return {
    current(): HealthSnapshot {
      return {
        local,
        connection: 'unknown',
        preflight: 'not-checked',
        stale: !isFresh(lastSuccessAt, Date.now()),
      };
    },

    requestRefresh(): void {
      try {
        if (disposed || inFlight !== null) return;
        if (isFresh(lastAttemptAt, Date.now())) return;
        startRefresh();
      } catch {
        // Never throw into the prompt path.
      }
    },

    dispose(): void {
      disposed = true;
      if (inFlight !== null) {
        clearTimeout(inFlight.timer);
        inFlight.controller.abort();
        inFlight = null;
      }
      local = 'unknown';
      lastSuccessAt = null;
      lastAttemptAt = null;
    },
  };
}

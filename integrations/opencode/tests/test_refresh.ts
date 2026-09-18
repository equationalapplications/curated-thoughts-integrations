import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createHealthCache,
  FRESHNESS_MS,
  REFRESH_DEADLINE_MS,
  type HealthSnapshot,
} from '../src/refresh.js';
import type { LocalSnapshot } from '../src/status.js';

type Probe = (env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal) => Promise<LocalSnapshot>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const READY: LocalSnapshot = { readiness: 'ready', reasons: [] };
const DEGRADED: LocalSnapshot = { readiness: 'degraded', reasons: ['vault-path-missing'] };

const INITIAL: HealthSnapshot = {
  local: 'unknown',
  connection: 'unknown',
  preflight: 'not-checked',
  stale: true,
};

/** Let resolved probe promises propagate through the cache's then-chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthCache', () => {
  it('uses the specified bounds: 2s deadline, 30s freshness window', () => {
    expect(REFRESH_DEADLINE_MS).toBe(2_000);
    expect(FRESHNESS_MS).toBe(30_000);
  });

  it('starts unknown, stale, and not-checked', () => {
    const cache = createHealthCache({ env: {}, cwd: '/', probe: vi.fn() });
    const snapshot = cache.current();
    expect(snapshot).toEqual(INITIAL);
    expect(snapshot.preflight).toBe('not-checked');
  });

  it('is no longer stale after a refresh that succeeds under 2s', async () => {
    const probe = vi.fn<Probe>(async () => READY);
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    await flush();
    expect(cache.current()).toEqual({
      local: 'ready',
      connection: 'unknown',
      preflight: 'not-checked',
      stale: false,
    });
  });

  it('passes env, cwd and an AbortSignal to the probe', async () => {
    const probe = vi.fn<Probe>(async () => READY);
    const env = { CURATED_BRAIN_DIR: '/x' };
    const cache = createHealthCache({ env, cwd: '/work', probe });
    cache.requestRefresh();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    const [e, c, s] = probe.mock.calls[0]!;
    expect(e).toBe(env);
    expect(c).toBe('/work');
    expect(s).toBeInstanceOf(AbortSignal);
  });

  it('does not re-probe within the 30s freshness window, and does after it', async () => {
    const probe = vi.fn<Probe>(async () => READY);
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FRESHNESS_MS - 1);
    cache.requestRefresh();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.current().stale).toBe(false);

    vi.advanceTimersByTime(1);
    expect(cache.current().stale).toBe(true);
    cache.requestRefresh();
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(cache.current().stale).toBe(false);
  });

  it('shares one in-flight refresh across concurrent requests', async () => {
    const d = deferred<LocalSnapshot>();
    const probe = vi.fn<Probe>(() => d.promise);
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    cache.requestRefresh();
    cache.requestRefresh();
    expect(probe).toHaveBeenCalledTimes(1);
    d.resolve(DEGRADED);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.current().local).toBe('degraded');
  });

  it('abandons a refresh that exceeds 2s and keeps the previous value', async () => {
    let call = 0;
    let lateSignal: AbortSignal | undefined;
    const late = deferred<LocalSnapshot>();
    const probe = vi.fn<Probe>((_env, _cwd, signal) => {
      call += 1;
      if (call === 1) return Promise.resolve(READY);
      lateSignal = signal;
      return late.promise; // ignores the signal: never settles on its own
    });
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    await flush();
    expect(cache.current().local).toBe('ready');

    vi.advanceTimersByTime(FRESHNESS_MS);
    cache.requestRefresh();
    expect(probe).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(REFRESH_DEADLINE_MS);
    await flush();
    expect(lateSignal?.aborted).toBe(true);
    // Previous value retained (now stale: its success is older than 30s).
    expect(cache.current().local).toBe('ready');
    expect(cache.current().stale).toBe(true);

    // A result arriving after the deadline is discarded.
    late.resolve(DEGRADED);
    await flush();
    expect(cache.current().local).toBe('ready');
  });

  it('does not start a second probe while an abandoned one is being torn down', async () => {
    const probe = vi.fn<Probe>(() => new Promise<LocalSnapshot>(() => {}));
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    vi.advanceTimersByTime(REFRESH_DEADLINE_MS);
    await flush();
    // The failed attempt still counts against the freshness window, so a
    // hung probe cannot be re-spawned on every prompt.
    cache.requestRefresh();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.current()).toEqual(INITIAL);
  });

  it('fails open: a rejecting probe keeps the previous value', async () => {
    let call = 0;
    const probe = vi.fn<Probe>(async () => {
      call += 1;
      if (call === 1) return DEGRADED;
      throw new Error('EACCES: /home/someone/secret');
    });
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    await flush();
    vi.advanceTimersByTime(FRESHNESS_MS);
    cache.requestRefresh();
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(cache.current().local).toBe('degraded');
  });

  it('never blocks or throws into the caller', () => {
    const syncThrow = vi.fn<Probe>(() => {
      throw new Error('boom');
    });
    const cache = createHealthCache({ env: {}, cwd: '/', probe: syncThrow });
    expect(cache.requestRefresh()).toBeUndefined();
    expect(cache.current()).toEqual(INITIAL);

    const pending = vi.fn<Probe>(() => new Promise<LocalSnapshot>(() => {}));
    const cache2 = createHealthCache({ env: {}, cwd: '/', probe: pending });
    // Returns synchronously even though the probe never settles.
    expect(cache2.requestRefresh()).toBeUndefined();
    expect(pending).toHaveBeenCalledTimes(1);
    cache2.dispose();
  });

  it('dispose() invalidates a pending result without waiting on it', async () => {
    const d = deferred<LocalSnapshot>();
    let seen: AbortSignal | undefined;
    const probe = vi.fn<Probe>((_e, _c, signal) => {
      seen = signal;
      return d.promise;
    });
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    expect(cache.dispose()).toBeUndefined();
    expect(seen?.aborted).toBe(true);
    // No timers left behind by the deadline guard.
    expect(vi.getTimerCount()).toBe(0);

    d.resolve(READY);
    await flush();
    expect(cache.current()).toEqual(INITIAL);

    // Further requests after dispose are inert.
    cache.requestRefresh();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('dispose() drops a previously cached value', async () => {
    const probe = vi.fn<Probe>(async () => READY);
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    cache.requestRefresh();
    await flush();
    expect(cache.current().local).toBe('ready');
    cache.dispose();
    expect(cache.current()).toEqual(INITIAL);
  });

  it('returns snapshots the caller cannot use to mutate the cache', async () => {
    const probe = vi.fn<Probe>(async () => READY);
    const cache = createHealthCache({ env: {}, cwd: '/', probe });
    const s = cache.current();
    s.local = 'ready';
    expect(cache.current().local).toBe('unknown');
  });
});

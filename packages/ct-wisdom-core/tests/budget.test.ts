/**
 * budget.test.ts — the shared budget helpers (review of PR #66):
 * `settleWithin` (one helper for every host, with an expiry hook that kills
 * the CT child), abort support through `wisdomMatch` / `runActivityMatch` /
 * `startActivity`, and `ActivityTracker.releaseKey` (a retry in a LATER
 * step, never a second query in the same one).
 */
import { describe, expect, it } from 'vitest';

import {
  ActivityTracker,
  Breaker,
  EMPTY_LEDGER,
  classify,
  onUserTurn,
  runActivityMatch,
  settleWithin,
  startActivity,
  wisdomMatch,
  type Activity,
  type HostAdapter,
  type SpawnLike,
} from '../src/index.js';

const activity: Activity = { verb: 'run', target: 'pnpm test', key: 'run\u0000pnpm test', line: 'run pnpm test', query: 'pnpm test' };

function host(over: Partial<HostAdapter> = {}): HostAdapter {
  return {
    deliveryEnabled: () => true,
    restored: () => false,
    rebuildLedger: () => EMPTY_LEDGER,
    cacheLedger: () => {},
    wisdomMatch: async () => ({ outcome: 'ok', result: { entries: [], corrections: [] } }),
    isCtRecallResult: () => false,
    envelopeFactIds: () => [],
    rewriteEnvelopeStub: (r) => r,
    resetDiscoveryAndProbeCaches: () => {},
    wisdomMatchAbsent: () => false,
    deliver: () => {},
    noteDelivered: () => {},
    ...over,
  };
}

describe('settleWithin', () => {
  it('resolves with the value when it settles in time, without calling onExpire', async () => {
    let expired = false;
    expect(await settleWithin(Promise.resolve(7), 50, () => (expired = true))).toBe(7);
    expect(expired).toBe(false);
  });

  it('resolves null on expiry and calls onExpire once', async () => {
    let n = 0;
    expect(await settleWithin(new Promise(() => {}), 10, () => n++)).toBeNull();
    expect(n).toBe(1);
  });

  it('uses an already-settled value even with a zero budget', async () => {
    const p = Promise.resolve('done');
    await p;
    expect(await settleWithin(p, 0)).toBe('done');
  });

  it('a rejection resolves null', async () => {
    expect(await settleWithin(Promise.reject(new Error('x')), 50)).toBeNull();
  });
});

describe('abort support', () => {
  it('wisdomMatch passes the signal to the spawn', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const ac = new AbortController();
    await wisdomMatch('/bin/ct', 'q', 1, [], async (spec: SpawnLike) => {
      seen.push(spec.signal);
      return { code: 0, stdout: '{"entries":[],"corrections":[]}', stderr: '', spawnError: false, timedOut: false };
    }, ac.signal);
    expect(seen).toEqual([ac.signal]);
  });

  it('an aborted activity match is `budget`, never a breaker failure', async () => {
    const breaker = new Breaker();
    const ac = new AbortController();
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r()));
        return { outcome: 'timeout_or_exit' };
      },
    });
    const pending = runActivityMatch(h, activity, [], breaker, ac.signal);
    ac.abort();
    expect(await pending).toEqual({ failure: 'budget' });
    for (let i = 0; i < 5; i++) {
      const again = new AbortController();
      const p = runActivityMatch(h, activity, [], breaker, again.signal);
      again.abort();
      await p;
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('startActivity forwards the signal to the host', async () => {
    const ac = new AbortController();
    let got: AbortSignal | undefined;
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        got = signal;
        return { outcome: 'ok', result: { entries: [], corrections: [] } };
      },
    });
    const start = startActivity(h, { id: 's' }, activity, new Breaker(), ac.signal);
    expect(start.failure).toBeNull();
    if (start.failure === null) await start.match;
    expect(got).toBe(ac.signal);
  });
});

describe('the aborted outcome (opencode 0.4.1 review)', () => {
  it('classify reports an aborted spawn as `aborted`, before any timeout or exit code', () => {
    expect(classify({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: false, aborted: true })).toBe('aborted');
    expect(classify({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: true, aborted: true })).toBe('aborted');
    expect(classify({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: true })).toBe('timeout_or_exit');
  });

  it('an `aborted` match is `budget` and never a breaker failure, even without a signal', async () => {
    const breaker = new Breaker();
    const h = host({ wisdomMatch: async () => ({ outcome: 'aborted' }) });
    for (let i = 0; i < 5; i++) expect(await runActivityMatch(h, activity, [], breaker)).toEqual({ failure: 'budget' });
    expect(breaker.isOpen()).toBe(false);
  });

  it('onUserTurn never counts an aborted match against the breaker', async () => {
    const breaker = new Breaker();
    const h = host({ wisdomMatch: async () => ({ outcome: 'aborted' }) });
    for (let i = 0; i < 5; i++) expect(await onUserTurn(h, { id: 's' }, 'question', breaker)).toBeNull();
    expect(breaker.isOpen()).toBe(false);
  });
});

describe('ActivityTracker.releaseKey', () => {
  it('frees the key for a later step but keeps this step used', () => {
    const t = new ActivityTracker();
    expect(t.admit('s', 'step1', 'k')).toBeNull();
    t.releaseKey('s', 'k');
    expect(t.peek('s', 'step1', 'other')).toBe('step_used');
    expect(t.peek('s', 'step2', 'k')).toBeNull();
    expect(t.admit('s', 'step2', 'k')).toBeNull();
  });
});

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
  BREAKER_FAILS,
  Breaker,
  EMPTY_LEDGER,
  recordActivityBudgetMiss,
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

  it('an aborted activity match is `budget` and counts ONE breaker failure (never a success)', async () => {
    // Controller decision (post-merge review of openclaw 0.3.0): a budget
    // miss counts as one failure on every host, like a Hermes live timeout.
    const breaker = new Breaker();
    const ac = new AbortController();
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r()));
        // even a host that reports ok after the kill is not a success
        return { outcome: 'ok', result: { entries: [], corrections: [] } };
      },
    });
    const pending = runActivityMatch(h, activity, [], breaker, ac.signal);
    ac.abort();
    expect(await pending).toEqual({ failure: 'budget' });
    expect(breaker.isOpen()).toBe(false); // one miss of BREAKER_FAILS
    for (let i = 1; i < BREAKER_FAILS; i++) {
      const again = new AbortController();
      const p = runActivityMatch(h, activity, [], breaker, again.signal);
      again.abort();
      await p;
    }
    expect(breaker.isOpen()).toBe(true);
  });

  it('recordActivityBudgetMiss is the one rule hosts without a signal call', () => {
    const breaker = new Breaker();
    for (let i = 0; i < BREAKER_FAILS; i++) recordActivityBudgetMiss(breaker);
    expect(breaker.isOpen()).toBe(true);
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

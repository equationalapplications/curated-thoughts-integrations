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

  // ── core-owned cancel (spec 2026-10-17-core-spawn-binding-and-cancel-design.md) ──

  /** A host whose wisdomMatch waits for the abort, then reports `outcome`. */
  function hangingHost(outcome: 'aborted' | 'timeout_or_exit' | 'spawn' | 'ok') {
    let seen: AbortSignal | undefined;
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        seen = signal;
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
        return outcome === 'ok' ? { outcome: 'ok', result: { entries: [], corrections: [] } } : { outcome };
      },
    });
    return { h, signal: () => seen };
  }

  function started(h: HostAdapter, breaker: Breaker) {
    const start = startActivity(h, { id: 's' }, activity, breaker);
    if (start.failure !== null) throw new Error(`refused: ${start.failure}`);
    return start;
  }

  it("cancel('budget') charges ONE failure at once, before the match settles, then aborts", async () => {
    const breaker = new Breaker();
    const { h, signal } = hangingHost('aborted');
    const start = started(h, breaker);
    await Promise.resolve();
    start.cancel('budget');
    expect(signal()?.aborted).toBe(true);
    // Charged synchronously: three budget misses open the breaker even if no match ever settles.
    for (let i = 1; i < BREAKER_FAILS; i++) started(hangingHost('aborted').h, breaker).cancel('budget');
    expect(breaker.isOpen()).toBe(true);
    expect(await start.match).toEqual({ failure: 'budget' });
  });

  it("cancel('budget') charges once whatever the kill surfaced as", async () => {
    for (const outcome of ['aborted', 'timeout_or_exit', 'spawn'] as const) {
      const breaker = new Breaker();
      const start = started(hangingHost(outcome).h, breaker);
      start.cancel('budget');
      expect(await start.match, outcome).toEqual({ failure: 'budget' });
      for (let i = 0; i < BREAKER_FAILS - 2; i++) recordActivityBudgetMiss(breaker);
      expect(breaker.isOpen(), outcome).toBe(false);
      recordActivityBudgetMiss(breaker);
      expect(breaker.isOpen(), outcome).toBe(true);
    }
  });

  it("cancel('abandoned') never charges, even when the kill surfaces as an exit code", async () => {
    for (const outcome of ['aborted', 'timeout_or_exit', 'spawn'] as const) {
      const breaker = new Breaker();
      for (let i = 0; i < BREAKER_FAILS + 1; i++) {
        const start = started(hangingHost(outcome).h, breaker);
        start.cancel('abandoned');
        expect(await start.match, outcome).toEqual({ failure: 'cancelled' });
      }
      expect(breaker.isOpen(), outcome).toBe(false);
    }
  });

  it('a real answer after a cancel wins and clears the budget charge', async () => {
    const breaker = new Breaker();
    for (let i = 0; i < BREAKER_FAILS - 1; i++) recordActivityBudgetMiss(breaker);
    const start = started(hangingHost('ok').h, breaker);
    start.cancel('budget'); // the charge opens the breaker...
    expect(breaker.isOpen()).toBe(true);
    const out = await start.match;
    expect(out.failure).toBeNull(); // ...and ct's real answer closes it again
    expect(breaker.isOpen()).toBe(false);
  });

  it('cancel is idempotent (first reason wins) and a no-op after the match settled', async () => {
    const breaker = new Breaker();
    const start = started(hangingHost('aborted').h, breaker);
    start.cancel('abandoned');
    start.cancel('budget'); // ignored: no charge
    expect(await start.match).toEqual({ failure: 'cancelled' });
    for (let i = 0; i < BREAKER_FAILS - 1; i++) recordActivityBudgetMiss(breaker);
    expect(breaker.isOpen()).toBe(false);

    const b2 = new Breaker();
    const q2 = started(host(), b2);
    expect((await q2.match).failure).toBeNull();
    q2.cancel('budget'); // after settle: no charge
    for (let i = 0; i < BREAKER_FAILS - 1; i++) recordActivityBudgetMiss(b2);
    expect(b2.isOpen()).toBe(false);
  });

  it('a host whose wisdomMatch never settles is still charged at budget expiry', async () => {
    const breaker = new Breaker();
    const never = host({ wisdomMatch: () => new Promise(() => {}) });
    for (let i = 0; i < BREAKER_FAILS; i++) {
      const start = started(never, breaker);
      const match = await settleWithin(start.match, 10, () => start.cancel('budget'));
      expect(match).toBeNull();
    }
    expect(breaker.isOpen()).toBe(true);
  });

  it('startActivity hands wisdomMatch the core signal', async () => {
    let got: AbortSignal | undefined;
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        got = signal;
        return { outcome: 'ok', result: { entries: [], corrections: [] } };
      },
    });
    const start = started(h, new Breaker());
    await start.match;
    expect(got).toBeInstanceOf(AbortSignal);
    expect(got?.aborted).toBe(false);
  });

  it('recordActivityBudgetMiss is the one rule hosts without a signal call', () => {
    const breaker = new Breaker();
    for (let i = 0; i < BREAKER_FAILS; i++) recordActivityBudgetMiss(breaker);
    expect(breaker.isOpen()).toBe(true);
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

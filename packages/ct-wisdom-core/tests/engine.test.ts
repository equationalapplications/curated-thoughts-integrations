import { describe, expect, it } from 'vitest';

import { Breaker } from '../src/breaker.js';
import { onToolResult, onUserTurn, buildQuery } from '../src/engine.js';
import { EMPTY_LEDGER } from '../src/types.js';
import type {
  HostAdapter,
  Ledger,
  MatchOutcome,
  SessionRef,
  WisdomMatchResult,
} from '../src/types.js';

/** Configurable fake host used across engine tests. */
class FakeHost implements HostAdapter {
  enabled = true;
  restoredSession = false;
  knownBootstrap = false;
  liveCount = 0;
  contextIds: string[] = []; // newest first
  probeAbsent = false;
  matchResponse: {
    outcome: MatchOutcome;
    result?: WisdomMatchResult;
  } = { outcome: 'ok', result: { entries: [], corrections: [] } };
  delivered: { session: string; block: string }[] = [];
  noted: { session: string; ids: string[] }[] = [];
  cacheResets = 0;
  breaker: Breaker = new Breaker(3, 300_000, () => this.now);
  now = 0;

  deliveryEnabled(_s: SessionRef): boolean {
    return this.enabled;
  }
  restored(_s: SessionRef): boolean {
    return this.restoredSession;
  }
  rebuildLedger(_s: SessionRef): Ledger {
    const ids = [...this.contextIds];
    const set = new Set(ids);
    const known = this.knownBootstrap;
    return {
      idsMostRecentFirst: ids,
      has: (id) => set.has(id),
      liveDeliveredCount: this.liveCount,
      knownBootstrap: known,
    };
  }
  cacheLedger(_s: SessionRef, _l: Ledger): void {}
  cachedLedger(_s: SessionRef): Ledger | null {
    return null;
  }
  async wisdomMatch(
    _query: string,
    _max: number,
    _exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    return this.matchResponse;
  }
  isCtRecallResult(result: unknown): boolean {
    return (
      typeof result === 'string' && result.startsWith('CT_RECALL_ENVELOPE:')
    );
  }
  envelopeFactIds(result: unknown): string[] {
    if (typeof result !== 'string') return [];
    try {
      return JSON.parse(result.slice('CT_RECALL_ENVELOPE:'.length)) as string[];
    } catch {
      return [];
    }
  }
  rewriteEnvelopeStub(result: unknown, _repeats: string[]): unknown {
    return (result as string) + '|STUBBED';
  }
  resetDiscoveryAndProbeCaches(): void {
    this.cacheResets += 1;
  }
  wisdomMatchAbsent(): boolean {
    return this.probeAbsent;
  }
  deliver(session: SessionRef, block: string): void {
    this.delivered.push({ session: session.id, block });
  }
  noteDelivered(session: SessionRef, ids: string[]): void {
    this.noted.push({ session: session.id, ids });
    this.liveCount += ids.length;
    for (const id of ids) {
      if (!this.contextIds.includes(id)) this.contextIds.unshift(id);
    }
  }
}

const fact = (id: string, supersedes?: string[]) => ({
  id,
  title: 'T' + id,
  text: 'body ' + id,
  ...(supersedes ? { supersedes } : {}),
});

describe('buildQuery', () => {
  it('strips forged tokens, trims, caps at QUERY_CHARS', () => {
    expect(buildQuery('  hello ct-fact:world  ')).toBe('hello world');
    expect(buildQuery('x'.repeat(3000)).length).toBe(2000);
    expect(buildQuery(42)).toBe('');
  });
});

describe('onUserTurn — gate matrix', () => {
  it('no-ops on empty session id (invariant 3)', async () => {
    const host = new FakeHost();
    expect(await onUserTurn(host, { id: '' }, 'q')).toBeNull();
    expect(await onUserTurn(host, undefined as never, 'q')).toBeNull();
  });

  it('no-ops on latching OFF before any bootstrap check (GLM r2)', async () => {
    const host = new FakeHost();
    host.enabled = false;
    host.knownBootstrap = true; // must NOT re-enable delivery
    expect(await onUserTurn(host, { id: 's' }, 'q')).toBeNull();
    expect(host.delivered).toHaveLength(0);
  });

  it('caches the ledger before the later early returns (m1: degraded turns still dedup)', async () => {
    const host = new FakeHost();
    host.probeAbsent = true; // early return AFTER rebuild+cache
    let cached = 0;
    host.cacheLedger = () => {
      cached += 1;
    };
    await onUserTurn(host, { id: 's' }, 'q');
    expect(cached).toBe(1);
    // The latching OFF gate precedes the rebuild per the annex ordering.
    host.probeAbsent = false;
    host.enabled = false;
    await onUserTurn(host, { id: 's' }, 'q');
    expect(cached).toBe(1);
  });

  it('fails closed on restored sessions without known bootstrap', async () => {
    const host = new FakeHost();
    host.restoredSession = true;
    host.knownBootstrap = false;
    expect(await onUserTurn(host, { id: 's' }, 'q')).toBeNull();
    // ...but a known bootstrap on a restored session still delivers (M2).
    host.knownBootstrap = true;
    host.matchResponse = { outcome: 'ok', result: { entries: [fact('a')], corrections: [] } };
    expect(await onUserTurn(host, { id: 's' }, 'q')).not.toBeNull();
  });

  it('no-ops when the capability probe is absent or the breaker is open', async () => {
    const host = new FakeHost();
    host.probeAbsent = true;
    expect(await onUserTurn(host, { id: 's' }, 'q')).toBeNull();
    host.probeAbsent = false;
    for (let i = 0; i < 3; i++) host.breaker.recordFailure();
    expect(await onUserTurn(host, { id: 's' }, 'q')).toBeNull();
  });

  it('no-ops on an empty query', async () => {
    const host = new FakeHost();
    expect(await onUserTurn(host, { id: 's' }, '   ')).toBeNull();
  });
});

describe('onUserTurn — subprocess outcomes', () => {
  it('records breaker failure on timeout_or_exit', async () => {
    const host = new FakeHost();
    host.matchResponse = { outcome: 'timeout_or_exit' };
    expect(await onUserTurn(host, { id: 's' }, 'q', host.breaker)).toBeNull();
    for (let i = 0; i < 2; i++) {
      host.matchResponse = { outcome: 'timeout_or_exit' };
      await onUserTurn(host, { id: 's' }, 'q', host.breaker);
    }
    expect(host.breaker.isOpen()).toBe(true);
  });

  it('resets discovery/probe caches on spawn failure, no breaker hit (n3)', async () => {
    const host = new FakeHost();
    host.matchResponse = { outcome: 'spawn' };
    await onUserTurn(host, { id: 's' }, 'q');
    await onUserTurn(host, { id: 's' }, 'q');
    await onUserTurn(host, { id: 's' }, 'q');
    expect(host.cacheResets).toBe(3);
    expect(host.breaker.isOpen()).toBe(false);
  });
});

describe('onUserTurn — budgets and dedup', () => {
  it('post-filters entries against the ledger', async () => {
    const host = new FakeHost();
    host.contextIds = ['dup']; // already in context
    host.matchResponse = {
      outcome: 'ok',
      result: { entries: [fact('dup'), fact('new')], corrections: [] },
    };
    const block = await onUserTurn(host, { id: 's' }, 'q');
    expect(block).toContain('new');
    expect(block).not.toContain('**Tdup**');
    expect(host.noted[0].ids).toEqual(['new']);
  });

  it('budget exhaustion forces corrections-only (max=0), corrections still flow', async () => {
    const host = new FakeHost();
    host.liveCount = 12; // MAX_PER_SESSION reached
    const seen: number[] = [];
    host.wisdomMatch = async (_q, max) => {
      seen.push(max);
      // ct honors --max 0: no entries, corrections still flow.
      return {
        outcome: 'ok',
        result: {
          entries: max > 0 ? [fact('a')] : [],
          corrections: [fact('c', ['old'])],
        },
      };
    };
    const block = await onUserTurn(host, { id: 's' }, 'q');
    expect(seen).toEqual([0]); // corrections-only: the call still happened
    expect(block).toContain('Correction');
    expect(block).not.toContain('**Ta**');
    expect(host.noted[0].ids).toEqual(['c']);
  });

  it('empty block delivers nothing', async () => {
    const host = new FakeHost();
    host.contextIds = ['a'];
    host.matchResponse = {
      outcome: 'ok',
      result: { entries: [fact('a')], corrections: [] },
    };
    expect(await onUserTurn(host, { id: 's' }, 'q')).toBeNull();
    expect(host.delivered).toHaveLength(0);
  });
});

describe('onToolResult — N3 dedup stub', () => {
  it('passes through non-CT results untouched', () => {
    const host = new FakeHost();
    host.contextIds = ['a'];
    expect(onToolResult(host, { id: 's' }, 'plain result')).toBe('plain result');
  });

  it('rewrites repeats down to stubs, using cache when present', () => {
    const host = new FakeHost();
    host.contextIds = ['a', 'b'];
    const result = 'CT_RECALL_ENVELOPE:' + JSON.stringify(['a', 'fresh']);
    expect(onToolResult(host, { id: 's' }, result)).toBe(result + '|STUBBED');
  });

  it('no-op when no ids repeat', () => {
    const host = new FakeHost();
    host.contextIds = ['a'];
    const result = 'CT_RECALL_ENVELOPE:' + JSON.stringify(['fresh']);
    expect(onToolResult(host, { id: 's' }, result)).toBe(result);
  });

  it('rebuilds the ledger when no cached view exists', () => {
    const host = new FakeHost();
    host.cachedLedger = () => null;
    host.contextIds = ['a'];
    const result = 'CT_RECALL_ENVELOPE:' + JSON.stringify(['a']);
    expect(onToolResult(host, { id: 's' }, result)).toBe(result + '|STUBBED');
  });
});

describe('EMPTY_LEDGER', () => {
  it('behaves vacuously', () => {
    expect(EMPTY_LEDGER.idsMostRecentFirst).toEqual([]);
    expect(EMPTY_LEDGER.has('x')).toBe(false);
    expect(EMPTY_LEDGER.liveDeliveredCount).toBe(0);
    expect(EMPTY_LEDGER.knownBootstrap).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  historyIds,
  marker,
  scanIds,
  stripForged,
  validId,
  LedgerCache,
} from '../src/ledger.js';
import { truncateBlock } from '../src/render.js';

describe('validId', () => {
  it('accepts spec ids', () => {
    expect(validId('fact_01')).toBe(true);
    expect(validId('a.b:c-d_e')).toBe(true);
    expect(validId('x'.repeat(128))).toBe(true);
  });

  it('rejects malformed ids', () => {
    expect(validId('')).toBe(false);
    expect(validId('has space')).toBe(false);
    expect(validId('x'.repeat(129))).toBe(false);
    expect(validId(42)).toBe(false);
    expect(validId(null)).toBe(false);
    expect(validId(undefined)).toBe(false);
  });
});

describe('marker / scanIds', () => {
  it('round-trips a marker', () => {
    const m = marker('fact_01');
    expect(m).toBe('<!-- ct-fact:fact_01 -->');
    expect(scanIds(`before ${m} after`)).toEqual(['fact_01']);
  });

  it('scans ordered unique ids', () => {
    expect(scanIds(`${marker('b')} ${marker('a')} ${marker('b')}`)).toEqual([
      'b',
      'a',
    ]);
  });

  it('tolerates non-string input', () => {
    expect(scanIds(null)).toEqual([]);
    expect(scanIds(42)).toEqual([]);
  });
});

describe('stripForged (fixpoint)', () => {
  it('removes all forged tokens', () => {
    expect(stripForged('a ct-fact:b c')).toBe('a b c');
  });

  it('survives splice attacks that a single pass would miss', () => {
    // "ct-f" + "act:" reassembles after one replace.
    expect(stripForged('ct-fact:ct-fact:x')).toBe('x');
    expect(stripForged('x ct-fact: ct-fact:ct-fact:')).toBe('x  ');
    // Alternation that reassembles across passes:
    const spliced = 'ct-f'.concat('act:ct-f', 'act:y');
    expect(stripForged(spliced)).toBe('y');
  });

  it('leaves clean text untouched', () => {
    expect(stripForged('nothing to see')).toBe('nothing to see');
  });
});

describe('historyIds', () => {
  it('returns ids newest-message first, unique', () => {
    const history = [
      { role: 'user', content: `q ${marker('a')}` },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: `q2 ${marker('b')} ${marker('a')}` },
    ];
    expect(historyIds(history)).toEqual(['b', 'a']);
  });

  it('reads api_content sidecars and text parts', () => {
    const history = [
      {
        role: 'user',
        content: 'plain',
        api_content: [{ type: 'text', text: marker('c') }],
      },
    ];
    expect(historyIds(history)).toEqual(['c']);
  });

  it('filters by role', () => {
    const history = [
      { role: 'tool', content: marker('t') },
      { role: 'user', content: marker('u') },
    ];
    expect(historyIds(history, ['user'])).toEqual(['u']);
  });

  it('tolerates malformed history', () => {
    expect(historyIds('nope')).toEqual([]);
    expect(historyIds([null, 42, { role: 'user' }])).toEqual([]);
  });
});

describe('LedgerCache', () => {
  it('put/get/add with LRU bound', () => {
    const cache = new LedgerCache(2);
    cache.put('s1', ['a']);
    cache.put('s2', ['b']);
    expect(cache.get('s1')).toEqual(new Set(['a']));
    cache.put('s3', ['c']); // evicts s2 (s1 was just touched)
    expect(cache.get('s2')).toBeNull();
    expect(cache.get('s3')).toEqual(new Set(['c']));
    cache.add('s3', ['d']);
    expect(cache.get('s3')).toEqual(new Set(['c', 'd']));
    cache.add('missing', ['x']); // no-op
    expect(cache.get('missing')).toBeNull();
  });

  it('returns a copy so callers cannot mutate the cache', () => {
    const cache = new LedgerCache();
    cache.put('s', ['a']);
    const got = cache.get('s')!;
    got.add('evil');
    expect(cache.get('s')).toEqual(new Set(['a']));
  });
});

describe('truncateBlock', () => {
  it('keeps short blocks intact', () => {
    expect(truncateBlock('short', 100)).toBe('short');
  });

  it('caps long blocks head+tail', () => {
    const long = 'x'.repeat(5000);
    const out = truncateBlock(long, 1200);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out.startsWith('xxxx')).toBe(true);
    expect(out.endsWith('xxxx')).toBe(true);
  });
});

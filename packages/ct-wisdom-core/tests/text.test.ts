/**
 * text.test.ts — code-point counting and cutting (review of PR #56): every
 * cap in the core counts and cuts like Python (`len`, slicing by code point)
 * and never splits a surrogate pair. Plus the shared LRU helper.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_LABEL_CHARS,
  ACTIVITY_MAX_BLOCK_CHARS,
  ACTIVITY_QUERY_CHARS,
  MAX_BLOCK_CHARS,
  QUERY_CHARS,
  activityQuery,
  buildQuery,
  cpLen,
  cpSlice,
  lruSet,
  renderActivityBlock,
  truncateBlock,
} from '../src/index.js';
import type { Activity } from '../src/index.js';

const EMOJI = '\u{1F600}'; // two UTF-16 units, one code point

/** True when `s` holds a lone surrogate (a split pair). */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

const activity = (line: string, query = 'q'): Activity => ({ verb: 'read', target: 'x', key: 'k', line, query });

describe('code points', () => {
  it('cpLen / cpSlice count and cut by code point', () => {
    expect(cpLen(`a${EMOJI}b`)).toBe(3);
    expect(cpSlice(`a${EMOJI}b`, 0, 2)).toBe(`a${EMOJI}`);
    expect(cpSlice(`${EMOJI}${EMOJI}`, 1)).toBe(EMOJI);
  });

  it('the activity label is capped by code points and never splits a pair', () => {
    for (let pad = 0; pad < 4; pad++) {
      const line = 'r'.repeat(ACTIVITY_LABEL_CHARS - 2 + pad) + EMOJI.repeat(5);
      const block = renderActivityBlock({ id: 'f1', title: 'T', text: 'x' }, [], activity(line));
      const label = block.split('\n')[1].slice('_for: '.length, -1);
      expect(cpLen(label), `pad ${pad}`).toBeLessThanOrEqual(ACTIVITY_LABEL_CHARS);
      expect(hasLoneSurrogate(block), `pad ${pad}`).toBe(false);
    }
  });

  it('the activity block is capped by code points and never splits a pair', () => {
    for (let pad = 0; pad < 4; pad++) {
      const block = renderActivityBlock(
        { id: 'f1', title: 'T', text: 'w'.repeat(pad) + EMOJI.repeat(800) }, [], activity('read x'));
      expect(cpLen(block)).toBeLessThanOrEqual(ACTIVITY_MAX_BLOCK_CHARS);
      expect(cpLen(block)).toBeGreaterThan(ACTIVITY_MAX_BLOCK_CHARS - 3); // filled by code points
      expect(hasLoneSurrogate(block), `pad ${pad}`).toBe(false);
      expect(block.endsWith('…')).toBe(true);
    }
  });

  it('the activity and user-turn query caps count code points', () => {
    const q = activityQuery(activity('l', EMOJI.repeat(400)));
    expect(cpLen(q)).toBe(ACTIVITY_QUERY_CHARS);
    expect(hasLoneSurrogate(q)).toBe(false);
    const u = buildQuery(`x${EMOJI.repeat(QUERY_CHARS + 10)}`);
    expect(cpLen(u)).toBe(QUERY_CHARS);
    expect(hasLoneSurrogate(u)).toBe(false);
  });

  it('the user-turn block truncation never splits a pair', () => {
    for (let pad = 0; pad < 4; pad++) {
      const t = truncateBlock('a'.repeat(pad) + EMOJI.repeat(2000));
      expect(cpLen(t)).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
      expect(hasLoneSurrogate(t), `pad ${pad}`).toBe(false);
    }
  });
});

describe('lruSet', () => {
  it('sets, refreshes recency and evicts the oldest past max', () => {
    const m = new Map<string, number>();
    lruSet(m, 'a', 1, 2);
    lruSet(m, 'b', 2, 2);
    lruSet(m, 'a', 3, 2); // refresh a
    lruSet(m, 'c', 4, 2); // evicts b
    expect([...m.entries()]).toEqual([['a', 3], ['c', 4]]);
  });
});

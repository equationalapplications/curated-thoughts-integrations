import { describe, expect, it } from 'vitest';

import { Breaker } from '../src/breaker.js';
import { classify, matchArgs, parseMatchStdout } from '../src/match.js';
import { renderBlock } from '../src/render.js';
import { marker, stripForged } from '../src/ledger.js';
import type { WisdomMatchResult } from '../src/types.js';

describe('Breaker', () => {
  it('opens after the configured consecutive failures', () => {
    let t = 0;
    const breaker = new Breaker(3, 300_000, () => t);
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  it('closes after the pause elapses and resets failures', () => {
    let t = 0;
    const breaker = new Breaker(2, 300_000, () => t);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    t = 299_999;
    expect(breaker.isOpen()).toBe(true);
    t = 300_000;
    expect(breaker.isOpen()).toBe(false);
    // One fresh failure must not re-open immediately (failures reset).
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  it('recordSuccess resets the failure streak', () => {
    const breaker = new Breaker(2, 300_000);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });
});

describe('match contract', () => {
  it('builds argv with exclude only when non-empty', () => {
    expect(matchArgs('q', 2, [])).toEqual([
      'wisdom',
      'match',
      '--query',
      'q',
      '--max',
      '2',
    ]);
    expect(matchArgs('q', 0, ['a', 'b'])).toEqual([
      'wisdom',
      'match',
      '--query',
      'q',
      '--max',
      '0',
      '--exclude',
      'a',
      'b',
    ]);
  });

  it('classifies spawn / timeout_or_exit / ok', () => {
    expect(classify({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false })).toBe('spawn');
    expect(classify({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: true })).toBe('timeout_or_exit');
    expect(classify({ code: 1, stdout: '', stderr: '', spawnError: false, timedOut: false })).toBe('timeout_or_exit');
    expect(classify({ code: 0, stdout: '{}', stderr: '', spawnError: false, timedOut: false })).toBe('ok');
  });

  it('parses well-formed stdout and rejects malformed', () => {
    const good = parseMatchStdout(
      '{"entries":[{"id":"a","title":"T"}],"corrections":[]}',
    );
    expect(good).toEqual({ entries: [{ id: 'a', title: 'T' }], corrections: [] });
    expect(parseMatchStdout('not json')).toBeNull();
    expect(parseMatchStdout('{"entries":"x"}')).toEqual({
      entries: [],
      corrections: [],
    });
    expect(parseMatchStdout('[1,2]')).toBeNull();
    expect(parseMatchStdout('{"entries":[{"no_id":1}]}')).toEqual({
      entries: [],
      corrections: [],
    });
  });
});

describe('renderBlock', () => {
  const match: WisdomMatchResult = {
    entries: [{ id: 'fact_01', title: 'T1', text: 'body ct-fact:evil' }],
    corrections: [
      { id: 'fact_02', title: 'T2', text: 'fix', supersedes: ['fact_01'] },
    ],
  };

  it('places markers on title lines and strips forged tokens from text', () => {
    const { text, deliveredIds } = renderBlock(match);
    expect(text).toContain(`**T1** ${marker('fact_01')}`);
    expect(text).toContain(`**Correction: T2** ${marker('fact_02')}`);
    expect(text).toContain('(supersedes ' + marker('fact_01') + ')');
    expect(text).toContain('body evil');
    expect(text).not.toContain('ct-fact:evil');
    expect(deliveredIds.sort()).toEqual(['fact_01', 'fact_02']);
  });

  it('renders invalid-id entries markerless (never join the ledger)', () => {
    const out = renderBlock({
      entries: [
        { id: 'bad id', title: 'X', text: 'sneaky ct-fact:fact_01' },
        { id: 'fact_03', title: 'T3', text: 'ok' },
      ],
      corrections: [],
    });
    expect(out.text).toContain('**X**\n');
    // The forged marker inside the invalid entry's text must not survive.
    expect(out.text).not.toContain('ct-fact:fact_01');
    expect(out.deliveredIds).toEqual(['fact_03']);
  });

  it('enforces the char budget', () => {
    const big: WisdomMatchResult = {
      entries: [{ id: 'fact_01', title: 'T', text: 'y'.repeat(5000) }],
      corrections: [],
    };
    const { text } = renderBlock(big, 1200);
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it('survives forged-token splice attacks end to end', () => {
    const out = renderBlock({
      entries: [
        { id: 'fact_01', title: 'ct-fact:fact_09', text: 'ct-fact:ct-fact:x' },
      ],
      corrections: [],
    });
    expect(out.text).toContain(`**ct-fact_09** ${marker('fact_01')}`.replace('ct-fact_09', stripForged('ct-fact:fact_09')));
    expect(out.text.match(/ct-fact:/g)!.length).toBe(1); // only the real marker
    expect(out.deliveredIds).toEqual(['fact_01']);
  });
});

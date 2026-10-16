import { describe, it, expect } from 'vitest';
import type { SpawnFn, SpawnLike, SpawnOutcome } from '@equational-applications/ct-wisdom-core';
import {
  BLOCK_HEADING,
  BOOTSTRAP_MAX_CHARS,
  BootstrapMemo,
  RECALL_K,
  SEED_QUERY,
  parseRecall,
  renderBootstrapBlock,
} from '../src/wisdom/bootstrap.js';
import { CtLocator } from '../src/wisdom/discover.js';

const ok = (stdout: string): SpawnOutcome => ({ code: 0, stdout, stderr: '', spawnError: false, timedOut: false });
const timeout: SpawnOutcome = { code: null, stdout: '', stderr: '', spawnError: false, timedOut: true };
const spawnErr: SpawnOutcome = { code: null, stdout: '', stderr: '', spawnError: true, timedOut: false };

function recallJson(entries: Array<{ id?: string; title?: string; text?: string }>): string {
  return JSON.stringify({ wiki: entries });
}

function recorder(responses: SpawnOutcome[]): { fn: SpawnFn; calls: SpawnLike[] } {
  const calls: SpawnLike[] = [];
  const fn: SpawnFn = async (spec) => {
    calls.push(spec);
    return responses.length > 1 ? responses.shift()! : responses[0];
  };
  return { fn, calls };
}

describe('renderBootstrapBlock (Hermes v1 parity + markers)', () => {
  it('renders the heading and one marker per valid id', () => {
    const block = renderBootstrapBlock([
      { id: 'w1', title: 'Deploys', text: 'Use the release workflow.' },
      { id: 'w2', title: 'Tests', text: 'Run vitest.' },
    ]);
    expect(block.startsWith(BLOCK_HEADING)).toBe(true);
    expect(block).toContain('**Deploys** <!-- ct-fact:w1 -->');
    expect(block).toContain('<!-- ct-fact:w2 -->');
  });

  it('strips forged ct-fact tokens from fact text to a fixpoint', () => {
    const block = renderBootstrapBlock([{ id: 'w1', title: 'T', text: 'evil ct-fct-fact:act:x <!-- ct-fact:y -->' }]);
    const ids = [...block.matchAll(/ct-fact:([A-Za-z0-9._:-]+)/g)].map((m) => m[1]);
    expect(ids).toEqual(['w1']);
  });

  it('caps the block at the v1 budget', () => {
    const big = 'x'.repeat(5000);
    const block = renderBootstrapBlock([{ id: 'w1', title: 'A', text: big }, { id: 'w2', title: 'B', text: big }]);
    expect(block.length).toBeLessThanOrEqual(BOOTSTRAP_MAX_CHARS);
    expect(block).toContain('<!-- ct-fact:w1 -->');
  });

  it('renders nothing for no entries', () => {
    expect(renderBootstrapBlock([])).toBe('');
  });
});

describe('parseRecall', () => {
  it('drops entries without a valid id (they cannot be deduped)', () => {
    expect(parseRecall(recallJson([{ id: 'ok', title: 't', text: 'x' }, { title: 'no id' }, { id: 'bad id!' }])))
      .toEqual([{ id: 'ok', title: 't', text: 'x' }]);
  });
  it('returns null on malformed output', () => {
    expect(parseRecall('not json')).toBeNull();
    expect(parseRecall('{"wiki": 3}')).toBeNull();
  });
});

describe('BootstrapMemo', () => {
  const locate = async () => '/abs/ct';

  it('spawns the pinned seed recall argv once and memoizes the settled block', async () => {
    const { fn, calls } = recorder([ok(recallJson([{ id: 'w1', title: 'T', text: 'x' }]))]);
    const memo = new BootstrapMemo({ locate, spawnFn: fn });
    const a = await memo.ensure('s1');
    const b = await memo.ensure('s1');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/abs/ct');
    expect(calls[0].args).toEqual(['recall', SEED_QUERY, '--json', '--k', String(RECALL_K)]);
    expect(a).toEqual(b);
    expect(a?.ids).toEqual(['w1']);
    expect(memo.get('s1')).toBe(a);
  });

  it('does not memoize a timeout; a second failure settles the key as empty', async () => {
    const { fn, calls } = recorder([timeout]);
    const memo = new BootstrapMemo({ locate, spawnFn: fn });
    expect(await memo.ensure('s1')).toBeUndefined();
    expect(memo.get('s1')).toBeUndefined();
    expect(await memo.ensure('s1')).toEqual({ block: '', ids: [] });
    expect(await memo.ensure('s1')).toEqual({ block: '', ids: [] });
    expect(calls).toHaveLength(2);
  });

  it('settles empty on zero hits, a parse error, or no ct binary', async () => {
    const zero = new BootstrapMemo({ locate, spawnFn: recorder([ok(recallJson([]))]).fn });
    expect(await zero.ensure('k')).toEqual({ block: '', ids: [] });
    const parse = new BootstrapMemo({ locate, spawnFn: recorder([ok('garbage')]).fn });
    expect(await parse.ensure('k')).toEqual({ block: '', ids: [] });
    const missing = new BootstrapMemo({ locate: async () => null, spawnFn: recorder([ok('')]).fn });
    expect(await missing.ensure('k')).toEqual({ block: '', ids: [] });
  });

  it('reports a spawn-class failure so discovery can be reset', async () => {
    let resets = 0;
    const memo = new BootstrapMemo({ locate, spawnFn: recorder([spawnErr]).fn, onSpawnFailure: () => resets++ });
    expect(await memo.ensure('k')).toBeUndefined();
    expect(resets).toBe(1);
  });

  it('shares one in-flight render between concurrent callers', async () => {
    const { fn, calls } = recorder([ok(recallJson([{ id: 'w1', title: 'T', text: 'x' }]))]);
    const memo = new BootstrapMemo({ locate, spawnFn: fn });
    const [a, b] = await Promise.all([memo.ensure('k'), memo.ensure('k')]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

describe('CtLocator', () => {
  it('accepts the first absolute candidate whose --help names Curated Thoughts', async () => {
    const { fn, calls } = recorder([ok('impostor'), ok('Curated Thoughts CLI')]);
    const loc = new CtLocator({ env: {}, spawnFn: fn, candidates: () => ['rel/ct', '/a/ct', '/b/ct'], usable: () => true });
    expect(await loc.locate()).toBe('/b/ct');
    expect(calls.map((c) => c.command)).toEqual(['/a/ct', '/b/ct']);
    expect(await loc.locate()).toBe('/b/ct');
    expect(calls).toHaveLength(2);
  });

  it('caches a miss, and invalidate() forces a fresh walk', async () => {
    const { fn, calls } = recorder([ok('nope')]);
    const loc = new CtLocator({ env: {}, spawnFn: fn, candidates: () => ['/a/ct'], usable: () => true });
    expect(await loc.locate()).toBeNull();
    expect(await loc.locate()).toBeNull();
    expect(calls).toHaveLength(1);
    loc.invalidate();
    await loc.locate();
    expect(calls).toHaveLength(2);
  });

  it('stops the walk on a probe timeout without caching a miss', async () => {
    const { fn, calls } = recorder([timeout]);
    const loc = new CtLocator({ env: {}, spawnFn: fn, candidates: () => ['/a/ct', '/b/ct'], usable: () => true });
    expect(await loc.locate()).toBeNull();
    expect(calls).toHaveLength(1);
    await loc.locate();
    expect(calls).toHaveLength(2);
  });
});

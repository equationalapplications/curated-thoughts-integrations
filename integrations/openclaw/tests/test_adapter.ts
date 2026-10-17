import { describe, it, expect } from 'vitest';
import type { SpawnFn, SpawnOutcome } from '@equational-applications/ct-wisdom-core';
import {
  OpenClawWisdomAdapter,
  isRecallToolName,
  snapshotScan,
} from '../src/wisdom/adapter.js';
import { CtLocator } from '../src/wisdom/discover.js';

const ok = (stdout: string, code = 0): SpawnOutcome => ({ code, stdout, stderr: '', spawnError: false, timedOut: false });

function adapterWith(fn: SpawnFn): OpenClawWisdomAdapter {
  const locator = new CtLocator({ env: {}, spawnFn: fn, candidates: () => ['/fake/ct'], usable: () => true });
  return new OpenClawWisdomAdapter({ spawnFn: fn, locator });
}
const noSpawn: SpawnFn = async () => ok('Curated Thoughts');

function recall(entries: Array<Record<string, unknown>>, prefix = ''): { content: Array<{ type: string; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: 'text', text: prefix + JSON.stringify({ wiki_entries: entries, chunks: [] }) }], details: { mcp: true } };
}

describe('snapshotScan (ledger source = before_prompt_build messages, F8/F9)', () => {
  it('reads user content, the persisted model-prompt projection, and tool results — newest first', () => {
    const messages = [
      { role: 'user', content: 'hi', __openclaw: { modelPromptProjection: { version: 1, text: '**A** <!-- ct-fact:a -->\n\nhi' } } },
      { role: 'assistant', content: [{ type: 'text', text: 'ct-fact:ignored-assistant' }] },
      { role: 'toolResult', content: [{ type: 'text', text: '{"wiki_entries":[]}\n<!-- ct-fact:t -->' }] },
      { role: 'user', content: [{ type: 'text', text: 'second <!-- ct-fact:b -->' }] },
    ];
    const scan = snapshotScan(messages);
    expect(scan.all).toEqual(['b', 't', 'a']);
  });

  it('tolerates junk without throwing', () => {
    expect(snapshotScan([null, 3, { role: 'user', content: 5 }, { role: 'user', __openclaw: { modelPromptProjection: 'x' } }]).all).toEqual([]);
    expect(snapshotScan('nope' as unknown as unknown[]).all).toEqual([]);
  });
});

describe('ledger rebuild', () => {
  it('unions snapshot, drained injection ids and bootstrap ids; bootstrap known only when settled', () => {
    const a = adapterWith(noSpawn);
    a.setTurn('s', { messages: [{ role: 'user', content: '<!-- ct-fact:m -->' }], drained: ['d'], bootstrapIds: ['boot'], restored: false });
    const l = a.rebuildLedger({ id: 's' });
    expect(l.idsMostRecentFirst).toEqual(['d', 'm', 'boot']);
    expect(l.has('boot')).toBe(true);
    expect(l.knownBootstrap).toBe(true);
    a.setTurn('s', { messages: [], drained: [], bootstrapIds: null, restored: true });
    expect(a.rebuildLedger({ id: 's' }).knownBootstrap).toBe(false);
    expect(a.restored({ id: 's' })).toBe(true);
  });

  it('an unknown session is an empty ledger', () => {
    expect(adapterWith(noSpawn).rebuildLedger({ id: 'nobody' }).idsMostRecentFirst).toEqual([]);
  });
});

describe('run ledger (autonomous-work spec 2026-10-17: ids that entered context during the run)', () => {
  const turn = (runId: string, ids: string[] = []) => ({
    runId,
    messages: ids.map((id) => ({ role: 'toolResult', content: [{ type: 'text', text: `<!-- ct-fact:${id} -->` }] })),
    drained: [] as string[],
    bootstrapIds: ['boot'],
    restored: false,
  });

  it('noteRunIds joins the ledger newest first, only for the current run', () => {
    const a = adapterWith(noSpawn);
    a.setTurn('s', turn('r1', ['snap']));
    expect(a.hasRun('s', 'r1')).toBe(true);
    expect(a.hasRun('s', 'r2')).toBe(false);
    expect(a.hasRun('other', 'r1')).toBe(false);
    a.noteRunIds('s', 'r1', ['x', 'bad id', 'y']);
    a.noteRunIds('s', 'r2', ['stale']);
    expect(a.rebuildLedger({ id: 's' }).idsMostRecentFirst).toEqual(['y', 'x', 'snap', 'boot']);
  });

  it('a new runId resets the run ledger (its tool results are in the next snapshot); the same runId keeps it', () => {
    const a = adapterWith(noSpawn);
    a.setTurn('s', turn('r1'));
    a.noteRunIds('s', 'r1', ['x']);
    a.setTurn('s', turn('r1')); // a second attempt of the same run
    expect(a.rebuildLedger({ id: 's' }).has('x')).toBe(true);
    a.setTurn('s', turn('r2', ['x']));
    a.noteRunIds('s', 'r2', ['z']);
    expect(a.rebuildLedger({ id: 's' }).idsMostRecentFirst).toEqual(['z', 'x', 'boot']);
  });

  it('cacheLedger unions into the run ledger; cachedLedger is scoped to the run', () => {
    const a = adapterWith(noSpawn);
    a.setTurn('s', turn('r1'));
    a.cacheLedger({ id: 's' }, { idsMostRecentFirst: ['c'], has: (id) => id === 'c', knownBootstrap: true });
    expect(a.cachedLedger({ id: 's' })?.idsMostRecentFirst).toEqual(['c']);
    expect(a.rebuildLedger({ id: 's' }).has('c')).toBe(true);
    a.setTurn('s', turn('r2'));
    expect(a.cachedLedger({ id: 's' })).toBeNull();
    expect(a.rebuildLedger({ id: 's' }).has('c')).toBe(false);
  });

  it('a turn without a runId (legacy callers) still caches for the session', () => {
    const a = adapterWith(noSpawn);
    a.setTurn('s', { messages: [], drained: [], bootstrapIds: null, restored: false });
    a.cacheLedger({ id: 's' }, { idsMostRecentFirst: ['c'], has: (id) => id === 'c', knownBootstrap: false });
    expect(a.cachedLedger({ id: 's' })?.has('c')).toBe(true);
  });
});

describe('N3 recall envelope (m4)', () => {
  it('matches only the projected curated_recall_context tool (incl. collision suffix)', () => {
    expect(isRecallToolName('curated-thoughts__curated_recall_context')).toBe(true);
    expect(isRecallToolName('ct__curated_recall_context-2')).toBe(true);
    expect(isRecallToolName('curated-thoughts__curated_get_wiki_entry')).toBe(false);
    expect(isRecallToolName('curated_recall_context')).toBe(false);
    expect(isRecallToolName(undefined)).toBe(false);
  });

  it('parses ids from plain and structuredContent-prefixed envelopes', () => {
    const a = adapterWith(noSpawn);
    expect(a.envelopeFactIds(recall([{ id: 'x' }, { id: 'y' }, { id: 'bad id' }]))).toEqual(['x', 'y']);
    expect(a.envelopeFactIds(recall([{ id: 'z' }], 'structuredContent:\n'))).toEqual(['z']);
    expect(a.isCtRecallResult({ content: [{ type: 'text', text: 'plain' }] })).toBe(false);
    expect(a.isCtRecallResult(null)).toBe(false);
  });

  it('stubs repeats and appends one marker trailer line per new id, keeping details', () => {
    const a = adapterWith(noSpawn);
    const out = a.rewriteEnvelopeStub(recall([{ id: 'old', text: 'secret' }, { id: 'new', text: 'fresh' }]), ['old'], ['new']) as ReturnType<typeof recall>;
    const text = out.content[0].text;
    const [json, ...trailer] = text.split('\n');
    const inner = JSON.parse(json);
    expect(inner.wiki_entries[0]).toEqual({ id: 'old', in_context: true, note: 'already in context: ct-fact:old' });
    expect(inner.wiki_entries[1].text).toBe('fresh');
    expect(inner.chunks).toEqual([]);
    expect(trailer).toEqual(['<!-- ct-fact:new -->']);
    expect(out.details).toEqual({ mcp: true });
  });

  it('keeps the structuredContent prefix when rewriting', () => {
    const a = adapterWith(noSpawn);
    const out = a.rewriteEnvelopeStub(recall([{ id: 'old' }], 'structuredContent:\n'), ['old'], []) as ReturnType<typeof recall>;
    expect(out.content[0].text.startsWith('structuredContent:\n{')).toBe(true);
  });
});

describe('wisdomMatch capability probe', () => {
  it('probes `ct wisdom match --help` once, then calls match with the core argv', async () => {
    const calls: string[][] = [];
    const fn: SpawnFn = async (spec) => {
      calls.push(spec.args);
      if (spec.args[0] === '--help') return ok('Curated Thoughts');
      if (spec.args.includes('--help')) return ok('usage');
      return ok(JSON.stringify({ entries: [{ id: 'w', title: 't', text: 'x' }], corrections: [] }));
    };
    const a = adapterWith(fn);
    const r1 = await a.wisdomMatch('q', 2, ['e1']);
    const r2 = await a.wisdomMatch('q', 2, []);
    expect(r1.outcome).toBe('ok');
    expect(r2.result?.entries[0].id).toBe('w');
    expect(calls.filter((c) => c.join(' ') === 'wisdom match --help')).toHaveLength(1);
    expect(calls).toContainEqual(['wisdom', 'match', '--json', '--max', '2', '--exclude=e1', '--', 'q']);
  });

  it('latches absent when the subcommand exits non-zero (older CT)', async () => {
    const fn: SpawnFn = async (spec) => (spec.args[0] === '--help' ? ok('Curated Thoughts') : ok('', 2));
    const a = adapterWith(fn);
    await a.wisdomMatch('q', 2, []);
    expect(a.wisdomMatchAbsent()).toBe(true);
  });

  it('reports spawn when no ct binary is found', async () => {
    const fn: SpawnFn = async () => ok('impostor');
    expect((await adapterWith(fn).wisdomMatch('q', 2, [])).outcome).toBe('spawn');
  });
});

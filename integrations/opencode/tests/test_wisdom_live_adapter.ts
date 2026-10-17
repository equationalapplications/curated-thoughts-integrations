/**
 * test_wisdom_live_adapter.ts — unit suite for the OpenCode HostAdapter binding
 * (leg spec 2026-10-16, LD2/LD5/LD6/LD7/LD9). Spawns, history and session
 * lookups are injected; no real `ct` or host runs here.
 */

import { describe, it, expect } from 'vitest';

import {
  BOOT_MARKER,
  LIVE_MARKER,
  OpenCodeWisdomAdapter,
  isOurPart,
  isRecallToolName,
  partId,
  runToolResult,
  runUserTurn,
  userQueryText,
  type AdapterDeps,
  type HistoryRow,
} from '../src/wisdom-live/adapter.js';
import { Breaker, type SpawnFn, type SpawnOutcome } from '@equational-applications/ct-wisdom-core';

function out(o: Partial<SpawnOutcome>): SpawnOutcome {
  return {
    code: o.code ?? 0,
    stdout: o.stdout ?? '',
    stderr: o.stderr ?? '',
    spawnError: o.spawnError ?? false,
    timedOut: o.timedOut ?? false,
  };
}

const matchStdout = (ids: string[]) =>
  JSON.stringify({ entries: ids.map((id) => ({ id, title: `T ${id}`, text: `fact ${id}` })), corrections: [] });

function make(over: Partial<AdapterDeps> & { rows?: Record<string, HistoryRow[]>; parents?: Record<string, string | undefined>; match?: string[] } = {}) {
  const spawns: Array<{ args: string[] }> = [];
  const rows = over.rows ?? {};
  const spawnFn: SpawnFn =
    over.spawnFn ??
    ((spec) => {
      spawns.push({ args: spec.args });
      if (spec.args.includes('--help')) return Promise.resolve(out({}));
      return Promise.resolve(out({ stdout: matchStdout(over.match ?? []) }));
    });
  const a = new OpenCodeWisdomAdapter({
    env: {},
    discover: () => ({ path: '/bin/ct', failure: null }),
    fetchHistory: over.fetchHistory ?? (async (id) => rows[id] ?? []),
    fetchSession:
      over.fetchSession ??
      (async (id) => (over.parents && id in over.parents ? { parentID: over.parents[id] } : { })),
    spawnFn,
    ...(over.now ? { now: over.now } : {}),
  });
  return { a, spawns, rows };
}

const userRow = (...parts: unknown[]): HistoryRow => ({ info: { role: 'user' }, parts });
const asstRow = (...parts: unknown[]): HistoryRow => ({ info: { role: 'assistant' }, parts });
const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: t, ...extra });
const livePart = (ids: string[]) =>
  text(`block ${ids.map((i) => `<!-- ct-fact:${i} -->`).join(' ')}\n\n${LIVE_MARKER}`, { synthetic: true });
const bootPart = (ids: string[]) =>
  text(`boot ${ids.map((i) => `<!-- ct-fact:${i} -->`).join(' ')}\n\n${BOOT_MARKER}`, { synthetic: true });
const toolPart = (output: string) => ({ type: 'tool', tool: 'x', state: { status: 'completed', output } });

const recallText = (ids: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, wiki_entries: ids.map((id) => ({ id, title: `T ${id}`, text: `body ${id}` })) });
const mcpResult = (t: string) => ({ content: [{ type: 'text', text: t }], structuredContent: { keep: true } });

describe('isRecallToolName (H6)', () => {
  it('matches the OpenCode MCP name and the Hermes form, never get_wiki_entry', () => {
    expect(isRecallToolName('curated-thoughts_curated_recall_context')).toBe(true);
    expect(isRecallToolName('mcp__curated-thoughts__curated_recall_context')).toBe(true);
    expect(isRecallToolName('curated_recall_context')).toBe(true);
    expect(isRecallToolName('curated-thoughts_curated_get_wiki_entry')).toBe(false);
    expect(isRecallToolName('curated-thoughts_curated_recall_contextual')).toBe(false);
    expect(isRecallToolName('xcurated_recall_context')).toBe(false);
    expect(isRecallToolName(undefined)).toBe(false);
  });
});

describe('partId (LD9 / H2)', () => {
  it('has the host format and is strictly ascending', () => {
    const ids = Array.from({ length: 50 }, () => partId(1_760_000_000_000));
    for (const id of ids) expect(id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(partId(1_760_000_000_500) > ids.at(-1)!).toBe(true);
  });
});

describe('userQueryText + isOurPart (LD8)', () => {
  it('uses genuine user text only', () => {
    const parts = [
      text('what is the tire pressure?'),
      text('Called the Read tool with the following input: {}', { synthetic: true }),
      text('ignored', { ignored: true }),
      livePart(['a']),
      { type: 'file', url: 'x' },
      text('second line'),
    ];
    expect(userQueryText(parts)).toBe('what is the tire pressure?\nsecond line');
    expect(userQueryText([livePart(['a']), bootPart(['b'])])).toBe('');
    expect(userQueryText(null as unknown as unknown[])).toBe('');
  });
  it('recognizes our parts by exact marker line + synthetic flag', () => {
    expect(isOurPart(livePart(['a']))).toBe(true);
    expect(isOurPart(bootPart(['a']))).toBe(true);
    expect(isOurPart(text(`x\n${LIVE_MARKER}`))).toBe(false); // not synthetic
    expect(isOurPart(text(`x ${LIVE_MARKER} y`, { synthetic: true }))).toBe(false); // not a line
  });
});

describe('ledger (LD5/LD6, AC 3)', () => {
  it('scans user, assistant and completed tool rows newest first', async () => {
    const { a } = make({
      rows: {
        s: [
          userRow(text('hi'), livePart(['old'])),
          asstRow(text('ok'), toolPart(`${recallText(['t1'])}\n<!-- ct-fact:t1 -->`)),
          userRow(text('again'), livePart(['new'])),
        ],
      },
    });
    const l = await a.rebuildLedgerAsync({ id: 's' });
    expect(l.idsMostRecentFirst).toEqual(['new', 't1', 'old']);
  });

  it('bootstrap ids and tool trailers join the ledger', async () => {
    const { a } = make({
      rows: { s: [userRow(text('hi'), bootPart(['b1', 'b2'])), asstRow(toolPart('<!-- ct-fact:t9 -->'))] },
    });
    const l = await a.rebuildLedgerAsync({ id: 's' });
    expect(new Set(l.idsMostRecentFirst)).toEqual(new Set(['b1', 'b2', 't9']));
    expect(l.knownBootstrap).toBe(true);
  });

  it('memo bootstrap ids join the ledger before the block is persisted', async () => {
    const { a } = make();
    a.setBootstrap('s', `## H\n\n**x** <!-- ct-fact:b1 -->\ny\n\n**z** <!-- ct-fact:b2 -->\nw`);
    expect(a.bootstrapMemo['s']!.ids).toEqual(['b1', 'b2']);
    const l = await a.rebuildLedgerAsync({ id: 's' });
    expect(l.has('b1') && l.has('b2')).toBe(true);
  });

  it('ids delivered by this process join the ledger even before the host persists them', async () => {
    const { a } = make();
    a.noteDelivered({ id: 's' }, ['d1']);
    const l = await a.rebuildLedgerAsync({ id: 's' });
    expect(l.idsMostRecentFirst[0]).toBe('d1');
    // noteDelivered never writes into the bootstrap memo
    expect(a.bootstrapMemo['s']).toBeUndefined();
  });

  it('a failing history fetch yields an empty (fail-open) ledger', async () => {
    const { a } = make({ fetchHistory: async () => { throw new Error('down'); } });
    const l = await a.rebuildLedgerAsync({ id: 's' });
    expect(l.idsMostRecentFirst).toEqual([]);
  });

  it('decision 3 carry-forward: post-compaction ledger ⊇ pre-compaction ∪ deliveries', async () => {
    const rows: Record<string, HistoryRow[]> = { s: [userRow(text('hi'), livePart(['p1'])), asstRow(toolPart('<!-- ct-fact:p2 -->'))] };
    const { a } = make({ rows });
    const pre = await a.rebuildLedgerAsync({ id: 's' });
    await a.snapshotForCompaction('s');
    // A host that DELETED compacted rows (worst case; 1.18.35 keeps them, H3):
    rows['s'] = [asstRow(text('summary'))];
    a.noteDelivered({ id: 's' }, ['p3']);
    const post = await a.rebuildLedgerAsync({ id: 's' });
    for (const id of [...pre.idsMostRecentFirst, 'p3']) expect(post.has(id), id).toBe(true);
  });

  it('next trigger reads exactly what the host returns (no in-flight payload)', async () => {
    const rows: Record<string, HistoryRow[]> = { s: [] };
    const { a } = make({ rows });
    expect((await a.rebuildLedgerAsync({ id: 's' })).idsMostRecentFirst).toEqual([]);
    rows['s'] = [userRow(text('q'), livePart(['x']))];
    expect((await a.rebuildLedgerAsync({ id: 's' })).idsMostRecentFirst).toEqual(['x']);
    expect(a.hasUserHistory('s')).toBe(true);
  });
});

describe('subagent policy (LD7)', () => {
  it('parent sessions deliver; child and unknown sessions do not', async () => {
    const { a } = make({ parents: { p: undefined, c: 'p' }, fetchSession: async (id) => (id === 'p' ? {} : id === 'c' ? { parentID: 'p' } : null) });
    expect(await a.sessionKind('p')).toBe('parent');
    expect(await a.sessionKind('c')).toBe('child');
    expect(await a.sessionKind('u')).toBe('child');
    expect(a.deliveryEnabled({ id: 'p' })).toBe(true);
    expect(a.deliveryEnabled({ id: 'c' })).toBe(false);
    expect(a.deliveryEnabled({ id: 'never-looked-up' })).toBe(false);
  });

  it('a throwing session lookup is fail-safe (child), cached 10 s, then retried (0.4.1)', async () => {
    let calls = 0;
    let clock = 1_000;
    const { a } = make({ now: () => clock, fetchSession: async () => { calls++; if (calls === 1) throw new Error('x'); return {}; } });
    expect(await a.sessionKind('s')).toBe('child');
    expect(await a.sessionKind('s')).toBe('child'); // within the TTL: no second lookup
    expect(calls).toBe(1);
    clock += 10_001;
    expect(await a.sessionKind('s')).toBe('parent');
    expect(calls).toBe(2);
  });

  it('child ledger = child history ∪ parent history (best-effort)', async () => {
    const { a } = make({
      rows: { p: [userRow(text('q'), livePart(['pf']))], c: [asstRow(toolPart('<!-- ct-fact:cf -->'))] },
      fetchSession: async (id) => (id === 'c' ? { parentID: 'p' } : {}),
    });
    await a.sessionKind('c');
    const l = await a.rebuildLedgerAsync({ id: 'c' });
    expect(l.has('pf') && l.has('cf')).toBe(true);
  });

  it('parent fetch failure → child history alone', async () => {
    const { a } = make({
      fetchHistory: async (id) => { if (id === 'p') throw new Error('x'); return [asstRow(toolPart('<!-- ct-fact:cf -->'))]; },
      fetchSession: async (id) => (id === 'c' ? { parentID: 'p' } : {}),
    });
    await a.sessionKind('c');
    const l = await a.rebuildLedgerAsync({ id: 'c' });
    expect(l.idsMostRecentFirst).toEqual(['cf']);
  });

  it('child sessions never deliver through the engine', async () => {
    const { a, spawns } = make({ match: ['f1'], fetchSession: async () => ({ parentID: 'p' }) });
    await a.sessionKind('c');
    await a.rebuildLedgerAsync({ id: 'c' });
    expect(await runUserTurn(a, { id: 'c' }, 'question', new Breaker())).toBeNull();
    expect(spawns.length).toBe(0);
  });
});

describe('N3 envelope on the real MCP shape (LD2 / H5)', () => {
  it('rewrites content[].text: stubs repeats, trails new ids, keeps other keys', async () => {
    const { a } = make({ rows: { s: [userRow(text('q'), livePart(['seen']))] } });
    await a.sessionKind('s');
    await a.rebuildLedgerAsync({ id: 's' });
    const input = mcpResult(recallText(['seen', 'fresh'], { query: 'q', meta: { n: 2 } }));
    const res = runToolResult(a, { id: 's' }, input) as typeof input;
    expect(res.structuredContent).toEqual({ keep: true });
    const [line1, ...rest] = res.content[0]!.text.split('\n');
    const inner = JSON.parse(line1!);
    expect(inner.query).toBe('q');
    expect(inner.meta).toEqual({ n: 2 });
    expect(inner.wiki_entries[0]).toEqual({ id: 'seen', in_context: true, note: 'already in context: ct-fact:seen' });
    expect(inner.wiki_entries[1].text).toBe('body fresh');
    expect(rest).toEqual(['<!-- ct-fact:fresh -->']);
  });

  it('accepts the Hermes {result} wrapper and keeps its keys', async () => {
    const { a } = make();
    await a.rebuildLedgerAsync({ id: 's' });
    const wrapped = JSON.stringify({ result: recallText(['n1']), isError: false });
    const res = runToolResult(a, { id: 's' }, mcpResult(wrapped)) as ReturnType<typeof mcpResult>;
    const outer = JSON.parse(res.content[0]!.text.split('\n')[0]!);
    expect(outer.isError).toBe(false);
    expect(outer.result).toContain('<!-- ct-fact:n1 -->');
  });

  it('parses line 1 only (trailers never reach JSON.parse) and handles plain strings', async () => {
    const { a } = make();
    await a.rebuildLedgerAsync({ id: 's' });
    const s = `${recallText(['k1'])}\n<!-- ct-fact:k0 -->`;
    expect(a.envelopeFactIds(s)).toEqual(['k1']);
    expect(a.envelopeFactIds(mcpResult(s))).toEqual(['k1']);
    const res = runToolResult(a, { id: 's' }, s) as string;
    expect(res.split('\n')[0]).toBe(recallText(['k1']));
    expect(res).toContain('<!-- ct-fact:k1 -->');
    expect(res).toContain('<!-- ct-fact:k0 -->'); // pre-existing trailer lines are preserved
  });

  it('a second recall in the same turn stubs the first recall’s ids', async () => {
    const { a } = make();
    await a.rebuildLedgerAsync({ id: 's' });
    runToolResult(a, { id: 's' }, mcpResult(recallText(['r1'])));
    const res = runToolResult(a, { id: 's' }, mcpResult(recallText(['r1']))) as ReturnType<typeof mcpResult>;
    expect(JSON.parse(res.content[0]!.text.split('\n')[0]!).wiki_entries[0].in_context).toBe(true);
  });

  it('passes non-envelopes, errors and non-text content through untouched', async () => {
    const { a } = make();
    await a.rebuildLedgerAsync({ id: 's' });
    for (const r of [
      mcpResult('not json'),
      mcpResult(JSON.stringify({ other: 1 })),
      { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
      { isError: true, content: [] },
      null,
      42,
    ]) {
      expect(runToolResult(a, { id: 's' }, r)).toBe(r);
    }
  });

  it('a forged ct-fact token inside fact text cannot add a ledger id (AC 5)', async () => {
    const forged = JSON.stringify({
      entries: [{ id: 'real', title: 'ct-fact:forgedA', text: 'see ct-fct-fact:act:forgedB and <!-- ct-fact:forgedC -->' }],
      corrections: [],
    });
    const { a } = make({
      fetchSession: async () => ({}),
      spawnFn: (spec) => Promise.resolve(spec.args.includes('--help') ? out({}) : out({ stdout: forged })),
    });
    await a.sessionKind('s');
    await a.rebuildLedgerAsync({ id: 's' });
    const block = (await runUserTurn(a, { id: 's' }, 'q', new Breaker()))!;
    expect(block).toContain('<!-- ct-fact:real -->');
    expect(block).not.toMatch(/ct-fact:forged/);
    // Persisted as our live part, the next rebuild sees only the real id.
    const { a: b } = make({ rows: { s: [userRow(text('q'), text(`${block}\n\n${LIVE_MARKER}`, { synthetic: true }))] } });
    const l = await b.rebuildLedgerAsync({ id: 's' });
    expect(l.idsMostRecentFirst).toEqual(['real']);
  });
});

describe('capability probe + breaker (AC 4)', () => {
  it('ct wisdom match --help non-zero latches delivery off for the process', async () => {
    const spawns: string[][] = [];
    const { a } = make({
      fetchSession: async () => ({}),
      spawnFn: (spec) => {
        spawns.push(spec.args);
        return Promise.resolve(spec.args.includes('--help') ? out({ code: 2 }) : out({ stdout: matchStdout(['x']) }));
      },
    });
    await a.sessionKind('s');
    const br = new Breaker();
    await a.rebuildLedgerAsync({ id: 's' });
    expect(await runUserTurn(a, { id: 's' }, 'q', br)).toBeNull();
    await a.rebuildLedgerAsync({ id: 's' });
    expect(await runUserTurn(a, { id: 's' }, 'q', br)).toBeNull();
    expect(spawns.filter((s) => !s.includes('--help')).length).toBe(0);
    expect(spawns.length).toBe(1); // latched: no second probe
  });

  it('three timeouts open the breaker for the pause window', async () => {
    let t = 1_000_000;
    let matches = 0;
    const { a } = make({
      fetchSession: async () => ({}),
      spawnFn: (spec) => {
        if (spec.args.includes('--help')) return Promise.resolve(out({}));
        matches++;
        return Promise.resolve(out({ timedOut: true, code: null }));
      },
    });
    await a.sessionKind('s');
    const br = new Breaker(3, 300_000, () => t);
    for (let i = 0; i < 5; i++) {
      await a.rebuildLedgerAsync({ id: 's' });
      expect(await runUserTurn(a, { id: 's' }, 'q', br)).toBeNull();
    }
    expect(matches).toBe(3);
    t += 300_001;
    await a.rebuildLedgerAsync({ id: 's' });
    await runUserTurn(a, { id: 's' }, 'q', br);
    expect(matches).toBe(4); // half-open probe after the pause
  });
});

describe('n3: a spawn-class failure retries discovery next turn', () => {
  it('resetDiscoveryAndProbeCaches drops the accepted ct path, not just the probe latch', async () => {
    let invalidations = 0;
    const a = new OpenCodeWisdomAdapter({
      env: {},
      discover: () => ({ path: '/gone/ct', failure: null }),
      invalidateDiscovery: () => {
        invalidations++;
      },
      fetchSession: async () => ({}),
      spawnFn: () => Promise.resolve(out({ spawnError: true, code: null })),
    });
    await a.sessionKind('s');
    await a.rebuildLedgerAsync({ id: 's' });
    expect(await runUserTurn(a, { id: 's' }, 'q', new Breaker())).toBeNull();
    expect(invalidations).toBe(1);
  });
});

describe('capability probe caching (PR #42 review)', () => {
  it('probes `wisdom match --help` once per accepted path, again only after an n3 reset', async () => {
    let helps = 0;
    const { a } = make({
      fetchSession: async () => ({}),
      spawnFn: (spec) => {
        if (spec.args.includes('--help')) {
          helps++;
          return Promise.resolve(out({}));
        }
        return Promise.resolve(out({ stdout: matchStdout([]) }));
      },
    });
    await a.sessionKind('s');
    for (let i = 0; i < 3; i++) {
      await a.rebuildLedgerAsync({ id: 's' });
      await runUserTurn(a, { id: 's' }, `q${i}`, new Breaker());
    }
    expect(helps).toBe(1);
    a.resetDiscoveryAndProbeCaches();
    await a.rebuildLedgerAsync({ id: 's' });
    await runUserTurn(a, { id: 's' }, 'again', new Breaker());
    expect(helps).toBe(2);
  });
});


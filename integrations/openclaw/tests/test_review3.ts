/**
 * Post-merge review of openclaw 0.3.0 → 0.3.1: one regression test per finding.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVITY_HEADING, EXCLUDE_MAX, type SpawnFn, type SpawnLike } from '@equational-applications/ct-wisdom-core';
import { PLUGIN_VERSION, createPlugin, processStateHolder, type StateHolder } from '../src/index.js';
import { metaRecallIds } from '../src/wisdom/activity.js';
import { OpenClawWisdomAdapter } from '../src/wisdom/adapter.js';
import { CtLocator } from '../src/wisdom/discover.js';
import { FakeApi, FakeCt, TIMEOUT, ok, type Fact } from './fake_host.js';

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'ocl-r3-')));
mkdirSync(join(PROJECT, '.git'));
const S = 'agent:main:main';
const FACT = (id: string): Fact => ({ id, title: `Title ${id}`, text: `body ${id}` });
type Result = { content: Array<{ type: string; text: string }>; details?: unknown };

function setup(extra: Record<string, unknown> = {}, wrap?: (fn: SpawnFn) => SpawnFn, instances = 1) {
  const ct = new FakeCt();
  const facts = new Map<string, Fact[]>();
  ct.poolFor = (q, max) => (max === 1 ? facts.get(q) ?? [] : []);
  const holder: StateHolder = {};
  const deps = { spawnFn: wrap ? wrap(ct.spawnFn) : ct.spawnFn, env: {}, candidates: () => ['/fake/ct'], usable: () => true, ...extra };
  const apis = Array.from({ length: instances }, () => {
    const api = new FakeApi();
    createPlugin(deps, holder).register(api as never);
    return api;
  });
  const api = apis[apis.length - 1];
  const prompt = (runId: string, messages: unknown[] = []) =>
    api.hook('before_prompt_build')({ prompt: 'q', messages }, { sessionKey: S, sessionId: 'sid', runId, trigger: 'cron' });
  const step = (runId: string, n: number) => api.hook('model_call_started')({ runId, callId: `${runId}:model:${n}` }, { runId, sessionKey: S });
  const mw = (i = 0) => apis[i].middleware[0]?.handler;
  const tool = async (runId: string, toolName: string, args: Record<string, unknown>, result?: Result, id = `tc-${Math.random()}`, i = 0) => {
    const r = result ?? { content: [{ type: 'text', text: 'out' }] };
    const ret = (await mw(i)!({ toolCallId: id, toolName, args, cwd: PROJECT, isError: false, result: r }, { runtime: 'openclaw', sessionKey: S, runId })) as { result: Result } | undefined;
    return ret?.result ?? r;
  };
  const block = (r: Result) => r.content.map((b) => b.text).find((t) => t.startsWith(ACTIVITY_HEADING)) ?? null;
  return { ct, facts, apis, holder, prompt, step, tool, mw, block };
}

const history = (n: number) => [{ role: 'toolResult', content: [{ type: 'text', text: Array.from({ length: n }, (_, i) => `<!-- ct-fact:h${i} -->`).join('\n') }] }];

describe('1. [regression] a long session (300 ids in history) keeps activity and N3', () => {
  it('the run ledger holds only ids new in the run; history is unioned at read time', async () => {
    const h = setup();
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1', history(300));
    h.step('r1', 1);
    const recall = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'h5', text: 'x' }] }) }] };
    const out = await h.tool('r1', 'curated-thoughts__curated_recall_context', {}, recall);
    expect(out.content[0].text).toContain('"in_context":true'); // N3 still works
    h.step('r1', 2);
    expect(h.block(await h.tool('r1', 'read', { path: 'a.ts' }))).toContain('ct-fact:fa'); // activity too
  });

  it('overflow means more than EXCLUDE_MAX NEW ids in one run', () => {
    const fn: SpawnFn = async () => ok('Curated Thoughts');
    const a = new OpenClawWisdomAdapter({ spawnFn: fn, locator: new CtLocator({ env: {}, spawnFn: fn, candidates: () => [], usable: () => true }) });
    a.setTurn('s', { runId: 'r', messages: history(300), drained: [], bootstrapIds: ['b'], restored: false });
    a.cacheLedger({ id: 's' }, a.rebuildLedger({ id: 's' }));
    expect(a.blindReason('s', 'r')).toBeNull();
    a.noteRunIds('s', 'r', ['h1', 'h2']); // already in the snapshot: not new
    expect(a.blindReason('s', 'r')).toBeNull();
    a.noteRunIds('s', 'r', Array.from({ length: EXCLUDE_MAX + 1 }, (_, i) => `n${i}`));
    expect(a.blindReason('s', 'r')).toBe('ledger_overflow');
  });
});

describe('2. N3 + activity are idempotent per tool result across module instances', () => {
  it('a second middleware pass over the same recall result changes nothing', async () => {
    const h = setup({}, undefined, 2);
    await h.prompt('r1', [{ role: 'toolResult', content: [{ type: 'text', text: '<!-- ct-fact:old -->' }] }]);
    const recall = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'old', text: 'x' }, { id: 'new', text: 'y' }] }) }] };
    const first = await h.tool('r1', 'curated-thoughts__curated_recall_context', {}, recall, 'tc-1', 0);
    expect(first.content[0].text).toContain('ct-fact:new');
    const second = await h.tool('r1', 'curated-thoughts__curated_recall_context', {}, first, 'tc-1', 1);
    expect(second).toEqual(first);
    const inner = JSON.parse(second.content[0].text.split('\n')[0]) as { wiki_entries: Array<Record<string, unknown>> };
    expect(inner.wiki_entries[1]).toMatchObject({ id: 'new', text: 'y' }); // not stubbed by the second pass
  });

  it('a second pass over an activity result adds no block and makes no query', async () => {
    const h = setup({}, undefined, 2);
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.step('r1', 1);
    const first = await h.tool('r1', 'read', { path: 'a.ts' }, undefined, 'tc-a', 0);
    const second = await h.tool('r1', 'read', { path: 'a.ts' }, first, 'tc-a', 1);
    expect(second).toEqual(first);
    expect(h.ct.activityQueries()).toEqual(['a.ts']);
  });
});

describe('3. a retryable outcome frees the key but keeps the step used', () => {
  it('after a timeout, another result of the SAME step makes no second call; a later step retries', async () => {
    const h = setup();
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.ct.matchOutcome = () => TIMEOUT;
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'a.ts' });
    h.ct.matchOutcome = null;
    await h.tool('r1', 'read', { path: 'b.ts' });
    expect(h.ct.activityQueries()).toEqual(['a.ts']);
    h.step('r1', 2);
    expect(h.block(await h.tool('r1', 'read', { path: 'a.ts' }))).toContain('ct-fact:fa');
  });
});

describe('4/5. the locate + probe wait is bounded and shared', () => {
  it('probe still pending after the wait → probe_pending, no step claimed, no CT match', async () => {
    let releaseProbe: (() => void) | null = null;
    const slowProbe = (fn: SpawnFn): SpawnFn => async (spec) => {
      if (spec.args.join(' ') === 'wisdom match --help') await new Promise<void>((r) => { releaseProbe = r; });
      return fn(spec);
    };
    const h = setup({ activityReadyMs: 10 }, slowProbe);
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.step('r1', 1);
    expect(h.block(await h.tool('r1', 'read', { path: 'a.ts' }))).toBeNull();
    expect(h.ct.activityQueries()).toEqual([]);
    (releaseProbe as unknown as () => void)();
    await new Promise((r) => setTimeout(r, 5));
    // the step was not claimed: the same step may query once the probe is done
    expect(h.block(await h.tool('r1', 'read', { path: 'a.ts' }))).toContain('ct-fact:fa');
  });

  it('ready(signal) passes the signal to the probe it starts; wisdomMatch reuses the in-flight warm', async () => {
    const probes: SpawnLike[] = [];
    const fn: SpawnFn = async (spec) => {
      if (spec.args[0] === '--help') return ok('Curated Thoughts');
      if (spec.args.includes('--help')) {
        probes.push(spec);
        await new Promise((r) => setTimeout(r, 20));
        return ok('usage');
      }
      return ok(JSON.stringify({ entries: [], corrections: [] }));
    };
    const a = new OpenClawWisdomAdapter({ spawnFn: fn, locator: new CtLocator({ env: {}, spawnFn: fn, candidates: () => ['/fake/ct'], usable: () => true }) });
    const ac = new AbortController();
    const warm = a.ready(ac.signal);
    const [, m] = await Promise.all([warm, a.wisdomMatch('q', 1, [])]);
    expect(probes).toHaveLength(1);
    expect(probes[0].signal).toBe(ac.signal);
    expect(m.outcome).toBe('ok');
  });
});

describe('7. metaRecallIds reads part by part', () => {
  const args = { id: 'mcp:curated-thoughts:curated-thoughts__curated_recall_context' };
  const env = JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'w1' }] }) }] } });
  it('a non-JSON part next to a readable envelope still yields the ids', () => {
    expect(metaRecallIds(args, { content: [{ type: 'text', text: 'banner, not json' }, { type: 'text', text: env }] })).toEqual(['w1']);
  });
  it('JSON parts without an envelope give no ids, not unreadable', () => {
    expect(metaRecallIds(args, { content: [{ type: 'text', text: '{"ok":true}' }] })).toEqual([]);
  });
  it('unreadable only when no part has an envelope AND some part is not JSON', () => {
    expect(metaRecallIds(args, { content: [{ type: 'text', text: 'nope' }] })).toBe('unreadable');
  });
});

describe('8. the process-wide state key carries the package version', () => {
  it('a hot reload of a new build gets fresh state', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
    const g = globalThis as unknown as Record<symbol, unknown>;
    expect(g[Symbol.for(`curated-thoughts.openclaw.plugin-state@${pkg.version}`)]).toBe(processStateHolder());
  });
});

describe('9. an unexpected throw after the claim releases it', () => {
  it('the same step can still query after a throw', async () => {
    const h = setup();
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.step('r1', 1);
    // a throw right after the claim (the tracker admits, then something fails)
    const tracker = (h.holder.state!.activity as unknown as { tracker: { admit: (...a: string[]) => unknown } }).tracker;
    const real = tracker.admit.bind(tracker);
    tracker.admit = (...a: string[]) => {
      real(...a);
      throw new Error('boom');
    };
    const r = await h.tool('r1', 'read', { path: 'a.ts' });
    expect(h.block(r)).toBeNull();
    tracker.admit = real;
    expect(h.block(await h.tool('r1', 'read', { path: 'a.ts' }))).toContain('ct-fact:fa');
  });
});

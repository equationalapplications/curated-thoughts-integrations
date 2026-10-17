/**
 * test_wisdom_activity.ts — DSH autonomous-work delivery (spec
 * docs/superpowers/specs/2026-10-16-dsh-autonomous-work-wisdom-design.md):
 * the DSH tool map, the per-step plan (prefetch at tools/pre-execute, deliver
 * at the next agent/pre-step), the fail-closed classes, the N3 cache update,
 * marker hygiene and verbose mode. All spawns are injected.
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_HEADING,
  Breaker,
  BREAKER_FAILS,
  createVerboseRecorder,
  marker,
  onToolResult,
  scanIds,
} from '@equational-applications/ct-wisdom-core';
import type { SpawnFn, VerboseTurn, WisdomMatchResult } from '@equational-applications/ct-wisdom-core';
import { DshWisdomAdapter } from '../src/wisdom-live/adapter.js';
import {
  ACTIVITY_SOURCE_KIND,
  DshActivity,
  activityMessage,
  dshActivitySpec,
  lastAssistantStep,
} from '../src/wisdom-live/activity.js';

type Msg = Record<string, unknown>;

const text = (t: string) => ({ type: 'text', text: t });
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function assistant(calls: Array<[string, unknown]>, prose = ''): Msg {
  return {
    id: nextId('a'),
    role: 'assistant',
    source: { kind: 'model', provider: 'p', model: 'm' },
    content: [
      ...(prose ? [text(prose)] : []),
      ...calls.map(([name, args]) => ({
        type: 'tool-call',
        id: nextId('call'),
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      })),
    ],
  };
}

function toolResult(callId: string, body: string): Msg {
  return { id: nextId('t'), role: 'tool', source: { kind: 'tool', callId }, content: [text(body)] };
}

const fact = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `T${id}`,
  text: `body ${id}`,
  provenance: 'stated',
  supersedes: [] as string[],
  ...over,
});

interface CtCall {
  query: string;
  max: number;
  exclude: string[];
}

function fakeCt(answer: (q: string, exclude: string[]) => WisdomMatchResult | 'timeout' | 'spawn' | 'hang') {
  const calls: CtCall[] = [];
  const spawnFn: SpawnFn = (spec) => {
    if (spec.args[2] === '--help') {
      return Promise.resolve({ code: 0, stdout: '', stderr: '', spawnError: false, timedOut: false });
    }
    const query = spec.args[spec.args.indexOf('--') + 1] ?? '';
    const exclude = spec.args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice(10));
    calls.push({ query, max: Number(spec.args[spec.args.indexOf('--max') + 1]), exclude });
    const r = answer(query, exclude);
    if (r === 'hang') return new Promise(() => {});
    if (r === 'timeout') return Promise.resolve({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: true });
    if (r === 'spawn') return Promise.resolve({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false });
    return Promise.resolve({ code: 0, stdout: JSON.stringify(r), stderr: '', spawnError: false, timedOut: false });
  };
  return { calls, spawnFn };
}

function setup(
  answer: Parameters<typeof fakeCt>[0] = () => ({ entries: [fact('f1')], corrections: [] }),
  over: { now?: () => number; recordVerbose?: (t: VerboseTurn) => void; breaker?: Breaker } = {},
) {
  const ct = fakeCt(answer);
  const adapter = new DshWisdomAdapter({
    env: {},
    discover: () => ({ path: '/bin/ct', failure: null }),
    spawnFn: ct.spawnFn,
    ...(over.recordVerbose ? { recordVerbose: over.recordVerbose } : {}),
  });
  const breaker = over.breaker ?? new Breaker();
  const activity = new DshActivity({ adapter, breaker, cwd: () => '/work/repo', ...(over.now ? { now: over.now } : {}) });
  const log: Msg[] = [{ id: 'u0', role: 'user', source: { kind: 'user' }, content: [text('do the task')] }];
  const agent = { id: 'agent-1', session: { deriveMessages: () => [...log] } };
  /** One model step: the assistant's calls, pre-execute per call, then results. */
  const step = (calls: Array<[string, unknown]>, results?: string[]): Msg => {
    const msg = assistant(calls);
    log.push(msg);
    const blocks = msg.content as Array<{ type: string; id: string; name: string; arguments: string }>;
    for (const b of blocks.filter((x) => x.type === 'tool-call')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(b.arguments);
      } catch {
        parsed = b.arguments;
      }
      activity.prefetch({ callId: b.id, name: b.name, arguments: parsed, agent });
    }
    blocks
      .filter((x) => x.type === 'tool-call')
      .forEach((b, i) => log.push(toolResult(b.id, results?.[i] ?? 'ok')));
    return msg;
  };
  /** The next pre-step; appends a delivered block to the log like the loop. */
  const pre = async (claimed: unknown[] = [], decision: unknown[] = []): Promise<string | null> => {
    const block = await activity.deliver(agent, claimed, decision);
    if (block !== null) log.push({ ...activityMessage(block) });
    return block;
  };
  return { ct, adapter, breaker, activity, log, agent, step, pre };
}

describe('DSH tool map (spec table)', () => {
  it('maps the pinned tools from their target args only', () => {
    expect(dshActivitySpec('read', { file_path: 'a.ts', offset: 3 })).toEqual({ verb: 'read', path: 'a.ts' });
    expect(dshActivitySpec('write', { file_path: 'a.ts', content: 'SECRET' })).toEqual({ verb: 'write', path: 'a.ts' });
    expect(dshActivitySpec('edit', { file_path: 'a.ts', old_string: 'S', new_string: 'S' })).toEqual({ verb: 'edit', path: 'a.ts' });
    expect(dshActivitySpec('str_replace_editor', { command: 'view', path: '/r/a' })).toEqual({ verb: 'read', path: '/r/a' });
    expect(dshActivitySpec('str_replace_editor', { command: 'create', path: 'b', file_text: 'S' })).toEqual({ verb: 'write', path: 'b' });
    expect(dshActivitySpec('str_replace_editor', { command: 'str_replace', path: 'b', old_str: 'S' })).toEqual({ verb: 'edit', path: 'b' });
    expect(dshActivitySpec('str_replace_editor', { command: 'insert', path: 'b', new_str: 'S' })).toEqual({ verb: 'edit', path: 'b' });
    expect(dshActivitySpec('str_replace_editor', { command: 'undo_edit', path: 'b' })).toBeNull();
    expect(dshActivitySpec('grep', { pattern: 'TODO', path: 'src', include: '*.ts' })).toEqual({ verb: 'search', pattern: 'TODO', path: 'src' });
    expect(dshActivitySpec('glob', { pattern: '**/*.ts' })).toEqual({ verb: 'search', pattern: '**/*.ts', path: undefined });
    expect(dshActivitySpec('bash', { command: 'pnpm test', description: 'SECRET' })).toEqual({ verb: 'run', command: 'pnpm test' });
    expect(dshActivitySpec('pwsh', { command: 'npm test' })).toEqual({ verb: 'run', command: 'npm test' });
    for (const [name, args] of [
      ['read_image', { file_path: 'x.png' }],
      ['web_fetch', { url: 'https://x' }],
      ['curated-thoughts__curated_recall_context', { query: 'x' }],
      ['bash', 'not-an-object'],
      ['bash', null],
      [42, {}],
    ] as Array<[unknown, unknown]>) {
      expect(dshActivitySpec(name, args)).toBeNull();
    }
  });

  it('reads the last assistant message and its tool calls', () => {
    const a = assistant([['bash', { command: 'ls' }], ['read', '{bad json']], 'prose');
    const step = lastAssistantStep([{ role: 'user' }, a, { role: 'tool' }])!;
    expect(step.messageId).toBe(a.id);
    expect(step.calls.map((c) => c.name)).toEqual(['bash', 'read']);
    expect(step.calls[1].args).toBe('{bad json');
    expect(lastAssistantStep([{ role: 'user', content: [] }])).toBeNull();
    expect(lastAssistantStep([assistant([], 'only text')])).toBeNull();
    expect(lastAssistantStep('garbage' as unknown as unknown[])).toBeNull();
  });

  it('builds an identified, frozen user-role message with its own source kind', () => {
    const m = activityMessage('BLOCK');
    expect(m.role).toBe('user');
    expect(typeof m.id).toBe('string');
    expect(m.id.length).toBeGreaterThan(0);
    expect(m.source).toEqual({ kind: ACTIVITY_SOURCE_KIND });
    expect(ACTIVITY_SOURCE_KIND).toBe('curated-thoughts-wisdom-activity');
    expect(m.content).toEqual([{ type: 'text', text: 'BLOCK' }]);
    expect(Object.isFrozen(m)).toBe(true);
    expect(activityMessage('BLOCK').id).not.toBe(m.id);
  });
});

describe('per-step plan and delivery', () => {
  it('delivers one marker-first fact for the bare target at the next pre-step', async () => {
    const s = setup();
    s.step([['bash', { command: 'pnpm test --silent' }]]);
    const block = await s.pre();
    expect(block).not.toBeNull();
    expect(block!.startsWith(`${ACTIVITY_HEADING}\n_for: run pnpm test_\n\n${marker('f1')} **Tf1**`)).toBe(true);
    expect(s.ct.calls).toEqual([{ query: 'pnpm test', max: 1, exclude: [] }]);
  });

  it('two new keys in one step make ONE CT call; the first in model order wins', async () => {
    const s = setup();
    s.step([['read', { file_path: 'src/a.ts' }], ['read', { file_path: 'src/b.ts' }]]);
    await s.pre();
    expect(s.ct.calls.map((c) => c.query)).toEqual(['src/a.ts']);
    // b.ts stayed unseen: a later step can trigger on it.
    s.step([['read', { file_path: 'src/b.ts' }]]);
    await s.pre();
    expect(s.ct.calls.map((c) => c.query)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('the same key in a later step neither re-queries nor re-delivers (read then edit folds)', async () => {
    const s = setup();
    s.step([['bash', { command: 'pnpm test' }]]);
    expect(await s.pre()).not.toBeNull();
    s.step([['bash', { command: 'pnpm test --silent' }]]);
    expect(await s.pre()).toBeNull();
    s.step([['write', { file_path: '.env.local', content: 'FOO=bar' }]]);
    await s.pre();
    s.step([['read', { file_path: '/work/repo/.env.local' }]]);
    expect(await s.pre()).toBeNull();
    expect(s.ct.calls.map((c) => c.query)).toEqual(['pnpm test', '.env.local']);
  });

  it('a seen key is skipped and the next call of the step triggers', async () => {
    const s = setup();
    s.step([['read', { file_path: 'a.ts' }]]);
    await s.pre();
    s.step([['edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }], ['grep', { pattern: 'TODO' }]]);
    await s.pre();
    expect(s.ct.calls.map((c) => c.query)).toEqual(['a.ts', 'TODO']);
  });

  it('prefetch and pre-step share one plan; pre-step plans itself when no prefetch ran', async () => {
    const s = setup();
    s.log.push(assistant([['bash', { command: 'make build' }]])); // no pre-execute
    expect(await s.pre()).not.toBeNull();
    expect(s.ct.calls).toHaveLength(1);
    expect(await s.pre()).toBeNull(); // same step again: consumed, no second CT call
    expect(s.ct.calls).toHaveLength(1);
  });

  it('the prefetch starts CT before the pre-step runs', () => {
    const s = setup();
    s.step([['bash', { command: 'pnpm test' }]]);
    expect(s.ct.calls).toHaveLength(0); // the probe is async; the match follows it
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(s.ct.calls).toHaveLength(1);
      resolve();
    }, 0));
  });

  it('CT tools never trigger (decision 6)', async () => {
    const s = setup();
    s.step([['curated-thoughts__curated_recall_context', { query: 'pnpm test' }],
      ['mcp__curated-thoughts__curated_get_wiki_entry', { id: 'x' }]]);
    expect(await s.pre()).toBeNull();
    expect(s.ct.calls).toEqual([]);
  });

  it('PTC sub-dispatches and calls of an older step never prefetch', () => {
    const s = setup();
    const old = assistant([['bash', { command: 'pnpm test' }]]);
    s.log.push(old, assistant([], 'later text'));
    const call = (old.content as Array<{ id: string }>)[0];
    s.activity.prefetch({ callId: call.id, name: 'bash', arguments: { command: 'pnpm test' }, agent: s.agent });
    s.activity.prefetch({ callId: 'x', name: 'bash', arguments: { command: 'npm test' }, agent: s.agent, parent: Symbol('t') });
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(s.ct.calls).toEqual([]);
      resolve();
    }, 0));
  });

  it('subagents are separate agents with their own tracker and ledger (decision 3)', async () => {
    const s = setup();
    s.step([['bash', { command: 'pnpm test' }]]);
    await s.pre();
    const childLog: Msg[] = [assistant([['bash', { command: 'pnpm test' }]])];
    const child = { id: 'child-1', session: { deriveMessages: () => [...childLog] } };
    expect(await s.activity.deliver(child, [], [])).not.toBeNull();
    expect(s.ct.calls).toHaveLength(2);
  });

  it('excludes the ledger (newest first) and post-filters a CT that ignores --exclude', async () => {
    const s = setup(() => ({ entries: [fact('f1'), fact('f2')], corrections: [] }));
    s.log.push({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [text(`x ${marker('f1')}`)] });
    s.step([['read', { file_path: 'a.ts' }]]);
    const block = await s.pre();
    expect(s.ct.calls[0].exclude).toEqual(['f1']);
    expect(scanIds(block)).toEqual(['f2']);
  });

  it('a recall in the previous step is in the fresh ledger: its id is not delivered', async () => {
    const s = setup(() => ({ entries: [fact('f9')], corrections: [] }));
    s.step([['read', { file_path: 'a.ts' }], ['curated-thoughts__curated_recall_context', { query: 'q' }]],
      ['file body', `{"result":"{}"}\n${marker('f9')}`]);
    expect(await s.pre()).toBeNull();
  });

  it('a correction rides only when it supersedes an id in context', async () => {
    const s = setup(() => ({ entries: [], corrections: [fact('c1', { supersedes: ['old'] }), fact('c2', { supersedes: ['nope'] })] }));
    s.log.push({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [text(marker('old'))] });
    s.step([['read', { file_path: 'a.ts' }]]);
    const block = await s.pre();
    expect(block).toContain('— supersedes ct-fact:old');
    expect(scanIds(block)).toEqual(['c1', 'old']);
  });

  it('teaches the N3 recall dedup the delivered id within the turn', async () => {
    const s = setup();
    s.adapter.cacheLedger({ id: 'agent-1' }, { idsMostRecentFirst: ['u'], has: (i) => i === 'u', knownBootstrap: false });
    s.step([['read', { file_path: 'a.ts' }]]);
    await s.pre();
    expect(s.adapter.cachedLedger({ id: 'agent-1' })!.has('f1')).toBe(true);
    expect(s.adapter.cachedLedger({ id: 'agent-1' })!.has('u')).toBe(true);
    const envelope = { result: JSON.stringify({ wiki_entries: [{ id: 'f1', title: 'T', text: 'full' }] }) };
    const out = onToolResult(s.adapter, { id: 'agent-1' }, envelope) as { result: string };
    expect(out.result).toContain('"in_context":true');
  });
});

describe('core gates apply to activity delivery (review of PR #56)', () => {
  it('a delivery latch that is OFF stops the CT call and the delivery', async () => {
    const s = setup();
    (s.adapter as unknown as { deliveryEnabled: () => boolean }).deliveryEnabled = () => false;
    s.step([['bash', { command: 'pnpm test' }]]);
    expect(await s.pre()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ct.calls).toEqual([]);
  });

  it('a restored session with no known bootstrap fails closed', async () => {
    const s = setup();
    (s.adapter as unknown as { restored: () => boolean }).restored = () => true;
    s.step([['bash', { command: 'pnpm test' }]]);
    expect(await s.pre()).toBeNull();
    // with a known bootstrap it delivers
    const s2 = setup();
    (s2.adapter as unknown as { restored: () => boolean }).restored = () => true;
    s2.adapter.bootstrapMemo['agent-1'] = { block: 'b', ids: ['boot1'] };
    s2.step([['bash', { command: 'pnpm test' }]]);
    expect(await s2.pre()).not.toBeNull();
  });

  it('noteDelivered records the activity id next to the bootstrap memo', async () => {
    const s = setup();
    s.adapter.bootstrapMemo['agent-1'] = { block: 'b', ids: ['boot1'] };
    s.step([['read', { file_path: 'a.ts' }]]);
    await s.pre();
    expect(s.adapter.bootstrapMemo['agent-1'].ids).toEqual(['boot1', 'f1']);
  });
});

describe('plan bookkeeping (review of PR #56)', () => {
  it('a plan survives many other agents planning before its pre-step (no shared 64-slot LRU)', async () => {
    const s = setup();
    s.step([['bash', { command: 'pnpm test' }]]);
    for (let i = 0; i < 100; i++) {
      const log: Msg[] = [assistant([['read', { file_path: `f${i}.ts` }]])];
      const other = { id: `other-${i}`, session: { deriveMessages: () => [...log] } };
      const b = (log[0].content as Array<{ id: string }>)[0];
      s.activity.prefetch({ callId: b.id, name: 'read', arguments: { file_path: `f${i}.ts` }, agent: other });
    }
    expect(await s.pre()).not.toBeNull();
    expect(s.ct.calls.filter((c) => c.query === 'pnpm test')).toHaveLength(1);
  });

  it('prefetch reads the log once per step, not once per tool call', () => {
    const s = setup();
    let reads = 0;
    const derive = s.agent.session.deriveMessages;
    s.agent.session.deriveMessages = () => {
      reads++;
      return derive();
    };
    s.step([['read', { file_path: 'a.ts' }], ['read', { file_path: 'b.ts' }], ['grep', { pattern: 'x' }]]);
    expect(reads).toBe(1);
  });
});

describe('fail closed', () => {
  it('no agent id, no deriveMessages, no assistant step, no tool-call: nothing', async () => {
    const s = setup();
    expect(await s.activity.deliver({ id: '' }, [], [])).toBeNull();
    expect(await s.activity.deliver({ id: 'x' }, [], [])).toBeNull();
    expect(await s.activity.deliver({ id: 'x', session: { deriveMessages: () => { throw new Error('boom'); } } }, [], [])).toBeNull();
    expect(await s.pre()).toBeNull();
    s.log.push(assistant([], 'just text'));
    expect(await s.pre()).toBeNull();
    s.activity.prefetch({});
    s.activity.prefetch(null as unknown as Record<string, unknown>);
    expect(s.ct.calls).toEqual([]);
  });

  it('would-extend-turn: claimed input stripped to nothing → no delivery', async () => {
    const s = setup();
    s.step([['bash', { command: 'pnpm test' }]]);
    expect(await s.pre([{ id: 'steer' }], [])).toBeNull();
    // claimed input still in the decision → the step runs anyway → deliver.
    const s2 = setup();
    s2.step([['bash', { command: 'pnpm test' }]]);
    expect(await s2.pre([{ id: 'steer' }], [{ id: 'steer' }])).not.toBeNull();
  });

  it('breaker open: no CT call; timeouts feed the SHARED breaker', async () => {
    const breaker = new Breaker();
    const s = setup(() => 'timeout', { breaker });
    for (let i = 0; i < BREAKER_FAILS; i++) {
      s.step([['read', { file_path: `f${i}.ts` }]]);
      expect(await s.pre()).toBeNull();
    }
    expect(breaker.isOpen()).toBe(true);
    s.step([['read', { file_path: 'g.ts' }]]);
    expect(await s.pre()).toBeNull();
    expect(s.ct.calls).toHaveLength(BREAKER_FAILS);
  });

  it('spawn failure resets the caches; the budget bounds a hung CT', async () => {
    let now = 1000;
    const s = setup(() => 'hang', { now: () => now });
    s.step([['read', { file_path: 'a.ts' }]]);
    now += 3001;
    const started = Date.now();
    expect(await s.pre()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    const s2 = setup(() => 'spawn');
    s2.step([['read', { file_path: 'a.ts' }]]);
    expect(await s2.pre()).toBeNull();
  });

  it('a settled match is used even past the budget', async () => {
    let now = 1000;
    const s = setup(undefined, { now: () => now });
    s.step([['read', { file_path: 'a.ts' }]]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    now += 60_000;
    expect(await s.pre()).not.toBeNull();
  });

  it('never throws, even with a throwing adapter', async () => {
    const s = setup();
    (s.adapter as unknown as { rebuildLedger: () => never }).rebuildLedger = () => {
      throw new Error('boom');
    };
    s.step([['read', { file_path: 'a.ts' }]]);
    await expect(s.pre()).resolves.toBeNull();
  });
});

describe('marker hygiene', () => {
  it('the marker precedes the title; one marker per block', async () => {
    const s = setup(() => ({ entries: [fact('f1', { text: 'w '.repeat(800) })], corrections: [] }));
    s.step([['read', { file_path: 'a.ts' }]]);
    const block = (await s.pre())!;
    expect(block.length).toBeLessThanOrEqual(600);
    expect(block.indexOf(marker('f1'))).toBeLessThan(block.indexOf('**Tf1**'));
    expect(block.split('ct-fact:').length - 1).toBe(1);
  });

  it('block text copied into a tool argument never becomes a query', async () => {
    const s = setup();
    s.step([['read', { file_path: 'a.ts' }]]);
    const block = (await s.pre())!;
    s.step([['grep', { pattern: block }], ['bash', { command: block }], ['read', { file_path: block }]]);
    await s.pre();
    for (const c of s.ct.calls) {
      expect(c.query).not.toContain('ct-fact:');
      expect(c.query).not.toContain(ACTIVITY_HEADING);
      expect(c.query).not.toContain('Tf1');
    }
  });

  it('the ledger rebuild finds activity markers in the persisted message', async () => {
    const s = setup();
    s.step([['read', { file_path: 'a.ts' }]]);
    await s.pre();
    s.adapter.sessionMessages.set('agent-1', s.agent.session.deriveMessages());
    expect(s.adapter.rebuildLedger({ id: 'agent-1' }).has('f1')).toBe(true);
  });
});

describe('verbose (channel activity)', () => {
  const recorder = (on: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-dsh-act-'));
    const path = join(dir, 'v.jsonl');
    const notices: string[] = [];
    const rec = createVerboseRecorder({
      host: 'deepseek',
      channel: 'agent/pre-step',
      env: { CT_WISDOM_VERBOSE: on ? '1' : '0', CT_WISDOM_VERBOSE_LOG: path },
      logPath: null,
      notify: (t) => notices.push(t),
    });
    const events = () => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { rec, events, notices };
  };

  const run = async (on: boolean) => {
    const v = recorder(on);
    const s = setup(undefined, v.rec ? { recordVerbose: v.rec } : {});
    s.step([['write', { file_path: 'src/x.ts', content: 'SECRET_CONTENT_VALUE' }]]);
    const block = await s.pre();
    return { block, v, s };
  };

  it('off: nothing written and byte-identical delivery', async () => {
    const off = await run(false);
    const on = await run(true);
    expect(off.v.rec).toBeUndefined();
    expect(off.v.events()).toEqual([]);
    expect(off.block).toBe(on.block);
  });

  it('on: one activity delivery record with query, label and id; no content', async () => {
    const { v, block } = await run(true);
    const ev = v.events();
    expect(ev).toHaveLength(1);
    expect([ev[0].host, ev[0].channel, ev[0].event]).toEqual(['deepseek', 'activity', 'delivery']);
    expect(ev[0].query).toBe('src/x.ts');
    expect(ev[0].activity).toBe('write src/x.ts');
    expect(ev[0].delivered_ids).toEqual(['f1']);
    expect(ev[0].block).toBe(block);
    expect(JSON.stringify(ev)).not.toContain('SECRET_CONTENT_VALUE');
    expect(v.notices[0]).toContain('[activity]');
  });

  it('on: a query that delivered nothing is recorded; rate and filter skips are not', async () => {
    const v = recorder(true);
    const s = setup(() => ({ entries: [fact('f1')], corrections: [] }), { recordVerbose: v.rec });
    s.log.push({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [text(marker('f1'))] });
    s.step([['read', { file_path: 'a.ts' }]]);
    await s.pre();
    expect(v.events().map((e) => [e.channel, e.event, e.reason])).toEqual([['activity', 'skip', 'deduped']]);
    s.step([['read', { file_path: 'a.ts' }]]); // seen_key
    await s.pre();
    s.step([['web_fetch', { url: 'x' }], ['curated-thoughts__curated_recall_context', { query: 'x' }]]);
    await s.pre();
    expect(v.events()).toHaveLength(1);
  });

  it('on: breaker_open is recorded once per step for a would-be trigger', async () => {
    const v = recorder(true);
    const breaker = new Breaker();
    for (let i = 0; i < BREAKER_FAILS; i++) breaker.recordFailure();
    const s = setup(undefined, { recordVerbose: v.rec, breaker });
    s.step([['read', { file_path: 'a.ts' }], ['read', { file_path: 'b.ts' }]]);
    await s.pre();
    expect(v.events().map((e) => [e.event, e.reason, e.query])).toEqual([['skip', 'breaker_open', 'a.ts']]);
  });
});

/**
 * Autonomous-work ("activity") delivery on OpenClaw (spec
 * docs/superpowers/specs/2026-10-17-openclaw-autonomous-work-wisdom-design.md),
 * driven through the registered hooks of a booted plugin:
 *
 *   before_prompt_build  — the run's snapshot (ledger source)
 *   model_call_started   — the step id (`<runId>:model:<n>`)
 *   tool-result middleware — the trigger and the channel
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVITY_HEADING, BREAKER_FAILS, type SpawnFn } from '@equational-applications/ct-wisdom-core';
import { FakeApi, FakeCt, TIMEOUT, boot, ok, type Fact } from './fake_host.js';
import { createPlugin, processStateHolder, type PluginDeps } from '../src/index.js';

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'ocl-act-')));
mkdirSync(join(PROJECT, '.git'));
const MAIN = 'agent:main:main';
const FACT = (id: string, text = `body of ${id}`): Fact => ({ id, title: `Title ${id}`, text });

interface ToolResult { content: Array<{ type: string; text?: string }>; details?: unknown }

class Harness {
  readonly ct = new FakeCt();
  readonly api: FakeApi;
  /** query → facts CT answers for activity (`--max 1`) queries. */
  readonly facts = new Map<string, Fact[]>();
  /** facts CT answers for user-turn (`--max 2`) queries. */
  live: Fact[] = [];

  constructor(extra: Partial<PluginDeps> = {}, wrap?: (fn: SpawnFn) => SpawnFn) {
    this.ct.poolFor = (query, max) => (max === 1 ? this.facts.get(query) ?? [] : this.live);
    const spawnFn = wrap ? wrap(this.ct.spawnFn) : this.ct.spawnFn;
    this.api = boot(this.ct, { spawnFn, ...extra });
  }

  async prompt(runId: string, opts: { sessionKey?: string; messages?: unknown[]; trigger?: string; text?: string; late?: boolean } = {}) {
    const ctx = {
      sessionKey: opts.sessionKey ?? MAIN, sessionId: 'sid', runId, agentId: 'main', trigger: opts.trigger ?? 'user',
      hookInvocation: { assertActive: () => { if (opts.late) throw new Error('no longer active'); } },
    };
    const text = opts.text ?? `question ${runId}`;
    return (await this.api.hook('before_prompt_build')(
      { prompt: text, currentUserMessage: text, currentUserMessageId: `m-${runId}`, messages: opts.messages ?? [] },
      ctx,
    )) as { prependContext?: string; prependSystemContext?: string } | undefined;
  }

  step(runId: string, n: number, sessionKey = MAIN): void {
    this.api.hook('model_call_started')({ runId, callId: `${runId}:model:${n}`, provider: 'p', model: 'm' }, { runId, sessionKey });
  }

  async tool(runId: string, toolName: string, args: Record<string, unknown>, opts: {
    sessionKey?: string; result?: ToolResult; isError?: boolean; cwd?: unknown; id?: string;
  } = {}): Promise<{ out: ToolResult; changed: boolean }> {
    const result = opts.result ?? { content: [{ type: 'text', text: `output of ${toolName}` }], details: { status: 'completed' } };
    const ret = (await this.api.middleware[0].handler(
      { toolCallId: opts.id ?? `tc-${Math.random()}`, toolName, args, cwd: 'cwd' in opts ? opts.cwd : PROJECT, isError: opts.isError ?? false, result },
      { runtime: 'openclaw', sessionKey: opts.sessionKey ?? MAIN, sessionId: 'sid', runId, agentId: 'main' },
    )) as { result: ToolResult } | undefined;
    return { out: ret?.result ?? result, changed: ret !== undefined };
  }
}

const blocks = (r: ToolResult) => r.content.map((b) => b.text ?? '');
const activityBlock = (r: ToolResult) => blocks(r).find((t) => t.startsWith(ACTIVITY_HEADING)) ?? null;

describe('activity delivery: channel and block', () => {
  it('appends ONE marker-first block as its own text block; the original blocks and details are untouched', async () => {
    const h = new Harness();
    h.facts.set('src/billing/invoice.ts', [FACT('w-inv', 'Invoices are immutable after issue.')]);
    await h.prompt('r1');
    h.step('r1', 1);
    const original: ToolResult = { content: [{ type: 'text', text: 'file body' }], details: { kind: 'text', path: 'x' } };
    const { out, changed } = await h.tool('r1', 'read', { path: 'src/billing/invoice.ts' }, { result: original });
    expect(changed).toBe(true);
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: 'text', text: 'file body' });
    expect(out.details).toEqual({ kind: 'text', path: 'x' });
    expect(out.content[1]).toEqual({
      type: 'text',
      text: `${ACTIVITY_HEADING}\n_for: read src/billing/invoice.ts_\n\n<!-- ct-fact:w-inv --> **Title w-inv** (provenance: unlabeled)\nInvoices are immutable after issue.`,
    });
    expect(h.ct.activityQueries()).toEqual(['src/billing/invoice.ts']);
    // the original object is never mutated
    expect(original.content).toHaveLength(1);
  });

  it('the query is the bare target; absolute paths inside the project are sent relative', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.step('r1', 1);
    await h.tool('r1', 'write', { path: join(PROJECT, 'src', 'x.ts'), content: 'SECRET-CONTENT' });
    h.step('r1', 2);
    await h.tool('r1', 'exec', { command: 'pnpm test --silent', workdir: '/somewhere', env: { TOKEN: 'sk-abcdef' } });
    h.step('r1', 3);
    await h.tool('r1', 'grep', { pattern: 'invoice total', path: 'src', glob: '*.ts' });
    expect(h.ct.activityQueries()).toEqual(['src/x.ts', 'pnpm test', 'invoice total']);
    const argv = JSON.stringify(h.ct.matchCalls().map((c) => c.args));
    expect(argv).not.toContain('SECRET-CONTENT');
    expect(argv).not.toContain('sk-abcdef');
    expect(argv).not.toContain('/somewhere');
    expect(argv).not.toContain(PROJECT);
  });

  it('without a cwd from the host no path is sent', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'src/a.ts' }, { cwd: undefined });
    h.step('r1', 2);
    await h.tool('r1', 'read', { path: join(PROJECT, 'src/a.ts') }, { cwd: '' });
    expect(h.ct.activityQueries()).toEqual([]);
  });
});

describe('rate rule: one CT call per model step, on a key change', () => {
  it('parallel results of one step make one call; the first to arrive carries the delivery', async () => {
    const h = new Harness();
    h.facts.set('a.ts', [FACT('fa')]);
    h.facts.set('b.ts', [FACT('fb')]);
    await h.prompt('r1');
    h.step('r1', 1);
    const [a, b] = await Promise.all([h.tool('r1', 'read', { path: 'a.ts' }), h.tool('r1', 'read', { path: 'b.ts' })]);
    expect(h.ct.activityQueries()).toEqual(['a.ts']);
    expect(activityBlock(a.out)).toContain('ct-fact:fa');
    expect(b.changed).toBe(false);
    // b's key was never admitted: the next step may query it
    h.step('r1', 2);
    const b2 = await h.tool('r1', 'read', { path: 'b.ts' });
    expect(h.ct.activityQueries()).toEqual(['a.ts', 'b.ts']);
    expect(activityBlock(b2.out)).toContain('ct-fact:fb');
  });

  it('the same key in a later step makes no call; read and edit of one file are one key', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'a.ts' });
    h.step('r1', 2);
    await h.tool('r1', 'edit', { path: 'a.ts', edits: [] });
    h.step('r1', 3);
    await h.tool('r1', 'exec', { command: 'pnpm test' });
    h.step('r1', 4);
    await h.tool('r1', 'exec', { command: 'pnpm test --silent' });
    expect(h.ct.activityQueries()).toEqual(['a.ts', 'pnpm test']);
  });

  it('without a model_call_started for the run, the whole run shares one step slot (fewer calls, never more)', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.step('r0', 1); // a step id of ANOTHER run is never used
    await h.tool('r1', 'read', { path: 'a.ts' });
    await h.tool('r1', 'read', { path: 'b.ts' });
    expect(h.ct.activityQueries()).toEqual(['a.ts']);
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'b.ts' });
    expect(h.ct.activityQueries()).toEqual(['a.ts', 'b.ts']);
  });

  it('subagent sessions have their own tracker and step ids', async () => {
    const h = new Harness();
    const child = 'agent:main:subagent:c1';
    await h.prompt('r1');
    await h.prompt('c1', { sessionKey: child });
    h.step('r1', 1);
    h.step('c1', 1, child);
    await h.tool('r1', 'read', { path: 'a.ts' });
    await h.tool('c1', 'read', { path: 'a.ts' }, { sessionKey: child });
    expect(h.ct.activityQueries()).toEqual(['a.ts', 'a.ts']);
  });
});

describe('release on post-start failures, keep on CT answers (decision 10)', () => {
  it('a CT timeout releases the key: a later step retries it', async () => {
    const g = new Harness();
    g.facts.set('a.ts', [FACT('fa')]);
    await g.prompt('r1');
    g.ct.matchOutcome = () => TIMEOUT;
    g.step('r1', 1);
    const first = await g.tool('r1', 'read', { path: 'a.ts' });
    expect(first.changed).toBe(false);
    g.ct.matchOutcome = null;
    g.step('r1', 2);
    const second = await g.tool('r1', 'read', { path: 'a.ts' });
    expect(activityBlock(second.out)).toContain('ct-fact:fa');
    expect(g.ct.activityQueries()).toEqual(['a.ts', 'a.ts']);
  });

  it('unparseable output releases; CT answering nothing (no_match) or only known facts (deduped) keeps the key', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.ct.matchOutcome = () => ok('not json');
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'p.ts' });
    h.ct.matchOutcome = null;
    h.step('r1', 2);
    await h.tool('r1', 'read', { path: 'p.ts' }); // retried after parse_error
    h.step('r1', 3);
    await h.tool('r1', 'read', { path: 'p.ts' }); // no_match: kept
    expect(h.ct.activityQueries()).toEqual(['p.ts', 'p.ts']);
  });

  it('running past the budget releases the key', async () => {
    let release: (() => void) | null = null;
    const h = new Harness({ activityBudgetMs: 0 }, (fn) => async (spec) => {
      if (spec.args[0] === 'wisdom' && spec.args[1] === 'match' && !spec.args.includes('--help') && spec.args.includes('a.ts') && release === null) {
        await new Promise<void>((r) => { release = r; });
      }
      return fn(spec);
    });
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.step('r1', 1);
    const first = await h.tool('r1', 'read', { path: 'a.ts' });
    expect(first.changed).toBe(false);
    (release as unknown as () => void)();
    h.step('r1', 2);
    const second = await h.tool('r1', 'read', { path: 'a.ts' });
    expect(activityBlock(second.out)).toContain('ct-fact:fa');
  });
});

describe('a ct that hangs past the budget (never settles, ignores the kill)', () => {
  it('each budget miss counts once, so three open the breaker; a fourth step makes no query', async () => {
    let started = 0;
    const h = new Harness({ activityBudgetMs: 40 }, (fn) => (spec) => {
      const isActivity = spec.args[0] === 'wisdom' && spec.args[1] === 'match' && !spec.args.includes('--help') && spec.args.includes('--max') && spec.args[spec.args.indexOf('--max') + 1] === '1';
      if (!isActivity) return fn(spec);
      started++;
      return new Promise(() => {}); // a child that never closes, even when killed
    });
    await h.prompt('r1');
    for (let n = 1; n <= BREAKER_FAILS; n++) {
      h.step('r1', n);
      await h.tool('r1', 'read', { path: `hang${n}.ts` });
    }
    expect(started).toBe(BREAKER_FAILS);
    h.step('r1', BREAKER_FAILS + 1);
    await h.tool('r1', 'read', { path: 'after.ts' });
    expect(started).toBe(BREAKER_FAILS); // breaker open: no fourth query
  });
});

describe('fail closed', () => {
  it('no snapshot for this run (no before_prompt_build in this process) → no CT call', async () => {
    const h = new Harness();
    h.step('r1', 1);
    const r = await h.tool('r1', 'read', { path: 'a.ts' });
    expect(r.changed).toBe(false);
    await h.prompt('r1');
    h.step('r2', 1);
    expect((await h.tool('r2', 'read', { path: 'a.ts' })).changed).toBe(false); // snapshot is for r1, not r2
    expect(h.ct.activityQueries()).toEqual([]);
    expect(h.api.debugs.some((d) => d.includes('class=no_ledger'))).toBe(true);
  });

  it('empty session key or run id → nothing', async () => {
    const h = new Harness();
    await h.prompt('r1');
    expect((await h.tool('', 'read', { path: 'a.ts' })).changed).toBe(false);
    expect((await h.tool('r1', 'read', { path: 'a.ts' }, { sessionKey: '' })).changed).toBe(false);
    expect(h.ct.activityQueries()).toEqual([]);
  });

  it('a restored session without a settled bootstrap gets no activity delivery', async () => {
    const h = new Harness({}, (fn) => async (spec) => (spec.args[0] === 'recall' ? TIMEOUT : fn(spec)));
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1', { messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }] });
    h.step('r1', 1);
    expect((await h.tool('r1', 'read', { path: 'a.ts' })).changed).toBe(false);
    expect(h.ct.activityQueries()).toEqual([]);
  });

  it('CT without `wisdom match` (older CT): probed once, latched, never queried again', async () => {
    const h = new Harness();
    h.ct.capable = false;
    await h.prompt('r1');
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'a.ts' });
    h.step('r1', 2);
    await h.tool('r1', 'read', { path: 'b.ts' });
    expect(h.ct.matchCalls()).toEqual([]);
  });

  it('the breaker is shared with the user-turn path', async () => {
    const h = new Harness();
    h.live = [FACT('live')];
    await h.prompt('r1', { trigger: 'cron' }); // no live call on a cron run
    h.ct.matchOutcome = () => TIMEOUT;
    for (let n = 1; n <= BREAKER_FAILS; n++) {
      h.step('r1', n);
      await h.tool('r1', 'read', { path: `f${n}.ts` });
    }
    h.ct.matchOutcome = null;
    const before = h.ct.matchCalls().length;
    const next = await h.prompt('r2');
    expect(next?.prependContext).toBeUndefined();
    h.step('r2', 1);
    await h.tool('r2', 'read', { path: 'z.ts' });
    expect(h.ct.matchCalls().length).toBe(before);
  });

  it('a result with 200 blocks already gets nothing and costs no CT call', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.step('r1', 1);
    const full: ToolResult = { content: Array.from({ length: 200 }, (_, i) => ({ type: 'text', text: `b${i}` })) };
    expect((await h.tool('r1', 'read', { path: 'a.ts' }, { result: full })).changed).toBe(false);
    expect(h.ct.activityQueries()).toEqual([]);
  });

  it('CT tools and calls the host did not run never query', async () => {
    const h = new Harness();
    await h.prompt('r1');
    h.step('r1', 1);
    await h.tool('r1', 'curated-thoughts__curated_search', { query: 'a.ts', path: 'a.ts' });
    await h.tool('r1', 'ct__curated_get_wiki_entry', { id: 'x' });
    await h.tool('r1', 'exec', { command: 'pnpm test' }, { result: { content: [{ type: 'text', text: 'approval needed' }], details: { status: 'approval-pending' } } });
    await h.tool('r1', 'exec', { command: 'pnpm test' }, { isError: true, result: { content: [{ type: 'text', text: 'Exec denied (user-denied): pnpm test' }], details: { status: 'failed', exitCode: null } } });
    await h.tool('r1', 'read', { path: 'missing.ts' }, { isError: true, result: { content: [{ type: 'text', text: 'ENOENT' }], details: { status: 'error' } } });
    expect(h.ct.activityQueries()).toEqual([]);
    // a command that ran and failed does count
    await h.tool('r1', 'exec', { command: 'pnpm test' }, { isError: true, result: { content: [{ type: 'text', text: '1 failed' }], details: { status: 'completed', exitCode: 1 } } });
    expect(h.ct.activityQueries()).toEqual(['pnpm test']);
  });

  it('a throwing spawn, logger or junk input never escapes the middleware and leaves the result untouched', async () => {
    const h = new Harness({}, (fn) => async (spec) => {
      if (spec.args[0] === 'wisdom' && spec.args[1] === 'match' && !spec.args.includes('--help')) throw new Error('boom');
      return fn(spec);
    });
    h.api.logger.debug = () => { throw new Error('logger down'); };
    await h.prompt('r1');
    h.step('r1', 1);
    expect((await h.tool('r1', 'read', { path: 'a.ts' })).changed).toBe(false);
    const mw = h.api.middleware[0].handler;
    for (const junk of [null, undefined, 3, { toolName: 'read' }, { toolName: 'read', args: 'x', result: 'y' }]) {
      await expect(Promise.resolve(mw(junk, { sessionKey: MAIN, runId: 'r1' }))).resolves.toBeUndefined();
      await expect(Promise.resolve(mw(junk, null))).resolves.toBeUndefined();
    }
    expect(() => h.api.hook('model_call_started')(null, null)).not.toThrow();
  });
});

describe('exactly-once across channels within a run and across runs', () => {
  it('a fact delivered by activity is stubbed by a later CT recall in the same run', async () => {
    const h = new Harness();
    h.facts.set('a.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.step('r1', 1);
    await h.tool('r1', 'read', { path: 'a.ts' });
    h.step('r1', 2);
    const recall: ToolResult = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'fa', text: 'again' }, { id: 'fz', text: 'new' }] }) }] };
    const { out } = await h.tool('r1', 'curated-thoughts__curated_recall_context', { query: 'x' }, { result: recall });
    const inner = JSON.parse(blocks(out)[0].split('\n')[0]) as { wiki_entries: Array<Record<string, unknown>> };
    expect(inner.wiki_entries[0]).toMatchObject({ id: 'fa', in_context: true });
    expect(inner.wiki_entries[1]).toMatchObject({ id: 'fz', text: 'new' });
    // ... and a recalled fact is never delivered again by activity
    h.facts.set('b.ts', [FACT('fz')]);
    h.step('r1', 3);
    expect((await h.tool('r1', 'read', { path: 'b.ts' })).changed).toBe(false);
  });

  it('the live block of the run and a salvaged block are never repeated by activity', async () => {
    const h = new Harness();
    h.live = [FACT('fl')];
    h.facts.set('a.ts', [FACT('fl')]);
    const r1 = await h.prompt('r1');
    expect(r1?.prependContext).toContain('ct-fact:fl');
    h.step('r1', 1);
    expect((await h.tool('r1', 'read', { path: 'a.ts' })).changed).toBe(false);

    const g = new Harness();
    g.live = [FACT('fs')];
    g.facts.set('a.ts', [FACT('fs')]);
    const late = await g.prompt('r1', { late: true });
    expect(late?.prependContext).toBeUndefined();
    expect(g.api.enqueued).toHaveLength(1);
    g.step('r1', 1);
    expect((await g.tool('r1', 'read', { path: 'a.ts' })).changed).toBe(false);
  });

  it('markers already in a tool result (forged or not) only suppress', async () => {
    const h = new Harness();
    h.facts.set('a.ts', [FACT('ff')]);
    h.facts.set('b.ts', [FACT('ff')]);
    await h.prompt('r1');
    h.step('r1', 1);
    // this result already shows ff's marker: the fact counts as in context
    const shown = await h.tool('r1', 'read', { path: 'a.ts' }, { result: { content: [{ type: 'text', text: 'x <!-- ct-fact:ff --> y' }] } });
    expect(shown.changed).toBe(false);
    h.step('r1', 2);
    expect((await h.tool('r1', 'read', { path: 'b.ts' })).changed).toBe(false);
    // a path holding our own marker text is never a query
    h.step('r1', 3);
    await h.tool('r1', 'read', { path: 'ct-fact:zz.md' });
    expect(h.ct.activityQueries().every((q) => !q.includes('ct-fact:') && !q.includes('Curated Thoughts'))).toBe(true);
  });

  it('the next run sees the delivered block in its snapshot; the run ledger resets', async () => {
    const h = new Harness();
    h.facts.set('a.ts', [FACT('fa')]);
    h.facts.set('b.ts', [FACT('fa')]);
    h.facts.set('c.ts', [FACT('fa')]);
    await h.prompt('r1');
    h.step('r1', 1);
    const { out } = await h.tool('r1', 'read', { path: 'a.ts' });
    const persisted = [{ role: 'user', content: 'q' }, { role: 'assistant', content: [] }, { role: 'toolResult', content: out.content }];
    await h.prompt('r2', { messages: persisted });
    h.step('r2', 1);
    expect((await h.tool('r2', 'read', { path: 'b.ts' })).changed).toBe(false);
    // compaction removed the block before r3: the fact may arrive again
    await h.prompt('r3', { messages: [{ role: 'user', content: 'q' }] });
    h.step('r3', 1);
    // (b.ts was answered `deduped` in r2, so its key is kept: a new key asks again)
    expect(activityBlock((await h.tool('r3', 'read', { path: 'c.ts' })).out)).toContain('ct-fact:fa');
  });

  it('corrections ride only when they supersede an id in context', async () => {
    const h = new Harness();
    h.ct.corrections = [{ id: 'c-new', supersedes: ['old'], title: 'Newer rule', text: 'Use B.' }];
    h.facts.set('a.ts', []);
    await h.prompt('r1');
    h.step('r1', 1);
    expect((await h.tool('r1', 'read', { path: 'a.ts' })).changed).toBe(false); // `old` not in context
    // a cron run: no user-turn query, which would deliver the correction first
    await h.prompt('r2', { trigger: 'cron', messages: [{ role: 'toolResult', content: [{ type: 'text', text: '<!-- ct-fact:old -->' }] }] });
    h.step('r2', 1);
    const block = activityBlock((await h.tool('r2', 'read', { path: 'b.ts' })).out);
    expect(block).toContain('<!-- ct-fact:c-new --> **Newer rule**');
    expect(block).toContain('supersedes ct-fact:old');
  });
});

describe('subagents, cron and heartbeat runs are included (decision 4); the user-turn gate is unchanged', () => {
  for (const [label, sessionKey, trigger] of [
    ['subagent', 'agent:main:subagent:abc', 'user'],
    ['cron', 'agent:main:cron:job', 'cron'],
    ['heartbeat', MAIN, 'heartbeat'],
  ] as const) {
    it(`${label}: activity delivered, no live block`, async () => {
      const h = new Harness();
      h.live = [FACT('fl')];
      h.facts.set('a.ts', [FACT('fa')]);
      const r = await h.prompt('r1', { sessionKey, trigger });
      expect(r?.prependContext).toBeUndefined();
      h.step('r1', 1, sessionKey);
      expect(activityBlock((await h.tool('r1', 'read', { path: 'a.ts' }, { sessionKey })).out)).toContain('ct-fact:fa');
      expect(h.ct.matchCalls().filter((c) => c.args.includes('2'))).toEqual([]);
    });
  }
});

describe('one state per process across module instances (live: the host loads the module 3 times)', () => {
  it('prompt hooks served by one instance and the middleware by another share the ledger', async () => {
    const ct = new FakeCt();
    ct.poolFor = (q, max) => (max === 1 && q === 'a.ts' ? [FACT('fa')] : max === 2 ? [FACT('fl')] : []);
    const holder = {};
    const deps = { spawnFn: ct.spawnFn, env: {}, candidates: () => ['/fake/ct'], usable: () => true };
    const hooksApi = new FakeApi();
    const middlewareApi = new FakeApi();
    createPlugin(deps, holder).register(hooksApi as never);
    createPlugin(deps, holder).register(middlewareApi as never);
    const ctx = { sessionKey: MAIN, sessionId: 's', runId: 'r1', trigger: 'user', hookInvocation: { assertActive() {} } };
    const r = (await hooksApi.hook('before_prompt_build')({ prompt: 'q', currentUserMessage: 'q', currentUserMessageId: 'm', messages: [] }, ctx)) as { prependContext?: string };
    expect(r.prependContext).toContain('ct-fact:fl');
    hooksApi.hook('model_call_started')({ runId: 'r1', callId: 'r1:model:1' }, { runId: 'r1', sessionKey: MAIN });
    const mw = middlewareApi.middleware[0].handler;
    const tctx = { runtime: 'openclaw', sessionKey: MAIN, runId: 'r1' };
    const act = (await mw({ toolName: 'read', args: { path: 'a.ts' }, cwd: PROJECT, isError: false, result: { content: [{ type: 'text', text: 'x' }] } }, tctx)) as { result: ToolResult };
    expect(activityBlock(act.result)).toContain('ct-fact:fa');
    // N3 in the middleware instance sees the live block the hook instance delivered
    const recall = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'fl', text: 'again' }] }) }] };
    const out = (await mw({ toolName: 'curated-thoughts__curated_recall_context', args: {}, isError: false, result: recall }, tctx)) as { result: ToolResult };
    expect(blocks(out.result)[0]).toContain('"in_context":true');
  });

  it('the default export keeps its state on a process-wide holder', () => {
    expect(processStateHolder()).toBe(processStateHolder());
  });
});

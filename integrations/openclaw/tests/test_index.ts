import { describe, it, expect } from 'vitest';
import plugin, { createPlugin } from '../src/index.js';
import { FakeApi, FakeCt, TIMEOUT, boot, userCtx } from './fake_host.js';

const FACTS = [
  { id: 'w1', title: 'Release flow', text: 'Tag after merge.' },
  { id: 'w2', title: 'Lockfiles', text: 'Use pnpm 9.15.9.' },
  { id: 'w3', title: 'Third', text: 'Third fact.' },
];

type Result = { prependContext?: string; prependSystemContext?: string } | undefined;

async function build(api: ReturnType<typeof boot>, event: Record<string, unknown>, ctx: Record<string, unknown>): Promise<Result> {
  return (await api.hook('before_prompt_build')(event, ctx)) as Result;
}

describe('plugin entry shape', () => {
  it('default-exports a definePluginEntry-shaped object', () => {
    expect(plugin.id).toBe('curated-thoughts');
    expect(typeof plugin.register).toBe('function');
    expect(plugin.configSchema).toBeTypeOf('object');
  });

  it('registers agent_turn_prepare, before_prompt_build (20 s budget) and openclaw-runtime middleware', () => {
    const api = boot(new FakeCt());
    expect(api.hooks.map((h) => h.name)).toEqual(['agent_turn_prepare', 'before_prompt_build']);
    expect(api.hooks[1].opts).toEqual({ timeoutMs: 20000 });
    expect(api.middleware).toHaveLength(1);
    expect(api.middleware[0].opts).toEqual({ runtimes: ['openclaw'] });
  });

  it('survives a host without the middleware or workflow APIs (salvage degrades to a no-op)', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = new FakeApi();
    (api as { registerAgentToolResultMiddleware?: unknown }).registerAgentToolResultMiddleware = undefined;
    (api as { session?: unknown }).session = undefined;
    createPlugin({ spawnFn: ct.spawnFn, env: {}, candidates: () => ['/fake/ct'], usable: () => true }).register(api as never);
    expect(api.hooks.map((h) => h.name)).toEqual(['agent_turn_prepare', 'before_prompt_build']);
    const ctx = userCtx({ hookInvocation: { assertActive: () => { throw new Error('inactive'); } } });
    const r = await build(api as never, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm', messages: [] }, ctx);
    expect(r).toBeUndefined();
    expect(api.warnings).toEqual([]);
  });
});

describe('N1 + N2 live delivery', () => {
  it('delivers the matched facts as prependContext on a user turn, with markers', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const r = await build(api, { prompt: 'p', currentUserMessage: 'how do releases work', currentUserMessageId: 'm1', messages: [] }, userCtx());
    expect(r?.prependContext).toContain('<!-- ct-fact:w1 -->');
    expect(r?.prependContext).toContain('<!-- ct-fact:w2 -->');
    expect(r?.prependContext).not.toContain('w3');
    expect(ct.matchCalls()[0].args.at(-1)).toBe('how do releases work');
  });

  it('excludes what the snapshot already carries (persisted projection) and post-filters', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const messages = [{ role: 'user', content: 'q1', __openclaw: { modelPromptProjection: { version: 1, text: '**R** <!-- ct-fact:w1 -->\n\nq1' } } }];
    const r = await build(api, { prompt: 'p', currentUserMessage: 'again', currentUserMessageId: 'm2', messages }, userCtx({ runId: 'r2' }));
    expect(ct.matchCalls()[0].args).toContain('--exclude=w1');
    expect(r?.prependContext).not.toContain('ct-fact:w1');
    expect(r?.prependContext).toContain('ct-fact:w2');
  });

  for (const [label, ctx] of [
    ['heartbeat trigger', userCtx({ trigger: 'heartbeat' })],
    ['cron trigger', userCtx({ trigger: 'cron' })],
    ['inter-session provenance', userCtx({ inputProvenance: { kind: 'inter_session' } })],
    ['subagent provenance', userCtx({ inputProvenance: { kind: 'external_user', sourceRole: 'subagent' } })],
    ['subagent session key', userCtx({ sessionKey: 'agent:main:subagent:abc' })],
  ] as const) {
    it(`never delivers live on a ${label}`, async () => {
      const ct = new FakeCt();
      ct.pool = () => FACTS;
      const api = boot(ct);
      const r = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm', messages: [] }, ctx);
      expect(r?.prependContext).toBeUndefined();
      expect(ct.matchCalls()).toHaveLength(0);
    });
  }

  it('fails closed when messages is not an array (no ledger source)', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const r = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm' }, userCtx());
    expect(r?.prependContext).toBeUndefined();
    expect(ct.matchCalls()).toHaveLength(0);
  });

  it('fails closed without an admission identity (no currentUserMessageId, no runId)', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const r = await build(api, { prompt: 'p', currentUserMessage: 'x', messages: [] }, userCtx({ runId: undefined }));
    expect(r?.prependContext).toBeUndefined();
  });

  it('is a silent no-op when the capability probe says wisdom match is absent', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    ct.capable = false;
    const api = boot(ct);
    const r = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm', messages: [] }, userCtx());
    expect(r?.prependContext).toBeUndefined();
    expect(api.warnings).toEqual([]);
  });

  it('opens the breaker after three failed matches and stops spawning', async () => {
    const ct = new FakeCt();
    ct.matchOutcome = () => TIMEOUT;
    const api = boot(ct);
    for (let i = 0; i < 5; i++) {
      await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: `m${i}`, messages: [] }, userCtx({ runId: `r${i}` }));
    }
    expect(ct.matchCalls()).toHaveLength(3);
  });
});

describe('AC 11 self-trigger / retry guard', () => {
  it('a rebuild of the same admission returns the identical result without a second CT call', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const ev = { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'adm-1', messages: [] };
    const a = await build(api, ev, userCtx());
    const b = await build(api, ev, userCtx({ runId: 'retry-run' }));
    expect(ct.matchCalls()).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it('our own delivered block never becomes the next query', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const r1 = await build(api, { prompt: 'p', currentUserMessage: 'first', currentUserMessageId: 'a1', messages: [] }, userCtx());
    const projected = `${r1!.prependContext}\n\nfirst`;
    await build(api, {
      prompt: `${projected}\n\nsecond`,
      currentUserMessage: 'second',
      currentUserMessageId: 'a2',
      messages: [{ role: 'user', content: 'first', __openclaw: { modelPromptProjection: { version: 1, text: projected } } }],
    }, userCtx({ runId: 'r2' }));
    expect(ct.matchCalls()[1].args.at(-1)).toBe('second');
  });
});

describe('durable salvage channel (enqueueNextTurnInjection) + three-channel dedupe', () => {
  it('a handler whose result is no longer accepted enqueues the block instead', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const ctx = userCtx({ hookInvocation: { assertActive: () => { throw new Error('prompt hook invocation is no longer active'); } } });
    const r = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm', messages: [] }, ctx);
    expect(r?.prependContext).toBeUndefined();
    expect(api.enqueued).toHaveLength(1);
    const inj = api.enqueued[0];
    expect(inj.sessionKey).toBe('agent:main:main');
    expect(inj.placement).toBe('prepend_context');
    expect(String(inj.idempotencyKey)).toMatch(/^ct-wisdom:/);
    expect((inj.metadata as { ctFactIds: string[] }).ctFactIds).toEqual(['w1', 'w2']);
    expect(String(inj.text)).toContain('ct-fact:w1');
  });

  it('a rejected salvage is not memoized: a retry of the same admission tries again', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    let fail = true;
    const enqueue = api.session.workflow.enqueueNextTurnInjection;
    api.session.workflow.enqueueNextTurnInjection = async (inj) => {
      if (fail) throw new Error('store unavailable');
      return enqueue(inj);
    };
    const ctx = userCtx({ hookInvocation: { assertActive: () => { throw new Error('inactive'); } } });
    const ev = { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm', messages: [] };
    expect(await build(api, ev, ctx)).toBeUndefined();
    expect(api.warnings).toHaveLength(1);
    fail = false;
    await build(api, ev, ctx);
    expect(api.enqueued).toHaveLength(1);
  });

  it('ids drained into this turn (agent_turn_prepare, own plugin only) are excluded from the live match', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    const ctx = userCtx({ runId: 'r9' });
    await api.hook('agent_turn_prepare')({
      prompt: 'p',
      messages: [],
      queuedInjections: [
        { id: 'i1', pluginId: 'curated-thoughts', text: '**R** <!-- ct-fact:w1 -->', metadata: { ctFactIds: ['w1'] }, createdAt: 1, placement: 'prepend_context' },
        { id: 'i2', pluginId: 'someone-else', text: '<!-- ct-fact:w2 -->', createdAt: 1, placement: 'prepend_context' },
      ],
    }, ctx);
    const r = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm9', messages: [] }, ctx);
    expect(ct.matchCalls()[0].args).toContain('--exclude=w1');
    expect(ct.matchCalls()[0].args).not.toContain('--exclude=w2');
    expect(r?.prependContext).not.toContain('ct-fact:w1');
  });

  it('the middleware stubs a recall repeat of an id delivered earlier in the same turn', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    const api = boot(ct);
    await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm', messages: [] }, userCtx());
    const result = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'w1', text: 'dup' }, { id: 'w3', text: 'new' }] }) }], details: {} };
    const out = (await api.middleware[0].handler(
      { toolCallId: 't', toolName: 'curated-thoughts__curated_recall_context', args: {}, result },
      { runtime: 'openclaw', sessionKey: 'agent:main:main', runId: 'run-1' },
    )) as { result: typeof result };
    const [json, trailer] = out.result.content[0].text.split('\n');
    expect(JSON.parse(json).wiki_entries[0].in_context).toBe(true);
    expect(trailer).toBe('<!-- ct-fact:w3 -->');
  });

  it('the middleware ignores other tools and errors', async () => {
    const api = boot(new FakeCt());
    const result = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [{ id: 'w1' }] }) }], details: {} };
    expect(await api.middleware[0].handler({ toolName: 'curated-thoughts__curated_get_wiki_entry', args: {}, result }, { sessionKey: 's' })).toBeUndefined();
    expect(await api.middleware[0].handler({ toolName: 'curated-thoughts__curated_recall_context', isError: true, args: {}, result }, { sessionKey: 's' })).toBeUndefined();
  });
});

describe('N5 bootstrap block', () => {
  it('rides prependSystemContext with byte-stable memoized bytes, and its ids join the ledger', async () => {
    const ct = new FakeCt();
    ct.bootstrap = [{ id: 'b1', title: 'Boot', text: 'Bootstrap fact.' }];
    ct.pool = () => [{ id: 'b1', title: 'Boot', text: 'x' }, ...FACTS];
    const api = boot(ct);
    const r1 = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm1', messages: [] }, userCtx());
    const r2 = await build(api, { prompt: 'p', currentUserMessage: 'y', currentUserMessageId: 'm2', messages: [] }, userCtx({ runId: 'r2' }));
    expect(r1?.prependSystemContext).toContain('<!-- ct-fact:b1 -->');
    expect(r2?.prependSystemContext).toBe(r1?.prependSystemContext);
    expect(ct.calls.filter((c) => c.args[0] === 'recall')).toHaveLength(1);
    expect(ct.matchCalls()[0].args).toContain('--exclude=b1');
    expect(r1?.prependContext).not.toContain('ct-fact:b1');
  });

  it('renders the bootstrap on non-user turns too (it is not live delivery)', async () => {
    const ct = new FakeCt();
    ct.bootstrap = [{ id: 'b1', title: 'Boot', text: 'Bootstrap fact.' }];
    const api = boot(ct);
    const r = await build(api, { prompt: 'p', messages: [] }, userCtx({ trigger: 'heartbeat' }));
    expect(r?.prependSystemContext).toContain('ct-fact:b1');
  });

  it('restored session (prior assistant turns, first sighting) with an unsettled bootstrap: no live delivery, bootstrap intact later', async () => {
    const ct = new FakeCt();
    ct.pool = () => FACTS;
    let fail = true;
    const base = ct.spawnFn;
    ct.spawnFn = async (spec) => (spec.args[0] === 'recall' && fail ? TIMEOUT : base(spec));
    ct.bootstrap = [{ id: 'b1', title: 'Boot', text: 'B' }];
    const api = boot(ct);
    const history = [{ role: 'user', content: 'old' }, { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }];
    const r1 = await build(api, { prompt: 'p', currentUserMessage: 'x', currentUserMessageId: 'm1', messages: history }, userCtx());
    expect(r1?.prependContext).toBeUndefined();
    expect(ct.matchCalls()).toHaveLength(0);
    fail = false;
    const r2 = await build(api, { prompt: 'p', currentUserMessage: 'y', currentUserMessageId: 'm2', messages: history }, userCtx({ runId: 'r2' }));
    expect(r2?.prependSystemContext).toContain('ct-fact:b1');
    expect(r2?.prependContext).toContain('ct-fact:w1');
  });
});

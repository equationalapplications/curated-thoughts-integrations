import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config, inject } from '../src/index.js';

// test_index stays UNIT-scoped: the real wisdom module's spawns/governor
// belong to test_wisdom.ts — mock it entirely (Step 6.1). The real
// WisdomMemo/scanIds/keyOf are imported by apply() for the live hooks
// (0.4.0); pass the pure implementations through.
vi.mock('../src/wisdom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wisdom.js')>();
  return {
    ...actual,
    renderWisdom: vi.fn(() => ''),
  };
});
import { renderWisdom } from '../src/wisdom.js';
// The live engine is unit-tested elsewhere (test_wisdom_live_*); here only the
// message the pre-step listener appends is under test, so the engine call is
// stubbed to a fixed block (null = no delivery when a test does not set one).
vi.mock('../src/wisdom-live/adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wisdom-live/adapter.js')>();
  return { ...actual, runUserTurn: vi.fn(async () => null) };
});
import { runUserTurn } from '../src/wisdom-live/adapter.js';
import { DshActivity } from '../src/wisdom-live/activity.js';

// The ctx mock encodes the real DSH 0.2.0 runtime surface: there is NO
// `ctx.plugin(string, ...)` (cordis rejects a string plugin — the MCP client
// is mounted by the shipped bundle patch instead), and systemPrompt.context
// requires a named entry with a finite `order` (getContextOrder only knows
// the built-in sections).
function mockCtx() {
  const skillRegistrations: Array<{
    name: string;
    description: string;
    content: string;
    invocation: { modelInvocable: boolean; userInvocable: boolean };
  }> = [];
  const contextRegistrations: Array<{
    name?: string;
    order: unknown;
    text: () => string;
  }> = [];
  const sectionRegistrations: Array<{
    name?: string;
    order: unknown;
    interpolate?: unknown;
    text: (assembleCtx: unknown) => string;
  }> = [];
  const sessionStartListeners: Array<() => Promise<void>> = [];
  const createdListeners: Array<(payload: unknown) => Promise<void>> = [];
  const preStepListeners: Array<
    (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  > = [];
  const postExecuteListeners: Array<
    (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>
  > = [];
  const preExecuteListeners: Array<
    (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
  > = [];
  return {
    ctx: {
      skills: {
        register: vi.fn((s: unknown) => {
          skillRegistrations.push(s as (typeof skillRegistrations)[number]);
          return () => {};
        }),
      },
      systemPrompt: {
        context: vi.fn((c: unknown) => {
          contextRegistrations.push(c as (typeof contextRegistrations)[number]);
          return () => {};
        }),
        section: vi.fn((s: unknown) => {
          sectionRegistrations.push(s as (typeof sectionRegistrations)[number]);
          return () => {};
        }),
      },
      on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
        if (event === 'agent/session-start') {
          sessionStartListeners.push(listener as () => Promise<void>);
        } else if (event === 'agent/created') {
          createdListeners.push(listener as (payload: unknown) => Promise<void>);
        } else if (event === 'agent/pre-step') {
          preStepListeners.push(
            listener as (p: unknown, next: () => Promise<unknown>) => Promise<unknown>,
          );
        } else if (event === 'tools/post-execute') {
          postExecuteListeners.push(
            listener as (e: unknown, r: unknown, next: () => Promise<unknown>) => Promise<unknown>,
          );
        } else if (event === 'tools/pre-execute') {
          preExecuteListeners.push(
            listener as (e: unknown, next: () => Promise<unknown>) => Promise<unknown>,
          );
        }
        return () => {};
      }),
    },
    preExecuteListeners,
    skillRegistrations,
    contextRegistrations,
    sectionRegistrations,
    sessionStartListeners,
    createdListeners,
    preStepListeners,
    postExecuteListeners,
  };
}

describe('inject', () => {
  it('declares the DSH services apply() touches', () => {
    // Without this export the host never injects systemPrompt/skills and
    // apply() crashes with 'cannot get property "systemPrompt" without inject'.
    expect(inject).toEqual(['systemPrompt', 'skills']);
  });
});

describe('Config schema', () => {
  it('is defined and callable (schemastery Schema)', () => {
    expect(Config).toBeDefined();
    expect(typeof Config).toBe('function');
  });
});

describe('apply', () => {
  let m: ReturnType<typeof mockCtx>;
  beforeEach(() => {
    m = mockCtx();
  });

  it('registers a named dynamic prompt context with a finite order', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.contextRegistrations).toHaveLength(1);
    const ctx0 = m.contextRegistrations[0];
    // dsh requires { name, order, text } and validates that order is a
    // finite number; getContextOrder() only knows the built-in sections, so
    // the order must be our own constant, not a getContextOrder() lookup.
    expect(ctx0.name).toBe('curated-thoughts-health');
    expect(typeof ctx0.order).toBe('number');
    expect(Number.isFinite(ctx0.order)).toBe(true);
    // Empty first-call default — text is a function reference evaluated lazily.
    expect(typeof ctx0.text).toBe('function');
    expect(ctx0.text()).toBe('');
  });

  it('publishes the health block once the agent/created refresh has run', async () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    // MIGRATION (0.2.0-rc.2): the lifecycle event is agent/created — the old
    // agent/session-start name has NO dispatcher at this pin (dead listener).
    expect(m.createdListeners.length).toBe(1);
    expect(m.sessionStartListeners.length).toBe(0);
    // The listener refreshes the cache fail-open; the text() reference must
    // observe the refreshed value at the next prompt assembly.
    await m.createdListeners[0]({ agent: { id: 'a' }, source: 'startup' });
    for (const reg of m.contextRegistrations) {
      expect(typeof reg.text()).toBe('string');
    }
  });

  it('probes config.brainDir without writing it into process.env', async () => {
    const before = process.env.CURATED_BRAIN_DIR;
    delete process.env.CURATED_BRAIN_DIR;
    try {
      apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '/nonexistent/ct-brain' });
      expect(process.env.CURATED_BRAIN_DIR).toBeUndefined();
      await m.createdListeners[0]({ agent: { id: 'a' }, source: 'startup' });
      // The probe looked at the configured dir, so the degraded block names it.
      expect(m.contextRegistrations[0].text()).toContain('/nonexistent/ct-brain');
    } finally {
      if (before === undefined) delete process.env.CURATED_BRAIN_DIR;
      else process.env.CURATED_BRAIN_DIR = before;
    }
  });

  it('subscribes agent/created for async refresh (0.2.0-rc.2 lifecycle event)', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.createdListeners.length).toBe(1);
    expect(typeof m.createdListeners[0]).toBe('function');
  });

  it('registers the live-delivery listeners: one pre-step, one pre-execute, one post-execute', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.preStepListeners.length).toBe(1);
    expect(m.preExecuteListeners.length).toBe(1);
    expect(m.postExecuteListeners.length).toBe(1);
  });

  it('pre-execute prefetches and passes the tool decision through untouched (even if prefetch throws)', async () => {
    const prefetch = vi.spyOn(DshActivity.prototype, 'prefetch');
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const decision = { kind: 'allow' };
    const exec = { callId: 'c1', name: 'bash', arguments: { command: 'ls' }, agent: { id: 'a' } };
    expect(await m.preExecuteListeners[0](exec, async () => decision)).toBe(decision);
    expect(prefetch).toHaveBeenCalledWith(exec);
    prefetch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await m.preExecuteListeners[0](exec, async () => decision)).toBe(decision);
    prefetch.mockRestore();
  });

  it('pre-execute prefetches only AFTER the waterfall approved the call (deny/cancel/ask/throw send nothing)', async () => {
    const prefetch = vi.spyOn(DshActivity.prototype, 'prefetch');
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const exec = { callId: 'c1', name: 'bash', arguments: { command: 'ls' }, agent: { id: 'a' } };
    for (const decision of [{ kind: 'deny', reason: 'no' }, { kind: 'cancel' }, { kind: 'ask', reason: '?' }]) {
      expect(await m.preExecuteListeners[0](exec, async () => decision)).toBe(decision);
    }
    await expect(m.preExecuteListeners[0](exec, async () => {
      throw new Error('downstream');
    })).rejects.toThrow('downstream');
    expect(prefetch).not.toHaveBeenCalled();
    // order: next() resolves first, then the prefetch
    const order: string[] = [];
    prefetch.mockImplementation(() => {
      order.push('prefetch');
    });
    await m.preExecuteListeners[0](exec, async () => {
      order.push('next');
      return { kind: 'allow' };
    });
    expect(order).toEqual(['next', 'prefetch']);
    prefetch.mockRestore();
  });

  it('step >= 2: appends the activity block as an identified user message with its own source kind', async () => {
    const block = '## Curated Thoughts — relevant to this step\n_for: run pnpm test_\n\n<!-- ct-fact:f1 --> **T** (provenance: stated)\nbody';
    const deliver = vi.spyOn(DshActivity.prototype, 'deliver').mockResolvedValue(block);
    vi.mocked(runUserTurn).mockClear();
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const agent = { id: 'agent-1', session: { deriveMessages: () => [] } };
    // Step 1 of turn 1: the user-turn path only.
    await m.preStepListeners[0]({ agent, messages: [], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    expect(deliver).not.toHaveBeenCalled();
    expect(runUserTurn).toHaveBeenCalledTimes(1);
    // Step 2: the activity path only.
    const decision = (await m.preStepListeners[0](
      { agent, messages: [], turn: 1, step: 2 },
      async () => ({ kind: 'enter', messages: [] }),
    )) as { messages: Array<Record<string, unknown>> };
    expect(runUserTurn).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(decision.messages).toHaveLength(1);
    const msg = decision.messages[0];
    expect(msg.role).toBe('user');
    expect(typeof msg.id).toBe('string');
    expect(msg.id).not.toBe('');
    expect(msg.source).toEqual({ kind: 'curated-thoughts-wisdom-activity' });
    expect(msg.content).toEqual([{ type: 'text', text: block }]);
    // A rejected step is never touched.
    const rejected = await m.preStepListeners[0]({ agent, messages: [], turn: 1, step: 3 }, async () => ({ kind: 'reject' }));
    expect(rejected).toEqual({ kind: 'reject' });
    expect(deliver).toHaveBeenCalledTimes(1);
    deliver.mockRestore();
  });

  it('step >= 2 with no activity block leaves the decision as next() returned it', async () => {
    const deliver = vi.spyOn(DshActivity.prototype, 'deliver').mockResolvedValue(null);
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const agent = { id: 'agent-2', session: { deriveMessages: () => [] } };
    await m.preStepListeners[0]({ agent, messages: [], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    const inner = { kind: 'enter', messages: [{ id: 'ctx' }] };
    const out = await m.preStepListeners[0]({ agent, messages: [], turn: 1, step: 2 }, async () => inner);
    expect(out).toEqual({ kind: 'enter', messages: [{ id: 'ctx' }] });
    expect(deliver.mock.calls[0]![1]).toEqual([]);
    expect(deliver.mock.calls[0]![2]).toEqual([{ id: 'ctx' }]);
    deliver.mockRestore();
  });

  it('appends the wisdom block as an identified user-role message (DSH session replay contract)', async () => {
    // Live e2e 2026-10-16 (DSH 0.2.0-rc.2): a pre-step message without `id`
    // and `role` is persisted as-is, then the stored session fails replay
    // validation ("session event at seq N lacks an identified message") and
    // can never be continued. The replay check (dsh-session
    // assertMessageEventShape for user/message) requires: a non-empty string
    // id, role "user", a source with a non-empty kind, and array content.
    const block = '**T** <!-- ct-fact:fact_0123456789abcdef01234567 -->\nbody';
    vi.mocked(runUserTurn).mockResolvedValueOnce(block);
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const claimed = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }];
    const decision = (await m.preStepListeners[0](
      { agent: { id: 'agent-1', session: { deriveMessages: () => [] } }, messages: claimed, turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [...claimed] }),
    )) as { kind: string; messages: Array<Record<string, unknown>> };
    expect(decision.kind).toBe('enter');
    expect(decision.messages).toHaveLength(2);
    const msg = decision.messages[1];
    expect(typeof msg.id).toBe('string');
    expect(msg.id).not.toBe('');
    expect(msg.id).not.toBe('u1');
    expect(msg.role).toBe('user');
    expect(msg.source).toEqual({ kind: 'curated-thoughts-wisdom' });
    expect(msg.content).toEqual([{ type: 'text', text: block }]);
  });

  it('wires the verbose recorder only when CT_WISDOM_VERBOSE is on (and the message bytes are the same)', async () => {
    const block = '**T** <!-- ct-fact:fact_0123456789abcdef01234567 -->\nbody';
    const claimed = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }];
    const run = async (on: boolean) => {
      const before = process.env.CT_WISDOM_VERBOSE;
      const beforeLog = process.env.CT_WISDOM_VERBOSE_LOG;
      process.env.CT_WISDOM_VERBOSE = on ? '1' : '0';
      // runUserTurn is mocked here, so the recorder never runs; keep any write in tmp anyway.
      process.env.CT_WISDOM_VERBOSE_LOG = join(tmpdir(), 'ct-dsh-index-verbose.jsonl');
      try {
        const mm = mockCtx();
        vi.mocked(runUserTurn).mockClear();
        vi.mocked(runUserTurn).mockResolvedValueOnce(block);
        apply(mm.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
        const decision = (await mm.preStepListeners[0](
          { agent: { id: 'agent-1', session: { deriveMessages: () => [] } }, messages: claimed, turn: 1, step: 1 },
          async () => ({ kind: 'enter', messages: [...claimed] }),
        )) as { messages: Array<Record<string, unknown>> };
        const adapterArg = vi.mocked(runUserTurn).mock.calls[0]![0] as { recordVerbose?: unknown };
        return { content: decision.messages[1].content, recorder: typeof adapterArg.recordVerbose };
      } finally {
        if (before === undefined) delete process.env.CT_WISDOM_VERBOSE;
        else process.env.CT_WISDOM_VERBOSE = before;
        if (beforeLog === undefined) delete process.env.CT_WISDOM_VERBOSE_LOG;
        else process.env.CT_WISDOM_VERBOSE_LOG = beforeLog;
      }
    };
    const off = await run(false);
    const on = await run(true);
    expect(off.recorder).toBe('undefined');
    expect(on.recorder).toBe('function');
    expect(on.content).toEqual(off.content);
  });

  it('registers three skills', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const names = m.skillRegistrations.map((s) => s.name).sort();
    expect(names).toEqual([
      'curated-thoughts-ops',
      'curated-thoughts-sidecar',
      'curated-thoughts-usage',
    ]);
    for (const reg of m.skillRegistrations) {
      expect(reg.content.length).toBeGreaterThan(0);
      expect(reg.invocation.modelInvocable).toBe(true);
      expect(reg.invocation.userInvocable).toBe(true);
    }
  });
});

// ── Task 6: curated-thoughts-wisdom systemPrompt section ──────────────────

describe('wisdom section', () => {
  let m: ReturnType<typeof mockCtx>;
  beforeEach(() => {
    m = mockCtx();
    vi.mocked(renderWisdom).mockClear();
    delete process.env.CURATED_BRAIN_DIR;
  });

  it('registers exactly one section: name, order 6000, interpolate false, function text', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.sectionRegistrations).toHaveLength(1);
    const s = m.sectionRegistrations[0];
    expect(s.name).toBe('curated-thoughts-wisdom');
    expect(s.order).toBe(6000);
    expect(s.interpolate).toBe(false);
    expect(typeof s.text).toBe('function');
  });

  it('leaves the health context() registration unchanged (order 130)', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.contextRegistrations).toHaveLength(1);
    expect(m.contextRegistrations[0].name).toBe('curated-thoughts-health');
    expect(m.contextRegistrations[0].order).toBe(130);
  });

  it('invoking text(assembleCtx) calls renderWisdom with that same object', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    const assembleCtx = { agent: { id: 's9' }, scope: null, signal: {} };
    const out = m.sectionRegistrations[0].text(assembleCtx);
    expect(renderWisdom).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderWisdom).mock.calls[0]![0]).toBe(assembleCtx);
    expect(out).toBe('');
  });

  it('ambient CURATED_BRAIN_DIR wins over the row default and is passed through un-expanded (absolute)', () => {
    process.env.CURATED_BRAIN_DIR = '/data/brain';
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '~/.brain' } as Parameters<typeof apply>[1]);
    m.sectionRegistrations[0].text({ agent: { id: 'e1' } });
    const deps = vi.mocked(renderWisdom).mock.calls[0]![1] as { env: NodeJS.ProcessEnv };
    expect(deps.env.CURATED_BRAIN_DIR).toBe('/data/brain');
  });

  it('row-default brainDir is expanded — never a leading ~ in the env handed to renderWisdom', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '~/.brain' } as Parameters<typeof apply>[1]);
    m.sectionRegistrations[0].text({ agent: { id: 'e2' } });
    const deps = vi.mocked(renderWisdom).mock.calls[0]![1] as { env: NodeJS.ProcessEnv };
    expect(deps.env.CURATED_BRAIN_DIR).not.toMatch(/^~/);
    expect(deps.env.CURATED_BRAIN_DIR).toMatch(/[\\/]\.brain$/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apply, Config, inject } from '../src/index.js';

// The ctx mock encodes the real DSH 0.1.5 runtime surface: there is NO
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
  const sessionStartListeners: Array<() => Promise<void>> = [];
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
      },
      on: vi.fn((event: string, listener: () => Promise<void>) => {
        if (event === 'agent/session-start') sessionStartListeners.push(listener);
      }),
    },
    skillRegistrations,
    contextRegistrations,
    sessionStartListeners,
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

  it('publishes the health block once the session-start refresh has run', async () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.sessionStartListeners.length).toBe(1);
    // The listener refreshes the cache fail-open; the text() reference must
    // observe the refreshed value at the next prompt assembly.
    await m.sessionStartListeners[0]();
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
      await m.sessionStartListeners[0]();
      // The probe looked at the configured dir, so the degraded block names it.
      expect(m.contextRegistrations[0].text()).toContain('/nonexistent/ct-brain');
    } finally {
      if (before === undefined) delete process.env.CURATED_BRAIN_DIR;
      else process.env.CURATED_BRAIN_DIR = before;
    }
  });

  it('subscribes agent/session-start for async refresh', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], {} as Parameters<typeof apply>[1]);
    expect(m.sessionStartListeners.length).toBe(1);
    expect(typeof m.sessionStartListeners[0]).toBe('function');
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

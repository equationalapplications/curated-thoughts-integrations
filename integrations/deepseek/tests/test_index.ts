import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apply, Config } from '../src/index.js';

function mockCtx() {
  const pluginCalls: Array<{ name: string; cfg: unknown }> = [];
  const skillRegistrations: Array<{
    name: string;
    description: string;
    content: string;
    invocation: { modelInvocable: boolean; userInvocable: boolean };
  }> = [];
  const contextRegistrations: Array<{
    order: unknown;
    text: () => string;
  }> = [];
  const sessionStartListeners: Array<() => Promise<void>> = [];
  return {
    ctx: {
      plugin: vi.fn((name: string, cfg: unknown) => {
        pluginCalls.push({ name, cfg });
        return () => {};
      }),
      skills: {
        register: vi.fn((s: unknown) => {
          skillRegistrations.push(s as (typeof skillRegistrations)[number]);
          return () => {};
        }),
      },
      systemPrompt: {
        getContextOrder: vi.fn((name: string) => 100),
        context: vi.fn((c: unknown) => {
          contextRegistrations.push(c as (typeof contextRegistrations)[number]);
          return () => {};
        }),
      },
      on: vi.fn((event: string, listener: () => Promise<void>) => {
        if (event === 'agent/session-start') sessionStartListeners.push(listener);
      }),
    },
    pluginCalls,
    skillRegistrations,
    contextRegistrations,
    sessionStartListeners,
  };
}

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

  it('mounts @deepseek-ai/dsh-mcp-client with the curated-thoughts server', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '/home/u/.brain' } as Parameters<typeof apply>[1]);
    expect(m.pluginCalls).toHaveLength(1);
    expect(m.pluginCalls[0].name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(m.pluginCalls[0].cfg).toMatchObject({
      serverName: 'curated-thoughts',
      transport: 'stdio',
      command: 'curated-thoughts-mcp',
      args: ['--mcp'],
      env: { CURATED_BRAIN_DIR: '/home/u/.brain' },
    });
  });

  it('uses the configured sidecar command override', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '/x', sidecarCommand: 'my-sidecar' } as Parameters<typeof apply>[1]);
    expect(m.pluginCalls[0].cfg).toMatchObject({
      command: 'my-sidecar',
      args: ['--mcp'],
    });
  });

  it('registers a dynamic prompt context with empty default', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '/x' } as Parameters<typeof apply>[1]);
    expect(m.contextRegistrations).toHaveLength(1);
    const ctx0 = m.contextRegistrations[0];
    // Empty first-call default — text is a function reference evaluated lazily.
    expect(typeof ctx0.text).toBe('function');
    expect(ctx0.text()).toBe('');
  });

  it('subscribes agent/session-start for async refresh', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '/x' } as Parameters<typeof apply>[1]);
    expect(m.sessionStartListeners.length).toBe(1);
    expect(typeof m.sessionStartListeners[0]).toBe('function');
  });

  it('registers three skills', () => {
    apply(m.ctx as unknown as Parameters<typeof apply>[0], { brainDir: '/x' } as Parameters<typeof apply>[1]);
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

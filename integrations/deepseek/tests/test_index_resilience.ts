import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// readFileSync is mocked so a skill file can be made unreadable at will.
// vi.mock is hoisted above the imports, so the switch lives in vi.hoisted().
const h = vi.hoisted(() => ({ unreadable: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // existsSync stays real: findSkillsRoot() uses it at module load to
    // locate the shipped skills/ directory.
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (h.unreadable !== null && String(p).includes(h.unreadable)) {
        const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { apply } = await import('../src/index.js');

/** Minimal dsh context; `failRegister` makes skills.register throw for one name. */
function mockCtx(failRegister: string | null = null) {
  const registered: string[] = [];
  const contexts: unknown[] = [];
  return {
    ctx: {
      skills: {
        register: vi.fn((s: { name: string }) => {
          if (s.name === failRegister) throw new Error('host rejected this skill');
          registered.push(s.name);
          return () => {};
        }),
      },
      systemPrompt: {
        context: vi.fn((c: unknown) => { contexts.push(c); return () => {}; }),
      },
      on: vi.fn(() => {}),
    },
    registered,
    contexts,
  };
}

describe('apply survives a broken skill', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    h.unreadable = null;
    warn.mockRestore();
  });

  it('registers all three skills when nothing is wrong', () => {
    const m = mockCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply(m.ctx as any, {});
    expect(m.registered).toHaveLength(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the prompt context when one SKILL.md is unreadable', () => {
    h.unreadable = 'curated-thoughts-ops';
    const m = mockCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => apply(m.ctx as any, {})).not.toThrow();
    expect(m.registered).toEqual(['curated-thoughts-usage', 'curated-thoughts-sidecar']);
    // The plugin still does its real job: the prompt context must survive a
    // bad skill file. (The MCP client is mounted by the shipped bundle
    // patch, outside apply()'s control.)
    expect(m.contexts).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps the other skills when one registration throws', () => {
    const m = mockCtx('curated-thoughts-usage');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => apply(m.ctx as any, {})).not.toThrow();
    expect(m.registered).toEqual(['curated-thoughts-ops', 'curated-thoughts-sidecar']);
    expect(warn).toHaveBeenCalledOnce();
  });
});

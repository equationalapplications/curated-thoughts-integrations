import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import type { LocalSnapshot } from '../src/status.js';

vi.mock('../src/status.js', () => ({
  probeLocal: vi.fn(),
}));

const status = await import('../src/status.js');
const mod = await import('../src/index.js');
const { CuratedThoughts } = mod;
const probeLocal = vi.mocked(status.probeLocal);

type Transform = NonNullable<Hooks['experimental.chat.system.transform']>;
type TransformInput = Parameters<Transform>[0];

const INPUT = { directory: '/work/project' } as unknown as PluginInput;
const MODEL = {} as TransformInput['model'];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function load(options?: Record<string, unknown>) {
  const hooks = await CuratedThoughts(INPUT, options);
  const transform = hooks['experimental.chat.system.transform'] as Transform;
  const run = async (sessionID: string | undefined, system: string[]) => {
    const output = { system };
    await transform({ sessionID, model: MODEL }, output);
    return output;
  };
  return { hooks, run };
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv, HOME: '/home/tester', USERPROFILE: '/home/tester' };
  delete process.env.CURATED_BRAIN_DIR;
  delete process.env.CURATED_BRAIN_DB;
  delete process.env.CURATED_BRAIN_CONFIG;
  probeLocal.mockReset();
  probeLocal.mockResolvedValue({ readiness: 'ready', reasons: [] });
});

afterEach(() => {
  process.env = originalEnv;
  vi.useRealTimers();
});

describe('module exports', () => {
  it('exports only the named CuratedThoughts plugin (no default, no server)', () => {
    expect(Object.keys(mod).sort()).toEqual(['CuratedThoughts']);
    expect(typeof CuratedThoughts).toBe('function');
  });
});

describe('CuratedThoughts hooks object', () => {
  it('returns exactly the system transform and dispose hooks', async () => {
    const { hooks } = await load();
    // No `event` hook: OpenCode 1.18.31 emits no MCP status event
    // (tests/host/compatibility.json → findings.mcpStatusEvents = false).
    expect(Object.keys(hooks).sort()).toEqual(['dispose', 'experimental.chat.system.transform']);
    await hooks.dispose!();
  });

  it('never probes at load time', async () => {
    const { hooks } = await load();
    expect(probeLocal).not.toHaveBeenCalled();
    await hooks.dispose!();
  });

  it('a session-less call neither refreshes nor mutates output.system', async () => {
    const { hooks, run } = await load();
    const prior = ['host system prompt'];
    const output = await run(undefined, [...prior]);
    expect(output.system).toEqual(prior);
    expect(probeLocal).not.toHaveBeenCalled();
    await hooks.dispose!();
  });

  it('keeps pre-existing entries unchanged and in order, appending one block', async () => {
    const { hooks, run } = await load();
    const prior = ['first entry', 'second entry\nmulti-line', 'third'];
    const output = await run('ses_1', [...prior]);
    expect(output.system.slice(0, prior.length)).toEqual(prior);
    expect(output.system).toHaveLength(prior.length + 1);
    expect(output.system[prior.length]!.startsWith('## Curated Thoughts\n')).toBe(true);
    await hooks.dispose!();
  });

  it('injects the block exactly once across repeated invocation', async () => {
    const { hooks, run } = await load();
    const prior = ['host system prompt'];
    const output = { system: [...prior] };
    const transform = hooks['experimental.chat.system.transform'] as Transform;
    for (let i = 0; i < 5; i++) {
      await transform({ sessionID: 'ses_1', model: MODEL }, output);
      await flush();
    }
    expect(output.system.slice(0, prior.length)).toEqual(prior);
    expect(countOccurrences(output.system.join('\n'), '## Curated Thoughts')).toBe(1);
    // A fresh array per assembly (what the host does) gets its own block.
    const again = await run('ses_1', [...prior]);
    expect(countOccurrences(again.system.join('\n'), '## Curated Thoughts')).toBe(1);
    await hooks.dispose!();
  });

  it('does not await the probe', async () => {
    probeLocal.mockImplementation(
      () =>
        new Promise<LocalSnapshot>(() => {
          /* never settles */
        }),
    );
    const { hooks, run } = await load();
    const pending = run('ses_1', ['host']);
    // The hook must settle while the probe promise is still pending; if it
    // awaited the probe, only the microtask-bounded sentinel would win.
    const hung = flush().then(() => 'hung' as const);
    const winner = await Promise.race([pending.then(() => 'done' as const), hung]);
    expect(winner).toBe('done');
    const output = await pending;
    expect(probeLocal).toHaveBeenCalledTimes(1);
    // Nothing known yet: honest unknown block.
    expect(output.system[1]).toMatch(/Memory status unknown/);
    await hooks.dispose!();
  });

  it('reports the refreshed state on a later assembly', async () => {
    probeLocal.mockResolvedValue({ readiness: 'degraded', reasons: ['vault-path-missing'] });
    const { hooks, run } = await load();
    await run('ses_1', ['host']);
    await flush();
    const output = await run('ses_1', ['host']);
    expect(output.system[1]).toMatch(/DEGRADED — CT tool calls may fail\. Run ct_doctor/);
    // Reason codes and paths never reach the prompt.
    expect(output.system[1]).not.toMatch(/vault-path-missing|\/home\/tester/);
    await hooks.dispose!();
  });

  it('a probe that throws synchronously does not break the hook', async () => {
    probeLocal.mockImplementation(() => {
      throw new Error('EACCES /home/tester/secret');
    });
    const { hooks, run } = await load();
    const output = await run('ses_1', ['host']);
    expect(output.system).toHaveLength(2);
    expect(output.system[1]).not.toMatch(/EACCES|secret/);
    await hooks.dispose!();
  });
});

describe('brain dir resolution', () => {
  async function brainLabelAndEnv(options?: Record<string, unknown>) {
    const { hooks, run } = await load(options);
    await run('ses_1', ['host']);
    await flush();
    const output = await run('ses_1', ['host']);
    const env = probeLocal.mock.calls[0]![0];
    await hooks.dispose!();
    return { block: output.system[1]!, env };
  }

  it('with no options (the v0 loader-file path) falls back to CURATED_BRAIN_DIR', async () => {
    process.env.CURATED_BRAIN_DIR = '/srv/env-brain';
    const { block, env } = await brainLabelAndEnv(undefined);
    expect(env.CURATED_BRAIN_DIR).toBe('/srv/env-brain');
    expect(block).toMatch(/Memory sidecar ready \(brain: env-brain\)/);
  });

  it('with no options and no env falls back to ~/.brain', async () => {
    const { block, env } = await brainLabelAndEnv(undefined);
    expect(env.CURATED_BRAIN_DIR).toBeUndefined();
    expect(block).toMatch(/Memory sidecar ready \(brain: \.brain\)/);
  });

  it('options.brainDir overrides CURATED_BRAIN_DIR without mutating process.env', async () => {
    process.env.CURATED_BRAIN_DIR = '/srv/env-brain';
    const { block, env } = await brainLabelAndEnv({ brainDir: '/srv/option-brain' });
    expect(env.CURATED_BRAIN_DIR).toBe('/srv/option-brain');
    expect(process.env.CURATED_BRAIN_DIR).toBe('/srv/env-brain');
    expect(block).toMatch(/Memory sidecar ready \(brain: option-brain\)/);
  });

  it('ignores a non-string or empty options.brainDir', async () => {
    process.env.CURATED_BRAIN_DIR = '/srv/env-brain';
    for (const brainDir of [42, '', '   ', null]) {
      probeLocal.mockClear();
      const { env } = await brainLabelAndEnv({ brainDir });
      expect(env.CURATED_BRAIN_DIR).toBe('/srv/env-brain');
    }
  });

  it('passes the plugin input directory as the probe cwd', async () => {
    const { hooks, run } = await load();
    await run('ses_1', ['host']);
    expect(probeLocal.mock.calls[0]![1]).toBe('/work/project');
    await hooks.dispose!();
  });
});

describe('dispose', () => {
  it('tears down the cache: aborts the in-flight probe and stops refreshing', async () => {
    let signal: AbortSignal | undefined;
    probeLocal.mockImplementation((_env, _cwd, s) => {
      signal = s;
      return new Promise<LocalSnapshot>(() => {});
    });
    const { hooks, run } = await load();
    await run('ses_1', ['host']);
    await expect(hooks.dispose!()).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);

    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    await run('ses_1', ['host']);
    expect(probeLocal).toHaveBeenCalledTimes(1);
  });
});

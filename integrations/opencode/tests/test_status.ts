import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ESM module namespaces are non-configurable, so `vi.spyOn` on a named
// export throws. `vi.mock` with a factory that wraps the real implementation
// in `vi.fn` gives the same call-tracking without redefining the export.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    exec: vi.fn(actual.exec),
    execFile: vi.fn(actual.execFile),
  };
});

const fsPromises = await import('node:fs/promises');
const childProcess = await import('node:child_process');
const { probeLocal } = await import('../src/status.js');
const { ENV_BRAIN_DIR } = await import('../scripts/ct_env.js');

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-probe-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env[ENV_BRAIN_DIR];
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('probeLocal', () => {
  it('returns unknown (not degraded) when the brain cannot be resolved', async () => {
    // Nothing set: falls back to a guessed ~/.brain that does not exist here.
    const snap = await probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(snap.readiness).toBe('unknown');
    expect(snap.reasons).toEqual(['brain-dir-not-found']);
  });

  it('never inspects a guessed brain dir beyond confirming it is missing', async () => {
    await probeLocal(process.env, tmpHome, new AbortController().signal);
    // config.json under the guessed ~/.brain must never be read once the
    // brain dir itself was confirmed missing.
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('returns degraded with a bounded reason code when config.json is missing', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    process.env[ENV_BRAIN_DIR] = brainDir;

    const snap = await probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(snap.readiness).toBe('degraded');
    expect(snap.reasons).toEqual(['config-unreadable']);
    // Bounded reason codes only: no raw paths, no exception messages, no stack traces.
    for (const reason of snap.reasons) {
      expect(reason).not.toMatch(/error|exception|enoent|at\s+\S+:\d+/i);
      expect(reason.length).toBeLessThan(64);
    }
  });

  it('returns degraded with a bounded reason code on malformed JSON', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    writeFileSync(join(brainDir, 'config.json'), '{ not json');
    process.env[ENV_BRAIN_DIR] = brainDir;

    const snap = await probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(snap.readiness).toBe('degraded');
    expect(snap.reasons).toEqual(['config-malformed']);
  });

  it('returns degraded when vault_path is missing from config', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({}));
    process.env[ENV_BRAIN_DIR] = brainDir;

    const snap = await probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(snap.readiness).toBe('degraded');
    expect(snap.reasons).toEqual(['vault-path-unresolved']);
  });

  it('returns degraded when vault_path does not exist on disk', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: join(tmpHome, 'nope') }));
    process.env[ENV_BRAIN_DIR] = brainDir;

    const snap = await probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(snap.readiness).toBe('degraded');
    expect(snap.reasons).toEqual(['vault-path-missing']);
  });

  it('returns ready when brain and vault both resolve and exist', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    const vault = join(tmpHome, 'vault');
    mkdirSync(vault);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: vault }));
    process.env[ENV_BRAIN_DIR] = brainDir;

    const snap = await probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(snap.readiness).toBe('ready');
    expect(snap.reasons).toEqual([]);
  });

  it('respects an already-aborted AbortSignal (cooperative cancellation)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeLocal(process.env, tmpHome, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('respects an AbortSignal that fires mid-probe', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: tmpHome }));
    process.env[ENV_BRAIN_DIR] = brainDir;

    const controller = new AbortController();
    // Abort as soon as the first microtask-scheduled fs call resolves, well
    // before probeLocal would otherwise finish.
    const promise = probeLocal(process.env, tmpHome, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not invoke the sidecar or spawn any subprocess', async () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    const vault = join(tmpHome, 'vault');
    mkdirSync(vault);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: vault }));
    process.env[ENV_BRAIN_DIR] = brainDir;

    await probeLocal(process.env, tmpHome, new AbortController().signal);

    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('probes the filesystem asynchronously (returns a pending Promise, not a synchronous result)', () => {
    const result = probeLocal(process.env, tmpHome, new AbortController().signal);
    expect(result).toBeInstanceOf(Promise);
    // Consume it so the test runner doesn't report an unhandled rejection.
    return result.catch(() => undefined);
  });
});

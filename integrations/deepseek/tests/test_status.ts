import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '../src/status.js';

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-status-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CURATED_BRAIN_DIR;
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('probe', () => {
  it('returns degraded when sidecar is not found and brain is missing', () => {
    process.env.PATH = '';
    const snap = probe();
    expect(snap.status).toBe('degraded');
    expect(snap.sidecar).toBeNull();
    expect(snap.brainDir).not.toBeNull();
    expect(snap.notes.length).toBeGreaterThan(0);
  });

  it('returns ok when sidecar is on PATH and brain + vault resolve', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const sidecar = join(binDir, 'curated-thoughts-mcp');
    writeFileSync(sidecar, '#!/bin/sh\n');
    // Sidecar discovery enforces the executable bit on POSIX (shutil.which
    // parity), so the fixture must chmod +x its fake sidecar.
    chmodSync(sidecar, 0o755);
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '');

    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    const vault = join(tmpHome, 'vault');
    mkdirSync(vault);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: vault }));

    process.env.CURATED_BRAIN_DIR = brainDir;

    const snap = probe();
    expect(snap.status).toBe('ok');
    expect(snap.sidecar).toMatch(/curated-thoughts-mcp/);
    expect(snap.brainDir).toBe(brainDir);
    expect(snap.vault).toBe(vault);
    expect(snap.notes).toEqual([]);
  });

  it('returns degraded when brain exists but vault_path does not', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'curated-thoughts-mcp'), '#!/bin/sh\n');
    chmodSync(join(binDir, 'curated-thoughts-mcp'), 0o755);
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '');

    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: '/nonexistent' }));
    process.env.CURATED_BRAIN_DIR = brainDir;

    const snap = probe();
    expect(snap.status).toBe('degraded');
    expect(snap.notes.some((n) => /vault/.test(n))).toBe(true);
  });

  it('does not spawn the sidecar', () => {
    // Sidecar is a fake script that prints "SPAWNED" if executed. probe() must
    // only do path / file existence checks, not execute it.
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const sidecar = join(binDir, 'curated-thoughts-mcp');
    // Write a script that creates a sentinel file — if probe() spawns it, the
    // sentinel will exist after the call.
    writeFileSync(sidecar, `#!/bin/sh\ntouch ${join(tmpHome, 'SPAWNED')}\n`);
    chmodSync(sidecar, 0o755);
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '');

    probe();

    expect(require('node:fs').existsSync(join(tmpHome, 'SPAWNED'))).toBe(false);
  });
});
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveBrainPaths,
  readBrainConfig,
  resolveVaultPath,
  findSidecar,
  sidecarCandidates,
  looksLikeDevBuild,
  installKind,
  ENV_BRAIN_DIR,
} from '../scripts/ct_env.js';

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-env-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows
  delete process.env[ENV_BRAIN_DIR];
  delete process.env.CURATED_BRAIN_DB;
  delete process.env.CURATED_BRAIN_CONFIG;
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveBrainPaths', () => {
  it('defaults to ~/.brain when no env var is set', () => {
    const paths = resolveBrainPaths();
    expect(paths.brainDir).toBe(join(tmpHome, '.brain'));
    expect(paths.dbPath).toBe(join(tmpHome, '.brain', 'brain.db'));
    expect(paths.configPath).toBe(join(tmpHome, '.brain', 'config.json'));
  });

  it('honors CURATED_BRAIN_DIR', () => {
    const custom = join(tmpHome, 'my-brain');
    process.env[ENV_BRAIN_DIR] = custom;
    const paths = resolveBrainPaths();
    expect(paths.brainDir).toBe(custom);
  });

  it('CURATED_BRAIN_DB overrides brainDir for dbPath, config.json sits beside the db', () => {
    // Hermes parity (ct_env.py): with an explicit CURATED_BRAIN_DB, config.json
    // is db_path.parent / "config.json" — split brain layouts probe the right
    // directory.
    process.env[ENV_BRAIN_DIR] = join(tmpHome, 'a');
    process.env.CURATED_BRAIN_DB = join(tmpHome, 'b', 'brain.db');
    const paths = resolveBrainPaths();
    expect(paths.brainDir).toBe(join(tmpHome, 'a'));
    expect(paths.dbPath).toBe(join(tmpHome, 'b', 'brain.db'));
    expect(paths.configPath).toBe(join(tmpHome, 'b', 'config.json'));
  });

  it('split brain layout: brainDir and db directory stay independent', () => {
    process.env[ENV_BRAIN_DIR] = join(tmpHome, 'elsewhere');
    process.env.CURATED_BRAIN_DB = join(tmpHome, 'x', 'b', 'brain.db');
    const paths = resolveBrainPaths();
    expect(paths.configPath).toBe(join(tmpHome, 'x', 'b', 'config.json'));
    expect(paths.configPath).not.toContain('elsewhere');
  });

  it('CURATED_BRAIN_CONFIG still wins over the beside-the-db rule', () => {
    process.env.CURATED_BRAIN_DB = join(tmpHome, 'b', 'brain.db');
    process.env.CURATED_BRAIN_CONFIG = join(tmpHome, 'custom.json');
    const paths = resolveBrainPaths();
    expect(paths.configPath).toBe(join(tmpHome, 'custom.json'));
  });
});

describe('readBrainConfig', () => {
  it('returns null + error when the file is missing', () => {
    const { config, error } = readBrainConfig(join(tmpHome, 'absent.json'));
    expect(config).toBeNull();
    expect(error).toMatch(/missing/i);
  });

  it('returns null + error on invalid JSON', () => {
    const bad = join(tmpHome, 'bad.json');
    writeFileSync(bad, '{ not json');
    const { config, error } = readBrainConfig(bad);
    expect(config).toBeNull();
    expect(error).toMatch(/json/i);
  });

  it('parses a minimal valid config', () => {
    const good = join(tmpHome, 'good.json');
    writeFileSync(good, JSON.stringify({ vault_path: '/data/v' }));
    const { config, error } = readBrainConfig(good);
    expect(error).toBeNull();
    expect(config?.vault_path).toBe('/data/v');
  });
});

describe('resolveVaultPath', () => {
  it('returns null when vault_path is absent', () => {
    const { vault, error } = resolveVaultPath({});
    expect(vault).toBeNull();
    expect(error).toMatch(/vault_path/i);
  });

  it('expands ~ to HOME', () => {
    const { vault, error } = resolveVaultPath({ vault_path: '~/vault' });
    expect(error).toBeNull();
    expect(vault).toBe(join(tmpHome, 'vault'));
  });

  it('expands a bare ~ to HOME', () => {
    const { vault, error } = resolveVaultPath({ vault_path: '~' });
    expect(error).toBeNull();
    expect(vault).toBe(tmpHome);
  });

  it('leaves ~otheruser alone rather than joining it onto HOME', () => {
    // Node has no password-database lookup, so `~someone` cannot be resolved
    // the way Python's expanduser does. Returning it untouched matches what
    // expanduser itself does for an unknown user; joining it onto HOME would
    // invent <HOME>/someone/Documents — a real-looking path under the wrong
    // account that the doctor would then report as a valid vault.
    const { vault, error } = resolveVaultPath({ vault_path: '~someone/Documents' });
    expect(error).toBeNull();
    expect(vault).toBe('~someone/Documents');
    expect(vault).not.toBe(join(tmpHome, 'someone', 'Documents'));
  });
});

describe('findSidecar', () => {
  it('returns null when not on PATH and no platform location matches', () => {
    // Empty PATH; the platform install locations under tmpHome don't exist.
    process.env.PATH = '';
    const found = findSidecar();
    expect(found).toBeNull();
  });

  it('finds curated-thoughts-mcp on PATH', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const fake = join(binDir, 'curated-thoughts-mcp');
    writeFileSync(fake, '#!/bin/sh\necho ok\n');
    // The lookup enforces the executable bit on POSIX (shutil.which parity),
    // so the fixture must chmod +x its fake sidecar.
    chmodSync(fake, 0o755);
    process.env.PATH = binDir;
    const found = findSidecar();
    expect(found?.path).toBe(fake);
    expect(found?.source).toBe('PATH');
  });

  it('ignores a non-executable sidecar on PATH (POSIX shutil.which parity)', () => {
    if (process.platform === 'win32') {
      // No executable bit on Windows; every file passes the check.
      return;
    }
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const fake = join(binDir, 'curated-thoughts-mcp');
    writeFileSync(fake, '#!/bin/sh\necho ok\n');
    // Deliberately NOT chmod +x.
    // Replace PATH rather than prepend: the assertion is toBeNull(), so an
    // inherited PATH carrying a real curated-thoughts-mcp install would let
    // the walk skip this fixture and match that instead, failing on the
    // developer's machine while passing on a clean runner.
    process.env.PATH = binDir;
    expect(findSidecar()).toBeNull();
  });

  it('resolves a .cmd sidecar via PATHEXT probing when platform is win32', () => {
    // Exercises the win32 branch of whichOnPath on any host OS: the bare
    // name `curated-thoughts-mcp` does not exist, but the PATHEXT-appended
    // `.cmd` candidate does.
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const fake = join(binDir, 'curated-thoughts-mcp.cmd');
    writeFileSync(fake, '@echo ok\r\n');
    process.env.PATH = binDir;
    const found = findSidecar(process.env, 'win32');
    expect(found?.path).toBe(fake);
    expect(found?.source).toBe('PATH');
  });
});

describe('sidecarCandidates', () => {
  it('includes ~/.local/bin/curated-thoughts-mcp', () => {
    const candidates = sidecarCandidates();
    expect(candidates.some((c) => c.endsWith(join('.local', 'bin', 'curated-thoughts-mcp')))).toBe(true);
  });
});

describe('looksLikeDevBuild', () => {
  it('flags a path inside tools/ or target/', () => {
    expect(looksLikeDevBuild('/repo/tools/curated-thoughts-mcp')).toBe(true);
    expect(looksLikeDevBuild('/repo/target/debug/curated-thoughts-mcp')).toBe(true);
  });

  it('does not flag a path under /usr/bin', () => {
    expect(looksLikeDevBuild('/usr/bin/curated-thoughts-mcp')).toBe(false);
  });
});

describe('installKind', () => {
  it('returns homebrew for /opt/homebrew or /usr/local/Cellar', () => {
    expect(installKind('/opt/homebrew/bin/curated-thoughts-mcp')).toBe('homebrew');
    expect(installKind('/usr/local/Cellar/curated-thoughts/1.0/bin/curated-thoughts-mcp')).toBe('homebrew');
  });

  it('returns deb for /usr/bin', () => {
    expect(installKind('/usr/bin/curated-thoughts-mcp')).toBe('deb');
  });

  it('returns app-bundle for a macOS .app path', () => {
    expect(installKind('/Applications/Curated Thoughts.app/Contents/MacOS/curated-thoughts-mcp')).toBe('app-bundle');
  });
});
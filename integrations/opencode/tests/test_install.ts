/**
 * test_install.ts — install.ts main() and the proposal's apply() (spec §4, §7).
 *
 * Preview by default; CT_INSTALL_EDIT=1 is the only mutation path. Every test
 * runs against a temp HOME / XDG_CONFIG_HOME / XDG_DATA_HOME and a stubbed
 * doctor runner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'jsonc-parser';
import { main, type InstallDeps } from '../scripts/install.js';
import { propose } from '../scripts/registration.js';
import {
  isolateProcessEnv,
  makePackage,
  makeSandbox,
  PKG_ROOT,
  SKILLS,
  treeSnapshot,
  writeFile,
  type Sandbox,
} from './install_sandbox.js';

// Creating symlinks on Windows needs admin rights or developer mode.
const CAN_SYMLINK = process.platform !== 'win32';

let sb: Sandbox;
let restoreEnv: () => void;

beforeEach(() => {
  sb = makeSandbox();
  restoreEnv = isolateProcessEnv(sb);
});

afterEach(() => {
  restoreEnv();
  sb.cleanup();
});

interface Run {
  code: number;
  out: string;
  err: string;
  doctorCalls: string[][];
}

async function install(argv: string[] = [], opts: { edit?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  let out = '';
  let err = '';
  const doctorCalls: string[][] = [];
  const env = { ...(opts.env ?? sb.env) };
  if (opts.edit) env.CT_INSTALL_EDIT = '1';
  const deps: InstallDeps = {
    env,
    packageRoot: sb.pkg,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    runDoctor: async (script, args) => {
      doctorCalls.push([script, ...args]);
      return 0;
    },
  };
  const code = await main(argv, deps);
  return { code, out, err, doctorCalls };
}

const configPath = () => join(sb.ocDir, 'opencode.json');
const read = (p: string) => readFileSync(p, 'utf8');

describe('preview (default)', () => {
  it('writes nothing — no payload, loader, skills or config', async () => {
    writeFile(configPath(), '{ "theme": "dark" }\n');
    const before = treeSnapshot(sb.root);
    const r = await install();
    expect(r.code).toBe(0);
    expect(treeSnapshot(sb.root)).toEqual(before);
    expect(r.out).toMatch(/PREVIEW/);
    expect(r.out).toContain('CT_INSTALL_EDIT=1');
    expect(r.out).toContain(sb.payloadDir);
    expect(r.out).toContain(sb.loaderPath);
    expect(r.out).toContain('export { CuratedThoughts } from "file://');
    for (const name of SKILLS) expect(r.out).toContain(join(sb.ocDir, 'skills', name, 'SKILL.md'));
    expect(r.out).toContain('"curated-thoughts-mcp"');
    expect(r.doctorCalls).toEqual([]);
  });

  it('rejects unknown arguments with exit 2', async () => {
    const r = await install(['--bogus']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown argument/);
  });
});

describe('CT_INSTALL_EDIT=1', () => {
  it('unpacks the payload, writes the loader and skills, and edits config after a .bak', async () => {
    const original = '{\n  "theme": "dark"\n}\n';
    writeFile(configPath(), original);
    writeFile(join(sb.pkg, 'lib', 'scripts', 'ct_doctor.js'), '// doctor\n');
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    expect(read(join(sb.payloadDir, 'lib', 'src', 'index.js'))).toContain("'v1'");
    expect(existsSync(join(sb.payloadDir, 'package.json'))).toBe(true);
    expect(existsSync(join(sb.payloadDir, 'scripts', 'install.sh'))).toBe(true);
    expect(existsSync(join(sb.payloadDir, 'skills', 'curated-thoughts-usage', 'SKILL.md'))).toBe(true);
    expect(read(sb.loaderPath)).toContain(join(sb.payloadDir));
    for (const name of SKILLS) {
      expect(read(join(sb.ocDir, 'skills', name, 'SKILL.md'))).toBe(read(join(sb.pkg, 'skills', name, 'SKILL.md')));
    }
    expect(read(configPath() + '.bak')).toBe(original);
    const cfg = parse(read(configPath()));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcp['curated-thoughts'].command).toEqual(['curated-thoughts-mcp', '--mcp']);
    expect(r.doctorCalls).toEqual([[join(sb.payloadDir, 'lib', 'scripts', 'ct_doctor.js'), 'check']]);
    // No staging / old-payload leftovers beside the payload.
    expect(readdirSync(dirname(sb.payloadDir))).toEqual(['opencode']);
  });

  it('creates the config file (no .bak) when none exists', async () => {
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    expect(parse(read(configPath())).mcp['curated-thoughts'].enabled).toBe(true);
    expect(existsSync(configPath() + '.bak')).toBe(false);
  });

  it('warns, but does not fail, when the payload has no doctor yet', async () => {
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    expect(r.doctorCalls).toEqual([]);
    expect(r.err + r.out).toMatch(/ct_doctor\.js not found/);
  });

  it('re-running with a newer payload replaces it in place and leaves the loader untouched', async () => {
    await install([], { edit: true });
    const loaderBefore = read(sb.loaderPath);
    const loaderMtime = statSync(sb.loaderPath).mtimeMs;
    writeFile(join(sb.payloadDir, 'lib', 'stale.js'), 'stale');
    makePackage(sb.pkg, 'v2');
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    expect(read(join(sb.payloadDir, 'lib', 'src', 'index.js'))).toContain("'v2'");
    expect(existsSync(join(sb.payloadDir, 'lib', 'stale.js'))).toBe(false);
    expect(read(sb.loaderPath)).toBe(loaderBefore);
    expect(statSync(sb.loaderPath).mtimeMs).toBe(loaderMtime);
  });

  it('a repeated, already-configured install is a clean no-op', async () => {
    await install([], { edit: true });
    const before = treeSnapshot(sb.root);
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    expect(treeSnapshot(sb.root)).toEqual(before);
    expect(r.out).toMatch(/nothing to do/i);
    expect(existsSync(configPath() + '.bak')).toBe(false);
  });

  it('keeps comments and trailing commas in a JSONC config on disk', async () => {
    const p = join(sb.ocDir, 'opencode.jsonc');
    writeFile(p, '{\n  // keep me\n  "theme": "dark", /* and me */\n  "plugin": ["a@1",],\n}\n');
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    const text = read(p);
    expect(text).toContain('// keep me');
    expect(text).toContain('/* and me */');
    expect(text).toContain('"plugin": ["a@1",],');
    const cfg = parse(text, [], { allowTrailingComma: true });
    expect(cfg.mcp['curated-thoughts'].type).toBe('local');
    expect(cfg.mcp['curated-thoughts'].environment).toEqual({ CURATED_BRAIN_DIR: '/tmp/brain' });
    expect(existsSync(configPath())).toBe(false);
  });

  it('an unparseable config prints manual instructions and is not written; no competing .json', async () => {
    const p = join(sb.ocDir, 'opencode.jsonc');
    const broken = '{ "mcp": { oops \n';
    writeFile(p, broken);
    const r = await install([], { edit: true });
    expect(r.code).toBe(3);
    expect(read(p)).toBe(broken);
    expect(existsSync(p + '.bak')).toBe(false);
    expect(existsSync(configPath())).toBe(false);
    expect(r.out).toMatch(/merge .*manually/i);
    expect(r.out).toContain('"curated-thoughts-mcp"');
  });

  it.skipIf(!CAN_SYMLINK)('refuses to follow a symlinked config file', async () => {
    const real = join(sb.root, 'dotfiles', 'opencode.json');
    writeFile(real, '{}\n');
    mkdirSync(sb.ocDir, { recursive: true });
    symlinkSync(real, configPath());
    const r = await install([], { edit: true });
    expect(r.code).toBe(3);
    expect(read(real)).toBe('{}\n');
    expect(lstatSync(configPath()).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!CAN_SYMLINK)('never writes the loader through a plugins/ symlink out of the config dir', async () => {
    const outside = join(sb.root, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(sb.ocDir, { recursive: true });
    symlinkSync(outside, join(sb.ocDir, 'plugins'));
    const r = await install([], { edit: true });
    expect(r.code).toBe(3);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('an existing disabled entry stays disabled on disk', async () => {
    writeFile(configPath(), '{ "mcp": { "curated-thoughts": { "enabled": false } } }\n');
    const r = await install([], { edit: true });
    expect(r.code).toBe(0);
    const entry = parse(read(configPath())).mcp['curated-thoughts'];
    expect(entry.enabled).toBe(false);
    expect(entry.command).toEqual(['curated-thoughts-mcp', '--mcp']);
  });

  it('never clobbers a user-modified SKILL.md; reports the conflict', async () => {
    const mine = join(sb.ocDir, 'skills', 'curated-thoughts-ops', 'SKILL.md');
    writeFile(mine, 'my edits\n');
    const r = await install([], { edit: true });
    expect(r.code).toBe(3);
    expect(read(mine)).toBe('my edits\n');
    expect(r.out).toMatch(/CONFLICT.*curated-thoughts-ops/);
    // The other skills still install.
    expect(existsSync(join(sb.ocDir, 'skills', 'curated-thoughts-usage', 'SKILL.md'))).toBe(true);
  });

  it('--skip-config installs payload, loader and skills but leaves config alone', async () => {
    writeFile(configPath(), '{}\n');
    const before = read(configPath());
    const r = await install(['--skip-config'], { edit: true });
    expect(r.code).toBe(0);
    expect(read(configPath())).toBe(before);
    expect(existsSync(configPath() + '.bak')).toBe(false);
    expect(existsSync(sb.loaderPath)).toBe(true);
    expect(existsSync(join(sb.payloadDir, 'lib', 'src', 'index.js'))).toBe(true);
    expect(existsSync(join(sb.ocDir, 'skills', 'curated-thoughts-sidecar', 'SKILL.md'))).toBe(true);
    expect(r.out).toContain('"curated-thoughts"');
  });
});

describe('apply() safety', () => {
  const editEnv = () => ({ ...sb.env, CT_INSTALL_EDIT: '1' });

  it('aborts on a concurrent external edit (mtime moved) before writing anything', async () => {
    writeFile(configPath(), '{}\n');
    const proposal = propose({ env: editEnv(), packageRoot: sb.pkg });
    writeFileSync(configPath(), '{ "theme": "light" }\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(configPath(), later, later);
    await expect(proposal.apply()).rejects.toThrow(/changed on disk/);
    expect(read(configPath())).toBe('{ "theme": "light" }\n');
    expect(existsSync(sb.payloadDir)).toBe(false);
    expect(existsSync(sb.loaderPath)).toBe(false);
  });

  it('restores the original from the backup when the config write fails partway', async () => {
    const original = '{\n  // mine\n  "theme": "dark"\n}\n';
    writeFile(configPath(), original);
    const proposal = propose({ env: editEnv(), packageRoot: sb.pkg });
    await expect(
      proposal.apply({
        io: {
          rename: (from, to) => {
            if (to === configPath()) {
              writeFileSync(to, '{ "mcp": { "curated-th'); // torn write
              throw new Error('disk full');
            }
            renameSync(from, to);
          },
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(read(configPath())).toBe(original);
    expect(read(configPath() + '.bak')).toBe(original);
    // No temp files left in the config dir.
    expect(readdirSync(sb.ocDir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('writes each skill via temp file + rename in the same directory', async () => {
    const renames: Array<[string, string]> = [];
    const proposal = propose({ env: editEnv(), packageRoot: sb.pkg });
    await proposal.apply({
      io: {
        rename: (from, to) => {
          renames.push([from, to]);
          renameSync(from, to);
        },
      },
    });
    for (const name of SKILLS) {
      const to = join(sb.ocDir, 'skills', name, 'SKILL.md');
      const hit = renames.find(([, t]) => t === to);
      expect(hit, name).toBeDefined();
      expect(dirname(hit![0])).toBe(dirname(to));
      expect(basename(hit![0])).not.toBe('SKILL.md');
    }
  });

  it('does not touch the plugin array on disk', async () => {
    const text = '{\n  "plugin": [ "x@1" ,"y@2" ],\n  "mcp": {}\n}\n';
    writeFile(configPath(), text);
    await propose({ env: editEnv(), packageRoot: sb.pkg }).apply();
    expect(read(configPath())).toContain('"plugin": [ "x@1" ,"y@2" ],');
  });
});

describe('shipped bundle (lib/scripts/install.js) + install.sh', () => {
  const bundle = join(PKG_ROOT, 'lib', 'scripts', 'install.js');
  const built = existsSync(bundle);

  it.skipIf(!built)('imports only node: builtins (jsonc-parser is inlined)', () => {
    const text = read(bundle);
    const specs = [...text.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual([]);
    expect(text).not.toMatch(/from\s+['"]jsonc-parser['"]/);
  });

  it.skipIf(!built || process.platform === 'win32')(
    'runs from a package copy with no node_modules: preview, then CT_INSTALL_EDIT=1',
    () => {
      // The sandbox package lives under the OS temp dir: no node_modules in
      // any ancestor, so a leftover bare import would fail to resolve.
      copyFileSync(bundle, join(sb.pkg, 'lib', 'scripts', 'install.js'));
      copyFileSync(join(PKG_ROOT, 'scripts', 'install.sh'), join(sb.pkg, 'scripts', 'install.sh'));
      const sh = join(sb.pkg, 'scripts', 'install.sh');
      const env = { ...sb.env };
      const before = treeSnapshot(sb.ocDir);
      const preview = spawnSync('bash', [sh], { env, encoding: 'utf8' });
      expect(preview.status, preview.stderr).toBe(0);
      expect(preview.stdout).toMatch(/PREVIEW/);
      expect(preview.stdout).toContain('CT_INSTALL_EDIT=1');
      expect(treeSnapshot(sb.ocDir)).toEqual(before);
      expect(existsSync(sb.payloadDir)).toBe(false);

      const apply = spawnSync('bash', [sh], { env: { ...env, CT_INSTALL_EDIT: '1' }, encoding: 'utf8' });
      expect(apply.status, apply.stderr + apply.stdout).toBe(0);
      expect(parse(read(configPath())).mcp['curated-thoughts'].command).toEqual(['curated-thoughts-mcp', '--mcp']);
      expect(existsSync(join(sb.payloadDir, 'lib', 'scripts', 'install.js'))).toBe(true);
      expect(read(sb.loaderPath)).toContain(sb.payloadDir);

      const usage = spawnSync('bash', [sh, '--nope'], { env, encoding: 'utf8' });
      expect(usage.status).toBe(2);
    },
  );
});

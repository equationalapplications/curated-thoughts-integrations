/**
 * install_sandbox.ts — shared fixtures for the registration/install tests.
 *
 * Every sandbox is a fresh temp tree:
 *
 *   <root>/home         HOME
 *   <root>/config       XDG_CONFIG_HOME   (OpenCode config → <config>/opencode)
 *   <root>/data         XDG_DATA_HOME     (payload → <data>/curated-thoughts/opencode)
 *   <root>/pkg          a fake package root (the thing install.js belongs to)
 *
 * Tests pass `sandbox.env` explicitly AND point process.env at the sandbox, so
 * nothing can reach the real ~/.config/opencode even through a default.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_SKILLS = join(PKG_ROOT, 'tests', 'host', 'fixtures', 'skills');
export const SKILLS = ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar'];

export interface Sandbox {
  root: string;
  home: string;
  configHome: string;
  dataHome: string;
  pkg: string;
  /** <configHome>/opencode */
  ocDir: string;
  payloadDir: string;
  loaderPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A package root with the payload copy set and the three fixture skills. */
export function makePackage(pkg: string, marker = 'v1'): void {
  writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@equational-applications/opencode-curated-thoughts', version: '0.1.0' }, null, 2),
  );
  writeFile(join(pkg, 'lib', 'src', 'index.js'), `export const CuratedThoughts = '${marker}';\n`);
  writeFile(join(pkg, 'lib', 'scripts', 'ct_env.js'), '// stub\n');
  writeFile(join(pkg, 'scripts', 'install.sh'), '#!/usr/bin/env bash\n');
  copyFileSync(join(PKG_ROOT, 'scripts', 'loader.js.tmpl'), join(pkg, 'scripts', 'loader.js.tmpl'));
  for (const name of SKILLS) {
    writeFile(
      join(pkg, 'skills', name, 'SKILL.md'),
      readFileSync(join(FIXTURE_SKILLS, name, 'SKILL.md'), 'utf8'),
    );
  }
}

export function makeSandbox(opts: { brainDir?: string } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'ct-oc-install-'));
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  const pkg = join(root, 'pkg');
  for (const d of [home, configHome, dataHome]) mkdirSync(d, { recursive: true });
  makePackage(pkg);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    CURATED_BRAIN_DIR: opts.brainDir ?? '/tmp/brain',
    PATH: process.env.PATH,
  };
  const ocDir = join(configHome, 'opencode');
  return {
    root,
    home,
    configHome,
    dataHome,
    pkg,
    ocDir,
    payloadDir: join(dataHome, 'curated-thoughts', 'opencode'),
    loaderPath: join(ocDir, 'plugins', 'curated-thoughts.js'),
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Point process.env at the sandbox for the duration of a test. */
export function isolateProcessEnv(sb: Sandbox): () => void {
  const original = process.env;
  process.env = { ...original, ...sb.env };
  delete process.env.OPENCODE_CONFIG;
  delete process.env.CT_INSTALL_EDIT;
  return () => {
    process.env = original;
  };
}

/** path → type + content hash + mtime, for "nothing was mutated" assertions. */
export function treeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        out[p] = `link:${readlinkSync(p)}`;
      } else if (st.isDirectory()) {
        out[p] = 'dir';
        walk(p);
      } else {
        const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
        out[p] = `file:${hash}:${st.mtimeMs}`;
      }
    }
  };
  walk(root);
  return out;
}

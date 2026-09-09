/**
 * test_build_output.ts — regression gate for the package's compiled layout.
 *
 * Guards the contract between tsconfig.json and package.json: the build must
 * emit `lib/src/*` and `lib/scripts/*` (rootDir = package root), and every
 * `main` / `exports` target must exist on disk after `pnpm run build`. A
 * stale flat layout (lib/index.js, lib/ct_doctor.js) from an earlier config
 * must never come back.
 *
 * Skipped gracefully when `lib/` has not been built yet (e.g. a fresh clone
 * running `pnpm test` before `pnpm run build`).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const LIB = join(PKG_ROOT, 'lib');

const built = existsSync(join(LIB, 'src', 'index.js'));

describe.skipIf(!built)('build output layout', () => {
  it('emits lib/src/index.js and lib/scripts/ct_doctor.js', () => {
    expect(existsSync(join(LIB, 'src', 'index.js'))).toBe(true);
    expect(existsSync(join(LIB, 'scripts', 'ct_doctor.js'))).toBe(true);
  });

  it('does not emit the stale flat-layout files (lib/index.js, lib/ct_doctor.js)', () => {
    expect(existsSync(join(LIB, 'index.js'))).toBe(false);
    expect(existsSync(join(LIB, 'ct_doctor.js'))).toBe(false);
  });

  it('package.json main and every exports target exists on disk', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      main: string;
      exports: Record<string, string>;
    };
    expect(pkg.main).toBe('lib/src/index.js');
    // exports targets are written with a leading './'; normalize to bare
    // package-relative paths so they can be checked against lib/.
    const targets = [
      pkg.main,
      ...Object.values(pkg.exports ?? {}).map((t) => t.replace(/^\.\//, '')),
    ];
    expect(targets).toContain('lib/src/index.js');
    expect(targets).toContain('lib/scripts/ct_doctor.js');
    for (const t of targets) {
      expect(existsSync(join(PKG_ROOT, t)), `missing built file: ${t}`).toBe(true);
    }
  });

  it('lib/src/index.js imports without throwing', async () => {
    const mod = await import(pathToFileURL(join(LIB, 'src', 'index.js')).href);
    expect(typeof mod.apply).toBe('function');
  });

  it('production SKILLS_ROOT resolves to the shipped skills directory', async () => {
    const mod = await import(pathToFileURL(join(LIB, 'src', 'index.js')).href);
    const root: string = mod.SKILLS_ROOT;
    expect(statSync(root).isDirectory()).toBe(true);
    for (const name of [
      'curated-thoughts-usage',
      'curated-thoughts-ops',
      'curated-thoughts-sidecar',
    ]) {
      expect(
        existsSync(join(root, name, 'SKILL.md')),
        `missing skill: ${join(root, name, 'SKILL.md')}`,
      ).toBe(true);
    }
  });
});

describe('skill resolution from source (no build required)', () => {
  it('src/index.ts SKILLS_ROOT also resolves to the shipped skills', async () => {
    const mod = await import('../src/index.js');
    const root: string = mod.SKILLS_ROOT;
    expect(statSync(root).isDirectory()).toBe(true);
    expect(existsSync(join(root, 'curated-thoughts-usage', 'SKILL.md'))).toBe(true);
  });
});

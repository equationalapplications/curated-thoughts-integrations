/**
 * test_runtime_imports.ts — the plugin payload ships without node_modules/,
 * so nothing on the runtime path may import a third-party module. Node
 * builtins (`node:*`) and relative modules only. `@opencode-ai/plugin` is
 * allowed as `import type` in source, which tsc erases.
 *
 * The lib/ half is skipped until `pnpm run build` has produced lib/src/index.js.
 *
 * One exception, in SOURCE only: the workspace-internal shared core
 * `@equational-applications/ct-wisdom-core` (a `file:` dep). The build
 * (scripts/vendor_core.mjs) copies its compiled lib into lib/ct-wisdom-core/
 * and rewrites the specifier to a relative path — the same staging release.yml
 * performs — so the SHIPPED payload still carries no bare specifier at all.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Runtime (non-type) import/export-from specifiers and dynamic imports.
const SPECIFIER_RE =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER_RE)) out.push((m[1] ?? m[2])!);
  return out;
}

const VENDORED_CORE = '@equational-applications/ct-wisdom-core';

function isAllowed(spec: string): boolean {
  return spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
}

/** Source-only: the vendored core is the single permitted bare specifier. */
function isAllowedInSource(spec: string): boolean {
  return isAllowed(spec) || spec === VENDORED_CORE;
}

function filesIn(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !f.endsWith('.d.ts'))
    .map((f) => join(dir, f));
}

describe('runtime imports', () => {
  it('the extractor sees type-only imports as erased', () => {
    expect(runtimeSpecifiers("import type { Plugin } from '@opencode-ai/plugin';")).toEqual([]);
    expect(runtimeSpecifiers("import { x } from 'left-pad';")).toEqual(['left-pad']);
    expect(runtimeSpecifiers("export { y } from './y.js';")).toEqual(['./y.js']);
  });

  it('src/*.ts has only node: and relative runtime imports', () => {
    const files = [...filesIn(join(PKG_ROOT, 'src'), '.ts'), ...filesIn(join(PKG_ROOT, 'src', 'wisdom-live'), '.ts')];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bad = runtimeSpecifiers(readFileSync(f, 'utf8')).filter((s) => !isAllowedInSource(s));
      expect(bad, f).toEqual([]);
    }
  });

  it('the source exception is exactly one specifier', () => {
    expect(isAllowedInSource(VENDORED_CORE)).toBe(true);
    expect(isAllowedInSource('@equational-applications/ct-wisdom-core/lib/index.js')).toBe(false);
    expect(isAllowedInSource('@equational-applications/other')).toBe(false);
    expect(isAllowedInSource('left-pad')).toBe(false);
  });

  const built = existsSync(join(PKG_ROOT, 'lib', 'src', 'index.js'));
  it.skipIf(!built)('lib/src/*.js (the shipped payload) imports no third-party module', () => {
    // The plugin entry and everything it pulls in: lib/src/* plus ct_env.
    const files = [
      ...filesIn(join(PKG_ROOT, 'lib', 'src'), '.js'),
      ...filesIn(join(PKG_ROOT, 'lib', 'src', 'wisdom-live'), '.js'),
      join(PKG_ROOT, 'lib', 'scripts', 'ct_env.js'),
    ];
    let referencesCore = false;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // Any quoted reference to the SDK as a module specifier (comments aside).
      expect(text, f).not.toMatch(/['"]@opencode-ai\/plugin['"]/);
      // The vendored core must have been rewritten to a relative specifier.
      expect(text, f).not.toMatch(/['"]@equational-applications\/ct-wisdom-core['"]/);
      const specs = runtimeSpecifiers(text);
      const bad = specs.filter((s) => !isAllowed(s));
      expect(bad, f).toEqual([]);
      // Every relative runtime import resolves to a file that actually ships.
      for (const s of specs.filter((x) => !x.startsWith('node:'))) {
        expect(existsSync(resolve(dirname(f), s)), `${f} -> ${s}`).toBe(true);
        if (s.includes('ct-wisdom-core/')) referencesCore = true;
      }
    }
    // src imports the shared core, so the built payload must reach the vendored copy.
    expect(referencesCore).toBe(true);
    expect(existsSync(join(PKG_ROOT, 'lib', 'ct-wisdom-core', 'index.js'))).toBe(true);
  });
});

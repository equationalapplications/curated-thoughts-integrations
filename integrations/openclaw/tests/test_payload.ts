/**
 * The built payload is self-contained (scripts/vendor_core.mjs, ported from
 * the opencode leg): lib/ carries the shared core at lib/ct-wisdom-core and no
 * emitted .js keeps the bare `@equational-applications/ct-wisdom-core`
 * specifier, so the plugin loads from a copy WITHOUT node_modules — the shape
 * install.sh stages and the release archive ships (release.yml also stages
 * lib/ct-wisdom-core). OpenClaw may repair or rebuild a plugin's
 * dependencies; nothing here depends on that tree surviving.
 */

import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');
const built = existsSync(join(LIB, 'src', 'index.js'));
const BARE = /['"]@equational-applications\/ct-wisdom-core['"]/;

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe.skipIf(!built)('self-contained payload (vendored ct-wisdom-core)', () => {
  it('vendors the core into lib/ct-wisdom-core', () => {
    expect(existsSync(join(LIB, 'ct-wisdom-core', 'index.js'))).toBe(true);
  });

  it('leaves no bare core specifier in any emitted .js', () => {
    const offenders = jsFiles(LIB)
      .filter((f) => !f.startsWith(join(LIB, 'ct-wisdom-core')))
      .filter((f) => BARE.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('loads and registers from a copy with no node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-payload-'));
    try {
      cpSync(LIB, join(dir, 'lib'), { recursive: true });
      cpSync(join(ROOT, 'openclaw.plugin.json'), join(dir, 'openclaw.plugin.json'));
      cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
      expect(existsSync(join(dir, 'node_modules'))).toBe(false);
      const mod = await import(pathToFileURL(join(dir, 'lib', 'src', 'index.js')).href);
      const hooks: string[] = [];
      mod.default.register({
        id: 'curated-thoughts',
        on: (name: string) => hooks.push(name),
        registerAgentToolResultMiddleware: () => {},
      });
      expect(hooks).toEqual(['agent_turn_prepare', 'before_prompt_build']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

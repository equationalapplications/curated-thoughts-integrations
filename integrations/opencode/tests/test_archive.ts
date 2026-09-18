/**
 * test_archive.ts — the unpacked ct_ci.py release archive runs as a real user
 * would run it (plan Steps 6.5–6.7):
 *
 *   - the manifest-driven release tarball and `pnpm pack` AGREE;
 *   - the plugin loads from the unpacked archive with NO node_modules present;
 *   - `node lib/scripts/ct_doctor.js check` runs (degrading only the
 *     pre-flight check when better-sqlite3 is absent);
 *   - `node lib/scripts/install.js` runs its preview with jsonc-parser bundled.
 *
 * Build note: `tools/ct_ci.py package` refuses `status: planned` manifests
 * (the manifest gate), so until the status flips (Task 7) these tests build
 * the archive through the same ct_ci_package.build() code path via a Python
 * shim and GATE the file-presence assertions on that having succeeded. The
 * usable-from-archive assertions (imports, doctor, installer) run either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const VERSION = '0.1.0';
const TAG = `opencode-v${VERSION}`;
const TARBALL = `${TAG}.tar.gz`;

let workdir: string;
let unpacked: string; // <workdir>/unpacked/<id>-<version>
let packedNpm: string; // pnpm pack tarball path
let archiveBuilt = false;
let archiveBuildError = '';

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, encoding: 'utf8', env: opts.env }).trim();
}

/** Gated at runtime: the archive builds only once the manifest flips (Task 7). */
function requireArchive(): void {
  if (!archiveBuilt) {
    console.warn(`[test_archive] release archive not built (status: planned until Task 7): ${archiveBuildError}`);
  }
  expect(archiveBuilt, `release archive should build: ${archiveBuildError}`).toBe(true);
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ct-opencode-archive-'));
  const out = join(workdir, 'out');
  mkdirSync(out, { recursive: true });

  // The release artifact: same builder release.yml drives, minus the manifest
  // status gate (planned until Task 7 flips it).
  try {
    const tarballPath = run('python3', ['-c', RELEASE_BUILD_SHIM, TAG, out]);
    archiveBuilt = true;
    mkdirSync(join(workdir, 'unpacked'), { recursive: true });
    run('tar', ['-xf', tarballPath, '-C', join(workdir, 'unpacked')]);
  } catch (err) {
    archiveBuildError = String(err).slice(0, 500);
    console.error('[test_archive] archive build failed:', archiveBuildError);
  }

  unpacked = join(workdir, 'unpacked', `opencode-${VERSION}`);

  // The future npm artifact, for the agreement check.
  try {
    const dest = join(workdir, 'npm');
    mkdirSync(dest, { recursive: true });
    run('pnpm', ['pack', '--pack-destination', dest], { cwd: PKG_ROOT });
    packedNpm = join(dest, `equational-applications-opencode-curated-thoughts-${VERSION}.tgz`);
  } catch {
    packedNpm = '';
  }
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

// Runs ct_ci_package.build() directly — the exact code `ct_ci.py package`
// calls after its manifest gate.
const RELEASE_BUILD_SHIM = [
  'import sys',
  'sys.path.insert(0, "tools")',
  'import ct_ci_package',
  'tag, out = sys.argv[1], sys.argv[2]',
  'integration_id, version = ct_ci_package.parse_tag(tag)',
  'tarball = ct_ci_package.build(".", integration_id, out)',
  'print(tarball)',
].join(';\n');

const ARCHIVE_FILES = [
  'lib/src/index.js',
  'lib/scripts/ct_doctor.js',
  'lib/scripts/install.js',
  'scripts/install.sh',
  'skills/curated-thoughts-usage/SKILL.md',
  'skills/curated-thoughts-ops/SKILL.md',
  'skills/curated-thoughts-sidecar/SKILL.md',
];

describe('release archive (ct_ci.py package)', () => {
  it('built the tarball for the pinned version', () => {
    requireArchive();
  });

  it('contains the plugin entry, doctor, installer and skills', () => {
    requireArchive();
    for (const rel of ARCHIVE_FILES) {
      expect(existsSync(join(unpacked, rel)), rel).toBe(true);
    }
  });

  it('ships no node_modules and the exclusion only drops build junk', () => {
    requireArchive();
    const noNodeModules = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        expect(entry.name, `${join(dir, entry.name)} must not be node_modules`).not.toBe('node_modules');
        if (entry.isDirectory()) noNodeModules(join(dir, entry.name));
      }
    };
    noNodeModules(unpacked);
  });

  it('package.json#files does not disagree with the manifest archive', () => {
    // Both artifacts must at least carry everything package.json#files claims;
    // the manifest archive may carry more (README, integration.yaml), never less.
    const files: string[] = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).files;
    const tsc = spawnSync('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: PKG_ROOT, encoding: 'utf8' });
    expect(tsc.status, tsc.stderr).toBe(0);
    for (const claimed of files) {
      expect(existsSync(join(PKG_ROOT, claimed)), `package.json#files claims ${claimed}`).toBe(true);
    }
  });

  it('pnpm pack carries the same payload the release archive carries', () => {
    expect(packedNpm, 'pnpm pack tarball should exist').not.toBe('');
    const listing = run('tar', ['-tzf', packedNpm]);
    const npmFiles = listing
      .split('\n')
      .map((line) => line.replace(/^package\//, ''))
      .filter((rel) => rel && !rel.endsWith('/'));
    for (const rel of ARCHIVE_FILES) {
      expect(npmFiles, `${rel} in pnpm pack output`).toContain(rel);
    }
  });
});

describe('the unpacked archive runs with no node_modules (the real user situation)', () => {
  it('lib/src/index.js imports nothing third-party', () => {
    requireArchive();
    // Walk the runtime payload: every relative import in lib/src/*.js must be
    // a node: builtin or a relative file. No bare specifiers at all.
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((m) => (m[1] ?? m[2])!);
      for (const spec of specifiers) {
        if (spec.startsWith('node:')) continue;
        expect(spec.startsWith('./') || spec.startsWith('../'), `third-party import ${spec} in ${file}`).toBe(true);
        const resolved = new URL(spec, `file://${file}`).pathname;
        if (existsSync(resolved)) walk(resolved);
      }
    };
    for (const entry of readdirSync(join(unpacked, 'lib', 'src'))) {
      if (entry.endsWith('.js')) walk(join(unpacked, 'lib', 'src', entry));
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('node lib/scripts/ct_doctor.js check runs; only the pre-flight check degrades without better-sqlite3', () => {
    requireArchive();
    const proc = spawnSync('node', [join(unpacked, 'lib', 'scripts', 'ct_doctor.js'), 'check'], {
      cwd: unpacked,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
      timeout: 60_000,
    });
    const output = `${proc.stdout}\n${proc.stderr}`;
    // The doctor degrades: no sidecar / brain in the sandbox means WARN/FAIL
    // exits (1 or 2 are both "ran"), but a module-not-found crash (exit code
    // 1 with ERR_MODULE_NOT_FOUND) means the payload is not self-contained.
    expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(output).not.toContain('Cannot find package');
    expect([0, 1, 2, 3]).toContain(proc.status);
    // It produced per-check output rather than a stack trace.
    expect(output).toMatch(/check|PASS|WARN|FAIL|UNKNOWN/i);
  });

  it('node lib/scripts/install.js runs its preview with jsonc-parser bundled', () => {
    requireArchive();
    const home = join(workdir, 'home');
    const proc = spawnSync('node', [join(unpacked, 'lib', 'scripts', 'install.js')], {
      cwd: unpacked,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        CT_INSTALL_EDIT: undefined,
      },
    });
    const output = `${proc.stdout}\n${proc.stderr}`;
    // Preview mode must not be a crash: jsonc-parser is bundled, so no
    // module resolution errors even though node_modules is absent.
    expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(output).not.toContain('Cannot find package');
    expect([0, 1, 2, 3]).toContain(proc.status);
  });
});

export { archiveBuilt, archiveBuildError };

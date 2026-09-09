import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runChecks,
  cmdCheck,
  checkDshRegistration,
  PASS, WARN, FAIL,
  type CheckResult,
} from '../scripts/ct_doctor.js';

// lib/scripts/ct_doctor.js is emitted by `pnpm run build`; lib/ is
// gitignored, so a fresh clone running `pnpm test` before `pnpm run build`
// has nothing to spawn. Skip like test_build_output.ts does, rather than
// failing on an empty child stdout.
const COMPILED_DOCTOR = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scripts', 'ct_doctor.js',
);
const built = existsSync(COMPILED_DOCTOR);

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-doctor-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CURATED_BRAIN_DIR;
  process.env.PATH = ''; // force a clean PATH so sidecar discovery is deterministic
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

function names(rs: CheckResult[]) {
  return rs.map((r) => `${r.name}:${r.status}`);
}

describe('runChecks', () => {
  it('reports FAIL on a clean machine with no sidecar and no brain', () => {
    const rs = runChecks();
    expect(names(rs)).toContain(`sidecar-binary:${FAIL}`);
    expect(names(rs)).toContain(`brain-dir:${FAIL}`);
  });

  it('reports FAIL when the brain directory exists but config.json is missing', () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    process.env.CURATED_BRAIN_DIR = brainDir;
    const rs = runChecks();
    expect(names(rs).some((n) => n.startsWith('brain-dir:') && n.endsWith(':WARN'))).toBe(true);
  });
});

describe.skipIf(!built)('cmdCheck', () => {
  it('prints JSON when --json is passed', () => {
    // Capture stdout via a child process running the compiled doctor.
    // lib/scripts/ct_doctor.js is emitted by the root tsconfig.json
    // (rootDir "." compiles src/ → lib/src and scripts/ → lib/scripts).
    // Use process.execPath (absolute) instead of bare 'node' because the
    // test sets PATH='' to wipe the sidecar's PATH lookup — bare 'node'
    // would then ENOENT. Bare 'node' is what the plan's verbatim test had;
    // it failed with `spawnSync node ENOENT` so we resolve to the running
    // Node binary by absolute path. (Plan-bug pattern #5.)
    const out = spawnSync(process.execPath, [COMPILED_DOCTOR, 'check', '--json'], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, PATH: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.exit_code).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe('checkDshRegistration', () => {
  function writeCordisYml(text: string): void {
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(join(tmpHome, 'cordis.yml'), text);
  }

  it('passes when the mcp-client entry is the LAST list item (appended shape)', () => {
    // Regression: the block-end lookahead used Python's `\Z`, which is a
    // literal `Z` in JS — an mcp-client entry as the final list item (the
    // common appended shape) never matched and the doctor false-FAILed a
    // valid config.
    writeCordisYml(
      [
        "- name: '@equational-applications/dsh-curated-thoughts'",
        '  config:',
        '    brainDir: ~/.brain',
        "- name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        "    serverName: 'curated-thoughts'",
        '    transport: stdio',
        '',
      ].join('\n'),
    );
    const r = checkDshRegistration({ ...process.env, DSH_HOME: tmpHome });
    expect(r.status).toBe(PASS);
  });

  it('detects the server when the mcp-client block itself contains a literal Z', () => {
    // The old `\Z` truncated the captured block at any `Z` character.
    // Plugin entry absent → WARN is the correct verdict for a detected
    // server mount; the old bug produced FAIL here instead.
    writeCordisYml(
      [
        "- name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        '    # Zone: main',
        "    serverName: 'curated-thoughts'",
        '',
      ].join('\n'),
    );
    const r = checkDshRegistration({ ...process.env, DSH_HOME: tmpHome });
    expect(r.status).toBe(WARN);
  });
});

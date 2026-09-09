import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runChecks,
  cmdCheck,
  PASS, WARN, FAIL,
  type CheckResult,
} from '../scripts/ct_doctor.js';

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

describe('cmdCheck', () => {
  it('prints JSON when --json is passed', () => {
    // Capture stdout via a child process running the compiled doctor.
    // lib/ct_doctor.js is built by scripts/tsconfig.json in Task 2.5.
    // Use process.execPath (absolute) instead of bare 'node' because the
    // test sets PATH='' to wipe the sidecar's PATH lookup — bare 'node'
    // would then ENOENT. Bare 'node' is what the plan's verbatim test had;
    // it failed with `spawnSync node ENOENT` so we resolve to the running
    // Node binary by absolute path. (Plan-bug pattern #5.)
    const out = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'lib', 'ct_doctor.js'), 'check', '--json'], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, PATH: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.exit_code).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

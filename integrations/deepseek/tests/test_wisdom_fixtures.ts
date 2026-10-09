import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeIdentity, recallWiki } from '../src/wisdom.js';

// POSIX-only REAL-executable fixtures — NO module mocks anywhere in this file
// (M2 cycle 3: vi.mock is file-wide-hoisted and would poison these real spawns).
const isWin = process.platform === 'win32';

function makeScript(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function makeNonExec(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  // deliberately NOT chmod +x
  return p;
}

describe.skipIf(isWin)('probeIdentity — real executable fixtures (POSIX)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("identifies the real ct via '#!/bin/sh' + printf identity line", () => {
    dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
    const ct = makeScript(dir, 'ct', "printf 'ct — headless CLI for Curated Thoughts brains\\n'");
    expect(probeIdentity(ct)).toBe('ok');
  });

  it("rejects a similarly-named imposter ('chart-testing')", () => {
    dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
    const ct = makeScript(dir, 'ct', "printf 'chart-testing'");
    expect(probeIdentity(ct)).toBe('reject');
  });

  it(
    'SIGKILLs a hung ct and still returns within the probe budget (wall time < 10 s)',
    { timeout: 15_000 },
    () => {
      dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
      // `exec` replaces the shell so the kill reaps everything — plain `sleep`
      // forks a child that inherits the pipes and keeps spawnSync blocked
      // ~30 s even after the shell is SIGKILLed (M1 cycle 3).
      const ct = makeScript(dir, 'ct', 'exec sleep 30');
      const start = Date.now();
      expect(probeIdentity(ct)).toBe('timeout');
      expect(Date.now() - start).toBeLessThan(10_000);
    },
  );

  it('a non-executable sleep fixture classifies as reject, not timeout (regression color)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
    const p = makeNonExec(dir, 'ct', 'sleep 30');
    const start = Date.now();
    expect(probeIdentity(p)).toBe('reject');
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe.skipIf(isWin)('recallWiki — real executable fixtures (POSIX, no module mocks)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a real ct printing wiki JSON yields real entries', () => {
    dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
    const ct = makeScript(dir, 'ct', `printf '{"wiki":[{"id":"f1","title":"T","text":"b"}]}'`);
    expect(recallWiki(ct, 'q')).toEqual({ entries: [{ title: 'T', text: 'b', id: 'f1' }], failure: null });
  });

  it('v1 amendment: an entry without a valid id is DROPPED (it cannot be deduped)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
    const ct = makeScript(
      dir,
      'ct',
      `printf '{"wiki":[{"title":"NoId","text":"x"},{"id":"","title":"Empty","text":"y"}]}'`,
    );
    expect(recallWiki(ct, 'q')).toEqual({ entries: [], failure: null });
  });

  it('a real ct printing garbage yields the parse-error class', () => {
    dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
    const ct = makeScript(dir, 'ct', "printf 'garbage not json'");
    expect(recallWiki(ct, 'q')).toEqual({ entries: null, failure: null });
  });

  it(
    'a hung real ct (exec sleep 30) is SIGKILLed → timeout class in < 10 s wall',
    { timeout: 15_000 },
    () => {
      dir = mkdtempSync(join(tmpdir(), 'ct-wisdom-fixture-'));
      const ct = makeScript(dir, 'ct', 'exec sleep 30');
      const start = Date.now();
      expect(recallWiki(ct, 'q')).toEqual({ entries: null, failure: 'timeout' });
      expect(Date.now() - start).toBeLessThan(10_000);
    },
  );
});

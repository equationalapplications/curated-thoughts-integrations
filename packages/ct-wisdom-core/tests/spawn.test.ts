/**
 * spawn.test.ts — the shared Node spawn binding (spec
 * 2026-10-17-core-spawn-binding-and-cancel-design.md). Ported from the
 * deepseek adapter suite (PR #71 review fixes) and the openclaw spawn suite
 * (multi-byte decoding), plus a platform-neutral settle test.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_KILL_GRACE_MS, nodeSpawnFn, spawnOutcomeOf, windowsTreeKill } from '../src/spawn.js';

describe('nodeSpawnFn (real binding, fake binary)', { timeout: 30_000 }, () => {
  it.skipIf(process.platform === 'win32')('passes the argument LIST to a shell-less spawn and captures stdout', async () => {
    // POSIX-only: needs /bin/sh for the shebang script.
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-fn-'));
    const script = join(dir, 'fake-ct');
    writeFileSync(script, '#!/bin/sh\nprintf \'{"ok": true}\'\n');
    chmodSync(script, 0o755);
    try {
      const out = await nodeSpawnFn()({
        command: script,
        args: ['wisdom', 'match', '--query', 'hello world; rm -rf /'],
        timeoutMs: 3000,
      });
      expect(out.spawnError).toBe(false);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('{"ok": true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('times out a hung binary inside the budget and reports timedOut', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-fn-'));
    const script = join(dir, 'hung-ct');
    writeFileSync(script, '#!/bin/sh\nsleep 30\n');
    chmodSync(script, 0o755);
    try {
      const out = await nodeSpawnFn()({
        command: script,
        args: [],
        timeoutMs: 200,
      });
      expect(out.timedOut).toBe(true);
      expect(out.code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('nodeSpawnFn abort (real process tree)', { timeout: 30_000 }, () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  };

  /** A fake ct whose `--help` exits 0 and whose match forks a grandchild and hangs. */
  async function hangingCt() {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-abort-'));
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'ct');
    writeFileSync(
      script,
      '#!/bin/sh\n'
        + 'case "$*" in *--help*) exit 0;; esac\n'
        + `sleep 30 &\necho $! > '${pidFile}'\nwait\n`,
    );
    chmodSync(script, 0o755);
    const grandchild = async (): Promise<number> => {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 5000);
      return Number(readFileSync(pidFile, 'utf8').trim());
    };
    return { script, grandchild, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * Windows fake ct: node.exe runs a script that starts a sleeping node
   * grandchild, writes its pid, and hangs. The grandchild is DETACHED: libuv
   * puts a non-detached child in its parent's job object (kill on job close),
   * so it would die with the fake ct even under the old direct kill. Detached,
   * it sits outside that job and only taskkill's parent-pid walk (/T) reaches it.
   * The negative control below is what proves this on the runner: with taskkill
   * skipped, the grandchild must survive the direct kill.
   */
  async function hangingCtWin() {
    const { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-win-'));
    const pidFile = join(dir, 'grandchild.pid');
    const selfFile = join(dir, 'child.pid');
    const script = join(dir, 'ct.cjs');
    writeFileSync(
      script,
      "const { spawn } = require('child_process');\n"
        + "const fs = require('fs');\n"
        + `fs.writeFileSync(${JSON.stringify(selfFile)}, String(process.pid));\n`
        + "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true, detached: true });\n"
        + 'g.unref();\n'
        + `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n`
        + 'setTimeout(() => {}, 30000);\n',
    );
    const grandchild = async (): Promise<number> => {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 10_000);
      return Number(readFileSync(pidFile, 'utf8').trim());
    };
    const child = async (): Promise<number> => {
      await waitFor(() => existsSync(selfFile) && readFileSync(selfFile, 'utf8').trim() !== '', 10_000);
      return Number(readFileSync(selfFile, 'utf8').trim());
    };
    return { command: process.execPath, args: [script, 'wisdom', 'match'], grandchild, child, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it.runIf(process.platform === 'win32')('Windows: an abort kills the child AND its grandchild, and settles within the deadline', async () => {
    const ct = await hangingCtWin();
    try {
      const abort = new AbortController();
      const pending = nodeSpawnFn()({ command: ct.command, args: ct.args, timeoutMs: 30_000, signal: abort.signal });
      const gpid = await ct.grandchild();
      expect(alive(gpid)).toBe(true);
      const abortedAt = Date.now();
      abort.abort();
      const out = await pending;
      expect(out.aborted).toBe(true);
      expect(Date.now() - abortedAt).toBeLessThan(DEFAULT_KILL_GRACE_MS + 1500);
      expect(await waitFor(() => !alive(gpid), 5000)).toBe(true);
    } finally {
      ct.cleanup();
    }
  });

  it.runIf(process.platform === 'win32')('Windows: the timeout kills the grandchild too', async () => {
    const ct = await hangingCtWin();
    try {
      const pending = nodeSpawnFn()({ command: ct.command, args: ct.args, timeoutMs: 3000 });
      const gpid = await ct.grandchild();
      expect(alive(gpid)).toBe(true);
      const out = await pending;
      expect(out.timedOut).toBe(true);
      expect(await waitFor(() => !alive(gpid), 5000)).toBe(true);
    } finally {
      ct.cleanup();
    }
  });

  it.runIf(process.platform === 'win32')('Windows: with SystemRoot unusable, the direct-kill fallback still ends the child and the call settles', async () => {
    const ct = await hangingCtWin();
    const saved = process.env.SystemRoot;
    let gpid = 0;
    try {
      const abort = new AbortController();
      const pending = nodeSpawnFn()({ command: ct.command, args: ct.args, timeoutMs: 30_000, signal: abort.signal });
      gpid = await ct.grandchild();
      const cpid = await ct.child();
      expect(alive(cpid)).toBe(true);
      // Break SystemRoot only now: the child needs it to start, the kill reads it at kill time.
      process.env.SystemRoot = 'not-absolute';
      abort.abort();
      const out = await pending;
      expect(out.aborted).toBe(true);
      // The fallback's direct kill ended the child itself (review 2, m3).
      expect(await waitFor(() => !alive(cpid), 5000)).toBe(true);
      // Negative control: the direct kill must NOT reach the detached
      // grandchild (so the abort/timeout tests above prove /T, not the job).
      expect(alive(gpid)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
      // The fallback reaches only the child: end the orphaned grandchild here.
      if (gpid > 0 && alive(gpid)) process.kill(gpid);
      ct.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('an abort kills the child AND its grandchild and reports aborted', async () => {
    const ct = await hangingCt();
    try {
      const abort = new AbortController();
      const started = Date.now();
      const pending = nodeSpawnFn()({ command: ct.script, args: ['wisdom', 'match'], timeoutMs: 30_000, signal: abort.signal });
      const gpid = await ct.grandchild();
      expect(alive(gpid)).toBe(true);
      abort.abort();
      const out = await pending;
      expect(out.aborted).toBe(true);
      expect(out.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await waitFor(() => !alive(gpid), 3000)).toBe(true);
    } finally {
      ct.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('a run that ends normally is not aborted and leaves no abort listener behind', async () => {
    const { getEventListeners } = await import('node:events');
    const ct = await hangingCt();
    try {
      const abort = new AbortController();
      const pending = nodeSpawnFn()({ command: ct.script, args: ['--help'], timeoutMs: 3000, signal: abort.signal });
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(1);
      const out = await pending;
      expect(out.code).toBe(0);
      expect(out.aborted).toBeUndefined();
      expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0); // removed on 'close'
      abort.abort(); // a later abort is a no-op
    } finally {
      ct.cleanup();
    }
  });

  it('a binary that cannot start ends on the error path with no abort listener left', async () => {
    const { getEventListeners } = await import('node:events');
    const abort = new AbortController();
    const out = await nodeSpawnFn()({ command: '/nonexistent/ct-binary', args: [], timeoutMs: 3000, signal: abort.signal });
    expect(out.spawnError).toBe(true);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('the timeout kills the grandchild too (one kill path, PR #71 review)', async () => {
    const ct = await hangingCt();
    try {
      const pending = nodeSpawnFn()({ command: ct.script, args: ['wisdom', 'match'], timeoutMs: 2000 });
      const gpid = await ct.grandchild();
      expect(gpid).toBeGreaterThan(0);
      const out = await pending;
      expect(out.timedOut).toBe(true);
      expect(await waitFor(() => !alive(gpid), 3000)).toBe(true);
    } finally {
      ct.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('an already-aborted signal resolves aborted without spawning (PR #71 review)', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-pre-abort-'));
    const touched = join(dir, 'ran');
    const script = join(dir, 'ct');
    writeFileSync(script, `#!/bin/sh\ntouch '${touched}'\n`);
    chmodSync(script, 0o755);
    try {
      const abort = new AbortController();
      abort.abort();
      const out = await nodeSpawnFn()({ command: script, args: [], timeoutMs: 3000, signal: abort.signal });
      expect(out.aborted).toBe(true);
      expect(out.spawnError).toBe(false);
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(touched)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a binary that cannot start is a spawn error, not an abort, even if the abort lands first (PR #71 review)', async () => {
    const abort = new AbortController();
    const pending = nodeSpawnFn()({ command: '/nonexistent/ct-binary', args: [], timeoutMs: 3000, signal: abort.signal });
    abort.abort(); // before the async ENOENT 'error' event
    const out = await pending;
    expect(out.spawnError).toBe(true);
    expect(out.aborted).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('an abort after the child already exited reports the real result, not aborted (PR #71 review)', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-exited-'));
    let stray = 0;
    const script = join(dir, 'ct');
    // Exits 0 at once, but a background grandchild keeps stdout open, so
    // 'close' has not fired yet when the abort lands.
    const exiting = join(dir, 'exiting');
    const strayPid = join(dir, 'stray.pid');
    writeFileSync(script, `#!/bin/sh\nprintf '{"entries": []}'\nsleep 30 &\necho $! > '${strayPid}'\ntouch '${exiting}'\nexit 0\n`);
    chmodSync(script, 0o755);
    try {
      const abort = new AbortController();
      const started = Date.now();
      // A long grace keeps the run unsettled after exit, so the abort lands
      // between exit and settle (the grace now starts at any exit).
      const pending = nodeSpawnFn(process.env, { killGraceMs: 3000 })({ command: script, args: [], timeoutMs: 30_000, signal: abort.signal });
      const end = Date.now() + 10_000;
      while (!existsSync(exiting) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 300)); // the child's exit is reaped
      abort.abort();
      const out = await pending;
      expect(out.aborted).toBeUndefined();
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('{"entries": []}');
      expect(Date.now() - started).toBeLessThan(20_000); // settled by the grace, not the straggler or the timeout
      // The leader was already reaped: nothing is signalled (no -pid of a
      // reaped leader), so the straggler is still alive.
      stray = Number(readFileSync(strayPid, 'utf8').trim());
      expect(alive(stray)).toBe(true);
    } finally {
      try { if (stray > 0) process.kill(stray, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('a child that exits normally while a straggler holds stdout settles within the grace, not the timeout (PR #76 review)', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-exit-grace-'));
    const strayPid = join(dir, 'stray.pid');
    const script = join(dir, 'ct');
    // Exits 0 at once; the background sleep inherits stdout, so 'close' waits on it.
    writeFileSync(script, `#!/bin/sh\nprintf '{"entries": []}'\nsleep 30 &\necho $! > '${strayPid}'\nexit 0\n`);
    chmodSync(script, 0o755);
    let stray = 0;
    try {
      const started = Date.now();
      const out = await nodeSpawnFn(process.env, { killGraceMs: 250 })({ command: script, args: [], timeoutMs: 5000 });
      const elapsed = Date.now() - started;
      if (existsSync(strayPid)) stray = Number(readFileSync(strayPid, 'utf8').trim());
      expect(elapsed).toBeLessThan(250 + 1500);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('{"entries": []}');
      expect(out.spawnError).toBe(false);
      expect(out.timedOut).toBe(false);
      expect(out.aborted).toBeUndefined();
    } finally {
      try { if (stray > 0) process.kill(stray, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('a timeout that fires during the post-exit grace does not change the outcome (PR #76 review)', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-late-timer-'));
    const strayPid = join(dir, 'stray.pid');
    const script = join(dir, 'ct');
    writeFileSync(script, `#!/bin/sh\nprintf 'ok'\nsleep 30 &\necho $! > '${strayPid}'\nexit 0\n`);
    chmodSync(script, 0o755);
    let stray = 0;
    try {
      // The child exits at once; the 1000 ms timer (room for a slow `sh`
      // start) fires inside the 2000 ms grace.
      const out = await nodeSpawnFn(process.env, { killGraceMs: 2000 })({ command: script, args: [], timeoutMs: 1000 });
      if (existsSync(strayPid)) stray = Number(readFileSync(strayPid, 'utf8').trim());
      expect(out.timedOut).toBe(false);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('ok');
      expect(out.aborted).toBeUndefined();
      // Nothing is signalled after exit, so the straggler is still alive.
      expect(stray).toBeGreaterThan(0);
      expect(alive(stray)).toBe(true);
    } finally {
      try { if (stray > 0) process.kill(stray, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('a kill that cannot close the pipes still resolves (escaped descendant holds stdout; PR #71 re-review)', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-escaped-'));
    const pidFile = join(dir, 'escaped.pid');
    const script = join(dir, 'ct');
    // The descendant leaves the process group (setpgrp) and keeps stdout
    // open, so the group kill cannot make 'close' fire.
    writeFileSync(script, `#!/bin/sh\nperl -e 'setpgrp(0,0); open(F, ">", $ARGV[0]); print F $$; close F; exec "sleep", "30"' '${pidFile}' &\nwait\n`);
    chmodSync(script, 0o755);
    let escaped = 0;
    try {
      for (const mode of ['abort', 'timeout'] as const) {
        rmSync(pidFile, { force: true });
        const abort = new AbortController();
        const started = Date.now();
        const pending = nodeSpawnFn()({ command: script, args: [], timeoutMs: mode === 'timeout' ? 1500 : 30_000, signal: abort.signal });
        await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 5000);
        escaped = Number(readFileSync(pidFile, 'utf8').trim());
        if (mode === 'abort') abort.abort();
        const out = await pending;
        expect(Date.now() - started).toBeLessThan(10_000);
        if (mode === 'abort') expect(out.aborted).toBe(true);
        else expect(out.timedOut).toBe(true);
        try { process.kill(escaped, 'SIGKILL'); } catch { /* gone */ }
      }
    } finally {
      try { if (escaped > 0) process.kill(escaped, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spawnOutcomeOf (one normalization in the binding)', () => {
  const base = { code: null, stdout: '', stderr: '', timedOut: false };
  it('a failed start or an overflow is a spawn error, never aborted', () => {
    expect(spawnOutcomeOf({ ...base, spawnError: true, overflow: false, aborted: true })).toEqual({ ...base, spawnError: true });
    expect(spawnOutcomeOf({ ...base, spawnError: false, overflow: true, aborted: true })).toEqual({ ...base, spawnError: true });
  });
  it('a plain abort reports aborted; nothing else carries the key', () => {
    expect(spawnOutcomeOf({ ...base, spawnError: false, overflow: false, aborted: true })).toEqual({ ...base, spawnError: false, aborted: true });
    expect(spawnOutcomeOf({ ...base, code: 0, spawnError: false, overflow: false, aborted: false })).toEqual({ ...base, code: 0, spawnError: false });
  });
});

describe('nodeSpawnFn (every OS)', { timeout: 30_000 }, () => {
  it('decodes multi-byte output split across chunks intact (openclaw)', async () => {
    // 200k copies of a 3-byte character: far past one pipe chunk.
    const script = "process.stdout.write('\\u20ac'.repeat(200000))";
    const r = await nodeSpawnFn(process.env)({ command: process.execPath, args: ['-e', script], timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(200000);
    expect(r.stdout.includes('�')).toBe(false);
  });

  it('reads the env getter at spawn time (openclaw)', async () => {
    let value = 'first';
    const fn = nodeSpawnFn(() => ({ ...process.env, CT_SPAWN_PROBE: value }));
    value = 'second';
    const r = await fn({ command: process.execPath, args: ['-e', 'process.stdout.write(process.env.CT_SPAWN_PROBE)'], timeoutMs: 10_000 });
    expect(r.stdout).toBe('second');
  });

  it('caps output by bytes: past capBytes the outcome is a spawn error, never aborted', async () => {
    const r = await nodeSpawnFn(process.env, { capBytes: 1024 })({
      command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(100000))"], timeoutMs: 10_000,
    });
    expect(r.spawnError).toBe(true);
    expect(r.aborted).toBeUndefined();
  });

  it('stops collecting both streams once the cap is passed (contiguous prefix; PR #76 review)', async () => {
    // A detached grandchild (outside the kill's reach) writes in separate,
    // spaced chunks: 600 x '0', 600 x '1' (passes the 1024 cap), then a late
    // stderr line and 300 x '2' (which alone would fit under the cap again).
    // The child idles until the overflow kill.
    const writer = [
      "const w = (f, s) => f.write(s);",
      "w(process.stdout, '0'.repeat(600));",
      "setTimeout(() => w(process.stdout, '1'.repeat(600)), 150);",
      "setTimeout(() => w(process.stderr, 'late'), 300);",
      "setTimeout(() => w(process.stdout, '2'.repeat(300)), 450);",
      "setTimeout(() => process.exit(0), 600);",
    ].join('\n');
    const child = [
      "const { spawn } = require('node:child_process');",
      `const g = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
      "process.stderr.write('pid:' + String(g.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join('\n');
    const r = await nodeSpawnFn(process.env, { capBytes: 1024, killGraceMs: 3000 })({
      command: process.execPath, args: ['-e', child], timeoutMs: 10_000,
    });
    const pid = Number((/pid:(\d+)/.exec(r.stderr) ?? [])[1] ?? 0);
    try { if (pid > 0) process.kill(pid); } catch { /* gone */ }
    expect(r.spawnError).toBe(true);
    expect(r.aborted).toBeUndefined();
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
    expect(r.stdout).toMatch(/^0*1*$/);
    expect(r.stderr).not.toContain('late');
  });

  it('settles after abort and after timeout even when a detached grandchild holds the pipes', async () => {
    // The child starts a detached grandchild that inherits stdout/stderr and
    // outlives it, then idles: on POSIX the group kill does not reach a
    // detached grandchild, so it keeps the pipes open and 'close' may never
    // fire (on Windows taskkill /T ends it too; the call settles either way).
    const child = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.stdout.write(String(g.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join('\n');
    for (const mode of ['abort', 'timeout'] as const) {
      const abort = new AbortController();
      const started = Date.now();
      const pending = nodeSpawnFn(process.env, { killGraceMs: 250 })({
        command: process.execPath, args: ['-e', child], timeoutMs: mode === 'timeout' ? 3000 : 30_000, signal: abort.signal,
      });
      if (mode === 'abort') setTimeout(() => abort.abort(), 2500);
      const out = await pending;
      expect(Date.now() - started).toBeLessThan(10_000);
      if (mode === 'abort') expect(out.aborted).toBe(true);
      else expect(out.timedOut).toBe(true);
      const pid = Number(out.stdout.trim().split('\n')[0]);
      expect(pid).toBeGreaterThan(0);
      try { if (pid > 0) process.kill(pid); } catch { /* gone */ }
    }
  });
});

describe('windowsTreeKill (pure; every platform)', () => {
  it('builds the absolute System32 taskkill call with an argument list', () => {
    expect(windowsTreeKill(4242, { SystemRoot: 'C:\\Windows' })).toEqual({
      command: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4242', '/T', '/F'],
      cwd: 'C:\\Windows',
    });
  });

  it('accepts another drive and a trailing backslash', () => {
    expect(windowsTreeKill(7, { SystemRoot: 'D:\\WINDOWS\\' })?.command).toBe('D:\\WINDOWS\\System32\\taskkill.exe');
  });

  it.each([
    ['missing', {}],
    ['empty', { SystemRoot: '' }],
    ['relative', { SystemRoot: 'Windows' }],
    ['UNC', { SystemRoot: '\\\\server\\share\\Windows' }],
    ['dot-dot segment', { SystemRoot: 'C:\\Windows\\..\\Temp' }],
    ['POSIX path', { SystemRoot: '/usr/bin' }],
    ['mixed-separator dot-dot', { SystemRoot: 'C:\\Windows/../x' }],
    ['trailing dot-dot', { SystemRoot: 'C:\\Windows\\x/..' }],
    ['dot-dot with space', { SystemRoot: 'C:\\Windows\\.. \\x' }],
    ['trailing space', { SystemRoot: 'C:\\Windows ' }],
    ['trailing dot', { SystemRoot: 'C:\\Windows.' }],
    ['drive letter in a later segment', { SystemRoot: 'C:\\Windows\\D:\\x' }],
  ])('returns null for a %s SystemRoot', (_name, env) => {
    expect(windowsTreeKill(4242, env as NodeJS.ProcessEnv)).toBeNull();
  });

  it('uses a drive-absolute cwd for a drive-root SystemRoot', () => {
    expect(windowsTreeKill(7, { SystemRoot: 'C:\\' })).toEqual({
      command: 'C:\\System32\\taskkill.exe',
      args: ['/PID', '7', '/T', '/F'],
      cwd: 'C:\\',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('returns null for pid %s', (pid) => {
    expect(windowsTreeKill(pid, { SystemRoot: 'C:\\Windows' })).toBeNull();
  });
});

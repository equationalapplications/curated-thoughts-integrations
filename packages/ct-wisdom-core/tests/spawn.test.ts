/**
 * spawn.test.ts — the shared Node spawn binding (spec
 * 2026-10-17-core-spawn-binding-and-cancel-design.md). Ported from the
 * deepseek adapter suite (PR #71 review fixes) and the openclaw spawn suite
 * (multi-byte decoding), plus a platform-neutral settle test.
 */

import { describe, it, expect } from 'vitest';

import { nodeSpawnFn, spawnOutcomeOf } from '../src/spawn.js';

describe('nodeSpawnFn (real binding, fake binary)', { timeout: 30_000 }, () => {
  it('passes the argument LIST to a shell-less spawn and captures stdout', async () => {
    // POSIX-only: needs /bin/sh for the shebang script.
    if (process.platform === 'win32') return;
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

  it('times out a hung binary inside the budget and reports timedOut', async () => {
    if (process.platform === 'win32') return;
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

  it('an abort kills the child AND its grandchild and reports aborted', async () => {
    if (process.platform === 'win32') return;
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

  it('a run that ends normally is not aborted and leaves no abort listener behind', async () => {
    if (process.platform === 'win32') return;
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

  it('the timeout kills the grandchild too (one kill path, PR #71 review)', async () => {
    if (process.platform === 'win32') return;
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

  it('an already-aborted signal resolves aborted without spawning (PR #71 review)', async () => {
    if (process.platform === 'win32') return;
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

  it('an abort after the child already exited reports the real result, not aborted (PR #71 review)', async () => {
    if (process.platform === 'win32') return;
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
      const pending = nodeSpawnFn()({ command: script, args: [], timeoutMs: 30_000, signal: abort.signal });
      const end = Date.now() + 10_000;
      while (!existsSync(exiting) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 300)); // the child's exit is reaped
      abort.abort();
      const out = await pending;
      expect(out.aborted).toBeUndefined();
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('{"entries": []}');
      expect(Date.now() - started).toBeLessThan(20_000); // settled by the grace, not the straggler
      // The leader was already reaped: nothing is signalled (no -pid of a
      // reaped leader), so the straggler is still alive.
      stray = Number(readFileSync(strayPid, 'utf8').trim());
      expect(alive(stray)).toBe(true);
    } finally {
      try { if (stray > 0) process.kill(stray, 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a kill that cannot close the pipes still resolves (escaped descendant holds stdout; PR #71 re-review)', async () => {
    if (process.platform === 'win32') return;
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

  it('settles after abort and after timeout even when a detached grandchild holds the pipes', async () => {
    // The child starts a detached grandchild that inherits stdout/stderr and
    // outlives it, then idles: a kill reaches the child (on Windows only the
    // child), the grandchild keeps the pipes open, so 'close' may never fire.
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
        command: process.execPath, args: ['-e', child], timeoutMs: mode === 'timeout' ? 1500 : 30_000, signal: abort.signal,
      });
      if (mode === 'abort') setTimeout(() => abort.abort(), 1000);
      const out = await pending;
      expect(Date.now() - started).toBeLessThan(10_000);
      if (mode === 'abort') expect(out.aborted).toBe(true);
      else expect(out.timedOut).toBe(true);
      const pid = Number(out.stdout.trim().split('\n')[0]);
      try { if (pid > 0) process.kill(pid); } catch { /* gone */ }
    }
  });
});

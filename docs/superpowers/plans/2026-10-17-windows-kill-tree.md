# Windows kill takes the `ct` process tree down — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, the core spawn binding's kill also ends the processes `ct` started, by running `taskkill /PID <pid> /T /F` before falling back to today's direct kill.

**Architecture:** One pure helper `windowsTreeKill(pid, env)` in `packages/ct-wisdom-core/src/spawn.ts` builds the taskkill call (absolute System32 path, argument list). `killTree()`'s win32 branch starts it once per child, `windowsHide`, `stdio: 'ignore'`, a 2 s own timeout, `unref`; on any taskkill failure it falls back to `child.kill('SIGKILL')`. The hard settle deadline and every other binding rule are unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `child_process`, vitest; CI matrix `ubuntu-latest` + `windows-latest` for the core job.

**Spec:** `docs/superpowers/specs/2026-10-17-windows-kill-tree-design.md` (approved). Read it first.

## Global Constraints

- taskkill program: `<SystemRoot>\System32\taskkill.exe`, `SystemRoot` read from the host's `process.env`; used only if it matches `/^[A-Za-z]:\\/` and has no `..` segment.
- taskkill arguments: exactly `['/PID', String(pid), '/T', '/F']`; `shell: false`; `windowsHide: true`; `stdio: 'ignore'`; `cwd` = `<SystemRoot>`; own timeout `TASKKILL_TIMEOUT_MS = 2000`; `unref()`.
- taskkill runs before the direct kill, once per child, never after the child has exited.
- Fallback to `child.kill('SIGKILL')` when taskkill cannot start, emits `'error'`, times out, or exits non-zero, and the child has not exited. Every error is swallowed.
- The hard deadline (`killGraceMs`) is armed before taskkill starts; settling is unchanged.
- POSIX behavior unchanged.
- No new dependency; no change outside `packages/ct-wisdom-core` except release metadata and docs (Task 3).
- Branch: `feat/windows-kill-tree` off `docs/windows-kill-tree-spec`. Never commit to `main`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run core tests from `packages/ct-wisdom-core` with `./node_modules/.bin/vitest run <file>` and type-check with `./node_modules/.bin/tsc -p . --noEmit` (run `pnpm install --frozen-lockfile` there first if `node_modules` is missing; local pnpm is 12.x and the repo pins 9.15.9 — if pnpm refuses, use a shim: `printf '#!/bin/sh\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0\nexec corepack pnpm "$@"\n'` on PATH).

---

### Task 1: `windowsTreeKill` helper and the win32 kill path

**Files:**
- Modify: `packages/ct-wisdom-core/src/spawn.ts` (header comment `:1–14`, `DEFAULT_KILL_GRACE_MS` comment `:41–51`, `killTree` `:136–167`, new exports)
- Test: `packages/ct-wisdom-core/tests/spawn.test.ts` (new `describe` for the helper)

**Interfaces:**
- Produces:
  - `export const TASKKILL_TIMEOUT_MS = 2000;`
  - `export interface WindowsTreeKill { command: string; args: string[]; cwd: string }`
  - `export function windowsTreeKill(pid: number, env: NodeJS.ProcessEnv): WindowsTreeKill | null`
  - (re-exported through `src/index.ts`'s existing `export * from './spawn.js'`)

- [ ] **Step 1: Branch**

```bash
cd /Users/equationalapplications/code/src/github.com/equationalapplications/curated-thoughts-integrations
git checkout docs/windows-kill-tree-spec && git pull && git checkout -b feat/windows-kill-tree
```

- [ ] **Step 2: Write the failing helper tests**

Append to `packages/ct-wisdom-core/tests/spawn.test.ts`, and add `windowsTreeKill` to its import from `'../src/spawn.js'`:

```ts
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
  ])('returns null for a %s SystemRoot', (_name, env) => {
    expect(windowsTreeKill(4242, env as NodeJS.ProcessEnv)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN])('returns null for pid %s', (pid) => {
    expect(windowsTreeKill(pid, { SystemRoot: 'C:\\Windows' })).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run (from `packages/ct-wisdom-core`): `./node_modules/.bin/vitest run tests/spawn.test.ts -t windowsTreeKill`
Expected: FAIL — `windowsTreeKill` is not exported.

- [ ] **Step 4: Implement the helper**

In `spawn.ts`, after `DEFAULT_CAP_BYTES`:

```ts
/** taskkill's own bound: it must never become a hung process of its own. */
export const TASKKILL_TIMEOUT_MS = 2000;

export interface WindowsTreeKill {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * The Windows tree kill (spec 2026-10-17-windows-kill-tree-design.md):
 * `<SystemRoot>\System32\taskkill.exe /PID <pid> /T /F`, by absolute path
 * (never a PATH lookup) with an argument list (never a shell). Null when
 * SystemRoot is not an absolute local path or the pid is not a positive
 * integer; the caller then falls back to the direct kill.
 */
export function windowsTreeKill(pid: number, env: NodeJS.ProcessEnv): WindowsTreeKill | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const root = env.SystemRoot;
  if (typeof root !== 'string' || !/^[A-Za-z]:\\/.test(root)) return null;
  if (root.split('\\').includes('..')) return null;
  const base = root.replace(/\\+$/, '');
  return { command: `${base}\\System32\\taskkill.exe`, args: ['/PID', String(pid), '/T', '/F'], cwd: base };
}
```

- [ ] **Step 5: Run the helper tests**

Run: `./node_modules/.bin/vitest run tests/spawn.test.ts -t windowsTreeKill`
Expected: PASS.

- [ ] **Step 6: Wire the win32 branch of `killTree`**

Inside `nodeSpawnFn`'s promise, next to the other `let` state, add `let treeKillStarted = false;`. Replace the body of `killTree()` from the line `if (process.platform !== 'win32') {` to the end of the function with:

```ts
        if (process.platform !== 'win32') {
          try {
            process.kill(-pid, 'SIGKILL');
            return;
          } catch {
            /* group gone — fall through to the direct kill */
          }
          directKill();
          return;
        }
        // win32: no process groups. taskkill /T walks the tree from the
        // child's pid, so it must run while the child is alive — before the
        // direct kill, which is only the fallback. Once per child.
        if (treeKillStarted) return;
        treeKillStarted = true;
        const call = windowsTreeKill(pid, process.env);
        if (call === null) {
          directKill();
          return;
        }
        let tk: ReturnType<typeof spawn>;
        try {
          tk = spawn(call.command, call.args, {
            cwd: call.cwd,
            stdio: 'ignore',
            shell: false,
            windowsHide: true,
            timeout: TASKKILL_TIMEOUT_MS,
            killSignal: 'SIGKILL' as NodeJS.Signals,
          });
        } catch {
          directKill();
          return;
        }
        let fellBack = false;
        const fallback = () => {
          if (fellBack) return;
          fellBack = true;
          if (!exited) directKill();
        };
        tk.on('error', fallback);
        tk.on('exit', (code) => {
          if (code !== 0) fallback();
        });
        try {
          tk.unref();
        } catch {
          /* nothing more to do */
        }
```

and add, just above `killTree`, the direct kill it shares with the POSIX fallback:

```ts
      /** Today's direct kill: the one process (Windows fallback, POSIX group gone). */
      function directKill(): void {
        try {
          child.kill('SIGKILL');
        } catch {
          /* a kill that throws is bounded by the deadline above */
        }
      }
```

Keep the existing first lines of `killTree` unchanged (the pid check, `if (exited) return;`, and arming `deadline`), so the deadline is armed before taskkill starts. Note: a taskkill killed by its own `timeout` exits with `code === null`, which is `!== 0`, so it falls back.

- [ ] **Step 7: Update the comments**

- `spawn.ts` header: replace "on POSIX the child's process group is killed; on Windows only the direct child." with "on POSIX the child's process group is killed; on Windows `taskkill /T /F` ends the child and its descendants, with the direct kill as the fallback."
- `DEFAULT_KILL_GRACE_MS` comment: replace "Windows killing only the direct child" with "a taskkill that has not finished yet".

- [ ] **Step 8: Run the whole core suite and type-check**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc -p . --noEmit`
Expected: PASS on macOS/Linux (the win32 branch is not taken there); no type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/ct-wisdom-core/src/spawn.ts packages/ct-wisdom-core/tests/spawn.test.ts
git commit -m "feat(core): on Windows a ct kill runs taskkill /T /F first, direct kill as the fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Windows CI tests — the grandchild dies

**Files:**
- Test: `packages/ct-wisdom-core/tests/spawn.test.ts` (new `runIf(win32)` tests inside the existing `describe('nodeSpawnFn (real binding, fake binary)'`)

**Interfaces:**
- Consumes: `nodeSpawnFn`, `DEFAULT_KILL_GRACE_MS` from `../src/spawn.js`; the suite's existing `alive(pid)` and `waitFor(cond, ms)` helpers.

- [ ] **Step 1: Add a Windows fake `ct` and the tests**

Inside the `nodeSpawnFn` describe, after `hangingCt`, add:

```ts
  /** Windows fake ct: node.exe runs a script that starts a sleeping node grandchild, writes its pid, and hangs. */
  async function hangingCtWin() {
    const { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-win-'));
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'ct.cjs');
    writeFileSync(
      script,
      "const { spawn } = require('child_process');\n"
        + "const fs = require('fs');\n"
        + "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });\n"
        + `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n`
        + 'setTimeout(() => {}, 30000);\n',
    );
    const grandchild = async (): Promise<number> => {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 10_000);
      return Number(readFileSync(pidFile, 'utf8').trim());
    };
    return { command: process.execPath, args: [script, 'wisdom', 'match'], grandchild, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
      process.env.SystemRoot = 'not-absolute';
      const abort = new AbortController();
      const pending = nodeSpawnFn()({ command: ct.command, args: ct.args, timeoutMs: 30_000, signal: abort.signal });
      gpid = await ct.grandchild();
      abort.abort();
      const out = await pending;
      expect(out.aborted).toBe(true);
    } finally {
      process.env.SystemRoot = saved;
      // The fallback reaches only the child: end the orphaned grandchild here.
      if (gpid > 0 && alive(gpid)) process.kill(gpid);
      ct.cleanup();
    }
  });
```

Add `DEFAULT_KILL_GRACE_MS` to the import from `'../src/spawn.js'` if it is not already imported. (The fallback test does not assert the grandchild's fate: the direct kill reaches only the child, which is the documented fallback.)

- [ ] **Step 2: Run locally (POSIX: the three tests are skipped)**

Run: `./node_modules/.bin/vitest run tests/spawn.test.ts`
Expected: PASS, with the three `Windows:` tests reported as skipped.

- [ ] **Step 3: Commit, push the branch, and run CI on Windows**

```bash
git add packages/ct-wisdom-core/tests/spawn.test.ts
git commit -m "test(core): Windows CI checks the grandchild dies on abort and timeout, and the fallback settles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/windows-kill-tree
gh workflow run ci.yml --ref feat/windows-kill-tree
```

Then watch the run: `gh run list --branch feat/windows-kill-tree -L 1` and `gh run watch <id> --exit-status`. Expected: the `core (ct-wisdom-core, windows-latest)` job passes with the three `Windows:` tests run (not skipped). If a Windows test fails, read the job log (`gh run view <id> --log-failed`), report the failing assertion verbatim, and stop: do not loosen an assertion without a ruling.

---

### Task 3: release metadata and docs

**Files:**
- Modify: `integrations/{deepseek,opencode,openclaw}/integration.yaml`, `package.json`; `integrations/openclaw/openclaw.plugin.json`; `integrations/openclaw/src/index.ts` (`PLUGIN_VERSION`); `README.md` (three rows); `integrations/{deepseek,opencode,openclaw}/CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md` (Known limitations, the Windows bullet)

- [ ] **Step 1: Pick the versions**

Read the current versions on this branch's base and on `origin/main` (`git fetch && git show origin/main:integrations/<id>/package.json | grep '"version"'`). Each of deepseek, opencode, openclaw gets the next patch above the HIGHEST of: this branch's version, `origin/main`'s version, and any open PR's version for that integration (`gh pr list --state open --json number,title` — PR #79 targets openclaw 0.3.5, so openclaw goes to 0.3.6 if #79 is still open or merged). Write the three chosen versions into the commit message.

- [ ] **Step 2: Bump**

For each `<id>` with its chosen `<old>` → `<new>`, update `integrations/<id>/integration.yaml` (`version:`), `integrations/<id>/package.json` (`"version"`), the README row link text `[<old>]` → `[<new>]`; for openclaw also `openclaw.plugin.json` and `PLUGIN_VERSION` in `src/index.ts`. Then run `python3 tools/ct_ci.py readme --check` from the repo root.

- [ ] **Step 3: CHANGELOG entries**

In each of the three CHANGELOGs, directly under `## Unreleased` (keep it empty), add:

```markdown
## <new> — <today's date, YYYY-MM-DD>

- Fixed: on Windows, stopping `ct` (timeout, cancel or output cap) now also stops the processes it started, using Windows' own `taskkill /T /F` by its full system path; if that fails, the old direct stop is used. No change on macOS or Linux.
```

- [ ] **Step 4: Parent spec note**

In `docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md`, under Known limitations, append to the bullet that begins "On Windows a kill reaches only the direct child": ` — closed by [2026-10-17-windows-kill-tree-design.md](2026-10-17-windows-kill-tree-design.md).`

- [ ] **Step 5: Refresh the hosts' vendored core and run their suites**

```bash
cd packages/ct-wisdom-core && ./node_modules/.bin/tsc -p . && cd ../..
for h in deepseek opencode openclaw; do rsync -a --delete packages/ct-wisdom-core/lib/ integrations/$h/node_modules/@equational-applications/ct-wisdom-core/lib/; (cd integrations/$h && ./node_modules/.bin/vitest run 2>&1 | grep -E 'Test Files|Tests '); done
python3 -m unittest discover -s tests/tools && python3 tools/ct_ci.py validate && python3 tools/ct_ci.py readme --check && python3 tools/ct_ci.py policy --base main
```

Expected: every host suite passes; tools tests OK; gates `ok`.

- [ ] **Step 6: Commit and push**

```bash
git add README.md integrations docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md
git commit -m "release: <versions> (Windows kill takes the ct process tree down)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

# Windows: a `ct` kill takes the whole process tree down — design

**Date:** 2026-10-17 · **Status:** Approved (user, 2026-10-17) · **Branch:** `docs/windows-kill-tree-spec` ·
**Base:** `origin/main` @ `0b7729c`
**Scope:** `packages/ct-wisdom-core/src/spawn.ts` (the one Node spawn binding), and through it the hosts that
vendor the core: deepseek, opencode, openclaw.
**Builds on:** [`2026-10-17-core-spawn-binding-and-cancel-design.md`](2026-10-17-core-spawn-binding-and-cancel-design.md)
(PR B: the shared binding, its one `killTree`, the post-exit grace and the hard settle deadline). This spec closes that
spec's first known limitation: "On Windows a kill reaches only the direct child; descendants survive."

Tags: **[V]** verified in this session (repo code, or the cited official documentation); **[U]** unverified, carried
as a limitation or as a Windows CI target. Nothing here runs Windows locally; Windows behavior is verified by the
core's existing `windows-latest` CI job.

## Problem

The binding has one kill path (`killTree`), used by the timeout, the caller's abort (activity budget) and the output
cap. On POSIX it kills the child's process group, so a `ct` that started helpers takes them down with it. On Windows it
calls `child.kill('SIGKILL')`, which ends only `ct` itself; any process `ct` started keeps running, unattended, holding
memory and maybe a file or a pipe, until it exits on its own. The session is never stuck (the hard settle deadline
ends the wait), so the cost is leftover processes, not a broken session.

## Phase 0: facts

- **F1 [V].** `spawn.ts:140–167`: `killTree()` returns if the child has exited; arms the hard deadline
  (`killGraceMs`, default 250 ms) once; on non-win32 kills `-pid` (the group) and falls back to `child.kill`; on win32
  only `child.kill('SIGKILL')`. `spawn.ts:94`: `detached` is `false` on win32 (no process group there).
- **F2 [V].** Node `child_process` docs: on Windows, `'SIGKILL'` and the other terminal signals "terminate the
  process forcefully and abruptly"; there are no POSIX signals or process groups, so the kill reaches one process.
- **F3 [V].** Microsoft `taskkill` reference: `/pid <processID>` selects the process; `/f` "Specifies that processes
  be forcefully ended"; `/t` "Ends the specified process and any child processes started by it." The default target
  is the local computer.
- **F4 [U].** `/t` finds descendants by their recorded parent process id, so it must run while `ct` is still alive:
  once `ct` is gone its children are no longer reachable from its pid. This is why taskkill runs **before** the direct
  kill. Windows CI target (see Testing).
- **F5 [V].** The core's CI job already runs on `ubuntu-latest` and `windows-latest` (`.github/workflows/ci.yml:82`);
  every kill test in `packages/ct-wisdom-core/tests/spawn.test.ts` is `skipIf(win32)` today.
- **F6 [V].** The Python hosts (Hermes, Claude Code, Docker Agent) run `ct` with `subprocess.run(timeout=…)`, which on
  timeout kills only the direct child on every platform. They do not use this binding.

## Design

### Overview

On win32, `killTree()` first starts Windows' own `taskkill.exe` against the child's pid with `/T /F`, and only falls
back to today's `child.kill('SIGKILL')` if taskkill cannot do the job. Everything else in the binding (the outcome
rules, the grace, the hard deadline, the abort and cap paths) is unchanged. POSIX is unchanged.

### The taskkill call

- **Program:** an absolute path, never a `PATH` lookup: `<SystemRoot>\System32\taskkill.exe`, where `SystemRoot` is read
  from the host's own `process.env` (not the env handed to `ct`, which may be minimal). It is used only if it is an
  absolute local Windows path (`/^[A-Za-z]:\\/`) with no `..` segment; otherwise the taskkill step is skipped and the
  fallback runs.
- **Arguments:** an argument list `['/PID', String(pid), '/T', '/F']`. No shell (`shell: false`), so nothing is parsed by
  `cmd.exe`; the pid is an integer from Node.
- **Options:** `windowsHide: true`, `stdio: 'ignore'`, `cwd` = `<SystemRoot>`, a short own timeout
  (`TASKKILL_TIMEOUT_MS` = 2000) and `unref()`, so taskkill can never hold the host's event loop open or become a hung
  process of its own.
- **Once per child:** a flag makes the first `killTree()` start taskkill; later calls (e.g. the cap after a timeout)
  do nothing more on win32 while taskkill is in flight.
- **Fallback:** if taskkill cannot start (spawn throws, or emits `'error'`), times out, or exits with a non-zero code
  (for example 128, "process not found"), and the child has not exited, call `child.kill('SIGKILL')` (today's
  behavior). Every error is swallowed (INTENT rule 4).
- **Not exited only:** as today, nothing is signalled once the child has exited (F1); taskkill is never started for a
  reaped pid.

### Settling (unchanged)

The hard deadline is armed at the first `killTree()`, before taskkill starts, so the call still settles within
`killGraceMs` whatever taskkill does. A slow taskkill finishes in the background (it is `unref`'d). The post-exit grace
still bounds the wait for `'close'`.

### A pure helper for tests

`spawn.ts` exports `windowsTreeKill(pid: number, env: NodeJS.ProcessEnv): { command: string; args: string[]; cwd: string } | null`,
the one place that builds the call (null when `SystemRoot` is unusable or the pid is not a positive integer). The
binding uses it; unit tests check it on every platform.

### Docs

- The `spawn.ts` header and the `DEFAULT_KILL_GRACE_MS` comment no longer say Windows kills only the direct child.
- The parent spec's known limitation gets a "closed by" note pointing here.

## Alignment with INTENT.md

- **Rule 4 (failing quietly beats failing the session):** the kill can only get more complete. Any taskkill failure
  falls back to today's direct kill, all errors are swallowed, and the call's settle bound is unchanged.
- **Rule 7 (integrations only read):** unaffected; taskkill acts only on the `ct` process tree this binding started,
  never on the brain.
- **Goal "every host should reach every step":** the three TypeScript hosts now stop `ct` the same way on Windows as on
  POSIX.

No departure from INTENT.md.

## Security

- No `PATH` lookup and no shell: a planted `taskkill.exe` earlier on `PATH`, or a crafted argument, cannot run.
- `SystemRoot` comes from the host's environment, the same trust level as the rest of the host's env (anyone who can
  set it can already run code as the user); the path is validated as an absolute local path before use.
- The only target is the pid of the child this binding spawned and has not seen exit.

## Known limitations

- **Pid reuse window [U].** Between the "not exited" check and taskkill opening the process (tens of milliseconds),
  `ct` could exit and Windows could hand its pid to an unrelated process, which `/T /F` would then end with its
  children. Windows does not reuse a pid while a handle to the process is open, and Node holds one until it reports the
  exit, so the window is only the time between Node seeing the exit and taskkill running. No cheap mitigation exists
  without native code; carried as a limitation.
- **A descendant that already left the tree** (its parent exited earlier, so it is no longer reachable from `ct`'s pid)
  survives, as on POSIX for a process that left the group.
- **Python hosts (F6):** Hermes, Claude Code and Docker Agent kill only the direct child on timeout, on every platform.
  That is a separate change in the Python ecosystem; out of scope here.

## Testing

- **Unit, every platform (`packages/ct-wisdom-core/tests/spawn.test.ts`):** `windowsTreeKill` builds
  `<SystemRoot>\System32\taskkill.exe` with exactly `['/PID', '<pid>', '/T', '/F']` and `cwd` `<SystemRoot>`; returns
  null for a missing, relative, UNC or `..`-containing `SystemRoot`, and for pid 0, negative or non-integer.
- **Windows CI (`windows-latest`, new `runIf(win32)` tests):**
  - an abort kills the child AND its grandchild: a `node` child starts a `node` grandchild that writes its pid to a
    file and sleeps; after the abort, the grandchild's pid is gone within a bounded wait (`process.kill(pid, 0)` throws
    `ESRCH`), and the outcome is `aborted`;
  - the timeout path does the same (`timedOut`);
  - the call settles within the hard deadline even when taskkill is slow (verified by the settle time, not by taskkill);
  - with `SystemRoot` unusable for the binding's process env, the direct-kill fallback still ends the child and the
    call settles.
- **POSIX:** the existing suite is unchanged and still passes (the win32 branch is not taken).

## Versioning and docs

The core is vendored by deepseek, opencode and openclaw, so each gets a patch bump with a CHANGELOG entry
("On Windows, stopping `ct` now also stops the processes it started"), and the README table is updated. The plan
coordinates the openclaw number with any release still in flight.

## Out of scope

- Windows Job Objects (would need a native add-on: a new dependency).
- Enumerating descendants with PowerShell or `wmic` (slower; `wmic` is deprecated; a gap between list and kill).
- The Python hosts' `subprocess.run` kill (F6).

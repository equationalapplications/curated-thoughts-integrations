/**
 * spawn.ts — the one Node child_process binding for the core's SpawnFn
 * contract, shared by every TypeScript host (deepseek, opencode, openclaw).
 * Spec: docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md.
 *
 * Argument LIST (never a shell string), no shell, cwd home, windowsHide,
 * SIGKILL, a POSIX process group so a kill takes the tree down, bounded byte
 * accumulation (the async spawn has no maxBuffer). `spec.signal` aborts: on
 * POSIX the child's process group is killed; on Windows only the direct
 * child. Every end path settles: once the child has exited (for any
 * reason), 'close' gets at most a short grace, then the pipes are destroyed
 * and the real exit code is reported; after a kill of a running child, the
 * call settles within the same grace even if the kill failed.
 */

import { spawn } from 'node:child_process';

import type { SpawnFn, SpawnOutcome } from './match.js';

/**
 * The binding's one outcome normalization: a binary that could not start
 * and a capped runaway are spawn errors and never `aborted` (the core's
 * classify checks `aborted` first), so ENOENT is never mistaken for an
 * abort. Every other layer relies on this invariant.
 */
export function spawnOutcomeOf(raw: {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: boolean;
  overflow: boolean;
  timedOut: boolean;
  aborted: boolean;
}): SpawnOutcome {
  const spawnError = raw.spawnError || raw.overflow;
  const out: SpawnOutcome = { code: raw.code, stdout: raw.stdout, stderr: raw.stderr, spawnError, timedOut: raw.timedOut };
  if (raw.aborted && !spawnError) out.aborted = true;
  return out;
}

/**
 * Once the child has exited (normally or killed), how long to wait for
 * 'close'. A descendant that inherited stdout can hold the pipe open long
 * after the child is gone (a background helper, Windows killing only the
 * direct child, a process that left the group), and a promise that never
 * settles would leak the plan, skip the budget miss, or report a working
 * run as timed out.
 */
export const DEFAULT_KILL_GRACE_MS = 250;
export const DEFAULT_CAP_BYTES = 4 * 1024 * 1024;

export interface NodeSpawnOptions {
  /** Once the child has exited (any reason), how long to wait for 'close'. */
  killGraceMs?: number;
  /** Byte cap for stdout and for stderr; past it the child is killed (spawnError). */
  capBytes?: number;
}

export function nodeSpawnFn(
  envOrGetter: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = process.env,
  opts: NodeSpawnOptions = {},
): SpawnFn {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const CAP = opts.capBytes ?? DEFAULT_CAP_BYTES;
  return (spec) =>
    new Promise((resolve) => {
      // A getter is read per spawn (OpenClaw: the env follows the current registration).
      const env = typeof envOrGetter === 'function' ? envOrGetter() : envOrGetter;
      // Already aborted (the budget ran out before the spawn): start nothing.
      if (spec.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: false, aborted: true });
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args, {
          killSignal: 'SIGKILL' as NodeJS.Signals,
          cwd: env.HOME || env.USERPROFILE || '.',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          // Process-group leader (POSIX): a kill takes the whole group down.
          // Without it a `sh -c <tool>` wrapper survives as a grandchild
          // holding the stdio pipes open and 'close' never fires — the 3 s
          // budget would leak a 30 s hang. windowsHide covers the console
          // flash on Windows; detached there is a no-op for kill.
          detached: process.platform !== 'win32',
        });
      } catch {
        resolve({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false });
        return;
      }
      // Bounded accumulation stands in for maxBuffer (async spawn has none):
      // a runaway binary cannot grow the Buffers past a configurable byte cap
      // (capBytes, default 4 MiB); past it the child is killed (spawnError).
      // Raw Buffers, decoded ONCE at settle (OpenClaw): per-chunk toString
      // would split a multi-byte character across chunk boundaries, and the
      // cap is a true byte count.
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let overflow = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let exitCode: number | null = null;
      let exited = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      /** Pipes may be held by a descendant: destroy them and settle with what is known. */
      function settleNow(): void {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exited ? exitCode : null, false);
      }
      /**
       * The one kill path (timeout, abort, overflow). POSIX: the process
       * group (negative pid), falling back to the direct child when the
       * group is gone; Windows: the direct child only. A child that never
       * started has no pid and is never signalled: `child.kill()` on a
       * failed spawn signals pid 0, i.e. OUR OWN process group.
       */
      function killTree(): void {
        const pid = child.pid;
        if (typeof pid !== 'number' || pid <= 0) return;
        // Already exited: never signal. The leader is reaped, so its group
        // may be empty and its id reused by an unrelated process group
        // (PR #71); a straggler it started can therefore outlive the call.
        // The exit-time grace alone bounds the wait.
        if (exited) return;
        // Hard settle deadline, armed once at the first kill: a kill can
        // fail (Node then emits 'error', ignored above) while the child
        // keeps running, so no 'exit' or 'close' may ever come. The binding
        // must always settle; whichever of this, the exit grace or 'close'
        // comes first wins (finish is idempotent).
        if (deadline === undefined) deadline = setTimeout(settleNow, killGraceMs);
        if (process.platform !== 'win32') {
          try {
            process.kill(-pid, 'SIGKILL');
            return;
          } catch {
            /* group gone — fall through to the direct kill */
          }
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* a kill that throws is bounded by the deadline above */
        }
      }
      // Cleared at exit, so `timedOut` means the timer fired BEFORE exit.
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, spec.timeoutMs);
      const finish = (code: number | null, spawnError: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        if (deadline !== undefined) clearTimeout(deadline);
        // Every end path ('close', 'error', the exit grace, the kill deadline) drops the abort listener.
        spec.signal?.removeEventListener('abort', onAbort);
        resolve(spawnOutcomeOf({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          spawnError,
          overflow,
          timedOut,
          aborted,
        }));
      };
      // 'error' is a failed start only when the child never got a pid. Node
      // also emits it on a started child (e.g. a kill that fails); then
      // exit/close/the grace settle as usual.
      child.on('error', () => {
        if (typeof child.pid !== 'number') finish(null, true);
      });
      // One settle rule after exit, whatever the reason: the outcome is
      // fixed now (a later timer or abort cannot change it), and 'close'
      // gets at most killGraceMs before the pipes are destroyed and the
      // real exit code is reported (a descendant may hold stdout open).
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onAbort);
        if (settled || grace !== undefined) return;
        grace = setTimeout(settleNow, killGraceMs);
      });
      // The caller's budget ran out (activity delivery, `spec.signal`): kill
      // the tree now and report `aborted`, which the core classifies as its
      // own outcome (OpenCode / OpenClaw parity). A child that already
      // exited keeps its real result (the listener is removed at exit; the
      // guard covers an abort dispatched in the same tick).
      function onAbort(): void {
        if (!exited) aborted = true;
        killTree();
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      // Past the cap, nothing more is collected on EITHER stream (no gap in
      // the kept prefix) and the tree is killed once.
      child.stdout?.on('data', (chunk: Buffer) => {
        if (overflow) return;
        if (outBytes + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        outBytes += chunk.length;
        out.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (overflow) return;
        if (errBytes + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        errBytes += chunk.length;
        err.push(chunk);
      });
      child.on('close', (code) => finish(code, false));
    });
}

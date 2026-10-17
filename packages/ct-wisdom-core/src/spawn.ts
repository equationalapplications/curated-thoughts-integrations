/**
 * spawn.ts — the one Node child_process binding for the core's SpawnFn
 * contract, shared by every TypeScript host (deepseek, opencode, openclaw).
 * Spec: docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md.
 *
 * Argument LIST (never a shell string), no shell, cwd home, windowsHide,
 * SIGKILL, a POSIX process group so a kill takes the tree down, bounded byte
 * accumulation (the async spawn has no maxBuffer). `spec.signal` aborts: on
 * POSIX the child's process group is killed; on Windows only the direct
 * child. Every end path settles: after a kill, 'close' gets a short grace.
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
 * After a kill, how long to wait for 'close' once the child has exited. A
 * kill cannot always close the pipes (Windows kills only the direct child;
 * a descendant that left the process group keeps stdout open), and a
 * promise that never settles would leak the plan and skip the budget miss.
 */
export const DEFAULT_KILL_GRACE_MS = 250;
export const DEFAULT_CAP_BYTES = 4 * 1024 * 1024;

export interface NodeSpawnOptions {
  /** After a kill, how long to wait for 'close' once the child has exited. */
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
      // a runaway binary cannot grow these strings past the same 4 MiB cap
      // the v1 spawnSync path enforced.
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
      let killed = false;
      let exitCode: number | null = null;
      let exited = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      /** Killed and exited: give 'close' a short grace, then settle anyway. */
      function armGrace(): void {
        if (grace !== undefined || settled) return;
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, false);
        }, killGraceMs);
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
        killed = true;
        // Already exited: never signal (the leader is reaped, so -pid could
        // hit a reused group); only bound the wait for pipes others hold,
        // keeping the output read so far.
        if (exited) {
          armGrace();
          return;
        }
        if (process.platform !== 'win32') {
          try {
            process.kill(-pid, 'SIGKILL');
            return;
          } catch {
            /* group gone — fall through to the direct kill */
          }
        }
        child.kill('SIGKILL');
      }
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, spec.timeoutMs);
      const finish = (code: number | null, spawnError: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        // Every end path ('close', 'error', the kill grace) drops the abort listener.
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
      child.on('error', () => finish(null, true));
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        if (killed) armGrace();
      });
      // The caller's budget ran out (activity delivery, `spec.signal`): kill
      // the tree now and report `aborted`, which the core classifies as its
      // own outcome (OpenCode / OpenClaw parity). A child that already
      // exited keeps its real result (killTree then only bounds the wait).
      function onAbort(): void {
        if (!exited) aborted = true;
        killTree();
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (outBytes + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        outBytes += chunk.length;
        out.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
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

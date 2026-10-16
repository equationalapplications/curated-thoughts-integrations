/**
 * spawn.ts — async child_process binding for the core's SpawnFn contract
 * (ported from the deepseek leg's adapter): argument LIST (never a shell
 * string), no shell, cwd = home, windowsHide, SIGKILL of the whole process
 * group on timeout, and a bounded 4 MiB stdout/stderr accumulation.
 *
 * Async is load-bearing on OpenClaw: the hook runs inside the Gateway's event
 * loop, which serves every channel — a spawnSync here would stall them all
 * for the full CT budget.
 */

import { spawn } from 'node:child_process';
import type { SpawnFn } from '@equational-applications/ct-wisdom-core';

const CAP = 4 * 1024 * 1024;

export function nodeSpawnFn(env: NodeJS.ProcessEnv = process.env): SpawnFn {
  return (spec) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args, {
          cwd: env.HOME || env.USERPROFILE || '.',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          // Process-group leader (POSIX) so the timeout kill takes wrapper
          // grandchildren down too; otherwise 'close' never fires.
          detached: process.platform !== 'win32',
        });
      } catch {
        resolve({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false });
        return;
      }
      // Raw Buffers, decoded ONCE in finish(): per-chunk toString would split
      // a multi-byte character across chunk boundaries, and the cap below is
      // a true byte count.
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let overflow = false;
      let timedOut = false;
      let settled = false;
      const killTree = (): void => {
        if (child.pid !== undefined && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            /* group gone — fall through to the direct kill */
          }
        }
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, spec.timeoutMs);
      const finish = (code: number | null, spawnError: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          spawnError: spawnError || overflow,
          timedOut,
        });
      };
      child.on('error', () => finish(null, true));
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

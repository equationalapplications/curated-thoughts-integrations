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
      let stdout = '';
      let stderr = '';
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
        resolve({ code, stdout, stderr, spawnError: spawnError || overflow, timedOut });
      };
      child.on('error', () => finish(null, true));
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length + chunk.length > CAP) {
          overflow = true;
          killTree();
          return;
        }
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => finish(code, false));
    });
}

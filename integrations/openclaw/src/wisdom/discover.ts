/**
 * discover.ts — locate the `ct` CLI (async port of the deepseek leg's
 * discoverCt): PATH matches first, then the platform fallbacks; ABSOLUTE
 * candidates only (a relative hit could resolve against the Gateway's cwd and
 * let a repo-planted impostor through); each candidate must answer
 * `--help` with "Curated Thoughts" inside one cumulative 3 s budget. A miss is
 * cached for 5 minutes; a probe timeout ends the walk without caching.
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { isAbsolute } from 'node:path';
import type { SpawnFn } from '@equational-applications/ct-wisdom-core';
import { allPathMatches } from '../../scripts/ct_env.js';

export const PROBE_TIMEOUT_MS = 3000;
const MISS_TTL_MS = 5 * 60_000;

export function candidatePaths(env: NodeJS.ProcessEnv, platform: string = osPlatform()): string[] {
  const isWin = platform.startsWith('win');
  const matches = allPathMatches('ct', env, platform as NodeJS.Platform);
  // win32: skip .cmd/.bat (shell:false spawns of them fail — CVE-2024-27980)
  // and extensionless files.
  const filtered = isWin
    ? matches.filter((p) => {
        const base = p.split(/[\\/]/).pop() ?? '';
        const dot = base.lastIndexOf('.');
        return dot > 0 && !['.cmd', '.bat'].includes(base.slice(dot).toLowerCase());
      })
    : matches;
  const home = homedir();
  if (isWin) {
    const out = [...filtered];
    if (env.USERPROFILE) out.push(`${env.USERPROFILE.replace(/[\\/]+$/, '')}\\bin\\ct.exe`);
    if (env.LOCALAPPDATA) out.push(`${env.LOCALAPPDATA.replace(/[\\/]+$/, '')}\\CuratedThoughts\\bin\\ct.exe`);
    return out;
  }
  const fallbacks = platform === 'darwin'
    ? [`${home}/bin/ct`, '/usr/local/bin/ct', '/opt/homebrew/bin/ct']
    : [`${home}/.local/bin/ct`, '/usr/bin/ct', '/usr/local/bin/ct', `${home}/bin/ct`];
  return [...filtered, ...fallbacks];
}

function defaultUsable(p: string): boolean {
  if (process.platform === 'win32') {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  }
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface LocatorDeps {
  env: NodeJS.ProcessEnv;
  spawnFn: SpawnFn;
  candidates?: () => string[];
  usable?: (path: string) => boolean;
  now?: () => number;
}

export class CtLocator {
  private accepted: string | null = null;
  private missUntil = 0;

  constructor(private readonly deps: LocatorDeps) {}

  /** Drop the accepted path and the miss cache (n3: retry next turn). */
  invalidate(): void {
    this.accepted = null;
    this.missUntil = 0;
  }

  async locate(): Promise<string | null> {
    if (this.accepted) return this.accepted;
    const now = this.deps.now ?? Date.now;
    if (now() < this.missUntil) return null;
    const usable = this.deps.usable ?? defaultUsable;
    const list = this.deps.candidates ? this.deps.candidates() : candidatePaths(this.deps.env);
    const seen = new Set<string>();
    const start = now();
    for (const cand of list) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      if (!isAbsolute(cand) || !usable(cand)) continue;
      const budget = PROBE_TIMEOUT_MS - (now() - start);
      if (budget <= 0) return null;
      const r = await this.deps.spawnFn({ command: cand, args: ['--help'], timeoutMs: budget });
      if (r.timedOut) return null; // budget spent: end the walk, cache nothing
      if (`${r.stdout}${r.stderr}`.includes('Curated Thoughts')) {
        this.accepted = cand;
        return cand;
      }
    }
    this.missUntil = now() + MISS_TTL_MS;
    return null;
  }
}

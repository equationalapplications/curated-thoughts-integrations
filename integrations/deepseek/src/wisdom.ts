// Port of integrations/hermes/scripts/ct_wisdom.py (proven); DSH deltas per
// docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-dsh-design.md.
export const SEED_QUERY = 'curated thoughts agent memory wisdom procedures';
export const PROBE_TIMEOUT_MS = 3000;
export const RECALL_TIMEOUT_MS = 5000;
export const RECALL_K = 3;
export const MAX_BLOCK_CHARS = 2500;
export const MEMO_MAX = 256;
export const BLOCK_HEADING = '## Curated Thoughts \u2014 relevant memory';

const FORBIDDEN_MARKER = '<!-- hermes-plugin-section';
const FORBIDDEN_HEADING = '## Plugin Context: ';
const HEADING_INDENT = '    ' + FORBIDDEN_HEADING;
const ELLIPSIS = '\u2026';

export type WikiEntry = { title: string; text: string };

export function keyOf(ctx: unknown): string {
  const c = (ctx ?? {}) as { agent?: unknown; scope?: unknown };
  const pick = (o: unknown): string =>
    typeof o === 'object' && o !== null && typeof (o as { id?: unknown }).id === 'string'
      ? (o as { id: string }).id
      : '';
  return pick(c.agent) || pick(c.scope) || '';
}

export function sanitize(value: unknown): string {
  let v = typeof value === 'string' ? value : value == null ? '' : String(value);
  while (v.includes(FORBIDDEN_MARKER)) v = v.split(FORBIDDEN_MARKER).join('');
  v = v
    .split('\n')
    .map((line) => (line.startsWith(FORBIDDEN_HEADING) ? HEADING_INDENT + line.slice(FORBIDDEN_HEADING.length) : line))
    .join('\n');
  return v.replace(/\{(?=\{)/g, '{ ');
}

export function renderBlock(entries: WikiEntry[]): string {
  if (!entries.length) return '';
  const heading = sanitize(BLOCK_HEADING);
  const parts: string[] = [];
  let used = heading.length + 2;
  for (const { title, text } of entries) {
    const cleanTitle = sanitize(title).trim();
    const cleanText = sanitize(text);
    if (!cleanTitle && !cleanText.trim()) continue;
    const titleLine = `**${cleanTitle}**`;
    let body = titleLine + '\n' + cleanText;
    const sep = parts.length ? 2 : 0;
    const remaining = MAX_BLOCK_CHARS - used - sep;
    if (remaining <= titleLine.length + 1) continue; // title alone cannot fit: skip
    if (body.length <= remaining) {
      parts.push(body);
      used += sep + body.length;
      continue;
    }
    const textBudget = remaining - titleLine.length - 1 - ELLIPSIS.length;
    if (textBudget > 0) {
      body = titleLine + '\n' + cleanText.slice(0, textBudget) + ELLIPSIS;
      parts.push(body);
      used += sep + body.length;
    }
    break; // budget exhausted after a truncated entry
  }
  if (!parts.length) return '';
  return heading + '\n\n' + parts.join('\n\n');
}

// ── Task 2: discovery — candidate lists, identity probe, bounded walk ──────

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { isAbsolute } from 'node:path';
import { allPathMatches } from '../scripts/ct_env.js';

const MISS_TTL_MS = 5 * 60_000;
let acceptedCtPath: string | null = null;
let missCache: { until: number } | null = null;

export type ProbeVerdict = 'ok' | 'timeout' | 'reject';
export type DiscoveryFailure = 'probe_timeout' | null;

export type SpawnLike = (
  cmd: string,
  args: readonly string[],
  opts: object,
) => {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer | null;
  stderr: Buffer | null;
  error?: Error;
};

export function candidatePaths(env: NodeJS.ProcessEnv, platform: string, pathMatches?: string[]): string[] {
  const isWin = platform.startsWith('win');
  // the optional third parameter injects a fabricated PATH-match list in tests
  const matches = pathMatches ?? allPathMatches('ct', env, platform as NodeJS.Platform);
  // win32 (spec): skip .cmd/.bat entirely (spawnSync shell:false fails EINVAL —
  // CVE-2024-27980) and extensionless files; any OTHER dotted extension survives.
  const filtered = isWin
    ? matches.filter((p) => {
        const base = p.split(/[\\/]/).pop() ?? '';
        const dot = base.lastIndexOf('.');
        return dot > 0 && !['.cmd', '.bat'].includes(base.slice(dot).toLowerCase());
      })
    : matches;
  const home = homedir();
  if (isWin) {
    // rows built conditionally — a row exists only when its env var is non-empty
    // (Hermes `if profile:` / `if local:` guards; never a length heuristic)
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

function defaultUsable(p: string, isWin: boolean): boolean {
  if (isWin) {
    try { return statSync(p).isFile(); } catch { return false; } // isfile: a directory named ct.exe is not a candidate
  }
  try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; }
}

const RECALL_OPTION_BASE = {
  killSignal: 'SIGKILL' as NodeJS.Signals,
  maxBuffer: 4 * 1024 * 1024,
  cwd: homedir(),
  stdio: ['ignore', 'pipe', 'pipe'] as const,
  shell: false,
  windowsHide: true,
};

export function probeIdentity(ctPath: string, opts: { timeoutMs?: number; spawnSync?: SpawnLike; env?: NodeJS.ProcessEnv } = {}): ProbeVerdict {
  const run: SpawnLike = opts.spawnSync ?? (spawnSync as unknown as SpawnLike);
  let r: ReturnType<SpawnLike>;
  try {
    r = run(ctPath, ['--help'], {
      ...RECALL_OPTION_BASE,
      timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
      env: opts.env ?? process.env,
    });
  } catch {
    return 'reject'; // m6 cycle 6: a synchronous throw (NUL-byte path, …) is a crash, not a budgeted timeout
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOBUFS') return 'reject';
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return 'timeout';
  // any OTHER error — including a bare signal-kill — is a CRASH → reject
  // (classing crashes as timeouts lets an impostor that dies on --help end
  // every walk as probe_timeout and trip the breaker before the real ct)
  return (r.stdout ?? Buffer.alloc(0)).toString('utf8').includes('Curated Thoughts') ||
    (r.stderr ?? Buffer.alloc(0)).toString('utf8').includes('Curated Thoughts')
    ? 'ok'
    : 'reject';
}

export function discoverCt(
  env: NodeJS.ProcessEnv = process.env,
  opts: { platform?: string; candidates?: string[]; usable?: (p: string) => boolean; probe?: (path: string, budgetMs: number) => ProbeVerdict; spawnSync?: SpawnLike; now?: () => number } = {},
): { path: string | null; failure: DiscoveryFailure } {
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? osPlatform();
  const isWin = platform.startsWith('win');
  const usable = opts.usable ?? ((p: string) => defaultUsable(p, isWin));
  // Opus cycle-5 M1: the probe gets THIS function's `env` parameter (where
  // renderWisdom forwards the brainDir env) — NOT opts.env (does not exist)
  const probe = opts.probe ?? ((p, budgetMs) => probeIdentity(p, { timeoutMs: budgetMs, spawnSync: opts.spawnSync, env }));
  if (acceptedCtPath) return { path: acceptedCtPath, failure: null };
  const t = now();
  if (missCache && t < missCache.until) return { path: null, failure: null };
  missCache = null;
  const walkStart = t;
  // dedupe candidates preserving first-seen order (m7 cycle 3): PATH hits and
  // the fallback list overlap (/usr/bin/ct etc.); without dedupe a rejecting
  // impostor is probed twice against the SAME cumulative 3 s deadline
  // m4 cycle 6 (Opus M2): ABSOLUTE candidates only — `join('.', 'ct')` yields
  // the bare 'ct' and pathResolve would paper over it against the harness cwd,
  // letting a repo-planted impostor pass the gate; skip anything relative
  const seen = new Set<string>();
  for (const cand of (opts.candidates ?? candidatePaths(env, platform)).filter((c) => (seen.has(c) ? false : (seen.add(c), true)))) {
    if (!isAbsolute(cand)) continue;
    if (!usable(cand)) continue;
    const budgetMs = PROBE_TIMEOUT_MS - (now() - walkStart);
    if (budgetMs <= 0) return { path: null, failure: 'probe_timeout' };
    const verdict = probe(cand, budgetMs);
    if (verdict === 'ok') { acceptedCtPath = cand; return { path: cand, failure: null }; }
    if (verdict === 'timeout') return { path: null, failure: 'probe_timeout' };
  }
  missCache = { until: now() + MISS_TTL_MS };
  return { path: null, failure: null };
}

/** PRIVATE production invalidation (Task 5 spawn path); the reset below is TEST-ONLY. */
function invalidateAcceptedPath(): void {
  acceptedCtPath = null;
}
void invalidateAcceptedPath;

export function resetDiscoveryCachesForTests(): void {
  acceptedCtPath = null;
  missCache = null;
}

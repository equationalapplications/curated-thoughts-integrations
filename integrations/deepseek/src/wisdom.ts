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

// ── Task 4: retry budget + circuit breaker ─────────────────────────────────
// ≤2 attempts per agent id, ≥60 s cooldown between them; process-wide breaker
// opens after 4 consecutive budgeted failures for 5 min, then allows ONE
// half-open attempt; a failed half-open re-opens. The per-agent map is
// LRU-capped at MEMO_MAX like the memo (unbounded failed-agent growth else).

export type BudgetVerdict = 'allow' | 'cooldown' | 'spent' | 'breaker_open';

const COOLDOWN_MS = 60_000;
const BREAKER_WINDOW_MS = 5 * 60_000;
const BREAKER_THRESHOLD = 4;

export class RetryGovernor {
  private clock: () => number;
  private agents = new Map<string, { attempts: number; lastAttemptAt: number }>();
  private consecutive = 0;
  private breakerOpenAt: number | null = null;
  private halfOpenUsed = false;

  /** TEST-ONLY deep reset (m4 cycle 6): `resetDiscoveryCachesForTests` is the single owner (`_resetWisdomStateForTests`). */
  _resetForTests(): void {
    this.agents.clear();
    this.consecutive = 0;
    this.breakerOpenAt = null;
    this.halfOpenUsed = false;
  }

  constructor(now?: () => number) {
    this.clock = now ?? (() => Date.now()); // live call, not a captured Date.now ref (m12 cycle 2)
  }

  setClock(fn: () => number): void {
    this.clock = fn;
  }

  gate(agentId: string): BudgetVerdict {
    const t = this.clock();
    // check ORDER pinned (Opus cycle-7 M3): spent → cooldown → breaker →
    // half-open grant → allow. A spent/cooldown agent NEVER consumes the
    // half-open trial — the trial is consumed ONLY when an attempt is granted.
    const rec = this.agents.get(agentId);
    if (rec) {
      if (rec.attempts >= 2) return 'spent';
      if (t - rec.lastAttemptAt < COOLDOWN_MS) return 'cooldown';
    }
    if (this.breakerOpenAt !== null) {
      if (t - this.breakerOpenAt < BREAKER_WINDOW_MS) return 'breaker_open';
      if (this.halfOpenUsed) return 'breaker_open'; // trial consumed; re-open happens at recordFailure
      this.halfOpenUsed = true; // trial consumed ONLY when an attempt is granted (fall through)
    }
    // one gate = one attempt: count it here, at the moment of the grant
    if (rec) rec.attempts += 1;
    else this.agents.set(agentId, { attempts: 1, lastAttemptAt: t });
    // LRU touch + cap (delete/re-insert keeps Map insertion order = recency)
    const entry = this.agents.get(agentId)!;
    this.agents.delete(agentId);
    this.agents.set(agentId, entry);
    entry.lastAttemptAt = t;
    while (this.agents.size > MEMO_MAX) {
      const oldest = this.agents.keys().next().value;
      if (oldest === undefined) break;
      this.agents.delete(oldest);
    }
    return 'allow';
  }

  /** Returns true when the agent's budget JUST became spent (2nd failure, both attempts granted) — the caller memoizes '' on THAT render (M3 cycle 3). */
  recordFailure(agentId: string): boolean {
    const rec = this.agents.get(agentId);
    const attempts = rec ? rec.attempts : 0;
    if (rec) rec.lastAttemptAt = this.clock();
    this.consecutive += 1;
    if (this.breakerOpenAt !== null && this.halfOpenUsed) {
      // a failed half-open probe re-opens for a FRESH 5-min window
      this.breakerOpenAt = this.clock();
      this.halfOpenUsed = false;
    } else if (this.consecutive >= BREAKER_THRESHOLD && this.breakerOpenAt === null) {
      this.breakerOpenAt = this.clock();
      this.halfOpenUsed = false;
    }
    return attempts >= 2; // both attempts granted and failed → spent THIS render
  }

  recordSuccess(agentId: string): void {
    this.agents.delete(agentId); // resets the agent's attempts
    this.consecutive = 0;
    this.breakerOpenAt = null; // closes the breaker
    this.halfOpenUsed = false;
  }
}

// module-level governor (renderWisdom uses it); re-clocked per call via setClock
const moduleGovernor = new RetryGovernor();

export function resetDiscoveryCachesForTests(): void {
  acceptedCtPath = null;
  missCache = null;
  moduleGovernor._resetForTests(); // m4 cycle 6: the reset also resets the module-level governor
}

// ── Task 3: recallWiki — pinned argv, failure classes ──────────────────────
// (no child_process import here — Task 2 already added `import { spawnSync }
// from 'node:child_process'`; re-importing would be a duplicate identifier)

export type RecallResult = { entries: WikiEntry[] | null; failure: 'timeout' | 'exit' | 'spawn' | null };

export function recallWiki(ctPath: string, query: string, deps: { spawnSync?: SpawnLike; env?: NodeJS.ProcessEnv } = {}): RecallResult {
  const run: SpawnLike = deps.spawnSync ?? (spawnSync as unknown as SpawnLike); // m2 cycle 3: the overloaded stdlib signature does not assign to SpawnLike directly
  let r: ReturnType<SpawnLike>;
  try {
    r = run(ctPath, ['recall', query, '--json', '--k', String(RECALL_K)], {
      ...RECALL_OPTION_BASE,
      timeout: RECALL_TIMEOUT_MS,
      env: deps.env ?? process.env, // Opus cycle-4 M2: brainDir-resolved env from the plugin row
    });
  } catch {
    return { entries: null, failure: 'spawn' }; // spawnSync never throws; defensive only
  }
  // classification ORDER (cycle-2 M4, revised m1 cycle 4): ENOBUFS first (parse-
  // error class), then ETIMEDOUT (timeout), then a bare signal-kill = EXIT (a
  // crash, never memoized as a timeout — Hermes: negative returncode = exit),
  // then other errors = spawn. A signal-kill falling into the parse-error path
  // would MEMOIZE a transient crash; classing it 'timeout' would let a crashing
  // impostor pin probe_timeout on every discovery walk.
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOBUFS') {
    return { entries: null, failure: null }; // overflow ≙ parse error (spec)
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { entries: null, failure: 'timeout' };
  }
  if (r.signal != null) return { entries: null, failure: 'exit' }; // crash (m1 cycle 4)
  if (r.error) return { entries: null, failure: 'spawn' };
  if (typeof r.status === 'number' && r.status !== 0) return { entries: null, failure: 'exit' };
  let data: unknown;
  try {
    data = JSON.parse((r.stdout ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    return { entries: null, failure: null };
  }
  const wiki = (data as { wiki?: unknown } | null)?.wiki;
  if (!Array.isArray(wiki)) return { entries: null, failure: null };
  const entries: WikiEntry[] = [];
  for (const item of wiki) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue; // arrays are not dicts (m5 cycle 2)
    const o = item as { title?: unknown; text?: unknown };
    entries.push({ title: typeof o.title === 'string' ? o.title : '', text: typeof o.text === 'string' ? o.text : '' });
  }
  return { entries, failure: null };
}

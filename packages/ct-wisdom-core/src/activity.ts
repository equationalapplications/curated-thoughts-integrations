/**
 * activity.ts — autonomous-work ("activity") wisdom delivery, the
 * host-neutral half (spec docs/superpowers/specs/2026-10-16-dsh-autonomous-
 * work-wisdom-design.md). A behavioral port of the Hermes reference
 * `integrations/hermes/scripts/ct_wisdom_activity.py`:
 *
 *   - the activity line builder: a deterministic rendering of ONE tool
 *     call's target from its ARGS only — never contents, output, diffs,
 *     reasoning, flag values, quoted words, assignments, URLs or
 *     credential-shaped tokens (user decision 2; INTENT rule 8: no scoring,
 *     no expansion);
 *   - the query: the bare target (A6 real-gate results), never the verb;
 *   - the key tracker: one CT call per step, only on a new key (decision 1);
 *   - the marker-first block renderer (1 fact, ≤ 600 chars, decision 5);
 *   - the match runner (shared breaker, capability latch, cache reset).
 *
 * Hosts map their own tool calls to an ActivitySpec and choose the step id
 * (DSH: the assistant message id). Every function tolerates malformed input
 * without throwing.
 */

import { Breaker } from './breaker.js';
import {
  ACTIVITY_HEADING,
  ACTIVITY_LABEL_CHARS,
  ACTIVITY_MAX_BLOCK_CHARS,
  ACTIVITY_MAX_PER_STEP,
  ACTIVITY_QUERY_CHARS,
  ACTIVITY_RECENT_KEYS_MAX,
  ACTIVITY_SESSIONS_MAX,
  ACTIVITY_STEP_IDS_MAX,
  ACTIVITY_TARGET_CHARS,
  EXCLUDE_MAX,
} from './constants.js';
import { marker, stripForged, validId } from './ledger.js';
import type {
  Correction,
  FactEntry,
  HostAdapter,
  Ledger,
  SessionRef,
  WisdomMatchResult,
} from './types.js';
import type { VerboseTurn } from './verbose.js';

export type ActivityVerb = 'read' | 'write' | 'edit' | 'search' | 'run';

/** A host's tool call, reduced to what the builder may look at. */
export type ActivitySpec =
  | { verb: 'read' | 'write' | 'edit'; path: unknown }
  | { verb: 'search'; pattern: unknown; path?: unknown }
  | { verb: 'run'; command: unknown };

/** One activity (Hermes `Activity` namedtuple). */
export interface Activity {
  verb: ActivityVerb;
  /** What the agent works on: path, `pattern[ in path]`, or `program[ word]`. */
  target: string;
  /** Rate-rule key: verb class (read/write/edit fold into `file`) + target. */
  key: string;
  /** Visible label, e.g. `read src/x.ts`. Never sent to CT. */
  line: string;
  /** The bare target CT receives (before stripForged and the cap). */
  query: string;
}

const VERB_CLASS: Record<ActivityVerb, string> = {
  read: 'file',
  write: 'file',
  edit: 'file',
  search: 'search',
  run: 'run',
};

const ELLIPSIS = '…';
/** Never used as a target: our own block text (self-trigger guard). */
const OWN_TEXT = ['ct-fact:', '## Curated Thoughts —'];
const WORD_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,39}$/;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEY_PREFIXES = ['sk-', 'sk_', 'pk_', 'rk_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_',
  'xox', 'akia', 'asia', 'aiza', 'glpat-', 'eyj'];
const OPERATOR_CHARS = new Set([';', '|', '&', '<', '>', '(', ')', '`']);
/** Programs whose first argument is free text or a value: keep only the name. */
const FREE_TEXT_PROGRAMS = new Set(['echo', 'printf', 'export', 'set', 'unset', 'alias', 'eval',
  'exec', 'env', 'sudo', 'su', 'doas', 'ssh', 'scp', 'curl', 'wget', 'http', 'https', 'nc',
  'telnet', 'openssl', 'gpg', 'pass', 'security', 'op', 'vault']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const PYTHON_RE = /^python[0-9.]*$/;
const DRIVE_RE = /^[A-Za-z]:$/;

/** True for Curated Thoughts' own tools (decision 6: never a trigger). */
export function isCtTool(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const lowered = name.toLowerCase();
  if (lowered.includes('curated-thoughts') || lowered.includes('curated_thoughts')) return true;
  const parts = lowered.split(/__|\./);
  return (parts[parts.length - 1] ?? '').startsWith('curated_');
}

/** A known key prefix, or 16+ chars with 3+ digits. */
export function credentialShaped(token: string): boolean {
  const lowered = token.toLowerCase();
  if (KEY_PREFIXES.some((p) => lowered.startsWith(p))) return true;
  let digits = 0;
  for (const ch of token) if (ch >= '0' && ch <= '9') digits++;
  return [...token].length >= 16 && digits >= 3;
}

function safeWord(token: unknown): boolean {
  return typeof token === 'string' && WORD_RE.test(token) && !credentialShaped(token);
}

function cleanTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '' || CONTROL_RE.test(v)) return null;
  if (OWN_TEXT.some((own) => v.includes(own))) return null;
  return v;
}

/** Python posixpath.normpath. */
function normpath(path: string): string {
  if (path === '') return '.';
  let initial = path.startsWith('/') ? 1 : 0;
  if (initial && path.startsWith('//') && !path.startsWith('///')) initial = 2;
  const out: string[] = [];
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initial && out.length === 0) || (out.length > 0 && out[out.length - 1] === '..')) {
      out.push(comp);
    } else if (out.length > 0) {
      out.pop();
    }
  }
  const joined = '/'.repeat(initial) + out.join('/');
  return joined || '.';
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// ─────────────────────────────────────────────────────────────────────────
// Privacy rules R1–R4 — IDENTICAL to the Hermes builder (hermes 0.6.2,
// ct_wisdom_activity.py, spec "Privacy amendment"); the shared vectors in
// tests/fixtures/activity_targets.json run against both. A user name never
// leaves the machine.
// ─────────────────────────────────────────────────────────────────────────

/** The environment view the builder reads (user names, HOME for `~`). */
export type ActivityEnv = Record<string, string | undefined>;

const DRIVE_PREFIX_RE = /^[A-Za-z]:(\/|$)/;
const QUOTE_CHARS = new Set(['"', "'", '`', '\u2018', '\u2019', '\u201c', '\u201d']);
const HOME_PARENTS = new Set(['users', 'home']);

/** Comparison form: NFC (macOS paths are often NFD) and case-folded (≈ Python casefold). */
function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}

function envStr(env: ActivityEnv, name: string): string | null {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function homeOf(env: ActivityEnv): string | null {
  return envStr(env, 'HOME') ?? envStr(env, 'USERPROFILE');
}

/** Python posixpath.dirname. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/') + 1;
  let head = path.slice(0, i);
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return head;
}

/**
 * Folded names of the current user: USER, LOGNAME, USERNAME and the
 * basename of HOME / USERPROFILE (Hermes `user_names`).
 */
export function userNames(env: ActivityEnv = process.env): Set<string> {
  const names = new Set<string>();
  for (const name of ['USER', 'LOGNAME', 'USERNAME']) {
    const v = envStr(env, name);
    if (v) names.add(fold(v));
  }
  for (const name of ['HOME', 'USERPROFILE']) {
    const v = envStr(env, name);
    if (!v) continue;
    const base = basename(v.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (base && !base.endsWith(':')) names.add(fold(base));
  }
  for (const bad of ['', '.', '..']) names.delete(bad);
  return names;
}

/**
 * Normalized '/' form of an absolute path (drive letter lowercased, a
 * leading `~` or `~/` expanded from HOME), or null when it is not one.
 */
function absNorm(raw: string, env: ActivityEnv): string | null {
  let path = raw.replace(/\\/g, '/');
  if (path === '~' || path.startsWith('~/')) {
    const home = homeOf(env);
    if (home === null) return null;
    path = home.replace(/\\/g, '/').replace(/\/+$/, '') + path.slice(1);
  }
  if (DRIVE_PREFIX_RE.test(path)) {
    path = path[0].toLowerCase() + path.slice(1);
  } else if (!path.startsWith('/')) {
    return null;
  }
  return normpath(path);
}

function depth(norm: string): number {
  let parts = norm.split('/').filter((p) => p !== '');
  if (parts.length > 0 && DRIVE_RE.test(parts[0])) parts = parts.slice(1);
  return parts.length;
}

/**
 * R1: the normalized cwd, or null when it does not count: empty, not
 * absolute, `/`, a drive root, any cwd of depth < 2 (`/Users`, `/home`,
 * `C:/Users`) or the parent of the user's home directory.
 */
export function validCwd(cwd: unknown, env: ActivityEnv = process.env): string | null {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const norm = absNorm(cwd.trim(), env);
  if (norm === null || depth(norm) < 2) return null;
  const home = homeOf(env);
  const homeNorm = home ? absNorm(home, env) : null;
  if (homeNorm && fold(dirname(homeNorm)) === fold(norm)) return null;
  return norm;
}

/** R2: drop every user-name component, and `Users`/`home` right before one. */
function dropNames(parts: string[], names: Set<string>): string[] {
  const out: string[] = [];
  parts.forEach((part, i) => {
    const folded = fold(part);
    if (names.has(folded)) return;
    if (HOME_PARENTS.has(folded) && i + 1 < parts.length && names.has(fold(parts[i + 1]))) return;
    out.push(part);
  });
  return out;
}

/**
 * True when R2 would leave `token` (one word of a search pattern or a
 * command's subcommand) exactly as it is: relative, no `..`, no user-name
 * component. An absolute, `~`, drive or UNC token fails.
 */
export function pathTokenOk(token: string, names: Set<string>): boolean {
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('\\\\')) return false;
  if (DRIVE_PREFIX_RE.test(token.replace(/\\/g, '/'))) return false;
  const comps = token.split(/[/\\]/);
  if (comps.includes('..')) return false;
  return !comps.some((c) => names.has(fold(c)));
}

/**
 * Relative, machine-neutral form of a path argument, or null.
 *
 * R2: an absolute (or `~`) path under a valid cwd (R1, `validCwd`) becomes
 * relative to it; any other absolute or `~` path is reduced to its basename.
 * Relative paths are kept, leading `..` dropped. Then every component equal
 * to the user's name (`userNames`), and `Users`/`home` right before one, is
 * dropped. Null when nothing is left.
 */
export function normalizePath(raw: unknown, cwd?: string | null, env: ActivityEnv = process.env): string | null {
  const cleaned = cleanTarget(raw);
  if (cleaned === null) return null;
  const path = cleaned.replace(/\\/g, '/');
  let parts: string[];
  if (path.startsWith('/') || path.startsWith('~') || DRIVE_PREFIX_RE.test(path)) {
    const norm = absNorm(path, env);
    const base = validCwd(cwd, env);
    if (norm !== null && base !== null && norm.startsWith(`${base}/`)) {
      parts = norm.slice(base.length + 1).split('/');
    } else {
      parts = normpath(path).split('/').filter((p) => p !== '' && p !== '.' && p !== '..' && !DRIVE_RE.test(p));
      parts = parts.slice(-1);
      if (parts.length > 0 && parts[0].startsWith('~')) parts = [];
    }
  } else {
    parts = normpath(path).split('/');
  }
  parts = parts.filter((p) => p !== '' && p !== '.' && p !== '~');
  while (parts.length > 0 && parts[0] === '..') parts = parts.slice(1);
  parts = dropNames(parts, userNames(env));
  if (parts.length === 0) return null;
  let target = parts.join('/');
  if (target.length > ACTIVITY_TARGET_CHARS) {
    const tail = target.slice(-ACTIVITY_TARGET_CHARS);
    const cut = tail.indexOf('/');
    target = cut < 0 ? tail : tail.slice(cut + 1);
  }
  return target || null;
}

/**
 * R3: the search pattern to send (≤ ACTIVITY_TARGET_CHARS), or null when it
 * has an `=`, any quote, a credential-shaped word, or a word R2 would change.
 */
export function searchTarget(pattern: unknown, env: ActivityEnv = process.env): string | null {
  const cleaned = cleanTarget(pattern);
  if (cleaned === null || [...cleaned].some((ch) => ch === '=' || QUOTE_CHARS.has(ch))) return null;
  const names = userNames(env);
  for (const word of cleaned.split(/\s+/).filter((w) => w !== '')) {
    if (credentialShaped(word) || !pathTokenOk(word, names)) return null;
  }
  return cleaned.slice(0, ACTIVITY_TARGET_CHARS);
}


/**
 * Shell words with their quotes KEPT, exactly like Python
 * `shlex.split(command, posix=False)`: whitespace splits, a quoted word that
 * starts a token ends at its closing quote. Throws on an unterminated quote.
 * A quoted value (`grep "Secret"`) therefore fails the word shape and is
 * never sent.
 */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) throw new Error('No closing quotation');
      out.push(command.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < command.length && !isSpace(command[j])) j++;
    out.push(command.slice(i, j));
    i = j;
  }
  return out;
}

function tokens(command: string): string[] {
  try {
    return shellWords(command);
  } catch {
    return command.split(/[ \t\r\n]+/).filter((t) => t !== '');
  }
}

/**
 * Program plus the next safe word of the first simple command (decision 2),
 * or null. The second word is the one right after the program, never a
 * flag's value (`psql -W secretpw` → `psql`); `python -m <module>` is the
 * one supported form. A program named like the user gives null; a second
 * word R2 would change is dropped. Everything else is dropped.
 */
export function commandTarget(command: unknown, env: ActivityEnv = process.env): string | null {
  const cleaned = cleanTarget(command);
  if (cleaned === null) return null;
  const names = userNames(env);
  let words: string[] = [];
  for (const token of tokens(cleaned)) {
    if (token === '' || [...token].some((ch) => OPERATOR_CHARS.has(ch))) break;
    words.push(token);
  }
  while (words.length > 0 && ASSIGN_RE.test(words[0])) words = words.slice(1);
  if (words.length === 0) return null;
  const program = basename(words[0].replace(/\\/g, '/'));
  if (!safeWord(program) || names.has(fold(program))) return null;
  if (FREE_TEXT_PROGRAMS.has(program.toLowerCase())) return program;
  let rest = words.slice(1);
  if (PYTHON_RE.test(program) && rest[0] === '-m') {
    rest = rest.slice(1);
  } else if (rest.length > 0 && rest[0].startsWith('-')) {
    return program;
  }
  if (rest.length > 0 && safeWord(rest[0]) && pathTokenOk(rest[0], names)) return `${program} ${rest[0]}`;
  return program;
}

function make(verb: ActivityVerb, target: string, line: string, query: string): Activity {
  return { verb, target, key: `${VERB_CLASS[verb]}\u0000${target}`, line, query };
}

/**
 * The activity for one tool call, built from its args only, or null.
 * R4: `line` (the visible `_for:` label and the verbose `activity` field)
 * and `query` come from the same sanitized target, never a raw argument.
 * `env` defaults to process.env (user names, HOME for `~`).
 */
export function buildActivity(
  spec: ActivitySpec | null | undefined,
  cwd?: string | null,
  env: ActivityEnv = process.env,
): Activity | null {
  if (spec === null || typeof spec !== 'object') return null;
  switch (spec.verb) {
    case 'read':
    case 'write':
    case 'edit': {
      const target = normalizePath(spec.path, cwd, env);
      return target === null ? null : make(spec.verb, target, `${spec.verb} ${target}`, target);
    }
    case 'search': {
      const pattern = searchTarget(spec.pattern, env);
      if (pattern === null) return null;
      const where = spec.path ? normalizePath(spec.path, cwd, env) : null;
      const target = pattern + (where ? ` in ${where}` : '');
      return make('search', target, `search ${target}`, pattern);
    }
    case 'run': {
      const target = commandTarget(spec.command, env);
      return target === null ? null : make('run', target, `run ${target}`, target);
    }
    default:
      return null;
  }
}


/** The text sent to CT: the bare target (A6), never the verb. */
export function activityQuery(activity: Activity): string {
  return stripForged(activity.query).trim().slice(0, ACTIVITY_QUERY_CHARS);
}

// ─────────────────────────────────────────────────────────────────────────
// key tracker and per-step rate rule
// ─────────────────────────────────────────────────────────────────────────

export type ActivityRefusal = 'step_used' | 'seen_key';

interface TrackerSession {
  keys: Map<string, true>;
  steps: Map<string, true>;
  reported: Map<string, true>;
}

function bump(map: Map<string, true>, key: string, max: number): void {
  map.delete(key);
  map.set(key, true);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Per session: recent activity keys (LRU) and steps that already started a
 * query. `admit` is the whole rate rule (Hermes ActivityState).
 */
export class ActivityTracker {
  private readonly sessions = new Map<string, TrackerSession>();

  private state(sessionId: string): TrackerSession {
    let s = this.sessions.get(sessionId);
    if (s === undefined) {
      s = { keys: new Map(), steps: new Map(), reported: new Map() };
    } else {
      this.sessions.delete(sessionId);
    }
    this.sessions.set(sessionId, s);
    while (this.sessions.size > ACTIVITY_SESSIONS_MAX) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return s;
  }

  /** null when this call may start the step's query (and records it); a rejected call changes nothing. */
  admit(sessionId: string, stepId: string, key: string): ActivityRefusal | null {
    const s = this.state(sessionId);
    if (s.steps.has(stepId)) return 'step_used';
    if (s.keys.has(key)) {
      bump(s.keys, key, ACTIVITY_RECENT_KEYS_MAX);
      return 'seen_key';
    }
    bump(s.keys, key, ACTIVITY_RECENT_KEYS_MAX);
    bump(s.steps, stepId, ACTIVITY_STEP_IDS_MAX);
    return null;
  }

  /** What admit() would answer, without recording anything. */
  peek(sessionId: string, stepId: string, key: string): ActivityRefusal | null {
    const s = this.state(sessionId);
    if (s.steps.has(stepId)) return 'step_used';
    return s.keys.has(key) ? 'seen_key' : null;
  }

  /**
   * True once per step: bounds verbose skip records (a blocked would-be
   * trigger) to one per step. Needed by per-TOOL hosts (Hermes
   * `pre_tool_call`, OpenCode `tool.execute.before`, OpenClaw
   * `before_tool_call`), where every call of one step reaches the gate.
   * DSH plans a whole step once, so it does not need it.
   */
  firstReport(sessionId: string, stepId: string): boolean {
    const s = this.state(sessionId);
    if (s.reported.has(stepId)) return false;
    bump(s.reported, stepId, ACTIVITY_STEP_IDS_MAX);
    return true;
  }

  reset(): void {
    this.sessions.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// render
// ─────────────────────────────────────────────────────────────────────────

function oneLine(value: unknown): string {
  return stripForged(typeof value === 'string' ? value : '').trim().replace(/[\n\r]/g, ' ');
}

export interface ActivityCandidate {
  item: FactEntry | Correction;
  /** Ledger ids a correction supersedes (empty for an entry). */
  superseded: string[];
}

/**
 * Delivery order: corrections that supersede an id in context first, then
 * entries not already in context. Invalid ids never render (the ledger could
 * not track them).
 */
export function activityCandidates(result: WisdomMatchResult, ledger: Ledger): ActivityCandidate[] {
  const out: ActivityCandidate[] = [];
  const seen = new Set<string>();
  const inLedger = (id: string) => seen.has(id) || ledger.has(id);
  for (const it of Array.isArray(result?.corrections) ? result.corrections : []) {
    if (it === null || typeof it !== 'object' || !validId(it.id)) continue;
    const sup = (Array.isArray(it.supersedes) ? it.supersedes : []).filter(
      (s): s is string => validId(s) && ledger.has(s),
    );
    if (inLedger(it.id) || sup.length === 0) continue;
    seen.add(it.id);
    out.push({ item: it, superseded: sup });
  }
  for (const it of Array.isArray(result?.entries) ? result.entries : []) {
    if (it === null || typeof it !== 'object' || !validId(it.id)) continue;
    if (inLedger(it.id)) continue;
    seen.add(it.id);
    out.push({ item: it, superseded: [] });
  }
  return out;
}

/**
 * One fact, marker FIRST (so truncation can never show the fact without its
 * marker), at most ACTIVITY_MAX_BLOCK_CHARS; '' when it cannot fit.
 */
export function renderActivityBlock(
  item: FactEntry | Correction,
  superseded: string[],
  activity: Activity,
): string {
  if (item === null || typeof item !== 'object' || !validId(item.id)) return '';
  let label = oneLine(activity?.line);
  if (label.length > ACTIVITY_LABEL_CHARS) label = label.slice(0, ACTIVITY_LABEL_CHARS - 1) + ELLIPSIS;
  const head = `${ACTIVITY_HEADING}\n_for: ${label}_\n\n`;
  const title = oneLine(item.title);
  const text = stripForged(typeof item.text === 'string' ? item.text : '');
  if (!title && !text.trim()) return '';
  const provenance = oneLine(typeof item.provenance === 'string' && item.provenance ? item.provenance : 'unlabeled');
  let titleLine = `${marker(item.id)} **${title}** (provenance: ${provenance})`;
  const sup = superseded.filter(validId);
  if (sup.length > 0) titleLine += ` — supersedes ${sup.map((s) => `ct-fact:${s}`).join(', ')}`;
  const remaining = ACTIVITY_MAX_BLOCK_CHARS - head.length;
  if (remaining <= titleLine.length + 1) return '';
  let body = `${titleLine}\n${text}`;
  if (body.length > remaining) {
    body = `${titleLine}\n${text.slice(0, remaining - titleLine.length - 1 - ELLIPSIS.length)}${ELLIPSIS}`;
  }
  return head + body;
}

/** The first candidate that renders (ACTIVITY_MAX_PER_STEP = 1), or null. */
export function selectActivityDelivery(
  result: WisdomMatchResult,
  ledger: Ledger,
  activity: Activity,
): { block: string; id: string } | null {
  for (const { item, superseded } of activityCandidates(result, ledger)) {
    const block = renderActivityBlock(item, superseded, activity);
    if (block !== '') return { block, id: item.id };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// match
// ─────────────────────────────────────────────────────────────────────────

export interface ActivityMatch {
  /** null on success; else capability_missing | spawn | timeout_or_exit | parse_error | hook_failed. */
  failure: string | null;
  result?: WisdomMatchResult;
}

/**
 * `ct wisdom match --max 1 -- <bare target>` through the host adapter, with
 * the same breaker bookkeeping as the user-turn path (the breaker is SHARED:
 * three failures pause both paths). Never throws.
 */
export async function runActivityMatch(
  host: HostAdapter,
  activity: Activity,
  exclude: string[],
  breaker: Breaker,
): Promise<ActivityMatch> {
  try {
    if (host.wisdomMatchAbsent()) return { failure: 'capability_missing' };
    const attempt = await host.wisdomMatch(activityQuery(activity), ACTIVITY_MAX_PER_STEP, exclude);
    if (attempt.outcome === 'spawn') {
      host.resetDiscoveryAndProbeCaches();
      return { failure: 'spawn' };
    }
    if (attempt.outcome === 'timeout_or_exit') {
      breaker.recordFailure();
      // The adapter latches a missing subcommand as timeout_or_exit too.
      return { failure: host.wisdomMatchAbsent() ? 'capability_missing' : 'timeout_or_exit' };
    }
    if (!attempt.result) return { failure: 'parse_error' };
    breaker.recordSuccess();
    return { failure: null, result: attempt.result };
  } catch {
    return { failure: 'hook_failed' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// host-neutral gates: the SAME preconditions onUserTurn enforces, so no
// host can skip them for activity delivery (a resume-OFF latch such as
// Claude Code's, the restored-session fail-closed rule, the capability
// latch, the shared breaker, delivered-id bookkeeping).
// ─────────────────────────────────────────────────────────────────────────

export type ActivityGate =
  | { ok: true; ledger: Ledger }
  | { ok: false; reason: string; ledger?: Ledger };

/**
 * Whether activity delivery may run for this session now, and the ledger
 * rebuilt from host-persisted context. Reasons: `no_session`,
 * `delivery_off`, `restored_unknown_bootstrap`, `capability_missing`,
 * `breaker_open` (the last two only when `breaker` is given: before a query).
 */
export function activityGate(host: HostAdapter, session: SessionRef, breaker?: Breaker): ActivityGate {
  if (!session || typeof session.id !== 'string' || session.id === '') return { ok: false, reason: 'no_session' };
  if (!host.deliveryEnabled(session)) return { ok: false, reason: 'delivery_off' };
  const ledger = host.rebuildLedger(session);
  if (host.restored(session) && !ledger.knownBootstrap) return { ok: false, reason: 'restored_unknown_bootstrap', ledger };
  if (breaker !== undefined) {
    if (host.wisdomMatchAbsent()) return { ok: false, reason: 'capability_missing', ledger };
    if (breaker.isOpen()) return { ok: false, reason: 'breaker_open', ledger };
  }
  return { ok: true, ledger };
}

/** Verbose record for an activity (channel `activity`); never throws. */
export function reportActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  turn: Omit<VerboseTurn, 'sessionId' | 'channel' | 'activity' | 'query'>,
): void {
  if (typeof host.recordVerbose !== 'function') return;
  try {
    host.recordVerbose({
      ...turn,
      sessionId: typeof session?.id === 'string' ? session.id : '',
      channel: 'activity',
      query: activityQuery(activity),
      activity: oneLine(activity.line),
    });
  } catch {
    /* fail quietly (INTENT rule 4) */
  }
}

export type ActivityStart =
  | { failure: null; match: Promise<ActivityMatch> }
  | { failure: string };

/**
 * Start the activity's one CT query, behind every gate: the gate's ledger
 * gives the `--exclude` bound (newest first, ≤ EXCLUDE_MAX). A refused start
 * makes no CT call; the caller decides whether to report it (hosts report
 * at most once per step, see ActivityTracker.firstReport).
 */
export function startActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  breaker: Breaker,
): ActivityStart {
  try {
    const gate = activityGate(host, session, breaker);
    if (!gate.ok) return { failure: gate.reason };
    const exclude = gate.ledger.idsMostRecentFirst.slice(0, EXCLUDE_MAX);
    return { failure: null, match: runActivityMatch(host, activity, exclude, breaker) };
  } catch {
    return { failure: 'hook_failed' };
  }
}

/**
 * Finish an activity: `match` is the settled query, or null when it ran
 * past the host's budget. Re-checks the gates against a FRESH ledger,
 * selects one fact, records it (`noteDelivered` and the N3 turn cache, so a
 * CT recall later in the turn stubs it) and reports every outcome to
 * verbose mode. Resolves to the block for the host to place on its channel,
 * or null. Never throws.
 */
export function finishActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  match: ActivityMatch | null,
): string | null {
  const skip = (reason: string, extra: Partial<VerboseTurn> = {}): null => {
    reportActivity(host, session, activity, { kind: 'skip', reason, ...extra });
    return null;
  };
  try {
    if (match === null) return skip('budget');
    if (match.failure !== null || !match.result) return skip(match.failure ?? 'parse_error');
    const gate = activityGate(host, session);
    if (!gate.ok) return skip(gate.reason);
    const ledger = gate.ledger;
    const ledgerIds = [...ledger.idsMostRecentFirst];
    const sel = selectActivityDelivery(match.result, ledger, activity);
    if (sel === null) return skip('zero_hits', { result: match.result, ledgerIds });
    host.noteDelivered(session, [sel.id]);
    const cached = host.cachedLedger ? host.cachedLedger(session) : null;
    const merged = [sel.id];
    for (const id of [...ledgerIds, ...(cached?.idsMostRecentFirst ?? [])]) {
      if (!merged.includes(id)) merged.push(id);
    }
    const set = new Set(merged);
    host.cacheLedger(session, {
      idsMostRecentFirst: merged,
      has: (id) => set.has(id),
      knownBootstrap: ledger.knownBootstrap || (cached?.knownBootstrap ?? false),
    });
    reportActivity(host, session, activity, {
      kind: 'delivery',
      reason: null,
      result: match.result,
      ledgerIds,
      deliveredIds: [sel.id],
      block: sel.block,
    });
    return sel.block;
  } catch {
    return skip('hook_failed');
  }
}

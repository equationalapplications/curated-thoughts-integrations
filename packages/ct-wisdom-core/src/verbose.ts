/**
 * verbose.ts — opt-in verbose mode for Intuitive Wisdom live delivery
 * (spec docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md).
 *
 * With CT_WISDOM_VERBOSE=1 the engine reports every exit of `onUserTurn` to
 * the adapter's `recordVerbose`, which this module builds: one JSON Lines
 * record in the host's log (CT_WISDOM_VERBOSE_LOG overrides it) and one
 * readable notice to a host channel the user sees and the model does not.
 *
 * Cache safety (INTENT rule 2): nothing here returns into the delivery path.
 * The recorder runs after the decision, reads copies, and returns void.
 * Fail quietly (rule 4): every step swallows its own errors. Records are
 * built from an allowlist; the environment is never logged.
 * Field names match the Python twin (hermes scripts/ct_wisdom_verbose.py).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { WisdomMatchResult } from './types.js';

export const VERBOSE_ENV = 'CT_WISDOM_VERBOSE';
export const VERBOSE_LOG_ENV = 'CT_WISDOM_VERBOSE_LOG';
export const VERBOSE_LOG_NAME = 'ct-wisdom-verbose.jsonl';
export const VERBOSE_SCHEMA = 1;
/** Rotate to `<file>.1` past this size. */
export const VERBOSE_MAX_LOG_BYTES = 5 * 1024 * 1024;

export type VerboseHost = 'deepseek' | 'opencode' | 'openclaw';
type Env = Record<string, string | undefined>;

/** What the engine hands the recorder at one exit of onUserTurn. */
export interface VerboseTurn {
  kind: 'delivery' | 'skip';
  sessionId: string;
  /** null for a delivery; the non-delivery class otherwise. */
  reason: string | null;
  query?: string;
  result?: WisdomMatchResult;
  ledgerIds?: string[];
  deliveredIds?: string[];
  block?: string;
  /**
   * Overrides the recorder's channel for this record: autonomous-work
   * deliveries report `activity` (Hermes parity). Absent on user turns.
   */
  channel?: string;
  /** Autonomous-work label, e.g. `read src/x.ts` (never sent to CT). */
  activity?: string;
}

export type MatchOutcomeLabel = 'delivered' | 'in_context' | 'budget' | 'not_applicable';

export interface VerboseMatched {
  id: string | null;
  kind: 'entry' | 'correction';
  title: string;
  text: string;
  score: number | null;
  provenance: string | null;
  supersedes: string[];
  outcome: MatchOutcomeLabel;
}

/** The v1 log record (same fields as the Python twin). */
export interface VerboseRecord {
  v: number;
  ts: string;
  host: string;
  channel: string;
  session_id: string;
  event: 'delivery' | 'skip';
  reason: string | null;
  query?: string;
  activity?: string;
  gate?: string | null;
  matched?: VerboseMatched[];
  delivered_ids?: string[];
  block_chars?: number;
  block?: string;
  ledger_size?: number;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);

export function verboseEnabled(env: Env | undefined): boolean {
  const value = env?.[VERBOSE_ENV];
  return typeof value === 'string' && TRUE.has(value.trim().toLowerCase());
}

function expandTilde(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

function nonBlank(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The host's default verbose log (spec D4); `home` is injectable for tests. */
export function defaultVerboseLogPath(
  host: VerboseHost,
  env: Env,
  home: string = homedir(),
): string {
  switch (host) {
    case 'deepseek': {
      const dsh = nonBlank(env.DSH_HOME);
      return join(dsh ? expandTilde(dsh, home) : join(home, '.dsh'), 'logs', VERBOSE_LOG_NAME);
    }
    case 'opencode': {
      const data = nonBlank(env.XDG_DATA_HOME) ?? join(home, '.local', 'share');
      return join(data, 'opencode', 'log', VERBOSE_LOG_NAME);
    }
    case 'openclaw': {
      const state = nonBlank(env.OPENCLAW_STATE_DIR);
      return join(state ? expandTilde(state, home) : join(home, '.openclaw'), 'logs', VERBOSE_LOG_NAME);
    }
  }
}

/** CT_WISDOM_VERBOSE_LOG when set (with `~` expanded), else `fallback`. */
export function resolveVerboseLogPath(env: Env, fallback: string | null): string | null {
  const override = nonBlank(env[VERBOSE_LOG_ENV]);
  return override ? expandTilde(override.trim(), homedir()) : fallback;
}

// ─────────────────────────────────────────────────────────────────────────
// record building (allowlist only)
// ─────────────────────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function scoreOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function matched(
  result: WisdomMatchResult | undefined,
  ledger: Set<string>,
  delivered: Set<string>,
): VerboseMatched[] {
  const out: VerboseMatched[] = [];
  const lists: Array<['entry' | 'correction', unknown]> = [
    ['entry', result?.entries],
    ['correction', result?.corrections],
  ];
  for (const [kind, list] of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const id = str(item.id);
      let outcome: MatchOutcomeLabel = 'budget';
      if (id !== null && delivered.has(id)) outcome = 'delivered';
      else if (id !== null && ledger.has(id)) outcome = 'in_context';
      out.push({
        id,
        kind,
        title: str(item.title) ?? '',
        text: str(item.text) ?? '',
        score: scoreOf(item.score),
        provenance: str(item.provenance),
        supersedes: strings(item.supersedes),
        outcome,
      });
    }
  }
  return out;
}

/** Split of the old catch-all `zero_hits` (spec D4). */
function zeroHitsReason(gate: string | null, items: VerboseMatched[]): string {
  if (items.length === 0) return gate === 'uncalibrated' ? 'gate_uncalibrated' : 'no_match';
  const outcomes = new Set(items.map((m) => m.outcome));
  if (outcomes.has('budget')) return 'budget';
  if (outcomes.has('in_context')) return 'deduped';
  return 'no_match';
}

export function buildRecord(
  turn: VerboseTurn,
  opts: { host: string; channel: string; now?: () => Date },
): VerboseRecord {
  const ledger = new Set(strings(turn.ledgerIds));
  const delivered = strings(turn.deliveredIds);
  const result = turn.result;
  const gate = result ? str((result as { gate?: unknown }).gate) : null;
  const items = matched(result, ledger, new Set(delivered));
  let reason: string | null = turn.kind === 'delivery' ? null : (str(turn.reason) ?? 'unknown');
  if (reason === 'zero_hits') reason = zeroHitsReason(gate, items);
  const record: VerboseRecord = {
    v: VERBOSE_SCHEMA,
    ts: (opts.now ? opts.now() : new Date()).toISOString(),
    host: opts.host,
    channel: str(turn.channel) ?? opts.channel,
    session_id: str(turn.sessionId) ?? '',
    event: turn.kind === 'delivery' ? 'delivery' : 'skip',
    reason,
  };
  const query = str(turn.query);
  if (query !== null) record.query = query;
  const activity = str(turn.activity);
  if (activity !== null) record.activity = activity;
  if (result) {
    record.gate = gate;
    record.matched = items;
  }
  if (turn.kind === 'delivery') {
    const block = str(turn.block) ?? '';
    record.delivered_ids = delivered;
    record.block_chars = block.length;
    record.block = block;
  }
  if (turn.ledgerIds !== undefined) record.ledger_size = ledger.size;
  return record;
}

// ─────────────────────────────────────────────────────────────────────────
// formatting (notice + reader)
// ─────────────────────────────────────────────────────────────────────────

const MARK: Record<string, string> = { delivered: '+', in_context: '=', budget: '-', not_applicable: '-' };
const NOTE: Record<string, string> = {
  in_context: ' (already in context)',
  budget: ' (did not fit)',
  not_applicable: ' (supersedes nothing in context)',
};

export function matchedLines(record: Partial<VerboseRecord>): string[] {
  const out: string[] = [];
  for (const m of Array.isArray(record.matched) ? record.matched : []) {
    if (m === null || typeof m !== 'object') continue;
    const score = typeof m.score === 'number' ? m.score.toFixed(3) : '-';
    const title = String(m.title ?? '').replace(/\n/g, ' ').slice(0, 80);
    out.push(
      `  ${MARK[m.outcome] ?? '?'} ${m.id} ${score} ${m.provenance || 'unlabeled'}${NOTE[m.outcome] ?? ''} "${title}"`,
    );
  }
  return out;
}

export function summary(record: Partial<VerboseRecord>): string {
  let head: string;
  if (record.event === 'delivery') {
    const n = Array.isArray(record.delivered_ids) ? record.delivered_ids.length : 0;
    head = `delivered ${n} fact${n === 1 ? '' : 's'} (${record.block_chars ?? 0} chars)`;
  } else {
    head = `nothing delivered (${record.reason})`;
  }
  if (record.gate) head += ` gate=${record.gate}`;
  return head;
}

/** The readable text shown to the user for one record. */
export function formatNotice(record: VerboseRecord): string {
  const lines = [`Curated Thoughts wisdom: ${summary(record)} [${record.channel}]`, ...matchedLines(record)];
  if (record.block) lines.push('', record.block);
  return lines.join('\n');
}

/** One reader entry (same layout as the Python ct_wisdom_log.py). */
export function formatLogLine(record: Partial<VerboseRecord>, withBlock: boolean): string {
  const lines = [
    `${record.ts ?? '?'} ${record.host ?? '?'} ${record.channel ?? '?'} session=${record.session_id || '-'}  ${summary(record)}`,
  ];
  if (typeof record.query === 'string') {
    const q = record.query.replace(/\n/g, ' ');
    lines.push(`  query: "${q.length > 160 ? `${q.slice(0, 157)}...` : q}"`);
  }
  lines.push(...matchedLines(record));
  if (withBlock && record.block) lines.push('', record.block, '');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// output
// ─────────────────────────────────────────────────────────────────────────

export function appendRecord(path: string, record: VerboseRecord, maxBytes = VERBOSE_MAX_LOG_BYTES): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch {
    /* no file yet */
  }
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
}

export interface VerboseRecorderOptions {
  host: VerboseHost;
  channel: string;
  env: Env;
  /** The host's default log; CT_WISDOM_VERBOSE_LOG overrides it; null = no log. */
  logPath: string | null;
  /** The user-only channel (spec D3). */
  notify?: (text: string, record: VerboseRecord) => unknown;
  now?: () => Date;
  maxBytes?: number;
}

/**
 * The adapter's `recordVerbose`, or undefined when verbose mode is off (so an
 * adapter with verbose off is exactly the adapter without this feature).
 */
export function createVerboseRecorder(
  opts: VerboseRecorderOptions,
): ((turn: VerboseTurn) => void) | undefined {
  if (!verboseEnabled(opts.env)) return undefined;
  const path = resolveVerboseLogPath(opts.env, opts.logPath);
  return (turn: VerboseTurn) => {
    let record: VerboseRecord;
    try {
      if (turn === null || typeof turn !== 'object') return;
      record = buildRecord(turn, { host: opts.host, channel: opts.channel, now: opts.now });
    } catch {
      return;
    }
    try {
      if (path) appendRecord(path, record, opts.maxBytes);
    } catch {
      /* fail quietly */
    }
    try {
      const pending = opts.notify?.(formatNotice(record), record);
      // An async channel (a toast) must not leak an unhandled rejection.
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        (pending as Promise<unknown>).then(undefined, () => {});
      }
    } catch {
      /* fail quietly */
    }
  };
}

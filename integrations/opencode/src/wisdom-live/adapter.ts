/**
 * wisdom-live/adapter.ts — the OpenCode HostAdapter binding for the shared
 * `ct-wisdom-core` algorithm. Contract: parent spec
 * docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md
 * (OpenCode row) as refined by the leg spec
 * docs/superpowers/specs/2026-10-16-opencode-wisdom-parity-leg-design.md —
 * host facts H1–H8 were read from the pinned 1.18.35 binary; do not re-derive.
 *
 *   N1 trigger   — `chat.message` (index.ts). The in-flight message is NOT yet
 *                  persisted while the hook runs (H1).
 *   N2 delivery  — a `synthetic: true` text part pushed on output.parts with a
 *                  host-format `prt_` id (LD9); the host persists it (H1).
 *   N3 transform — `tool.execute.after`. For MCP tools the hook output is the
 *                  raw MCP CallToolResult; the host derives the persisted
 *                  `state.output` from `content[].text` AFTER the hook (H5), so
 *                  the rewrite targets the content text item (LD2). Tool names
 *                  are `<server>_<tool>` (H6).
 *   Ledger (N4)  — persisted history via client.session.messages() (every row;
 *                  never compaction-filtered, H3) ∪ compaction carry set ∪
 *                  bootstrap memo ids ∪ ids this process delivered (LD5).
 *   Compaction   — decision 3 carry-forward: the pre-compaction ledger is
 *                  snapshotted into a per-process carry set that is never
 *                  cleared, so post-compaction ⊇ pre-compaction ∪ deliveries.
 *   Subagents    — parent-only delivery (LD7): `parentID` set or lookup
 *                  failure ⇒ no N1/N2; N3 dedups against child ∪ parent
 *                  history, best-effort.
 *   Restore      — none separate: resume rebuilds from the same history (LD10).
 *   Activity     — autonomous-work delivery (spec 2026-10-17-opencode-
 *                  autonomous-work-wisdom-design.md, activity.ts) reads the
 *                  session's OWN history (`activityView`): the step id of a
 *                  call and the ledger the agent sees. Ids this process put in
 *                  a tool result that may not be persisted yet (`unpersisted`)
 *                  join every ledger until an own-history scan finds them.
 */

import {
  marker,
  onToolResult as coreOnToolResult,
  onUserTurn as coreOnUserTurn,
  scanIds,
  wisdomMatch as coreWisdomMatch,
  validId,
  type HostAdapter,
  type Ledger,
  type MatchOutcome,
  type SessionRef,
  type VerboseTurn,
  type SpawnFn,
  type WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { discoverCt, invalidateAcceptedPath } from '../wisdom.js';

/** Exact marker LINE of a live delivery part (identity + provenance). */
export const LIVE_MARKER = 'source.kind: curated-thoughts/wisdom';
/** Exact marker LINE of the v1 bootstrap part (LD4). */
export const BOOT_MARKER = 'source.kind: curated-thoughts/wisdom-bootstrap';

/** One v1 memo record: the rendered block plus the fact ids it carries. */
export interface MemoRecord {
  block: string;
  ids: string[];
}

/**
 * One persisted-history row as `client.session.messages()` returns it:
 * { info: Message, parts: Part[] }. Typed loosely — the ledger must tolerate
 * extra/missing fields without throwing.
 */
export interface HistoryRow {
  info?: { role?: unknown; id?: unknown };
  parts?: unknown[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function roleOf(row: unknown): unknown {
  if (!isObj(row) || !isObj(row.info)) return undefined;
  return row.info.role;
}

function hasMarkerLine(text: string, line: string): boolean {
  return text.split('\n').some((l) => l.trim() === line);
}

/** True for a text part this plugin wrote (live or bootstrap). */
export function isOurPart(part: unknown): boolean {
  if (!isObj(part) || part.type !== 'text' || part.synthetic !== true) return false;
  if (typeof part.text !== 'string') return false;
  return hasMarkerLine(part.text, LIVE_MARKER) || hasMarkerLine(part.text, BOOT_MARKER);
}

function isBootPart(part: unknown): boolean {
  return isOurPart(part) && hasMarkerLine((part as { text: string }).text, BOOT_MARKER);
}

/** Text of every non-ignored text part of a row (synthetic included). */
function rowTexts(row: HistoryRow): string[] {
  const out: string[] = [];
  if (!Array.isArray(row.parts)) return out;
  for (const part of row.parts) {
    if (isObj(part) && part.type === 'text' && typeof part.text === 'string' && part.ignored !== true) {
      out.push(part.text);
    }
  }
  return out;
}

/** Persisted output text of COMPLETED tool parts (ToolStateCompleted.output). */
function toolOutputTexts(row: HistoryRow): string[] {
  const out: string[] = [];
  if (!Array.isArray(row.parts)) return out;
  for (const part of row.parts) {
    if (!isObj(part) || part.type !== 'tool') continue;
    const state = part.state;
    if (isObj(state) && state.status === 'completed' && typeof state.output === 'string') {
      out.push(state.output);
    }
  }
  return out;
}

/**
 * The query text (LD8 self-trigger guard): GENUINE user text only —
 * non-synthetic, non-ignored text parts. Our own parts and host-synthetic
 * parts ("Called the Read tool…") never feed `ct wisdom match`.
 */
export function userQueryText(parts: unknown[]): string {
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  for (const part of parts) {
    if (
      isObj(part) &&
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.synthetic !== true &&
      part.ignored !== true
    ) {
      out.push(part.text);
    }
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Part ids (LD9 / H2): `prt_` + 12 hex of (ms*4096 + counter), 48 bits
// big-endian, + 14 base62 chars — the host's own ascending format. Parts the
// plugin pushes skip the host's id assignment (H1), so they must arrive
// well-formed and sort after the message's earlier parts.
// ─────────────────────────────────────────────────────────────────────────

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let idLastMs = 0;
let idCounter = 0;

export function partId(now: number = Date.now()): string {
  // Monotonic even if the clock steps back or callers pass a fixed time.
  const ms = Math.max(now, idLastMs);
  if (ms !== idLastMs) {
    idLastMs = ms;
    idCounter = 0;
  }
  idCounter++;
  const value = (BigInt(ms) * 4096n + BigInt(idCounter)) & 0xffffffffffffn;
  const hex = value.toString(16).padStart(12, '0');
  const rnd = randomBytes(14);
  let tail = '';
  for (let i = 0; i < 14; i++) tail += BASE62[rnd[i]! % 62];
  return `prt_${hex}${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────
// SpawnFn: async child_process binding, byte-identical hygiene to the DSH
// binding (argument LIST — never a shell string — killSignal SIGKILL,
// bounded accumulation standing in for maxBuffer, cwd home, no shell,
// windowsHide, detached process-group on POSIX so the timeout kill takes
// the whole tree).
// ─────────────────────────────────────────────────────────────────────────

export function nodeSpawnFn(env: NodeJS.ProcessEnv = process.env): SpawnFn {
  return (spec) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args, {
          killSignal: 'SIGKILL' as NodeJS.Signals,
          cwd: env.HOME || env.USERPROFILE || '.',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          // Process-group leader (POSIX): the timeout kill takes the whole
          // tree down (DSH parity — the 3 s budget must not leak a hang).
          detached: process.platform !== 'win32',
        });
      } catch {
        resolve({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let overflow = false;
      const CAP = 4 * 1024 * 1024;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      }, spec.timeoutMs);
      const finish = (code: number | null, spawnError: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, spawnError: spawnError || overflow, timedOut });
      };
      child.on('error', () => finish(null, true));
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

// ─────────────────────────────────────────────────────────────────────────
// The curated_recall_context envelope (N3, LD2).
//
// Two carriers: the OpenCode MCP CallToolResult `{content:[{type:'text',
// text}], …}` (the real shape, H5) and a plain string. Inside the text, the
// envelope is line 1 only (ct-fact trailers follow it; JSON.stringify emits
// no literal newlines): either the CT recall JSON itself (`wiki_entries`) or
// the Hermes wrapper `{"result": "<CT JSON>"}`. Every key other than
// `wiki_entries` (inner) and `result` (wrapper) is preserved verbatim.
// ─────────────────────────────────────────────────────────────────────────

export const RECALL_TOOL = 'curated_recall_context';

/** m4: the CT recall surface only — never curated_get_wiki_entry. */
export function isRecallToolName(name: unknown): boolean {
  return typeof name === 'string' && (name === RECALL_TOOL || name.endsWith(`_${RECALL_TOOL}`));
}

interface ParsedText {
  inner: Record<string, unknown> & { wiki_entries: unknown[] };
  wrapper: Record<string, unknown> | null;
  /** Lines after line 1 of the carrier text (pre-existing trailers etc.). */
  rest: string[];
}

function line1(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim();
}

function parseEnvelopeText(text: unknown): ParsedText | null {
  if (typeof text !== 'string') return null;
  const first = line1(text);
  if (first === '') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(first);
  } catch {
    return null;
  }
  if (!isObj(obj)) return null;
  const rest = text.split('\n').slice(1);
  if (Array.isArray(obj.wiki_entries)) {
    return { inner: obj as ParsedText['inner'], wrapper: null, rest };
  }
  if (typeof obj.result === 'string') {
    let inner: unknown;
    try {
      inner = JSON.parse(line1(obj.result));
    } catch {
      return null;
    }
    if (isObj(inner) && Array.isArray(inner.wiki_entries)) {
      return { inner: inner as ParsedText['inner'], wrapper: obj, rest };
    }
  }
  return null;
}

interface Located {
  parsed: ParsedText;
  /** Index into result.content, or -1 for a plain-string carrier. */
  index: number;
}

function locate(result: unknown): Located | null {
  if (typeof result === 'string') {
    const parsed = parseEnvelopeText(result);
    return parsed ? { parsed, index: -1 } : null;
  }
  if (!isObj(result) || !Array.isArray(result.content)) return null;
  for (let i = 0; i < result.content.length; i++) {
    const item = result.content[i];
    if (isObj(item) && item.type === 'text') {
      const parsed = parseEnvelopeText(item.text);
      if (parsed) return { parsed, index: i };
    }
  }
  return null;
}

function stubEntry(factId: string): Record<string, unknown> {
  return { id: factId, in_context: true, note: `already in context: ct-fact:${factId}` };
}

// ─────────────────────────────────────────────────────────────────────────
// OpenCodeWisdomAdapter
// ─────────────────────────────────────────────────────────────────────────

export type SessionKind = 'parent' | 'child';

export interface AdapterDeps {
  /** Resolved brain env for discovery + spawns (CURATED_BRAIN_DIR carried). */
  env: NodeJS.ProcessEnv;
  /** Injected spawn (tests); defaults to the real nodeSpawnFn binding. */
  spawnFn?: SpawnFn;
  /** Injected discovery (tests); defaults to the v1 module discovery. */
  discover?: () => { path: string | null; failure: string | null };
  /** Persisted history rows of a session, oldest first; null/throw ⇒ empty. */
  fetchHistory?: (sessionId: string) => Promise<HistoryRow[] | null>;
  /** Session info (`parentID`), null/throw ⇒ unknown ⇒ treated as child. */
  fetchSession?: (sessionId: string) => Promise<{ parentID?: unknown; directory?: unknown } | null>;
  /** n3 discovery reset (tests); defaults to dropping the accepted ct path. */
  invalidateDiscovery?: () => void;
  /** Verbose-mode recorder; set only when CT_WISDOM_VERBOSE is on. */
  recordVerbose?: (turn: VerboseTurn) => void;
}

const LRU_MAX = 256;

function lruSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > LRU_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function unionInto(set: Set<string> | undefined, ids: Iterable<string>): Set<string> {
  const out = set ?? new Set<string>();
  for (const id of ids) out.add(id);
  return out;
}

function makeLedger(ids: string[], knownBootstrap: boolean): Ledger {
  const set = new Set(ids);
  return { idsMostRecentFirst: ids, has: (id) => set.has(id), knownBootstrap };
}

export class OpenCodeWisdomAdapter implements HostAdapter {
  private readonly spawnFn: SpawnFn;
  private readonly discover: () => { path: string | null; failure: string | null };
  private readonly fetchHistory: (sessionId: string) => Promise<HistoryRow[] | null>;
  private readonly fetchSession: (sessionId: string) => Promise<{ parentID?: unknown; directory?: unknown } | null>;
  private readonly invalidateDiscovery: () => void;
  /** m1 turn cache: the N1 rebuild, read by N3 within the turn. */
  private readonly turns = new Map<string, Ledger>();
  /** Definitive session kinds (lookup failures are not cached). */
  private readonly kinds = new Map<string, { kind: SessionKind; parentID: string | null; directory: string | null }>();
  /** Decision 3 carry-forward: pre-compaction ids, never cleared. */
  private readonly carry = new Map<string, Set<string>>();
  /** Ids this process delivered live (persistence-gap cover, LD5). */
  private readonly delivered = new Map<string, string[]>();
  /**
   * Ids this process placed in a tool result (an activity block, a CT
   * recall's entries) that the host may not have persisted yet: parallel
   * calls of one step finish before their parts are written. Pruned once an
   * own-history scan finds the id (history is the record, LD5).
   */
  private readonly unpersisted = new Map<string, Set<string>>();
  /** Whether the last rebuild saw any persisted user row (LD4 first-turn rule). */
  private readonly userHistory = new Map<string, boolean>();
  private capabilityAbsent = false;
  /** ct path whose `wisdom match --help` already exited 0 in this process. */
  private probedPath: string | null = null;

  /** v1 bootstrap memo, per session (LD4). */
  bootstrapMemo: Record<string, MemoRecord> = {};
  /** Verbose mode only (absent when off, so the adapter is unchanged). */
  declare readonly recordVerbose?: (turn: VerboseTurn) => void;

  constructor(deps: AdapterDeps) {
    if (deps.recordVerbose) this.recordVerbose = deps.recordVerbose;
    this.spawnFn = deps.spawnFn ?? nodeSpawnFn(deps.env);
    this.discover = deps.discover ?? (() => discoverCt(deps.env));
    this.fetchHistory = deps.fetchHistory ?? (async () => null);
    this.fetchSession = deps.fetchSession ?? (async () => null);
    this.invalidateDiscovery = deps.invalidateDiscovery ?? invalidateAcceptedPath;
  }

  /** TEST-ONLY: drop all process state. */
  _resetForTests(): void {
    this.turns.clear();
    this.kinds.clear();
    this.carry.clear();
    this.delivered.clear();
    this.unpersisted.clear();
    this.userHistory.clear();
    this.bootstrapMemo = {};
    this.capabilityAbsent = false;
    this.probedPath = null;
  }

  // ── session kind (LD7) ────────────────────────────────────────────────

  async sessionKind(sessionId: string): Promise<SessionKind> {
    const known = this.kinds.get(sessionId);
    if (known) return known.kind;
    let info: { parentID?: unknown; directory?: unknown } | null = null;
    try {
      info = await this.fetchSession(sessionId);
    } catch {
      return 'child'; // fail-safe, not cached: retried next turn
    }
    if (!isObj(info)) return 'child';
    const parentID = typeof info.parentID === 'string' && info.parentID !== '' ? info.parentID : null;
    const kind: SessionKind = parentID === null ? 'parent' : 'child';
    // The session's working directory (SDK Session.directory; tools resolve
    // relative paths against it). Only an absolute path counts.
    const directory =
      typeof info.directory === 'string' && info.directory.trim() !== '' && nodePath.isAbsolute(info.directory)
        ? info.directory
        : null;
    lruSet(this.kinds, sessionId, { kind, parentID, directory });
    return kind;
  }

  /** Activity delivery runs in any session whose kind is KNOWN (parent or child). */
  sessionKnown(sessionId: string): boolean {
    return this.kinds.has(sessionId);
  }

  /** The session's absolute working directory, or null (then no path is sent). */
  sessionDirectory(sessionId: string): string | null {
    return this.kinds.get(sessionId)?.directory ?? null;
  }

  /** Parent-only delivery: only a session positively known as a parent. */
  deliveryEnabled(session: SessionRef): boolean {
    return this.kinds.get(session.id)?.kind === 'parent';
  }

  restored(_session: SessionRef): boolean {
    return false; // LD10: resume rebuilds from the same persisted history
  }

  hasUserHistory(sessionId: string): boolean {
    return this.userHistory.get(sessionId) === true;
  }

  // ── v1 bootstrap memo (LD4) ───────────────────────────────────────────

  setBootstrap(sessionId: string, block: string): MemoRecord {
    const rec: MemoRecord = { block, ids: scanIds(block) };
    this.bootstrapMemo[sessionId] = rec;
    return rec;
  }

  // ── ledger (LD5/LD6) ──────────────────────────────────────────────────

  private async rows(sessionId: string): Promise<HistoryRow[]> {
    try {
      const rows = await this.fetchHistory(sessionId);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /**
   * m5 source of truth: rebuild from what the NEXT trigger reads — the
   * persisted history (child: ∪ parent history) — plus carry, memo and this
   * process's deliveries. Cached for N3 (m1).
   */
  async rebuildLedgerAsync(session: SessionRef): Promise<Ledger> {
    const own = await this.rows(session.id);
    this.prune(session.id, own);
    const parentID = this.kinds.get(session.id)?.parentID ?? null;
    const parentRows = parentID !== null ? await this.rows(parentID) : [];
    const ledger = this.buildLedger(session.id, [...parentRows, ...own]);
    this.userHistory.set(session.id, own.some((r) => roleOf(r) === 'user'));
    lruSet(this.turns, session.id, ledger);
    return ledger;
  }

  private buildLedger(sessionId: string, rows: HistoryRow[]): Ledger {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    };
    const delivered = this.delivered.get(sessionId) ?? [];
    for (let i = delivered.length - 1; i >= 0; i--) push(delivered[i]!);
    for (const id of this.unpersisted.get(sessionId) ?? []) push(id);
    let bootSeen = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i] as HistoryRow;
      if (!isObj(row)) continue;
      const role = roleOf(row);
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
      for (const t of [...rowTexts(row), ...toolOutputTexts(row)]) for (const id of scanIds(t)) push(id);
      if (role === 'user' && Array.isArray(row.parts)) {
        for (const part of row.parts) {
          if (isBootPart(part)) bootSeen = true;
        }
      }
    }
    const memo = this.bootstrapMemo[sessionId];
    for (const id of memo?.ids ?? []) push(id);
    for (const id of this.carry.get(sessionId) ?? []) push(id);
    return makeLedger(ordered, bootSeen || memo !== undefined);
  }

  // ── activity view (spec 2026-10-17) ──────────────────────────────────

  /** Remember ids just placed in a tool result of this session (see `unpersisted`). */
  noteUnpersisted(sessionId: string, ids: Iterable<string>): void {
    const valid = [...ids].filter((id) => validId(id));
    if (valid.length === 0) return;
    lruSet(this.unpersisted, sessionId, unionInto(this.unpersisted.get(sessionId), valid));
  }

  /** Drop unpersisted ids that the session's own persisted history now shows. */
  private prune(sessionId: string, own: HistoryRow[]): void {
    const pending = this.unpersisted.get(sessionId);
    if (pending === undefined || pending.size === 0) return;
    const seen = new Set<string>();
    for (const row of own) {
      if (!isObj(row)) continue;
      for (const t of [...rowTexts(row), ...toolOutputTexts(row)]) for (const id of scanIds(t)) seen.add(id);
    }
    for (const id of seen) pending.delete(id);
  }

  /**
   * The activity path's view of a session: its OWN persisted history (never
   * the parent's: a subagent cannot see its parent's context), plus carry,
   * memo, user-turn deliveries and unpersisted ids. `stepOf(callID)` is the
   * assistant message id of the tool part with that call id (the processor
   * persists the part when the call streams in), or null.
   */
  async activityView(sessionId: string): Promise<{ ledger: Ledger; stepOf: (callID: string) => string | null }> {
    const own = await this.rows(sessionId);
    this.prune(sessionId, own);
    const ledger = this.buildLedger(sessionId, own);
    const stepOf = (callID: string): string | null => {
      for (let i = own.length - 1; i >= 0; i--) {
        const row = own[i];
        if (!isObj(row) || !Array.isArray(row.parts)) continue;
        for (const part of row.parts) {
          if (!isObj(part) || part.type !== 'tool' || part.callID !== callID) continue;
          if (typeof part.messageID === 'string' && part.messageID !== '') return part.messageID;
          const id = isObj(row.info) ? row.info.id : undefined;
          return typeof id === 'string' && id !== '' ? id : null;
        }
      }
      return null;
    };
    return { ledger, stepOf };
  }

  /**
   * N3 view (m2): fresh rebuild ∪ the current turn cache (same-turn ids that
   * may not be persisted yet, e.g. an earlier recall in the same step). Ids
   * only ever join the cache, so a stale cache can suppress, never duplicate.
   */
  async refreshForToolResult(session: SessionRef): Promise<Ledger> {
    const prior = this.turns.get(session.id);
    const fresh = await this.rebuildLedgerAsync(session);
    if (prior === undefined) return fresh;
    const ids = [...fresh.idsMostRecentFirst];
    const seen = new Set(ids);
    for (const id of prior.idsMostRecentFirst) if (!seen.has(id)) ids.push(id);
    const merged = makeLedger(
      ids,
      fresh.knownBootstrap || prior.knownBootstrap,
    );
    lruSet(this.turns, session.id, merged);
    return merged;
  }

  /** Sync HostAdapter entry: the turn cache (every call path refreshes it first). */
  rebuildLedger(session: SessionRef): Ledger {
    return this.turns.get(session.id) ?? this.buildLedger(session.id, []);
  }

  /**
   * Decision 3 carry-forward (`experimental.session.compacting`): snapshot the
   * pre-compaction ledger into the carry set — never removed.
   */
  async snapshotForCompaction(sessionId: string): Promise<void> {
    const cached = this.turns.get(sessionId); // same-turn additions (N3 unions)
    const ledger = await this.rebuildLedgerAsync({ id: sessionId });
    const ids = [...ledger.idsMostRecentFirst, ...(cached?.idsMostRecentFirst ?? [])];
    lruSet(this.carry, sessionId, unionInto(this.carry.get(sessionId), ids));
  }

  cacheLedger(session: SessionRef, ledger: Ledger): void {
    lruSet(this.turns, session.id, ledger);
  }

  cachedLedger(session: SessionRef): Ledger | null {
    return this.turns.get(session.id) ?? null;
  }

  // ── CT ────────────────────────────────────────────────────────────────

  async wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    if (this.capabilityAbsent) return { outcome: 'timeout_or_exit' };
    const { path } = this.discover();
    if (path === null) return { outcome: 'spawn' };
    if (this.probedPath !== path) {
      // Capability gate (Hermes has_match_capability parity), once per
      // accepted path: a per-turn probe would add a spawn and up to 3 s of
      // pre-LLM latency on top of the 3 s match budget every turn.
      const probe = await this.spawnFn({ command: path, args: ['wisdom', 'match', '--help'], timeoutMs: 3000 });
      if (probe.spawnError || probe.timedOut) return { outcome: 'spawn' };
      if (probe.code !== 0) {
        this.capabilityAbsent = true; // deterministic absence: latch OFF for the process
        return { outcome: 'timeout_or_exit' };
      }
      this.probedPath = path;
    }
    return coreWisdomMatch(path, query, max, exclude, this.spawnFn);
  }

  /** n3: retry next turn — re-walk discovery and re-probe the capability. */
  resetDiscoveryAndProbeCaches(): void {
    this.capabilityAbsent = false;
    this.probedPath = null;
    this.invalidateDiscovery();
  }

  wisdomMatchAbsent(): boolean {
    return this.capabilityAbsent;
  }

  // ── N3 ────────────────────────────────────────────────────────────────

  isCtRecallResult(result: unknown): boolean {
    return locate(result) !== null;
  }

  envelopeFactIds(result: unknown): string[] {
    const found = locate(result);
    if (found === null) return [];
    const ids: string[] = [];
    for (const entry of found.parsed.inner.wiki_entries) {
      const id = isObj(entry) ? entry.id : undefined;
      if (validId(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Reference dedup (ct_tool_dedup.transform_tool_result): stub repeats,
   * append one `ct-fact:<id>` trailer line per NEW id after the envelope JSON.
   * Returns the SAME carrier shape (string, or a CallToolResult copy whose
   * located text item is replaced); index.ts copies `content` back onto the
   * host's output object.
   */
  rewriteEnvelopeStub(result: unknown, repeats: string[], newIds: string[]): unknown {
    const found = locate(result);
    if (found === null) return result;
    const { inner, wrapper, rest } = found.parsed;
    const stubs = new Set(repeats);
    const newInner = {
      ...inner,
      wiki_entries: inner.wiki_entries.map((entry) => {
        const id = isObj(entry) ? entry.id : undefined;
        return validId(id) && stubs.has(id) ? stubEntry(id) : entry;
      }),
    };
    const trailer = newIds.map((id) => `\n${marker(id)}`).join('');
    const body = JSON.stringify(newInner) + trailer;
    const head = wrapper === null ? body : JSON.stringify({ ...wrapper, result: body });
    const text = [head, ...rest].join('\n');
    if (found.index < 0) return text;
    const obj = result as Record<string, unknown> & { content: unknown[] };
    return {
      ...obj,
      content: obj.content.map((item, i) => (i === found.index ? { ...(item as object), text } : item)),
    };
  }

  // ── N2 bookkeeping ────────────────────────────────────────────────────

  deliver(_session: SessionRef, _block: string): void {
    // The N2 channel is the returned block itself (index.ts pushes the part).
  }

  noteDelivered(session: SessionRef, ids: string[]): void {
    const list = this.delivered.get(session.id) ?? [];
    for (const id of ids) if (!list.includes(id)) list.push(id);
    lruSet(this.delivered, session.id, list);
  }
}

// N1 / N3 entry points for index.ts.
export { coreOnUserTurn as runUserTurn, coreOnToolResult as runToolResult };

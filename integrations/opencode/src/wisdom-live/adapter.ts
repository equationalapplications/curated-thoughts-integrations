/**
 * wisdom-live/adapter.ts — the OpenCode HostAdapter binding for the shared
 * `ct-wisdom-core` algorithm (spec: 2026-10-09 cross-harness parity,
 * OpenCode leg; host evidence base: OpenCode 1.18.35 plugin SDK,
 * tests/host/compatibility.json; DSH reference: ../deepseek/src/wisdom-live).
 *
 * Mapping (spec "Per-host adapter contracts", OpenCode row — do not re-derive):
 *   N1 trigger   — `chat.message` (UserMessage, pre-LLM, persisted channel;
 *                  registered in ../index.ts).
 *   N2 delivery  — SAME `chat.message` invocation: an appended part with
 *                  `synthetic: true` on output.parts. The part is persisted
 *                  by the host, so the ledger (N4) reads it back from the
 *                  persisted history (investigation F1 decision 3:
 *                  messages.transform is wire-only and is NOT used).
 *   N3 transform — `tool.execute.after`: output.output is the tool's string
 *                  output as persisted; rewrite the recall envelope there.
 *   Ledger       — rebuilt from the persisted history via
 *                  client.session.messages() ({info, parts} rows): user-role
 *                  text parts + completed tool parts are the scan surface
 *                  (roles per the core's historyIds N4 rule).
 *   Compaction   — the persisted history IS the ledger source, so compaction
 *                  is visible: the synthetic summary replaces the compacted
 *                  messages. Decision 3 carry-forward (spec §opencode): a
 *                  text-part id the summary preserves keeps the fact known
 *                  (no redelivery); ids the summary dropped are forgotten
 *                  (allowed again after M1 budget checks) — the assertion
 *                  comes for free from rebuilding on the post-compaction
 *                  history, and `experimental.session.compacting` is where
 *                  the pre-compaction ledger snapshot gets invalidated.
 *   Restore      — persisted history again: a resumed session rebuilds from
 *                  the same store; fail-safe child policy per decision 3
 *                  (deliveryEnabled=true; the restored+no-bootstrap
 *                  fail-closed rule stays host-local: OpenCode resume keeps
 *                  the bootstrap ids in history, so knownBootstrap carries
 *                  the semantics — same reasoning as the DSH row).
 *   Session id   — `sessionID` (stable; compaction does not rotate it).
 */

import {
  marker,
  onToolResult as coreOnToolResult,
  onUserTurn as coreOnUserTurn,
  wisdomMatch as coreWisdomMatch,
  validId,
  type HostAdapter,
  type Ledger,
  type MatchOutcome,
  type SessionRef,
  type SpawnFn,
  type WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import { spawn } from 'node:child_process';
import { discoverCt } from '../wisdom.js';

/** One v1 memo record: the rendered block plus the fact ids it delivered. */
export interface MemoRecord {
  block: string;
  ids: string[];
}

/**
 * One persisted-history row as `client.session.messages()` returns it:
 * { info: Message, parts: Part[] }. Typed loosely — the SDK shape is
 * verified (types.gen.d.ts) but the ledger must tolerate extra/missing
 * fields without throwing.
 */
export interface HistoryRow {
  info?: { role?: unknown };
  parts?: unknown[];
}

/** Text parts of one history row (type: 'text', non-ignored only). */
function rowTexts(row: HistoryRow): string[] {
  const out: string[] = [];
  if (!Array.isArray(row.parts)) return out;
  for (const part of row.parts) {
    if (
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string' &&
      (part as { ignored?: unknown }).ignored !== true
    ) {
      out.push((part as { text: string }).text);
    }
  }
  return out;
}

/**
 * The persisted output text of a COMPLETED tool part (ToolStateCompleted
 * carries `output: string`; pending/running/error states carry none).
 */
function toolOutputText(row: HistoryRow): string[] {
  const out: string[] = [];
  if (!Array.isArray(row.parts)) return out;
  for (const part of row.parts) {
    if (
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'tool'
    ) {
      const state = (part as { state?: unknown }).state;
      if (
        state !== null &&
        typeof state === 'object' &&
        (state as { status?: unknown }).status === 'completed' &&
        typeof (state as { output?: unknown }).output === 'string'
      ) {
        out.push((state as { output: string }).output);
      }
    }
  }
  return out;
}

/**
 * The user message's text for the query. N1 hands us `output.parts` (the
 * incoming message's parts); text parts joined.
 */
export function userMessageText(parts: unknown[]): string {
  return rowTexts({ parts } as HistoryRow).join('\n');
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
// The curated_recall_context envelope (N3).
//
// A successful MCP call arrives at `tool.execute.after` with
// `output.output` — the tool's string output as the host PERSISTS it. The
// CT recall shape is { result: "<CT JSON>" } whose inner wiki_entries carry
// fact ids. Anything else — errors, other shapes, other tools — passes
// through untouched. Parse rule (handoff landmine): the envelope JSON is
// line 1 only; ct-fact trailer lines follow it (JSON.stringify emits no
// literal newlines), so parsing must never hand the trailers to JSON.parse.
// ─────────────────────────────────────────────────────────────────────────

export const RECALL_TOOL_SUFFIX = '__curated_recall_context';

/** Inner wiki-entry envelope: the parsed shape N3 reads and rewrites. */
interface InnerEnvelope {
  wiki_entries: Array<Record<string, unknown>>;
}

function parseEnvelope(result: unknown):
  | { outer: Record<string, unknown>; inner: InnerEnvelope }
  | null {
  if (typeof result !== 'string') return null;
  // Line 1 only: the persisted output may carry ct-fact trailer lines that
  // are NOT part of the JSON (this module's own rewrite appends them).
  const line1 = (result.split('\n', 1)[0] ?? '').trim();
  if (line1 === '') return null;
  let outer: unknown;
  try {
    outer = JSON.parse(line1);
  } catch {
    return null;
  }
  if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) {
    return null;
  }
  const obj = outer as Record<string, unknown>;
  if (typeof obj.result !== 'string') return null;
  // Same rule one level down: the inner envelope JSON is line 1 of `result`.
  let inner: unknown;
  try {
    inner = JSON.parse((obj.result.split('\n', 1)[0] ?? '').trim() || obj.result);
  } catch {
    return null;
  }
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
    return null;
  }
  const innerObj = inner as Record<string, unknown>;
  if (!Array.isArray(innerObj.wiki_entries)) return null;
  return {
    outer: obj,
    inner: { wiki_entries: innerObj.wiki_entries as Array<Record<string, unknown>> },
  };
}

export function isRecallToolName(name: unknown): boolean {
  return typeof name === 'string' && name.endsWith(RECALL_TOOL_SUFFIX);
}

function stubEntry(factId: string): Record<string, unknown> {
  return {
    id: factId,
    in_context: true,
    note: `already in context: ct-fact:${factId}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// OpenCodeWisdomAdapter
// ─────────────────────────────────────────────────────────────────────────

export interface AdapterDeps {
  /** Resolved brain env for discovery + spawns (CURATED_BRAIN_DIR carried). */
  env: NodeJS.ProcessEnv;
  /** Injected spawn (tests); defaults to the real nodeSpawnFn binding. */
  spawnFn?: SpawnFn;
  /** Injected discovery (tests); defaults to the v1 module discovery. */
  discover?: () => { path: string | null; failure: string | null };
  /** Injected clock for the breaker (tests). */
  now?: () => number;
  /**
   * Injected persisted-history fetch (tests); production passes the plugin
   * input's `client`. Returns the {info, parts} rows of the session, newest
   * last. A rejected/failed fetch yields null (empty ledger, fail-open).
   */
  fetchHistory?: (sessionId: string) => Promise<HistoryRow[] | null>;
}

/**
 * Per-turn state: the ledger rebuilt at N1, cached BEFORE any early return
 * (m1) so N3 can dedup even on turns that deliver nothing. Turn-scoped only —
 * the next turn's N1 rebuild is the source of truth (INTENT M1).
 */
interface TurnState {
  ledger: Ledger;
}

export class OpenCodeWisdomAdapter implements HostAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: SpawnFn;
  private readonly discover: () => { path: string | null; failure: string | null };
  private readonly now: () => number;
  private readonly fetchHistory: (sessionId: string) => Promise<HistoryRow[] | null>;
  private readonly turns = new Map<string, TurnState>();
  private capabilityAbsent = false;

  constructor(deps: AdapterDeps) {
    this.env = deps.env;
    this.spawnFn = deps.spawnFn ?? nodeSpawnFn(deps.env);
    this.discover = deps.discover ?? (() => discoverCt(deps.env));
    this.now = deps.now ?? (() => Date.now());
    this.fetchHistory =
      deps.fetchHistory ??
      (async (_sessionId: string) => {
        // Production wiring (index.ts) always injects fetchHistory from the
        // plugin input's client. This default keeps the adapter honest if
        // constructed bare: an empty ledger instead of a crash.
        return null;
      });
  }

  /** TEST-ONLY: drop all turn caches. */
  _resetForTests(): void {
    this.turns.clear();
    this.capabilityAbsent = false;
  }

  /**
   * The v1 memo record for this session, when this process rendered one. The
   * index.ts wiring sets this before the N1 rebuild each turn.
   */
  bootstrapMemo: Record<string, MemoRecord> = {};

  /** Sessions in the compaction window (set at `beginCompaction`). */
  private readonly compactionPending = new Set<string>();

  /**
   * Decision 3 carry-forward (spec §opencode): called from
   * `experimental.session.compacting`. The summary may drop the bootstrap
   * block and prior deliveries, so the advisory memo ids must not survive
   * compaction — the next N1 rebuild reads the post-compaction history:
   * ids the summary preserved stay known (no redelivery); dropped ids are
   * forgotten. Cleared at the next rebuild (the window closes once the
   * post-compaction history has been read once).
   */
  beginCompaction(sessionId: string): void {
    this.compactionPending.add(sessionId);
    this.turns.delete(sessionId);
  }

  deliveryEnabled(_session: SessionRef): boolean {
    // OpenCode has no resume-OFF latch (decision 4d is claude-code-only); the
    // restored+unknown-bootstrap fail-closed rule covers resume below.
    return true;
  }

  restored(_session: SessionRef): boolean {
    // No separate restore path (host row, Restore rule): resume reuses the
    // same persisted history, so knownBootstrap below carries the semantics.
    return false;
  }

  /**
   * m5 source of truth: rebuild from the PERSISTED history the NEXT trigger
   * reads — client.session.messages() — plus the memo bootstrap ids. Never
   * from the in-flight hook payload (N1's output.message is not yet
   * persisted when the hook runs; the fetch may include it later, which is
   * harmless: the scan is idempotent on markers).
   *
   * Async rebuild over a sync HostAdapter operation: the fetch is issued per
   * rebuild and awaited through `rebuildLedgerAsync`; the sync entry point
   * serves the cached view (m1/m2), which every N1 call path refreshes
   * BEFORE the engine runs.
   */
  async rebuildLedgerAsync(session: SessionRef): Promise<Ledger> {
    const rows = await this.fetchHistory(session.id).catch(() => null);
    // The compaction window closes once the post-compaction history has been
    // read: memo bootstrap ids rejoin the ledger from here on.
    const inCompactionWindow = this.compactionPending.has(session.id);
    if (inCompactionWindow) this.compactionPending.delete(session.id);
    const logIds = this.scanRows(rows, 'all');
    const rec = this.bootstrapMemo[session.id];
    const bootIds = !inCompactionWindow && rec ? rec.ids : [];
    const merged: string[] = [...logIds];
    for (const id of bootIds) {
      if (!merged.includes(id)) merged.push(id);
    }
    const set = new Set(merged);
    const knownBootstrap = bootIds.length > 0 || logIds.length > 0;
    const ledger: Ledger = {
      idsMostRecentFirst: merged,
      has: (id) => set.has(id),
      liveDeliveredCount: this.liveDeliveredCount(rows, set),
      knownBootstrap,
    };
    this.turns.set(session.id, { ledger });
    this.pruneTurns();
    return ledger;
  }

  rebuildLedger(session: SessionRef): Ledger {
    // Sync fallback: serve the last cached rebuild for this session — the m1
    // cache — or EMPTY. Every engine call path refreshes the cache first via
    // rebuildLedgerAsync; a cold sync read would block the host on HTTP.
    return this.cachedLedger(session) ?? {
      idsMostRecentFirst: [],
      has: () => false,
      liveDeliveredCount: 0,
      knownBootstrap: this.compactionPending.has(session.id)
        ? false
        : (this.bootstrapMemo[session.id]?.ids.length ?? 0) > 0,
    };
  }

  /**
   * Scan history rows for ct-fact markers, newest row first. `mode`:
   * 'all' = user + tool roles (N4 scan surface); the synthetic N2 block
   * lands on the user role and recall trailers on completed tool parts.
   */
  private scanRows(rows: HistoryRow[] | null, mode: 'all'): string[] {
    if (rows === null || rows.length === 0) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i] as HistoryRow;
      if (row === null || typeof row !== 'object') continue;
      const role = row.info?.role;
      if (mode === 'all' && role !== 'user' && role !== 'tool' && role !== 'assistant') {
        continue;
      }
      for (const text of [...rowTexts(row), ...toolOutputText(row)]) {
        const re = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            out.push(m[1]);
          }
        }
      }
    }
    return out;
  }

  /**
   * M1 live budget: count distinct ids delivered via the LIVE path — markers
   * on USER-role rows of the persisted history (the N2 channel), same rule
   * as the Hermes reference and the core's SimHost.
   */
  private liveDeliveredCount(rows: HistoryRow[] | null, known: Set<string>): number {
    if (rows === null) return 0;
    const live = new Set<string>();
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      if (row.info?.role !== 'user') continue;
      for (const text of rowTexts(row)) {
        const re = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          if (known.has(match[1])) live.add(match[1]);
        }
      }
    }
    return live.size;
  }

  private pruneTurns(): void {
    while (this.turns.size > 256) {
      const oldest = this.turns.keys().next();
      if (oldest.done) break;
      this.turns.delete(oldest.value);
    }
  }

  /** m1: cache the N1 rebuild before any early return. */
  cacheLedger(session: SessionRef, ledger: Ledger): void {
    this.turns.set(session.id, { ledger });
    this.pruneTurns();
  }

  /** m2: the N1 rebuild, when this turn produced one. */
  cachedLedger(session: SessionRef): Ledger | null {
    return this.turns.get(session.id)?.ledger ?? null;
  }

  async wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    if (this.capabilityAbsent) return { outcome: 'timeout_or_exit' };
    const { path } = this.discover();
    if (path === null) return { outcome: 'spawn' };
    const probe = await this.spawnFn({
      command: path,
      // Capability gate per the live-delivery spec: `ct wisdom match --help`
      // exits 0 (Hermes ct_wisdom_live.has_match_capability parity).
      args: ['wisdom', 'match', '--help'],
      timeoutMs: 3000,
    });
    if (probe.spawnError || probe.timedOut) {
      return { outcome: 'spawn' };
    }
    if (probe.code !== 0) {
      // Deterministic absence of the subcommand: latch OFF for the process
      // (n3 retry-next-turn does not apply — the binary answered).
      this.capabilityAbsent = true;
      return { outcome: 'timeout_or_exit' };
    }
    return coreWisdomMatch(path, query, max, exclude, this.spawnFn);
  }

  /** m4: N3 fires on the CT recall surface only. */
  isCtRecallResult(result: unknown): boolean {
    return parseEnvelope(result) !== null;
  }

  /** Fact ids carried by a recall envelope (empty on malformed). */
  envelopeFactIds(result: unknown): string[] {
    const parsed = parseEnvelope(result);
    if (parsed === null) return [];
    const ids: string[] = [];
    for (const entry of parsed.inner.wiki_entries) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (validId(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Reference dedup (ct_tool_dedup.transform_tool_result): stub repeated
   * wiki entries down to one-line stubs (option A), then append a
   * `ct-fact:<id>` trailer line for every NEW id — envelope JSON first,
   * one trailer line per new id after it, exactly as the reference writes
   * `outer['result'] = json.dumps(inner) + trailer`. The persisted tool
   * output then carries the markers the next ledger scan picks up. The
   * returned STRING replaces output.output at `tool.execute.after`.
   */
  rewriteEnvelopeStub(result: unknown, repeats: string[], newIds: string[]): unknown {
    const parsed = parseEnvelope(result);
    if (parsed === null) return result;
    const stubs = new Set(repeats);
    parsed.inner.wiki_entries = parsed.inner.wiki_entries.map((entry) => {
      const id = (entry as { id?: unknown } | null)?.id;
      return validId(id) && stubs.has(id) ? stubEntry(id) : entry;
    });
    const trailer = newIds.map((id) => `\n${marker(id)}`).join('');
    return JSON.stringify(parsed.inner) + trailer;
  }

  /** n3: a spawn-class failure drops the process capability latch. */
  resetDiscoveryAndProbeCaches(): void {
    this.capabilityAbsent = false;
  }

  wisdomMatchAbsent(): boolean {
    return this.capabilityAbsent;
  }

  /**
   * N2 delivery: the BLOCK text is returned to index.ts (which appends the
   * synthetic part); here we only record the memo's delivered ids so the
   * ledger can find them even if the host never persisted our part
   * (fail-open bookkeeping — the history scan stays authoritative).
   */
  deliver(_session: SessionRef, _block: string): void {
    // No host-side write: the N2 channel is the returned block itself.
  }

  noteDelivered(session: SessionRef, ids: string[]): void {
    const rec = this.bootstrapMemo[session.id];
    if (rec) {
      for (const id of ids) if (!rec.ids.includes(id)) rec.ids.push(id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// N1 / N3 entry points for index.ts (thin wrappers around the core so the
// adapter + Breaker pairing lives in one place).
// ─────────────────────────────────────────────────────────────────────────

export { coreOnUserTurn as runUserTurn, coreOnToolResult as runToolResult };

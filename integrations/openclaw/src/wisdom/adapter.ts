/**
 * wisdom/adapter.ts — the OpenClaw HostAdapter binding for the shared
 * `ct-wisdom-core` algorithm (spec 2026-10-16 OpenClaw leg; parent spec
 * 2026-10-09 annex A, OpenClaw row).
 *
 * Mapping:
 *   N1 trigger   — `before_prompt_build` (wired in ../index.ts, gated there).
 *   N2 delivery  — the returned `prependContext`; the embedded runner folds it
 *                  into the current user message's model-prompt projection,
 *                  which the transcript recorder freezes once per admission
 *                  (spec F8). `deliver()` is therefore a no-op here.
 *   N3 transform — runtime-neutral tool-result middleware, rewriting the CT
 *                  recall envelope inside the AgentToolResult text blocks.
 *   Ledger       — rebuilt from the prompt hook's `messages` snapshot (what the
 *                  next trigger reads: user content + persisted projection +
 *                  tool results, spec F9), ∪ ids drained into THIS turn from
 *                  our own next-turn injections, ∪ the settled bootstrap ids.
 *                  Never from the adapter's own decision (m5).
 *                  Within a run there is no prompt hook between tool calls,
 *                  so the adapter also keeps a RUN LEDGER: every id that
 *                  entered context during the current run (the live block,
 *                  every tool result's markers, recall envelopes, activity
 *                  deliveries). It is reset by the next run's snapshot, which
 *                  then carries those tool results itself (spec 2026-10-17
 *                  OpenClaw autonomous work, A3).
 *   Session id   — OpenClaw `sessionKey` (stable across compaction).
 */

import {
  EXCLUDE_MAX,
  marker,
  validId,
  scanIds,
  wisdomMatch as coreWisdomMatch,
  type HostAdapter,
  type Ledger,
  type MatchOutcome,
  type SessionRef,
  type VerboseTurn,
  type SpawnFn,
  type WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import type { CtLocator } from './discover.js';

const RECALL_TOOL_RE = /__curated_recall_context(-\d+)?$/;
export const STRUCTURED_PREFIX = 'structuredContent:\n';
const SNAPSHOT_SCAN_ROLES = new Set(['user', 'toolResult', 'tool']);

/** m4: the CT recall surface only — never curated_get_wiki_entry. */
export function isRecallToolName(name: unknown): boolean {
  return typeof name === 'string' && RECALL_TOOL_RE.test(name);
}

/** Text of every text part of a message or tool-result `content`. */
export function partTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') out.push(part);
    else if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      out.push((part as { text: string }).text);
    }
  }
  return out;
}

function projectionText(msg: Record<string, unknown>): string | null {
  const meta = msg.__openclaw;
  if (meta === null || typeof meta !== 'object') return null;
  const proj = (meta as { modelPromptProjection?: unknown }).modelPromptProjection;
  if (proj === null || typeof proj !== 'object') return null;
  const text = (proj as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

export interface SnapshotScan {
  /** Unique ids, newest message first. */
  all: string[];
}

/** Scan a prompt-hook `messages` snapshot for ct-fact markers. Never throws. */
export function snapshotScan(messages: unknown): SnapshotScan {
  const all: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(messages)) return { all };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === null || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    const role = typeof m.role === 'string' ? m.role : '';
    if (!SNAPSHOT_SCAN_ROLES.has(role)) continue;
    const texts = partTexts(m.content);
    if (role === 'user') {
      const p = projectionText(m);
      if (p !== null) texts.push(p);
    }
    for (const text of texts) {
      for (const id of scanIds(text)) {
        if (!seen.has(id)) {
          seen.add(id);
          all.push(id);
        }
      }
    }
  }
  return { all };
}

/** One recall-shaped text block inside an AgentToolResult. */
interface RecallBlock {
  index: number;
  prefix: string;
  inner: Record<string, unknown> & { wiki_entries: unknown[] };
}

interface ParsedResult {
  outer: Record<string, unknown> & { content: unknown[] };
  blocks: RecallBlock[];
}

function parseResult(result: unknown): ParsedResult | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const outer = result as Record<string, unknown>;
  if (!Array.isArray(outer.content)) return null;
  const blocks: RecallBlock[] = [];
  outer.content.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== 'text' || typeof b.text !== 'string') return;
    const prefix = b.text.startsWith(STRUCTURED_PREFIX) ? STRUCTURED_PREFIX : '';
    let inner: unknown;
    try {
      inner = JSON.parse(b.text.slice(prefix.length));
    } catch {
      return;
    }
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return;
    if (!Array.isArray((inner as { wiki_entries?: unknown }).wiki_entries)) return;
    blocks.push({ index, prefix, inner: inner as RecallBlock['inner'] });
  });
  if (blocks.length === 0) return null;
  return { outer: outer as ParsedResult['outer'], blocks };
}

function stubEntry(factId: string): Record<string, unknown> {
  return { id: factId, in_context: true, note: `already in context: ct-fact:${factId}` };
}

/** Per-turn inputs captured by the hook before the core runs. */
export interface TurnInput {
  /** The run this snapshot was taken for (`ctx.runId`); absent on legacy callers. */
  runId?: string;
  messages: unknown[];
  drained: string[];
  /** Settled bootstrap ids, or null while the bootstrap is unsettled. */
  bootstrapIds: string[] | null;
  restored: boolean;
}

export interface AdapterDeps {
  spawnFn: SpawnFn;
  locator: CtLocator;
  /** Verbose-mode recorder; set only when CT_WISDOM_VERBOSE is on. */
  recordVerbose?: (turn: VerboseTurn) => void;
}

const LRU_MAX = 256;

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max = LRU_MAX): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

interface RunLedger {
  /** undefined: no run identity (legacy host) — nothing is run-scoped. */
  runId: string | undefined;
  /** Newest first; bounded at EXCLUDE_MAX (`ids` and `set` mirror each other). */
  ids: string[];
  set: Set<string>;
  /**
   * Why this process can no longer tell what the run shows (fail closed for
   * activity; N3 stubs nothing): `compacted` (compaction during the run),
   * `ledger_overflow` (more than EXCLUDE_MAX ids entered), `meta_unreadable`
   * (a CT recall through the `tool_call` meta tool we could not read).
   * Cleared by the next snapshot.
   */
  blind: string | null;
}

interface CachedLedger {
  runId: string | undefined;
  ledger: Ledger;
}

/** '' is no run id (legacy hosts): never a run scope. */
const runKey = (runId: string | undefined): string | undefined => (runId ? runId : undefined);

export class OpenClawWisdomAdapter implements HostAdapter {
  private readonly turns = new Map<string, TurnInput>();
  private readonly cache = new Map<string, CachedLedger>();
  private readonly runs = new Map<string, RunLedger>();
  /** null = not probed yet; true = `ct wisdom match` present; false = absent (latched). */
  private capable: boolean | null = null;
  private warming: Promise<void> | null = null;

  /** Verbose mode only (absent when off, so the adapter is unchanged). */
  declare readonly recordVerbose?: (turn: VerboseTurn) => void;

  constructor(private readonly deps: AdapterDeps) {
    if (deps.recordVerbose) this.recordVerbose = deps.recordVerbose;
  }

  /**
   * Store a run's prompt-hook snapshot. A NEW runId, a missing one, or a run
   * that went blind (compaction, overflow) starts a fresh run ledger: the
   * snapshot itself now shows what is in context. Another attempt of the same
   * healthy run keeps it.
   */
  setTurn(sessionId: string, input: TurnInput): void {
    const runId = runKey(input.runId);
    lruSet(this.turns, sessionId, { ...input, runId });
    const run = this.runs.get(sessionId);
    if (run === undefined || runId === undefined || run.runId !== runId || run.blind !== null) {
      lruSet(this.runs, sessionId, { runId, ids: [], set: new Set<string>(), blind: null });
    }
  }

  private run(sessionId: string, runId: string | undefined): RunLedger | null {
    const key = runKey(runId);
    const run = this.runs.get(sessionId);
    return key !== undefined && run !== undefined && run.runId === key ? run : null;
  }

  /** True when this process holds a snapshot of `runId` for the session. */
  hasRun(sessionId: string, runId: string): boolean {
    const turn = this.turns.get(sessionId);
    return turn !== undefined && runKey(runId) !== undefined && turn.runId === runId;
  }

  /** Ids that entered context during `runId` (ignored for any other run, or none). */
  noteRunIds(sessionId: string, runId: string | undefined, ids: readonly string[]): void {
    const run = this.run(sessionId, runId);
    if (run === null) return;
    for (const id of ids) {
      if (!validId(id)) continue;
      if (run.set.has(id)) run.ids.splice(run.ids.indexOf(id), 1);
      run.ids.unshift(id);
      run.set.add(id);
    }
    if (run.ids.length > EXCLUDE_MAX) {
      // Bounded: forgetting an id in context could repeat it, so the run
      // goes blind instead (no activity delivery until the next snapshot).
      for (const id of run.ids.splice(EXCLUDE_MAX)) run.set.delete(id);
      run.blind ??= 'ledger_overflow';
    }
  }

  /** The run can no longer be trusted to know what is in context (see RunLedger.blind). */
  markBlind(sessionId: string, reason: string, runId?: string): void {
    const run = runId === undefined ? this.runs.get(sessionId) : this.run(sessionId, runId);
    if (run !== undefined && run !== null) run.blind ??= reason;
    this.cache.delete(sessionId);
  }

  /** Why the run is blind, or null. */
  blindReason(sessionId: string, runId: string): string | null {
    return this.run(sessionId, runId)?.blind ?? null;
  }

  /** TEST/inspection: did the run overflow its bound? */
  runOverflow(sessionId: string, runId: string): boolean {
    return this.run(sessionId, runId)?.blind === 'ledger_overflow';
  }

  deliveryEnabled(_session: SessionRef): boolean {
    return true; // no latching OFF switch on OpenClaw (decision 4d is claude-code-only)
  }

  restored(session: SessionRef): boolean {
    return this.turns.get(session.id)?.restored ?? false;
  }

  rebuildLedger(session: SessionRef): Ledger {
    const turn = this.turns.get(session.id);
    if (turn === undefined) {
      return { idsMostRecentFirst: [], has: () => false, knownBootstrap: false };
    }
    const run = this.run(session.id, turn.runId);
    if (run !== null && run.blind !== null) {
      // Unknown view: claim nothing is in context (N3 stubs nothing; the
      // activity path refuses blind runs before it gets here).
      return { idsMostRecentFirst: [], has: () => false, knownBootstrap: turn.bootstrapIds !== null };
    }
    const scan = snapshotScan(turn.messages);
    const merged: string[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (validId(id) && !seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    };
    run?.ids.forEach(push); // newest: entered context during this run (after the snapshot)
    turn.drained.forEach(push); // drained into this run's request
    scan.all.forEach(push);
    (turn.bootstrapIds ?? []).forEach(push); // oldest: system space
    return {
      idsMostRecentFirst: merged,
      has: (id) => seen.has(id),
      knownBootstrap: turn.bootstrapIds !== null,
    };
  }

  /** The N3 cache, scoped to the current run; its ids also join the run ledger. */
  cacheLedger(session: SessionRef, ledger: Ledger): void {
    const runId = this.turns.get(session.id)?.runId;
    lruSet(this.cache, session.id, { runId, ledger });
    this.noteRunIds(session.id, runId, [...ledger.idsMostRecentFirst].reverse());
  }

  /** null when the cache belongs to an earlier run or the run is blind (never a stale view). */
  cachedLedger(session: SessionRef): Ledger | null {
    const cached = this.cache.get(session.id);
    const turn = this.turns.get(session.id);
    if (cached === undefined || cached.runId !== turn?.runId) return null;
    return this.run(session.id, turn?.runId)?.blind ? null : cached.ledger;
  }

  /**
   * Locate `ct` and probe `ct wisdom match --help` (both cached), so a
   * caller's match budget covers the match alone (review of PR #67). Warmed
   * at prompt time; concurrent callers share one attempt. Never throws.
   */
  ready(): Promise<void> {
    if (this.capable !== null) return Promise.resolve();
    this.warming ??= (async () => {
      try {
        const path = await this.deps.locator.locate();
        if (path !== null) await this.probe(path);
      } catch {
        /* fail quietly: the match reports the class */
      }
    })().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  /** null when probed (capable decided), else the outcome that stopped it. */
  private async probe(path: string): Promise<MatchOutcome | null> {
    if (this.capable !== null) return null;
    const probe = await this.deps.spawnFn({ command: path, args: ['wisdom', 'match', '--help'], timeoutMs: 3000 });
    if (probe.spawnError || probe.timedOut) return 'spawn';
    // Non-zero exit: deterministic absence (CT < 3.3.0), latched OFF.
    this.capable = probe.code === 0;
    return null;
  }

  async wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
    signal?: AbortSignal,
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    if (this.capable === false) return { outcome: 'timeout_or_exit' };
    const path = await this.deps.locator.locate();
    if (path === null) return { outcome: 'spawn' };
    const stopped = await this.probe(path);
    if (stopped !== null) return { outcome: stopped };
    // The probe may have just latched it OFF (TS narrowed the field above).
    if ((this.capable as boolean | null) === false) return { outcome: 'timeout_or_exit' };
    return coreWisdomMatch(path, query, max, exclude, this.deps.spawnFn, signal);
  }

  isCtRecallResult(result: unknown): boolean {
    return parseResult(result) !== null;
  }

  envelopeFactIds(result: unknown): string[] {
    const parsed = parseResult(result);
    if (parsed === null) return [];
    const ids: string[] = [];
    for (const block of parsed.blocks) {
      for (const entry of block.inner.wiki_entries) {
        const id = (entry as { id?: unknown } | null)?.id;
        if (validId(id) && !ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Reference dedup (ct_tool_dedup): stub repeated entries in every recall
   * block, then append one marker trailer line per NEW id to the first block —
   * envelope JSON first, trailer after it. Other blocks and `details` pass
   * through untouched.
   */
  rewriteEnvelopeStub(result: unknown, repeats: string[], newIds: string[]): unknown {
    const parsed = parseResult(result);
    if (parsed === null) return result;
    const stubs = new Set(repeats);
    const content = [...parsed.outer.content];
    parsed.blocks.forEach((block, n) => {
      const inner = {
        ...block.inner,
        wiki_entries: block.inner.wiki_entries.map((entry) => {
          const id = (entry as { id?: unknown } | null)?.id;
          return validId(id) && stubs.has(id) ? stubEntry(id) : entry;
        }),
      };
      const trailer = n === 0 ? newIds.map((id) => `\n${marker(id)}`).join('') : '';
      content[block.index] = {
        ...(content[block.index] as Record<string, unknown>),
        text: block.prefix + JSON.stringify(inner) + trailer,
      };
    });
    return { ...parsed.outer, content };
  }

  resetDiscoveryAndProbeCaches(): void {
    this.deps.locator.invalidate();
    if (this.capable === true) this.capable = null;
  }

  wisdomMatchAbsent(): boolean {
    return this.capable === false;
  }

  deliver(_session: SessionRef, _block: string): void {
    // N2 is the hook's return value (prependContext); the host persists it.
  }

  noteDelivered(_session: SessionRef, _ids: string[]): void {
    // The ledger is rebuilt from the host snapshot each turn (m5).
  }
}

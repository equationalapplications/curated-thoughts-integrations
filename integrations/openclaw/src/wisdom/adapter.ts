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
 *   Session id   — OpenClaw `sessionKey` (stable across compaction).
 */

import {
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
const STRUCTURED_PREFIX = 'structuredContent:\n';
const SNAPSHOT_SCAN_ROLES = new Set(['user', 'toolResult', 'tool']);

/** m4: the CT recall surface only — never curated_get_wiki_entry. */
export function isRecallToolName(name: unknown): boolean {
  return typeof name === 'string' && RECALL_TOOL_RE.test(name);
}

function partTexts(content: unknown): string[] {
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

export class OpenClawWisdomAdapter implements HostAdapter {
  private readonly turns = new Map<string, TurnInput>();
  private readonly cache = new Map<string, Ledger>();
  /** null = not probed yet; true = `ct wisdom match` present; false = absent (latched). */
  private capable: boolean | null = null;

  /** Verbose mode only (absent when off, so the adapter is unchanged). */
  declare readonly recordVerbose?: (turn: VerboseTurn) => void;

  constructor(private readonly deps: AdapterDeps) {
    if (deps.recordVerbose) this.recordVerbose = deps.recordVerbose;
  }

  setTurn(sessionId: string, input: TurnInput): void {
    lruSet(this.turns, sessionId, input);
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
    const scan = snapshotScan(turn.messages);
    const merged: string[] = [];
    const push = (id: string) => {
      if (validId(id) && !merged.includes(id)) merged.push(id);
    };
    turn.drained.forEach(push); // newest: drained into this very request
    scan.all.forEach(push);
    (turn.bootstrapIds ?? []).forEach(push); // oldest: system space
    const set = new Set(merged);
    return {
      idsMostRecentFirst: merged,
      has: (id) => set.has(id),
      knownBootstrap: turn.bootstrapIds !== null,
    };
  }

  cacheLedger(session: SessionRef, ledger: Ledger): void {
    lruSet(this.cache, session.id, ledger);
  }

  cachedLedger(session: SessionRef): Ledger | null {
    return this.cache.get(session.id) ?? null;
  }

  async wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    if (this.capable === false) return { outcome: 'timeout_or_exit' };
    const path = await this.deps.locator.locate();
    if (path === null) return { outcome: 'spawn' };
    if (this.capable === null) {
      const probe = await this.deps.spawnFn({ command: path, args: ['wisdom', 'match', '--help'], timeoutMs: 3000 });
      if (probe.spawnError || probe.timedOut) return { outcome: 'spawn' };
      if (probe.code !== 0) {
        this.capable = false; // deterministic absence (CT < 3.3.0): latch OFF
        return { outcome: 'timeout_or_exit' };
      }
      this.capable = true;
    }
    return coreWisdomMatch(path, query, max, exclude, this.deps.spawnFn);
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

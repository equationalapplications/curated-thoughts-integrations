/**
 * ledger.ts — `ct-fact:<id>` markers, sanitization, and transcript-derived
 * ledger scanning (port of `integrations/hermes/scripts/ct_ledger.py`).
 *
 * The ledger is NEVER stored: hosts rebuild it each turn from their persisted
 * context (INTENT M1 — no plugin persistence). A turn-scoped cache only carries
 * the N1 rebuild to the N3 transform within one turn; it is a speed aid, never
 * a source of truth across turns.
 *
 * Every function tolerates malformed input without throwing.
 */

import { FACT_ID_RE, FACT_TOKEN, SCAN_RE } from './constants.js';

/** True for a CT fact id usable in a marker (spec CT guarantee 4). */
export function validId(value: unknown): value is string {
  return typeof value === 'string' && FACT_ID_RE.test(value);
}

/** The HTML-comment marker that tags a fact id in persisted context. */
export function marker(factId: string): string {
  return `<!-- ct-fact:${factId} -->`;
}

/**
 * Remove every `ct-fact:` token, repeatedly until stable (one pass can splice
 * a fresh token together — "ct-f" + "act:" + "x" survives a single replace).
 * Applied to fact titles/text so a fact can never forge a ledger entry.
 */
export function stripForged(value: string): string {
  let current = value;
  while (current.includes(FACT_TOKEN)) {
    current = current.split(FACT_TOKEN).join('');
  }
  return current;
}

/** Ordered unique ids following `ct-fact:` in text. */
export function scanIds(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  SCAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN_RE.exec(text)) !== null) {
    const id = m[1];
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** One history message: `content` plus the host's `api_content` sidecar. */
export interface HistoryMessage {
  role?: string;
  content?: unknown;
  api_content?: unknown;
  [key: string]: unknown;
}

/** Every text field of one message: string content, or text parts of a list. */
function messageTexts(msg: HistoryMessage): string[] {
  const texts: string[] = [];
  for (const key of ['content', 'api_content'] as const) {
    const value = msg[key];
    if (typeof value === 'string') {
      texts.push(value);
    } else if (Array.isArray(value)) {
      for (const part of value) {
        if (typeof part === 'string') texts.push(part);
        else if (
          part !== null &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          texts.push((part as { text: string }).text);
        }
      }
    }
  }
  return texts;
}

/**
 * Unique ids in history, most recent message first (the order the `--exclude`
 * bound keeps, m8). `roles` restricts to messages with those roles.
 */
export function historyIds(
  history: unknown,
  roles?: readonly string[],
): string[] {
  if (!Array.isArray(history)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === null || typeof msg !== 'object') continue;
    const m = msg as HistoryMessage;
    if (roles !== undefined && !roles.includes(m.role as string)) continue;
    for (const text of messageTexts(m)) {
      for (const id of scanIds(text)) {
        if (!seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return out;
}

/**
 * Turn-scoped ledger cache: {session_id -> ids}, LRU-bounded, carried from
 * the N1 pre-turn hook to the N3 tool-result transform within one turn.
 * Not a source of truth across turns (M1).
 */
export class LedgerCache {
  private store = new Map<string, Set<string>>();

  constructor(private readonly max = 256) {}

  get(sessionId: string): Set<string> | null {
    const ids = this.store.get(sessionId);
    if (ids === undefined) return null;
    // Map iteration order = insertion; delete+set moves the key to the end.
    this.store.delete(sessionId);
    this.store.set(sessionId, ids);
    return new Set(ids);
  }

  put(sessionId: string, ids: Iterable<string>): void {
    this.store.set(sessionId, new Set(ids));
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  /** Union ids into an existing entry; no-op when the session is absent. */
  add(sessionId: string, ids: Iterable<string>): void {
    const current = this.store.get(sessionId);
    if (current === undefined) return;
    for (const id of ids) current.add(id);
  }

  clear(): void {
    this.store.clear();
  }
}

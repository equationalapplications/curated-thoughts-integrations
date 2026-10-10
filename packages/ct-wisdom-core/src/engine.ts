/**
 * engine.ts — the Annex A normative algorithm. Host adapters implement the
 * `HostAdapter` operations; all policy (budgets, breaker, corrections-only
 * rule, exclusion ordering, sanitization) lives here so every TS leg behaves
 * identically to the Hermes reference.
 */

import { Breaker } from './breaker.js';
import {
  EXCLUDE_MAX,
  MAX_PER_SESSION,
  MAX_PER_TURN,
  QUERY_CHARS,
} from './constants.js';
import { scanIds, stripForged, validId } from './ledger.js';
import { renderBlock } from './render.js';
import { EMPTY_LEDGER } from './types.js';
import type {
  HostAdapter,
  Ledger,
  SessionRef,
  WisdomMatchResult,
} from './types.js';

/** Query derived from the user message: sanitized + char-capped. */
export function buildQuery(userMessage: unknown): string {
  const raw = typeof userMessage === 'string' ? userMessage : '';
  return stripForged(raw).trim().slice(0, QUERY_CHARS).trim();
}

/**
 * `on user_turn` (N1+N2). Resolves to the delivered block, or null when the
 * turn delivers nothing (silent no-op — never an error surfaced to the host).
 */
export async function onUserTurn(
  host: HostAdapter,
  session: SessionRef,
  userMessage: unknown,
  breaker: Breaker = new Breaker(),
): Promise<string | null> {
  // Invariant 3: no session identity — nothing is trackable, deliver nothing.
  if (!session || typeof session.id !== 'string' || session.id === '') {
    return null;
  }
  // Latching OFF switch (GLM r2): CC resume marks the session OFF-for-life in
  // the store; this fires before any bootstrap check and must not re-enable.
  if (!host.deliveryEnabled(session)) return null;

  // N4 source of truth; cached BEFORE any early return (m1): degraded turns
  // still dedup agent-initiated CT calls in the N3 transform.
  const ledger = host.rebuildLedger(session);
  host.cacheLedger(session, ledger);

  // Fail closed on restored sessions with no known bootstrap (Hermes M2).
  if (host.restored(session) && !ledger.knownBootstrap) return null;
  if (host.wisdomMatchAbsent() || breaker.isOpen()) return null;

  const query = buildQuery(userMessage);
  if (query === '') return null;

  // M1 session budget: counts only ids delivered via the LIVE path.
  // Exhaustion does NOT stop the call — it forces corrections-only.
  const liveUsed = ledger.liveDeliveredCount;
  const maxN = liveUsed >= MAX_PER_SESSION ? 0 : MAX_PER_TURN;
  // m8: newest first — corrections only flow for ids actually sent, and a
  // wrong ordering silently delays or loses supersession corrections.
  const exclude = ledger.idsMostRecentFirst.slice(0, EXCLUDE_MAX);

  const attempt = await host.wisdomMatch(query, maxN, exclude);
  if (attempt.outcome !== 'ok' || !attempt.result) {
    if (attempt.outcome === 'timeout_or_exit') breaker.recordFailure();
    if (attempt.outcome === 'spawn') host.resetDiscoveryAndProbeCaches(); // n3
    return null;
  }
  breaker.recordSuccess();

  // Always post-filter against the ledger (the `--exclude` bound is a subset
  // of the context view; the two can disagree transiently).
  const entries = attempt.result.entries.filter(
    (e) => !validId(e?.id) || !ledger.has(e.id),
  );
  // Corrections are exempt from the budget and from the exclude filter —
  // superseding a fact already in context is the point of a correction.
  const corrections = attempt.result.corrections;
  const match: WisdomMatchResult = { entries, corrections };

  const { text, deliveredIds } = renderBlock(match);
  if (text.trim() === '') return null;

  host.deliver(session, text);
  if (deliveredIds.length > 0) {
    host.noteDelivered(session, deliveredIds);
    // Same-turn dedup (mirrors the reference's LEDGER_CACHE.add): the N3
    // transform within THIS turn must already see the ids we just delivered.
    const merged = [...ledger.idsMostRecentFirst];
    for (const id of deliveredIds) {
      if (!merged.includes(id)) merged.unshift(id);
    }
    host.cacheLedger(session, {
      idsMostRecentFirst: merged,
      has: (id) => merged.includes(id),
      liveDeliveredCount: ledger.liveDeliveredCount + deliveredIds.length,
      knownBootstrap: ledger.knownBootstrap,
    });
  }
  return text;
}

/**
 * `on tool_result` (N3): dedup stub only. Returns the (possibly rewritten)
 * result; the m2 rule holds — when the cached view is advisory (DSH), the
 * adapter's `isCtRecallResult`/envelope ops derive from the session log, and
 * the decision below may consult a fresh rebuild when no cache exists.
 */
export function onToolResult(
  host: HostAdapter,
  session: SessionRef,
  result: unknown,
): unknown {
  if (!session || typeof session.id !== 'string' || session.id === '') {
    return result;
  }
  if (!host.isCtRecallResult(result)) return result;

  let ledger: Ledger | null =
    host.cachedLedger ? host.cachedLedger(session) : null;
  const fromCache = ledger !== null;
  if (ledger === null) ledger = host.rebuildLedger(session);

  const ids = host.envelopeFactIds(result);
  const repeats = ids.filter((id) => validId(id) && ledger!.has(id));
  // New = a valid envelope id NOT already in the rebuilt/cached ledger view —
  // it is delivered for the first time by THIS tool result, so the persisted
  // copy must carry its ct-fact marker (mirrors the reference's new_ids /
  // LEDGER_CACHE.add in ct_tool_dedup).
  const newIds = ids.filter((id) => validId(id) && !ledger!.has(id));
  if (repeats.length > 0 || newIds.length > 0) {
    result = host.rewriteEnvelopeStub(result, repeats, newIds);
  }
  // Union the ids this result now carries into the turn cache (mirrors the
  // reference's LEDGER_CACHE.add in ct_tool_dedup): a SECOND recall within
  // the same turn must see the first recall's ids and stub the repeat.
  // On the fallback-rebuild path (no cached view) the rebuilt ids are also
  // merged, but only the cache is written — the rebuild stays authoritative.
  const merged = [...ledger.idsMostRecentFirst];
  for (const id of ids) {
    if (validId(id) && !merged.includes(id)) merged.unshift(id);
  }
  host.cacheLedger(session, {
    idsMostRecentFirst: merged,
    has: (id) => merged.includes(id),
    liveDeliveredCount: ledger.liveDeliveredCount,
    knownBootstrap: ledger.knownBootstrap,
  });
  return result;
}

/** Convenience for adapters: scan a text blob for fact ids. */
export { scanIds, stripForged, validId } from './ledger.js';
export { EMPTY_LEDGER } from './types.js';
export type {
  Correction,
  FactEntry,
  HostAdapter,
  Ledger,
  MatchOutcome,
  SessionRef,
  WisdomMatchResult,
} from './types.js';

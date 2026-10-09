/**
 * types.ts — shared types for the Annex A algorithm and the host adapter
 * interface. Host adapters implement the `host.*` operations; the core owns
 * all policy (budgets, breaker, rendering, sanitize, corrections rule).
 */

/** A wiki fact as returned by `ct wisdom match` (subset the core needs). */
export interface FactEntry {
  id: string;
  title?: string;
  text?: string;
  [key: string]: unknown;
}

/** A supersession correction (exempt from the per-session budget). */
export interface Correction {
  id: string;
  supersedes?: string[];
  title?: string;
  text?: string;
  [key: string]: unknown;
}

/** Parsed result of one `ct wisdom match` invocation. */
export interface WisdomMatchResult {
  entries: FactEntry[];
  corrections: Correction[];
}

/** Outcome class of a subprocess attempt — drives breaker vs cache reset. */
export type MatchOutcome = 'ok' | 'timeout_or_exit' | 'spawn';

/** The ledger: ids present in the session's context, newest first. */
export interface Ledger {
  /** Unique fact ids visible in context right now, most recent first. */
  idsMostRecentFirst: string[];
  /** O(1) membership mirror of {@link idsMostRecentFirst}. */
  has(id: string): boolean;
  /** Count of ids this session delivered via the LIVE path (M1 budget). */
  liveDeliveredCount: number;
  /** True when this session's bootstrap block ids are in the ledger (N5). */
  knownBootstrap: boolean;
}

export const EMPTY_LEDGER: Ledger = {
  idsMostRecentFirst: [],
  has: () => false,
  liveDeliveredCount: 0,
  knownBootstrap: false,
};

/** Anything a host must supply for one turn of the algorithm. */
export interface HostAdapter {
  /**
   * Latching OFF switch (GLM r2). CC marks resumed sessions OFF-for-life in
   * its store, so this fires before any bootstrap check. Hosts without a
   * latch return `true` unconditionally.
   */
  deliveryEnabled(session: SessionRef): boolean;

  /** True when the session was restored rather than started fresh. */
  restored(session: SessionRef): boolean;

  /** N4 source of truth: rebuild the ledger from host-persisted context. */
  rebuildLedger(session: SessionRef): Ledger;

  /**
   * Cache the rebuilt ledger BEFORE any early return (m1): the N3 transform
   * must be able to dedup agent-initiated CT calls even on turns that deliver
   * nothing — degraded turns still dedup.
   */
  cacheLedger(session: SessionRef, ledger: Ledger): void;

  /** Cached ledger from the current turn's N1 rebuild, if any (m2). */
  cachedLedger?(session: SessionRef): Ledger | null;

  /** Run `ct wisdom match` under the core's timeout; never throws. */
  wisdomMatch(
    query: string,
    max: number,
    exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }>;

  /** True when a tool result is an agent-initiated CT recall (m4). */
  isCtRecallResult(result: unknown): boolean;

  /** Fact ids carried by a CT recall envelope (parse; empty on malformed). */
  envelopeFactIds(result: unknown): string[];

  /** Rewrite repeated ids in a recall envelope down to stubs (option A). */
  rewriteEnvelopeStub(result: unknown, repeats: string[]): unknown;

  /** n3: retry next turn — drop discovery/probe caches after a spawn failure. */
  resetDiscoveryAndProbeCaches(): void;

  /** Capability probe: is the `wisdom_match` subcommand present? */
  wisdomMatchAbsent(): boolean;

  /** N2 delivery (channel="append"); host persists. */
  deliver(session: SessionRef, block: string): void;

  /** Per-host delivered-id bookkeeping (A.1); called after a live delivery. */
  noteDelivered(session: SessionRef, ids: string[]): void;
}

/** Minimal session handle the host supplies on every hook. */
export interface SessionRef {
  /** Host-stable session id; empty string disables everything (invariant 3). */
  id: string;
}

/**
 * constants.ts — frozen algorithm constants (spec Annex A).
 *
 * "frozen, no config surface": every adapter consumes these values directly;
 * none of them is tunable per host or per environment. Changing a value here
 * changes the normative algorithm for every leg at once.
 */

/**
 * Max wiki facts delivered on one user turn (N2 block). There is no
 * per-session cap (removed 2026-10-16): the per-turn limits bound the noise,
 * and the ledger's dedup bounds a session's total to the distinct facts that
 * match its turns.
 */
export const MAX_PER_TURN = 2;

/** Max characters of the rendered, sanitized delivery block. */
export const MAX_BLOCK_CHARS = 1200;

/** CT subprocess timeout in milliseconds (`ct wisdom match`). */
export const TIMEOUT_MS = 3_000;

/** Max characters of the query derived from the user message. */
export const QUERY_CHARS = 2000;

/** Max ids sent as the `--exclude` bound (m8: newest first). */
export const EXCLUDE_MAX = 256;

/** Consecutive spawn failures that open the breaker. */
export const BREAKER_FAILS = 3;

/** Breaker open duration in milliseconds. */
export const BREAKER_PAUSE_MS = 300_000;

/** `ct-fact:` token that prefixes every fact-id marker. */
export const FACT_TOKEN = 'ct-fact:';

/** A fact id usable in a marker (spec CT guarantee 4). */
export const FACT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Scan pattern: a fact id directly following the `ct-fact:` token. */
export const SCAN_RE = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;

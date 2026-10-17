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

// ─────────────────────────────────────────────────────────────────────────
// Autonomous-work ("activity") delivery — frozen like the live constants
// (spec 2026-10-16-dsh-autonomous-work-wisdom-design.md; Hermes parity,
// ct_wisdom_activity.py). User decision 5: 1 fact, ≤ 600 chars.
// ─────────────────────────────────────────────────────────────────────────

/** Max facts in one activity delivery. */
export const ACTIVITY_MAX_PER_STEP = 1;

/** Max characters of one rendered activity block. */
export const ACTIVITY_MAX_BLOCK_CHARS = 600;

/** Max characters of an activity query (the bare target). */
export const ACTIVITY_QUERY_CHARS = 300;

/** Max characters of one activity target (path, pattern or command words). */
export const ACTIVITY_TARGET_CHARS = 200;

/** Max characters of the visible `_for: <line>_` label. */
export const ACTIVITY_LABEL_CHARS = 120;

/** Recent activity keys kept per session (LRU). */
export const ACTIVITY_RECENT_KEYS_MAX = 32;

/** Recent step ids kept per session (LRU) for the once-per-step rule. */
export const ACTIVITY_STEP_IDS_MAX = 16;

/** Sessions the activity tracker keeps (LRU). */
export const ACTIVITY_SESSIONS_MAX = 256;

/** Heading of an activity block (distinct from the user-turn heading). */
export const ACTIVITY_HEADING = '## Curated Thoughts — relevant to this step';

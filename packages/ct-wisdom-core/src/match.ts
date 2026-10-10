/**
 * match.ts — the `ct wisdom match` subprocess contract.
 *
 * Ports the Hermes `ct_wisdom.match_wisdom` boundary: the plugin never
 * scores, ranks, or thresholds; CT stays read-only behind this single CLI
 * call (CT >= 3.3.0). The adapter for each host binds this to its own spawn
 * primitive; the core owns argument construction, the 3 s budget, and the
 * outcome classification (timeout_or_exit vs spawn) that drives the breaker
 * vs the discovery-cache reset.
 */

import { TIMEOUT_MS } from './constants.js';
import type { MatchOutcome, WisdomMatchResult } from './types.js';

export interface SpawnLike {
  /** The CT entry point to execute (absolute ct path from discovery). */
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface SpawnOutcome {
  /** Exit code; null on timeout or spawn error. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary could not be launched at all (ENOENT, EACCES). */
  spawnError: boolean;
  timedOut: boolean;
}

export type SpawnFn = (spec: SpawnLike) => Promise<SpawnOutcome>;

/**
 * Build the argv for one `ct wisdom match` call — the shipped CT 3.3.0
 * contract (Hermes parity, ct_wisdom_live.match_wisdom): `--json` makes
 * stdout parseable, ids ride `--exclude=<id>` so they can never be read as
 * positional values, and the query goes LAST after `--` so arbitrary user
 * text can never parse as a flag.
 */
export function matchArgs(
  query: string,
  max: number,
  exclude: string[],
): string[] {
  const args = ['wisdom', 'match', '--json', '--max', String(max)];
  for (const id of exclude) {
    args.push(`--exclude=${id}`);
  }
  args.push('--', query);
  return args;
}

/** Classify a spawn outcome per Annex A (`res.failed` / breaker / n3). */
export function classify(outcome: SpawnOutcome): MatchOutcome {
  if (outcome.spawnError) return 'spawn';
  if (outcome.timedOut || outcome.code !== 0) return 'timeout_or_exit';
  return 'ok';
}

/** Parse stdout into entries + corrections; null on malformed output. */
export function parseMatchStdout(stdout: string): WisdomMatchResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const entries = Array.isArray(obj.entries) ? obj.entries : [];
    const corrections = Array.isArray(obj.corrections) ? obj.corrections : [];
    return {
      entries: entries.filter(
        (e): e is WisdomMatchResult['entries'][number] =>
          e !== null && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string',
      ),
      corrections: corrections.filter(
        (c): c is WisdomMatchResult['corrections'][number] =>
          c !== null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string',
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Full subprocess call: `ct wisdom match` under the 3 s budget. Never
 * throws; outcome classification drives the engine's breaker/n3 handling.
 */
export async function wisdomMatch(
  ctPath: string,
  query: string,
  max: number,
  exclude: string[],
  spawnFn: SpawnFn,
): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
  const raw = await spawnFn({
    command: ctPath,
    args: matchArgs(query, max, exclude),
    timeoutMs: TIMEOUT_MS,
  });
  const outcome = classify(raw);
  if (outcome !== 'ok') return { outcome };
  const result = parseMatchStdout(raw.stdout);
  if (result === null) return { outcome: 'timeout_or_exit' };
  return { outcome, result };
}

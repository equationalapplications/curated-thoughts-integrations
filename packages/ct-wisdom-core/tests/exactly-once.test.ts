/**
 * exactly-once.test.ts — shared-core port of the Hermes exactly-once property
 * test (integrations/hermes/tests/test_exactly_once.py, INTENT workflow 5).
 *
 * Property: across many randomized sessions (random user turns, random
 * compaction, random agent-initiated CT recalls, random corrections), no fact
 * id is ever present twice in the model-visible context — the bootstrap block,
 * live delivery blocks, and tool results combined.
 */

import { describe, expect, it } from 'vitest';

import { Breaker } from '../src/breaker.js';
import { onToolResult, onUserTurn } from '../src/engine.js';
import { historyIds, marker, scanIds } from '../src/ledger.js';
import { renderBlock } from '../src/render.js';
import type {
  HostAdapter,
  Ledger,
  MatchOutcome,
  SessionRef,
  WisdomMatchResult,
} from '../src/types.js';

const UNIVERSE = Array.from({ length: 16 }, (_, i) => `fact_${String(i).padStart(2, '0')}`);
const SESSIONS = 200;
const RECALL_TOOL = 'ct__curated_recall_context';

/** Deterministic PRNG so failures are reproducible (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, arr: T[]): T =>
  arr[Math.floor(r() * arr.length)];

function sample<T>(r: () => number, arr: T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  }
  return out;
}

const fact = (id: string, supersedes?: string[]): WisdomMatchResult['entries'][number] => ({
  id,
  title: 'T' + id,
  text: 'body ' + id,
  ...(supersedes ? { supersedes } : {}),
});

/** Session context as the MODEL sees it — the exactly-once surface. */
interface SimMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Simulated host. Context = bootstrap block + user-turn appends (N2,
 * host-persisted) + tool results (N3 rewrites). The ledger rebuilds from
 * that context each turn, exactly like a real host (N4, INTENT M1).
 */
class SimHost implements HostAdapter {
  session: SessionRef;
  context: SimMessage[] = [];
  /** Bootstrap ids: joined into context via the v1 memo on first live turn. */
  bootstrapIds: string[] = [];
  breaker: Breaker;
  deliveries = 0;
  cache: Set<string> | null = null;

  constructor(
    readonly id: string,
    readonly seed: number,
  ) {
    this.session = { id };
    this.breaker = new Breaker(3, 300_000);
  }

  deliveryEnabled(): boolean {
    return true;
  }

  restored(): boolean {
    return false;
  }

  rebuildLedger(_s: SessionRef): Ledger {
    const text = this.context.map((m) => m.content).join('\n');
    const ids = historyIds(this.context as unknown[]);
    void text;
    return {
      idsMostRecentFirst: ids,
      has: (id) => ids.includes(id),
      // Live count = ids delivered on user-role messages (Hermes rule).
      liveDeliveredCount: new Set(
        this.context
          .filter((m) => m.role === 'user')
          .flatMap((m) => scanIds(m.content)),
      ).size,
      knownBootstrap: true,
    };
  }

  cacheLedger(_s: SessionRef, ledger: Ledger): void {
    this.cache = new Set(ledger.idsMostRecentFirst);
  }

  cachedLedger(_s: SessionRef): Ledger | null {
    if (this.cache === null) return null;
    const ids = [...this.cache];
    const set = new Set(ids);
    return {
      idsMostRecentFirst: ids,
      has: (id) => set.has(id),
      liveDeliveredCount: 0,
      knownBootstrap: true,
    };
  }

  async wisdomMatch(
    _query: string,
    max: number,
    exclude: string[],
  ): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    const rand = rng(this.seed + this.deliveries * 7919);
    // Half the time the fake CT ignores the exclude bound (transient ledger/
    // view disagreement) — the engine's post-filter must catch it.
    const pool =
      rand() < 0.5 ? UNIVERSE : UNIVERSE.filter((f) => !exclude.includes(f));
    const entries = sample(rand, pool, Math.min(pool.length, max)).map((f) =>
      fact(f),
    );
    const corrections: WisdomMatchResult['corrections'] = [];
    if (exclude.length > 0 && rand() < 0.3) {
      corrections.push(fact(pick(rand, UNIVERSE), [pick(rand, exclude)]));
    }
    return { outcome: 'ok', result: { entries, corrections } };
  }

  isCtRecallResult(result: unknown): boolean {
    return typeof result === 'string' && result.startsWith('CT::');
  }

  envelopeFactIds(result: unknown): string[] {
    if (typeof result !== 'string') return [];
    try {
      const parsed = JSON.parse(result.slice(4)) as { ids?: string[] };
      return Array.isArray(parsed.ids) ? parsed.ids : [];
    } catch {
      return [];
    }
  }

  rewriteEnvelopeStub(result: unknown, repeats: string[]): unknown {
    if (typeof result !== 'string') return result;
    const parsed = JSON.parse(result.slice(4)) as {
      ids?: string[];
      stubbed?: string[];
    };
    parsed.stubbed = repeats;
    parsed.ids = (parsed.ids ?? []).filter((id) => !repeats.includes(id));
    return 'CT::' + JSON.stringify(parsed);
  }

  /** Trail a rewritten envelope with markers (reference: ct_tool_dedup L85). */
  markEnvelope(result: string, newIds: string[]): string {
    if (newIds.length === 0) return result;
    return `${result}\n${newIds.map((id) => marker(id)).join('\n')}`;
  }

  resetDiscoveryAndProbeCaches(): void {}

  wisdomMatchAbsent(): boolean {
    return false;
  }

  deliver(_s: SessionRef, block: string): void {
    // In the real hosts the N2 append IS how the block reaches context (the
    // harness appends it to the turn's user message and persists it). The
    // sim mirrors that: the test harness appends `out` to the user message
    // below, so deliver() only counts the delivery.
    this.deliveries += 1;
    void block;
  }

  noteDelivered(_s: SessionRef, _ids: string[]): void {
    // Bookkeeping only; the ledger derives from persisted context.
  }
}

/** Every fact id present in the simulated context, with occurrence counts. */
function presentCounts(host: SimHost): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const msg of host.context) {
    if (msg.role === 'user') {
      // Title-line markers: `**T{id}** {marker}` (live + bootstrap blocks).
      for (const id of UNIVERSE) {
        const re = new RegExp(
          `\\*\\*T${id}\\*\\* ${marker(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          'g',
        );
        const hits = msg.content.match(re)?.length ?? 0;
        if (hits > 0) bump(id);
      }
    } else if (msg.role === 'tool') {
      // Tool results: every NON-STUBBED id counts as present; a stubbed id
      // was replaced by a one-line stub (option A), NOT delivered again.
      try {
        const parsed = JSON.parse(msg.content.slice(4)) as {
          ids?: string[];
          stubbed?: string[];
        };
        const stubbed = new Set(parsed.stubbed ?? []);
        for (const id of parsed.ids ?? []) {
          if (!stubbed.has(id)) bump(id);
        }
      } catch {
        /* malformed tool result carries no ids */
      }
    }
  }
  return counts;
}

function assertNoDupes(host: SimHost, where: string): void {
  for (const [id, n] of presentCounts(host)) {
    expect(n, `${where}: fact ${id} present ${n}x`).toBe(1);
  }
}

describe('exactly-once across randomized sessions (Hermes port)', () => {
  it('no fact twice in current context over 200 randomized sessions', async () => {
    for (let s = 0; s < SESSIONS; s++) {
      const rand = rng(0xc7ade + s);
      const host = new SimHost(`prop-${s}`, 0xbeef + s);
      // Random bootstrap block (v1 memo) joins the context before turn 1.
      host.bootstrapIds = sample(rand, UNIVERSE, Math.floor(rand() * 4));
      if (host.bootstrapIds.length > 0) {
        const boot = renderBlock({
          entries: host.bootstrapIds.map((f) => fact(f)),
          corrections: [],
        });
        host.context.push({ role: 'user', content: boot.text });
      }

      const turns = 1 + Math.floor(rand() * 12);
      for (let turn = 0; turn < turns; turn++) {
        // In-place compaction at turn start (drops oldest messages).
        if (host.context.length > 0 && rand() < 0.15) {
          const drop = 1 + Math.floor(rand() * host.context.length);
          host.context.splice(0, drop);
        }
        const question = `question ${turn}`;
        const out = await onUserTurn(
          host,
          host.session,
          question,
          host.breaker,
        );
        const userMsg: SimMessage = { role: 'user', content: question };
        if (out !== null) {
          userMsg.content = `${question}\n\n${out}`;
        }
        host.context.push(userMsg);
        host.context.push({ role: 'assistant', content: 'ok' });

        // Random agent-initiated CT recalls this turn.
        const recalls = Math.floor(rand() * 3);
        for (let k = 0; k < recalls; k++) {
          const ids = sample(rand, UNIVERSE, Math.floor(rand() * 5));
          let raw = 'CT::' + JSON.stringify({ ids });
          // The N3 transform consults the turn cache (with fallback rebuild)
          // and stubs repeats, including ids carried by an EARLIER recall in
          // this same turn (cache union rule).
          raw = onToolResult(host, host.session, raw) as string;
          // Trail the (possibly rewritten) envelope with ct-fact: markers for
          // every id still present — exactly what the reference's
          // transform_tool_result does, so the next rebuild can see them.
          const kept = (JSON.parse(raw.slice(4)) as { ids?: string[] }).ids ?? [];
          raw = host.markEnvelope(raw, kept);
          host.context.push({ role: 'tool', content: raw });
          assertNoDupes(host, `session ${host.id} turn ${turn} recall ${k}`);
        }
        assertNoDupes(host, `session ${host.id} turn ${turn}`);
      }
    }
  });

  it('corrections-only turns still dedup (m1) — targeted probe', async () => {
    const host = new SimHost('probe', 1);
    // Saturate the live budget: 12 ids already delivered on user messages,
    // in MAX_PER_TURN chunks, each chunk carrying DISTINCT ids (a fact twice
    // in one block would be an exactly-once violation of its own).
    for (let i = 0; i < 6; i++) {
      const chunk = renderBlock({
        entries: UNIVERSE.slice(i * 2, i * 2 + 2).map((f) => fact(f)),
        corrections: [],
      });
      host.context.push({ role: 'user', content: `d${i}\n\n${chunk.text}` });
    }
    const ledger = host.rebuildLedger(host.session);
    expect(ledger.liveDeliveredCount).toBe(12);

    // A turn now must be corrections-only: the two ids in `chunk` are already
    // present, so the block carries nothing new (they are post-filtered).
    const out = await onUserTurn(host, host.session, 'next question', host.breaker);
    if (out !== null) {
      // Whatever the fake CT returned, no already-present id may appear again.
      for (const id of UNIVERSE.slice(0, 12)) {
        expect(out.match(new RegExp(`\\*\\*T${id}\\*\\*`))).toBeNull();
      }
    }
    assertNoDupes(host, 'saturated probe');
  });
});

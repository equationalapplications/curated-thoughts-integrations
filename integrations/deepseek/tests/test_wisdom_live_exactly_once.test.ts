/**
 * test_wisdom_live_exactly_once.test.ts — the shared exactly-once property
 * test, ported to the DSH binding (packages/ct-wisdom-core
 * tests/exactly-once.test.ts SimHost pattern → DshWisdomAdapter).
 *
 * Property: across many randomized sessions (random user turns, random
 * compaction, random agent-initiated CT recalls, random corrections), no fact
 * id is ever present twice in the model-visible context — the bootstrap
 * record, live delivery blocks (persisted user messages), and tool results
 * combined.
 *
 * DSH deltas from the core's SimHost:
 *   - context = the session log as the adapter rebuilds it (user + tool
 *     roles via sessionMessages — what deriveMessages() would return);
 *   - the N2 append is OUR listener's job in production, so the harness here
 *     appends the delivered block to the turn's user message exactly like
 *     the pre-step listener does (block message with source.kind);
 *   - N3 rewrites a REAL recall envelope ({result: "<CT JSON>"}), trailing
 *     ct-fact markers on the content blocks (the post-execute rewrite).
 */

import { describe, expect, it } from 'vitest';

import { onToolResult, onUserTurn, Breaker, marker } from '@equational-applications/ct-wisdom-core';
import type {
  Ledger,
  SpawnFn,
  WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import { DshWisdomAdapter, type AdapterDeps } from '../src/wisdom-live/adapter.js';

const UNIVERSE = Array.from({ length: 16 }, (_, i) => `fact_${String(i).padStart(2, '0')}`);
const SESSIONS = 200;

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

const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

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

interface LogMessage {
  role: 'user' | 'assistant' | 'tool';
  content: Array<{ type: string; text?: string }>;
}

const textBlock = (text: string) => ({ type: 'text', text });

/**
 * DSH host: the session log the adapter rebuilds from, plus the exact
 * envelope shape the post-execute waterfall sees.
 */
class DshSim {
  log: LogMessage[] = [];
  adapter: DshWisdomAdapter;
  breaker = new Breaker();
  deliveries = 0;
  turnCache: Set<string> | null = null;

  constructor(
    readonly id: string,
    readonly seed: number,
    readonly fakeSpawn: SpawnFn,
    deps?: Partial<AdapterDeps>,
  ) {
    this.adapter = new DshWisdomAdapter({
      env: {},
      discover: () => ({ path: '/bin/ct', failure: null }),
      spawnFn: fakeSpawn,
      ...deps,
    });
    this.syncLog();
  }

  /** Publish the log snapshot the way the pre-step listener does. */
  syncLog(): void {
    this.adapter.sessionMessages.set(this.id, this.log);
  }

  /** N1: run one turn; append the delivered block the way the listener does. */
  async turn(rand: () => number, question: string): Promise<void> {
    // Compaction: surface replacement inside the same session log (drops
    // oldest messages; agent id does NOT rotate).
    if (this.log.length > 0 && rand() < 0.15) {
      const drop = 1 + Math.floor(rand() * this.log.length);
      this.log.splice(0, drop);
    }
    this.syncLog();
    const out = await onUserTurn(
      this.adapter,
      { id: this.id },
      question,
      this.breaker,
    );
    const userMsg: LogMessage = {
      role: 'user',
      content: [textBlock(question)],
    };
    if (out !== null) {
      this.deliveries += 1;
      userMsg.content.push(textBlock(out));
    }
    this.log.push(userMsg);
    this.log.push({ role: 'assistant', content: [textBlock('ok')] });
    this.syncLog();
  }

  /** N3: one agent-initiated CT recall of the given ids. */
  recall(rand: () => number, ids: string[]): void {
    const envelope = {
      result: JSON.stringify({
        wiki_entries: ids.map((id) => ({ id, title: 'T' + id, text: 'full ' + id })),
      }),
    };
    const rewritten = onToolResult(this.adapter, { id: this.id }, envelope) as typeof envelope;
    const kept = (
      JSON.parse(rewritten.result) as { wiki_entries: Array<{ id?: string }> }
    ).wiki_entries
      .map((e) => e.id)
      .filter((id): id is string => typeof id === 'string');
    // The post-execute content: each kept id carries its trailing marker
    // (mirrors the reference's transform_tool_result), so the next ledger
    // rebuild can see it.
    this.log.push({
      role: 'tool',
      content: [
        textBlock(
          JSON.stringify(rewritten) +
            '\n' +
            kept.map((id) => marker(id)).join('\n'),
        ),
      ],
    });
    this.syncLog();
  }
}

/** Every fact id present in the simulated model-visible context. */
function presentCounts(sim: DshSim): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const msg of sim.log) {
    const texts = msg.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (msg.role === 'user') {
      // Title-line markers: `**T{id}** <!-- ct-fact:{id} -->` (live + bootstrap blocks).
      for (const id of UNIVERSE) {
        const re = new RegExp(
          `\\*\\*T${id}\\*\\* ${marker(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          'g',
        );
        for (const text of texts) {
          const hits = text.match(re)?.length ?? 0;
          if (hits > 0) bump(id);
        }
      }
    } else if (msg.role === 'tool') {
      // Tool results: NON-STUBBED ids count as present (a stubbed id was
      // replaced by the one-line stub, NOT delivered again).
      for (const text of texts) {
        const jsonPart = text.split('\n')[0] ?? '';
        try {
          const outer = JSON.parse(jsonPart) as { result?: string };
          const inner = JSON.parse(outer.result ?? '{}') as {
            wiki_entries?: Array<Record<string, unknown>>;
          };
          for (const entry of inner.wiki_entries ?? []) {
            const id = entry.id;
            if (typeof id === 'string' && entry.in_context !== true) bump(id);
          }
        } catch {
          /* malformed tool result carries no ids */
        }
      }
    }
  }
  return counts;
}

function assertNoDupes(sim: DshSim, where: string): void {
  for (const [id, n] of presentCounts(sim)) {
    expect(n, `${where}: fact ${id} present ${n}x`).toBe(1);
  }
}

/**
 * The adapter's wisdomMatch runs the REAL spawn contract, so the fake encodes
 * the result JSON on the match call (the core's SimHost faked
 * HostAdapter.wisdomMatch directly — this is one layer lower).
 */
function fakeCtFor(matchFor: (query: string, max: number, exclude: string[]) => WisdomMatchResult): SpawnFn {
  return (spec) =>
    Promise.resolve({
      code: 0,
      stdout: '',
      stderr: '',
      spawnError: false,
      timedOut: false,
      ...(spec.args[2] === '--help'
        ? {}
        : {
            stdout: JSON.stringify(
              matchFor(
                spec.args[spec.args.indexOf('--query') + 1] ?? '',
                Number(spec.args[spec.args.indexOf('--max') + 1] ?? 0),
                spec.args.slice(spec.args.indexOf('--exclude') + 1).filter((a) => a !== undefined && !a.startsWith('--')),
              ),
            ),
          }),
    });
}

describe('exactly-once across randomized sessions (DSH binding)', () => {
  it('no fact twice in current context over 200 randomized sessions', async () => {
    for (let s = 0; s < SESSIONS; s++) {
      const rand = rng(0xc7ade + s);
      const seed = 0xbeef + s;
      // Random fake CT: ignores the exclude bound half the time (the
      // engine's post-filter must catch it) and emits random corrections.
      const fake: SpawnFn = fakeCtFor((_q, max, exclude) => {
        const r = rng(seed + 7919);
        const pool = r() < 0.5 ? UNIVERSE : UNIVERSE.filter((f) => !exclude.includes(f));
        const entries = sample(r, pool, Math.min(pool.length, max)).map((f) => fact(f));
        const corrections: WisdomMatchResult['corrections'] = [];
        if (exclude.length > 0 && r() < 0.3) {
          corrections.push(fact(pick(r, UNIVERSE), [pick(r, exclude)]));
        }
        return { entries, corrections };
      });
      const sim = new DshSim(`prop-${s}`, seed, fake);
      // Random bootstrap record (v1 memo with ids) — mirrors the marker
      // amendment: the section block lands in the system prompt with
      // markers; recorded ids join the ledger (N5). The block itself is not
      // a log message on DSH (it is a prompt section), but its ids ARE in
      // the ledger — exactly what bootstrapMemo encodes.
      const bootIds = sample(rand, UNIVERSE, Math.floor(rand() * 4));
      if (bootIds.length > 0) {
        const { renderBlock } = await import('@equational-applications/ct-wisdom-core');
        const boot = renderBlock({ entries: bootIds.map((f) => fact(f)), corrections: [] });
        sim.adapter.bootstrapMemo[sim.id] = { block: boot.text, ids: bootIds };
      }

      const turns = 1 + Math.floor(rand() * 12);
      for (let turn = 0; turn < turns; turn++) {
        await sim.turn(rand, `question ${turn}`);
        // Random agent-initiated CT recalls this turn.
        const recalls = Math.floor(rand() * 3);
        for (let k = 0; k < recalls; k++) {
          const ids = sample(rand, UNIVERSE, Math.floor(rand() * 5));
          sim.recall(rand, ids);
          assertNoDupes(sim, `session ${sim.id} turn ${turn} recall ${k}`);
        }
        assertNoDupes(sim, `session ${sim.id} turn ${turn}`);
      }
    }
  });

  it('saturated live budget → corrections-only turns still dedup (m1)', async () => {
    const rand = rng(42);
    const fake: SpawnFn = fakeCtFor((_q, max, exclude) => {
      const r = rng(7);
      const pool = UNIVERSE.filter((f) => !exclude.includes(f));
      return {
        entries: sample(r, pool, Math.min(pool.length, max)).map((f) => fact(f)),
        corrections: [],
      };
    });
    const sim = new DshSim('probe', 1, fake);
    // Saturate: 12 distinct ids delivered on user messages, in MAX_PER_TURN
    // chunks with distinct ids per chunk.
    const { renderBlock } = await import('@equational-applications/ct-wisdom-core');
    for (let i = 0; i < 6; i++) {
      const chunk = renderBlock({
        entries: UNIVERSE.slice(i * 2, i * 2 + 2).map((f) => fact(f)),
        corrections: [],
      });
      sim.log.push({
        role: 'user',
        content: [textBlock(`d${i}`), textBlock(chunk.text)],
      });
    }
    sim.syncLog();
    const ledger: Ledger = sim.adapter.rebuildLedger({ id: sim.id });
    expect(ledger.liveDeliveredCount).toBe(12);

    const out = await onUserTurn(sim.adapter, { id: sim.id }, 'next question', sim.breaker);
    if (out !== null) {
      // Whatever the fake CT returned, no already-present id may appear again.
      for (const id of UNIVERSE.slice(0, 12)) {
        expect(out.match(new RegExp(`\\*\\*T${id}\\*\\*`))).toBeNull();
      }
    }
    assertNoDupes(sim, 'saturated probe');
  });
});

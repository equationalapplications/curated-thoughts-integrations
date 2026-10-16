/**
 * test_wisdom_live_exactly_once.test.ts — randomized multi-channel
 * exactly-once property test for the OpenCode leg (parent spec decision 6,
 * AC 2/AC 3; leg spec LD4/LD5/LD7/LD8). Pattern: Hermes test_exactly_once.py.
 *
 * A simulated OpenCode host persists exactly what the real 1.18.35 host
 * persists (leg spec H1/H3/H5): user messages with the parts chat.message
 * left on them, assistant tool parts whose `state.output` is the hook-
 * rewritten `content[].text` joined by "\n", compaction as an appended
 * summary row (rows are never deleted, H3). Channels mixed at random:
 *   - N1/N2 user turns in the parent (incl. host-synthetic parts),
 *   - N3 recalls in the parent and in child sessions, in all three carriers
 *     (MCP CallToolResult bare / Hermes-wrapped, builtin-style string),
 *   - compaction, process restarts (fresh plugin: memo/carry/caches lost),
 *   - child-session user turns (must never deliver),
 *   - a CT that ignores --exclude half the time and times out sometimes.
 *
 * Oracle (independent of the adapter; parses envelopes LINE 1 ONLY): per
 * session, no fact id reaches the model twice — every id in a delivered
 * part or a full (non-stub) recall entry is new to that session's context
 * (a child's context includes its parent's), and every stub names an id the
 * context already holds (a stub can only suppress).
 */
import { describe, expect, it } from 'vitest';
import type { SpawnFn, SpawnOutcome } from '@equational-applications/ct-wisdom-core';
import { createWisdomHooks, type WisdomHooks } from '../src/wisdom-live/hooks.js';
import { BOOT_MARKER, LIVE_MARKER } from '../src/wisdom-live/adapter.js';

type Part = Record<string, unknown>;
type Row = { info: { role: string; id: string }; parts: Part[] };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNIVERSE = Array.from({ length: 30 }, (_, i) => `F${i}`);
const SCAN = /ct-fact:([A-Za-z0-9._:-]{1,128})/g;
const idsIn = (text: string) => [...text.matchAll(SCAN)].map((m) => m[1]!);

function done(stdout: string): SpawnOutcome {
  return { code: 0, stdout, stderr: '', spawnError: false, timedOut: false };
}

/** Line-1-only recall parse (the trailer landmine): entries of a carrier text. */
function recallEntries(text: string): Array<Record<string, unknown>> | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text.split('\n', 1)[0]!);
  } catch {
    return null;
  }
  if (obj && typeof obj === 'object' && Array.isArray((obj as { wiki_entries?: unknown }).wiki_entries)) {
    return (obj as { wiki_entries: Array<Record<string, unknown>> }).wiki_entries;
  }
  const inner = (obj as { result?: unknown } | null)?.result;
  if (typeof inner === 'string') return recallEntries(inner);
  return null;
}

interface Sim {
  userTurn(session: string): Promise<void>;
  recall(session: string): Promise<void>;
  compact(): Promise<void>;
  restart(): void;
  rnd: () => number;
  readonly totals: { deliveries: number; recalls: number };
}

function makeSim(seed: number): Sim {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const sample = (n: number) => {
    const out = new Set<string>();
    while (out.size < n) out.add(pick(UNIVERSE));
    return [...out];
  };

  const rows: Record<string, Row[]> = { P: [], C1: [], C2: [] };
  const parents: Record<string, string | undefined> = { P: undefined, C1: 'P', C2: 'P' };
  const known: Record<string, Set<string>> = { P: new Set(), C1: new Set(), C2: new Set() };
  const contextOf = (s: string) => (parents[s] ? new Set([...known[s]!, ...known[parents[s]!]!]) : known[s]!);
  let seq = 0;
  let deliveries = 0;
  let recalls = 0;

  const spawnFn: SpawnFn = async (spec) => {
    if (spec.args.includes('--help')) return done('');
    if (rnd() < 0.05) return { code: null, stdout: '', stderr: '', spawnError: false, timedOut: true };
    const exclude = new Set(spec.args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice(10)));
    const max = Number(spec.args[spec.args.indexOf('--max') + 1]);
    let ids = sample(Math.floor(rnd() * 4));
    if (rnd() < 0.5) ids = ids.filter((id) => !exclude.has(id)); // honor --exclude only sometimes
    const entries = ids.slice(0, max).map((id) => ({ id, title: `t ${id}`, text: `body ${id}` }));
    return done(JSON.stringify({ entries, corrections: [] }));
  };

  const fresh = (): WisdomHooks =>
    createWisdomHooks({
      env: {},
      spawnFn,
      discover: () => ({ path: '/bin/ct', failure: null }),
      fetchHistory: async (id) => structuredClone(rows[id] ?? []),
      fetchSession: async (id) => (id in parents ? { parentID: parents[id] } : null),
      renderBootstrap: () =>
        `## Curated Thoughts — relevant memory\n\n${sample(2)
          .map((id) => `**t ${id}** <!-- ct-fact:${id} -->\nbody ${id}`)
          .join('\n\n')}`,
    }).hooks;
  let hooks = fresh();

  const userTurn = async (session: string) => {
    const id = `msg_${String(++seq).padStart(5, '0')}`;
    const parts: Part[] = [{ id: `prt_u${seq}`, type: 'text', text: `question ${seq}` }];
    if (rnd() < 0.15) parts.push({ id: `prt_s${seq}`, type: 'text', synthetic: true, text: 'Called the Read tool with the following input: {}' });
    const before = contextOf(session);
    const output = { message: { id, sessionID: session }, parts };
    await hooks['chat.message']({ sessionID: session } as never, output as never);
    const delivered = parts.filter(
      (p) => p.synthetic === true && typeof p.text === 'string' && /source\.kind: curated-thoughts\/wisdom/.test(p.text as string),
    );
    if (parents[session]) expect(delivered, `child ${session} must never get a delivery`).toEqual([]);
    const seenThisTurn = new Set<string>();
    for (const p of delivered) {
      const text = p.text as string;
      expect(text.split('\n').some((l) => l === LIVE_MARKER || l === BOOT_MARKER)).toBe(true);
      for (const fid of idsIn(text)) {
        expect(before.has(fid), `seed ${seed}: ${fid} redelivered to ${session}`).toBe(false);
        expect(seenThisTurn.has(fid), `seed ${seed}: ${fid} twice in one turn`).toBe(false);
        seenThisTurn.add(fid);
        known[session]!.add(fid);
        deliveries++;
      }
    }
    rows[session]!.push({ info: { role: 'user', id }, parts });
  };

  const recall = async (session: string) => {
    const ids = sample(1 + Math.floor(rnd() * 3));
    const body = JSON.stringify({ query: 'q', wiki_entries: ids.map((id) => ({ id, title: `t ${id}`, text: `body ${id}` })) });
    const carrier = pick(['mcp', 'wrapped', 'string'] as const);
    let persisted: string;
    if (carrier === 'string') {
      const output = { title: '', output: body, metadata: {} };
      await hooks['tool.execute.after']({ tool: 'curated-thoughts_curated_recall_context', sessionID: session, callID: 'c', args: {} }, output as never);
      persisted = output.output;
    } else {
      const text = carrier === 'mcp' ? body : JSON.stringify({ result: body });
      const output = { content: [{ type: 'text', text }] };
      await hooks['tool.execute.after']({ tool: 'curated-thoughts_curated_recall_context', sessionID: session, callID: 'c', args: {} }, output as never);
      persisted = output.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    }
    const entries = recallEntries(persisted);
    expect(entries, `seed ${seed}: rewritten envelope must stay parseable on line 1`).not.toBeNull();
    const ctx = contextOf(session);
    for (const e of entries!) {
      const fid = e.id as string;
      if (e.in_context === true) {
        expect(ctx.has(fid), `seed ${seed}: spurious stub for ${fid} in ${session}`).toBe(true);
      } else {
        expect(ctx.has(fid), `seed ${seed}: ${fid} reached ${session} twice via recall`).toBe(false);
        known[session]!.add(fid);
        recalls++;
      }
    }
    const id = `msg_${String(++seq).padStart(5, '0')}`;
    rows[session]!.push({
      info: { role: 'assistant', id },
      parts: [{ type: 'tool', tool: 'curated-thoughts_curated_recall_context', state: { status: 'completed', output: persisted } }],
    });
  };

  const compact = async () => {
    await hooks['experimental.session.compacting']({ sessionID: 'P' }, { context: [], prompt: undefined } as never);
    rows['P']!.push({
      info: { role: 'assistant', id: `msg_${String(++seq).padStart(5, '0')}` },
      parts: [{ type: 'text', text: 'summary of the conversation' }],
    });
  };

  return {
    userTurn,
    recall,
    compact,
    restart: () => {
      hooks = fresh();
    },
    rnd,
    get totals() {
      return { deliveries, recalls };
    },
  };
}

describe('exactly-once (randomized, multi-channel, 200 sessions)', () => {
  it('no fact id reaches a session twice across turns, recalls, compaction, restarts and children', async () => {
    let totalDeliveries = 0;
    let totalRecalls = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const sim = makeSim(seed);
      // Host invariant: a session's first message is a user message (no
      // assistant/tool row can precede it) — that turn renders the bootstrap.
      await sim.userTurn('P');
      for (let step = 1; step < 40; step++) {
        const r = sim.rnd();
        if (r < 0.45) await sim.userTurn('P');
        else if (r < 0.62) await sim.recall('P');
        else if (r < 0.74) await sim.recall(sim.rnd() < 0.5 ? 'C1' : 'C2');
        else if (r < 0.84) await sim.userTurn(sim.rnd() < 0.5 ? 'C1' : 'C2');
        else if (r < 0.92) await sim.compact();
        else sim.restart();
      }
      totalDeliveries += sim.totals.deliveries;
      totalRecalls += sim.totals.recalls;
    }
    // Non-vacuous: the property was exercised on both channels.
    expect(totalDeliveries).toBeGreaterThan(500);
    expect(totalRecalls).toBeGreaterThan(300);
  }, 120_000);
});

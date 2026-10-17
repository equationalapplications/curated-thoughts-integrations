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
 *   - N3 rewrites a REAL recall envelope ({result: "<CT JSON>"}); the
 *     production rewrite itself appends the ct-fact trailer for new ids
 *     (ct_tool_dedup parity) — no test-side marker patching.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { onToolResult, onUserTurn, Breaker, marker } from '@equational-applications/ct-wisdom-core';
import type {
  Ledger,
  SpawnFn,
  WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';
import { DshWisdomAdapter, type AdapterDeps } from '../src/wisdom-live/adapter.js';
import { DshActivity, activityMessage } from '../src/wisdom-live/activity.js';

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
    // Production path: the adapter's rewriteEnvelopeStub appends the
    // ct-fact trailer for every NEW id itself (ct_tool_dedup parity) —
    // the test appends nothing.
    const rewritten = onToolResult(this.adapter, { id: this.id }, envelope) as typeof envelope;
    this.log.push({
      role: 'tool',
      content: [textBlock(JSON.stringify(rewritten))],
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
      // replaced by the one-line stub, NOT delivered again). The envelope
      // JSON is the FIRST line only — the rewrite appends ct-fact trailer
      // lines after it (production path), and JSON.stringify never emits
      // literal newlines, so line 1 is exactly the parseable prefix.
      for (const text of texts) {
        const jsonPart = text.split('\n')[0] ?? '';
        try {
          const outer = JSON.parse(jsonPart) as { result?: string };
          const inner = JSON.parse((outer.result ?? '').split('\n')[0]) as {
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
 * HostAdapter.wisdomMatch directly — this is one layer lower). Parses the
 * shipped 3.3.0 argv: `--exclude=<id>` flags, query last after `--`.
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
                spec.args[spec.args.indexOf('--') + 1] ?? '',
                Number(spec.args[spec.args.indexOf('--max') + 1] ?? 0),
                spec.args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice('--exclude='.length)),
              ),
            ),
          }),
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Autonomous-work delivery mixed in (spec 2026-10-16-dsh-autonomous-work-
// wisdom-design.md): multi-step turns whose tool calls trigger activity
// deliveries at the next pre-step, CT recalls inside those steps, compaction
// between steps, and resume into a NEW process (adapter + DshActivity
// rebuilt; only the session log and the re-rendered bootstrap carry over).
// ─────────────────────────────────────────────────────────────────────────

type AnyMsg = { id?: string; role: string; source?: { kind: string }; content: Array<Record<string, unknown>> };

const TOOLS: Array<() => [string, Record<string, unknown>]> = [
  () => ['bash', { command: pickStatic(['pnpm test', 'pnpm test --silent', 'npm run build', 'git status', 'make']) }],
  () => ['read', { file_path: pickStatic(['src/a.ts', 'src/b.ts', '.env.local', 'README.md']) }],
  () => ['write', { file_path: pickStatic(['src/a.ts', '.env.local']), content: 'x' }],
  () => ['edit', { file_path: pickStatic(['src/a.ts', 'src/c.ts']), old_string: 'a', new_string: 'b' }],
  () => ['grep', { pattern: pickStatic(['TODO', 'MCP tool name', 'fleet']) }],
];
let staticRand: () => number = Math.random;
function pickStatic<T>(arr: T[]): T {
  return arr[Math.floor(staticRand() * arr.length)];
}

/** A real project root (hermes 0.6.5 P1), so file activities are sent too. */
const SIM_PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'ct-dsh-sim-proj-')));
mkdirSync(join(SIM_PROJ, '.git'));
afterAll(() => rmSync(SIM_PROJ, { recursive: true, force: true }));

class ActivitySim {
  log: AnyMsg[] = [];
  adapter!: DshWisdomAdapter;
  activity!: DshActivity;
  breaker!: Breaker;
  bootIds: string[] = [];
  private seq = 0;
  activityDeliveries = 0;
  userDeliveries = 0;

  constructor(readonly id: string, readonly fake: SpawnFn) {
    this.boot();
  }

  /** A fresh process: in-memory state gone, the log and the prompt replay. */
  boot(): void {
    this.adapter = new DshWisdomAdapter({ env: {}, discover: () => ({ path: '/bin/ct', failure: null }), spawnFn: this.fake });
    this.breaker = new Breaker();
    this.activity = new DshActivity({ adapter: this.adapter, breaker: this.breaker, cwd: () => SIM_PROJ, env: { USER: 'alice', HOME: '/Users/alice' } });
    if (this.bootIds.length > 0) {
      // The section re-renders the same bootstrap block into the memo.
      this.adapter.bootstrapMemo[this.id] = { block: 'boot', ids: [...this.bootIds] };
    }
  }

  agent() {
    return { id: this.id, session: { deriveMessages: () => [...this.log] } };
  }

  compact(rand: () => number): void {
    if (this.log.length > 0 && rand() < 0.15) this.log.splice(0, 1 + Math.floor(rand() * this.log.length));
  }

  async userTurn(question: string): Promise<void> {
    // index.ts: snapshot the log BEFORE the engine runs.
    this.adapter.sessionMessages.set(this.id, [...this.log]);
    const out = await onUserTurn(this.adapter, { id: this.id }, question, this.breaker);
    this.log.push({ id: `u${++this.seq}`, role: 'user', source: { kind: 'user' }, content: [textBlock(question)] });
    if (out !== null) {
      this.userDeliveries++;
      this.log.push({ id: `w${++this.seq}`, role: 'user', source: { kind: 'curated-thoughts-wisdom' }, content: [textBlock(out)] });
    }
  }

  /** One model step with tool calls (CT recalls among them), then their results. */
  step(rand: () => number): void {
    staticRand = rand;
    const n = 1 + Math.floor(rand() * 3);
    const blocks: Array<{ type: string; id: string; name: string; arguments: string }> = [];
    for (let i = 0; i < n; i++) {
      const [name, args] = rand() < 0.2
        ? ['curated-thoughts__curated_recall_context', { query: 'q' }]
        : pick(rand, TOOLS)();
      blocks.push({ type: 'tool-call', id: `c${++this.seq}`, name, arguments: JSON.stringify(args) });
    }
    this.log.push({ id: `a${++this.seq}`, role: 'assistant', source: { kind: 'model' }, content: blocks });
    const agent = this.agent();
    for (const b of blocks) {
      this.activity.prefetch({ callId: b.id, name: b.name, arguments: JSON.parse(b.arguments), agent });
    }
    for (const b of blocks) {
      let body = 'ok';
      if (b.name.startsWith('curated-thoughts__')) {
        const ids = sample(rand, UNIVERSE, Math.floor(rand() * 4));
        const envelope = { result: JSON.stringify({ wiki_entries: ids.map((id) => ({ id, title: 'T' + id, text: 'full ' + id })) }) };
        body = JSON.stringify(onToolResult(this.adapter, { id: this.id }, envelope));
      }
      this.log.push({ id: `t${++this.seq}`, role: 'tool', source: { kind: 'tool' }, content: [textBlock(body)] });
    }
  }

  /** The next pre-step (step >= 2). */
  async preStep(): Promise<void> {
    const block = await this.activity.deliver(this.agent(), [], []);
    if (block !== null) {
      this.activityDeliveries++;
      this.log.push({ ...activityMessage(block) } as unknown as AnyMsg);
    }
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every fact id visible in the simulated context (prompt bootstrap + log). */
function activityPresent(sim: ActivitySim): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of sim.bootIds) bump(id);
  for (const msg of sim.log) {
    const texts = msg.content.filter((b) => b.type === 'text').map((b) => String(b.text));
    for (const t of texts) {
      if (msg.role === 'user') {
        for (const id of UNIVERSE) {
          // user-turn block: `**T<id>** <!-- ct-fact:<id> -->` (or a correction's `**Correction: ...** marker`);
          // activity block: `<!-- ct-fact:<id> --> **T<id>**` (marker first).
          const m = esc(marker(id));
          const live = new RegExp(`\\*\\* ${m}`, 'g');
          const act = new RegExp(`${m} \\*\\*`, 'g');
          const hits = (t.match(live)?.length ?? 0) + (t.match(act)?.length ?? 0);
          for (let k = 0; k < hits; k++) bump(id);
        }
      } else if (msg.role === 'tool') {
        try {
          const outer = JSON.parse(t.split('\n')[0]) as { result?: string };
          const inner = JSON.parse((outer.result ?? '').split('\n')[0]) as { wiki_entries?: Array<Record<string, unknown>> };
          for (const e of inner.wiki_entries ?? []) {
            if (typeof e.id === 'string' && e.in_context !== true) bump(e.id);
          }
        } catch {
          /* plain tool output carries no facts */
        }
      }
    }
  }
  return counts;
}

describe('exactly-once with autonomous-work deliveries (DSH)', () => {
  it('no fact twice across 200 randomized sessions mixing user turns, activity, recalls, compaction and resume', async () => {
    let totalActivity = 0;
    let totalUser = 0;
    let resumes = 0;
    for (let s = 0; s < SESSIONS; s++) {
      const rand = rng(0xa11ce + s);
      const r2 = rng(0x5eed + s);
      const fake: SpawnFn = fakeCtFor((_q, max, exclude) => {
        const pool = r2() < 0.5 ? UNIVERSE : UNIVERSE.filter((f) => !exclude.includes(f));
        const entries = sample(r2, pool, Math.min(pool.length, max)).map((f) => fact(f));
        const corrections: WisdomMatchResult['corrections'] = [];
        if (exclude.length > 0 && r2() < 0.3) corrections.push(fact(pick(r2, UNIVERSE), [pick(r2, exclude)]));
        return { entries, corrections };
      });
      const sim = new ActivitySim(`act-${s}`, fake);
      sim.bootIds = sample(rand, UNIVERSE, Math.floor(rand() * 3));
      sim.boot();
      const check = (where: string) => {
        for (const [id, n] of activityPresent(sim)) expect(n, `${sim.id} ${where}: ${id} x${n}`).toBe(1);
      };
      const turns = 1 + Math.floor(rand() * 6);
      for (let turn = 0; turn < turns; turn++) {
        if (turn > 0 && rand() < 0.3) {
          sim.boot(); // resume with --session-id in a new process
          resumes++;
        }
        sim.compact(rand);
        await sim.userTurn(`question ${turn}`);
        check(`turn ${turn} user`);
        const steps = 1 + Math.floor(rand() * 4);
        for (let st = 0; st < steps; st++) {
          sim.step(rand);
          check(`turn ${turn} step ${st} tools`);
          if (rand() < 0.1) sim.compact(rand);
          await sim.preStep();
          check(`turn ${turn} step ${st + 1} pre-step`);
        }
      }
      totalActivity += sim.activityDeliveries;
      totalUser += sim.userDeliveries;
    }
    // The property is not vacuous: both channels delivered, and sessions resumed.
    expect(totalActivity).toBeGreaterThan(50);
    expect(totalUser).toBeGreaterThan(50);
    expect(resumes).toBeGreaterThan(20);
  });
});

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

  it('no session cap: past 12 live ids a turn still asks --max 2, delivers fresh facts and dedups', async () => {
    // 2026-10-16: the per-session cap (12) was removed; only the per-turn
    // limits bound a delivery, and the ledger dedup bounds the total.
    const maxes: number[] = [];
    const fake: SpawnFn = fakeCtFor((_q, max, exclude) => {
      maxes.push(max);
      const pool = UNIVERSE.filter((f) => !exclude.includes(f));
      return { entries: pool.slice(0, max).map((f) => fact(f)), corrections: [] };
    });
    const sim = new DshSim('probe', 1, fake);
    // 12 distinct ids already delivered on user messages (the old cap), in
    // MAX_PER_TURN chunks with distinct ids per chunk.
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
    expect(ledger.idsMostRecentFirst).toHaveLength(12);

    for (const [turn, expected] of [
      [0, UNIVERSE.slice(12, 14)],
      [1, UNIVERSE.slice(14, 16)],
    ] as const) {
      const question = `next question ${turn}`;
      const out = await onUserTurn(sim.adapter, { id: sim.id }, question, sim.breaker);
      expect(out, `turn ${turn}`).not.toBeNull();
      for (const id of expected) expect(out).toContain(`**T${id}**`);
      for (const id of UNIVERSE.slice(0, 12 + turn * 2)) {
        expect(out!.match(new RegExp(`\\*\\*T${id}\\*\\*`))).toBeNull();
      }
      sim.log.push({ role: 'user', content: [textBlock(question), textBlock(out!)] });
      sim.syncLog();
      assertNoDupes(sim, `post-12 probe turn ${turn}`);
    }
    expect(maxes.filter((m) => m !== 2)).toEqual([]);
    expect(maxes).toHaveLength(2);
  });
});

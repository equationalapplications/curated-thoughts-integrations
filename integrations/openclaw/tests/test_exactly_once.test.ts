/**
 * Randomized multi-channel exactly-once property test (parent spec decision 6,
 * AC 2; Hermes test_exactly_once.py is the pattern), adapted to OpenClaw's
 * three channels:
 *
 *   1. in-turn prependContext  — folded into the user message's persisted
 *      model-prompt projection (spec F8);
 *   2. durable salvage         — enqueueNextTurnInjection when the handler's
 *      result is no longer accepted; the host drains it into the NEXT turn's
 *      prependContext and reports it to agent_turn_prepare (F10, F11);
 *   3. tool-result middleware  — CT recall results stubbed / marker-trailed.
 *
 * plus prompt rebuilds of one admission (AC 11), compaction (oldest messages
 * leave the model-visible window) and gateway restarts (fresh plugin
 * instance, same transcript, same pending queue — host-owned).
 *
 * Oracle: within the model-visible window (bootstrap system block + visible
 * transcript) no fact id is ever delivered twice.
 */

import { describe, it, expect } from 'vitest';
import { MAX_PER_TURN } from '@equational-applications/ct-wisdom-core';
import { createPlugin } from '../src/index.js';
import { FakeApi, FakeCt, type Fact, userCtx } from './fake_host.js';

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

const POOL: Fact[] = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, title: `Fact ${i}`, text: `body ${i}` }));
const BOOT: Fact[] = [{ id: 'f0', title: 'Boot 0', text: 'b0' }, { id: 'f1', title: 'Boot 1', text: 'b1' }];
const MARKER_RE = /<!-- ct-fact:([A-Za-z0-9._:-]+) -->/g;
const RECALL_TOOL = 'curated-thoughts__curated_recall_context';

type Msg = Record<string, unknown>;

interface Pending { text: string; idempotencyKey?: string; metadata?: unknown }

function deliveries(transcript: Msg[], bootIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  bootIds.forEach(bump);
  for (const m of transcript) {
    if (m.role === 'user') {
      const proj = ((m.__openclaw as { modelPromptProjection?: { text?: string } } | undefined)?.modelPromptProjection?.text) ?? '';
      for (const match of proj.matchAll(MARKER_RE)) bump(match[1]);
    } else if (m.role === 'toolResult') {
      const text = ((m.content as Array<{ text: string }>)[0]?.text ?? '').split('\n')[0];
      const inner = JSON.parse(text) as { wiki_entries: Array<{ id: string; in_context?: boolean }> };
      for (const e of inner.wiki_entries) if (!e.in_context) bump(e.id);
    }
  }
  return counts;
}

interface Stats { live: number; salvaged: number; drained: number; stubs: number; compactions: number; restarts: number }

async function runSession(seed: number, turns: number, stats: Stats): Promise<{ violations: string[]; maxLive: number }> {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const ct = new FakeCt();
  ct.bootstrap = BOOT;
  ct.pool = () => [...POOL].sort(() => rnd() - 0.5);

  let api = new FakeApi();
  const boot = () => {
    api = new FakeApi();
    createPlugin({ spawnFn: ct.spawnFn, env: {}, candidates: () => ['/fake/ct'], usable: () => true }).register(api as never);
  };
  boot();

  let transcript: Msg[] = [];
  let pending: Pending[] = [];
  let enqueuedSeen = 0;
  const violations: string[] = [];
  let maxLive = 0;
  const ctxBase = userCtx({ sessionKey: `agent:main:s${seed}`, sessionId: `sid-${seed}` });

  for (let t = 0; t < turns; t++) {
    if (rnd() < 0.1) {
      boot(); // gateway restart: plugin state gone, host state kept
      enqueuedSeen = 0;
      stats.restarts++;
    }

    // (1) host drains queued injections before prompt hooks
    const queued = pending;
    if (queued.length) stats.drained += queued.length;
    pending = [];
    const runId = `r${t}`;
    const ctx = { ...ctxBase, runId };
    await api.hook('agent_turn_prepare')({
      prompt: 'p',
      messages: structuredClone(transcript),
      queuedInjections: queued.map((q, i) => ({ id: `q${t}-${i}`, pluginId: 'curated-thoughts', text: q.text, metadata: q.metadata, createdAt: t, placement: 'prepend_context' })),
    }, ctx);

    // (2) prompt build; sometimes the handler's lifetime has already ended
    const lateResult = rnd() < 0.2;
    const hookCtx = lateResult
      ? { ...ctx, hookInvocation: { assertActive: () => { throw new Error('prompt hook invocation is no longer active'); } } }
      : { ...ctx, hookInvocation: { assertActive: () => {} } };
    const userText = `question ${t} ${pick(['deploy', 'tests', 'lockfile', 'release'])}`;
    const event = { prompt: userText, currentUserMessage: userText, currentUserMessageId: `adm-${t}`, messages: structuredClone(transcript) };
    const result = (await api.hook('before_prompt_build')(event, hookCtx)) as { prependContext?: string; prependSystemContext?: string } | undefined;

    // (2b) rebuild/retry of the same admission returns the same bytes
    if (rnd() < 0.3) {
      const again = await api.hook('before_prompt_build')(event, { ...hookCtx, runId: `${runId}-retry` });
      if (JSON.stringify(again) !== JSON.stringify(result)) violations.push(`turn ${t}: retry changed the result`);
    }

    // newly salvaged injections join the host-owned queue (idempotencyKey dedupe)
    for (const inj of api.enqueued.slice(enqueuedSeen)) {
      const key = inj.idempotencyKey as string | undefined;
      if (!key || !pending.some((p) => p.idempotencyKey === key)) {
        pending.push({ text: String(inj.text), idempotencyKey: key, metadata: inj.metadata });
      }
    }
    stats.salvaged += api.enqueued.length - enqueuedSeen;
    enqueuedSeen = api.enqueued.length;
    if (result?.prependContext) stats.live++;
    // Per-turn limit still holds: one in-turn block carries at most
    // MAX_PER_TURN facts (FakeCt emits no corrections).
    const inTurn = [...(result?.prependContext ?? '').matchAll(MARKER_RE)].length;
    if (inTurn > MAX_PER_TURN) violations.push(`seed ${seed} turn ${t}: ${inTurn} facts in one block`);

    // (3) the projection the model sees for this user turn
    const prepend = [...queued.map((q) => q.text), result?.prependContext].filter(Boolean).join('\n\n');
    const projection = prepend ? `${prepend}\n\n${userText}` : userText;
    transcript.push({ role: 'user', content: userText, __openclaw: { modelPromptProjection: { version: 1, text: projection } } });

    // (4) the agent sometimes calls CT recall through the middleware
    if (rnd() < 0.5) {
      const ids = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(POOL).id);
      const raw = { content: [{ type: 'text', text: JSON.stringify({ wiki_entries: [...new Set(ids)].map((id) => ({ id, title: id, text: `t-${id}` })) }) }], details: {} };
      const out = (await api.middleware[0].handler(
        { toolCallId: `tc${t}`, toolName: RECALL_TOOL, args: {}, result: raw },
        { runtime: 'openclaw', sessionKey: ctx.sessionKey, runId },
      )) as { result: typeof raw } | undefined;
      if (out && out.result.content[0].text.includes('"in_context":true')) stats.stubs++;
      transcript.push({ role: 'toolResult', content: (out?.result ?? raw).content });
    }
    transcript.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${t}` }] });

    // (5) compaction: the oldest messages leave the model-visible window
    if (rnd() < 0.15 && transcript.length > 6) {
      transcript = transcript.slice(Math.floor(transcript.length / 2));
      stats.compactions++;
    }

    const bootIds = (result?.prependSystemContext ?? '').match(MARKER_RE) ? BOOT.map((b) => b.id) : [];
    for (const [id, n] of deliveries(transcript, bootIds)) {
      if (n > 1) violations.push(`seed ${seed} turn ${t}: ${id} delivered ${n}x in the visible window`);
    }
    const live = new Set<string>();
    for (const m of transcript) {
      if (m.role !== 'user') continue;
      const proj = (m.__openclaw as { modelPromptProjection: { text: string } }).modelPromptProjection.text;
      for (const match of proj.matchAll(MARKER_RE)) live.add(match[1]);
    }
    maxLive = Math.max(maxLive, live.size);
  }
  // No session cap (removed 2026-10-16): every match call asks for a full turn.
  for (const call of ct.matchCalls()) {
    const max = call.args[call.args.indexOf('--max') + 1];
    if (max !== String(MAX_PER_TURN)) violations.push(`seed ${seed}: match call with --max ${max}`);
  }
  return { violations, maxLive };
}

describe('exactly-once across prependContext, salvage injections and the middleware', () => {
  it('holds over 150 randomized sessions with retries, compaction and restarts', async () => {
    const all: string[] = [];
    let maxLive = 0;
    const stats: Stats = { live: 0, salvaged: 0, drained: 0, stubs: 0, compactions: 0, restarts: 0 };
    for (let seed = 1; seed <= 150; seed++) {
      const r = await runSession(seed, 14, stats);
      all.push(...r.violations);
      maxLive = Math.max(maxLive, r.maxLive);
    }
    expect(all).toEqual([]);
    // No session cap: some session's visible live count passes the old
    // bound (12 + 2 turns' worth), while violations above stay empty.
    expect(maxLive).toBeGreaterThan(12 + 2 * MAX_PER_TURN);
    // every channel and path was actually exercised
    expect(stats.live).toBeGreaterThan(100);
    expect(stats.salvaged).toBeGreaterThan(20);
    expect(stats.drained).toBeGreaterThan(20);
    expect(stats.stubs).toBeGreaterThan(20);
    expect(stats.compactions).toBeGreaterThan(20);
    expect(stats.restarts).toBeGreaterThan(20);
    if (process.env.CT_EO_STATS) console.log(JSON.stringify({ ...stats, maxLive }));
  }, 120_000);
});

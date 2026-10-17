/**
 * test_wisdom_live_adapter.ts — unit suite for the DSH HostAdapter binding
 * (spec: 2026-10-09 cross-harness parity, DSH leg). All spawns are injected;
 * no real `ct` is executed here (real-executable fixtures live in
 * test_wisdom_fixtures.ts).
 */

import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';

import {
  DshWisdomAdapter,
  userMessageText,
  isRecallToolName,
  type AdapterDeps,
} from '../src/wisdom-live/adapter.js';
import { DshActivity } from '../src/wisdom-live/activity.js';
import { Breaker } from '@equational-applications/ct-wisdom-core';
import type {
  Ledger,
  SpawnFn,
  SpawnOutcome,
} from '@equational-applications/ct-wisdom-core';

function spawnOutcome(o: Partial<SpawnOutcome>): SpawnOutcome {
  return {
    code: o.code ?? 0,
    stdout: o.stdout ?? '',
    stderr: o.stderr ?? '',
    spawnError: o.spawnError ?? false,
    timedOut: o.timedOut ?? false,
  };
}

function adapter(over: Partial<AdapterDeps> & { spawnFn?: SpawnFn } = {}) {
  const spawns: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  const defaultSpawn: SpawnFn = (spec) => {
    spawns.push(spec);
    // Default: a healthy ct — --help exits 0, wisdom match returns nothing.
    return Promise.resolve(
      spec.args[0] === '--help'
        ? spawnOutcome({})
        : spawnOutcome({ stdout: '{"entries": [], "corrections": []}' }),
    );
  };
  const a = new DshWisdomAdapter({
    env: {},
    discover: () => ({ path: '/bin/ct', failure: null }),
    ...over,
    spawnFn: over.spawnFn ?? defaultSpawn,
  });
  return { a, spawns };
}

const LEDGER_SHAPE = (ids: string[]): Ledger => {
  const set = new Set(ids);
  return { idsMostRecentFirst: ids, has: (id) => set.has(id), knownBootstrap: false };
};

describe('userMessageText', () => {
  it('joins text blocks; ignores non-text blocks and garbage', () => {
    expect(
      userMessageText({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', url: 'x' },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toBe('hello\nworld');
    expect(userMessageText(null)).toBe('');
    expect(userMessageText({ content: 'plain string is not blocks' })).toBe('');
    expect(userMessageText(42)).toBe('');
  });
});

describe('adapter abort plumbing', { timeout: 30_000 }, () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  };

  /** A fake ct whose `--help` exits 0 and whose match forks a grandchild and hangs. */
  async function hangingCt() {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-abort-'));
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'ct');
    writeFileSync(
      script,
      '#!/bin/sh\n'
        + 'case "$*" in *--help*) exit 0;; esac\n'
        + `sleep 30 &\necho $! > '${pidFile}'\nwait\n`,
    );
    chmodSync(script, 0o755);
    const grandchild = async (): Promise<number> => {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 5000);
      return Number(readFileSync(pidFile, 'utf8').trim());
    };
    return { script, grandchild, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('a plan cancel("abandoned") kills a real hanging ct child and its grandchild (activity level; no breaker failure)', async () => {
    if (process.platform === 'win32') return;
    const ct = await hangingCt();
    try {
      const a = new DshWisdomAdapter({ env: { ...process.env }, discover: () => ({ path: ct.script, failure: null }) });
      const breaker = new Breaker();
      let failures = 0;
      const recordFailure = breaker.recordFailure.bind(breaker);
      breaker.recordFailure = () => { failures++; recordFailure(); };
      const activity = new DshActivity({ adapter: a, breaker, env: { USER: 'alice', HOME: '/Users/alice' } });
      const mk = (n: number) => {
        const callId = `call-${n}`;
        const log = [
          { id: `u${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] },
          {
            id: `a${n}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
            content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: JSON.stringify({ command: `pnpm test${n}` }) }],
          },
        ];
        return { callId, agent: { id: 'agent-1', session: { deriveMessages: () => [...log], header: { cwd: tmpdir() } } } };
      };
      const one = mk(1);
      activity.prefetch({ callId: one.callId, name: 'bash', arguments: { command: 'pnpm test1' }, agent: one.agent });
      const gpid = await ct.grandchild();
      expect(alive(gpid)).toBe(true);
      const firstPlan = (activity as unknown as { slots: Map<string, { plan: { promise: Promise<unknown> } | null }> }).slots.get('agent-1')!.plan!;
      // A newer step replaces the slot: the first plan is abandoned.
      const two = mk(2);
      activity.prefetch({ callId: two.callId, name: 'bash', arguments: { command: 'pnpm test2' }, agent: two.agent });
      expect(await waitFor(() => !alive(gpid), 3000)).toBe(true);
      await firstPlan.promise; // the abandoned match settles
      expect(failures).toBe(0); // abandoned is never a breaker failure
    } finally {
      ct.cleanup();
    }
  });

  it('DshWisdomAdapter.wisdomMatch passes the signal: abort → outcome aborted, capability not latched', async () => {
    if (process.platform === 'win32') return;
    const ct = await hangingCt();
    try {
      const a = new DshWisdomAdapter({ env: { ...process.env }, discover: () => ({ path: ct.script, failure: null }) });
      const abort = new AbortController();
      const pending = a.wisdomMatch('pnpm test', 1, [], abort.signal);
      const gpid = await ct.grandchild();
      abort.abort();
      expect((await pending).outcome).toBe('aborted');
      expect(a.wisdomMatchAbsent()).toBe(false);
      expect(await waitFor(() => !alive(gpid), 3000)).toBe(true);
    } finally {
      ct.cleanup();
    }
  });
});

describe('ledger rebuild (m5: session-log source of truth)', () => {
  it('scans user + tool roles from the derived log, newest first', () => {
    const { a } = adapter();
    a.sessionMessages.set('s1', [
      { role: 'user', content: [{ type: 'text', text: 'q1 <!-- ct-fact:aa -->' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ignored <!-- ct-fact:zz -->' }] },
      { role: 'tool', content: [{ type: 'text', text: 'trailer <!-- ct-fact:bb -->' }] },
      { role: 'user', content: [{ type: 'text', text: 'later <!-- ct-fact:aa --> <!-- ct-fact:cc -->' }] },
    ]);
    const ledger = a.rebuildLedger({ id: 's1' });
    expect(ledger.idsMostRecentFirst).toEqual(['aa', 'cc', 'bb']);
    expect(ledger.has('aa')).toBe(true);
    expect(ledger.has('zz')).toBe(false);
    // knownBootstrap: log markers alone prove a bootstrap existed
    expect(ledger.knownBootstrap).toBe(true);
  });

  it('unions the memo bootstrap ids after the session-log scan', () => {
    const { a } = adapter();
    a.bootstrapMemo['s2'] = { block: '**B** <!-- ct-fact:boot1 -->', ids: ['boot1'] };
    a.sessionMessages.set('s2', [
      { role: 'user', content: [{ type: 'text', text: '<!-- ct-fact:live1 --> <!-- ct-fact:live2 -->' }] },
      { role: 'tool', content: [{ type: 'text', text: '<!-- ct-fact:toolonly -->' }] },
    ]);
    const ledger = a.rebuildLedger({ id: 's2' });
    // newest MESSAGE first: the tool trailer is the newest message, then the
    // user message; memo bootstrap ids append after the log scan.
    expect(ledger.idsMostRecentFirst).toEqual(['toolonly', 'live1', 'live2', 'boot1']);
    expect(ledger.knownBootstrap).toBe(true);
  });

  it('scans each frozen message once; new or unfrozen messages are always scanned (review of PR #56)', () => {
    const { a } = adapter();
    let reads = 0;
    const frozen = (role: string, text: string) => {
      const msg = { role, get content() { reads++; return [{ type: 'text', text }]; } };
      return Object.freeze(msg);
    };
    const log: unknown[] = [frozen('user', '<!-- ct-fact:a1 -->'), frozen('tool', '<!-- ct-fact:t1 -->')];
    a.snapshotMessages('s3', [...log]);
    expect(a.rebuildLedger({ id: 's3' }).idsMostRecentFirst).toEqual(['t1', 'a1']);
    expect(reads).toBe(2);
    expect(a.rebuildLedger({ id: 's3' }).idsMostRecentFirst).toEqual(['t1', 'a1']);
    expect(reads).toBe(2); // memoized by frozen message identity
    log.push(frozen('tool', '<!-- ct-fact:t2 -->'));
    a.snapshotMessages('s3', [...log]); // a tool result arrived after the plan
    expect(a.rebuildLedger({ id: 's3' }).idsMostRecentFirst).toEqual(['t2', 't1', 'a1']);
    expect(reads).toBe(3); // only the new message was scanned
    log.splice(0, 1); // compaction drops the oldest message
    a.snapshotMessages('s3', [...log]);
    expect(a.rebuildLedger({ id: 's3' }).idsMostRecentFirst).toEqual(['t2', 't1']);
    // an unfrozen (mutable) message is never memoized
    const mutable = { role: 'user', content: [{ type: 'text', text: '<!-- ct-fact:m1 -->' }] };
    a.snapshotMessages('s4', [mutable]);
    expect(a.rebuildLedger({ id: 's4' }).idsMostRecentFirst).toEqual(['m1']);
    mutable.content = [{ type: 'text', text: '<!-- ct-fact:m2 -->' }];
    expect(a.rebuildLedger({ id: 's4' }).idsMostRecentFirst).toEqual(['m2']);
  });

  it('an unseen session yields the empty ledger (fail-closed)', () => {
    const { a } = adapter();
    const ledger = a.rebuildLedger({ id: 'never-seen' });
    expect(ledger.idsMostRecentFirst).toEqual([]);
    expect(ledger.knownBootstrap).toBe(false);
    expect(a.restored({ id: 'never-seen' })).toBe(false);
    expect(a.deliveryEnabled({ id: 'never-seen' })).toBe(true);
  });

  it('caches before early return (m1) and serves it back (m2)', () => {
    const { a } = adapter();
    a.cacheLedger({ id: 's3' }, LEDGER_SHAPE(['x']));
    expect(a.cachedLedger({ id: 's3'})?.idsMostRecentFirst).toEqual(['x']);
    expect(a.cachedLedger({ id: 'other' })).toBeNull();
  });
});

describe('capability probe + wisdomMatch', () => {
  it('probes capability, then runs the core match argv with --exclude bound', async () => {
    const seen: string[][] = [];
    const spawns: SpawnFn = (spec) => {
      seen.push(spec.args);
      if (spec.args[2] === '--help') {
        // capability gate: `ct wisdom match --help` exits 0
        return Promise.resolve(spawnOutcome({}));
      }
      // the core's matchArgs contract (CT 3.3.0): --json, --exclude= ids,
      // query last after --
      expect(spec.args.slice(0, 5)).toEqual(['wisdom', 'match', '--json', '--max', '2']);
      expect(spec.args.slice(5)).toEqual(['--exclude=ex1', '--', 'q']);
      expect(spec.timeoutMs).toBe(3000);
      return Promise.resolve(
        spawnOutcome({ stdout: '{"entries": [{"id": "e1", "title": "T", "text": "B"}], "corrections": []}' }),
      );
    };
    const { a } = adapter({ spawnFn: spawns });
    const res = await a.wisdomMatch('q', 2, ['ex1']);
    expect(res.outcome).toBe('ok');
    expect(res.result?.entries.map((e) => e.id)).toEqual(['e1']);
    expect(seen[0]).toEqual(['wisdom', 'match', '--help']);
  });

  it('absent subcommand (exit 1) latches OFF for the process (n3 probe semantics)', async () => {
    const spawns: SpawnFn = (spec) =>
      Promise.resolve(spec.args[2] === '--help' ? spawnOutcome({ code: 1 }) : spawnOutcome({}));
    const { a } = adapter({ spawnFn: spawns });
    expect((await a.wisdomMatch('q', 2, [])).outcome).toBe('timeout_or_exit');
    expect(a.wisdomMatchAbsent()).toBe(true);
    // Latched: no further spawns at all.
    expect((await a.wisdomMatch('q2', 2, [])).outcome).toBe('timeout_or_exit');
  });

  it('spawn failure returns spawn class (engine resets caches), not a latch', async () => {
    const spawns: SpawnFn = () => Promise.resolve(spawnOutcome({ spawnError: true }));
    const { a } = adapter({ spawnFn: spawns });
    expect((await a.wisdomMatch('q', 2, [])).outcome).toBe('spawn');
    expect(a.wisdomMatchAbsent()).toBe(false);
    a.resetDiscoveryAndProbeCaches();
    expect(a.wisdomMatchAbsent()).toBe(false);
  });

  it('discovery miss → spawn class (n3 retry next turn)', async () => {
    const { a } = adapter({ discover: () => ({ path: null, failure: null }) });
    expect((await a.wisdomMatch('q', 2, [])).outcome).toBe('spawn');
  });

  it('probes the capability once per resolved ct path, not on every call (PR #71 review)', async () => {
    const { a, spawns } = adapter();
    await a.wisdomMatch('q1', 1, []);
    await a.wisdomMatch('q2', 1, []);
    await a.wisdomMatch('q3', 1, []);
    expect(spawns.filter((s) => s.args[2] === '--help')).toHaveLength(1);
    expect(spawns.filter((s) => s.args[2] === '--json')).toHaveLength(3);
  });

  it('re-probes after a discovery reset and when the resolved path changes', async () => {
    let path = '/bin/ct';
    const { a, spawns } = adapter({ discover: () => ({ path, failure: null }) });
    const helps = () => spawns.filter((s) => s.args[2] === '--help').map((s) => s.command);
    await a.wisdomMatch('q', 1, []);
    a.resetDiscoveryAndProbeCaches();
    await a.wisdomMatch('q', 1, []);
    path = '/opt/ct';
    await a.wisdomMatch('q', 1, []);
    await a.wisdomMatch('q', 1, []);
    expect(helps()).toEqual(['/bin/ct', '/bin/ct', '/opt/ct']);
    a._resetForTests();
    await a.wisdomMatch('q', 1, []);
    expect(helps()).toHaveLength(4);
  });

  it('a spawn-class reset also invalidates discovery, so a moved ct is found again (PR #71 re-review)', async () => {
    let invalidations = 0;
    const { a, spawns } = adapter({ invalidateDiscovery: () => { invalidations++; } });
    await a.wisdomMatch('q', 1, []);
    a.resetDiscoveryAndProbeCaches();
    expect(invalidations).toBe(1);
    await a.wisdomMatch('q', 1, []);
    expect(spawns.filter((x) => x.args[2] === '--help')).toHaveLength(2);
  });

  it('a match that exits non-zero drops the probe cache: an in-place downgrade latches on the next call (PR #71 re-review)', async () => {
    let downgraded = false;
    const seen: string[][] = [];
    const spawnFn: SpawnFn = (spec) => {
      seen.push(spec.args);
      if (spec.args[2] === '--help') return Promise.resolve(spawnOutcome({ code: downgraded ? 2 : 0 }));
      if (downgraded) return Promise.resolve(spawnOutcome({ code: 2, stderr: "invalid choice: 'match'" }));
      return Promise.resolve(spawnOutcome({ stdout: '{"entries": [], "corrections": []}' }));
    };
    const { a } = adapter({ spawnFn });
    expect((await a.wisdomMatch('q', 1, [])).outcome).toBe('ok');
    downgraded = true;
    expect((await a.wisdomMatch('q', 1, [])).outcome).toBe('timeout_or_exit'); // one failure
    expect(a.wisdomMatchAbsent()).toBe(false);
    expect((await a.wisdomMatch('q', 1, [])).outcome).toBe('timeout_or_exit'); // re-probed: latched
    expect(a.wisdomMatchAbsent()).toBe(true);
    const n = seen.length;
    await a.wisdomMatch('q', 1, []);
    expect(seen.length).toBe(n); // latched: no spawn at all
  });

  it('slow probes are charged to the breaker and never re-walk discovery (PR #71 third review)', async () => {
    const { Breaker, BREAKER_FAILS, buildActivity, runActivityMatch } = await import('@equational-applications/ct-wisdom-core');
    let invalidations = 0;
    let probes = 0;
    const spawnFn: SpawnFn = (spec) => {
      if (spec.args[2] === '--help') probes++;
      return Promise.resolve(spawnOutcome({ code: null, timedOut: true }));
    };
    // Discovery's accepted path stays cached unless it is invalidated; an
    // invalidation makes the next call re-run the blocking spawnSync walk.
    const { a } = adapter({ spawnFn, invalidateDiscovery: () => { invalidations++; } });
    const breaker = new Breaker();
    const activity = buildActivity({ verb: 'run', command: 'pnpm test' }, null, {})!;
    for (let i = 0; i < 20; i++) {
      if (breaker.isOpen()) continue;
      await runActivityMatch(a, activity, [], breaker);
    }
    expect(probes).toBe(BREAKER_FAILS); // then the breaker pauses everything
    expect(invalidations).toBe(0); // no blocking discovery re-walk
    expect(breaker.isOpen()).toBe(true);
  });

  it('a probe that passed is cached even when the abort lands right after it (PR #71 third review)', async () => {
    const abort = new AbortController();
    let helps = 0;
    const spawnFn: SpawnFn = (spec) => {
      if (spec.args[2] === '--help') {
        helps++;
        abort.abort(); // lands after the probe answered
        return Promise.resolve(spawnOutcome({}));
      }
      return Promise.resolve(spawnOutcome({ stdout: '{"entries": [], "corrections": []}' }));
    };
    const { a } = adapter({ spawnFn });
    expect((await a.wisdomMatch('q', 1, [], abort.signal)).outcome).toBe('aborted');
    await a.wisdomMatch('q', 1, []);
    expect(helps).toBe(1);
  });

  it('a probe spawn error with an aborted signal is class spawn, not aborted', async () => {
    const spawnFn: SpawnFn = () => Promise.resolve({ ...spawnOutcome({ code: null, spawnError: true }), aborted: true });
    const { a } = adapter({ spawnFn });
    const abort = new AbortController();
    abort.abort();
    expect((await a.wisdomMatch('q', 1, [], abort.signal)).outcome).toBe('spawn');
  });
});

describe('recall envelope (N3, m4)', () => {
  const ENVELOPE = {
    result: JSON.stringify({
      wiki_entries: [
        { id: 'f1', title: 'A', text: 'long text' },
        { id: 'f2', title: 'B', text: 'other' },
      ],
    }),
    structuredContent: { passthrough: true },
  };

  it('fires only on the curated_recall_context surface, never get_wiki_entry', () => {
    expect(isRecallToolName('mcp__ct__curated_recall_context')).toBe(true);
    expect(isRecallToolName('ct__curated_recall_context')).toBe(true);
    expect(isRecallToolName('mcp__ct__curated_get_wiki_entry')).toBe(false);
    expect(isRecallToolName(undefined)).toBe(false);
  });

  it('parses ids from the wiki_entries envelope; malformed → empty', () => {
    const { a } = adapter();
    expect(a.isCtRecallResult(ENVELOPE)).toBe(true);
    expect(a.envelopeFactIds(ENVELOPE)).toEqual(['f1', 'f2']);
    expect(a.isCtRecallResult({ nope: 1 })).toBe(false);
    expect(a.isCtRecallResult(null)).toBe(false);
    expect(a.isCtRecallResult({ result: 'not json' })).toBe(false);
    expect(a.isCtRecallResult({ result: '{"no_entries": []}' })).toBe(false);
    expect(a.envelopeFactIds({ result: 'not json' })).toEqual([]);
  });

  it('stubs repeats in place, preserves other outer keys, and leaves new ids alone', () => {
    const { a } = adapter();
    const rewritten = a.rewriteEnvelopeStub(ENVELOPE, ['f1'], []) as typeof ENVELOPE;
    expect(rewritten.structuredContent).toEqual({ passthrough: true });
    // No new ids → NO trailer: result stays pure JSON.
    const inner = JSON.parse(rewritten.result) as {
      wiki_entries: Array<Record<string, unknown>>;
    };
    expect(inner.wiki_entries[0]).toEqual({
      id: 'f1',
      in_context: true,
      note: 'already in context: ct-fact:f1',
    });
    expect(inner.wiki_entries[1]).toEqual({ id: 'f2', title: 'B', text: 'other' });
  });

  it('appends one ct-fact trailer line per NEW id, envelope JSON first', async () => {
    const { a } = adapter();
    const rewritten = a.rewriteEnvelopeStub(ENVELOPE, ['f1'], ['f2']) as typeof ENVELOPE;
    expect(rewritten.structuredContent).toEqual({ passthrough: true });
    // Mirror of ct_tool_dedup: result = json.dumps(inner) + trailer.
    expect(rewritten.result).toBe(
      JSON.stringify({
        wiki_entries: [
          {
            id: 'f1',
            in_context: true,
            note: 'already in context: ct-fact:f1',
          },
          { id: 'f2', title: 'B', text: 'other' },
        ],
      }) + '\n<!-- ct-fact:f2 -->',
    );
    // The trailer must be scannable by the ledger (next rebuild picks it up).
    // scanIds also picks the ct-fact token out of the stub NOTE — harmless,
    // f1 is a repeat — so expect both, in text order.
    const { scanIds } = await import('@equational-applications/ct-wisdom-core');
    expect(scanIds(rewritten.result)).toEqual(['f1', 'f2']);
  });

  it('trailers every new id in order when there are no repeats', () => {
    const { a } = adapter();
    const rewritten = a.rewriteEnvelopeStub(ENVELOPE, [], ['f1', 'f2']) as typeof ENVELOPE;
    expect(rewritten.result.endsWith('\n<!-- ct-fact:f1 -->\n<!-- ct-fact:f2 -->')).toBe(true);
  });

  it('keeps every other inner-envelope key, in order, byte-faithfully', () => {
    // CT's recall envelope carries more than wiki_entries (chunks, query
    // metadata, …). A stub/trailer rewrite must change ONLY the stubbed
    // entries and append the trailer — never drop or reorder sibling keys
    // (OpenCode leg parity: its envelope parse keeps the full object).
    const { a } = adapter();
    const innerIn = {
      schema: 2,
      query: 'tire pressure',
      chunks: [{ doc: 'n1', text: 'chunk text', score: 0.5 }],
      wiki_entries: [
        { id: 'f1', title: 'A', text: 'long text' },
        { id: 'f2', title: 'B', text: 'other' },
      ],
      provenance: { source: 'ct', tier: 'v2.5-full' },
      unknown_future_key: null,
    };
    const env = { result: JSON.stringify(innerIn) };
    const expectedInner = {
      ...innerIn,
      wiki_entries: [
        { id: 'f1', in_context: true, note: 'already in context: ct-fact:f1' },
        { id: 'f2', title: 'B', text: 'other' },
      ],
    };
    // Repeat-only rewrite: pure JSON, siblings intact, key order intact.
    const stubbed = a.rewriteEnvelopeStub(env, ['f1'], []) as { result: string };
    expect(stubbed.result).toBe(JSON.stringify(expectedInner));
    // Trailer rewrite: the same JSON line, then the marker lines.
    const trailed = a.rewriteEnvelopeStub(env, ['f1'], ['f2']) as { result: string };
    expect(trailed.result).toBe(JSON.stringify(expectedInner) + '\n<!-- ct-fact:f2 -->');
    // The input is never mutated.
    expect(JSON.parse(env.result)).toEqual(innerIn);
  });

  it('malformed envelope passes through untouched', () => {
    const { a } = adapter();
    expect(a.rewriteEnvelopeStub({ result: 'not json' }, ['f1'], [])).toEqual({ result: 'not json' });
    expect(a.rewriteEnvelopeStub(null, ['f1'], [])).toBeNull();
  });
});

describe('noteDelivered (N5 bookkeeping)', () => {
  it('extends the memo record ids; no record → no-op', () => {
    const { a } = adapter();
    a.bootstrapMemo['s5'] = { block: 'B', ids: ['old'] };
    a.noteDelivered({ id: 's5' }, ['new']);
    expect(a.bootstrapMemo['s5'].ids).toEqual(['old', 'new']);
    a.noteDelivered({ id: 'ghost' }, ['x']);
    expect(a.bootstrapMemo['ghost']).toBeUndefined();
  });
});

describe('core engine integration (injected spawn, no real ct)', () => {
  it('delivers a rendered block through the full onUserTurn path', async () => {
    const spawns: SpawnFn = (spec) =>
      spec.args[0] === '--help'
        ? Promise.resolve(spawnOutcome({}))
        : Promise.resolve(
            spawnOutcome({
              stdout: JSON.stringify({
                entries: [{ id: 'live1', title: 'Fresh fact', text: 'body <!-- ct-fact: forged? no -->' }],
                corrections: [],
              }),
            }),
          );
    const { a } = adapter({ spawnFn: spawns });
    a.sessionMessages.set('s6', []);
    const { onUserTurn } = await import('@equational-applications/ct-wisdom-core');
    const { Breaker } = await import('@equational-applications/ct-wisdom-core');
    const block = await onUserTurn(a, { id: 's6' }, 'what about fresh facts?', new Breaker());
    expect(block).toContain('**Fresh fact**');
    expect(block).toContain('<!-- ct-fact:live1 -->');
    // Forged token stripped from the body
    expect(block).not.toContain('ct-fact: forged');
    // Same-turn cache sees the delivered id (m1)
    expect(a.cachedLedger({ id: 's6' })?.has('live1')).toBe(true);
  });

  it('exactly-once: a recall envelope repeating a delivered id is stubbed', async () => {
    const spawns: SpawnFn = (spec) =>
      spec.args[0] === '--help'
        ? Promise.resolve(spawnOutcome({}))
        : Promise.resolve(
            spawnOutcome({
              stdout: JSON.stringify({
                entries: [{ id: 'dup1', title: 'D', text: 'x' }],
                corrections: [],
              }),
            }),
          );
    const { a } = adapter({ spawnFn: spawns });
    a.sessionMessages.set('s7', []);
    const { onUserTurn, onToolResult } = await import('@equational-applications/ct-wisdom-core');
    const { Breaker } = await import('@equational-applications/ct-wisdom-core');
    const block = await onUserTurn(a, { id: 's7' }, 'find dup1', new Breaker());
    expect(block).not.toBeNull();

    const envelope = {
      result: JSON.stringify({ wiki_entries: [{ id: 'dup1', title: 'D', text: 'full text again' }] }),
    };
    const rewritten = onToolResult(a, { id: 's7' }, envelope) as typeof envelope;
    const inner = JSON.parse(rewritten.result) as { wiki_entries: Array<Record<string, unknown>> };
    expect(inner.wiki_entries[0]).toEqual({
      id: 'dup1',
      in_context: true,
      note: 'already in context: ct-fact:dup1',
    });
  });

  it('exactly-once: a recall envelope with a NEW id gets the ct-fact trailer through onToolResult', async () => {
    // Recall of an id the ledger has never seen: the persisted tool result
    // must carry its marker (the next ledger rebuild picks it up) — the
    // production rewrite appends it, not the host.
    const { a } = adapter();
    a.sessionMessages.set('s8', []);
    const { onToolResult, scanIds } = await import('@equational-applications/ct-wisdom-core');
    const envelope = {
      result: JSON.stringify({
        wiki_entries: [{ id: 'brand_new', title: 'N', text: 'first appearance' }],
      }),
    };
    const rewritten = onToolResult(a, { id: 's8' }, envelope) as typeof envelope;
    // Envelope JSON first, one trailer line per new id after it.
    expect(rewritten.result).toBe(
      JSON.stringify({
        wiki_entries: [{ id: 'brand_new', title: 'N', text: 'first appearance' }],
      }) + '\n<!-- ct-fact:brand_new -->',
    );
    // And the next ledger scan sees it — the reason the trailer exists.
    expect(scanIds(rewritten.result)).toEqual(['brand_new']);
  });

  it('empty session id → silent no-op (invariant 3)', async () => {
    const { onUserTurn } = await import('@equational-applications/ct-wisdom-core');
    const { Breaker } = await import('@equational-applications/ct-wisdom-core');
    const { a } = adapter();
    expect(await onUserTurn(a, { id: '' }, 'hello', new Breaker())).toBeNull();
  });
});

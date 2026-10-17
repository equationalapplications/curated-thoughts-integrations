/**
 * test_wisdom_live_adapter.ts — unit suite for the DSH HostAdapter binding
 * (spec: 2026-10-09 cross-harness parity, DSH leg). All spawns are injected;
 * no real `ct` is executed here (real-executable fixtures live in
 * test_wisdom_fixtures.ts).
 */

import { describe, it, expect, vi } from 'vitest';

import {
  DshWisdomAdapter,
  nodeSpawnFn,
  userMessageText,
  isRecallToolName,
  type AdapterDeps,
} from '../src/wisdom-live/adapter.js';
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

describe('nodeSpawnFn (real binding, fake binary)', () => {
  it('passes the argument LIST to a shell-less spawn and captures stdout', async () => {
    // POSIX-only: needs /bin/sh for the shebang script.
    if (process.platform === 'win32') return;
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-fn-'));
    const script = join(dir, 'fake-ct');
    writeFileSync(script, '#!/bin/sh\nprintf \'{"ok": true}\'\n');
    chmodSync(script, 0o755);
    try {
      const out = await nodeSpawnFn()({
        command: script,
        args: ['wisdom', 'match', '--query', 'hello world; rm -rf /'],
        timeoutMs: 3000,
      });
      expect(out.spawnError).toBe(false);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe('{"ok": true}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out a hung binary inside the budget and reports timedOut', async () => {
    if (process.platform === 'win32') return;
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ct-spawn-fn-'));
    const script = join(dir, 'hung-ct');
    writeFileSync(script, '#!/bin/sh\nsleep 30\n');
    chmodSync(script, 0o755);
    try {
      const out = await nodeSpawnFn()({
        command: script,
        args: [],
        timeoutMs: 200,
      });
      expect(out.timedOut).toBe(true);
      expect(out.code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

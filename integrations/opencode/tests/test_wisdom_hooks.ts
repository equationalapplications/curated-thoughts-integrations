/**
 * test_wisdom_hooks.ts — the plugin's wisdom hooks driven end-to-end through
 * `CuratedThoughts(input)` with a fake host client and a REAL executable `ct`
 * stub on PATH (tests/fixtures/ct-stub.mjs). Leg spec LD4 (bootstrap), LD7
 * (parent-only), LD8 (self-trigger guard), LD5 (compaction), AC 4/5/11.
 * POSIX-only: the stub is a shebang script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';

vi.mock('../src/status.js', () => ({ probeLocal: vi.fn(async () => ({ readiness: 'ready', reasons: [] })) }));

const { CuratedThoughts } = await import('../src/index.js');
const { _resetWisdomStateForTests } = await import('../src/wisdom.js');
const { BOOT_MARKER, LIVE_MARKER } = await import('../src/wisdom-live/adapter.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== 'win32';

type Row = { info: { role: string; id: string }; parts: Array<Record<string, unknown>> };

interface Host {
  rows: Record<string, Row[]>;
  sessions: Record<string, { parentID?: string } | null>;
  hooks: Hooks;
  log: string;
  /** Simulates one user turn: chat.message, then the host persists the message. */
  turn(sessionID: string, ...texts: Array<string | Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
  stubCalls(): string[][];
}

let tmp: string;
let originalEnv: NodeJS.ProcessEnv;
let msgSeq = 0;

function fact(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Title ${id}`, text: `Body of ${id}`, ...extra };
}

async function makeHost(env: Record<string, string> = {}, extraClient: Record<string, unknown> = {}): Promise<Host> {
  const rows: Record<string, Row[]> = {};
  const sessions: Record<string, { parentID?: string } | null> = {};
  const log = join(tmp, `ct-log-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env = {
    ...process.env,
    CT_STUB_LOG: log,
    ...env,
  };
  const client = {
    session: {
      messages: async ({ path }: { path: { id: string } }) => ({ data: structuredClone(rows[path.id] ?? []) }),
      get: async ({ path }: { path: { id: string } }) =>
        path.id in sessions && sessions[path.id] === null
          ? { error: { name: 'NotFound' }, data: undefined }
          : { data: { id: path.id, ...(sessions[path.id] ?? {}) } },
    },
    ...extraClient,
  };
  const hooks = await CuratedThoughts({ directory: '/work', client } as unknown as PluginInput, undefined);
  const host: Host = {
    rows,
    sessions,
    hooks,
    log,
    async turn(sessionID, ...texts) {
      const id = `msg_${String(++msgSeq).padStart(6, '0')}`;
      const parts = texts.map((t) => (typeof t === 'string' ? { id: `prt_u${msgSeq}`, type: 'text', text: t } : t));
      const output = { message: { id, sessionID, role: 'user' }, parts };
      await (hooks['chat.message'] as NonNullable<Hooks['chat.message']>)(
        { sessionID, agent: 'build' } as Parameters<NonNullable<Hooks['chat.message']>>[0],
        output as unknown as Parameters<NonNullable<Hooks['chat.message']>>[1],
      );
      (rows[sessionID] ??= []).push({ info: { role: 'user', id }, parts: output.parts as Row['parts'] });
      return output.parts as Array<Record<string, unknown>>;
    },
    stubCalls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
    },
  };
  return host;
}

const ours = (parts: Array<Record<string, unknown>>, mark: string) =>
  parts.filter((p) => p.synthetic === true && typeof p.text === 'string' && (p.text as string).split('\n').includes(mark));
const matchCalls = (h: Host) => h.stubCalls().filter((a) => a[0] === 'wisdom' && a[1] === 'match' && !a.includes('--help'));
const recallCalls = (h: Host) => h.stubCalls().filter((a) => a[0] === 'recall');

beforeEach(() => {
  originalEnv = process.env;
  tmp = mkdtempSync(join(tmpdir(), 'ct-oc-hooks-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  copyFileSync(join(HERE, 'fixtures', 'ct-stub.mjs'), join(bin, 'ct'));
  chmodSync(join(bin, 'ct'), 0o755);
  const home = join(tmp, 'home');
  mkdirSync(home);
  process.env = {
    ...originalEnv,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}:${originalEnv.PATH ?? ''}`,
    CURATED_BRAIN_DIR: join(tmp, 'brain'),
  };
  for (const k of Object.keys(process.env)) if (k.startsWith('CT_STUB_')) delete process.env[k];
  _resetWisdomStateForTests();
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!posix)('chat.message — v1 bootstrap (LD4)', () => {
  it('first turn: bootstrap part then live part, both synthetic with host-format ids', async () => {
    const h = await makeHost({
      CT_STUB_RECALL: JSON.stringify([fact('b1'), fact('b2')]),
      CT_STUB_MATCH: JSON.stringify([fact('l1')]),
    });
    const parts = await h.turn('s1', 'what is the tire pressure?');
    const boot = ours(parts, BOOT_MARKER);
    const live = ours(parts, LIVE_MARKER);
    expect(boot.length).toBe(1);
    expect(live.length).toBe(1);
    expect(parts.indexOf(boot[0]!)).toBeLessThan(parts.indexOf(live[0]!));
    for (const p of [...boot, ...live]) {
      expect(p.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(p.sessionID).toBe('s1');
      expect(p.messageID).toBe(h.rows['s1']![0]!.info.id);
      expect(p.type).toBe('text');
    }
    expect(boot[0]!.text).toContain('<!-- ct-fact:b1 -->');
    expect(boot[0]!.text).toContain('<!-- ct-fact:b2 -->');
    expect(live[0]!.text).toContain('<!-- ct-fact:l1 -->');
    // Seed query + pinned argv (Hermes/DSH v1 parity).
    expect(recallCalls(h)).toEqual([['recall', 'curated thoughts agent memory wisdom procedures', '--json', '--k', '3']]);
  });

  it('a bootstrap fact offered by wisdom match on turn 1 is not live-delivered again', async () => {
    const h = await makeHost({
      CT_STUB_RECALL: JSON.stringify([fact('dup')]),
      CT_STUB_MATCH: JSON.stringify([fact('dup'), fact('new')]),
      CT_STUB_IGNORE_EXCLUDE: '1',
    });
    const parts = await h.turn('s1', 'question');
    const live = ours(parts, LIVE_MARKER)[0]!;
    expect(live.text).not.toContain('ct-fact:dup');
    expect(live.text).toContain('ct-fact:new');
    expect(matchCalls(h)[0]).toContain('--exclude=dup');
  });

  it('renders once per session: never again on later turns or in a later process', async () => {
    const env = { CT_STUB_RECALL: JSON.stringify([fact('b1')]) };
    const h = await makeHost(env);
    await h.turn('s1', 'one');
    await h.turn('s1', 'two');
    expect(recallCalls(h).length).toBe(1);
    // A new process (`opencode run --continue`) reuses the persisted history.
    _resetWisdomStateForTests();
    const h2 = await makeHost(env);
    h2.rows['s1'] = h.rows['s1']!;
    const parts = await h2.turn('s1', 'three');
    expect(ours(parts, BOOT_MARKER)).toEqual([]);
    expect(recallCalls(h2).length).toBe(0);
  });

  it('no session cap: a long session keeps receiving 2 facts per turn past 12', async () => {
    // 2026-10-16: the per-session cap (12) was removed; the per-turn limits
    // stay, and the ledger dedup bounds the session total.
    const h = await makeHost({
      CT_STUB_RECALL: JSON.stringify(Array.from({ length: 3 }, (_, i) => fact(`b${i}`))),
      CT_STUB_MATCH: JSON.stringify(Array.from({ length: 40 }, (_, i) => fact(`l${i}`))),
    });
    const live: string[] = [];
    for (let t = 0; t < 10; t++) {
      const parts = await h.turn('s1', `turn ${t}`);
      const ids = ours(parts, LIVE_MARKER).flatMap((p) =>
        [...(p.text as string).matchAll(/ct-fact:([A-Za-z0-9._:-]+)/g)].map((m) => m[1]!),
      );
      expect(ids, `turn ${t}`).toHaveLength(2); // MAX_PER_TURN, every turn
      live.push(...ids);
    }
    expect(live).toHaveLength(20);
    expect(new Set(live).size).toBe(20); // no fact twice
    expect(live.some((id) => id.startsWith('b'))).toBe(false);
    for (const call of matchCalls(h)) expect(call).toEqual(expect.arrayContaining(['--max', '2']));
  });

  // Only meaningful where no real ct sits on a discovery fallback path.
  const fallbackCt = ['/usr/local/bin/ct', '/opt/homebrew/bin/ct', '/usr/bin/ct'].some((p) => existsSync(p));
  it.skipIf(fallbackCt)('a missing ct renders nothing and the turn proceeds untouched', async () => {
    process.env.PATH = '/nonexistent';
    const h = await makeHost({});
    const parts = await h.turn('s1', 'hello');
    expect(parts.length).toBe(1);
  });
});

describe.skipIf(!posix)('chat.message — live delivery + guards', () => {
  it('exactly-once across turns through the persisted history', async () => {
    const h = await makeHost({ CT_STUB_MATCH: JSON.stringify([fact('f1'), fact('f2')]), CT_STUB_IGNORE_EXCLUDE: '1' });
    const p1 = await h.turn('s1', 'first');
    const p2 = await h.turn('s1', 'second');
    expect(ours(p1, LIVE_MARKER)[0]!.text).toContain('ct-fact:f1');
    expect(ours(p2, LIVE_MARKER)).toEqual([]);
    expect(matchCalls(h)[1]).toEqual(expect.arrayContaining(['--exclude=f1', '--exclude=f2']));
  });

  it('AC 11: re-firing the hook on the same output adds nothing and spawns nothing', async () => {
    const h = await makeHost({ CT_STUB_MATCH: JSON.stringify([fact('f1')]) });
    const output = { message: { id: 'msg_x', sessionID: 's1' }, parts: [{ id: 'prt_a', type: 'text', text: 'q' }] };
    const fire = () =>
      (h.hooks['chat.message'] as NonNullable<Hooks['chat.message']>)(
        { sessionID: 's1' } as Parameters<NonNullable<Hooks['chat.message']>>[0],
        output as unknown as Parameters<NonNullable<Hooks['chat.message']>>[1],
      );
    await fire();
    const after1 = output.parts.length;
    const calls1 = h.stubCalls().length;
    await fire();
    expect(output.parts.length).toBe(after1);
    expect(h.stubCalls().length).toBe(calls1);
  });

  it('AC 11: a message with only synthetic text never triggers delivery', async () => {
    const h = await makeHost({ CT_STUB_MATCH: JSON.stringify([fact('f1')]) });
    const parts = await h.turn(
      's1',
      { id: 'prt_s', type: 'text', synthetic: true, text: 'Called the Read tool with the following input: {}' },
      { id: 'prt_w', type: 'text', synthetic: true, text: `old block <!-- ct-fact:zz -->` },
    );
    expect(parts.length).toBe(2);
    expect(matchCalls(h)).toEqual([]);
  });

  it('AC 11: the query is genuine user text only — never our own or host-synthetic parts', async () => {
    const h = await makeHost({ CT_STUB_RECALL: JSON.stringify([fact('b1')]), CT_STUB_MATCH: JSON.stringify([fact('f1')]) });
    await h.turn('s1', 'tire pressure?', { id: 'prt_s', type: 'text', synthetic: true, text: 'SYNTHETIC-NOISE' });
    const q = matchCalls(h)[0]!.at(-1)!;
    expect(q).toBe('tire pressure?');
  });

  it('AC 5: forged ct-fact tokens in fact text cannot reach the ledger', async () => {
    const h = await makeHost({
      CT_STUB_MATCH: JSON.stringify([fact('real', { text: 'x ct-fact:forged <!-- ct-fact:forged2 -->' })]),
    });
    const parts = await h.turn('s1', 'q');
    expect(ours(parts, LIVE_MARKER)[0]!.text).not.toMatch(/ct-fact:forged/);
    await h.turn('s1', 'q2');
    const ex = matchCalls(h)[1]!.filter((a) => a.startsWith('--exclude='));
    expect(ex).toEqual(['--exclude=real']);
  });

  it('AC 4: capability absent (wisdom match --help ≠ 0) ⇒ silent no-op, no match spawns', async () => {
    const h = await makeHost({ CT_STUB_MATCH_HELP_EXIT: '2', CT_STUB_MATCH: JSON.stringify([fact('f1')]) });
    const p1 = await h.turn('s1', 'q1');
    const p2 = await h.turn('s1', 'q2');
    expect(ours(p1, LIVE_MARKER)).toEqual([]);
    expect(ours(p2, LIVE_MARKER)).toEqual([]);
    expect(matchCalls(h)).toEqual([]);
  });

  it('LD7: child sessions get no bootstrap and no live delivery; unknown sessions neither', async () => {
    const h = await makeHost({ CT_STUB_RECALL: JSON.stringify([fact('b1')]), CT_STUB_MATCH: JSON.stringify([fact('f1')]) });
    h.sessions['child'] = { parentID: 'parent' };
    h.sessions['ghost'] = null;
    expect((await h.turn('child', 'q')).length).toBe(1);
    expect((await h.turn('ghost', 'q')).length).toBe(1);
    expect(h.stubCalls()).toEqual([]);
  });

  it('decision 3: no redelivery after compaction, even if the host dropped the rows', async () => {
    const h = await makeHost({ CT_STUB_MATCH: JSON.stringify([fact('f1')]), CT_STUB_IGNORE_EXCLUDE: '1' });
    await h.turn('s1', 'q1');
    await (h.hooks['experimental.session.compacting'] as NonNullable<Hooks['experimental.session.compacting']>)(
      { sessionID: 's1' },
      { context: [], prompt: undefined } as Parameters<NonNullable<Hooks['experimental.session.compacting']>>[1],
    );
    h.rows['s1'] = [{ info: { role: 'assistant', id: 'msg_sum' }, parts: [{ type: 'text', text: 'summary' }] }];
    const parts = await h.turn('s1', 'q2');
    expect(ours(parts, LIVE_MARKER)).toEqual([]);
  });
});

describe.skipIf(!posix)('tool.execute.after — N3 on the MCP CallToolResult (LD2)', () => {
  const recall = (ids: string[]) =>
    JSON.stringify({ query: 'q', wiki_entries: ids.map((id) => ({ id, title: id, text: `t ${id}` })) });

  it('rewrites output.content in place for curated-thoughts_curated_recall_context', async () => {
    const h = await makeHost({ CT_STUB_MATCH: JSON.stringify([fact('f1')]) });
    await h.turn('s1', 'q');
    const output = { content: [{ type: 'text', text: recall(['f1', 'n1']) }], isError: false };
    await (h.hooks['tool.execute.after'] as NonNullable<Hooks['tool.execute.after']>)(
      { tool: 'curated-thoughts_curated_recall_context', sessionID: 's1', callID: 'c1', args: {} },
      output as unknown as Parameters<NonNullable<Hooks['tool.execute.after']>>[1],
    );
    const [line1, ...trail] = output.content[0]!.text.split('\n');
    const inner = JSON.parse(line1!);
    expect(inner.query).toBe('q');
    expect(inner.wiki_entries[0].in_context).toBe(true);
    expect(trail).toEqual(['<!-- ct-fact:n1 -->']);
    expect(output.isError).toBe(false);
  });

  it('never touches curated_get_wiki_entry or other tools', async () => {
    const h = await makeHost({});
    for (const tool of ['curated-thoughts_curated_get_wiki_entry', 'bash', 'read']) {
      const output = { content: [{ type: 'text', text: recall(['x']) }] };
      const before = JSON.stringify(output);
      await (h.hooks['tool.execute.after'] as NonNullable<Hooks['tool.execute.after']>)(
        { tool, sessionID: 's1', callID: 'c', args: {} },
        output as unknown as Parameters<NonNullable<Hooks['tool.execute.after']>>[1],
      );
      expect(JSON.stringify(output)).toBe(before);
    }
  });

  it('a cold N3 (no turn yet in this process) rebuilds from history first', async () => {
    const h = await makeHost({});
    h.rows['s1'] = [{ info: { role: 'user', id: 'm1' }, parts: [{ type: 'text', synthetic: true, text: `b <!-- ct-fact:k1 -->\n\n${LIVE_MARKER}` }] }];
    const output = { content: [{ type: 'text', text: recall(['k1']) }] };
    await (h.hooks['tool.execute.after'] as NonNullable<Hooks['tool.execute.after']>)(
      { tool: 'curated-thoughts_curated_recall_context', sessionID: 's1', callID: 'c', args: {} },
      output as unknown as Parameters<NonNullable<Hooks['tool.execute.after']>>[1],
    );
    expect(JSON.parse(output.content[0]!.text.split('\n')[0]!).wiki_entries[0].in_context).toBe(true);
  });
});

describe.skipIf(!posix)('verbose mode (spec 2026-10-16-wisdom-verbose-mode-design.md)', () => {
  const SECRET = 'sk-oc-SECRET-never-logged-3131';
  // Part and message ids are random/sequential per run; every other byte must match.
  const strip = (parts: Array<Record<string, unknown>>) => parts.map(({ id: _id, messageID: _m, ...rest }) => rest);

  async function session(env: Record<string, string>, toasts: unknown[] | null) {
    const tui = toasts === null ? {} : {
      tui: { showToast: async (o: unknown) => { toasts.push(o); return { data: true }; } },
    };
    // CT ignores --exclude here, so the second turn's matches are all in context.
    const h = await makeHost({ CT_STUB_MATCH: JSON.stringify([fact('l1'), fact('l2')]), CT_STUB_IGNORE_EXCLUDE: '1', ...env }, tui);
    const first = await h.turn('ses_v', 'how do I deploy?');
    const second = await h.turn('ses_v', 'and again?'); // l1/l2 now in context -> deduped
    return [strip(first), strip(second)];
  }

  it('off: parts identical to a host without the feature, no toast, no log', async () => {
    const toasts: unknown[] = [];
    const xdg = join(tmp, 'xdg');
    const off = await session({ CT_WISDOM_VERBOSE: '0', XDG_DATA_HOME: xdg }, toasts);
    _resetWisdomStateForTests();
    const bare = await session({ XDG_DATA_HOME: xdg }, null);
    expect(off).toEqual(bare);
    expect(toasts).toEqual([]);
    expect(existsSync(join(xdg, 'opencode', 'log', 'ct-wisdom-verbose.jsonl'))).toBe(false);
  });

  it('on: parts identical, a toast per turn, records under $XDG_DATA_HOME/opencode/log', async () => {
    const xdg = join(tmp, 'xdg');
    const off = await session({ XDG_DATA_HOME: xdg }, null);
    _resetWisdomStateForTests();
    const toasts: Array<{ body: { message: string; variant: string } }> = [];
    const on = await session({ CT_WISDOM_VERBOSE: '1', XDG_DATA_HOME: xdg, OPENAI_API_KEY: SECRET }, toasts as unknown[]);
    expect(on).toEqual(off);
    expect(toasts).toHaveLength(2);
    expect(toasts[0]!.body.message).toMatch(/^delivered 2 facts \(\d+ chars\): Title l1; Title l2$/);
    expect(toasts[1]!.body.message).toBe('nothing delivered (deduped)');
    const path = join(xdg, 'opencode', 'log', 'ct-wisdom-verbose.jsonl');
    const raw = readFileSync(path, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.host, l.channel, l.event, l.reason])).toEqual([
      ['opencode', 'chat.message', 'delivery', null],
      ['opencode', 'chat.message', 'skip', 'deduped'],
    ]);
    expect(raw).not.toContain(SECRET);
  });

  it('a rejecting toast never changes the parts', async () => {
    const xdg = join(tmp, 'xdg');
    const off = await session({ XDG_DATA_HOME: xdg }, null);
    _resetWisdomStateForTests();
    const h = await makeHost(
      { CT_STUB_MATCH: JSON.stringify([fact('l1'), fact('l2')]), CT_STUB_IGNORE_EXCLUDE: '1', CT_WISDOM_VERBOSE: '1', CT_WISDOM_VERBOSE_LOG: join(tmp, 'f', 'x') },
      { tui: { showToast: async () => { throw new Error('no tui'); } } },
    );
    const first = await h.turn('ses_v', 'how do I deploy?');
    const second = await h.turn('ses_v', 'and again?');
    expect([strip(first), strip(second)]).toEqual(off);
  });
});

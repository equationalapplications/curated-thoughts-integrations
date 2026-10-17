/**
 * test_wisdom_activity.ts — OpenCode autonomous-work delivery (spec
 * docs/superpowers/specs/2026-10-17-opencode-autonomous-work-wisdom-design.md).
 *
 * A simulated 1.18.35 host drives createWisdomHooks the way the binary does
 * (pinned facts in the spec): the processor persists a tool part (callID,
 * messageID) when the call streams in; `tool.execute.before` fires; a refused
 * permission ask aborts the call, so `tool.execute.after` never fires for it;
 * otherwise `tool.execute.after` gets the builtin `{title, output, metadata}`
 * or the MCP CallToolResult, and its (possibly rewritten) text is what the
 * host persists as the part's `state.output`.
 */
import { mkdirSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_HEADING,
  createVerboseRecorder,
  type SpawnFn,
  type SpawnOutcome,
  type VerboseTurn,
} from '@equational-applications/ct-wisdom-core';
import { createWisdomHooks } from '../src/wisdom-live/hooks.js';
import { isCodeModeCall, isOpenCodeCtTool, opencodeActivitySpec } from '../src/wisdom-live/activity.js';

type Part = Record<string, unknown>;
type Row = { info: { role: string; id: string }; parts: Part[] };
type Entry = { id: string; title?: string; text?: string; provenance?: string };

let tmp: string;
let work: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ct-oc-act-')));
  work = join(tmp, 'proj');
  mkdirSync(join(work, '.git'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const done = (stdout: string): SpawnOutcome => ({ code: 0, stdout, stderr: '', spawnError: false, timedOut: false });
const fact = (id: string): Entry => ({ id, title: `Title ${id}`, text: `Body of ${id}.`, provenance: 'stated' });

interface CallSpec {
  tool: string;
  args: Record<string, unknown>;
  /** The host refused the permission ask: `after` never fires. */
  refused?: boolean;
  /** MCP carrier instead of the builtin {title, output, metadata}. */
  mcp?: boolean;
  /** Tool output text. */
  text?: string;
}

interface SimOptions {
  /** CT answer for an activity query (`--max 1`); 'hang' never settles in budget. */
  answer?: (query: string) => Entry[] | 'hang' | 'timeout';
  /** CT answer for user-turn queries (`--max 2`). */
  userAnswer?: (query: string) => Entry[];
  sessions?: Record<string, { parentID?: string; directory?: string } | null>;
  verbose?: (turn: VerboseTurn) => void;
  now?: () => number;
  fetchFails?: boolean;
  /** Delay before an activity answer settles (real timer). */
  delayMs?: number;
}

function makeSim(opts: SimOptions = {}) {
  const rows: Record<string, Row[]> = {};
  const sessions = opts.sessions ?? { P: { directory: work } };
  const argvs: string[][] = [];
  let seq = 0;
  const spawnFn: SpawnFn = async (spec) => {
    if (spec.args.includes('--help')) return done('');
    argvs.push(spec.args);
    const query = spec.args[spec.args.length - 1] ?? '';
    const max = Number(spec.args[spec.args.indexOf('--max') + 1]);
    if (max === 1) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const a = opts.answer?.(query) ?? [];
      if (a === 'hang') return new Promise(() => {});
      if (a === 'timeout') return { code: null, stdout: '', stderr: '', spawnError: false, timedOut: true };
      return done(JSON.stringify({ entries: a, corrections: [] }));
    }
    return done(JSON.stringify({ entries: opts.userAnswer?.(query) ?? [], corrections: [] }));
  };
  const built = createWisdomHooks({
    env: {},
    spawnFn,
    discover: () => ({ path: '/bin/ct', failure: null }),
    fetchHistory: async (id) => {
      if (opts.fetchFails) throw new Error('boom');
      return structuredClone(rows[id] ?? []);
    },
    fetchSession: async (id) => {
      if (opts.fetchFails) throw new Error('boom');
      return id in sessions ? sessions[id] ?? null : null;
    },
    renderBootstrap: () => '',
    ...(opts.verbose ? { recordVerbose: opts.verbose } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const hooks = built.hooks;
  const activityCalls = () => argvs.filter((a) => a[a.indexOf('--max') + 1] === '1');
  const queries = () => activityCalls().map((a) => a[a.length - 1]!);

  async function userTurn(session: string, text: string): Promise<Part[]> {
    const id = `msg_${String(++seq).padStart(5, '0')}`;
    const parts: Part[] = [{ id: `prt_u${seq}`, type: 'text', text }];
    await hooks['chat.message']({ sessionID: session } as never, { message: { id, sessionID: session }, parts } as never);
    (rows[session] ??= []).push({ info: { role: 'user', id }, parts });
    return parts;
  }

  /** One model step: its calls stream in, run their hooks (afters in parallel), persist. */
  async function step(session: string, calls: CallSpec[]): Promise<string[]> {
    const messageID = `msg_${String(++seq).padStart(5, '0')}`;
    const row: Row = { info: { role: 'assistant', id: messageID }, parts: [] };
    (rows[session] ??= []).push(row);
    const callIDs = calls.map((_, i) => `call_${seq}_${i}`);
    calls.forEach((c, i) =>
      row.parts.push({ id: `prt_t${seq}_${i}`, type: 'tool', callID: callIDs[i], messageID, tool: c.tool, state: { status: 'running', input: c.args } }),
    );
    const outputs = calls.map((c) =>
      c.mcp ? { content: [{ type: 'text', text: c.text ?? 'mcp result' }] } : { title: '', output: c.text ?? 'tool output', metadata: {} },
    );
    for (let i = 0; i < calls.length; i++) {
      await hooks['tool.execute.before']({ tool: calls[i]!.tool, sessionID: session, callID: callIDs[i]! }, { args: calls[i]!.args });
    }
    await Promise.all(
      calls.map(async (c, i) => {
        if (c.refused) return;
        await hooks['tool.execute.after']({ tool: c.tool, sessionID: session, callID: callIDs[i]!, args: c.args }, outputs[i] as never);
      }),
    );
    const persisted = outputs.map((o, i) => {
      const part = row.parts[i]!;
      if (calls[i]!.refused) {
        part.state = { status: 'error', input: calls[i]!.args, error: 'rejected' };
        return '';
      }
      const text = 'content' in o
        ? (o.content as Array<{ type: string; text: string }>).filter((x) => x.type === 'text').map((x) => x.text).join('\n')
        : (o as { output: string }).output;
      part.state = { status: 'completed', input: calls[i]!.args, output: text, title: '', metadata: {} };
      return text;
    });
    return persisted;
  }

  return { hooks, rows, argvs, activityCalls, queries, userTurn, step, adapter: built.adapter };
}

const blocksIn = (text: string) => text.split(ACTIVITY_HEADING).length - 1;

// ─────────────────────────────────────────────────────────────────────────

describe('binding (tool table at the 1.18.35 pin)', () => {
  it('maps only the target argument of the builtin tools', () => {
    expect(opencodeActivitySpec('read', { filePath: 'a.ts', offset: 2 })).toEqual({ verb: 'read', path: 'a.ts' });
    expect(opencodeActivitySpec('write', { filePath: 'a.ts', content: 'SECRET' })).toEqual({ verb: 'write', path: 'a.ts' });
    expect(opencodeActivitySpec('edit', { filePath: 'a.ts', oldString: 'x', newString: 'SECRET' })).toEqual({ verb: 'edit', path: 'a.ts' });
    expect(opencodeActivitySpec('grep', { pattern: 'TODO', path: 'src', include: '*.ts' })).toEqual({ verb: 'search', pattern: 'TODO', path: 'src' });
    expect(opencodeActivitySpec('glob', { pattern: '**/*.ts' })).toEqual({ verb: 'search', pattern: '**/*.ts', path: undefined });
    expect(opencodeActivitySpec('bash', { command: 'pnpm test', workdir: '/x', timeout: 5 })).toEqual({ verb: 'run', command: 'pnpm test' });
  });

  it('gives no activity for other tools or malformed args', () => {
    for (const tool of ['apply_patch', 'task', 'webfetch', 'websearch', 'todowrite', 'skill', 'lsp', 'question', 'github_create_issue', 'constructor', 'toString']) {
      expect(opencodeActivitySpec(tool, { filePath: 'a.ts', command: 'ls', pattern: 'x', patchText: '*** Update File: a.ts' }), tool).toBeNull();
    }
    expect(opencodeActivitySpec('read', null)).toBeNull();
    expect(opencodeActivitySpec('read', 'a.ts')).toBeNull();
    expect(opencodeActivitySpec(42, { filePath: 'a.ts' })).toBeNull();
  });

  it('recognises CT tools under any server name, and code-mode child calls', () => {
    for (const n of ['curated-thoughts_curated_recall_context', 'curated-thoughts_curated_get_wiki_entry', 'ct_curated_recall_context', 'curated_recall_context', 'mcp__curated-thoughts__curated_x']) {
      expect(isOpenCodeCtTool(n), n).toBe(true);
    }
    for (const n of ['read', 'bash', 'github_search_code']) expect(isOpenCodeCtTool(n), n).toBe(false);
    expect(isCodeModeCall('call_abc/1')).toBe(true);
    expect(isCodeModeCall('call_abc')).toBe(false);
  });
});

describe('delivery channel (marker first, appended)', () => {
  it('builtin: the block is appended after a blank line, once, marker before the title', async () => {
    const sim = makeSim({ answer: () => [fact('f-env')] });
    const [out] = await sim.step('P', [{ tool: 'read', args: { filePath: join(work, '.env.local') }, text: 'FOO=bar' }]);
    expect(sim.queries()).toEqual(['.env.local']);
    expect(out!.startsWith('FOO=bar\n\n' + ACTIVITY_HEADING + '\n_for: read .env.local_\n\n<!-- ct-fact:f-env --> **Title f-env** (provenance: stated)\nBody of f-env.')).toBe(true);
    expect(blocksIn(out!)).toBe(1);
    expect(out!.indexOf('<!-- ct-fact:f-env -->')).toBeLessThan(out!.indexOf('Title f-env'));
  });

  it('MCP: the block rides the LAST text item, so it is the tail of the joined output', async () => {
    const sim = makeSim({ answer: () => [fact('f-m')] });
    // A non-CT MCP tool never has an activity; drive the MCP shape with a builtin name.
    const out = { content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: 'two' }] };
    sim.rows['P'] = [{ info: { role: 'assistant', id: 'msg_a' }, parts: [{ type: 'tool', callID: 'c1', messageID: 'msg_a', state: { status: 'running' } }] }];
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'P', callID: 'c1' }, { args: { command: 'pnpm test' } });
    await sim.hooks['tool.execute.after']({ tool: 'bash', sessionID: 'P', callID: 'c1', args: {} }, out as never);
    expect(out.content[0]!.text).toBe('one');
    expect(out.content[2]!.text!.startsWith(`two\n\n${ACTIVITY_HEADING}`)).toBe(true);
  });

  it('MCP fit guard: an output near the host truncation limit sends nothing and is untouched', async () => {
    const sim = makeSim({ answer: () => [fact('f-big')] });
    const big = 'x\n'.repeat(1500);
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' }, mcp: true, text: big }]);
    expect(out).toBe(big);
    expect(sim.activityCalls()).toEqual([]);
  });

  it('an unsupported output shape sends nothing', async () => {
    const sim = makeSim({ answer: () => [fact('f')] });
    sim.rows['P'] = [{ info: { role: 'assistant', id: 'msg_a' }, parts: [{ type: 'tool', callID: 'c1', messageID: 'msg_a' }] }];
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'P', callID: 'c1' }, { args: { command: 'pnpm test' } });
    const weird = { title: '', output: 42, metadata: {} };
    await sim.hooks['tool.execute.after']({ tool: 'bash', sessionID: 'P', callID: 'c1', args: {} }, weird as never);
    expect(weird.output).toBe(42);
    expect(sim.activityCalls()).toEqual([]);
  });

  it('the CT argv is `--max 1 … -- <bare target>`, the query last', async () => {
    const sim = makeSim({ answer: () => [] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'API_KEY=sk-123 pnpm test --filter x' } }]);
    const [a] = sim.activityCalls();
    expect(a!.slice(a!.indexOf('--'))).toEqual(['--', 'pnpm test']);
    expect(a!.join(' ')).not.toContain('sk-123');
  });
});

describe('rate rule: one CT call per model step on a key change', () => {
  it('parallel calls of one step make ONE call; one block, on the trigger', async () => {
    const sim = makeSim({ answer: (q) => [fact(`f-${q.replace(/\W/g, '')}`)] });
    const outs = await sim.step('P', [
      { tool: 'bash', args: { command: 'pnpm test' } },
      { tool: 'read', args: { filePath: 'src/index.ts' } },
      { tool: 'grep', args: { pattern: 'TODO' } },
    ]);
    expect(sim.activityCalls().length).toBe(1);
    expect(outs.reduce((n, o) => n + blocksIn(o), 0)).toBe(1);
  });

  it('a later step with the same key makes no call; a new key makes one', async () => {
    const sim = makeSim({ answer: () => [] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test --silent' } }]);
    await sim.step('P', [{ tool: 'write', args: { filePath: '.env.local', content: 'A=1' } }]);
    await sim.step('P', [{ tool: 'read', args: { filePath: '.env.local' } }]); // same file key
    expect(sim.queries()).toEqual(['pnpm test', '.env.local']);
  });

  it('keys skipped in a step (coalesced) can trigger in a later step', async () => {
    const sim = makeSim({ answer: () => [] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }, { tool: 'bash', args: { command: 'make build' } }]);
    await sim.step('P', [{ tool: 'bash', args: { command: 'make build' } }]);
    expect(sim.queries()).toEqual(['pnpm test', 'make build']);
  });

  it('a refused call (no tool.execute.after) never queries CT (decision 8)', async () => {
    const sim = makeSim({ answer: () => [fact('f')] });
    await sim.step('P', [{ tool: 'read', args: { filePath: 'secrets.env' }, refused: true }]);
    expect(sim.activityCalls()).toEqual([]);
    // The refused key is still unseen: an approved call may trigger it later.
    await sim.step('P', [{ tool: 'read', args: { filePath: 'secrets.env' } }]);
    expect(sim.queries()).toEqual(['secrets.env']);
  });

  it('a call whose tool part is not in the history (no step id) sends nothing', async () => {
    const sim = makeSim({ answer: () => [fact('f')] });
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'P', callID: 'ghost' }, { args: { command: 'pnpm test' } });
    const out = { title: '', output: 'o', metadata: {} };
    await sim.hooks['tool.execute.after']({ tool: 'bash', sessionID: 'P', callID: 'ghost', args: {} }, out as never);
    expect(out.output).toBe('o');
    expect(sim.activityCalls()).toEqual([]);
  });

  it('delivery never plans: an after with no before-plan sends nothing', async () => {
    const sim = makeSim({ answer: () => [fact('f')] });
    sim.rows['P'] = [{ info: { role: 'assistant', id: 'msg_a' }, parts: [{ type: 'tool', callID: 'c1', messageID: 'msg_a' }] }];
    const out = { title: '', output: 'o', metadata: {} };
    await sim.hooks['tool.execute.after']({ tool: 'bash', sessionID: 'P', callID: 'c1', args: { command: 'pnpm test' } }, out as never);
    expect(out.output).toBe('o');
    expect(sim.activityCalls()).toEqual([]);
  });

  it('release on a post-start failure (budget, timeout): a later step retries the key', async () => {
    let n = 0;
    const answers: Array<'hang' | 'timeout' | Entry[]> = ['hang', 'timeout', [fact('f-ok')]];
    let clock = 0;
    const sim = makeSim({ answer: () => answers[n++]!, now: () => (clock += 2000) });
    const o1 = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    const o2 = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    const o3 = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.queries()).toEqual(['pnpm test', 'pnpm test', 'pnpm test']);
    expect([blocksIn(o1[0]!), blocksIn(o2[0]!), blocksIn(o3[0]!)]).toEqual([0, 0, 1]);
  });

  it('keep on no_match / deduped: CT answered, the key is not queried again', async () => {
    const sim = makeSim({ answer: () => [] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.queries()).toEqual(['pnpm test']);
  });

  it('CT tools and code-mode child calls never trigger (decision 6)', async () => {
    const sim = makeSim({ answer: () => [fact('f')] });
    await sim.step('P', [{ tool: 'curated-thoughts_curated_get_wiki_entry', args: { id: 'x', command: 'pnpm test' }, mcp: true }]);
    sim.rows['P']!.push({ info: { role: 'assistant', id: 'msg_cm' }, parts: [{ type: 'tool', callID: 'call_x/1', messageID: 'msg_cm' }] });
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'P', callID: 'call_x/1' }, { args: { command: 'pnpm test' } });
    await sim.hooks['tool.execute.after']({ tool: 'bash', sessionID: 'P', callID: 'call_x/1', args: {} }, { title: '', output: '', metadata: {} } as never);
    expect(sim.activityCalls()).toEqual([]);
  });
});

describe('ledger and exactly once', () => {
  it('a fact delivered by the user turn is never activity-delivered', async () => {
    const sim = makeSim({ userAnswer: () => [fact('shared')], answer: () => [fact('shared')] });
    await sim.userTurn('P', 'hello');
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(blocksIn(out!)).toBe(0);
    expect(sim.activityCalls()[0]).toContain('--exclude=shared');
  });

  it('an activity fact is in the next user turn\'s ledger (never redelivered there)', async () => {
    const sim = makeSim({ answer: () => [fact('a1')], userAnswer: () => [fact('a1')] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    const parts = await sim.userTurn('P', 'next');
    expect(parts.some((p) => String(p.text ?? '').includes('ct-fact:a1'))).toBe(false);
  });

  it('a parallel CT recall of fact X in the same step blocks an activity X (unpersisted ids)', async () => {
    const recall = JSON.stringify({ query: 'q', wiki_entries: [{ id: 'X', title: 'X', text: 'x' }] });
    // The activity match settles only after the recall's hook has run.
    const sim = makeSim({ answer: () => [fact('X')], delayMs: 50 });
    const outs = await sim.step('P', [
      { tool: 'bash', args: { command: 'pnpm test' } },
      { tool: 'curated-thoughts_curated_recall_context', args: { query: 'q' }, mcp: true, text: recall },
    ]);
    expect(sim.activityCalls().length).toBe(1);
    expect(outs[1]).toContain('<!-- ct-fact:X -->'); // N3 trailer: the recall shows X
    expect(blocksIn(outs[0]!)).toBe(0); // so the activity must not show it again
    expect(outs.join('\n').match(/ct-fact:X/g)?.length).toBe(1);
  });

  it('the activity query never holds our own block text; the user-turn query never holds tool output', async () => {
    const sim = makeSim({ answer: () => [fact('a1')], userAnswer: () => [] });
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    await sim.step('P', [{ tool: 'grep', args: { pattern: out!.split('\n').find((l) => l.includes('ct-fact:'))! } }]);
    await sim.userTurn('P', 'plain question');
    for (const a of sim.argvs) {
      const q = a[a.length - 1]!;
      expect(q).not.toContain('ct-fact:');
      expect(q).not.toContain(ACTIVITY_HEADING);
    }
    expect(sim.argvs.at(-1)!.at(-1)).toBe('plain question');
  });
});

describe('subagents (decision 4) and unknown sessions', () => {
  it('a child session gets activity delivery, from its OWN ledger', async () => {
    const sim = makeSim({
      sessions: { P: { directory: work }, C: { parentID: 'P', directory: work } },
      userAnswer: () => [fact('pf')],
      answer: () => [fact('pf')],
    });
    await sim.userTurn('P', 'parent question'); // the parent now holds pf
    const childParts = await sim.userTurn('C', 'task prompt from the parent');
    expect(childParts.some((p) => p.synthetic === true)).toBe(false); // per-message stays parent-only
    const [out] = await sim.step('C', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(blocksIn(out!)).toBe(1); // the child cannot see the parent's context
    expect(out).toContain('ct-fact:pf');
    const [again] = await sim.step('C', [{ tool: 'read', args: { filePath: 'b.ts' } }]);
    expect(blocksIn(again!)).toBe(0); // now in the child's own context
  });

  it('an unknown session kind (lookup fails) delivers nothing', async () => {
    const sim = makeSim({ sessions: {}, answer: () => [fact('f')] });
    const [out] = await sim.step('X', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(blocksIn(out!)).toBe(0);
    expect(sim.activityCalls()).toEqual([]);
  });

  it('without a session directory no path is sent (commands still are)', async () => {
    const sim = makeSim({ sessions: { P: {} }, answer: () => [] });
    await sim.step('P', [{ tool: 'read', args: { filePath: join(work, 'src/a.ts') } }]);
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.queries()).toEqual(['pnpm test']);
  });
});

describe('fail closed (rule 4)', () => {
  it('throwing history/session lookups never throw out of the hooks and leave outputs untouched', async () => {
    const sim = makeSim({ fetchFails: true, answer: () => [fact('f')] });
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' }, text: 'same' }]);
    expect(out).toBe('same');
  });

  it('empty session or call ids do nothing', async () => {
    const sim = makeSim({ answer: () => [fact('f')] });
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: '', callID: 'c' }, { args: { command: 'pnpm test' } });
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'P', callID: '' }, { args: { command: 'pnpm test' } });
    const out = { title: '', output: 'o', metadata: {} };
    await sim.hooks['tool.execute.after']({ tool: 'bash', sessionID: 'P', callID: '', args: {} }, out as never);
    expect(out.output).toBe('o');
    expect(sim.activityCalls()).toEqual([]);
  });
});

describe('verbose mode (channel activity)', () => {
  it('off: byte-identical tool outputs to an on run, and nothing is written', async () => {
    const xdg = join(tmp, 'xdg');
    const run = async (verbose: boolean) => {
      const rec = createVerboseRecorder({
        host: 'opencode',
        channel: 'chat.message',
        env: { CT_WISDOM_VERBOSE: verbose ? '1' : '0' },
        logPath: join(xdg, 'v.jsonl'),
      });
      const sim = makeSim({ answer: () => [fact('v1')], ...(rec ? { verbose: rec } : {}) });
      const a = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
      const b = await sim.step('P', [{ tool: 'read', args: { filePath: 'README.md' } }]);
      return [...a, ...b];
    };
    const off = await run(false);
    expect(existsSync(join(xdg, 'v.jsonl'))).toBe(false);
    const on = await run(true);
    expect(on).toEqual(off);
    const lines = readFileSync(join(xdg, 'v.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const deliveries = lines.filter((l) => l.channel === 'activity' && l.event === 'delivery');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ host: 'opencode', query: 'pnpm test', activity: 'run pnpm test', delivered_ids: ['v1'] });
    // The second step's CT answer was deduped (v1 already in context): recorded as a skip.
    expect(lines.some((l) => l.channel === 'activity' && l.event === 'skip' && l.reason === 'deduped')).toBe(true);
  });

  it('rate and filter skips are never recorded', async () => {
    const turns: VerboseTurn[] = [];
    const sim = makeSim({ answer: () => [], verbose: (t) => turns.push(t) });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }, { tool: 'webfetch', args: { url: 'x' } }]);
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(turns.map((t) => t.reason)).toEqual(['zero_hits']);
  });
});

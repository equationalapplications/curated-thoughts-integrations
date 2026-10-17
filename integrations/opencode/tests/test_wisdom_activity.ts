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
import { activityHost, canCarry, isCodeModeCall, isOpenCodeCtTool, opencodeActivitySpec } from '../src/wisdom-live/activity.js';
import { OpenCodeWisdomAdapter } from '../src/wisdom-live/adapter.js';

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
  /**
   * How the host persists the part after the hooks: 'normal' (the hook's
   * output), 'abort' (an error part without the output: the step was
   * cancelled), 'none' (still running: never persisted).
   */
  persist?: 'normal' | 'abort' | 'none';
}

interface SimOptions {
  /**
   * CT answer for an activity query (`--max 1`). 'hang' runs until the call
   * is aborted (then exits after `killDelayMs`): the budget path.
   */
  answer?: (query: string) => Entry[] | 'hang' | 'timeout' | 'aborted';
  killDelayMs?: number;
  /** The activity budget (default 3 s). */
  budgetMs?: number;
  /** session.messages never answers for activity fetches. */
  hangHistory?: boolean;
  /** Run the afters of a step one after the other. */
  sequential?: boolean;
  /** Delay of every session.messages answer (mutable: tests change it mid-run). */
  history?: { delayMs: number };
  /** session.get never answers / always throws. */
  sessionHangs?: boolean;
  sessionThrows?: boolean;
  /** Exit code of `ct wisdom match --help` (non-zero latches the capability off). */
  helpExit?: number;
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
  const killed: string[] = [];
  let historyFetches = 0;
  let sessionFetches = 0;
  let seq = 0;
  const spawnFn: SpawnFn = async (spec) => {
    if (spec.args.includes('--help')) return { ...done(''), code: opts.helpExit ?? 0 };
    argvs.push(spec.args);
    const query = spec.args[spec.args.length - 1] ?? '';
    const max = Number(spec.args[spec.args.indexOf('--max') + 1]);
    if (max === 1) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const a = opts.answer?.(query) ?? [];
      if (a === 'hang') {
        return new Promise((resolve) => {
          const exit = () =>
            setTimeout(() => {
              killed.push(query);
              resolve({ code: null, stdout: '', stderr: '', spawnError: false, timedOut: false });
            }, opts.killDelayMs ?? 0);
          if (spec.signal?.aborted) exit();
          else spec.signal?.addEventListener('abort', exit, { once: true });
        });
      }
      if (a === 'timeout') return { code: null, stdout: '', stderr: '', spawnError: false, timedOut: true };
      if (a === 'aborted') return { code: null, stdout: '', stderr: '', spawnError: false, timedOut: false, aborted: true };
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
      historyFetches++;
      if (opts.hangHistory) return new Promise(() => {});
      if (opts.history?.delayMs) await new Promise((r) => setTimeout(r, opts.history!.delayMs));
      return structuredClone(rows[id] ?? []);
    },
    fetchSession: async (id) => {
      sessionFetches++;
      if (opts.fetchFails || opts.sessionThrows) throw new Error('boom');
      if (opts.sessionHangs) return new Promise(() => {});
      return id in sessions ? sessions[id] ?? null : null;
    },
    renderBootstrap: () => '',
    ...(opts.verbose ? { recordVerbose: opts.verbose } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
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
    const after = async (c: CallSpec, i: number) => {
      if (c.refused) return;
      await hooks['tool.execute.after']({ tool: c.tool, sessionID: session, callID: callIDs[i]!, args: c.args }, outputs[i] as never);
    };
    if (opts.sequential) {
      for (let i = 0; i < calls.length; i++) await after(calls[i]!, i);
    } else {
      await Promise.all(calls.map(after));
    }
    const persisted = outputs.map((o, i) => {
      const part = row.parts[i]!;
      if (calls[i]!.refused || calls[i]!.persist === 'abort') {
        part.state = { status: 'error', input: calls[i]!.args, error: calls[i]!.refused ? 'rejected' : 'Cancelled' };
        return '';
      }
      if (calls[i]!.persist === 'none') return '';
      const text = 'content' in o
        ? (o.content as Array<{ type: string; text: string }>).filter((x) => x.type === 'text').map((x) => x.text).join('\n')
        : (o as { output: string }).output;
      part.state = { status: 'completed', input: calls[i]!.args, output: text, title: '', metadata: {} };
      return text;
    });
    return persisted;
  }

  /** /undo: the host removes a step's message from the history. */
  const undo = (session: string, messageID: string) => {
    rows[session] = (rows[session] ?? []).filter((r) => r.info.id !== messageID);
  };
  const lastMessageID = (session: string) => rows[session]!.at(-1)!.info.id;
  return {
    hooks, rows, argvs, activityCalls, queries, userTurn, step, undo, lastMessageID, killed,
    historyFetches: () => historyFetches,
    sessionFetches: () => sessionFetches,
    adapter: built.adapter,
  };
}

const blocksIn = (text: string) => text.split(ACTIVITY_HEADING).length - 1;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

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
    // Case-insensitive (review of PR #66): server and tool names are lowered first.
    for (const n of ['CT_Curated_Recall_Context', 'Curated_Get_Wiki_Entry', 'Curated-Thoughts_x']) expect(isOpenCodeCtTool(n), n).toBe(true);
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

  it('an MCP-shaped result never carries a block (only builtin tools are planned; 0.4.1)', async () => {
    const sim = makeSim({ answer: () => [fact('f-m')] });
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' }, mcp: true, text: 'one' }]);
    expect(out).toBe('one');
    expect(sim.activityCalls()).toEqual([]);
    expect(canCarry({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(canCarry({ title: '', output: '', metadata: {} })).toBe(true);
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
    const sim = makeSim({ answer: () => answers[n++]!, budgetMs: 300 });
    const o1 = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    await tick(); // the killed child exits; the in-flight marker is released then
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


describe('review of PR #66', () => {
  it('1 unpersisted: an aborted step (part persisted without the block) frees the fact', async () => {
    const sim = makeSim({ answer: () => [fact('X')] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' }, persist: 'abort' }]);
    expect(sim.queries()).toEqual(['pnpm test']);
    const [out] = await sim.step('P', [{ tool: 'read', args: { filePath: 'src/a.ts' } }]);
    expect(out).toContain('<!-- ct-fact:X -->');
  });

  it('1 unpersisted: /undo of the step frees the fact', async () => {
    const sim = makeSim({ answer: () => [fact('X')] });
    const [first] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(first).toContain('<!-- ct-fact:X -->');
    sim.undo('P', sim.lastMessageID('P'));
    const [out] = await sim.step('P', [{ tool: 'read', args: { filePath: 'src/a.ts' } }]);
    expect(out).toContain('<!-- ct-fact:X -->');
  });

  it('1 unpersisted: a part never persisted expires after 60 s', async () => {
    let clock = 1_000_000;
    const sim = makeSim({ answer: () => [fact('X')], now: () => clock });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' }, persist: 'none' }]);
    const [soon] = await sim.step('P', [{ tool: 'read', args: { filePath: 'src/a.ts' } }]);
    expect(soon).not.toContain('ct-fact:X'); // still running: kept
    clock += 61_000;
    const [later] = await sim.step('P', [{ tool: 'read', args: { filePath: 'src/b.ts' } }]);
    expect(later).toContain('<!-- ct-fact:X -->');
  });

  it('1 unpersisted: a recall step that is undone frees its ids too', async () => {
    const recall = JSON.stringify({ query: 'q', wiki_entries: [{ id: 'X', title: 'X', text: 'x' }] });
    const sim = makeSim({ answer: () => [fact('X')] });
    await sim.step('P', [{ tool: 'curated-thoughts_curated_recall_context', args: { query: 'q' }, mcp: true, text: recall }]);
    sim.undo('P', sim.lastMessageID('P'));
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(out).toContain('<!-- ct-fact:X -->');
  });

  it('2 one deadline covers the fetches: a hung session.messages fails open', async () => {
    const sim = makeSim({ answer: () => [fact('X')], hangHistory: true, budgetMs: 100 });
    const t0 = Date.now();
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' }, text: 'same' }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out).toBe('same');
    expect(sim.activityCalls()).toEqual([]);
  });

  it('3 budget expiry kills the ct child; the step stays used, the key retries in a later step', async () => {
    let n = 0;
    const sim = makeSim({ answer: () => (n++ === 0 ? 'hang' : [fact('ok')]), budgetMs: 300, sequential: true });
    const outs = await sim.step('P', [
      { tool: 'bash', args: { command: 'pnpm test' } },
      { tool: 'read', args: { filePath: 'src/a.ts' } }, // same step, after the failure: no second query
    ]);
    await tick();
    expect(sim.killed).toEqual(['pnpm test']);
    expect(sim.queries()).toEqual(['pnpm test']);
    expect(outs.every((o) => blocksIn(o) === 0)).toBe(true);
    const [retry] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.queries()).toEqual(['pnpm test', 'pnpm test']);
    expect(retry).toContain('<!-- ct-fact:ok -->');
  });

  it('3 the in-flight marker stays until the killed child exits', async () => {
    let n = 0;
    const sim = makeSim({ answer: () => (n++ === 0 ? 'hang' : []), budgetMs: 260, killDelayMs: 300 });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    await sim.step('P', [{ tool: 'read', args: { filePath: 'src/a.ts' } }]); // child still exiting
    expect(sim.queries()).toEqual(['pnpm test']);
    await new Promise((r) => setTimeout(r, 400));
    await sim.step('P', [{ tool: 'read', args: { filePath: 'src/a.ts' } }]);
    expect(sim.queries()).toEqual(['pnpm test', 'src/a.ts']);
  });

  it('4 one history fetch per triggering call', async () => {
    const sim = makeSim({ answer: () => [fact('X')] });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.historyFetches()).toBe(1);
  });

  it('8 the activity host delegates to the adapter: a capability latch set through it is the adapter\'s', async () => {
    const adapter = new OpenCodeWisdomAdapter({
      env: {},
      discover: () => ({ path: '/bin/ct', failure: null }),
      spawnFn: async () => ({ code: 2, stdout: '', stderr: '', spawnError: false, timedOut: false }),
    });
    const host = activityHost(adapter);
    // 0.4.1: an explicit delegating object, no inheritance from the adapter.
    expect(Object.getPrototypeOf(host)).toBe(Object.prototype);
    await host.wisdomMatch('q', 1, []);
    expect(adapter.wisdomMatchAbsent()).toBe(true);
    expect(host.wisdomMatchAbsent()).toBe(true);
    expect(host.restored({ id: 's' })).toBe(false);
    expect(host.deliveryEnabled({ id: 'unknown' })).toBe(false);
  });
});


describe('0.4.1 polish (post-merge review of 0.4.0)', () => {
  it('1 too little budget left before the start: no spawn, and the key and step are not admitted', async () => {
    const history = { delayMs: 260 };
    const sim = makeSim({ answer: () => [fact('X')], budgetMs: 400, history });
    const [out] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.activityCalls()).toEqual([]);
    expect(blocksIn(out!)).toBe(0);
    history.delayMs = 0;
    const [again] = await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.queries()).toEqual(['pnpm test']);
    expect(again).toContain('<!-- ct-fact:X -->');
  });

  it('2 an open breaker skips the history fetch', async () => {
    const sim = makeSim({ answer: () => 'timeout' });
    for (const command of ['a1', 'a2', 'a3']) await sim.step('P', [{ tool: 'bash', args: { command } }]);
    expect(sim.activityCalls().length).toBe(3);
    const before = sim.historyFetches();
    await sim.step('P', [{ tool: 'bash', args: { command: 'a4' } }]);
    expect(sim.historyFetches()).toBe(before);
    expect(sim.activityCalls().length).toBe(3);
  });

  it('2 a latched-off capability skips the history fetch', async () => {
    const sim = makeSim({ answer: () => [fact('X')], helpExit: 2 });
    await sim.step('P', [{ tool: 'bash', args: { command: 'pnpm test' } }]); // probe latches off
    const before = sim.historyFetches();
    await sim.step('P', [{ tool: 'read', args: { filePath: 'src/a.ts' } }]);
    expect(sim.historyFetches()).toBe(before);
  });

  it('2 an unknown session kind skips the history fetch', async () => {
    const sim = makeSim({ sessions: {}, answer: () => [fact('X')] });
    await sim.step('X', [{ tool: 'bash', args: { command: 'pnpm test' } }]);
    expect(sim.historyFetches()).toBe(0);
  });

  it('3 a failing session.get is cached briefly: one lookup for many tool calls', async () => {
    const sim = makeSim({ sessionThrows: true, answer: () => [fact('X')] });
    for (const command of ['a', 'b', 'c', 'd']) await sim.step('P', [{ tool: 'bash', args: { command } }]);
    expect(sim.sessionFetches()).toBe(1);
  });

  it('3 the plan-time lookup waits ~300 ms at most', async () => {
    const sim = makeSim({ sessionHangs: true, answer: () => [fact('X')] });
    const t0 = Date.now();
    await sim.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'P', callID: 'c1' }, { args: { command: 'pnpm test' } });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('9 an abort from elsewhere (not our budget) never counts against the breaker', async () => {
    const sim = makeSim({ answer: () => 'aborted' });
    for (const command of ['a1', 'a2', 'a3', 'a4']) await sim.step('P', [{ tool: 'bash', args: { command } }]);
    expect(sim.activityCalls().length).toBe(4);
  });

  it('3 deliver reuses the plan-time lookup (one session.get per session)', async () => {
    const sim = makeSim({ answer: () => [] });
    for (const command of ['a', 'b', 'c']) await sim.step('P', [{ tool: 'bash', args: { command } }]);
    expect(sim.sessionFetches()).toBe(1);
  });
});

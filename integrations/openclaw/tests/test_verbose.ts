/**
 * Verbose mode on OpenClaw (spec 2026-10-16-wisdom-verbose-mode-design.md):
 * the user-only channel is the plugin logger (`api.logger.info`, the gateway
 * log), the record goes to $OPENCLAW_STATE_DIR/logs. The before_prompt_build
 * result (prependContext / prependSystemContext) is byte-identical on or off.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FakeCt, boot, userCtx } from './fake_host.js';

const SECRET = 'sk-ocl-SECRET-never-logged-8888';
const FACTS = [
  { id: 'w1', title: 'Release flow', text: 'Tag after merge.' },
  { id: 'w2', title: 'Lockfiles', text: 'Use pnpm 9.15.9.' },
];

async function session(env: Record<string, string>, onInfo?: (m: string) => void) {
  const ct = new FakeCt();
  ct.pool = () => FACTS;
  const api = boot(ct, { env });
  if (onInfo) api.logger.info = onInfo as never;
  const build = api.hook('before_prompt_build');
  const first = await build(
    { prompt: 'p', currentUserMessage: 'how do releases work', currentUserMessageId: 'm1', messages: [] },
    userCtx({ runId: 'r1' }),
  );
  // The second turn's snapshot already carries both facts: nothing new.
  const persisted = [{ role: 'user', content: `how do releases work\n${(first as { prependContext?: string })?.prependContext ?? ''}` }];
  const second = await build(
    { prompt: 'p', currentUserMessage: 'and again', currentUserMessageId: 'm2', messages: persisted },
    userCtx({ runId: 'r2' }),
  );
  return [first, second];
}

describe('OpenClaw verbose mode', () => {
  it('off: identical results, logger.info never called, no log file', async () => {
    const state = mkdtempSync(join(tmpdir(), 'ocl-'));
    const infos: string[] = [];
    const off = await session({ CT_WISDOM_VERBOSE: '0', OPENCLAW_STATE_DIR: state }, (m) => infos.push(m));
    const bare = await session({});
    expect(off).toEqual(bare);
    expect(infos).toEqual([]);
    expect(existsSync(join(state, 'logs', 'ct-wisdom-verbose.jsonl'))).toBe(false);
  });

  it('on: identical results, one info line and one record per turn', async () => {
    const state = mkdtempSync(join(tmpdir(), 'ocl-'));
    const infos: string[] = [];
    const bare = await session({});
    const on = await session({ CT_WISDOM_VERBOSE: '1', OPENCLAW_STATE_DIR: state, ANTHROPIC_API_KEY: SECRET }, (m) => infos.push(m));
    expect(on).toEqual(bare);
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatch(/^curated-thoughts: Curated Thoughts wisdom: delivered 2 facts/);
    expect(infos[1]).toContain('nothing delivered (no_match)');
    const raw = readFileSync(join(state, 'logs', 'ct-wisdom-verbose.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.host, l.channel, l.session_id, l.event])).toEqual([
      ['openclaw', 'before_prompt_build', 'agent:main:main', 'delivery'],
      ['openclaw', 'before_prompt_build', 'agent:main:main', 'skip'],
    ]);
    expect(raw).not.toContain(SECRET);
    expect(infos.join('')).not.toContain(SECRET);
  });

  it('a throwing logger never changes the result', async () => {
    const bare = await session({});
    // A regular file as the log's parent directory: unwritable on every OS.
    const dir = mkdtempSync(join(tmpdir(), 'ocl-'));
    writeFileSync(join(dir, 'file'), 'x');
    const failing = await session({ CT_WISDOM_VERBOSE: '1', CT_WISDOM_VERBOSE_LOG: join(dir, 'file', 'x.jsonl') }, () => {
      throw new Error('logger down');
    });
    expect(failing).toEqual(bare);
  });
});

describe('OpenClaw verbose mode: activity channel', () => {
  async function activitySession(env: Record<string, string>, onInfo?: (m: string) => void) {
    const project = mkdtempSync(join(tmpdir(), 'ocl-vact-'));
    mkdirSync(join(project, '.git'));
    const ct = new FakeCt();
    ct.poolFor = (q, max) => (max === 1 && q === 'a.ts' ? [{ id: 'wa', title: 'A rule', text: 'About a.ts.' }] : []);
    const api = boot(ct, { env });
    if (onInfo) api.logger.info = onInfo as never;
    await api.hook('before_prompt_build')({ prompt: 'p', messages: [] }, userCtx({ runId: 'r1', trigger: 'cron' }));
    const outs: unknown[] = [];
    for (const [n, path] of [[1, 'a.ts'], [2, 'b.ts'], [3, 'a.ts']] as const) {
      api.hook('model_call_started')({ runId: 'r1', callId: `r1:model:${n}` }, { runId: 'r1', sessionKey: 'agent:main:main' });
      outs.push(await api.middleware[0].handler(
        { toolCallId: `t${n}`, toolName: 'read', args: { path }, cwd: project, isError: false, result: { content: [{ type: 'text', text: 'body' }] } },
        { runtime: 'openclaw', sessionKey: 'agent:main:main', runId: 'r1' },
      ));
    }
    return outs;
  }

  it('off: tool results byte-identical, nothing logged', async () => {
    const state = mkdtempSync(join(tmpdir(), 'ocl-'));
    const infos: string[] = [];
    const off = await activitySession({ CT_WISDOM_VERBOSE: '0', OPENCLAW_STATE_DIR: state }, (m) => infos.push(m));
    expect(JSON.stringify(off)).toBe(JSON.stringify(await activitySession({})));
    expect(JSON.stringify(off)).toContain('ct-fact:wa');
    expect(infos).toEqual([]);
    expect(existsSync(join(state, 'logs', 'ct-wisdom-verbose.jsonl'))).toBe(false);
  });

  it('on: identical results; one `activity` record per query outcome, none for rate skips', async () => {
    const state = mkdtempSync(join(tmpdir(), 'ocl-'));
    const infos: string[] = [];
    const on = await activitySession({ CT_WISDOM_VERBOSE: '1', OPENCLAW_STATE_DIR: state, ANTHROPIC_API_KEY: SECRET }, (m) => infos.push(m));
    expect(JSON.stringify(on)).toBe(JSON.stringify(await activitySession({})));
    const lines = readFileSync(join(state, 'logs', 'ct-wisdom-verbose.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    // a.ts delivered, b.ts no_match; the repeated a.ts is a rate skip (not recorded)
    expect(lines.map((l) => [l.channel, l.event, l.query, l.activity])).toEqual([
      ['activity', 'delivery', 'a.ts', 'read a.ts'],
      ['activity', 'skip', 'b.ts', 'read b.ts'],
    ]);
    expect(infos[0]).toMatch(/delivered 1 fact[\s\S]*\[activity\]/);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });
});

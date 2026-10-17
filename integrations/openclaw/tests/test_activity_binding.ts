/**
 * The OpenClaw tool → activity binding (spec 2026-10-17 "Tools and
 * arguments at the pin") and the executed-call trigger (decision 8: a query
 * starts only for a call the host actually ran).
 */
import { describe, expect, it } from 'vitest';

import { executedResult, openclawActivitySpec } from '../src/wisdom/activity.js';

describe('openclawActivitySpec (pin 2026.10.3 tool names and args)', () => {
  it('file tools read `path`, falling back to `file_path`, and never content', () => {
    expect(openclawActivitySpec('read', { path: 'src/a.ts', offset: 3, limit: 9 })).toEqual({ verb: 'read', path: 'src/a.ts' });
    expect(openclawActivitySpec('write', { path: 'a.md', content: 'SECRET' })).toEqual({ verb: 'write', path: 'a.md' });
    expect(openclawActivitySpec('edit', { path: 'a.md', edits: [{ oldText: 'SECRET', newText: 'x' }] })).toEqual({ verb: 'edit', path: 'a.md' });
    expect(openclawActivitySpec('read', { file_path: 'b.ts' })).toEqual({ verb: 'read', path: 'b.ts' });
    expect(openclawActivitySpec('read', { path: 'a', file_path: 'b' })).toEqual({ verb: 'read', path: 'a' });
    expect(JSON.stringify(openclawActivitySpec('write', { path: 'a.md', content: 'SECRET' }))).not.toContain('SECRET');
  });

  it('grep and find are searches (pattern + path; never glob or flags)', () => {
    expect(openclawActivitySpec('grep', { pattern: 'invoice', path: 'src', glob: '*.ts', ignoreCase: true }))
      .toEqual({ verb: 'search', pattern: 'invoice', path: 'src' });
    expect(openclawActivitySpec('find', { pattern: '**/*.ts' })).toEqual({ verb: 'search', pattern: '**/*.ts', path: undefined });
  });

  it('exec and bash run the command only (never workdir, env, ask)', () => {
    expect(openclawActivitySpec('exec', { command: 'pnpm test', workdir: '/secret', env: { TOKEN: 'x' }, ask: 'always' }))
      .toEqual({ verb: 'run', command: 'pnpm test' });
    expect(openclawActivitySpec('bash', { command: 'git status', timeout: 3 })).toEqual({ verb: 'run', command: 'git status' });
  });

  it('every other tool gives no activity', () => {
    for (const name of ['ls', 'apply_patch', 'process', 'web_fetch', 'sessions_spawn', 'message',
      'curated-thoughts__curated_recall_context', 'x__read', 'Read', '', 'constructor', 'toString']) {
      expect(openclawActivitySpec(name, { path: 'a', command: 'ls', pattern: 'p', input: '*** Begin Patch' }), name).toBeNull();
    }
    expect(openclawActivitySpec(undefined, { path: 'a' })).toBeNull();
    expect(openclawActivitySpec('read', null)).toBeNull();
    expect(openclawActivitySpec('read', ['a'])).toBeNull();
    expect(openclawActivitySpec('read', 'a')).toBeNull();
  });
});

describe('executedResult (decision 8: only a call the host ran)', () => {
  const r = (details: unknown, isError?: boolean) => ({ isError, result: { content: [{ type: 'text', text: 'x' }], details } });

  it('a successful result counts', () => {
    expect(executedResult(r(undefined))).toBe(true);
    expect(executedResult(r({ status: 'completed', exitCode: 0 }, false))).toBe(true);
  });

  it('exec approval-pending / approval-unavailable results never count (the command has not run)', () => {
    expect(executedResult(r({ status: 'approval-pending', approvalId: 'a1' }))).toBe(false);
    expect(executedResult(r({ status: 'approval-unavailable' }, true))).toBe(false);
  });

  it('denied, blocked or cancelled results never count', () => {
    for (const status of ['denied', 'blocked', 'cancelled', 'canceled', 'aborted']) {
      expect(executedResult(r({ status }, true)), status).toBe(false);
      expect(executedResult(r({ status }, false)), status).toBe(false);
    }
    // the gateway's denied exec: status failed, exitCode null
    expect(executedResult(r({ status: 'failed', exitCode: null, durationMs: 0 }, true))).toBe(false);
  });

  it('an error counts only when the command ran and exited (a finite exit code)', () => {
    expect(executedResult(r({ status: 'completed', exitCode: 1 }, true))).toBe(true);
    expect(executedResult(r({ status: 'failed', exitCode: 2 }, true))).toBe(true);
    expect(executedResult(r({ status: 'error' }, true))).toBe(false);
    expect(executedResult(r(undefined, true))).toBe(false);
    expect(executedResult(r({ exitCode: Number.NaN }, true))).toBe(false);
  });

  it('junk never throws', () => {
    expect(executedResult(null)).toBe(false);
    expect(executedResult({})).toBe(true);
    expect(executedResult({ result: null })).toBe(true);
    expect(executedResult({ result: { details: 'x' } })).toBe(true);
  });
});

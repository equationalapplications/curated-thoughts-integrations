/**
 * Verbose mode on DeepSeek Harness (spec 2026-10-16-wisdom-verbose-mode-design.md):
 * the user-only channel is the plugin's cordis logger, the log lives under
 * $DSH_HOME/logs. Verbose on or off, the delivered block (the pre-step user
 * message's bytes) is identical.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Breaker, VERBOSE_LOG_NAME, type SpawnFn, type VerboseTurn } from '@equational-applications/ct-wisdom-core';
import { DshWisdomAdapter, runUserTurn } from '../src/wisdom-live/adapter.js';
import { dshVerboseRecorder, namedLogger } from '../src/verbose.js';

const SECRET = 'sk-dsh-SECRET-never-logged-7777';

function ctSpawn(stdout: string): SpawnFn {
  return (spec) =>
    Promise.resolve({
      code: 0,
      stdout: spec.args[2] === '--help' ? '' : stdout,
      stderr: '',
      spawnError: false,
      timedOut: false,
    });
}

const MATCHES = [
  '{"gate":"semantic-v1:m","entries":[{"id":"e1","title":"Deploy","text":"use make deploy","score":0.74,"provenance":"user_stated"}],"corrections":[]}',
  '{"gate":"uncalibrated","entries":[],"corrections":[]}',
];

async function turn(stdout: string, recordVerbose?: (t: VerboseTurn) => void) {
  const a = new DshWisdomAdapter({
    env: {},
    discover: () => ({ path: '/bin/ct', failure: null }),
    spawnFn: ctSpawn(stdout),
    recordVerbose,
  });
  a.sessionMessages.set('agent-1', [{ role: 'user', content: [{ type: 'text', text: 'boot <!-- ct-fact:b1 -->' }] }]);
  return runUserTurn(a, { id: 'agent-1' }, 'how do I deploy?', new Breaker());
}

describe('DSH verbose mode', () => {
  it('off: no recorder at all (the adapter is exactly the pre-verbose adapter)', () => {
    expect(dshVerboseRecorder({}, {})).toBeUndefined();
    expect(dshVerboseRecorder({}, { CT_WISDOM_VERBOSE: '0' })).toBeUndefined();
    const a = new DshWisdomAdapter({ env: {} });
    expect('recordVerbose' in a).toBe(false);
  });

  it('on: same delivered bytes, one JSONL record per turn, logger notified', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-'));
    const infos: string[] = [];
    const ctx = { logger: (name: string) => ({ info: (m: string) => infos.push(`${name}|${m}`) }) };
    const rec = dshVerboseRecorder(ctx, { CT_WISDOM_VERBOSE: '1', DSH_HOME: home, DEEPSEEK_API_KEY: SECRET });
    expect(rec).toBeDefined();
    for (const stdout of MATCHES) {
      expect(await turn(stdout, rec)).toEqual(await turn(stdout));
    }
    const path = join(home, 'logs', VERBOSE_LOG_NAME);
    const raw = readFileSync(path, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.host, l.channel, l.event, l.reason])).toEqual([
      ['deepseek', 'agent/pre-step', 'delivery', null],
      ['deepseek', 'agent/pre-step', 'skip', 'gate_uncalibrated'],
    ]);
    expect(lines[0].matched[0]).toMatchObject({ id: 'e1', score: 0.74, outcome: 'delivered' });
    expect(lines[0].block).toBe(await turn(MATCHES[0]));
    expect(infos[0]).toMatch(/^curated-thoughts\|Curated Thoughts wisdom: delivered 1 fact/);
    expect(raw).not.toContain(SECRET);
    expect(infos.join('')).not.toContain(SECRET);
  });

  it('a throwing logger and an unwritable log never change the block', async () => {
    const ctx = {
      logger: () => {
        throw new Error('logger down');
      },
    };
    // A regular file used as the log's parent directory: unwritable on every OS.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-'));
    writeFileSync(join(dir, 'file'), 'x');
    const log = join(dir, 'file', 'nope.jsonl');
    const rec = dshVerboseRecorder(ctx, { CT_WISDOM_VERBOSE: '1', CT_WISDOM_VERBOSE_LOG: log });
    expect(await turn(MATCHES[0], rec)).toEqual(await turn(MATCHES[0]));
    expect(existsSync(log)).toBe(false);
  });
});

describe('namedLogger (resolved once)', () => {
  it('looks the named logger up once, lazily, for info and debug', () => {
    let lookups = 0;
    const lines: string[] = [];
    const ctx = {
      logger: (name: string) => {
        lookups++;
        return { info: (m: string) => lines.push(`info ${name} ${m}`), debug: (m: string) => lines.push(`debug ${name} ${m}`) };
      },
    };
    const log = namedLogger(ctx);
    expect(lookups).toBe(0);
    log.info('a');
    log.debug('b');
    log.debug('c');
    expect(lookups).toBe(1);
    expect(lines).toEqual(['info curated-thoughts a', 'debug curated-thoughts b', 'debug curated-thoughts c']);
  });

  it('a failed lookup is not cached: the next call retries (review of PR #56)', () => {
    let up = false;
    let lookups = 0;
    const lines: string[] = [];
    const ctx = {
      logger: () => {
        lookups++;
        if (!up) throw new Error('not ready');
        return { debug: (m: string) => lines.push(m) };
      },
    };
    const log = namedLogger(ctx);
    log.debug('lost');
    up = true;
    log.debug('a');
    log.debug('b');
    expect(lines).toEqual(['a', 'b']);
    expect(lookups).toBe(2); // one failure, then one success, cached
  });

  it('a missing or throwing factory is a quiet no-op', () => {
    expect(() => namedLogger({}).info('x')).not.toThrow();
    expect(() => namedLogger({ logger: () => { throw new Error('down'); } }).debug('x')).not.toThrow();
    expect(() => namedLogger(null).debug('x')).not.toThrow();
  });
});

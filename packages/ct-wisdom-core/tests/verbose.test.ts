/**
 * Verbose mode (spec 2026-10-16-wisdom-verbose-mode-design.md): the engine
 * reports every exit of onUserTurn to an optional host recorder, and the
 * recorder writes JSON Lines + a user-only notice. Without a recorder, or with
 * a throwing one, onUserTurn behaves exactly as before.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Breaker } from '../src/breaker.js';
import { onUserTurn } from '../src/engine.js';
import { marker } from '../src/ledger.js';
import { parseMatchStdout } from '../src/match.js';
import type {
  HostAdapter,
  Ledger,
  MatchOutcome,
  SessionRef,
  WisdomMatchResult,
} from '../src/types.js';
import {
  VERBOSE_LOG_NAME,
  buildRecord,
  createVerboseRecorder,
  defaultVerboseLogPath,
  formatLogLine,
  formatNotice,
  verboseEnabled,
  type VerboseRecord,
  type VerboseTurn,
} from '../src/verbose.js';
import { Follower, main as readerMain } from '../src/cli/ct-wisdom-log.js';

const SECRET = 'sk-ts-SECRET-never-logged-4242';

function fact(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `T${id}`, text: `body ${id}`, score: 0.8, provenance: 'user_stated', ...extra };
}

class Host implements HostAdapter {
  contextIds: string[] = [];
  knownBootstrap = true;
  restoredSession = false;
  enabled = true;
  probeAbsent = false;
  response: { outcome: MatchOutcome; result?: WisdomMatchResult } = {
    outcome: 'ok',
    result: { entries: [], corrections: [] },
  };
  delivered: string[] = [];
  recordVerbose?: (turn: VerboseTurn) => void;

  deliveryEnabled(): boolean {
    return this.enabled;
  }
  restored(): boolean {
    return this.restoredSession;
  }
  rebuildLedger(): Ledger {
    const ids = [...this.contextIds];
    return { idsMostRecentFirst: ids, has: (id) => ids.includes(id), knownBootstrap: this.knownBootstrap };
  }
  cacheLedger(): void {}
  async wisdomMatch() {
    return this.response;
  }
  isCtRecallResult(): boolean {
    return false;
  }
  envelopeFactIds(): string[] {
    return [];
  }
  rewriteEnvelopeStub(r: unknown): unknown {
    return r;
  }
  resetDiscoveryAndProbeCaches(): void {}
  wisdomMatchAbsent(): boolean {
    return this.probeAbsent;
  }
  deliver(_s: SessionRef, block: string): void {
    this.delivered.push(block);
  }
  noteDelivered(_s: SessionRef, ids: string[]): void {
    for (const id of ids) if (!this.contextIds.includes(id)) this.contextIds.unshift(id);
  }
}

type Scenario = [string, (h: Host) => void, string];

const SCENARIOS: Scenario[] = [
  ['delivery', (h) => {
    h.response = { outcome: 'ok', result: { gate: 'semantic-v1:m', entries: [fact('e1'), fact('e2')], corrections: [] } };
  }, 'how do I deploy?'],
  ['deduped', (h) => {
    h.contextIds = ['b1'];
    h.response = { outcome: 'ok', result: { entries: [fact('b1')], corrections: [] } };
  }, 'q'],
  ['no_match', (h) => {
    h.response = { outcome: 'ok', result: { gate: 'semantic-v1:m', entries: [], corrections: [] } };
  }, 'q'],
  ['gate_uncalibrated', (h) => {
    h.response = { outcome: 'ok', result: { gate: 'uncalibrated', entries: [], corrections: [] } };
  }, 'q'],
  ['budget', (h) => {
    h.response = { outcome: 'ok', result: { entries: [fact('e9', { title: '', text: '' })], corrections: [] } };
  }, 'q'],
  ['timeout_or_exit', (h) => {
    h.response = { outcome: 'timeout_or_exit' };
  }, 'q'],
  ['spawn', (h) => {
    h.response = { outcome: 'spawn' };
  }, 'q'],
  ['empty_query', () => {}, '   '],
  ['delivery_off', (h) => {
    h.enabled = false;
  }, 'q'],
  ['restored_unknown_bootstrap', (h) => {
    h.restoredSession = true;
    h.knownBootstrap = false;
  }, 'q'],
  ['capability_missing', (h) => {
    h.probeAbsent = true;
  }, 'q'],
];

async function runAll(recorder?: (turn: VerboseTurn) => void) {
  const outs: Array<[string, string | null, string[]]> = [];
  for (const [name, setup, query] of SCENARIOS) {
    const host = new Host();
    setup(host);
    if (recorder) host.recordVerbose = recorder;
    const out = await onUserTurn(host, { id: 's1' }, query, new Breaker());
    outs.push([name, out, host.delivered]);
  }
  return outs;
}

describe('verboseEnabled', () => {
  it('accepts 1/true/yes/on only', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(verboseEnabled({ CT_WISDOM_VERBOSE: v })).toBe(true);
    }
    for (const v of ['', '0', 'false', 'no', 'off', '2x', undefined]) {
      expect(verboseEnabled({ CT_WISDOM_VERBOSE: v })).toBe(false);
    }
  });
});

describe('engine reporting', () => {
  it('reports every exit with the right reason and identical results', async () => {
    const turns: VerboseTurn[] = [];
    const bare = await runAll();
    const recorded = await runAll((t) => turns.push(t));
    expect(recorded).toEqual(bare);
    const reasons = turns.map((t) => buildRecord(t, { host: 'deepseek', channel: 'x' }).reason);
    expect(reasons).toEqual([
      null, 'deduped', 'no_match', 'gate_uncalibrated', 'budget',
      'timeout_or_exit', 'spawn', 'empty_query', 'delivery_off',
      'restored_unknown_bootstrap', 'capability_missing',
    ]);
    expect(turns[0].kind).toBe('delivery');
    expect(turns[0].block).toBe(bare[0][1]);
    expect(turns[0].query).toBe('how do I deploy?');
    expect(turns[0].deliveredIds).toEqual(['e1', 'e2']);
  });

  it('a throwing recorder never changes the result', async () => {
    const bare = await runAll();
    const failing = await runAll(() => {
      throw new Error('recorder down');
    });
    expect(failing).toEqual(bare);
  });

  it('no session id still reports, then returns null', async () => {
    const turns: VerboseTurn[] = [];
    const host = new Host();
    host.recordVerbose = (t) => turns.push(t);
    expect(await onUserTurn(host, { id: '' }, 'q')).toBeNull();
    expect(turns.map((t) => t.reason)).toEqual(['no_session']);
  });
});

describe('buildRecord', () => {
  it('classifies outcomes and keeps scores, gate and the block', () => {
    const rec = buildRecord(
      {
        kind: 'delivery',
        sessionId: 's1',
        reason: null,
        query: 'q',
        result: {
          gate: 'semantic-v1:m',
          entries: [fact('e1'), fact('e2'), fact('e3')],
          corrections: [{ id: 'c1', title: 'C', text: 'x', supersedes: ['zz'], score: null }],
        },
        ledgerIds: ['e2'],
        deliveredIds: ['e1'],
        block: `**Te1** ${marker('e1')}\nbody e1`,
      },
      { host: 'opencode', channel: 'chat.message', now: () => new Date('2026-10-16T12:00:00.000Z') },
    );
    expect(rec.ts).toBe('2026-10-16T12:00:00.000Z');
    expect(rec.v).toBe(1);
    expect(rec.gate).toBe('semantic-v1:m');
    expect(rec.ledger_size).toBe(1);
    expect(rec.block_chars).toBe(rec.block!.length);
    expect(rec.matched!.map((m) => [m.id, m.kind, m.outcome, m.score])).toEqual([
      ['e1', 'entry', 'delivered', 0.8],
      ['e2', 'entry', 'in_context', 0.8],
      ['e3', 'entry', 'budget', 0.8],
      ['c1', 'correction', 'budget', null],
    ]);
  });

  it('an activity turn overrides the channel and carries its label (Python field order)', () => {
    const rec = buildRecord(
      { kind: 'skip', sessionId: 's1', reason: 'zero_hits', query: 'src/x.ts', activity: 'read src/x.ts',
        channel: 'activity', result: { entries: [], corrections: [] }, ledgerIds: [] },
      { host: 'deepseek', channel: 'agent/pre-step', now: () => new Date('2026-10-16T12:00:00.000Z') },
    );
    expect(rec.channel).toBe('activity');
    expect(rec.activity).toBe('read src/x.ts');
    expect(rec.reason).toBe('no_match');
    expect(Object.keys(rec)).toEqual(['v', 'ts', 'host', 'channel', 'session_id', 'event', 'reason',
      'query', 'activity', 'gate', 'matched', 'ledger_size']);
    expect(formatNotice(rec)).toContain('[activity]');
  });

  it('a user-turn record is unchanged: no activity key, the recorder channel', () => {
    const rec = buildRecord(
      { kind: 'skip', sessionId: 's1', reason: 'empty_query' },
      { host: 'opencode', channel: 'chat.message', now: () => new Date('2026-10-16T12:00:00.000Z') },
    );
    expect(rec).toEqual({ v: 1, ts: '2026-10-16T12:00:00.000Z', host: 'opencode', channel: 'chat.message',
      session_id: 's1', event: 'skip', reason: 'empty_query' });
  });
});

describe('createVerboseRecorder', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'ctv-'));
  const turn: VerboseTurn = {
    kind: 'delivery', sessionId: 's1', reason: null, query: 'q',
    result: { entries: [fact('e1')], corrections: [] }, ledgerIds: [], deliveredIds: ['e1'],
    block: '## h\n\n**Te1**',
  };

  it('is undefined when off', () => {
    expect(createVerboseRecorder({ host: 'deepseek', channel: 'x', env: {}, logPath: '/nope' })).toBeUndefined();
  });

  it('writes JSONL (private), notifies, and never logs env', () => {
    const d = dir();
    const path = join(d, 'sub', VERBOSE_LOG_NAME);
    const notices: string[] = [];
    const rec = createVerboseRecorder({
      host: 'deepseek', channel: 'agent/pre-step',
      env: { CT_WISDOM_VERBOSE: '1', DEEPSEEK_API_KEY: SECRET },
      logPath: path, notify: (t) => notices.push(t),
    })!;
    rec(turn);
    rec({ kind: 'skip', sessionId: 's1', reason: 'breaker_open' });
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as VerboseRecord);
    expect(lines.map((l) => [l.host, l.channel, l.event, l.reason])).toEqual([
      ['deepseek', 'agent/pre-step', 'delivery', null],
      ['deepseek', 'agent/pre-step', 'skip', 'breaker_open'],
    ]);
    expect(notices[0]).toContain('Curated Thoughts wisdom: delivered 1 fact');
    expect(notices[0]).toContain('**Te1**');
    expect(readFileSync(path, 'utf8')).not.toContain(SECRET);
    expect(notices.join('')).not.toContain(SECRET);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('the env override wins over the host default', () => {
    const d = dir();
    const override = join(d, 'o.jsonl');
    const rec = createVerboseRecorder({
      host: 'openclaw', channel: 'x',
      env: { CT_WISDOM_VERBOSE: '1', CT_WISDOM_VERBOSE_LOG: override }, logPath: join(d, 'default.jsonl'),
    })!;
    rec(turn);
    expect(existsSync(override)).toBe(true);
    expect(existsSync(join(d, 'default.jsonl'))).toBe(false);
  });

  it('swallows a throwing notify and an unwritable log', () => {
    const d = dir();
    writeFileSync(join(d, 'file'), 'x');
    const rec = createVerboseRecorder({
      host: 'opencode', channel: 'x', env: { CT_WISDOM_VERBOSE: '1' },
      logPath: join(d, 'file', 'v.jsonl'),
      notify: () => {
        throw new Error('toast down');
      },
    })!;
    expect(() => rec(turn)).not.toThrow();
    expect(() => rec(null as unknown as VerboseTurn)).not.toThrow();
  });

  it('rotates past the size cap', () => {
    const d = dir();
    const path = join(d, 'v.jsonl');
    writeFileSync(path, 'x'.repeat(64));
    const rec = createVerboseRecorder({
      host: 'opencode', channel: 'x', env: { CT_WISDOM_VERBOSE: '1' }, logPath: path, maxBytes: 32,
    })!;
    rec(turn);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('defaultVerboseLogPath', () => {
  it('follows each host convention', () => {
    expect(defaultVerboseLogPath('deepseek', { DSH_HOME: '/d' })).toBe(join('/d', 'logs', VERBOSE_LOG_NAME));
    expect(defaultVerboseLogPath('deepseek', { DSH_HOME: '  ' }, '/h')).toBe(join('/h', '.dsh', 'logs', VERBOSE_LOG_NAME));
    expect(defaultVerboseLogPath('opencode', { XDG_DATA_HOME: '/x' })).toBe(join('/x', 'opencode', 'log', VERBOSE_LOG_NAME));
    expect(defaultVerboseLogPath('opencode', {}, '/h')).toBe(join('/h', '.local', 'share', 'opencode', 'log', VERBOSE_LOG_NAME));
    expect(defaultVerboseLogPath('openclaw', { OPENCLAW_STATE_DIR: '/s' })).toBe(join('/s', 'logs', VERBOSE_LOG_NAME));
    expect(defaultVerboseLogPath('openclaw', {}, '/h')).toBe(join('/h', '.openclaw', 'logs', VERBOSE_LOG_NAME));
  });
});

describe('gate parsing', () => {
  it('keeps CT gate when present and omits it otherwise', () => {
    expect(parseMatchStdout('{"schema":1,"gate":"uncalibrated","entries":[],"corrections":[]}')!.gate).toBe('uncalibrated');
    expect(parseMatchStdout('{"entries":[],"corrections":[]}')).toEqual({ entries: [], corrections: [] });
  });
});

describe('formatting and the reader', () => {
  const rec = buildRecord(
    {
      kind: 'delivery', sessionId: 's1', reason: null, query: 'how do I deploy?',
      result: { gate: 'g', entries: [fact('e1'), fact('e2')], corrections: [] },
      ledgerIds: ['e2'], deliveredIds: ['e1'], block: '## h\n\n**Te1**',
    },
    { host: 'opencode', channel: 'chat.message', now: () => new Date('2026-10-16T12:00:00.000Z') },
  );

  it('formatNotice and formatLogLine', () => {
    expect(formatNotice(rec)).toContain('+ e1 0.800 user_stated "Te1"');
    expect(formatNotice(rec)).toContain('= e2 0.800 user_stated (already in context) "Te2"');
    const line = formatLogLine(rec, false);
    expect(line).toContain('2026-10-16T12:00:00.000Z opencode chat.message session=s1  delivered 1 fact');
    expect(line).toContain('query: "how do I deploy?"');
    expect(line).not.toContain('**Te1**');
    expect(formatLogLine(rec, true)).toContain('**Te1**');
  });

  it('reader prints the last N events and skips bad lines', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctr-'));
    mkdirSync(join(d, 'x'));
    const path = join(d, 'x', 'v.jsonl');
    writeFileSync(path, `${JSON.stringify(rec)}\nnot json\n${JSON.stringify({ ...rec, event: 'skip', reason: 'breaker_open' })}\n`);
    const out: string[] = [];
    expect(await readerMain(['--path', path], {}, (s) => out.push(s))).toBe(0);
    expect(out.join('\n')).toContain('delivered 1 fact');
    expect(out.join('\n')).toContain('nothing delivered (breaker_open)');
    const last: string[] = [];
    await readerMain(['--path', path, '-n', '1'], {}, (s) => last.push(s));
    expect(last.join('\n')).not.toContain('delivered 1 fact');
    expect(await readerMain(['--path', join(d, 'missing')], {}, () => {})).toBe(1);
    expect(await readerMain(['--host', 'nope'], {}, () => {})).toBe(2);
  });
});

describe('reader --follow (rotation, truncation, partial lines)', () => {
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), 'ctf-'));
    const path = join(d, 'v.jsonl');
    writeFileSync(path, 'a\n');
    return { path, f: new Follower(path, 2, statSync(path).ino) };
  };

  it('appends, joins a partial line, and splits multi-byte safely', () => {
    const { path, f } = setup();
    appendFileSync(path, 'b\nc');
    expect(f.poll()).toEqual(['b']);
    appendFileSync(path, Buffer.from('é\n', 'utf8').subarray(0, 1));
    expect(f.poll()).toEqual([]);
    appendFileSync(path, Buffer.from('é\n', 'utf8').subarray(1));
    expect(f.poll()).toEqual(['cé']);
  });

  it('starts over on rotation to a larger or smaller file, dropping stale partials', () => {
    const { path, f } = setup();
    appendFileSync(path, 'partial');
    expect(f.poll()).toEqual([]);
    renameSync(path, `${path}.1`);
    writeFileSync(path, 'new-1 long enough to pass the old offset\nnew-2\n');
    expect(f.poll()).toEqual(['new-1 long enough to pass the old offset', 'new-2']);
    renameSync(path, `${path}.1`);
    writeFileSync(path, 'x\n');
    expect(f.poll()).toEqual(['x']);
  });

  it('starts over on in-place truncation; a missing file is quiet', () => {
    const { path, f } = setup();
    appendFileSync(path, 'bbbbbbbb\n');
    expect(f.poll()).toEqual(['bbbbbbbb']);
    writeFileSync(path, 'z\n');
    expect(f.poll()).toEqual(['z']);
    rmSync(path);
    expect(f.poll()).toEqual([]);
  });
});

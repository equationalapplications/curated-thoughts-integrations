import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import {
  keyOf,
  sanitize,
  renderBlock,
  MAX_BLOCK_CHARS,
  BLOCK_HEADING,
  candidatePaths,
  discoverCt,
  probeIdentity,
  resetDiscoveryCachesForTests,
  RetryGovernor,
  renderWisdom,
  WisdomMemo,
  _resetWisdomStateForTests,
  type ProbeVerdict,
  type RecallDeps,
  type RenderOutcome,
} from '../src/wisdom.js';

describe('keyOf', () => {
  it('prefers a non-empty string agent.id', () => {
    expect(keyOf({ agent: { id: 's1' }, scope: { id: 'other' }, signal: {} })).toBe('s1');
  });
  it('falls back to scope.id when agent.id is missing/blank/non-string', () => {
    expect(keyOf({ scope: { id: 'sc' } })).toBe('sc');
    expect(keyOf({ agent: { id: '' }, scope: { id: 'sc' } })).toBe('sc');
    expect(keyOf({ agent: { id: 42 }, scope: { id: 'sc' } })).toBe('sc');
  });
  it('returns "" when neither yields a non-empty string (no-throw on garbage)', () => {
    expect(keyOf(undefined)).toBe('');
    expect(keyOf(null)).toBe('');
    expect(keyOf({})).toBe('');
    expect(keyOf({ agent: 7, scope: 'str-not-object' })).toBe('');
  });
});

describe('sanitize', () => {
  it('removes the marker REPEATEDLY until stable (a pass can splice a fresh marker)', () => {
    // pass 1 removes the inner marker at offset 18, splicing '<!-- hermes-plugin' + '-section'
    // into a NEW marker; pass 2 removes it. A single replaceAll leaves the forged frame.
    expect(sanitize('<!-- hermes-plugin<!-- hermes-plugin-section-section')).toBe('');
    // this input leaves NO splice: after both markers are removed, '-sectiony' remains
    expect(sanitize('x<!-- hermes-plugin-section<!-- hermes-plugin-section-sectiony')).toBe('x-sectiony');
  });
  it('indents a line-start heading only AFTER marker removal (order)', () => {
    expect(sanitize('## Plugin Context: x')).toBe('    ## Plugin Context: x');
    // Opus cycle-8 m1: the ordering hazard needs the marker on the SAME line,
    // immediately before the heading — indent-first would strip the marker and
    // leave an UNINDENTED forged heading
    expect(sanitize('<!-- hermes-plugin-section## Plugin Context: x')).toBe('    ## Plugin Context: x');
    // removal first, THEN indent: the exposed heading must still be indented
    expect(sanitize('<!-- hermes-plugin<!-- hermes-plugin-section-section\n## Plugin Context: x')).toBe(
      '\n    ## Plugin Context: x'
    );
  });
  it('neutralizes brace-runs with the lookahead form in one pass', () => {
    expect(sanitize('{{a}}')).toBe('{ {a}}');
    expect(sanitize('{{{x}}')).toBe('{ { {x}}');
    expect(sanitize('{{{{')).toBe('{ { { {');
    expect(sanitize('plain { single } braces')).toBe('plain { single } braces');
  });
  it('coerces non-string input defensively', () => {
    expect(sanitize(undefined)).toBe('');
    expect(sanitize(null)).toBe('');
    expect(sanitize(42)).toBe('42');
  });
});

describe('renderBlock', () => {
  it('empty input -> ""', () => {
    expect(renderBlock([])).toBe('');
  });
  it('heading + per-entry **title**\\ntext, blank-line joined, sanitized', () => {
    const out = renderBlock([
      { title: 'T1', text: 'body <!-- hermes-plugin-section-sections:start --> rest' },
      { title: 'T2', text: '{{inject}}' },
    ]);
    expect(out.startsWith(BLOCK_HEADING + '\n\n')).toBe(true);
    expect(out).toContain('**T1**\nbody -sections:start --> rest');
    expect(out).toContain('**T2**\n{ {inject}}');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('<!-- hermes-plugin-section');
  });
  it('skips entries with no usable content', () => {
    const out = renderBlock([{ title: '', text: '   ' }, { title: 'real', text: 'x' }]);
    expect(out).not.toContain('****');
    expect(out).toContain('**real**');
  });
  it('hard-caps the final STRIPPED length at 2500, keeping every kept entry title', () => {
    // heading = 37 chars → used starts at 39; T0 and T1 fit whole (bodies 1007 each);
    // T2 truncates with a budget of 443 — the final stripped length is EXACTLY 2500 (m8 cycle 3)
    const entries = Array.from({ length: 40 }, (_, i) => ({
      title: `T${i}`,
      text: 'x'.repeat(1000),
    }));
    const out = renderBlock(entries);
    expect(out.trim().length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    expect(out).toContain('**T0**');
    expect(out).toContain('\u2026'); // truncated entry keeps title, cut text gets an ellipsis
  });
  it('drops entries that cannot even fit their title line; keeps the rest', () => {
    // used = heading(37) + 2 = 39; entry1 hits the TITLE guard (Hermes L332:
    // remaining 2461 <= titleLine.length 2484 + 1) → dropped before any text
    // math; entry2 fits → INCLUDED (loop continues) (m7 cycle 6: corrected branch)
    const entries = [
      { title: 'T'.repeat(2480), text: 'x' },
      { title: 'T2', text: 'small' },
    ];
    const out = renderBlock(entries);
    expect(out).not.toContain('*****');
    expect(out).not.toContain(`${'T'.repeat(50)}`);
    expect(out).toContain('**T2**');
  });
  it('is byte-stable for identical entries', () => {
    const e = [{ title: 'A', text: 'b' }];
    expect(renderBlock(e)).toBe(renderBlock(e.map((x) => ({ ...x }))));
  });
});

// ── Task 2: discovery — candidatePaths, discoverCt, probeIdentity ──────────

const PROCESS_ENV = {} as NodeJS.ProcessEnv; // tests never read it; injects keep fs/spawn out
const okProbe = (p: string): ProbeVerdict => (p.endsWith('real') ? 'ok' : 'reject'); // annotate: string inference would rely on tests being excluded from tsc (m12 cycle 6)
const allUsable = () => true;

beforeEach(() => {
  resetDiscoveryCachesForTests();
});

describe('candidatePaths (win32 filtering, pure logic — no fs)', () => {
  it('drops ct.cmd, ct.bat and extensionless ct on win32; keeps ct.exe', () => {
    const out = candidatePaths({} as NodeJS.ProcessEnv, 'win32', [
      '/a/ct.cmd',
      '/b/ct.bat',
      '/c/ct.exe',
      '/d/ct',
    ]);
    expect(out).toEqual(['/c/ct.exe']);
  });

  it('keeps everything on POSIX platforms and appends the fallback list', () => {
    const out = candidatePaths({} as NodeJS.ProcessEnv, 'linux', ['/a/ct.cmd', '/c/ct.exe', '/d/ct']);
    expect(out.slice(0, 3)).toEqual(['/a/ct.cmd', '/c/ct.exe', '/d/ct']);
    expect(out.slice(3)).toEqual([
      `${homedir()}/.local/bin/ct`,
      '/usr/bin/ct',
      '/usr/local/bin/ct',
      `${homedir()}/bin/ct`,
    ]);
  });

  it('appends win32 USERPROFILE / LOCALAPPDATA rows only when the env var is non-empty', () => {
    const out = candidatePaths(
      { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } as NodeJS.ProcessEnv,
      'win32',
      [],
    );
    expect(out).toEqual(['C:\\Users\\u\\bin\\ct.exe', 'C:\\Users\\u\\AppData\\Local\\CuratedThoughts\\bin\\ct.exe']);
    // a trailing slash is stripped exactly once, not doubled
    const out2 = candidatePaths({ USERPROFILE: 'C:\\Users\\u\\' } as NodeJS.ProcessEnv, 'win32', []);
    expect(out2).toEqual(['C:\\Users\\u\\bin\\ct.exe']);
    expect(candidatePaths({} as NodeJS.ProcessEnv, 'win32', [])).toEqual([]);
  });

  it('appends the platform fallback list after the PATH matches (darwin vs linux)', () => {
    const linux = candidatePaths({} as NodeJS.ProcessEnv, 'linux', ['/p/ct']);
    expect(linux.slice(0, 1)).toEqual(['/p/ct']);
    expect(linux).toContain('/usr/bin/ct');
    const darwin = candidatePaths({} as NodeJS.ProcessEnv, 'darwin', []);
    expect(darwin).toEqual(['/opt/x/bin/ct'.replace('/opt/x/bin/ct', `${homedir()}/bin/ct`), '/usr/local/bin/ct', '/opt/homebrew/bin/ct']);
  });
});

describe('discoverCt (mocked walk)', () => {
  it('skips relative candidates entirely', () => {
    const calls: string[] = [];
    const r = discoverCt(PROCESS_ENV, {
      candidates: ['ct', 'bin/ct', './ct', '/y/real'],
      usable: allUsable,
      probe: (p) => { calls.push(p); return okProbe(p); },
    });
    expect(r.path).toBe('/y/real');
    expect(calls).toEqual(['/y/real']);
  });

  it('advances past a rejecting candidate and accepts the first passing one', () => {
    const calls: string[] = [];
    const r = discoverCt(PROCESS_ENV, {
      candidates: ['/x/impostor', '/y/real'],
      usable: allUsable,
      probe: (p) => { calls.push(p); return okProbe(p); },
    });
    expect(r).toEqual({ path: '/y/real', failure: null });
    expect(calls).toEqual(['/x/impostor', '/y/real']);
  });

  it('ends the walk on a probe timeout (later candidates not probed)', () => {
    const calls: string[] = [];
    const r = discoverCt(PROCESS_ENV, {
      candidates: ['/a/slow', '/b/real'],
      usable: allUsable,
      probe: (p) => { calls.push(p); return 'timeout' as const; },
    });
    expect(r).toEqual({ path: null, failure: 'probe_timeout' });
    expect(calls).toEqual(['/a/slow']);
  });

  it('exhausting the walk deadline ends it as probe_timeout', () => {
    let t = 0;
    const calls: string[] = [];
    const r = discoverCt(PROCESS_ENV, {
      candidates: ['/a', '/b', '/c'],
      usable: allUsable,
      probe: (p) => { calls.push(p); t += 2800; return 'reject' as const; },
      now: () => t,
    });
    expect(r.failure).toBe('probe_timeout');
    // /c must never be probed: /a + /b spent the whole 3 s deadline
    expect(calls).toEqual(['/a', '/b']);
  });

  it('caches a discovery miss with a 5-min TTL', () => {
    let t = 0;
    const probe = (): ProbeVerdict => 'reject';
    expect(discoverCt(PROCESS_ENV, { candidates: ['/a'], usable: allUsable, probe, now: () => t }).path).toBeNull();
    expect(discoverCt(PROCESS_ENV, { candidates: ['/a'], usable: allUsable, probe: () => { throw new Error('must not re-probe'); }, now: () => t }).path).toBeNull();
    t += 5 * 60_000 + 1;
    const calls: string[] = [];
    expect(discoverCt(PROCESS_ENV, { candidates: ['/a'], usable: allUsable, probe: (p) => { calls.push(p); return 'reject' as const; }, now: () => t }).path).toBeNull();
    expect(calls).toEqual(['/a']); // TTL expired: walked again
  });

  it('never caches a probe_timeout (asserted, not just titled)', () => {
    resetDiscoveryCachesForTests();
    const calls: string[] = [];
    const tprobe = (p: string) => { calls.push(p); return 'timeout' as const; };
    discoverCt(PROCESS_ENV, { candidates: ['/a'], usable: allUsable, probe: tprobe });
    discoverCt(PROCESS_ENV, { candidates: ['/a'], usable: allUsable, probe: tprobe });
    expect(calls).toEqual(['/a', '/a']); // second call walked again
  });

  it('caches the accepted path process-wide (no re-probe)', () => {
    resetDiscoveryCachesForTests();
    const calls: string[] = [];
    const probe = (p: string): ProbeVerdict => { calls.push(p); return 'ok'; };
    discoverCt(PROCESS_ENV, { candidates: ['/y/real'], usable: allUsable, probe });
    const before = calls.length;
    expect(discoverCt(PROCESS_ENV, { candidates: ['/y/real'], usable: allUsable, probe }).path).toBe('/y/real');
    expect(calls.length).toBe(before);
  });

  it('dedupes candidates preserving first-seen order', () => {
    const calls: string[] = [];
    const r = discoverCt(PROCESS_ENV, {
      candidates: ['/y/real', '/y/real', '/z/other'],
      usable: allUsable,
      probe: (p) => { calls.push(p); return okProbe(p); },
    });
    expect(r.path).toBe('/y/real');
    expect(calls).toEqual(['/y/real']);
  });
});

describe('probeIdentity (mocked spawnSync injection — all platforms)', () => {
  const baseOpts = { timeout: 3000, killSignal: 'SIGKILL' };

  it('returns ok when combined output contains Curated Thoughts', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: Buffer.from('ct — headless CLI for Curated Thoughts brains\n'), stderr: null }));
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('ok');
  });

  it('returns reject when output lacks the identity line', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: Buffer.from('chart-testing tool\n'), stderr: Buffer.from('') }));
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('reject');
  });

  it('classifies ETIMEDOUT as timeout', () => {
    const err = Object.assign(new Error('kill'), { code: 'ETIMEDOUT' });
    const spawn = vi.fn(() => ({ status: null, signal: null, stdout: null, stderr: null, error: err }));
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('timeout');
  });

  it('classifies a bare signal-kill (crash shape) as reject — NOT timeout', () => {
    const spawn = vi.fn(() => ({ status: null, signal: 'SIGKILL', stdout: null, stderr: null }));
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('reject');
  });

  it('classifies ENOENT as reject', () => {
    const err = Object.assign(new Error('enoent'), { code: 'ENOENT' });
    const spawn = vi.fn(() => ({ status: null, signal: null, stdout: null, stderr: null, error: err }));
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('reject');
  });

  it('classifies a throwing spawnSync as reject (never escapes)', () => {
    const spawn = vi.fn(() => { throw new Error('NUL byte in path'); });
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('reject');
  });

  it('spawns [ct, --help] with the recall option set except probe timeout', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: Buffer.from('Curated Thoughts'), stderr: null }));
    probeIdentity('/bin/ct', { spawnSync: spawn as never, timeoutMs: 1234 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('/bin/ct');
    expect(spawn.mock.calls[0][1]).toEqual(['--help']);
    expect(spawn.mock.calls[0][2]).toMatchObject({ ...baseOpts, timeout: 1234 });
  });

  it('reads stdout+stderr COMBINED for the identity line', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: Buffer.from(''), stderr: Buffer.from('Curated Thoughts v1') }));
    expect(probeIdentity('/bin/ct', { spawnSync: spawn as never })).toBe('ok');
  });
});

// ── Task 3: recallWiki — pinned argv + failure classes (mocked, all platforms) ──

import { recallWiki } from '../src/wisdom.js';

const wisdomEnv = { CURATED_BRAIN_DB: '/tmp/brain.db' } as NodeJS.ProcessEnv;

function spawnResult(partial: Record<string, unknown>) {
  return {
    status: 0,
    signal: null,
    stdout: null,
    stderr: null,
    ...partial,
  };
}

describe('recallWiki (mocked spawnSync injection — all platforms)', () => {
  it('pins argv, all recall options, and the identity of the env object', () => {
    const runSpy = vi.fn(() => spawnResult({ stdout: Buffer.from('{"wiki": []}') }));
    const r = recallWiki('/bin/ct', 'procedures', { spawnSync: runSpy as never, env: wisdomEnv });
    expect(r).toEqual({ entries: [], failure: null });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith('/bin/ct', ['recall', 'procedures', '--json', '--k', '3'], {
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      cwd: homedir(),
      env: wisdomEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    // deep equality alone does not prove identity — assert the same object
    expect((runSpy.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env).toBe(wisdomEnv);
  });

  it('parses valid wiki JSON with full coercion rules', () => {
    const stdout = Buffer.from(
      JSON.stringify({
        wiki: [
          { title: 'T1', text: 'body' },
          { text: 'no title' }, // missing title → ''
          { title: 'no text' }, // missing text → ''
          { title: 42, text: null }, // non-string → ''
          'a string item', // non-dict → skipped
          ['array', 'item'], // arrays are not dicts → skipped
        ],
      }),
    );
    const spawn = vi.fn(() => spawnResult({ stdout }));
    const r = recallWiki('/bin/ct', 'q', { spawnSync: spawn as never });
    expect(r).toEqual({
      entries: [
        { title: 'T1', text: 'body' },
        { title: '', text: 'no title' },
        { title: 'no text', text: '' },
        { title: '', text: '' },
      ],
      failure: null,
    });
  });

  it('chunks without a wiki key → parse-error class (entries null, failure null)', () => {
    const stdout = Buffer.from(JSON.stringify({ results: [{ title: 'x', text: 'y' }] }));
    const spawn = vi.fn(() => spawnResult({ stdout }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: null });
  });

  it("stdout 'not json' → parse-error class", () => {
    const spawn = vi.fn(() => spawnResult({ stdout: Buffer.from('not json') }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: null });
  });

  it('empty wiki list → zero hits success', () => {
    const spawn = vi.fn(() => spawnResult({ stdout: Buffer.from('{"wiki": []}') }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: [], failure: null });
  });

  it('non-zero exit → exit class', () => {
    const spawn = vi.fn(() => spawnResult({ status: 3, stdout: Buffer.from(''), stderr: Buffer.from('boom') }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: 'exit' });
  });

  it('ETIMEDOUT error → timeout class', () => {
    const err = Object.assign(new Error('kill'), { code: 'ETIMEDOUT' });
    const spawn = vi.fn(() => spawnResult({ error: err }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: 'timeout' });
  });

  it('bare signal-kill (no error field) → EXIT class, not timeout (crash)', () => {
    const spawn = vi.fn(() => spawnResult({ signal: 'SIGKILL', status: null }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: 'exit' });
  });

  it('ENOENT error → spawn class', () => {
    const err = Object.assign(new Error('enoent'), { code: 'ENOENT' });
    const spawn = vi.fn(() => spawnResult({ error: err }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: 'spawn' });
  });

  it('ENOBUFS error → parse-error class (memoized by the orchestrator, per spec)', () => {
    const err = Object.assign(new Error('buf'), { code: 'ENOBUFS' });
    const spawn = vi.fn(() => spawnResult({ error: err }));
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: null });
  });

  it('a throwing spawnSync → spawn class (defensive; spawnSync never throws in practice)', () => {
    const spawn = vi.fn(() => { throw new Error('nul byte'); });
    expect(recallWiki('/bin/ct', 'q', { spawnSync: spawn as never })).toEqual({ entries: null, failure: 'spawn' });
  });

  it('defaults env to process.env when deps.env is absent', () => {
    const runSpy = vi.fn(() => spawnResult({ stdout: Buffer.from('{"wiki": []}') }));
    recallWiki('/bin/ct', 'q', { spawnSync: runSpy as never });
    expect((runSpy.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env).toBe(process.env);
  });
});

// ── Task 4: RetryGovernor — budget + circuit breaker (injected clock; NO vi.useFakeTimers, M4 cycle 3) ──

describe('RetryGovernor (constructor-injected clock)', () => {
  it('first gate allows; after one failure the immediate gate is cooldown', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    expect(g.gate('a1')).toBe('allow');
    // 1st attempt granted then failed: budget NOT yet spent (both attempts
    // must be granted for recordFailure to return true — M3 cycle 3)
    g.recordFailure('a1');
    expect(g.gate('a1')).toBe('cooldown'); // < 60 s since the attempt
  });

  it('after 60s the 2nd attempt is allowed; the 2nd recordFailure returns true (budget JUST spent); gate is then spent forever', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    expect(g.gate('a1')).toBe('allow');
    g.recordFailure('a1');
    t += 60_001;
    expect(g.gate('a1')).toBe('allow'); // 2nd attempt
    expect(g.recordFailure('a1')).toBe(true); // M3 cycle 3: spent THIS render
    t += 1_000_000;
    expect(g.gate('a1')).toBe('spent');
  });

  it('budget is per agent: a fresh id after 1 failure is allowed', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    expect(g.gate('a1')).toBe('allow');
    g.recordFailure('a1');
    expect(g.gate('a2')).toBe('allow');
  });

  it('opens the breaker after 4 consecutive failures across agents; any fresh id is breaker_open immediately', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      expect(g.gate(id)).toBe('allow');
      g.recordFailure(id);
      t += 60_001; // keep each agent's own gate legal
    }
    expect(g.gate('fresh1')).toBe('breaker_open'); // no cooldown wait
  });

  it('after the 5-min window elapses exactly ONE half-open attempt is granted; a failed half-open re-opens', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      g.gate(id);
      g.recordFailure(id);
      t += 60_001;
    }
    t += 5 * 60_001;
    expect(g.gate('h1')).toBe('allow'); // half-open trial consumed by the grant (cycle-7 M3)
    g.recordFailure('h1'); // failed probe RE-OPENS for a fresh 5-min window (plan line 545)
    t += 4 * 60_001; // still INSIDE the fresh window
    expect(g.gate('fresh2')).toBe('breaker_open'); // re-opened for another 5 min
  });

  it('a cooldown agent gets cooldown (not breaker_open) while the breaker is OPEN — pinned gate order', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    g.gate('a1');
    g.recordFailure('a1'); // a1 cooldown: t=0..60s
    t += 59_000;
    // 4 more consecutive failures → breaker opens at t=59_000, still < 60s since a1's attempt
    for (const id of ['a2', 'a3', 'a4', 'a5']) {
      g.gate(id);
      g.recordFailure(id);
    }
    // order (2) before (3): a1 is answered cooldown, not breaker_open; the breaker stays open
    expect(g.gate('a1')).toBe('cooldown');
    expect(g.gate('fresh1')).toBe('breaker_open');
  });

  it('a half-open trial is NOT consumed by a gated (spent) agent', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    // a1 burns BOTH attempts BEFORE the breaker opens → 'spent' forever
    expect(g.gate('a1')).toBe('allow');
    g.recordFailure('a1');
    t += 60_001;
    expect(g.gate('a1')).toBe('allow');
    expect(g.recordFailure('a1')).toBe(true);
    // a2..a4: 3 more consecutive failures → breaker opens (consecutive = 5)
    for (const id of ['a2', 'a3', 'a4']) {
      g.gate(id);
      g.recordFailure(id);
      t += 60_001;
    }
    t += 5 * 60_001; // window elapses
    // order (1) before (3): a1 is spent, checked BEFORE the breaker — must not burn the trial
    expect(g.gate('a1')).toBe('spent');
    expect(g.gate('freshId')).toBe('allow'); // trial still available for a fresh agent
  });

  it('half-open SUCCESS closes the breaker (consecutive reset)', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      g.gate(id);
      g.recordFailure(id);
      t += 60_001;
    }
    t += 5 * 60_001;
    expect(g.gate('h1')).toBe('allow');
    g.recordSuccess('h1');
    expect(g.gate('freshId')).toBe('allow');
  });

  it('half-open MEMOIZED-class outcome (recordSuccess) also closes the breaker', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      g.gate(id);
      g.recordFailure(id);
      t += 60_001;
    }
    t += 5 * 60_001;
    expect(g.gate('h1')).toBe('allow');
    // discovery_miss-style outcome: recordSuccess, not recordFailure
    g.recordSuccess('h1');
    expect(g.gate('freshId')).toBe('allow');
  });

  it('the per-agent map is LRU-capped at 256 entries (raw eviction)', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    // grants only: the RAW eviction test must not trip the process-wide
    // breaker (recordFailure here would be 256 consecutive failures — plan
    // line 549 keeps breaker interplay in Task 5's orchestrator tests)
    for (let i = 0; i < 256; i++) {
      expect(g.gate(`agent-${i}`)).toBe('allow');
    }
    // one more agent evicts the OLDEST entry (agent-0) without breaking anything
    expect(g.gate('agent-256')).toBe('allow');
    // agent-0 was evicted: its budget is fresh again (allow, not cooldown)
    expect(g.gate('agent-0')).toBe('allow');
  });

  it('a SUCCESS resets the consecutive counter: 3 failures + success + 3 failures → breaker NOT open', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    for (const id of ['a1', 'a2', 'a3']) {
      g.gate(id);
      g.recordFailure(id);
      t += 60_001;
    }
    g.recordSuccess('ok-agent');
    for (const id of ['b1', 'b2', 'b3']) {
      g.gate(id);
      g.recordFailure(id);
      t += 60_001;
    }
    expect(g.gate('fresh')).toBe('allow'); // only 3 consecutive since the success
  });

  it('setClock swaps the clock for later gates', () => {
    let t = 0;
    const g = new RetryGovernor(() => t);
    g.gate('a1');
    g.recordFailure('a1');
    const t2 = () => 10_000_000;
    g.setClock(t2);
    expect(g.gate('a1')).toBe('allow'); // cooldown elapsed under the new clock
  });
});

// ── Task 5: WisdomMemo + renderWisdom orchestrator (injected deps ONLY — no real spawns) ──

const WIKI_OK = '{"wiki": [{"title": "T1", "text": "body one"}]}';

function okSpawn(): { fn: ReturnType<typeof vi.fn>; result: () => ReturnType<typeof spawnShape> } {
  const fn = vi.fn(() => spawnShape({ stdout: Buffer.from(WIKI_OK) }));
  return { fn, result: () => spawnShape({ stdout: Buffer.from(WIKI_OK) }) };
}
function spawnShape(o: Partial<ReturnType<typeof JSON.parse>> & { stdout?: Buffer; error?: Error; status?: number | null; signal?: null }): {
  status: number | null;
  signal: null;
  stdout: Buffer | null;
  stderr: Buffer | null;
  error?: Error;
} {
  return { status: o.status ?? 0, signal: null, stdout: o.stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0), error: o.error };
}

describe('WisdomMemo (pure — no spawn mocks)', () => {
  it('same key → byte-identical, recallFn invoked exactly once', () => {
    let calls = 0;
    const m = new WisdomMemo();
    const recall = vi.fn((_k: string) => {
      calls += 1;
      return { block: 'B', memoize: true };
    });
    expect(m.renderFor('a', recall)).toBe('B');
    expect(m.renderFor('a', recall)).toBe('B');
    expect(recall).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });

  it('different key → second recall', () => {
    const recall = vi.fn((k: string) => ({ block: `B-${k}`, memoize: true }));
    const m = new WisdomMemo();
    expect(m.renderFor('a', recall)).toBe('B-a');
    expect(m.renderFor('b', recall)).toBe('B-b');
    expect(recall).toHaveBeenCalledTimes(2);
  });

  it('LRU eviction at 256: key 2 hit refreshes it; key 1 re-recalls and evicts key 3 (Opus cycle-4 M3)', () => {
    const recall = vi.fn((k: string) => ({ block: `B-${k}`, memoize: true }));
    const m = new WisdomMemo();
    for (let i = 1; i <= 257; i++) m.renderFor(`k${i}`, recall);
    expect(recall).toHaveBeenCalledTimes(257);
    m.renderFor('k2', recall); // hit + touch (refresh recency)
    expect(recall).toHaveBeenCalledTimes(257);
    m.renderFor('k1', recall); // k1 was EVICTED (oldest) → re-recall; insertion evicts k3
    expect(recall).toHaveBeenCalledTimes(258);
    expect(m.renderFor('k3', recall)).toBe('B-k3'); // k3 gone → miss
    expect(recall).toHaveBeenCalledTimes(259);
    expect(m.renderFor('k2', recall)).toBe('B-k2'); // k2 survived (was touched)
    expect(recall).toHaveBeenCalledTimes(259);
  });

  it('empty key → "" with NO recallFn call and NO memo write', () => {
    const recall = vi.fn(() => ({ block: 'B', memoize: true }));
    const m = new WisdomMemo();
    expect(m.renderFor('', recall)).toBe('');
    expect(m.renderFor('', recall)).toBe('');
    expect(recall).not.toHaveBeenCalled();
  });

  it('empty-string block memoized (hit on second call)', () => {
    const recall = vi.fn(() => ({ block: '', memoize: true }));
    const m = new WisdomMemo();
    expect(m.renderFor('a', recall)).toBe('');
    expect(m.renderFor('a', recall)).toBe('');
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it('recallFn throwing → "" and NOT memoized', () => {
    let n = 0;
    const recall = vi.fn((_k: string) => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { block: 'B', memoize: true };
    });
    const m = new WisdomMemo();
    expect(m.renderFor('a', recall)).toBe('');
    expect(m.renderFor('a', recall)).toBe('B'); // re-recalled: throw was not memoized
    expect(recall).toHaveBeenCalledTimes(2);
  });

  it('memoize:false result returned but NOT stored', () => {
    const recall = vi.fn(() => ({ block: 'B', memoize: false }));
    const m = new WisdomMemo();
    expect(m.renderFor('a', recall)).toBe('B');
    expect(m.renderFor('a', recall)).toBe('B');
    expect(recall).toHaveBeenCalledTimes(2);
  });
});

// ── orchestrator: renderWisdom ─────────────────────────────────────────────

describe('renderWisdom (injected deps)', () => {
  let t = 0;
  beforeEach(() => {
    _resetWisdomStateForTests();
    t = 0;
  });
  const deps = (o: Partial<RecallDeps>): RecallDeps => ({ ...o, now: o.now ?? (() => t) });

  it('success: block non-empty; second call memo=hit (spawn count and probe count unchanged, bytes identical)', () => {
    const spawn = vi.fn(() => spawnShape({ stdout: Buffer.from(WIKI_OK) }));
    const probe = vi.fn((p: string): ProbeVerdict => (p.endsWith('real') ? 'ok' : 'reject'));
    const d = deps({ spawnSync: spawn as never, probe, candidates: ['/x/ct-real'], usable: () => true });
    const first = renderWisdom({ agent: { id: 'a1' } }, d);
    expect(first).toContain('**T1**');
    expect(spawn).toHaveBeenCalledTimes(1); // recall only — the injected probe bypasses spawnSync in discovery
    expect(probe).toHaveBeenCalledTimes(1);
    const second = renderWisdom({ agent: { id: 'a1' } }, d);
    expect(second).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1); // unchanged: memo=hit, no second recall
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('discovery miss → "", class discovery_miss, memoized (no spawn on second call)', () => {
    const spawn = vi.fn(() => { throw new Error('must not spawn'); });
    const probe = vi.fn((): ProbeVerdict => 'reject');
    const outcomes: RenderOutcome[] = [];
    const d = deps({ spawnSync: spawn as never, probe, candidates: ['/x/ct-a', '/x/ct-b'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    expect(outcomes[0]).toEqual({ called: true, failureClass: 'discovery_miss' });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // memo hit
    expect(spawn).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2); // a1, a2 candidates — once overall
  });

  it('probe timeout → "", class probe_timeout, NOT memoized; 3rd render (after 2 budgeted failures) is memo=hit with ZERO probe calls (M3 cycle 3)', () => {
    const probe = vi.fn((): ProbeVerdict => 'timeout');
    const outcomes: RenderOutcome[] = [];
    const d = deps({ probe, candidates: ['/x/ct-a'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    t += 60_001;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // attempt 2, recordFailure → true, memoized
    t += 60_001;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // memo hit — spent
    expect(probe).toHaveBeenCalledTimes(2);
    // M3 cycle 3: the '' memo landed AT render 2 (recordFailure returned true),
    // so render 3 never reaches the outcome callable — only two entries exist
    expect(outcomes.map((o) => [o.called, o.failureClass])).toEqual([
      [true, 'probe_timeout'],
      [true, 'probe_timeout'],
    ]);
  });

  it('a fresh agent at the same clock gets its own 2 attempts (probe timeout)', () => {
    const probe = vi.fn((): ProbeVerdict => 'timeout');
    const d = deps({ probe, candidates: ['/x/ct-a'], usable: () => true });
    renderWisdom({ agent: { id: 'a1' } }, d);
    t += 60_001;
    renderWisdom({ agent: { id: 'a1' } }, d); // a1 spent
    t += 60_001;
    expect(renderWisdom({ agent: { id: 'a2' } }, d)).toBe('');
    expect(probe).toHaveBeenCalledTimes(3); // a1 ×2, a2 ×1
  });

  it.each(['timeout', 'exit'] as const)('recall %s → class %s, NOT memoized at failure time; 2nd failure memoizes', (cls) => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help'
        ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') })
        : cls === 'timeout'
          ? spawnShape({ error: Object.assign(new Error('to'), { code: 'ETIMEDOUT' }) })
          : spawnShape({ status: 1 }),
    );
    const outcomes: RenderOutcome[] = [];
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    expect(outcomes[0]?.failureClass).toBe(cls);
    t += 60_001;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // 2nd failure → budget spent → memoized
    t += 60_001;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // memo hit
  });

  it('spawn failure (ENOENT) → class spawn; accepted-path cache reset verified: probe re-runs after ≥60 s (Opus cycle-7 M4)', () => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help'
        ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') })
        : spawnShape({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }),
    );
    const outcomes: RenderOutcome[] = [];
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    expect(outcomes[0]?.failureClass).toBe('spawn');
    const probesAfterFirst = spawn.mock.calls.filter((c) => c[1][0] === '--help').length;
    t += 60_001; // WITHOUT the advance the gate answers cooldown and nothing re-probes
    renderWisdom({ agent: { id: 'a1' } }, d);
    const probesAfterSecond = spawn.mock.calls.filter((c) => c[1][0] === '--help').length;
    expect(probesAfterSecond).toBeGreaterThan(probesAfterFirst); // reset re-probed
  });

  it('two ENOENT failures for a1 (≥60 s advances) → recordFailure true → memo-hit on the third render', () => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help'
        ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') })
        : spawnShape({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }),
    );
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true });
    renderWisdom({ agent: { id: 'a1' } }, d);
    t += 60_001;
    renderWisdom({ agent: { id: 'a1' } }, d); // 2nd failure — budget just spent
    t += 60_001;
    const probesBefore = spawn.mock.calls.filter((c) => c[1][0] === '--help').length;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // memo hit
    const probesAfter = spawn.mock.calls.filter((c) => c[1][0] === '--help').length;
    expect(probesAfter).toBe(probesBefore);
  });

  it('four spawn failures across agents → a fresh agent is breaker_open (the breaker SURVIVED the resets)', () => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help'
        ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') })
        : spawnShape({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }),
    );
    const outcomes: RenderOutcome[] = [];
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    const ids = ['a1', 'a2', 'a3', 'a4'];
    for (const id of ids) {
      renderWisdom({ agent: { id } }, d);
      t += 60_001;
    }
    const outcome = renderWisdom({ agent: { id: 'a5' } }, d);
    expect(outcome).toBe('');
    expect(outcomes.at(-1)).toEqual({ called: false, failureClass: 'breaker_open' });
  });

  it('parse error / ENOBUFS → memoized (second render: spawn count unchanged)', () => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help'
        ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') })
        : spawnShape({ error: Object.assign(new Error('buf'), { code: 'ENOBUFS' }) }),
    );
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    const callsAfterFirst = spawn.mock.calls.length;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    expect(spawn.mock.calls.length).toBe(callsAfterFirst);
  });

  it('zero hits → "" memoized', () => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help' ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') }) : spawnShape({ stdout: Buffer.from('{"wiki": []}') }),
    );
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    const callsAfterFirst = spawn.mock.calls.length;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe('');
    expect(spawn.mock.calls.length).toBe(callsAfterFirst);
  });

  it('no key (ctx = {}) → "", no memo write, NO spawnSync, NO probe', () => {
    const spawn = vi.fn(() => { throw new Error('must not spawn'); });
    const probe = vi.fn((): ProbeVerdict => 'ok');
    const d = deps({ spawnSync: spawn as never, probe, candidates: ['/x/ct-real'], usable: () => true });
    expect(renderWisdom({}, d)).toBe('');
    expect(spawn).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('budget/breaker interplay (M3 cycle 3): a1 fails twice → 3rd render memo-hit with ZERO spawns/probes; a2 fails twice → breaker OPEN; a3 → breaker_open, zero calls', () => {
    const probe = vi.fn((): ProbeVerdict => 'timeout');
    const outcomes: RenderOutcome[] = [];
    const d = deps({ probe, candidates: ['/x/ct-a'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    renderWisdom({ agent: { id: 'a1' } }, d);
    t += 60_001;
    renderWisdom({ agent: { id: 'a1' } }, d); // 2nd failure → recordFailure true → memoize NOW
    t += 60_001;
    const probeCountAfterA1 = probe.mock.calls.length;
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // memo hit
    expect(probe).toHaveBeenCalledTimes(probeCountAfterA1);
    // a2: 2 more consecutive failures → 4 total → breaker OPEN
    renderWisdom({ agent: { id: 'a2' } }, d);
    t += 60_001;
    renderWisdom({ agent: { id: 'a2' } }, d);
    t += 60_001;
    expect(renderWisdom({ agent: { id: 'a3' } }, d)).toBe(''); // breaker_open — no attempt made
    expect(outcomes.at(-1)).toEqual({ called: false, failureClass: 'breaker_open' });
    const probeCountFinal = probe.mock.calls.length;
    t += 60_001;
    renderWisdom({ agent: { id: 'a3' } }, d); // still breaker_open (window not elapsed) — memo NOT written
    expect(probe).toHaveBeenCalledTimes(probeCountFinal);
  });

  it('throw-after-allow: a throwing probe after a granted allow → "", no raise, governor consistent (next render gated)', () => {
    const probe = vi.fn((): ProbeVerdict => {
      throw new Error('probe exploded');
    });
    const outcomes: RenderOutcome[] = [];
    const d = deps({ probe, candidates: ['/x/ct-a'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    expect(renderWisdom({ agent: { id: 'a1' } }, d)).toBe(''); // no raise
    expect(outcomes[0]).toEqual({ called: true, failureClass: 'spawn' });
    // a1's attempt was recorded: the immediate next render is cooldown-gated
    const next = renderWisdom({ agent: { id: 'a1' } }, d);
    expect(next).toBe('');
    expect(outcomes[1]?.failureClass).toBe('cooldown');
  });

  it('GLM-2 precise: 3 single-failure agents (throwing observer) leave the breaker CLOSED for a 4th fresh agent', () => {
    const probe = vi.fn((): ProbeVerdict => {
      const n = (probe as unknown as { calls?: number }).calls ?? 0;
      (probe as unknown as { calls: number }).calls = n + 1;
      return 'timeout';
    });
    let boom = true;
    const d = deps({
      probe,
      candidates: ['/x/ct-a'],
      usable: () => true,
      onOutcome: () => {
        if (boom) throw new Error('observer exploded');
      },
    });
    for (const id of ['x1', 'x2', 'x3']) {
      renderWisdom({ agent: { id } }, d); // each records exactly ONE failure even though the observer throws
      t += 60_001;
    }
    boom = false;
    const outcomes: RenderOutcome[] = [];
    const dClean = deps({ probe, candidates: ['/x/ct-a'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    renderWisdom({ agent: { id: 'x4' } }, dClean);
    // exactly-once: consecutive = 3 (not 6) → the 4th failure opens the breaker
    expect(outcomes.at(-1)?.failureClass).toBe('probe_timeout'); // the attempt ran; the NEXT fresh agent is breaker-gated
    const outcomes2: RenderOutcome[] = [];
    const dClean2 = deps({ probe, candidates: ['/x/ct-a'], usable: () => true, onOutcome: (o) => outcomes2.push(o) });
    renderWisdom({ agent: { id: 'x5' } }, dClean2);
    expect(outcomes2[0]).toEqual({ called: false, failureClass: 'breaker_open' }); // breaker opened by 4 REAL failures
  });

  it('breaker half-open + the one allowed attempt throws → after the window another attempt is admitted (never wedged)', () => {
    const probe = vi.fn((): ProbeVerdict => {
      throw new Error('probe exploded');
    });
    const d = deps({ probe, candidates: ['/x/ct-a'], usable: () => true });
    // 4 consecutive failures → breaker opens
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      renderWisdom({ agent: { id } }, d);
      t += 60_001;
    }
    t += 5 * 60_001; // window elapses; the ONE trial goes to the next render
    renderWisdom({ agent: { id: 'h1' } }, d); // trial consumed; the probe THROWS → recordFailure re-opens
    t += 5 * 60_001; // the FRESH re-open window ALSO elapses (re-open stamps a new breakerOpenAt)
    const outcomes: RenderOutcome[] = [];
    const d2 = deps({ probe, candidates: ['/x/ct-a'], usable: () => true, onOutcome: (o) => outcomes.push(o) });
    renderWisdom({ agent: { id: 'h2' } }, d2); // trial available again; the probe throws once more
    expect(outcomes.at(-1)?.failureClass).toBe('spawn'); // an attempt was GRANTED (not breaker_open)
  });

  it('garbage ctx (null, 42, {agent: () => {}}) → "" never throws', () => {
    const spawn = vi.fn(() => spawnShape({ stdout: Buffer.from(WIKI_OK) }));
    const probe = vi.fn((): ProbeVerdict => 'ok');
    const d = deps({ spawnSync: spawn as never, probe, candidates: ['/x/ct-real'], usable: () => true });
    expect(renderWisdom(null, d)).toBe('');
    expect(renderWisdom(42, d)).toBe('');
    expect(renderWisdom({ agent: () => {} }, d)).toBe('');
  });

  it('debug logging: env set → one stderr line; env unset → nothing on stderr and console.* all silent', () => {
    const spawn = vi.fn((cmd: string, args: readonly string[]) =>
      args[0] === '--help' ? spawnShape({ stdout: Buffer.from('Curated Thoughts ok') }) : spawnShape({ stdout: Buffer.from(WIKI_OK) }),
    );
    const d = deps({ spawnSync: spawn as never, candidates: ['/x/ct-real'], usable: () => true });
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.CT_WISDOM_DEBUG = '1';
    try {
      renderWisdom({ agent: { id: 'dbg1' } }, d);
      const line = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(line).toContain('wisdom: render agent=dbg1');
      expect(line).toMatch(/memo=(hit|miss) class=(ok)/);
    } finally {
      delete process.env.CT_WISDOM_DEBUG;
      errSpy.mockRestore();
    }
    // unset: NOTHING on stderr, no console flood
    const errSpy2 = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderWisdom({ agent: { id: 'dbg2' } }, d); // new agent → new render (memo untouched)
      expect(errSpy2).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errSpy2.mockRestore();
      logSpy.mockRestore();
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('GLM-1: with debug on, a miss render emits EXACTLY ONE line (no spurious memo=hit alongside memo=miss)', () => {
    const probe = vi.fn((): ProbeVerdict => 'reject'); // → discovery_miss, which IS memoized
    const d = deps({ probe, candidates: ['/x/ct-a'], usable: () => true });
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.CT_WISDOM_DEBUG = '1';
    try {
      renderWisdom({ agent: { id: 'gl1' } }, d); // miss render (discovery_miss)
      const lines = errSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('wisdom: render'));
      expect(lines).toHaveLength(1); // GLM-1: the old code emitted the miss line AND the hit line
      expect(lines[0]).toContain('memo=miss class=discovery_miss');
      // second render for the same agent is a real memo hit: exactly one HIT line
      errSpy.mockClear();
      renderWisdom({ agent: { id: 'gl1' } }, d);
      const hitLines = errSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('wisdom: render'));
      expect(hitLines).toHaveLength(1);
      expect(hitLines[0]).toContain('memo=hit');
    } finally {
      delete process.env.CT_WISDOM_DEBUG;
      errSpy.mockRestore();
    }
  });
});

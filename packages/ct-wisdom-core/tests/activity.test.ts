/**
 * activity.test.ts — the autonomous-work activity core (spec
 * docs/superpowers/specs/2026-10-16-dsh-autonomous-work-wisdom-design.md),
 * a port of integrations/hermes/tests/test_ct_wisdom_activity.py: the line
 * builder cases, the randomized secret-safety test, the key tracker, the
 * block renderer and the match runner.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_HEADING,
  ACTIVITY_MAX_BLOCK_CHARS,
  ACTIVITY_QUERY_CHARS,
  ACTIVITY_RECENT_KEYS_MAX,
  ACTIVITY_TARGET_CHARS,
  ActivityTracker,
  Breaker,
  BREAKER_FAILS,
  activityCandidates,
  activityQuery,
  buildActivity,
  isCtTool,
  marker,
  nameHit,
  projectRoot,
  renderActivityBlock,
  resetActivityCaches,
  runActivityMatch,
  scanIds,
  selectActivityDelivery,
  shellWords,
  startActivity,
  finishActivity,
  userNames,
} from '../src/index.js';
import type {
  Activity,
  ActivitySpec,
  HostAdapter,
  Ledger,
  MatchOutcome,
  WisdomMatchResult,
} from '../src/index.js';

// Hermes tool → neutral spec, so the Hermes cases port verbatim.
function hermes(tool: string, args: unknown): ActivitySpec | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  switch (tool) {
    case 'read_file':
      return { verb: 'read', path: a.path };
    case 'write_file':
      return { verb: 'write', path: a.path };
    case 'patch':
      return { verb: 'edit', path: a.path };
    case 'search_files':
      return { verb: 'search', pattern: a.pattern, path: a.path };
    case 'terminal':
      return { verb: 'run', command: a.command };
    default:
      return null;
  }
}

/** The environment the builder reads; fixed so the suite never depends on the CI user. */
const ENV = { USER: 'alice', HOME: '/Users/alice' };

/** A real project on disk (P1 needs one): a temp dir holding a `.git` marker. */
const PROJ = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'ct-act-proj-')));
mkdirSync(nodePath.join(PROJ, '.git'));
/** A directory with no marker anywhere up its walk. */
const NO_ROOT = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'ct-act-none-')));
afterAll(() => {
  rmSync(PROJ, { recursive: true, force: true });
  rmSync(NO_ROOT, { recursive: true, force: true });
});
beforeEach(() => resetActivityCaches());

/** realpath of the longest existing prefix, the rest appended. */
function realpathOr(p: string): string {
  const segs = p.split('/');
  for (let i = segs.length; i > 0; i--) {
    const head = segs.slice(0, i).join('/') || '/';
    try {
      return [realpathSync(head), ...segs.slice(i)].join('/');
    } catch {
      /* shorter prefix */
    }
  }
  return p;
}

function act(tool: string, args: unknown, cwd: string = PROJ): Activity | null {
  const spec = hermes(tool, args);
  return spec === null ? null : buildActivity(spec, cwd, ENV);
}

/** Commands (hermes 0.6.6 P3) and searches (P4); paths are covered by the shared vectors. */
const CASES: Array<[string, Record<string, unknown>, string, string]> = [
  ['read_file', { path: 'src/billing/invoice.py' }, 'read src/billing/invoice.py', 'src/billing/invoice.py'],
  ['write_file', { path: './a/b.py', content: 'SECRET_CONTENT' }, 'write a/b.py', 'a/b.py'],
  ['patch', { path: 'x.py', old_string: 'o', new_string: 'SECRET_NEW' }, 'edit x.py', 'x.py'],
  ['search_files', { pattern: 'MCP tool name', path: 'src' }, 'search MCP tool name in src', 'MCP tool name'],
  ['search_files', { pattern: 'TODO' }, 'search TODO', 'TODO'],
  ['terminal', { command: 'pnpm test' }, 'run pnpm test', 'pnpm test'],
  ['terminal', { command: 'npm run build' }, 'run npm run', 'npm run'],
  ['terminal', { command: 'pytest tests/billing -q' }, 'run pytest', 'pytest'],
  ['terminal', { command: 'API_KEY=sk-123 python deploy.py --token x' }, 'run python', 'python'],
  ['terminal', { command: "curl -H 'Authorization: Bearer x' https://h" }, 'run curl', 'curl'],
  ['terminal', { command: "git commit -m 'msg SECRET'" }, 'run git commit', 'git commit'],
  ['terminal', { command: 'python3 -m pytest' }, 'run python3 pytest', 'python3 pytest'],
  ['terminal', { command: 'cat .env.local | grep KEY' }, 'run cat', 'cat'],
  ['terminal', { command: 'echo sk-live-abcdef' }, 'run echo', 'echo'],
  ['terminal', { command: 'export TOKEN=abc && make' }, 'run export', 'export'],
  ['terminal', { command: 'mysql -uroot -pS3cr3t db' }, 'run mysql', 'mysql'],
  ['terminal', { command: 'psql -W secretpw' }, 'run psql', 'psql'],
  ['terminal', { command: 'deploy --token abcsecret' }, 'run deploy', 'deploy'],
  ['terminal', { command: 'git -C somedir status' }, 'run git', 'git'],
  ['terminal', { command: 'python -m mypkg.cli --key v' }, 'run python', 'python'], // not known, not in the project
  ['terminal', { command: 'rm divorce-papers' }, 'run rm', 'rm'], // 0.6.6: no subcommand for ordinary programs
  ['terminal', { command: 'make test' }, 'run make test', 'make test'],
  ['terminal', { command: 'make secret-target' }, 'run make', 'make'],
  ['terminal', { command: 'cargo nextest' }, 'run cargo nextest', 'cargo nextest'],
  ['terminal', { command: 'python3.11 -m pytest -q' }, 'run python3.11 pytest', 'python3.11 pytest'],
  ['terminal', { command: 'node -m x' }, 'run node', 'node'],
  ['terminal', { command: 'grep "SecretPassword" app.log' }, 'run grep', 'grep'],
  ['terminal', { command: "python -m 'secretmod'" }, 'run python', 'python'],
  ['terminal', { command: 'git push https://user:pw@host/r.git' }, 'run git push', 'git push'],
  ['terminal', { command: 'deploy ghp_abcdefghijklmnop1234' }, 'run deploy', 'deploy'],
  ['terminal', { command: 'git Rebase' }, 'run git', 'git'],
];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Python shlex.split (POSIX) for the test oracle: quotes removed. */
function posixSplit(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote !== null) throw new Error('No closing quotation');
  if (inWord) out.push(cur);
  return out;
}

const basename = (p: string): string => p.split('/').pop() ?? p;

describe('activity line builder (hermes 0.6.5 rules; the full contract is activity_vectors.test.ts)', () => {
  it('builds the command and search cases (P3 allowlist)', () => {
    for (const [tool, args, line, query] of CASES) {
      const a = act(tool, args);
      expect(a, JSON.stringify(args)).not.toBeNull();
      expect(a!.line, JSON.stringify(args)).toBe(line);
      expect(activityQuery(a!), JSON.stringify(args)).toBe(query);
    }
  });

  it('never puts the verb in the query', () => {
    for (const [tool, args, line] of CASES) {
      const verb = line.split(' ', 1)[0];
      expect(activityQuery(act(tool, args)!).startsWith(`${verb} `), line).toBe(false);
    }
  });

  it('P1: a path is sent only relative to the project root it resolves inside', () => {
    expect(act('read_file', { path: 'src/billing/invoice.py' })!.query).toBe('src/billing/invoice.py');
    expect(act('read_file', { path: `${PROJ}/src/x.py` })!.query).toBe('src/x.py');
    expect(act('read_file', { path: '/etc/passwd' })).toBeNull();
    expect(act('read_file', { path: '../outside.txt' })).toBeNull();
    expect(act('read_file', { path: 'src/x.py' }, '')).toBeNull(); // no cwd
    expect(act('read_file', { path: 'src/x.py' }, NO_ROOT)).toBeNull(); // no marker anywhere up the walk
    expect(act('read_file', { path: 'a:b.py' })).toBeNull(); // `:` outside a drive prefix
    expect(act('read_file', { path: `src/${'d/'.repeat(120)}f.py` })).toBeNull(); // > 200 chars: never cut
  });

  it('P3a: a script, a path or a dotted program gives no query', () => {
    for (const command of ['./acme_export.sh', '/usr/local/bin/python3 -m pytest', '~/bin/tool', 'C:\\x\\y.exe',
      'acme_export.sh --all', 'node.js x', '../run test']) {
      expect(act('terminal', { command }), command).toBeNull();
    }
    expect(act('terminal', { command: 'python3.11 -m pytest' })!.query).toBe('python3.11 pytest');
  });

  it('P3c: python -m sends a known module, or one whose top package is in the project', () => {
    expect(act('terminal', { command: 'python -m http.server 8000' })!.query).toBe('python http.server');
    expect(act('terminal', { command: 'python -m billing.cli' })!.query).toBe('python');
    mkdirSync(nodePath.join(PROJ, 'src', 'billing'), { recursive: true });
    resetActivityCaches();
    expect(act('terminal', { command: 'python -m billing.cli' })!.query).toBe('python billing.cli');
    writeFileSync(nodePath.join(PROJ, 'tool.py'), '');
    expect(act('terminal', { command: 'python -m tool' })!.query).toBe('python tool');
    expect(act('terminal', { command: 'python -m tool' }, NO_ROOT)!.query).toBe('python'); // no root: not sent
  });

  it('P2: a path, a search pattern or a program that names the user gives nothing', () => {
    expect(act('read_file', { path: 'notes/alice.txt' })).toBeNull();
    expect(act('read_file', { path: 'notes/Alice-notes.md' })).toBeNull();
    expect(act('search_files', { pattern: 'alice todo' })).toBeNull();
    expect(act('terminal', { command: 'alice --help' })).toBeNull();
    // a name in a subcommand or -m module sends the program alone
    expect(act('terminal', { command: 'git alice' })!.query).toBe('git');
    expect(act('terminal', { command: 'python -m alice_tools' })!.query).toBe('python');
  });

  it('P2: the user names come from the environment and the process identity', () => {
    expect([...userNames({ USER: 'Alice', HOME: '/Users/alice', USERPROFILE: 'C:\\Users\\Bob' })].sort())
      .toEqual(expect.arrayContaining(['alice', 'bob']));
    expect(userNames({ USER: 'node' }).has('node')).toBe(false); // service account
    expect(userNames({ HOME: '/config' }).has('config')).toBe(false); // parent is not Users/home/Profiles
    expect(nameHit('jo.md', new Set(['jo']))).toBe(true);
    expect(nameHit('join.py', new Set(['jo']))).toBe(false);
    expect(nameHit('john_smith.md', new Set(['john smith']))).toBe(true);
    expect(nameHit('jo\u2013notes.md', new Set(['jo']))).toBe(true);
  });

  it('P4: search allowlist; a path argument goes through P1', () => {
    for (const pattern of ['**/*.ts', 'src/billing', '\\w+', '--password hunter2', 'Bearer abc', 'token x',
      'password:letmein', 'x@corp.com', 'w1 w2 w3 w4 w5 w6 w7', 'y'.repeat(81), 'API_KEY="x"']) {
      expect(act('search_files', { pattern }), pattern).toBeNull();
    }
    expect(act('search_files', { pattern: 'MCP tool name' })!.query).toBe('MCP tool name');
    expect(act('search_files', { pattern: 'café menü' })!.query).toBe('café menü');
    expect(act('search_files', { pattern: 'TODO', path: 'src' })!.line).toBe('search TODO in src');
    expect(act('search_files', { pattern: 'TODO', path: '/etc' })!.line).toBe('search TODO'); // outside: path part dropped
    expect(act('search_files', { pattern: 'TODO', path: 'alice' })).toBeNull(); // a name hit: nothing
  });

  it('keys: the same query in two places is two keys; read then edit is one', () => {
    const a = act('search_files', { pattern: 'TODO', path: '/srv/a' })!;
    const b = act('search_files', { pattern: 'TODO', path: '/srv/b' })!;
    expect(a.query).toBe(b.query);
    expect(a.key).not.toBe(b.key);
    expect(act('read_file', { path: 'src/x.ts' })!.key).toBe(act('patch', { path: `${PROJ}/src/x.ts` })!.key);
  });

  it('randomized paths: every query resolves strictly inside the project root (symlink escape included)', () => {
    mkdirSync(nodePath.join(PROJ, 'src', 'deep'), { recursive: true });
    const esc = nodePath.join(PROJ, 'esc');
    try {
      symlinkSync(NO_ROOT, esc, 'dir');
    } catch {
      /* already there */
    }
    const r = rng(20261017);
    const choice = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
    const parts = ['src', 'deep', '..', '.', 'esc', 'x.ts', 'alice', 'notes.md', '~'];
    const roots = ['', `${PROJ}/`, `${NO_ROOT}/`, '/', '~/', '../'];
    let sent = 0;
    for (let i = 0; i < 600; i++) {
      const p = choice(roots) + Array.from({ length: 1 + Math.floor(r() * 4) }, () => choice(parts)).join('/');
      const a = act('read_file', { path: p });
      if (a === null) continue;
      sent++;
      const q = activityQuery(a);
      expect(q, p).not.toMatch(/alice|^\/|\.\./);
      const realTarget = realpathOr(nodePath.join(PROJ, q));
      expect(realTarget.startsWith(`${PROJ}/`), `${p} → ${q}`).toBe(true);
    }
    expect(sent).toBeGreaterThan(50);
  });

  it('project roots are cached (30 s found, 2 s none) and reset for tests', () => {
    expect(projectRoot(PROJ, ENV)).toBe(PROJ);
    expect(projectRoot(NO_ROOT, ENV)).toBeNull();
    writeFileSync(`${NO_ROOT}/.curated-thoughts-project`, '');
    resetActivityCaches();
    expect(projectRoot(NO_ROOT, ENV)).toBe(NO_ROOT);
  });

  it('gives no line for unsafe or unknown calls', () => {
    const cases: Array<[string, unknown]> = [
      ['patch', { mode: 'patch', patch: '*** Update File: a.py\n+SECRET' }],
      ['execute_code', { code: "print('SECRET')" }],
      ['web_search', { query: 'secret' }],
      ['read_file', {}],
      ['read_file', { path: 7 }],
      ['terminal', { command: '' }],
      ['terminal', { command: 'A=1 B=2' }],
      ['terminal', { command: "'unterminated" }],
      ['terminal', { command: '$(cat secret)' }],
      ['terminal', { command: 42 }],
      ['search_files', { pattern: '' }],
      ['read_file', 'not-a-dict'],
    ];
    for (const [tool, args] of cases) {
      expect(act(tool, args), `${tool} ${JSON.stringify(args)}`).toBeNull();
    }
  });

  it('recognizes CT tools', () => {
    for (const name of [
      'mcp__curated-thoughts__curated_recall_context',
      'mcp_curated_thoughts_curated_get_wiki_entry',
      'curated_recall_context',
      'mcp__curated-thoughts__wiki_context',
      'curated-thoughts__curated_proposals_list',
    ]) {
      expect(isCtTool(name), name).toBe(true);
    }
    for (const name of ['read_file', 'terminal', 'search_files', 'mcp__github__search', 'bash', 7]) {
      expect(isCtTool(name), String(name)).toBe(false);
    }
  });

  it('never carries secret args into the line or query', () => {
    const secret = 'SUPERSECRET';
    for (const [tool, args] of [
      ['write_file', { path: 'a.py', content: secret }],
      ['patch', { path: 'a.py', old_string: secret, new_string: secret, patch: secret }],
      ['read_file', { path: 'a.py', offset: 1, limit: secret }],
      ['search_files', { pattern: 'p', file_glob: secret, context: secret }],
      ['terminal', { command: 'ls', workdir: secret }],
    ] as Array<[string, Record<string, unknown>]>) {
      const a = act(tool, args)!;
      expect(a.line).not.toContain(secret);
      expect(activityQuery(a)).not.toContain(secret);
    }
  });

  it('randomized commands are secret-safe (500 iterations)', () => {
    const r = rng(20261016);
    const choice = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
    const words = ['git', 'npm', 'pytest', 'make', 'python', 'status', 'test', 'build', 'src/a.py'];
    const nasty = ['sk-ABCDEF1234567890xyz', 'ghp_0123456789abcdefABCD', 'user:pw@host',
      'https://u:p@h/x', '$TOKEN', '${SECRET}', 'A=B', "'quoted secret'",
      '"dq secret"', '--password=hunter2', '-pHUNTER2', 'AKIAABCDEFGHIJKLMNOP',
      'xoxb-123-456', 'a1b2c3d4e5f6g7h8i9j0', '|', '&&', ';', '>', 'out.txt'];
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(r() * 7);
      const parts = Array.from({ length: n }, () => choice([...words, ...nasty]));
      const command = parts.join(' ');
      const a = act('terminal', { command });
      if (a === null) continue;
      checked++;
      const query = activityQuery(a);
      const tokens = query.split(' ');
      expect(tokens.length, command).toBeLessThanOrEqual(2);
      for (const ch of "=@:$'\"|&;<>") expect(query, command).not.toContain(ch);
      for (const bad of ['sk-', 'ghp_', 'AKIA', 'xox', 'hunter2', 'HUNTER2', 'a1b2c3']) {
        expect(query, command).not.toContain(bad);
      }
      let raw: string[];
      try {
        raw = posixSplit(command);
      } catch {
        raw = command.split(/\s+/).filter(Boolean);
      }
      const names = raw.map(basename);
      for (const token of tokens) expect([...raw, ...names], command).toContain(token);
      if (tokens.length === 2) {
        const at = names.indexOf(tokens[0]);
        const after = raw.slice(at + 1);
        const ok = after[0] === tokens[1] || (after[0] === '-m' && after[1] === tokens[1]);
        expect(ok, command).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('rejects credential-shaped search patterns', () => {
    for (const pattern of ['sk-live-abcdef', 'find ghp_abcdefghijklmnop1234 here',
      'AKIAABCDEFGHIJKLMNOP', 'token a1b2c3d4e5f6g7h8i9']) {
      expect(act('search_files', { pattern }), pattern).toBeNull();
    }
    expect(act('search_files', { pattern: 'error 404' })).not.toBeNull();
  });

  it('never uses our own marker or heading as a target', () => {
    for (const pattern of ['ct-fact:evil', '## Curated Thoughts \u2014 relevant now', 'a\nb']) {
      expect(act('search_files', { pattern })).toBeNull();
    }
  });

  it('caps the query and the target', () => {
    expect(act('search_files', { pattern: 'x'.repeat(81) })).toBeNull(); // refused, not cut
    const a = act('search_files', { pattern: 'x'.repeat(80), path: 'y'.repeat(600) })!;
    expect(activityQuery(a).length).toBeLessThanOrEqual(ACTIVITY_QUERY_CHARS);
    expect(a.query.length).toBeLessThanOrEqual(ACTIVITY_TARGET_CHARS);
  });

  it('tokenizes like Python shlex.split(posix=False)', () => {
    expect(shellWords('a "b c" d')).toEqual(['a', '"b c"', 'd']);
    expect(shellWords('a"b c"')).toEqual(['a"b', 'c"']);
    expect(shellWords('"ab"cd')).toEqual(['"ab"', 'cd']);
    expect(() => shellWords("'open")).toThrow();
  });
});

describe('ActivityTracker (rate rule)', () => {
  const key = (tool: string, path: string) => act(tool, { path })!.key;

  it('starts one query per step', () => {
    const st = new ActivityTracker();
    expect(st.admit('s', 'm1', key('read_file', 'a.py'))).toBeNull();
    expect(st.admit('s', 'm1', key('read_file', 'b.py'))).toBe('step_used');
    expect(st.admit('s', 'm2', key('read_file', 'b.py'))).toBeNull();
  });

  it('folds read/write/edit into one file key; a rejected key does not use the step', () => {
    const st = new ActivityTracker();
    expect(st.admit('s', 'r1', key('read_file', 'a.py'))).toBeNull();
    expect(st.admit('s', 'r2', key('patch', 'a.py'))).toBe('seen_key');
    expect(st.admit('s', 'r3', key('write_file', 'a.py'))).toBe('seen_key');
    expect(st.admit('s', 'r3', key('read_file', 'c.py'))).toBeNull();
  });

  it('is LRU-bounded and per session', () => {
    const st = new ActivityTracker();
    for (let i = 0; i <= ACTIVITY_RECENT_KEYS_MAX; i++) {
      expect(st.admit('s', `r${i}`, key('read_file', `f${i}.py`))).toBeNull();
    }
    expect(st.admit('s', 'rx', key('read_file', 'f0.py'))).toBeNull();
    expect(st.admit('other', 'r1', key('read_file', 'f1.py'))).toBeNull();
  });

  it('keeps run and search keys distinct from each other', () => {
    const st = new ActivityTracker();
    expect(st.admit('s', 'r1', act('terminal', { command: 'make test' })!.key)).toBeNull();
    expect(st.admit('s', 'r2', act('search_files', { pattern: 'make test' })!.key)).toBeNull();
    expect(st.admit('s', 'r3', act('terminal', { command: 'make test -j4' })!.key)).toBe('seen_key');
  });

  it('peek records nothing; firstReport is once per step', () => {
    const st = new ActivityTracker();
    const k = key('read_file', 'a.py');
    expect(st.peek('s', 'r1', k)).toBeNull();
    expect(st.admit('s', 'r1', k)).toBeNull();
    expect(st.peek('s', 'r1', k)).toBe('step_used');
    expect(st.firstReport('s', 'r1')).toBe(true);
    expect(st.firstReport('s', 'r1')).toBe(false);
    st.reset();
    expect(st.admit('s', 'r1', k)).toBeNull();
  });
});

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  text: `Body of ${id}`,
  supersedes: [] as string[],
  provenance: 'stated',
  ...over,
});

function ledgerOf(ids: string[]): Ledger {
  const set = new Set(ids);
  return { idsMostRecentFirst: [...ids], has: (id) => set.has(id), knownBootstrap: false };
}

const READ = buildActivity({ verb: 'read', path: 'src/x.ts' }, PROJ, ENV)!;

describe('activity block', () => {
  it('is marker first, within 600 chars, with provenance and one marker', () => {
    const block = renderActivityBlock(item('f1', { text: 'word '.repeat(400) }), [], READ);
    expect(block.length).toBeLessThanOrEqual(ACTIVITY_MAX_BLOCK_CHARS);
    expect(block.startsWith(`${ACTIVITY_HEADING}\n_for: read src/x.ts_\n\n`)).toBe(true);
    expect(block.endsWith('…')).toBe(true);
    const m = block.indexOf(marker('f1'));
    const t = block.indexOf('**Title f1**');
    const b = block.indexOf('word');
    expect(m).toBeGreaterThan(-1);
    expect(m).toBeLessThan(t);
    expect(t).toBeLessThan(b);
    expect(block).toContain('(provenance: stated)');
    expect(block.split('ct-fact:').length - 1).toBe(1);
  });

  it('renders the exact short shape', () => {
    expect(renderActivityBlock(item('f1'), [], READ)).toBe(
      `${ACTIVITY_HEADING}\n_for: read src/x.ts_\n\n<!-- ct-fact:f1 --> **Title f1** (provenance: stated)\nBody of f1`,
    );
  });

  it('strips forged markers and labels unlabeled provenance', () => {
    const block = renderActivityBlock(
      item('f1', { title: 'evil ct-fact:x', text: 'ct-fact:y body', provenance: null }), [], READ);
    expect(scanIds(block)).toEqual(['f1']);
    expect(block).toContain('(provenance: unlabeled)');
  });

  it('marks a correction with what it supersedes', () => {
    const block = renderActivityBlock(item('c1'), ['old'], READ);
    expect(block).toContain('— supersedes ct-fact:old');
  });

  it('is empty for an item with no content or an invalid id', () => {
    expect(renderActivityBlock(item('f1', { title: '', text: '  ' }), [], READ)).toBe('');
    expect(renderActivityBlock(item('bad id!'), [], READ)).toBe('');
  });

  it('picks corrections that supersede the ledger first, skips ids in context', () => {
    const result: WisdomMatchResult = {
      entries: [item('f1'), item('f2')],
      corrections: [item('c_nope', { supersedes: ['absent'] }), item('c1', { supersedes: ['old'] })],
    };
    const cands = activityCandidates(result, ledgerOf(['old', 'f1']));
    expect(cands.map((c) => c.item.id)).toEqual(['c1', 'f2']);
    const sel = selectActivityDelivery(result, ledgerOf(['old']), READ)!;
    expect(sel.id).toBe('c1');
    expect(sel.block).toContain('supersedes ct-fact:old');
  });

  it('delivers one fact even if CT returns more', () => {
    const sel = selectActivityDelivery({ entries: [item('f1'), item('f2')], corrections: [] }, ledgerOf([]), READ)!;
    expect(scanIds(sel.block)).toEqual(['f1']);
  });

  it('returns null when nothing new survives', () => {
    expect(selectActivityDelivery({ entries: [item('f1')], corrections: [] }, ledgerOf(['f1']), READ)).toBeNull();
  });
});

function fakeHost(over: Partial<HostAdapter> & { outcome?: MatchOutcome; result?: WisdomMatchResult } = {}) {
  const calls: Array<{ query: string; max: number; exclude: string[] }> = [];
  let resets = 0;
  const host = {
    wisdomMatchAbsent: () => false,
    resetDiscoveryAndProbeCaches: () => {
      resets++;
    },
    wisdomMatch: async (query: string, max: number, exclude: string[]) => {
      calls.push({ query, max, exclude });
      return { outcome: over.outcome ?? 'ok', result: over.result };
    },
    ...over,
  } as unknown as HostAdapter;
  return { host, calls, resets: () => resets };
}

/** A HostAdapter with every gate switchable (the onUserTurn preconditions). */
function gateHost(over: Record<string, unknown> = {}) {
  const state = {
    enabled: true,
    restored: false,
    known: false,
    absent: false,
    ids: [] as string[],
    cached: null as Ledger | null,
    noted: [] as string[][],
    turns: [] as Array<Record<string, unknown>>,
    queries: [] as Array<{ query: string; max: number; exclude: string[] }>,
    result: { entries: [item('f1')], corrections: [] } as WisdomMatchResult,
    ...over,
  };
  const host = {
    deliveryEnabled: () => state.enabled,
    restored: () => state.restored,
    rebuildLedger: () => ({ ...ledgerOf(state.ids), knownBootstrap: state.known }),
    cacheLedger: (_s: unknown, l: Ledger) => {
      state.cached = l;
    },
    cachedLedger: () => state.cached,
    wisdomMatchAbsent: () => state.absent,
    resetDiscoveryAndProbeCaches: () => {},
    wisdomMatch: async (query: string, max: number, exclude: string[]) => {
      state.queries.push({ query, max, exclude });
      return { outcome: 'ok' as MatchOutcome, result: state.result };
    },
    noteDelivered: (_s: unknown, ids: string[]) => {
      state.noted.push(ids);
    },
    recordVerbose: (t: Record<string, unknown>) => {
      state.turns.push(t);
    },
  } as unknown as HostAdapter;
  return { host, state };
}

describe('core activity gates (startActivity / finishActivity)', () => {
  const S = { id: 's1' };

  it('runs behind every onUserTurn gate; a refused start makes no CT call', async () => {
    const cases: Array<[Record<string, unknown>, string, Breaker?]> = [
      [{ enabled: false }, 'delivery_off'],
      [{ restored: true, known: false }, 'restored_unknown_bootstrap'],
      [{ absent: true }, 'capability_missing'],
    ];
    for (const [over, reason] of cases) {
      const { host, state } = gateHost(over);
      expect(startActivity(host, S, READ, new Breaker()).failure, reason).toBe(reason);
      expect(state.queries).toEqual([]);
    }
    const open = new Breaker();
    for (let i = 0; i < BREAKER_FAILS; i++) open.recordFailure();
    expect(startActivity(gateHost().host, S, READ, open).failure).toBe('breaker_open');
    expect(startActivity(gateHost().host, { id: '' }, READ, new Breaker()).failure).toBe('no_session');
    // restored with a KNOWN bootstrap is fine (Hermes M2 semantics)
    expect(startActivity(gateHost({ restored: true, known: true }).host, S, READ, new Breaker()).failure).toBeNull();
  });

  it('excludes the ledger newest first, then delivers one fact, cached for the turn only', async () => {
    const { host, state } = gateHost({ ids: ['b', 'a'] });
    const start = startActivity(host, S, READ, new Breaker());
    expect(start.failure).toBeNull();
    const match = await (start as { match: Promise<unknown> }).match;
    expect(state.queries).toEqual([{ query: 'src/x.ts', max: 1, exclude: ['b', 'a'] }]);
    const block = finishActivity(host, S, READ, match as never)!;
    expect(scanIds(block)).toEqual(['f1']);
    // Never recorded beyond the turn (review of PR #56): the ledger is what
    // the agent sees, rebuilt from the host's persisted context, so a fact
    // whose message was rejected or compacted away can arrive again.
    expect(state.noted).toEqual([]);
    expect(state.cached!.has('f1') && state.cached!.has('a')).toBe(true);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ kind: 'delivery', channel: 'activity', query: 'src/x.ts',
      activity: 'read src/x.ts', deliveredIds: ['f1'], sessionId: 's1' });
  });

  it('a latch that turns OFF before delivery wins (e.g. a resume-OFF latch)', () => {
    const { host, state } = gateHost();
    state.enabled = false;
    expect(finishActivity(host, S, READ, { failure: null, result: state.result })).toBeNull();
    expect(state.noted).toEqual([]);
    expect(state.turns[0]).toMatchObject({ kind: 'skip', reason: 'delivery_off', channel: 'activity' });
  });

  it('reports budget, failures and zero hits; never throws', () => {
    const { host, state } = gateHost({ ids: ['f1'] });
    expect(finishActivity(host, S, READ, null)).toBeNull();
    expect(finishActivity(host, S, READ, { failure: 'timeout_or_exit' })).toBeNull();
    expect(finishActivity(host, S, READ, { failure: null, result: state.result })).toBeNull();
    expect(state.turns.map((t) => t.reason)).toEqual(['budget', 'timeout_or_exit', 'zero_hits']);
    const boom = { ...host, rebuildLedger: () => { throw new Error('boom'); } } as HostAdapter;
    expect(finishActivity(boom, S, READ, { failure: null, result: state.result })).toBeNull();
    expect(startActivity(boom, S, READ, new Breaker()).failure).toBe('hook_failed');
  });
});

describe('runActivityMatch', () => {
  it('asks CT for one fact with the bare target', async () => {
    const f = fakeHost({ result: { entries: [item('f1')], corrections: [] } });
    const b = new Breaker();
    const m = await runActivityMatch(f.host, READ, ['a', 'b'], b);
    expect(m.failure).toBeNull();
    expect(f.calls).toEqual([{ query: 'src/x.ts', max: 1, exclude: ['a', 'b'] }]);
  });

  it('classifies failures and feeds the shared breaker', async () => {
    const b = new Breaker();
    for (let i = 0; i < BREAKER_FAILS; i++) {
      const m = await runActivityMatch(fakeHost({ outcome: 'timeout_or_exit' }).host, READ, [], b);
      expect(m.failure).toBe('timeout_or_exit');
    }
    expect(b.isOpen()).toBe(true);
    const s = fakeHost({ outcome: 'spawn' });
    expect((await runActivityMatch(s.host, READ, [], new Breaker())).failure).toBe('spawn');
    expect(s.resets()).toBe(1);
    expect((await runActivityMatch(fakeHost({ outcome: 'ok' }).host, READ, [], new Breaker())).failure).toBe('parse_error');
    const absent = fakeHost({ wisdomMatchAbsent: () => true });
    expect((await runActivityMatch(absent.host, READ, [], new Breaker())).failure).toBe('capability_missing');
    expect(absent.calls).toEqual([]);
  });

  it('never throws', async () => {
    const boom = fakeHost({
      wisdomMatch: async () => {
        throw new Error('boom');
      },
    });
    expect((await runActivityMatch(boom.host, READ, [], new Breaker())).failure).toBe('hook_failed');
  });

  it('a success closes the breaker again', async () => {
    const b = new Breaker();
    b.recordFailure();
    b.recordFailure();
    await runActivityMatch(fakeHost({ result: { entries: [], corrections: [] } }).host, READ, [], b);
    b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });
});

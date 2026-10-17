import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  mcpToolsList,
  runChecks,
  cmdCheck,
  checkOpenclawRegistration,
  openclawConfigPath,
  parseJson5Lenient,
  checkImportPreflight,
  checkSidecarEnv,
  PASS, WARN, FAIL,
  type CheckResult,
} from '../scripts/ct_doctor.js';
import { sidecarCandidates } from '../scripts/ct_env.js';

// lib/scripts/ct_doctor.js is emitted by `pnpm run build`; lib/ is
// gitignored, so a fresh clone running `pnpm test` before `pnpm run build`
// has nothing to spawn. Skip like test_build_output.ts does, rather than
// failing on an empty child stdout.
const COMPILED_DOCTOR = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scripts', 'ct_doctor.js',
);
const built = existsSync(COMPILED_DOCTOR);

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-doctor-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CURATED_BRAIN_DIR;
  // Inherited host settings must not leak into the checks under test.
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.CT_ENGINE_PACKAGE_JSON;
  process.env.PATH = ''; // force a clean PATH so sidecar discovery is deterministic
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

function names(rs: CheckResult[]) {
  return rs.map((r) => `${r.name}:${r.status}`);
}

describe('runChecks', () => {
  it('reports FAIL on a clean machine with no sidecar and no brain', () => {
    const rs = runChecks();
    // Absolute system install locations are outside PATH/HOME isolation; on a
    // machine with CT installed the sidecar is legitimately found.
    if (!sidecarCandidates().some((p) => existsSync(p))) {
      expect(names(rs)).toContain(`sidecar-binary:${FAIL}`);
    }
    expect(names(rs)).toContain(`brain-dir:${FAIL}`);
  });

  it('reports WARN when the brain directory exists but config.json is missing', () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    process.env.CURATED_BRAIN_DIR = brainDir;
    const rs = runChecks();
    expect(names(rs).some((n) => n.startsWith('brain-dir:') && n.endsWith(':WARN'))).toBe(true);
  });
});

describe.skipIf(!built)('cmdCheck', () => {
  it('prints JSON when --json is passed', () => {
    // Capture stdout via a child process running the compiled doctor.
    // lib/scripts/ct_doctor.js is emitted by the root tsconfig.json
    // (rootDir "." compiles src/ → lib/src and scripts/ → lib/scripts).
    // Use process.execPath (absolute) instead of bare 'node' because the
    // test sets PATH='' to wipe the sidecar's PATH lookup — bare 'node'
    // would then ENOENT. Bare 'node' is what the plan's verbatim test had;
    // it failed with `spawnSync node ENOENT` so we resolve to the running
    // Node binary by absolute path. (Plan-bug pattern #5.)
    const out = spawnSync(process.execPath, [COMPILED_DOCTOR, 'check', '--json'], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, CURATED_BRAIN_DIR: join(tmpHome, 'brain'), PATH: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.exit_code).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe('checkOpenclawRegistration', () => {
  function writeConfig(text: string, dir = join(tmpHome, '.openclaw')): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'openclaw.json');
    writeFileSync(path, text);
    return path;
  }

  it('fails when no config exists', () => {
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain('no OpenClaw config');
  });

  it('fails when the plugin entry is missing', () => {
    writeConfig('{"plugins": {"entries": {}}}');
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain('missing');
  });

  it('fails without the conversation-access grant (prompt hooks are refused)', () => {
    writeConfig('{"plugins": {"entries": {"curated-thoughts": {"enabled": true}}}}');
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain('allowConversationAccess');
  });

  it('fails when the plugin is disabled', () => {
    writeConfig('{"plugins": {"entries": {"curated-thoughts": {"enabled": false, "hooks": {"allowConversationAccess": true}}}}}');
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain('disabled');
  });

  it('fails when prompt injection is explicitly denied', () => {
    writeConfig('{"plugins": {"entries": {"curated-thoughts": {"hooks": {"allowConversationAccess": true, "allowPromptInjection": false}}}}}');
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(FAIL);
  });

  it('passes on a JSON5 config with comments and trailing commas', () => {
    const path = writeConfig([
      '{',
      '  // OpenClaw config is JSON5',
      '  "plugins": {',
      '    "entries": {',
      '      /* ours */ "curated-thoughts": { "enabled": true, "hooks": { "allowConversationAccess": true, }, },',
      '    },',
      '  },',
      '}',
    ].join('\n'));
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(PASS);
    expect(r.detail).toContain(path);
  });

  it('honors OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR', () => {
    const body = '{"plugins": {"entries": {"curated-thoughts": {"hooks": {"allowConversationAccess": true}}}}}';
    const explicit = writeConfig(body, join(tmpHome, 'elsewhere'));
    expect(openclawConfigPath({ OPENCLAW_CONFIG_PATH: explicit })).toBe(explicit);
    expect(checkOpenclawRegistration({ ...process.env, OPENCLAW_CONFIG_PATH: explicit }).status).toBe(PASS);
    writeConfig(body, join(tmpHome, 'state'));
    expect(checkOpenclawRegistration({ ...process.env, HOME: tmpHome, OPENCLAW_STATE_DIR: '~/state' }).status).toBe(PASS);
  });

  it('warns when the user disabled the plugin-mounted MCP server', () => {
    writeConfig('{"plugins": {"entries": {"curated-thoughts": {"hooks": {"allowConversationAccess": true}}}}, "mcp": {"servers": {"curated-thoughts": {"enabled": false}}}}');
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(WARN);
  });

  it('warns (never a false FAIL) on JSON5 it cannot parse', () => {
    writeConfig('{ plugins: { entries: {} } }');
    const r = checkOpenclawRegistration({ ...process.env, HOME: tmpHome });
    expect(r.status).toBe(WARN);
  });

  it('parseJson5Lenient keeps comment-like text inside strings', () => {
    expect(parseJson5Lenient('{"a": "x // y", /* c */ "b": [1,],}')).toEqual({ a: 'x // y', b: [1] });
    expect(parseJson5Lenient("{'k': 'v\"q'}")).toEqual({ k: 'v"q' });
  });
});

// A sidecar that answers tools/list with a non-array `tools`. mcpToolsList
// documents "Never throws; every failure mode becomes a result with an error
// field" — a malformed payload must become a graceful result, not a TypeError
// out of .map() that aborts the whole doctor run with a stack trace.
// POSIX-only: the stub relies on a shebang, as the exec-bit test does.
function writeStub(dir: string, toolsLiteral: string): string {
  const stub = join(dir, 'fake-sidecar');
  writeFileSync(
    stub,
    // Absolute interpreter: beforeEach blanks PATH, so `env node` would
    // not resolve and the stub would never run.
    `#!${process.execPath}\n`
      + 'let b = "";\n'
      + 'process.stdin.on("data", (d) => { b += d; });\n'
      + 'process.stdin.on("end", () => {\n'
      + '  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{version:"2.5.0"}}}) + "\\n");\n'
      + `  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{tools:${toolsLiteral}}}) + "\\n");\n`
      + '});\n',
  );
  chmodSync(stub, 0o755);
  return stub;
}

describe.skipIf(process.platform === 'win32')('mcpToolsList with a malformed tools/list', () => {
  for (const [label, literal] of [
    ['a string', '"not-an-array"'],
    ['an object', '{"a":1}'],
    ['a number', '7'],
  ] as const) {
    it(`does not throw when tools is ${label}`, () => {
      const stub = writeStub(tmpHome, literal);
      let result!: ReturnType<typeof mcpToolsList>;
      expect(() => { result = mcpToolsList(stub, 10); }).not.toThrow();
      // Degrades to "no tools", which the tier check reports as a FAIL —
      // never a crash.
      expect(result.toolNames).toEqual([]);
    });
  }

  it('tolerates a malformed element inside a well-formed array', () => {
    const stub = writeStub(tmpHome, '[{"name":"wiki_context"},null,{}]');
    let result!: ReturnType<typeof mcpToolsList>;
    expect(() => { result = mcpToolsList(stub, 10); }).not.toThrow();
    expect(result.toolNames).toEqual(['wiki_context', '?', '?']);
  });

  it('still reads a well-formed tools array', () => {
    const stub = writeStub(tmpHome, '[{"name":"wiki_context"},{"name":"recall"}]');
    const result = mcpToolsList(stub, 10);
    expect(result.toolNames).toEqual(['wiki_context', 'recall']);
    expect(result.error).toBeNull();
  });
});

describe('checkImportPreflight', () => {
  const TOKEN = 'librarian-' + 'ab12'.repeat(8);
  // A token that lost its hex to the engine's setup() rewrite: 'mangled'.
  // A JSON ref would classify 'at_risk' and FAIL on the wrong branch.
  const MANGLED = 'librarian-ab12';

  let brainDir = '';

  afterEach(() => {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  });

  function seedBrain(
    rows: Array<{ id: number; ref: string; deletedAt: string | null }>,
  ) {
    brainDir = mkdtempSync(join(tmpdir(), 'ct-doctor-preflight-'));
    const dbPath = join(brainDir, 'brain.db');
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE llm_wiki_entries (
         id INTEGER PRIMARY KEY, source_ref TEXT, source_type TEXT,
         deleted_at TEXT
       );
       CREATE TABLE librarian_evidence (
         entry_id TEXT PRIMARY KEY, proposal_id TEXT, evidence_json TEXT,
         unanchored INTEGER NOT NULL DEFAULT 0, created_at INTEGER
       );`,
    );
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (id, source_ref, source_type, deleted_at)
       VALUES (?, ?, ?, ?)`,
    );
    const ev = db.prepare(
      `INSERT INTO librarian_evidence VALUES (?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(r.id, r.ref, 'librarian_inferred', r.deletedAt);
      // Evidence follows live token rows, so the missing-evidence WARN
      // stays out of the way unless a test asks for it.
      if (r.deletedAt === null && r.ref === TOKEN) {
        ev.run(String(r.id), 'prop_x', '{"evidence":[]}', 0, 0);
      }
    }
    db.close();
    return { brainDir, dbPath, configPath: join(brainDir, 'config.json') };
  }

  it('reports excluded soft-deleted rows in the PASS detail', () => {
    const paths = seedBrain([
      { id: 1, ref: TOKEN, deletedAt: null },
      { id: 2, ref: MANGLED, deletedAt: '2026-01-01' },
      { id: 3, ref: TOKEN, deletedAt: '2026-01-02' },
    ]);
    const r = checkImportPreflight({ brainPaths: paths });
    expect(r.status).toBe('PASS');
    expect(r.detail).toContain(
      '; 2 soft-deleted rows excluded from this census '
        + '(1 with mangled source_refs)',
    );
  });

  it('omits the suffix when there are no soft-deleted rows', () => {
    const paths = seedBrain([{ id: 1, ref: TOKEN, deletedAt: null }]);
    const r = checkImportPreflight({ brainPaths: paths });
    expect(r.status).toBe('PASS');
    expect(r.detail).not.toContain('soft-deleted');
  });
});

describe('checkSidecarEnv (OpenClaw gives a plugin stdio server only the MCP SDK default env)', () => {
  const SECRET = 'sk-or-v1-FAKE-DO-NOT-PRINT-0123456789';
  const FORWARDING_ROW = { mcp: { servers: { 'curated-thoughts': {
    command: 'curated-thoughts-mcp', args: ['--mcp'], env: { OPENROUTER_API_KEY: '${OPENROUTER_API_KEY}' },
  } } } };

  beforeEach(() => {
    for (const k of ['EMBED_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST']) {
      delete process.env[k];
    }
  });

  function brain(profile: Record<string, unknown> | null): void {
    const dir = join(tmpHome, '.brain');
    mkdirSync(dir, { recursive: true });
    const cfg: Record<string, unknown> = { vault_path: tmpHome };
    if (profile) cfg.embed_profile = profile;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  }

  function openclawConfig(body: unknown): void {
    const dir = join(tmpHome, '.openclaw');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(body));
  }

  function check(env: NodeJS.ProcessEnv = {}): CheckResult {
    const r = checkSidecarEnv(undefined, { ...process.env, ...env });
    expect(r.detail + (r.hint ?? '')).not.toContain(SECRET);
    return r;
  }

  it('passes when the brain embeds locally', () => {
    brain({ type: 'local', model: 'nomic-embed-code' });
    expect(check().status).toBe(PASS);
  });

  it('passes when the profile carries its own key', () => {
    brain({ type: 'external', model: 'm', api_key: SECRET });
    expect(check().status).toBe(PASS);
  });

  it('warns with a full mcp.servers row when only the manifest row exists', () => {
    brain({ type: 'external', model: 'qwen/qwen3-embedding-4b' });
    openclawConfig({ plugins: { entries: { 'curated-thoughts': {} } } });
    const r = check({ OPENROUTER_API_KEY: SECRET });
    expect(r.status).toBe(WARN);
    expect(r.detail).toContain("plugin's manifest row");
    expect(r.hint).toContain('"OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}"');
    expect(r.hint).toContain('command: "curated-thoughts-mcp"');
  });

  it('names OPENAI_API_KEY for a non-openrouter base_url', () => {
    brain({ type: 'external', base_url: 'https://api.openai.com/v1', model: 'm' });
    expect(check().hint).toContain('"OPENAI_API_KEY": "${OPENAI_API_KEY}"');
  });

  it('passes when the user row forwards the key and it is set', () => {
    brain({ type: 'external', model: 'm' });
    openclawConfig(FORWARDING_ROW);
    expect(check({ OPENROUTER_API_KEY: SECRET }).status).toBe(PASS);
  });

  it('warns when the forwarded key is unset', () => {
    brain({ type: 'external', model: 'm' });
    openclawConfig(FORWARDING_ROW);
    const r = check();
    expect(r.status).toBe(WARN);
    expect(r.detail).toContain('not set in this environment');
  });

  it('asks for a custom brain dir as an absolute path', () => {
    brain({ type: 'local', model: 'm' });
    const custom = join(tmpHome, 'brains', 'work');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'config.json'), '{}');
    const r = check({ CURATED_BRAIN_DIR: custom });
    expect(r.status).toBe(WARN);
    expect(r.hint).toContain(`"CURATED_BRAIN_DIR": ${JSON.stringify(custom)}`);
  });

  it('flags a forwarded brain dir that points elsewhere, accepts a match', () => {
    brain({ type: 'local', model: 'm' });
    const custom = join(tmpHome, 'brains', 'work');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'config.json'), '{}');
    const row = (dir: string) => ({ mcp: { servers: { 'curated-thoughts': {
      command: 'curated-thoughts-mcp', args: ['--mcp'], env: { CURATED_BRAIN_DIR: dir },
    } } } });
    openclawConfig(row(join(tmpHome, 'brains', 'other')));
    const r = check({ CURATED_BRAIN_DIR: custom });
    expect(r.status).toBe(WARN);
    expect(r.detail).toContain('different brain location');
    openclawConfig(row(custom));
    expect(check({ CURATED_BRAIN_DIR: custom }).status).toBe(PASS);
    openclawConfig(row('${CURATED_BRAIN_DIR}'));
    expect(check({ CURATED_BRAIN_DIR: custom }).status).toBe(PASS);
  });

  it('is part of runChecks, right after embedding-backend', () => {
    const order = runChecks().map((r) => r.name);
    expect(order.indexOf('sidecar-env')).toBe(order.indexOf('embedding-backend') + 1);
  });
});

// --------------------------------------------------------------------------
// Isolation guard (live-brain incident, 2026-10-17): the doctor probes the CT
// sidecar, which opens the brain under HOME. A test that spawns the doctor
// must therefore say `HOME:` in the same call. This scans every tests/*.ts
// source: for each spawn/execFile call whose text mentions the doctor
// (DOCTOR_RE), the balanced call text must contain `HOME:`. Parens inside
// string literals are not parsed (the scan is deliberately simple).
// Known limits: not string-aware; it checks for HOME: only (not USERPROFILE or
// CURATED_BRAIN_DIR); and this guard is copied into each host suite.
// --------------------------------------------------------------------------

describe('test isolation guard: doctor spawns override HOME', () => {
  const DOCTOR_RE = /ct_doctor\.js|libDoctor|COMPILED_DOCTOR/;
  const CALL_RE = /\b(?:spawnSync|execFileSync)\(/g;
  const testsDir = dirname(fileURLToPath(import.meta.url));

  /** The guard's one predicate: a doctor call without an explicit HOME override. */
  function violates(call: string): boolean {
    return DOCTOR_RE.test(call) && !/\bHOME:/.test(call);
  }

  function callTexts(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(CALL_RE)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
        i += 1;
      }
      out.push(src.slice(m.index!, i));
    }
    return out;
  }

  it('every doctor spawn in tests/*.ts passes an explicit HOME:', () => {
    const offenders: string[] = [];
    let doctorCalls = 0;
    for (const f of readdirSync(testsDir).filter((n) => n.endsWith('.ts'))) {
      for (const call of callTexts(readFileSync(join(testsDir, f), 'utf8'))) {
        if (!DOCTOR_RE.test(call)) continue;
        doctorCalls += 1;
        if (violates(call)) offenders.push(`${f}: ${call.split('\n')[0]}`);
      }
    }
    expect(doctorCalls, 'the scan should find the doctor spawns').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('the scanner flags a doctor call without HOME: (self-check)', () => {
    const bad = callTexts("spawn" + "Sync(process.execPath, [libDoctor, 'check'], { env: { ...process.env } });");
    expect(bad).toHaveLength(1);
    expect(violates(bad[0]!)).toBe(true);
    expect(violates("spawn" + "Sync(process.execPath, [libDoctor], { env: { HOME: h } });")).toBe(false);
  });
});

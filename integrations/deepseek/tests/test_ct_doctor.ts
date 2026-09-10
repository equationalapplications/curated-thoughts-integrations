import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  mcpToolsList,
  runChecks,
  cmdCheck,
  checkDshRegistration,
  checkImportPreflight,
  PASS, WARN, FAIL,
  type CheckResult,
} from '../scripts/ct_doctor.js';

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
    expect(names(rs)).toContain(`sidecar-binary:${FAIL}`);
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
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, PATH: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.exit_code).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

describe('checkDshRegistration', () => {
  function writeCordisYml(text: string): void {
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(join(tmpHome, 'cordis.yml'), text);
  }

  it('passes when the mcp-client entry is the LAST list item (appended shape)', () => {
    // Regression: the block-end lookahead used Python's `\Z`, which is a
    // literal `Z` in JS — an mcp-client entry as the final list item (the
    // common appended shape) never matched and the doctor false-FAILed a
    // valid config.
    writeCordisYml(
      [
        "- name: '@equational-applications/dsh-curated-thoughts'",
        '  config:',
        '    brainDir: ~/.brain',
        "- name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        "    serverName: 'curated-thoughts'",
        '    transport: stdio',
        '',
      ].join('\n'),
    );
    const r = checkDshRegistration({ ...process.env, DSH_HOME: tmpHome });
    expect(r.status).toBe(PASS);
  });

  it('detects the server when the mcp-client block itself contains a literal Z', () => {
    // The old `\Z` truncated the captured block at any `Z` character.
    // Plugin entry absent → WARN is the correct verdict for a detected
    // server mount; the old bug produced FAIL here instead.
    writeCordisYml(
      [
        "- name: '@deepseek-ai/dsh-mcp-client'",
        '  config:',
        '    # Zone: main',
        "    serverName: 'curated-thoughts'",
        '',
      ].join('\n'),
    );
    const r = checkDshRegistration({ ...process.env, DSH_HOME: tmpHome });
    expect(r.status).toBe(WARN);
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

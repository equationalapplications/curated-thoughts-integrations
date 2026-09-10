import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { censusSourceRefs, detectEngineVersion } from '../scripts/ct_preflight.js';

// A well-formed post-#188 token: 'librarian-' + exactly 32 lowercase hex chars
// (PR #188 §2.2). The plan's literal 'ct_token:abc123' is not a valid token
// under the normative regex; using a real token keeps the assertion true.
const TOKEN = 'librarian-' + 'ab12cd34ef5678901234abcd56789012';
// A token that lost its hex to the engine's setup() rewrite: 'mangled'. A
// JSON ref would classify 'at_risk' (verified — see classifySourceRef), so
// the truncated-token shape is the right post-rewrite corpse fixture.
const MANGLED = 'librarian-ab12';
// Whitespace-padded: the engine would rewrite it, so 'at_risk'.
const AT_RISK = `  ${TOKEN}`;

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ct-preflight-'));
  dbPath = join(tmpDir, 'brain.db');
  const db = new Database(dbPath);
  // shared schema includes deleted_at so existing rows default to NULL
  // (live); 2026-09-10 live-scope cases insert against it directly.
  db.exec(`
    CREATE TABLE llm_wiki_entries (
      id INTEGER PRIMARY KEY,
      source_ref TEXT,
      source_type TEXT,
      deleted_at TEXT
    );
  `);
  db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('censusSourceRefs', () => {
  it('returns no damage when the table is empty', () => {
    const c = censusSourceRefs(dbPath);
    expect(c.error).toBeNull();
    expect(c.total).toBe(0);
    expect(c.damaged).toBe(0);
    expect(c.atRisk).toBe(0);
  });

  it('classifies rows whose source_ref is engine-proof token', () => {
    const db = new Database(dbPath);
    // source_type='librarian_inferred' (§2.5.1 scope). The plan's verbatim
    // fixture used 'vault_note' which would be filtered out of the census.
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run(TOKEN, 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.tokens).toBe(1);
    expect(c.damaged).toBe(0);
    expect(c.atRisk).toBe(0);
  });

  it('flags rows with structured JSON source_ref as at_risk', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('{"note_id":"n1"}', 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.atRisk).toBeGreaterThanOrEqual(1);
  });

  it('flags rows with whitespace-padded source_ref as at_risk', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('  ' + TOKEN + '  ', 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.atRisk).toBeGreaterThanOrEqual(1);
  });

  it('returns error when brain.db is missing', () => {
    const c = censusSourceRefs(join(tmpDir, 'absent.db'));
    // Python source uses 'brain database not found' (no '.db' substring);
    // match that message rather than the plan's /brain\.db/ literal.
    expect(c.error).toMatch(/brain/i);
  });

  // --- live-row scoping (2026-09-10 spec) --------------------------------

  it('excludes soft-deleted rows and counts them separately', () => {
    const db = new Database(dbPath);
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type, deleted_at)
       VALUES (?, ?, ?)`,
    );
    ins.run(TOKEN, 'librarian_inferred', null);
    ins.run(TOKEN, 'librarian_inferred', null);
    ins.run(MANGLED, 'librarian_inferred', '2026-01-01');
    ins.run(MANGLED, 'librarian_inferred', '2026-01-02');
    ins.run(TOKEN, 'librarian_inferred', '2026-01-03');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.error).toBeNull();
    expect(c.total).toBe(2);
    expect(c.damaged).toBe(0);
    expect(c.deadRows).toBe(3);
    // The token corpse is healthy; only the two truncated ones are mangled.
    expect(c.deadMangled).toBe(2);
  });

  it('counts dead rows scoped to librarian_inferred', () => {
    const db = new Database(dbPath);
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type, deleted_at)
       VALUES (?, ?, ?)`,
    );
    ins.run(TOKEN, 'librarian_inferred', null);
    ins.run(MANGLED, 'librarian_inferred', '2026-01-01');
    ins.run('{"json":"doc"}', 'document', '2026-01-01');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.deadRows).toBe(1);
    expect(c.deadMangled).toBe(1);
  });

  it('excludes at_risk corpses from deadMangled', () => {
    const db = new Database(dbPath);
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type, deleted_at)
       VALUES (?, ?, ?)`,
    );
    ins.run(TOKEN, 'librarian_inferred', null);
    ins.run(AT_RISK, 'librarian_inferred', '2026-01-01');
    ins.run(MANGLED, 'librarian_inferred', '2026-01-02'); // mangled
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.deadRows).toBe(2);
    expect(c.deadMangled).toBe(1);
  });

  it('is a no-op on a schema with no deleted_at column', () => {
    const legacyPath = join(tmpDir, 'legacy.db');
    const db = new Database(legacyPath);
    db.exec(
      `CREATE TABLE llm_wiki_entries (
         id INTEGER PRIMARY KEY, source_ref TEXT, source_type TEXT
       );`,
    );
    db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`,
    ).run(MANGLED, 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(legacyPath);
    expect(c.total).toBe(1);
    expect(c.damaged).toBe(1);
    expect(c.deadRows).toBe(0);
    expect(c.deadMangled).toBe(0);
  });

  it('scopes by deleted_at even when source_type is absent', () => {
    const legacyPath = join(tmpDir, 'no-source-type.db');
    const db = new Database(legacyPath);
    db.exec(
      `CREATE TABLE llm_wiki_entries (
         id INTEGER PRIMARY KEY, source_ref TEXT, deleted_at TEXT
       );`,
    );
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, deleted_at) VALUES (?, ?)`,
    );
    ins.run(TOKEN, null);
    ins.run(MANGLED, '2026-01-01');
    db.close();
    const c = censusSourceRefs(legacyPath);
    expect(c.scoped).toBe(false);
    expect(c.total).toBe(1);
    expect(c.damaged).toBe(0);
    expect(c.deadRows).toBe(1);
    expect(c.deadMangled).toBe(1);
  });

  it('leaves the live census intact when the corpse query fails', () => {
    // Best-effort: an informational query must never degrade the census.
    // Force the corpse query to throw, proving the dead counts fall back to
    // 0 without an error result. Parity with the hermes port's
    // test_dead_row_query_failure_leaves_the_live_census_intact.
    const db = new Database(dbPath);
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type, deleted_at)
       VALUES (?, ?, ?)`,
    );
    ins.run(TOKEN, 'librarian_inferred', null);
    ins.run(MANGLED, 'librarian_inferred', '2026-01-01');
    db.close();

    const realPrepare = Database.prototype.prepare;
    const spy = vi
      .spyOn(Database.prototype, 'prepare')
      .mockImplementation(function (this: unknown, sql: string) {
        if (sql.includes('deleted_at IS NOT NULL')) {
          throw new Error('simulated mid-flight failure');
        }
        return realPrepare.call(this as never, sql);
      } as typeof Database.prototype.prepare);
    try {
      const c = censusSourceRefs(dbPath);
      expect(c.error).toBeNull();
      expect(c.total).toBe(1);
      expect(c.deadRows).toBe(0);
      expect(c.deadMangled).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('detectEngineVersion', () => {
  it('returns nulls when no sidecar path is given and engine is not present', () => {
    // The engine lookup is heuristic (Cargo.toml, package.json, dpkg).
    // With an isolated tmpDir and no sidecar, both are null.
    const r = detectEngineVersion();
    expect(r.version).toBeNull();
    expect(r.source).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { censusSourceRefs, detectEngineVersion } from '../scripts/ct_preflight.js';

// A well-formed post-#188 token: 'librarian-' + exactly 32 lowercase hex chars
// (PR #188 §2.2). The plan's literal 'ct_token:abc123' is not a valid token
// under the normative regex; using a real token keeps the assertion true.
const TOKEN = 'librarian-' + 'ab12cd34ef5678901234abcd56789012';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ct-preflight-'));
  dbPath = join(tmpDir, 'brain.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE llm_wiki_entries (
      id INTEGER PRIMARY KEY,
      source_ref TEXT,
      source_type TEXT
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

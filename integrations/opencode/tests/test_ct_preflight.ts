/**
 * test_ct_preflight.ts — census + engine-version tests for the OpenCode
 * pre-flight, mirroring the hermes/deepseek fixture suites (Step 5.6).
 *
 * Fixtures: live vs soft-deleted rows, legacy columns, null source_refs,
 * evidence gaps, missing anchors (engine mismatch), TEXT/INTEGER affinity.
 *
 * Parity gate: the three pre-flight ports (hermes .py, deepseek .ts,
 * opencode .ts) must stay logically identical — same SQL, same
 * classification, same recovery hints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  censusSourceRefs,
  classifySourceRef,
  detectEngineVersion,
  hasEvidenceTable,
} from '../scripts/ct_preflight.js';

// A well-formed post-#188 token: 'librarian-' + exactly 32 lowercase hex chars
// (PR #188 §2.2).
const TOKEN = 'librarian-' + 'ab12cd34ef5678901234abcd56789012';
// A token that lost its hex to the engine's setup() rewrite: 'mangled'.
const MANGLED = 'librarian-ab12';
// Whitespace-padded: the engine would rewrite it, so 'at_risk'.
const AT_RISK = `  ${TOKEN}`;

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

  it('classifies engine-proof token rows as healthy', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run(TOKEN, 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.tokens).toBe(1);
    expect(c.damaged).toBe(0);
    expect(c.atRisk).toBe(0);
    expect(c.scoped).toBe(true);
  });

  it('flags structured JSON source_ref rows as at_risk', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('{"note_id":"n1"}', 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.atRisk).toBeGreaterThanOrEqual(1);
  });

  it('flags whitespace-padded source_ref rows as at_risk', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('  ' + TOKEN + '  ', 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.atRisk).toBeGreaterThanOrEqual(1);
  });

  it('counts null source_ref rows separately, never as damaged (Step 5.6 fixture)', () => {
    const db = new Database(dbPath);
    const ins = db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`,
    );
    ins.run(null, 'librarian_inferred');
    ins.run(null, 'librarian_inferred');
    ins.run(TOKEN, 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.error).toBeNull();
    expect(c.nullRefCount).toBe(2);
    // Parity with ct_preflight.py: `total` counts classified (non-null)
    // rows; null refs are reported separately as nullRefCount.
    expect(c.total).toBe(1);
    expect(c.tokens).toBe(1);
    expect(c.damaged).toBe(0);
    expect(c.atRisk).toBe(0);
  });

  it('returns error when brain.db is missing', () => {
    const c = censusSourceRefs(join(tmpDir, 'absent.db'));
    expect(c.error).toMatch(/brain/i);
  });

  it('reports tablePresent: false on a brain without the entries table', () => {
    const p = join(tmpDir, 'fresh.db');
    const db = new Database(p);
    db.exec('CREATE TABLE other (x INTEGER);');
    db.close();
    const c = censusSourceRefs(p);
    expect(c.error).toBeNull();
    expect(c.tablePresent).toBe(false);
  });

  // --- live rows vs soft-deleted rows (Step 5.6 fixture) ------------------

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
    ins.run(MANGLED, 'librarian_inferred', '2026-01-02');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.deadRows).toBe(2);
    expect(c.deadMangled).toBe(1);
  });

  // --- legacy columns (Step 5.6 fixture) -----------------------------------

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

  // --- evidence gaps (Step 5.6 fixture) ------------------------------------

  it('counts token rows whose evidence is missing as damaged-with-missing-evidence', () => {
    const p = join(tmpDir, 'evidence-gap.db');
    const db = new Database(p);
    db.exec(
      `CREATE TABLE llm_wiki_entries (
         id INTEGER PRIMARY KEY, source_ref TEXT, source_type TEXT
       );
       CREATE TABLE librarian_evidence (
         entry_id TEXT PRIMARY KEY, proposal_id TEXT,
         evidence_json TEXT, unanchored INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER
       );`,
    );
    // Two tokens: one with evidence, one without → a provenance gap.
    db.prepare(
      `INSERT INTO llm_wiki_entries (id, source_ref, source_type) VALUES (?, ?, ?)`,
    ).run(1, TOKEN, 'librarian_inferred');
    db.prepare(
      `INSERT INTO llm_wiki_entries (id, source_ref, source_type) VALUES (?, ?, ?)`,
    ).run(2, 'librarian-' + 'ff11ee22dd33cc4455667788aabbccdd', 'librarian_inferred');
    db.prepare(`INSERT INTO librarian_evidence VALUES (?, ?, ?, ?, ?)`).run(
      '1', 'prop_x', '{"evidence":[]}', 0, 0,
    );
    db.close();
    const c = censusSourceRefs(p);
    expect(c.error).toBeNull();
    expect(c.tokens).toBe(2);
    expect(c.missingEvidenceRows).toBe(1);
  });

  it('reports evidenceTablePresent=false when token rows have no evidence table', () => {
    const p = join(tmpDir, 'no-evidence-table.db');
    const db = new Database(p);
    db.exec(
      `CREATE TABLE llm_wiki_entries (
         id INTEGER PRIMARY KEY, source_ref TEXT, source_type TEXT
       );`,
    );
    db.prepare(
      `INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`,
    ).run(TOKEN, 'librarian_inferred');
    db.close();
    const c = censusSourceRefs(p);
    expect(c.error).toBeNull();
    expect(c.evidenceTablePresent).toBe(false);
  });

  it('hasEvidenceTable distinguishes present/absent/missing-db', () => {
    expect(hasEvidenceTable(dbPath)).toBe(false);
    const db = new Database(dbPath);
    db.exec('CREATE TABLE librarian_evidence (entry_id TEXT PRIMARY KEY);');
    db.close();
    expect(hasEvidenceTable(dbPath)).toBe(true);
    expect(hasEvidenceTable(join(tmpDir, 'nope.db'))).toBeNull();
  });

  // --- missing anchors / engine mismatch (Step 5.6 fixture) ----------------

  it('counts unanchored evidence rows (missing anchors) via the unanchored column', () => {
    const p = join(tmpDir, 'unanchored.db');
    const db = new Database(p);
    db.exec(
      `CREATE TABLE llm_wiki_entries (
         id INTEGER PRIMARY KEY, source_ref TEXT, source_type TEXT
       );
       CREATE TABLE librarian_evidence (
         entry_id TEXT PRIMARY KEY, proposal_id TEXT,
         evidence_json TEXT, unanchored INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER
       );`,
    );
    db.prepare(
      `INSERT INTO llm_wiki_entries (id, source_ref, source_type) VALUES (?, ?, ?)`,
    ).run(1, TOKEN, 'librarian_inferred');
    db.prepare(`INSERT INTO librarian_evidence VALUES (?, ?, ?, ?, ?)`).run(
      '1', 'prop_x', '{"evidence":[]}', 1, 0,
    );
    db.close();
    const c = censusSourceRefs(p);
    expect(c.error).toBeNull();
    expect(c.unanchoredRows).toBe(1);
  });

  // Neither side's column affinity is a contract this repo controls, so the
  // entry_id match is exercised against both.
  for (const affinity of ['TEXT', 'INTEGER'] as const) {
    it(`matches evidence entry_id with ${affinity} affinity`, () => {
      const p = join(tmpDir, `evidence-${affinity}.db`);
      const db = new Database(p);
      db.exec(
        `CREATE TABLE llm_wiki_entries (
           id INTEGER PRIMARY KEY, source_ref TEXT, source_type TEXT
         );
         CREATE TABLE librarian_evidence (
           entry_id ${affinity} PRIMARY KEY, proposal_id TEXT,
           evidence_json TEXT, unanchored INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER
         );`,
      );
      db.prepare(
        `INSERT INTO llm_wiki_entries (id, source_ref, source_type)
         VALUES (?, ?, ?)`,
      ).run(1, TOKEN, 'librarian_inferred');
      db.prepare(`INSERT INTO librarian_evidence VALUES (?, ?, ?, ?, ?)`).run(
        affinity === 'TEXT' ? '1' : 1,
        'prop_x',
        '{"evidence":[]}',
        0,
        0,
      );
      db.close();
      const c = censusSourceRefs(p);
      expect(c.error).toBeNull();
      expect(c.tokens).toBe(1);
      expect(c.missingEvidenceRows).toBe(0);
    });
  }
});

describe('classifySourceRef', () => {
  it('token shape is exactly the generated SOURCE_REF_SHAPE', () => {
    expect(classifySourceRef(TOKEN)).toBe('token');
    // Upper-case hex is NOT a token (shape is lowercase-only).
    expect(classifySourceRef(TOKEN.toUpperCase())).toBe('mangled');
  });

  it('null, JSON, padded and truncated refs land in their own classes', () => {
    expect(classifySourceRef(null)).toBe('null');
    expect(classifySourceRef('{"a":1}')).toBe('at_risk');
    expect(classifySourceRef(`  ${TOKEN}  `)).toBe('at_risk');
    expect(classifySourceRef(MANGLED)).toBe('mangled');
  });
});

describe('detectEngineVersion', () => {
  it('reads the engine version from CT_ENGINE_PACKAGE_JSON (engine mismatch fixture)', () => {
    const manifest = join(tmpDir, 'engine-package.json');
    writeFileSync(manifest, JSON.stringify({ name: '@equationalapplications/core-llm-wiki', version: '7.0.9' }));
    const env = { CT_ENGINE_PACKAGE_JSON: manifest } as NodeJS.ProcessEnv;
    const r = detectEngineVersion(undefined, env);
    expect(r.version).toBe('7.0.9');
    expect(r.source).toBe(manifest);
  });

  it('returns nulls when the override points at nothing', () => {
    const env = { CT_ENGINE_PACKAGE_JSON: join(tmpDir, 'missing.json') } as NodeJS.ProcessEnv;
    const r = detectEngineVersion(undefined, env);
    expect(r.version).toBeNull();
    expect(r.source).toBeNull();
  });

  it('ignores a malformed override manifest', () => {
    const manifest = join(tmpDir, 'broken.json');
    writeFileSync(manifest, 'not json {');
    const env = { CT_ENGINE_PACKAGE_JSON: manifest } as NodeJS.ProcessEnv;
    const r = detectEngineVersion(undefined, env);
    expect(r.version).toBeNull();
  });
});

// --- Step 5.5: better-sqlite3 is a lazy, optional dependency ----------------

describe('lazy better-sqlite3 (Step 5.5)', () => {
  it('importing the module never touches the native binding until a census runs', async () => {
    // If better-sqlite3 were a static import, a missing native build would
    // crash the doctor at import time. Importing the compiled module in a
    // fresh registry must therefore succeed regardless of the binding.
    await expect(import('../scripts/ct_preflight.js')).resolves.toBeTruthy();
  });

  it('a census on a missing DB degrades to an error result without throwing', () => {
    const c = censusSourceRefs(join(tmpDir, 'does-not-exist.db'));
    expect(c.error).not.toBeNull();
    expect(c.tablePresent).toBe(false);
  });
});

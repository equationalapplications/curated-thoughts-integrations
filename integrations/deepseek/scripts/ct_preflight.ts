/**
 * ct_preflight.ts — import pre-flight for a Curated Thoughts brain.
 *
 * Line-by-line port of integrations/hermes/scripts/ct_preflight.py. The
 * pre-flight check protects an imported graph before an agent trusts it:
 * two things can quietly destroy an imported graph before an agent ever
 * reads it, and both are checkable without writing a byte.
 *
 *  1. core-llm-wiki's setup() runs an unconditional legacy-ref back-rewrite
 *     selected by five predicates (TRIM != source, INSTR '/', INSTR '\',
 *     INSTR CHAR(0), GLOB '*[^-A-Za-z0-9._ ]*'). Every JSON-shaped
 *     source_ref qualifies and is rewritten to a normalizer fixed point
 *     with all evidence stripped. See curated-thoughts PR #188 §1.1/§2.2.
 *
 *  2. The post-#188 fix changes what a healthy row looks like: a
 *     normalizer-idempotent token (^librarian-[0-9a-f]{32}$) into
 *     source_ref, and the evidence in a CT-owned `librarian_evidence`
 *     table the engine never touches.
 *
 * Scope matters: §2.5.1 restricts the census to
 * `source_type = 'librarian_inferred'`. A legitimate document-sourced ref
 * can itself reach the 255-char cap (long vault paths normalize to exactly
 * 255) and is charset-legal, so an unscoped shape-based census would
 * classify healthy document rows as damaged.
 *
 * `NULL` refs are legitimate engine-era data, outside the central
 * invariant's scope; they are counted separately as `null_ref_count` for
 * visibility only.
 *
 * Read-only by construction: the database is opened through better-sqlite3
 * in readonly mode and no statement other than SELECT is ever issued.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVIDENCE_TABLE, REQUIRED_TABLES, SOURCE_REF_SHAPE } from './_compat_generated.js';

// --------------------------------------------------------------------------
// normative constants — token shape (PR #188 §2.2) and evidence table
// (§2.5.1) are declared in shared/compat.yaml. Never restate them here:
// _compat_generated.ts is regenerated from that file and byte-compared in CI,
// so a literal copy here would drift silently the moment the shape changes,
// and this census would start reporting healthy rows as mangled while
// ct_doctor.ts — which already imports these — disagreed on the same brain.
// Mirrors integrations/hermes/scripts/ct_preflight.py.
// --------------------------------------------------------------------------

export const TOKEN_RE = new RegExp(SOURCE_REF_SHAPE);
export { EVIDENCE_TABLE };
// The wiki entries table leads the required list (PR #188 §2.5.5 export order).
export const ENTRIES_TABLE = REQUIRED_TABLES[0]!;

// The engine's keep-set, verbatim from normalizeSourceRef (7.1.0 dist:4082).
const _NORMALIZE_STRIP = /[^A-Za-z0-9._\- ]/;
// Global variant for .replace(): without it only the FIRST illegal character
// is stripped. Keep _NORMALIZE_STRIP non-global — engineWouldRewrite calls
// .test() on it, and a global regex would carry lastIndex between calls.
const _NORMALIZE_STRIP_ALL = /[^A-Za-z0-9._\- ]/g;
const _NORMALIZE_CAP = 255;

// Row type the census and every verdict are scoped to (§2.5.1).
const LIBRARIAN_SOURCE_TYPE = 'librarian_inferred';

// Recovery-shape hints (§2.5.4). These distinguish which recovery path a
// damaged row would take; they are NOT used for detection.
interface RecoveryShape {
  readonly specPath: string;
  readonly description: string;
}
const _RECOVERY_SHAPES: ReadonlyArray<{
  readonly prefix: string;
  readonly specPath: string;
  readonly description: string;
}> = [
  // (prefix, spec path, what survived)
  {
    prefix: 'evidenceproposal_id',
    specPath: '§2.5.4b',
    description: 'proposal_id intact (empty-evidence serialization)',
  },
  {
    prefix: 'evidencechunk_id',
    specPath: '§2.5.4c',
    description: 'proposal_id truncated away; recover via content_hash',
  },
];

// Explicit override for locating the engine package, for installs where the
// bundled JS is not in a discoverable node_modules tree.
const ENV_ENGINE_PACKAGE = 'CT_ENGINE_PACKAGE_JSON';
const ENGINE_PACKAGE = '@equationalapplications/core-llm-wiki';

// --------------------------------------------------------------------------
// public types
// --------------------------------------------------------------------------

export type SourceRefState = 'null' | 'token' | 'at_risk' | 'mangled';

export interface Census {
  total: number;
  damaged: number;
  atRisk: number;
  tokens: number;
  missingEvidenceRows: number;
  unanchoredRows: number;
  evidenceTablePresent: boolean | null;
  tablePresent: boolean;
  scoped: boolean;
  shape: () => string;
  recoveryHints: Record<string, number>;
  error: string | null;
  counts: Record<string, number>;
  nullRefCount: number;
  // Soft-deleted rows, excluded from every count above. Informational
  // only: corpse accumulation is expected engine behavior (soft-delete
  // with no purge) and never affects a verdict.
  deadRows: number;
  // Of those corpses, how many classify as "mangled" — and only
  // "mangled". at_risk/token/null corpses are counted in deadRows but
  // not here, so the number matches the "with mangled source_refs"
  // wording of the operator-facing suffix.
  deadMangled: number;
}

interface CensusInit {
  counts?: Record<string, number>;
  total?: number;
  error?: string | null;
  tablePresent?: boolean;
  nullRefCount?: number;
  scoped?: boolean;
  recoveryHints?: Record<string, number>;
  missingEvidenceRows?: number;
  unanchoredRows?: number;
  evidenceTablePresent?: boolean | null;
  deadRows?: number;
  deadMangled?: number;
}

function makeCensus(init: CensusInit = {}): Census {
  const counts = init.counts ?? {};
  const recoveryHints = init.recoveryHints ?? {};
  const nullRefCount = init.nullRefCount ?? 0;
  return {
    counts,
    total: init.total ?? 0,
    error: init.error ?? null,
    tablePresent: init.tablePresent ?? false,
    nullRefCount,
    scoped: init.scoped ?? true,
    recoveryHints,
    missingEvidenceRows: init.missingEvidenceRows ?? 0,
    unanchoredRows: init.unanchoredRows ?? 0,
    evidenceTablePresent: init.evidenceTablePresent ?? null,
    deadRows: init.deadRows ?? 0,
    deadMangled: init.deadMangled ?? 0,
    shape() {
      const parts = Object.keys(counts)
        .sort()
        .map((k) => `${k}=${counts[k]}`);
      if (nullRefCount) {
        parts.push(`null_ref_count=${nullRefCount}`);
      }
      return parts.length > 0 ? parts.join(', ') : 'empty';
    },
    get damaged() {
      return counts['mangled'] ?? 0;
    },
    get atRisk() {
      return counts['at_risk'] ?? 0;
    },
    get tokens() {
      return counts['token'] ?? 0;
    },
  } as Census;
}

// --------------------------------------------------------------------------
// pure helpers — port of normalize_source_ref, engine_would_rewrite,
// is_normalizer_fixed_point, is_token, recovery_shape, classify_source_ref
// --------------------------------------------------------------------------

export function normalizeSourceRef(value: unknown): string | null {
  /** Faithful port of the engine's normalizeSourceRef. */
  if (typeof value !== 'string') {
    return null;
  }
  return value.replace(_NORMALIZE_STRIP_ALL, '').trim().slice(0, _NORMALIZE_CAP);
}

export function engineWouldRewrite(value: unknown): boolean {
  /** True if `findRowsForSourceRefMigration`'s selector matches this row.

  All five predicates, ORed, exactly as the engine evaluates them. Only the
  GLOB is implied by the keep-set; TRIM adds genuine coverage because space
  is a legal character, so a whitespace-padded ref clears the GLOB and is
  still selected.
  */
  if (typeof value !== 'string') {
    // SQLite columns are dynamically typed: an imported database can hold
    // an INTEGER, REAL or BLOB here. Nothing non-textual is a value the
    // engine's text predicates would select.
    return false;
  }
  if (value.trim() !== value) {
    return true;
  }
  if (value.includes('/')) {
    return true;
  }
  if (value.includes('\\')) {
    return true;
  }
  if (value.includes('\x00')) {
    return true;
  }
  return _NORMALIZE_STRIP.test(value);
}

export function isNormalizerFixedPoint(value: unknown): boolean {
  /** True if the engine's rewrite would leave this value unchanged. */
  if (typeof value !== 'string') {
    return true;
  }
  return normalizeSourceRef(value) === value;
}

export function isToken(value: unknown): boolean {
  /** True if the ref is a well-formed post-#188 token (§2.2). */
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function recoveryShape(value: unknown): RecoveryShape | null {
  /** Advisory (spec_path, description) for a damaged row, or null.

  Per §2.5.4 these shapes drive recovery, never detection.
  */
  if (typeof value !== 'string') {
    return null;
  }
  for (const shape of _RECOVERY_SHAPES) {
    if (value.startsWith(shape.prefix)) {
      return { specPath: shape.specPath, description: shape.description };
    }
  }
  return null;
}

export function classifySourceRef(value: unknown): SourceRefState {
  /** Classify one `source_ref` into a pre-flight state.

  **Only meaningful for `source_type = 'librarian_inferred'` rows** — see the
  module docstring. Applied to a document-sourced ref it would report a
  healthy long path as damaged, which is precisely the false positive
  §2.5.1's scoping rule exists to prevent.

  Detection is the positive token-shape test (§2.5.1): anything that is not
  NULL and not a token is damaged. The sub-classification only says *how*:

    "null"    — no ref; legitimate engine-era data, outside the invariant
    "token"   — engine-proof, matches ^librarian-[0-9a-f]{32}$
    "at_risk" — the engine's selector still matches it, so it is intact now
                and destroyed at the next setup()
    "mangled" — already rewritten: a normalizer fixed point that is not a
                token, i.e. the evidence is gone
  */
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'string') {
    // A non-TEXT storage value (INTEGER/REAL/BLOB) is certainly not a
    // token, and reaching the regex with one would raise TypeError —
    // which censusSourceRefs does not catch and runChecks has no
    // boundary for, so `ct_doctor check` would abort on exactly the
    // imported-database case this check exists to inspect.
    return 'mangled';
  }
  if (isToken(value)) {
    return 'token';
  }
  if (engineWouldRewrite(value)) {
    return 'at_risk';
  }
  return 'mangled';
}

// --------------------------------------------------------------------------
// DB helpers — readonly connection, table-existence, column-existence
// --------------------------------------------------------------------------

function _tableExists(conn: Database.Database, name: string): boolean {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

function _columns(conn: Database.Database, table: string): Set<string> {
  // SQLite cannot parameterise identifiers; EVIDENCE_TABLE / ENTRIES_TABLE
  // are repository-controlled constants, never user input.
  try {
    const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

function _openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

// --------------------------------------------------------------------------
// census
// --------------------------------------------------------------------------

export function censusSourceRefs(dbPath: string): Census {
  /** Census `librarian_inferred` source_refs. Read-only; never raises. */
  if (!existsSync(dbPath)) {
    return makeCensus({ error: 'brain database not found' });
  }
  let conn: Database.Database;
  try {
    conn = _openReadonly(dbPath);
  } catch (e) {
    return makeCensus({
      error: `cannot open database read-only: ${(e as Error).message}`,
    });
  }
  try {
    if (!_tableExists(conn, ENTRIES_TABLE)) {
      // A brain that has never run the wiki engine has no entries table.
      // That is a legitimate state, not an error.
      return makeCensus({ tablePresent: false });
    }

    const cols = _columns(conn, ENTRIES_TABLE);
    const scoped = cols.has('source_type');
    // Soft-deleted rows are retained forever (the engine has no purge), so a
    // corpse's mangled source_ref would otherwise be counted as live damage
    // and FAIL a healthy brain. Detected, never assumed: on a pre-soft-delete
    // engine the column's absence must leave behavior byte-identical.
    const hasDeletedAt = cols.has('deleted_at');
    let rows: Array<{ id: unknown; source_ref: unknown }>;
    if (scoped) {
      let sql = 'SELECT id, source_ref FROM llm_wiki_entries WHERE source_type = ?';
      if (hasDeletedAt) sql += ' AND deleted_at IS NULL';
      rows = conn.prepare(sql).all(LIBRARIAN_SOURCE_TYPE) as Array<{
        id: unknown;
        source_ref: unknown;
      }>;
    } else {
      // Older schema with no source_type column: we cannot scope, so we
      // report that plainly rather than risk the §2.5.1 false positive.
      let sql = 'SELECT id, source_ref FROM llm_wiki_entries';
      if (hasDeletedAt) sql += ' WHERE deleted_at IS NULL';
      rows = conn.prepare(sql).all() as Array<{
        id: unknown;
        source_ref: unknown;
      }>;
    }

    const counts: Record<string, number> = {};
    const hints: Record<string, number> = {};
    let nullRefs = 0;
    let total = 0;
    const tokenIds: unknown[] = [];
    for (const row of rows) {
      const ref = row.source_ref;
      if (ref === null) {
        nullRefs += 1;
        continue;
      }
      total += 1;
      const state = classifySourceRef(ref);
      counts[state] = (counts[state] ?? 0) + 1;
      if (state === 'token') {
        tokenIds.push(row.id);
      } else {
        const hint = recoveryShape(ref);
        if (hint) {
          const key = `${hint.specPath} ${hint.description}`;
          hints[key] = (hints[key] ?? 0) + 1;
        }
      }
    }

    const evidencePresent = _tableExists(conn, EVIDENCE_TABLE);
    let missingEvidence = 0;
    let unanchored = 0;
    if (evidencePresent && tokenIds.length > 0) {
      const have = new Set<unknown>();
      // Chunk the IN list: SQLite's default variable limit is 999.
      const CHUNK = 500;
      for (let i = 0; i < tokenIds.length; i += CHUNK) {
        const batch = tokenIds.slice(i, i + CHUNK);
        // Table name is interpolated because SQLite cannot
        // parameterise identifiers; it comes from a repository-
        // controlled data file, never from user input.
        // tokenIds come from llm_wiki_entries.id, which is INTEGER when
        // the schema uses INTEGER PRIMARY KEY. Bind as strings so the
        // IN match works against the TEXT entry_id column: better-sqlite3
        // passes integer parameters through sqlite3_bind_int and SQLite
        // does not coerce bind parameters across column affinity, so an
        // unconverted batch would silently miss every evidence row on a
        // brain with INTEGER ids.
        const placeholders = batch.map(() => '?').join(',');
        const q = `SELECT entry_id FROM ${EVIDENCE_TABLE} WHERE entry_id IN (${placeholders})`;
        const evidenceRows = conn.prepare(q).all(...batch.map(String)) as Array<{
          entry_id: unknown;
        }>;
        for (const r of evidenceRows) {
          have.add(r.entry_id);
        }
      }
      missingEvidence = tokenIds.filter((t) => !have.has(String(t))).length;
      if (_columns(conn, EVIDENCE_TABLE).has('unanchored')) {
        const row = conn
          .prepare(
            `SELECT COUNT(*) AS n FROM ${EVIDENCE_TABLE} WHERE unanchored = 1`,
          )
          .get() as { n: number } | undefined;
        unanchored = row?.n ?? 0;
      }
    }

    // Corpse census: informational only, and deliberately isolated. Its own
    // try/catch means a failure here can never degrade the primary census to
    // an error result. Declared with `let` outside the try so both are in
    // scope at the return regardless of which path ran.
    let deadRows = 0;
    let deadMangled = 0;
    if (hasDeletedAt) {
      try {
        // One pass, not a COUNT(*) alongside a SELECT with the same WHERE:
        // both counters then derive from the same result set, so no partial
        // failure can leave deadRows truthful while deadMangled silently
        // reads 0 and reports '(0 with mangled source_refs)'.
        //
        // classifySourceRef is TypeScript, so corpses have to be read and
        // classified here rather than counted in SQL. The predicate is
        // 'mangled' and only 'mangled': at_risk, token and null corpses land
        // in deadRows but not here, matching the operator-facing wording.
        let deadRefSql =
          'SELECT source_ref FROM llm_wiki_entries WHERE deleted_at IS NOT NULL';
        if (scoped) deadRefSql += ' AND source_type = ?';
        const params = scoped ? [LIBRARIAN_SOURCE_TYPE] : [];
        const deadRefs = conn.prepare(deadRefSql).all(...params) as Array<{
          source_ref: unknown;
        }>;
        deadRows = deadRefs.length;
        for (const row of deadRefs) {
          if (row.source_ref === null) continue;
          if (classifySourceRef(row.source_ref) === 'mangled') deadMangled += 1;
        }
      } catch {
        // informational only; never degrades the census
      }
    }

    return makeCensus({
      counts,
      total,
      tablePresent: true,
      nullRefCount: nullRefs,
      scoped,
      recoveryHints: hints,
      missingEvidenceRows: missingEvidence,
      unanchoredRows: unanchored,
      evidenceTablePresent: evidencePresent,
      deadRows,
      deadMangled,
    });
  } catch (e) {
    return makeCensus({
      error: `census query failed: ${(e as Error).message}`,
      tablePresent: true,
    });
  } finally {
    try {
      conn.close();
    } catch {
      // ignore
    }
  }
}

export function hasEvidenceTable(dbPath: string): boolean | null {
  /** True if the post-#188 CT-owned librarian_evidence table exists.

  Its absence on a brain full of token rows means provenance was dropped in
  transit — the export was not brain-complete (PR #188 §2.5.5).
  */
  if (!existsSync(dbPath)) {
    return null;
  }
  let conn: Database.Database;
  try {
    conn = _openReadonly(dbPath);
  } catch {
    return null;
  }
  try {
    return _tableExists(conn, EVIDENCE_TABLE);
  } catch {
    return null;
  } finally {
    try {
      conn.close();
    } catch {
      // ignore
    }
  }
}

// --------------------------------------------------------------------------
// engine version detection
// --------------------------------------------------------------------------

function _candidateEngineManifests(
  sidecarPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  /** Plausible locations of the engine's package.json. */
  const out: string[] = [];
  const override = env[ENV_ENGINE_PACKAGE];
  if (override) {
    // os.path.expanduser on a leading ~ — Python's expanduser handles a
    // bare ~ by reading HOME. Port the equivalent path manipulation.
    out.push(override.replace(/^~(?=$|\/)/, env['HOME'] ?? ''));
  }
  const rel = join('node_modules', ENGINE_PACKAGE, 'package.json');
  if (sidecarPath) {
    // Walk up to 6 parents of the sidecar, mirroring the Python's
    // `list(base.parents)[:6]`. We resolve symlinks-free relative
    // traversal because the Python uses pathlib's .parents on the raw
    // string path; using dirname() repeatedly is the TS equivalent.
    let cur = sidecarPath;
    for (let i = 0; i < 6; i += 1) {
      const parent = join(cur, '..');
      out.push(join(parent, rel));
      out.push(join(parent, 'Resources', rel));
      const next = join(cur, '..');
      if (next === cur) break;
      cur = next;
    }
  }
  return out;
}

export function detectEngineVersion(
  sidecarPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): { version: string | null; source: string | null } {
  /** Best-effort core-llm-wiki version. Returns (version|null, source|null).

  Reads package.json off disk rather than via `node -e`: the package's
  exports map blocks a `require` of its package.json (PR #188 §2.6, which
  uses `pnpm ls --json` for the same reason). A direct file read is
  unaffected.

  The engine ships inside the desktop app's JS bundle, so on an installed
  app there is often no readable package.json. Unknown is a legitimate,
  non-fatal answer — but when it is found it is the single most useful fact
  about whether an imported brain is safe.
  */
  for (const manifest of _candidateEngineManifests(sidecarPath, env)) {
    try {
      if (!existsSync(manifest)) {
        continue;
      }
      const data = JSON.parse(readFileSync(manifest, { encoding: 'utf8' }));
      const version = data?.version;
      if (typeof version === 'string' && version.trim().length > 0) {
        return { version: version.trim(), source: manifest };
      }
    } catch {
      // OSError / JSONDecodeError — try next candidate.
      continue;
    }
  }
  return { version: null, source: null };
}

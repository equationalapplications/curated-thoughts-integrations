# ct_doctor import-preflight — live-row scoping for the source_ref census

**Date:** 2026-09-10
**Status:** Draft (rev 3 — GLM 5.3 round-2 findings addressed)
**Branch:** docs/spec-2026-09-10-doctor-preflight-live-scope
**Priority:** Low (correctness polish; zero live-data impact)

## Problem

`ct_doctor.py check` currently reports `1 FAIL` on Kurt's ThinkPad brain even
though the live graph is fully healthy. Verified on 2026-09-10 by an audit
session and independently re-verified by a GLM 5.3 review pass against a
read-only copy of `~/.brain/brain.db` (audit session: vault
`immutable-source-files/agents/people/tessera/sessions/ct-graphrag-state-audit-2026-09-10.md`):

- Live `librarian_inferred` entries: **192 total, all token refs
  (`librarian-<32-hex>`), 0 mangled, 0 at-risk** — ground truth verified by
  running the repo's own `classify_source_ref` against a read-only copy of
  the DB during the GLM 5.3 review. Every live row is healthy.
- The 14 mangled refs the check counts are **all on soft-deleted rows**
  (`deleted_at IS NOT NULL`; rowids 627–637 and 647–649): issue #186
  corpses retained because soft-deleted entries are never auto-purged.
- Total soft-deleted `librarian_inferred` rows: **505** (491 with valid
  token refs + the 14 mangled corpses).

Root cause: `census_source_refs()` in
`integrations/hermes/scripts/ct_preflight.py` (line ~300) selects
`id, source_ref FROM llm_wiki_entries` with **no `deleted_at` predicate**. It
counts dead rows identically to live ones, so `check_import_preflight()` in
`ct_doctor.py` (line ~625) emits its FAIL with the misleading message
"14 of 697 librarian_inferred entries have a mangled source_ref" — implying
live facts are untrustworthy when the actual live failure count is 0.
Every future doctor run on this machine re-raises the same false alarm.

## Approach

Scope the census to live rows and surface corpse data separately, so a
soft-deleted corpse can never flip the check to FAIL:

1. **`census_source_refs(db_path)`** (`ct_preflight.py`):
   - After the existing `_columns(conn, ENTRIES_TABLE)` call, detect a
     `deleted_at` column (the soft-delete convention used by the engine's
     `llm_wiki_entries` schema).
   - If present, add `AND deleted_at IS NULL` to the scoped SELECT. For the
     legacy no-`source_type` path, add a `WHERE deleted_at IS NULL` clause.
     (If `deleted_at` is absent — pre-soft-delete engine — no scoping
     occurs and behavior is identical to today.)
   - Add two new `CensusResult` fields, **both counted with `source_type`
     scoping when the `source_type` column exists, and over the whole
     table when it does not** (matching the main census's scoping
     behavior, so the numbers always describe the same row population):
     - `dead_rows: int = 0` — `COUNT(*)` of rows with
       `deleted_at IS NOT NULL` (expected 505 on this brain).
     - `dead_mangled: int = 0` — of those, how many have a mangled
       source_ref (expected 14 on this brain; the remainder are healthy
       token corpses).
   - **Best-effort, isolated:** the dead-rows queries run in their own
     `try/except sqlite3.Error` with both fields defaulting to 0 on
     failure — an informational count must never degrade the primary
     census into `CensusResult(error=...)`.
2. **`CensusResult.as_dict()`**: include `dead_rows` and `dead_mangled` so
   the JSON surface exposes corpse accumulation to tooling (and to the
   existing test suite, e.g. `test_ct_doctor.py` asserts on
   `CensusResult.as_dict` output).
3. **`check_import_preflight()`** (`ct_doctor.py`):
   - All verdict logic operates on live counts only — no condition changes.
   - Message placement (exact): when `census.dead_rows > 0`, append one
     sentence to the **`detail` field of the final PASS result and of the
     missing-evidence WARN result only**:
     `"; N soft-deleted rows excluded from this census (M with mangled source_refs)"`.
     On the legacy no-`source_type` path, `dead_mangled` is counted over the
     whole table while `classify_source_ref` is only meaningful for
     librarian rows, so document-sourced refs can inflate the informational
     "(M with mangled)" suffix there — informational only; it never affects
     any verdict. FAIL-result messages are left byte-for-byte unchanged —
     they carry recovery-hint text that out-of-scope work depends on.

### Verified expectation for this brain (post-fix)

`import-preflight` returns **PASS** with: `192 librarian_inferred entries,
all source_refs engine-proof` + `"; 505 soft-deleted rows excluded from
this census (14 with mangled source_refs)"`. Overall doctor exit returns
to 0. (Rev-1 quoted post-fix numbers computed with pre-fix semantics;
rev-2 quoted 206 live — both wrong. The live DB is the authority:
192 live / 505 dead / 697 total.)

### Rejected alternatives

- **Purge corpses in the doctor.** Rejected: the doctor is strictly
  read-only by design; deletion belongs to an engine GC migration, out of
  scope here.
- **Treat dead rows as a separate WARN.** Rejected: corpse accumulation is
  expected engine behavior (soft-delete with no purge), not a condition the
  operator must act on; a permanent WARN is the same crying-wolf problem as
  the current FAIL.
- **Hardcode `deleted_at` filtering off.** Rejected: silently changes
  verdicts on older engines where the column is genuinely absent — column
  detection keeps pre-soft-delete engine versions working unchanged.

## Error handling

- Main census path unchanged: existing `try/except sqlite3.Error` returning
  `CensusResult(error=...)` still guards all live-row queries; the
  never-raises contract (docstring line 301) is preserved.
- Dead-rows counts are best-effort (own `try`, default 0) and cannot
  degrade the primary verdict.
- Column detection uses the existing `_columns()` helper (already
  tolerant of missing tables via `sqlite3.Error` catch).

## Testing

- Unit tests for `census_source_refs` with a fixture DB containing: live
  token rows, live plain-token rows, live mangled rows, soft-deleted
  mangled rows, and soft-deleted token rows. Assert: dead rows excluded
  from `counts`/`total`; `dead_rows` counts all corpses;
  `dead_mangled` counts only mangled corpses; doctor verdict is PASS when
  only dead rows are mangled.
- Best-effort test: a fixture whose dead-rows query fails (e.g. dropped
  column mid-flight via mock) still returns a valid live census with
  `dead_rows = 0`, not an error result.
- Legacy-schema regression tests: (a) no `deleted_at` column → identical
  to today; (b) `deleted_at` but no `source_type` → scoping still applies
  and `dead_rows` is table-wide.
- `as_dict()` round-trip: new fields present in JSON output.
- Existing preflight tests (ct_doctor test suite) must stay green.

## Out of scope

- Engine-side GC/purge of soft-deleted rows (curated-thoughts repo).
- `.brain/errors.log` indexing noise — separate spec in the
  curated-thoughts repo (companion spec
  `2026-09-10-vault-walk-brain-dir-exclusion-design.md`).
- Any change to FAIL-result message strings, recovery-hint shapes, or the
  V18/PR #188 recovery machinery.

## Open questions

None. Rev-1's grounding errors (dead_rows 14-vs-505 contradiction,
pre-fix-semantics expectation numbers, error-coupling of the informational
query) were found by the GLM 5.3 round-1 review and are resolved above.

# ct_doctor import-preflight — live-row scoping for the source_ref census

**Date:** 2026-09-10
**Status:** Draft
**Branch:** docs/spec-2026-09-10-doctor-preflight-live-scope
**Priority:** Low (correctness polish; zero live-data impact)

## Problem

`ct_doctor.py check` currently reports `1 FAIL` on Kurt's ThinkPad brain even
though the live graph is fully healthy. Verified on 2026-09-10
(audit session: vault
`immutable-source-files/agents/people/tessera/sessions/ct-graphrag-state-audit-2026-09-10.md`):

- All 192 live `librarian_inferred` entries have valid token-JSON source_refs;
  zero live rows are mangled.
- The 14 mangled refs the check counts are **all on soft-deleted rows**
  (`deleted_at IS NOT NULL`, rowids 627–649): issue #186 corpses retained
  because soft-deleted entries are never auto-purged.

Root cause: `census_source_refs()` in
`integrations/hermes/scripts/ct_preflight.py` (line ~300) selects
`id, source_ref FROM llm_wiki_entries` with **no `deleted_at` predicate**. It
counts dead rows identically to live ones, so `check_import_preflight()` in
`ct_doctor.py` (line ~625) emits its FAIL with the misleading message
"14 of 697 librarian_inferred entries have a mangled source_ref" — implying
14 live facts are untrustworthy when the actual live failure count is 0.
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
   - Additionally issue one informational count:
     `SELECT COUNT(*) FROM llm_wiki_entries WHERE source_type = 'librarian_inferred' AND deleted_at IS NOT NULL`
     (guarded on both columns existing). Expose it as a new
     `dead_rows: int` field on `CensusResult`, default `0`. Keep the query
     read-only and failure-tolerant exactly as the rest of the module is
     ("never raises" contract, docstring line 301).
2. **`check_import_preflight()`** (`ct_doctor.py`):
   - All FAIL/WARN/PASS verdict logic operates on live counts only — no
     condition change needed beyond the census scoping.
   - When `census.dead_rows > 0`, append to the final PASS detail (and to any
     live-finding detail) a trailing sentence:
     `"; additionally N soft-deleted (corpse) rows are excluded from this
     census"` so operators can see why totals differ from a raw
     `SELECT COUNT(*)` and so corpse accumulation stays observable.
3. **Doctor behavior after fix** (verified expectation for this brain):
   `import-preflight` returns PASS — 683 valid token refs, 0 live mangled,
   14 dead rows reported informationally. Overall doctor exit returns to 0.

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

- All new SQL runs inside the existing `try` block whose
  `sqlite3.Error` handler returns `CensusResult(error=...)`; no new failure
  modes can escape the module's never-raises contract.
- Column detection uses the existing `_columns()` helper (already
  tolerant of missing tables via `sqlite3.Error` catch).

## Testing

- Unit tests for `census_source_refs` with a fixture DB containing: live
  token rows, live mangled rows, and soft-deleted mangled rows. Assert:
  dead mangled rows are excluded from `counts`/`total`, included in
  `dead_rows`, and the doctor verdict is PASS when only dead rows are
  mangled.
- Regression test: legacy schema without `deleted_at` produces identical
  results to today's behavior (no crash, no scoping).
- Existing preflight tests (ct_doctor test suite) must stay green.

## Out of scope

- Engine-side GC/purge of soft-deleted rows (curated-thoughts repo).
- `.brain/errors.log` indexing noise — separate spec in the
  curated-thoughts repo (same-day companion spec
  `2026-09-10-vault-walk-brain-dir-exclusion-design.md`).
- Any change to recovery-hint shapes or the V18/PR #188 recovery machinery.

## Open questions

None — scope is mechanical and fully grounded in the current code.

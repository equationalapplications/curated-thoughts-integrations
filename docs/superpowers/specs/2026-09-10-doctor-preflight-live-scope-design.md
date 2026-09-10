# ct_doctor import-preflight — live-row scoping for the source_ref census

**Date:** 2026-09-10
**Status:** Draft (rev 4 — Opus 5 review findings addressed)
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

### Why the 505 figure is all-`librarian_inferred` (arithmetic, not assertion)

The pre-fix FAIL message on this brain reads "14 of **697**". `census.total`
on the `source_type`-scoped path counts `librarian_inferred` rows *only*, so
697 is already a scoped total. With 192 of those live, the remaining
**697 − 192 = 505** soft-deleted rows are `librarian_inferred` by
construction — no separate query is needed to establish it, and a
`source_type`-scoped `dead_rows` must return exactly 505 post-fix.

### Evidence that `deleted_at` exists on this schema

`deleted_at` appears **nowhere in this repository** — no source file, no test
fixture, no `shared/compat.yaml` entry. Its existence is established solely by
the 2026-09-10 audit, which ran `WHERE deleted_at IS NOT NULL` against a
read-only copy of the real `~/.brain/brain.db` and got the rowid ranges quoted
above. That is empirical evidence for *this* engine build, **not** a
documented schema contract we control.

This is exactly why the design detects the column at runtime instead of
assuming it (see Approach 1). If a brain lacks `deleted_at`, the census
behaves precisely as it does today and the fix is a no-op there — the correct
degradation, not a silent failure. Implementers must **not** hand-write
`WHERE deleted_at IS NULL` into any query that is not guarded by the column
check.

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
     `deleted_at` column. All `deleted_at` predicates below are emitted
     **only** when that detection succeeds.
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

   **`CensusResult` declares `__slots__`** (`ct_preflight.py:204`). Adding a
   field to `__init__` alone raises `AttributeError` on first access. Both
   new names **must** be added to the `__slots__` tuple as well as to
   `__init__`, `as_dict()`, and the `CensusResult(...)` construction at the
   end of the success path.

   **Placement (exact, non-negotiable):** the dead-rows block goes
   **inside the existing outer `try`**, after the evidence-table section and
   **before** the `return CensusResult(...)`. It cannot go after the outer
   `try`/`except`/`finally`: the `finally` closes `conn`, so a query there
   raises `ProgrammingError: Cannot operate on a closed database`.

   **Failure isolation (exact):** initialize `dead_rows = 0` and
   `dead_mangled = 0` **before** the inner `try`, never only inside it —
   assigning solely within the `try` leaves them unbound on the failure path
   and the subsequent `CensusResult(...)` raises `UnboundLocalError`,
   breaking the never-raises contract. The inner
   `except sqlite3.Error: pass` catches before the outer handler can see the
   error, so a failed informational count leaves the primary census intact
   and never degrades it to `CensusResult(error=...)`. Shape:

   ```python
   dead_rows = 0
   dead_mangled = 0
   if has_deleted_at:
       try:
           ...  # COUNT(*) and mangled-corpse queries
       except sqlite3.Error:
           pass  # informational only; never degrades the census
   ```

2. **`CensusResult.as_dict()`**: include `dead_rows` and `dead_mangled` so
   the JSON surface exposes corpse accumulation to tooling.

   Note: no existing test asserts on `as_dict()` *shape* — the sole
   reference (`test_ct_doctor.py:739`) passes it as an `assertEqual` failure
   message, not as the value under test. (Rev-3 claimed otherwise; that was
   wrong.) Adding keys is therefore unguarded by the current suite, so the
   new `as_dict()` round-trip test below is the only thing pinning the JSON
   surface — treat it as required, not optional. The change is
   additive-only: no existing key is renamed, removed, or retyped, so
   key-stable downstream consumers keep working.

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

4. **DeepSeek parity** (`integrations/deepseek/scripts/`): apply the same
   change to the TypeScript twin. `censusSourceRefs`
   (`ct_preflight.ts:308`) carries the identical unscoped
   `SELECT id, source_ref FROM llm_wiki_entries`, and `checkImportPreflight`
   (`ct_doctor.ts:777`) builds the same messages, so shipping to hermes alone
   leaves DeepSeek users with the same false FAIL this spec exists to remove.
   The `Census` type (`ct_preflight.ts:101`) is a plain interface built by
   `makeCensus`, so it needs `deadRows`/`deadMangled` added to `Census`,
   `CensusInit`, and `makeCensus`'s defaults — there is no `__slots__`
   equivalent to trip over, and the `try`/`catch`/`finally` placement
   constraint is the same as the Python one.

### Legacy no-`source_type` path: pre-existing message imprecision

On that path `census.total` is a whole-table count, yet the PASS detail reads
`"{total} librarian_inferred entries"`. That wording is already inaccurate
today and this spec does not change it; the existing
`"; UNSCOPED (no source_type column)"` marker appended to `shape` is what
signals the caveat to operators. The new suffix inherits the same
whole-table caveat, already stated in Approach 3. **Out of scope:** rewording
the `librarian_inferred` label on the unscoped path — a pre-existing defect
that deserves its own change so it can be reviewed against the FAIL/WARN
strings it also affects.

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
- Dead-rows counts are best-effort (own inner `try`, pre-initialized to 0)
  and cannot degrade the primary verdict or raise.
- Column detection uses the existing `_columns()` helper (already
  tolerant of missing tables via `sqlite3.Error` catch).

## Testing

### Fixture prerequisite

The existing seed helper `_seed` (`test_ct_doctor.py:668`) hardcodes
`CREATE TABLE llm_wiki_entries (id TEXT, source_ref TEXT, source_type TEXT)`
and cannot express a soft-deleted row. Extend it **backward-compatibly**:
add a `with_deleted_at=False` keyword that appends a `deleted_at TEXT`
column and accepts an optional 4th tuple element per row (default `None` =
live). Existing call sites pass 2- and 3-tuples and must keep working
unchanged, so every current `ImportPreflightTests` case stays green without
edits. Do **not** rewrite the default schema — the 10+ existing cases
(e.g. `test_document_sourced_255_char_path_is_never_damaged`) assert against
its current shape.

### Cases

- Unit tests for `census_source_refs` with a fixture DB containing: live
  token rows, live plain-token rows, live mangled rows, soft-deleted
  mangled rows, and soft-deleted token rows. Assert: dead rows excluded
  from `counts`/`total`; `dead_rows` counts all corpses;
  `dead_mangled` counts only mangled corpses; doctor verdict is PASS when
  only dead rows are mangled.
- Best-effort test: a fixture whose dead-rows query fails (e.g. dropped
  column mid-flight via mock) still returns a valid live census with
  `dead_rows = 0`, not an error result — and does **not** raise
  `UnboundLocalError`.
- Legacy-schema regression tests: (a) no `deleted_at` column → identical
  to today; (b) `deleted_at` but no `source_type` → scoping still applies
  and `dead_rows` is table-wide.
- `as_dict()` round-trip: new fields present in JSON output, and all ten
  pre-existing keys still present and unrenamed.
- Existing preflight tests (ct_doctor test suite) must stay green.
- DeepSeek: mirror the above in the TypeScript test suite.

## Out of scope

- Engine-side GC/purge of soft-deleted rows (curated-thoughts repo).
- `.brain/errors.log` indexing noise — separate spec in the
  curated-thoughts repo (companion spec
  `2026-09-10-vault-walk-brain-dir-exclusion-design.md`).
- Any change to FAIL-result message strings, recovery-hint shapes, or the
  V18/PR #188 recovery machinery.
- Rewording the `librarian_inferred` label on the unscoped legacy path
  (pre-existing; see above).

## Open questions

None. Rev-1's grounding errors (dead_rows 14-vs-505 contradiction,
pre-fix-semantics expectation numbers, error-coupling of the informational
query) were found by the GLM 5.3 round-1 review. Rev-4 adds the `__slots__`
requirement, exact query placement and variable-init shape, the `deleted_at`
evidence provenance, the 505 arithmetic derivation, the DeepSeek parity
requirement, the fixture-extension strategy, and corrects rev-3's false
claim about existing `as_dict` test coverage.

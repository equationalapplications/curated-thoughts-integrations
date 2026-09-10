# ct_doctor import-preflight live-row scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the `source_ref` census to live (non-soft-deleted) rows so soft-deleted corpses stop flipping `ct_doctor check` to a false FAIL, and report corpse counts separately as informational data.

**Architecture:** `census_source_refs()` detects a `deleted_at` column at runtime via the existing `_columns()` helper; when present it adds `deleted_at IS NULL` to the row SELECT and counts corpses into two new best-effort `CensusResult` fields. `check_import_preflight()` verdict logic is untouched — only the PASS and missing-evidence WARN detail strings gain an informational suffix. The whole change is mirrored into the DeepSeek TypeScript twin, which carries the identical unscoped query.

**Tech Stack:** Python 3 (stdlib `sqlite3`, `unittest`), TypeScript (`better-sqlite3`, `vitest`, `tsc`)

**Spec:** `docs/superpowers/specs/2026-09-10-doctor-preflight-live-scope-design.md` (rev 5, approved)

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **Never hand-write `WHERE deleted_at IS NULL` into any query that is not guarded by the column check.** `deleted_at` appears nowhere in this repository; its existence is empirical (a 2026-09-10 audit of a real brain), not a schema contract we control. If a brain lacks the column, the census must behave exactly as it does today.
- **`census_source_refs` never raises.** Docstring contract at `ct_preflight.py:301`. The corpse counts are informational and must never degrade the census to `CensusResult(error=...)` nor raise.
- **Verdict logic does not change.** No condition in `check_import_preflight` is added, removed, or reordered. Live counts alone decide the verdict.
- **FAIL-result message strings are left byte-for-byte unchanged.** They carry recovery-hint text that out-of-scope work depends on.
- **`dead_mangled` predicate is exactly `classify_source_ref(ref) == "mangled"`.** Not `at_risk`, not `token`, not `null`.
- **Additive-only on `as_dict()`:** no existing key renamed, removed, or retyped.
- **Both new fields are counted with `source_type` scoping when the `source_type` column exists, and over the whole table when it does not** — matching the main census's scoping behavior.
- **Python and TypeScript must both ship.** Nothing in CI enforces parity between them; shipping only hermes leaves DeepSeek users with the false FAIL this work exists to remove.
- Expected end state on the reference brain: **192 live / 505 dead / 697 total**, with **14** mangled corpses.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `integrations/hermes/scripts/ct_preflight.py` | Python census + classification | Modify: `CensusResult` (`__slots__`/`__init__`/`as_dict`), `census_source_refs` |
| `integrations/hermes/scripts/ct_doctor.py` | Python check verdicts + messages | Modify: `check_import_preflight` detail strings only |
| `integrations/hermes/tests/test_ct_doctor.py` | Python suite (census + doctor both live here) | Modify: `_seed` helper; add cases |
| `integrations/deepseek/scripts/ct_preflight.ts` | TS census twin | Modify: `Census`, `CensusInit`, `makeCensus`, `censusSourceRefs` |
| `integrations/deepseek/scripts/ct_doctor.ts` | TS check twin | Modify: `checkImportPreflight` detail strings only |
| `integrations/deepseek/tests/test_ct_preflight.ts` | TS census suite | Modify: shared schema; add cases |
| `integrations/hermes/CHANGELOG.md`, `integrations/deepseek/CHANGELOG.md` | Release notes | Modify: add entries |

**Test commands** (memorize these; every task uses them):

```bash
# Python — run from integrations/hermes/
python -m unittest discover -s tests
# Python — single case
python -m unittest tests.test_ct_doctor.ImportPreflightTests.<name> -v

# TypeScript — run from integrations/deepseek/
pnpm run test
pnpm exec tsc --noEmit
```

---

### Task 1: Extend the `_seed` test fixture to express soft-deleted rows

The existing helper hardcodes a 3-column schema and cannot represent a corpse. Every later Python task depends on this, so it lands first with its own test.

**Files:**
- Modify: `integrations/hermes/tests/test_ct_doctor.py:668-717` (the `_seed` method)
- Test: `integrations/hermes/tests/test_ct_doctor.py` (new cases in `ImportPreflightTests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `self._seed(rows, evidence_table=True, evidence_ids=None, unanchored=0, with_source_type=True, with_deleted_at=False)`. `rows` entries are `(id, source_ref)` or `(id, source_ref, source_type)` or `(id, source_ref, source_type, deleted_at)`. `deleted_at` is read as `row[3] if len(row) > 3 else None`; `None` means live. Returns the db path, unchanged from today.

**Background you need:** `_seed` currently inserts with positional placeholders (`INSERT INTO llm_wiki_entries VALUES (?,?,?)`). Adding a column to the table without changing the row arity raises `sqlite3.ProgrammingError`. There are four schema combinations and each must project rows to exactly the arity its own `CREATE TABLE` declared. The `with_source_type=False, with_deleted_at=True` combination is required — it is the only way to build the legacy-schema regression case in Task 4.

- [ ] **Step 1: Write the failing tests**

Add these two cases to `ImportPreflightTests` in `integrations/hermes/tests/test_ct_doctor.py`, immediately before `test_document_sourced_255_char_path_is_never_damaged` (line ~721):

First add a class constant next to the existing `TOKEN` constant at the top of
`ImportPreflightTests` (line ~666). **Do not use a JSON string as your mangled
fixture value** — `classify_source_ref('{"evidence":[]}')` returns `"at_risk"`,
not `"mangled"`, because a structured ref is something the engine *will*
rewrite rather than something it already destroyed. A truncated token is the
right shape for a post-rewrite corpse and classifies as `"mangled"`:

```python
    TOKEN = "librarian-" + "ab12" * 8  # 32 hex, the normative §2.2 shape
    # A token that lost its hex to the engine's setup() rewrite: classifies
    # as "mangled". Verified — a JSON ref classifies as "at_risk" instead.
    MANGLED = "librarian-ab12"
    # Whitespace-padded: the engine would rewrite it, so "at_risk".
    AT_RISK = "  " + TOKEN
```

Then add these two cases:

```python
    # --- fixture capability: soft-deleted rows (2026-09-10 live-scope) -----

    def test_seed_can_express_soft_deleted_rows(self):
        """The fixture must be able to build a corpse, or nothing else can."""
        import sqlite3

        db = self._seed(
            [
                ("e1", self.TOKEN, "librarian_inferred"),
                ("e2", '{"json":"dead"}', "librarian_inferred", "2026-01-01"),
            ],
            with_deleted_at=True,
        )
        conn = sqlite3.connect(db)
        try:
            rows = conn.execute(
                "SELECT id, deleted_at FROM llm_wiki_entries ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual(rows, [("e1", None), ("e2", "2026-01-01")])

    def test_seed_supports_deleted_at_without_source_type(self):
        """Legacy schema: deleted_at present, source_type absent."""
        import sqlite3

        db = self._seed(
            [
                ("e1", self.TOKEN, "librarian_inferred"),
                ("e2", self.TOKEN, "librarian_inferred", "2026-01-01"),
            ],
            with_source_type=False,
            with_deleted_at=True,
        )
        conn = sqlite3.connect(db)
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(llm_wiki_entries)")}
            rows = conn.execute(
                "SELECT id, deleted_at FROM llm_wiki_entries ORDER BY id"
            ).fetchall()
        finally:
            conn.close()
        self.assertEqual(cols, {"id", "source_ref", "deleted_at"})
        self.assertEqual(rows, [("e1", None), ("e2", "2026-01-01")])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `integrations/hermes/`:
```bash
python -m unittest tests.test_ct_doctor.ImportPreflightTests.test_seed_can_express_soft_deleted_rows tests.test_ct_doctor.ImportPreflightTests.test_seed_supports_deleted_at_without_source_type -v
```
Expected: both FAIL with `TypeError: _seed() got an unexpected keyword argument 'with_deleted_at'`.

- [ ] **Step 3: Implement the fixture extension**

Replace the signature and the schema/insert block of `_seed` (`test_ct_doctor.py:668-695`) with this. Everything from `if evidence_table:` onward is untouched:

```python
    def _seed(self, rows, evidence_table=True, evidence_ids=None, unanchored=0,
              with_source_type=True, with_deleted_at=False):
        """Seed llm_wiki_entries (+ optional librarian_evidence).

        rows: list of (entry_id, source_ref[, source_type[, deleted_at]]).
              deleted_at defaults to None (a live row). Callers passing 2- or
              3-tuples keep working unchanged.
        evidence_ids: entry_ids that get a librarian_evidence row; None = all
                      token rows.
        """
        import sqlite3

        self.make_brain()
        db = self.brain_db()
        conn = sqlite3.connect(db)

        def _deleted_at(row):
            return row[3] if len(row) > 3 else None

        try:
            # Each branch projects rows to exactly the arity its own CREATE
            # TABLE declares: positional VALUES placeholders make a mismatch a
            # ProgrammingError, not a silent NULL.
            if with_source_type and with_deleted_at:
                conn.execute(
                    "CREATE TABLE llm_wiki_entries "
                    "(id TEXT, source_ref TEXT, source_type TEXT, "
                    "deleted_at TEXT)"
                )
                conn.executemany(
                    "INSERT INTO llm_wiki_entries VALUES (?,?,?,?)",
                    [(r[0], r[1], r[2], _deleted_at(r)) for r in rows],
                )
            elif with_source_type:
                conn.execute(
                    "CREATE TABLE llm_wiki_entries "
                    "(id TEXT, source_ref TEXT, source_type TEXT)"
                )
                conn.executemany(
                    "INSERT INTO llm_wiki_entries VALUES (?,?,?)",
                    [(r[0], r[1], r[2]) for r in rows],
                )
            elif with_deleted_at:
                conn.execute(
                    "CREATE TABLE llm_wiki_entries "
                    "(id TEXT, source_ref TEXT, deleted_at TEXT)"
                )
                conn.executemany(
                    "INSERT INTO llm_wiki_entries VALUES (?,?,?)",
                    [(r[0], r[1], _deleted_at(r)) for r in rows],
                )
            else:
                conn.execute("CREATE TABLE llm_wiki_entries (id TEXT, source_ref TEXT)")
                conn.executemany(
                    "INSERT INTO llm_wiki_entries VALUES (?,?)",
                    [(r[0], r[1]) for r in rows],
                )
```

Note the `elif with_source_type` branch now projects `(r[0], r[1], r[2])` rather than passing `rows` straight through — that is deliberate, so a 4-tuple works in every branch.

- [ ] **Step 4: Run the new tests, then the whole suite**

```bash
python -m unittest tests.test_ct_doctor.ImportPreflightTests.test_seed_can_express_soft_deleted_rows tests.test_ct_doctor.ImportPreflightTests.test_seed_supports_deleted_at_without_source_type -v
python -m unittest discover -s tests
```
Expected: the two new tests PASS, and the full suite is green — every existing `_seed` caller passes 2- and 3-tuples and must be unaffected. If any pre-existing test broke, you changed default behavior; fix that before continuing.

- [ ] **Step 5: Commit**

```bash
git add integrations/hermes/tests/test_ct_doctor.py
git commit -m "test(hermes): let _seed express soft-deleted llm_wiki_entries rows"
```

---

### Task 2: Add `dead_rows` / `dead_mangled` to `CensusResult`

Pure data-carrier change. It lands before the query work so Task 3 has somewhere to put its numbers.

**Files:**
- Modify: `integrations/hermes/scripts/ct_preflight.py:201-276` (the `CensusResult` class)
- Test: `integrations/hermes/tests/test_ct_doctor.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `CensusResult(..., dead_rows=0, dead_mangled=0)` — two `int` keyword arguments defaulting to `0`, exposed as attributes and as the `as_dict()` keys `"dead_rows"` and `"dead_mangled"`.

**Background you need:** `CensusResult` declares `__slots__` at `ct_preflight.py:204`. Adding a name to `__init__` without adding it to `__slots__` raises `AttributeError` on first assignment. There are four places to touch: `__slots__`, `__init__` parameters, `__init__` body, and `as_dict()`.

`as_dict()` has exactly one caller in the repo — `test_ct_doctor.py:739`, where it is an `assertEqual` failure *message*, not a value under test. The doctor's `--json` output at `ct_doctor.py:906` serializes `CheckResult`, a different class. So this test is a `__slots__`-drift consistency check, not a contract test. Write it anyway; don't over-weight it.

- [ ] **Step 1: Write the failing test**

Add to `ImportPreflightTests` in `integrations/hermes/tests/test_ct_doctor.py`, after the two fixture tests from Task 1:

```python
    def test_census_result_carries_dead_row_fields(self):
        """__slots__ drift check: new fields exist and reach as_dict()."""
        c = ct_preflight.CensusResult(dead_rows=505, dead_mangled=14)
        self.assertEqual(c.dead_rows, 505)
        self.assertEqual(c.dead_mangled, 14)
        d = c.as_dict()
        self.assertEqual(d["dead_rows"], 505)
        self.assertEqual(d["dead_mangled"], 14)
        # Additive only: every pre-existing key survives, unrenamed.
        self.assertEqual(
            set(d) - {"dead_rows", "dead_mangled"},
            {
                "table_present", "evidence_table_present",
                "scoped_to_librarian_inferred", "total", "counts",
                "null_ref_count", "missing_evidence_rows", "unanchored_rows",
                "recovery_hints", "error",
            },
        )

    def test_census_result_dead_fields_default_to_zero(self):
        c = ct_preflight.CensusResult()
        self.assertEqual(c.dead_rows, 0)
        self.assertEqual(c.dead_mangled, 0)
```

- [ ] **Step 2: Run to verify failure**

```bash
python -m unittest tests.test_ct_doctor.ImportPreflightTests.test_census_result_carries_dead_row_fields -v
```
Expected: FAIL with `TypeError: __init__() got an unexpected keyword argument 'dead_rows'`.

- [ ] **Step 3: Implement the four edits**

In `integrations/hermes/scripts/ct_preflight.py`, append to the `__slots__` tuple (line ~204):

```python
    __slots__ = (
        "counts",
        "total",
        "error",
        "table_present",
        "null_ref_count",
        "scoped",
        "recovery_hints",
        "missing_evidence_rows",
        "unanchored_rows",
        "evidence_table_present",
        "dead_rows",
        "dead_mangled",
    )
```

Add the two parameters to the end of the `__init__` signature:

```python
        evidence_table_present=None,
        dead_rows=0,
        dead_mangled=0,
    ):
```

Add to the end of the `__init__` body, after `self.evidence_table_present = evidence_table_present`:

```python
        # Soft-deleted rows, excluded from every count above. Informational
        # only: corpse accumulation is expected engine behavior (soft-delete
        # with no purge) and never affects a verdict.
        self.dead_rows = dead_rows
        # Of those corpses, how many classify as "mangled" — and only
        # "mangled". at_risk/token/null corpses are counted in dead_rows but
        # not here, so the number matches the "with mangled source_refs"
        # wording of the operator-facing suffix.
        self.dead_mangled = dead_mangled
```

Add to the `as_dict()` return, after `"unanchored_rows": self.unanchored_rows,`:

```python
            "dead_rows": self.dead_rows,
            "dead_mangled": self.dead_mangled,
```

- [ ] **Step 4: Run tests**

```bash
python -m unittest tests.test_ct_doctor.ImportPreflightTests.test_census_result_carries_dead_row_fields tests.test_ct_doctor.ImportPreflightTests.test_census_result_dead_fields_default_to_zero -v
python -m unittest discover -s tests
```
Expected: new tests PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add integrations/hermes/scripts/ct_preflight.py integrations/hermes/tests/test_ct_doctor.py
git commit -m "feat(hermes): add dead_rows/dead_mangled fields to CensusResult"
```

---

### Task 3: Scope `census_source_refs` to live rows and count corpses

The core of the change.

**Files:**
- Modify: `integrations/hermes/scripts/ct_preflight.py:300-400` (`census_source_refs`)
- Test: `integrations/hermes/tests/test_ct_doctor.py`

**Interfaces:**
- Consumes: `CensusResult(dead_rows=..., dead_mangled=...)` from Task 2; `self._seed(..., with_deleted_at=True)` from Task 1.
- Produces: `census_source_refs(db_path)` returning a `CensusResult` whose `counts`/`total` cover live rows only when `deleted_at` exists, and whose `dead_rows`/`dead_mangled` describe the corpses.

**Background you need — three traps, all mandatory:**

1. **Placement.** The corpse-counting block goes **inside the existing outer `try`**, after the evidence-table section and **before** `return CensusResult(...)`. It cannot go after the `try`/`except`/`finally`: the `finally` closes `conn`, so a query there raises `ProgrammingError: Cannot operate on a closed database`.
2. **Variable initialization.** Initialize `dead_rows = 0` and `dead_mangled = 0` **before** the inner `try`, never only inside it. Assigning solely within the `try` leaves them unbound on the failure path and the following `CensusResult(...)` raises `UnboundLocalError`, breaking the never-raises contract.
3. **`dead_mangled` cannot be computed in SQL.** `classify_source_ref` is Python; SQLite knows nothing about it. Count `dead_rows` with `COUNT(*)`, then `SELECT source_ref` for the corpses and classify them in Python. NULL refs are skipped, matching the live loop.

- [ ] **Step 1: Write the failing tests**

Add to `ImportPreflightTests` in `integrations/hermes/tests/test_ct_doctor.py`:

```python
    # --- live-row scoping (2026-09-10 spec) --------------------------------

    def test_soft_deleted_mangled_rows_are_excluded_from_the_census(self):
        """The reference bug: a corpse must not flip the check to FAIL."""
        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("live2", self.TOKEN, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
                ("dead2", self.MANGLED, "librarian_inferred", "2026-01-02"),
                ("dead3", self.TOKEN, "librarian_inferred", "2026-01-03"),
            ],
            with_deleted_at=True,
        )
        census = ct_preflight.census_source_refs(self.brain_db())
        self.assertIsNone(census.error)
        self.assertEqual(census.total, 2)
        self.assertEqual(census.damaged, 0)
        self.assertEqual(census.counts.get("token"), 2)
        self.assertEqual(census.dead_rows, 3)
        # Only the two truncated-token corpses are mangled; the token
        # corpse is healthy. (A JSON corpse would classify "at_risk".)
        self.assertEqual(census.dead_mangled, 2)
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.PASS, r.detail)

    def test_dead_mangled_excludes_at_risk_corpses(self):
        """The predicate is classify == 'mangled', not 'anything unhealthy'."""
        self.assertEqual(
            ct_preflight.classify_source_ref(self.AT_RISK), "at_risk"
        )
        self.assertEqual(
            ct_preflight.classify_source_ref(self.MANGLED), "mangled"
        )
        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("dead1", self.AT_RISK, "librarian_inferred", "2026-01-01"),
                ("dead2", self.MANGLED, "librarian_inferred", "2026-01-02"),
            ],
            with_deleted_at=True,
        )
        census = ct_preflight.census_source_refs(self.brain_db())
        self.assertEqual(census.dead_rows, 2)
        self.assertEqual(census.dead_mangled, 1)

    def test_dead_row_counts_are_scoped_to_librarian_inferred(self):
        """Corpses of other source_types are not this census's business."""
        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
                ("deaddoc", '{"json":"doc"}', "document", "2026-01-01"),
            ],
            with_deleted_at=True,
        )
        census = ct_preflight.census_source_refs(self.brain_db())
        self.assertEqual(census.dead_rows, 1)
        self.assertEqual(census.dead_mangled, 1)

    def test_census_unchanged_when_deleted_at_column_absent(self):
        """Pre-soft-delete engines: the fix is a no-op, not a silent change."""
        self._seed([
            ("e1", self.TOKEN, "librarian_inferred"),
            ("e2", self.MANGLED, "librarian_inferred"),
        ])
        census = ct_preflight.census_source_refs(self.brain_db())
        self.assertEqual(census.total, 2)
        self.assertEqual(census.damaged, 1)
        self.assertEqual(census.dead_rows, 0)
        self.assertEqual(census.dead_mangled, 0)

    def test_deleted_at_scoping_applies_on_the_legacy_unscoped_path(self):
        """deleted_at present, source_type absent: scope by deleted_at alone."""
        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
            ],
            with_source_type=False,
            with_deleted_at=True,
        )
        census = ct_preflight.census_source_refs(self.brain_db())
        self.assertFalse(census.scoped)
        self.assertEqual(census.total, 1)
        self.assertEqual(census.damaged, 0)
        # Table-wide, because there is no source_type to scope by.
        self.assertEqual(census.dead_rows, 1)
        self.assertEqual(census.dead_mangled, 1)

    def test_dead_row_query_failure_leaves_the_live_census_intact(self):
        """Best-effort: an informational query must never degrade the census.

        Force the corpse-loop query to raise the sqlite3 error the inner
        handler catches, proving dead counts fall back to 0 without an error
        result and without UnboundLocalError.

        Implementation note: Python 3.13 made sqlite3.Connection immutable
        (it has been since the C extension landed; 3.13 just hardened the
        type), so the original `mock.patch.object(sqlite3.Connection,
        "execute", ...)` raises TypeError before the census runs. Patch the
        application-owned seam `ct_preflight._connect_readonly` instead and
        wrap the connection's `execute()` to raise only on the
        `deleted_at IS NOT NULL` query — semantically equivalent to the
        original, and the inner handler still catches the same
        OperationalError.
        """
        import sqlite3
        from unittest import mock

        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
            ],
            with_deleted_at=True,
        )

        class _Wrap:
            def __init__(self, conn):
                self._conn = conn

            def __getattr__(self, name):
                return getattr(self._conn, name)

            def execute(self, sql, *args, **kwargs):
                if "deleted_at IS NOT NULL" in sql:
                    raise sqlite3.OperationalError("simulated mid-flight failure")
                return self._conn.execute(sql, *args, **kwargs)

            def close(self):
                self._conn.close()

        real_connect = ct_preflight._connect_readonly

        def fake_connect(db_path):
            return _Wrap(real_connect(db_path))

        with mock.patch.object(ct_preflight, "_connect_readonly", fake_connect):
            census = ct_preflight.census_source_refs(self.brain_db())
        self.assertIsNone(census.error)
        self.assertEqual(census.total, 1)
        self.assertEqual(census.dead_rows, 0)
        self.assertEqual(census.dead_mangled, 0)
```

- [ ] **Step 2: Run to verify failure**

```bash
python -m unittest tests.test_ct_doctor.ImportPreflightTests -v -k dead
python -m unittest tests.test_ct_doctor.ImportPreflightTests.test_soft_deleted_mangled_rows_are_excluded_from_the_census -v
```
Expected: FAIL — `census.total` is 5, not 2, and `dead_rows` is 0. `test_census_unchanged_when_deleted_at_column_absent` should already PASS (it pins today's behavior); that is fine and expected.

- [ ] **Step 3: Implement the scoping**

In `integrations/hermes/scripts/ct_preflight.py`, replace the column-detection and SELECT block (lines 314-324) with:

```python
        cols = _columns(conn, ENTRIES_TABLE)
        scoped = "source_type" in cols
        # Soft-deleted rows are retained forever (the engine has no purge), so
        # a corpse's mangled source_ref would otherwise be counted as live
        # damage and FAIL a healthy brain. The column is detected rather than
        # assumed: it is not part of any schema contract this repo controls,
        # and on a pre-soft-delete engine its absence must leave behavior
        # byte-identical to before.
        has_deleted_at = "deleted_at" in cols
        if scoped:
            sql = (
                "SELECT id, source_ref FROM llm_wiki_entries WHERE source_type = ?"
            )
            if has_deleted_at:
                sql += " AND deleted_at IS NULL"
            rows = conn.execute(sql, (LIBRARIAN_SOURCE_TYPE,)).fetchall()
        else:
            # Older schema with no source_type column: we cannot scope, so we
            # report that plainly rather than risk the §2.5.1 false positive.
            sql = "SELECT id, source_ref FROM llm_wiki_entries"
            if has_deleted_at:
                sql += " WHERE deleted_at IS NULL"
            rows = conn.execute(sql).fetchall()
```

Then insert the corpse-counting block **immediately before** the `return CensusResult(` at line ~380 — inside the outer `try`, after the evidence-table section:

```python
        # Corpse census: informational only, and deliberately isolated. Its
        # own try/except means a failure here can never degrade the primary
        # census to an error result; the counters are initialized before the
        # try so the failure path cannot leave them unbound.
        dead_rows = 0
        dead_mangled = 0
        if has_deleted_at:
            try:
                dead_sql = (
                    "SELECT COUNT(*) FROM llm_wiki_entries "
                    "WHERE deleted_at IS NOT NULL"
                )
                dead_ref_sql = (
                    "SELECT source_ref FROM llm_wiki_entries "
                    "WHERE deleted_at IS NOT NULL"
                )
                if scoped:
                    dead_sql += " AND source_type = ?"
                    dead_ref_sql += " AND source_type = ?"
                    params = (LIBRARIAN_SOURCE_TYPE,)
                else:
                    params = ()
                dead_rows = conn.execute(dead_sql, params).fetchone()[0]
                # classify_source_ref is Python, so the corpses have to be
                # read and classified here rather than counted in SQL. The
                # predicate is "mangled" and only "mangled": at_risk, token
                # and null corpses land in dead_rows but not here, so the
                # number matches the operator-facing wording.
                for (ref,) in conn.execute(dead_ref_sql, params):
                    if ref is None:
                        continue
                    if classify_source_ref(ref) == "mangled":
                        dead_mangled += 1
            except sqlite3.Error:
                pass  # informational only; never degrades the census

```

Finally, add the two fields to the `CensusResult(...)` construction at the end of the success path, after `evidence_table_present=evidence_present,`:

```python
            dead_rows=dead_rows,
            dead_mangled=dead_mangled,
```

- [ ] **Step 4: Run tests**

```bash
python -m unittest discover -s tests
```
Expected: all green, including the pinned `test_document_sourced_255_char_path_is_never_damaged` regression and `test_census_is_scoped_to_librarian_inferred`.

- [ ] **Step 5: Commit**

```bash
git add integrations/hermes/scripts/ct_preflight.py integrations/hermes/tests/test_ct_doctor.py
git commit -m "fix(hermes): scope source_ref census to live rows, count corpses separately"
```

---

### Task 4: Append the informational suffix to the PASS and missing-evidence WARN details

**Files:**
- Modify: `integrations/hermes/scripts/ct_doctor.py:721-748` (`check_import_preflight` tail)
- Test: `integrations/hermes/tests/test_ct_doctor.py`

**Interfaces:**
- Consumes: `census.dead_rows`, `census.dead_mangled` from Task 3.
- Produces: on `CheckResult.detail`, the appended sentence `"; {dead_rows} soft-deleted rows excluded from this census ({dead_mangled} with mangled source_refs)"`.

**Background you need:** No verdict condition changes — this is string work only. The suffix goes on exactly two results: the final PASS and the missing-evidence WARN. The other early returns get nothing, by construction rather than oversight: the census-error WARN returns before a usable census exists, and the "no llm_wiki_entries table yet" PASS returns a `CensusResult(table_present=False)` whose `dead_rows` is 0, so a `dead_rows > 0` guard is already false there. Every FAIL string stays byte-for-byte identical.

On the legacy no-`source_type` path `dead_mangled` is counted table-wide while `classify_source_ref` is only meaningful for librarian rows, so document-sourced corpses can inflate the `(M with mangled)` figure there. That is informational and never affects a verdict; the existing `"; UNSCOPED (no source_type column)"` marker on `shape` is what signals the caveat to operators.

- [ ] **Step 1: Write the failing tests**

Add to `ImportPreflightTests`:

```python
    def test_pass_detail_reports_excluded_corpses(self):
        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
                ("dead2", self.TOKEN, "librarian_inferred", "2026-01-02"),
            ],
            with_deleted_at=True,
        )
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.PASS, r.detail)
        self.assertIn(
            "; 2 soft-deleted rows excluded from this census "
            "(1 with mangled source_refs)",
            r.detail,
        )

    def test_pass_detail_omits_the_suffix_when_there_are_no_corpses(self):
        self._seed(
            [("live1", self.TOKEN, "librarian_inferred")],
            with_deleted_at=True,
        )
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.PASS, r.detail)
        self.assertNotIn("soft-deleted", r.detail)

    def test_missing_evidence_warn_reports_excluded_corpses(self):
        self._seed(
            [
                ("live1", self.TOKEN, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
            ],
            evidence_ids=[],  # evidence table exists but has no rows
            with_deleted_at=True,
        )
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.WARN, r.detail)
        self.assertIn(
            "; 1 soft-deleted rows excluded from this census "
            "(1 with mangled source_refs)",
            r.detail,
        )

    def test_fail_detail_is_unchanged_by_corpse_reporting(self):
        """FAIL strings carry recovery-hint text other work depends on."""
        self._seed(
            [
                ("live1", self.MANGLED, "librarian_inferred"),
                ("dead1", self.MANGLED, "librarian_inferred", "2026-01-01"),
            ],
            with_deleted_at=True,
        )
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("1 of 1 librarian_inferred entries have a mangled", r.detail)
        self.assertNotIn("soft-deleted", r.detail)
```

- [ ] **Step 2: Run to verify failure**

```bash
python -m unittest tests.test_ct_doctor.ImportPreflightTests.test_pass_detail_reports_excluded_corpses -v
```
Expected: FAIL with an `AssertionError` — the suffix is not in `r.detail`.

- [ ] **Step 3: Implement the suffix**

In `integrations/hermes/scripts/ct_doctor.py`, add this helper immediately before the `if damaged:` block (line ~669, right after the `hints = ...` line):

```python
    # Corpse accumulation is expected engine behavior (soft-delete with no
    # purge), so it is reported, never warned about — a permanent WARN would
    # be the same crying-wolf problem as the FAIL this change removes.
    dead_note = (
        f"; {census.dead_rows} soft-deleted rows excluded from this census "
        f"({census.dead_mangled} with mangled source_refs)"
        if census.dead_rows
        else ""
    )
```

Change the missing-evidence WARN's message argument (lines 728-729) to append it:

```python
            f"{census.missing_evidence_rows} of {tokens} token entries have no "
            f"{EVIDENCE_TABLE} row ({shape}; {engine_note})" + dead_note,
```

And append it to the PASS detail. Insert after the `if census.unanchored_rows:` block, immediately before `return CheckResult("import-preflight", PASS, detail)` (line ~748):

```python
    detail += dead_note
```

Leave all three FAIL blocks untouched.

- [ ] **Step 4: Run tests**

```bash
python -m unittest discover -s tests
python scripts/ct_doctor.py --self-test
```
Expected: both green. The `--self-test` run is what CI exercises from outside the checkout.

- [ ] **Step 5: Commit**

```bash
git add integrations/hermes/scripts/ct_doctor.py integrations/hermes/tests/test_ct_doctor.py
git commit -m "feat(hermes): report excluded soft-deleted rows in import-preflight detail"
```

---

### Task 5: Port the census change to the DeepSeek TypeScript twin

`censusSourceRefs` carries the identical unscoped SELECT. Nothing in CI enforces parity, so this task is the only thing standing between DeepSeek users and the same false FAIL.

**Files:**
- Modify: `integrations/deepseek/scripts/ct_preflight.ts:101-165` (`Census`, `CensusInit`, `makeCensus`) and `:308-400` (`censusSourceRefs`)
- Test: `integrations/deepseek/tests/test_ct_preflight.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is an independent port of the same design).
- Produces: `Census.deadRows: number` and `Census.deadMangled: number`, optional on `CensusInit`, defaulting to `0` in `makeCensus`.

**Background you need:** `Census` is a plain interface built by `makeCensus` — there is no `__slots__` equivalent to trip over, and there is no `asDict`/`toJSON` on the TS side, so nothing corresponds to the Python Task 2 serialization work. The `try`/`catch`/`finally` placement constraint **is** the same: `finally` closes the connection, so the corpse queries must sit inside the main `try`, before the `makeCensus(...)` return. TypeScript has no `UnboundLocalError`, but declare `let deadRows = 0; let deadMangled = 0;` outside the inner `try` anyway — `const` inside would not be in scope at the return.

The shared test fixture in `beforeEach` (`test_ct_preflight.ts:19-27`) uses named-column INSERTs everywhere, so adding `deleted_at TEXT` to that schema defaults every existing row to NULL (live) and needs no changes to existing cases.

- [ ] **Step 1: Write the failing tests**

Add `deleted_at TEXT` to the shared schema in `beforeEach` (`integrations/deepseek/tests/test_ct_preflight.ts:20-26`):

```typescript
  db.exec(`
    CREATE TABLE llm_wiki_entries (
      id INTEGER PRIMARY KEY,
      source_ref TEXT,
      source_type TEXT,
      deleted_at TEXT
    );
  `);
```

Add two fixture constants next to the existing `TOKEN` at the top of the file
(line ~11). As on the Python side, **a JSON ref is not a mangled ref** —
`classifySourceRef('{"evidence":[]}')` returns `'at_risk'`:

```typescript
// A token that lost its hex to the engine's setup() rewrite: 'mangled'.
const MANGLED = 'librarian-ab12';
// Whitespace-padded: the engine would rewrite it, so 'at_risk'.
const AT_RISK = `  ${TOKEN}`;
```

Then add these cases inside the existing `describe('censusSourceRefs', ...)` block:

```typescript
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
```

- [ ] **Step 2: Run to verify failure**

Run from `integrations/deepseek/`:
```bash
pnpm run test -- test_ct_preflight
```
Expected: FAIL — `deadRows` is `undefined` and `total` is 5, not 2. `tsc` would also reject `c.deadRows`; that is the same failure.

- [ ] **Step 3: Implement the port**

In `integrations/deepseek/scripts/ct_preflight.ts`, add to the `Census` interface (after `nullRefCount: number;`):

```typescript
  deadRows: number;
  deadMangled: number;
```

Add to `CensusInit` (after `evidenceTablePresent?: boolean | null;`):

```typescript
  deadRows?: number;
  deadMangled?: number;
```

Add to the `makeCensus` return object (after `evidenceTablePresent: init.evidenceTablePresent ?? null,`):

```typescript
    deadRows: init.deadRows ?? 0,
    deadMangled: init.deadMangled ?? 0,
```

Replace the column-detection and SELECT block in `censusSourceRefs` (lines ~329-343):

```typescript
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
```

Insert the corpse block immediately before the `return makeCensus({` at the end of the success path — inside the main `try`, after the evidence-table section:

```typescript
    // Corpse census: informational only, and deliberately isolated. Its own
    // try/catch means a failure here can never degrade the primary census to
    // an error result. Declared with `let` outside the try so both are in
    // scope at the return regardless of which path ran.
    let deadRows = 0;
    let deadMangled = 0;
    if (hasDeletedAt) {
      try {
        let deadSql =
          'SELECT COUNT(*) AS n FROM llm_wiki_entries WHERE deleted_at IS NOT NULL';
        let deadRefSql =
          'SELECT source_ref FROM llm_wiki_entries WHERE deleted_at IS NOT NULL';
        if (scoped) {
          deadSql += ' AND source_type = ?';
          deadRefSql += ' AND source_type = ?';
        }
        const params = scoped ? [LIBRARIAN_SOURCE_TYPE] : [];
        const countRow = conn.prepare(deadSql).get(...params) as
          | { n: number }
          | undefined;
        deadRows = countRow?.n ?? 0;
        // classifySourceRef is TypeScript, so corpses have to be read and
        // classified here rather than counted in SQL. The predicate is
        // 'mangled' and only 'mangled': at_risk, token and null corpses land
        // in deadRows but not here, matching the operator-facing wording.
        const deadRefs = conn.prepare(deadRefSql).all(...params) as Array<{
          source_ref: unknown;
        }>;
        for (const row of deadRefs) {
          if (row.source_ref === null) continue;
          if (classifySourceRef(row.source_ref) === 'mangled') deadMangled += 1;
        }
      } catch {
        // informational only; never degrades the census
      }
    }
```

Add the two fields to the `makeCensus({...})` return, after `evidenceTablePresent: evidencePresent,`:

```typescript
      deadRows,
      deadMangled,
```

- [ ] **Step 4: Run tests and the type check**

```bash
pnpm run test
pnpm exec tsc --noEmit
```
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add integrations/deepseek/scripts/ct_preflight.ts integrations/deepseek/tests/test_ct_preflight.ts
git commit -m "fix(deepseek): scope source_ref census to live rows, count corpses separately"
```

---

### Task 6: Append the informational suffix in the DeepSeek `checkImportPreflight`

**Files:**
- Modify: `integrations/deepseek/scripts/ct_doctor.ts:810-882` (`checkImportPreflight` tail)
- Test: `integrations/deepseek/tests/test_ct_doctor.ts`

**Interfaces:**
- Consumes: `census.deadRows`, `census.deadMangled` from Task 5.
- Produces: the same suffix text as the Python side — `"; {deadRows} soft-deleted rows excluded from this census ({deadMangled} with mangled source_refs)"`.

**Background you need:** Same rules as Task 4 — no verdict change, suffix on the final `_pass` and the missing-evidence `_warn` only, all three `_fail` strings byte-for-byte identical. Keeping the wording character-identical to the Python string matters: these two implementations are compared by operators reading output from both harnesses.

- [ ] **Step 1: Write the failing tests**

`test_ct_doctor.ts` has **no existing preflight cases** — no brain fixture to copy, no preflight `describe` block, and no `checkImportPreflight` import — so this step builds all three. Two file-level edits first:

1. Add `checkImportPreflight` to the existing named imports from `'../scripts/ct_doctor.js'` (lines 7–14):

```typescript
import {
  mcpToolsList,
  runChecks,
  cmdCheck,
  checkDshRegistration,
  checkImportPreflight,
  PASS, WARN, FAIL,
  type CheckResult,
} from '../scripts/ct_doctor.js';
```

2. Add a `better-sqlite3` import beside the other module imports (already a devDependency — `test_ct_preflight.ts` uses it the same way):

```typescript
import Database from 'better-sqlite3';
```

Then append a new self-contained `describe` block at the end of the file. Shape notes, all verified against the source:

- `BrainPaths` (`ct_env.ts:60`) requires `brainDir`, `dbPath`, **and** `configPath` — passing only `{ dbPath }` fails `tsc`. The check reads only `paths.dbPath`, so the other two just have to exist.
- The file-level `beforeEach` blanks `PATH`; that is fine here — `detectEngineVersion` degrades to "engine version unknown".
- These tests import the TS source through vitest, so they run even before `pnpm run build` — no `built` guard needed.
- `mkdtempSync`, `rmSync`, `tmpdir`, and `join` are already imported at the top of the file.
- As everywhere else in this plan, **a JSON ref is not a mangled ref** (`classifySourceRef` returns `'at_risk'`): `MANGLED` below is a truncated token.

```typescript
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
```

Note the first case seeds a *healthy* corpse (id 3, `TOKEN`, deleted) next to the mangled one — that is what makes the suffix read "2 … (1 with mangled …)" instead of "2 … (2 …)", pinning `deadRows` and `deadMangled` as genuinely different counts.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm run test -- test_ct_doctor
```
Expected: the first new test FAILs on the missing suffix; the second should already pass.

- [ ] **Step 3: Implement the suffix**

In `integrations/deepseek/scripts/ct_doctor.ts`, add after the `hints` assignment (line ~818):

```typescript
  // Corpse accumulation is expected engine behavior (soft-delete with no
  // purge), so it is reported, never warned about — a permanent WARN would be
  // the same crying-wolf problem as the FAIL this change removes.
  const deadNote = census.deadRows > 0
    ? `; ${census.deadRows} soft-deleted rows excluded from this census `
      + `(${census.deadMangled} with mangled source_refs)`
    : '';
```

Append it to the missing-evidence WARN message (line ~869-870):

```typescript
      `${census.missingEvidenceRows} of ${tokens} token entries have no `
        + `${EVIDENCE_TABLE} row (${shape}; ${engineNote})` + deadNote,
```

And to the PASS detail, immediately before `return _pass('import-preflight', detail);`:

```typescript
  detail += deadNote;
```

Leave all three `_fail` blocks untouched.

- [ ] **Step 4: Run tests and the type check**

```bash
pnpm run build && pnpm run test
pnpm exec tsc --noEmit
```
Expected: green. `pnpm run build` matters — `lib/` is gitignored and several tests spawn the compiled doctor.

- [ ] **Step 5: Commit**

```bash
git add integrations/deepseek/scripts/ct_doctor.ts integrations/deepseek/tests/test_ct_doctor.ts
git commit -m "feat(deepseek): report excluded soft-deleted rows in import-preflight detail"
```

---

### Task 7: Changelogs and full-repo verification

**Files:**
- Modify: `integrations/hermes/CHANGELOG.md`, `integrations/deepseek/CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-level.

- [ ] **Step 1: Read both changelogs and match their existing format**

```bash
head -30 integrations/hermes/CHANGELOG.md
head -30 integrations/deepseek/CHANGELOG.md
```

Follow whatever heading and version convention is already there (Keep a Changelog `## [Unreleased]`, a dated section, or whatever the file actually does). Do not invent a version number — if the file has no Unreleased section and every heading is a released version, add an Unreleased section at the top.

- [ ] **Step 2: Add an entry to each**

Both entries say the same thing, adapted to each file's format:

```markdown
### Fixed

- `import-preflight` no longer counts soft-deleted `llm_wiki_entries` rows as
  live damage. The census is now scoped to rows with `deleted_at IS NULL` when
  that column exists, so retained issue-#186 corpses can no longer flip a
  healthy brain to FAIL. Soft-deleted rows are reported separately in the
  PASS/WARN detail as informational context. On brains with no `deleted_at`
  column the behavior is unchanged.
```

- [ ] **Step 3: Run every check both integrations declare**

```bash
cd integrations/hermes && python -m unittest discover -s tests && \
  ruff check --select E9,F63,F7,F82,F401 . && \
  python scripts/ct_doctor.py --self-test
cd ../deepseek && pnpm run build && pnpm run test && pnpm exec tsc --noEmit
```
Expected: all green. These are the exact commands `integration.yaml` declares and CI runs.

- [ ] **Step 4: Confirm the spec's acceptance criteria**

Re-read `docs/superpowers/specs/2026-09-10-doctor-preflight-live-scope-design.md` and verify by inspection:

- No `WHERE deleted_at IS NULL` exists anywhere outside a `has_deleted_at` / `hasDeletedAt` guard: `grep -rn "deleted_at" integrations/hermes/scripts integrations/deepseek/scripts`
- No FAIL message string changed: `git diff main -- integrations/hermes/scripts/ct_doctor.py integrations/deepseek/scripts/ct_doctor.ts` and read every hunk.
- No verdict condition changed in either doctor.
- The Python and TypeScript suffix strings are character-identical.

- [ ] **Step 5: Commit and push**

```bash
git add integrations/hermes/CHANGELOG.md integrations/deepseek/CHANGELOG.md
git commit -m "docs(changelog): note import-preflight live-row census scoping"
git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Approach 1 — `deleted_at` detection + live scoping | 3 (py), 5 (ts) |
| Approach 1 — `dead_rows`/`dead_mangled` fields, `__slots__` | 2 (py), 5 (ts) |
| Approach 1 — placement inside outer `try`, pre-init | 3, 5 (stated as mandatory background) |
| Approach 1 — `dead_mangled` predicate, not-in-SQL | 3, 5 |
| Approach 2 — `as_dict()` | 2 |
| Approach 3 — suffix on PASS + missing-evidence WARN only | 4 (py), 6 (ts) |
| Approach 3 — FAIL strings unchanged | 4, 6; verified in 7 |
| Approach 3 — early returns carry no suffix | 4 (background) |
| Approach 4 — DeepSeek parity | 5, 6 |
| Legacy unscoped path caveat | 3, 5 (tests); 4 (background) |
| Error handling — best-effort, never-raises | 3 (`test_dead_row_query_failure_...`), 5 |
| Testing — fixture prerequisite | 1 |
| Testing — all six listed cases | 1, 2, 3, 4 |
| Out of scope — no purge, no FAIL rewording, no unscoped-label fix | Not implemented anywhere; verified in 7 |

**Type consistency:** `dead_rows`/`dead_mangled` (Python) and `deadRows`/`deadMangled` (TypeScript) are used identically in every task that references them. `has_deleted_at`/`hasDeletedAt` is defined in Tasks 3/5 and referenced only there. `_seed`'s new keyword is `with_deleted_at` everywhere.

**Fixture values, verified against the real classifier** (run during planning,
`python3 -c "import ct_preflight; ..."` from `integrations/hermes/scripts`):

| Value | `classify_source_ref` |
|---|---|
| `"librarian-" + "ab12" * 8` | `token` |
| `"librarian-ab12"` (truncated) | `mangled` |
| `"  " + TOKEN` (padded) | `at_risk` |
| `'{"evidence":[]}'` | **`at_risk`**, not `mangled` |

The last row is the trap: an early draft of this plan used a JSON string as its
mangled fixture throughout, which would have made almost every assertion wrong
in a way that looks right. Use the constants, not ad-hoc literals.

**Note for the executor:** Task 6's fixture and call shape are verified against the source as of this rev — `test_ct_doctor.ts` has no preflight cases of its own (the Task 6 `describe` block builds them), and `BrainPaths` (`ct_env.ts:60`) requires `brainDir`, `dbPath`, and `configPath`, so the tests pass the full object. If the file has grown preflight cases by the time you execute, prefer following whatever pattern they settled on.

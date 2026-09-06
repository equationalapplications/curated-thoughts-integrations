#!/usr/bin/env python3
"""ct_preflight.py — import pre-flight for a Curated Thoughts brain.

Curated Thoughts is memory-in-a-box: a brain exported from one machine is
meant to be imported on another and keep working. Two things can quietly
destroy an imported graph before an agent ever reads it, and both are
checkable without writing a byte.

## 1. The engine rewrites `source_ref` on every launch

core-llm-wiki's `setup()` runs an unconditional legacy-ref back-rewrite.
`findRowsForSourceRefMigration()` selects a row if **any of five predicates**
holds (7.1.0 dist/index.js:1454) — not the GLOB alone:

    TRIM(source_ref) != source_ref
    INSTR(source_ref, '/')     > 0
    INSTR(source_ref, '\\')    > 0
    INSTR(source_ref, CHAR(0)) > 0
    source_ref GLOB '*[^-A-Za-z0-9._ ]*'

and rewrites each through `normalizeSourceRef` (7.1.0 dist:4082):

    value.replace(/[^A-Za-z0-9._\\- ]/g, "").trim().slice(0, 255)

Every JSON blob qualifies, so the embedded evidence is destroyed: the
`proposal_id` needed for retraction and the evidence array behind provenance
display. It fires on every app launch and every outbox-worker transition, over
the shared brain.db. The TRIM predicate is the one that does not follow from
the GLOB — **space is inside the keep-set**, so a whitespace-padded ref passes
the GLOB and is still selected. See curated-thoughts PR #188 §1.1/§2.2.

The current pin, 7.1.0, still mangles (PR #188 §3, §7.2).

## 2. The fix changes what a healthy row looks like

Post-#188, CT writes a normalizer-idempotent token into `source_ref` and keeps
the evidence in a CT-owned `librarian_evidence` table the engine never
touches. The token shape is normative (§2.2): `"librarian-"` followed by
**exactly** the first 32 lowercase hex characters of the SHA-256 of the entry
id. §2.5.1's census keys on that exact regex.

## Detection is a positive token-shape test

Per §2.5.1, a row is damaged **iff its `source_ref` does not match the token
shape** — asking "is this the new shape" rather than "does it look mangled",
so detection stays correct regardless of the mangled blobs' internal layout.
The observed `evidence…` prefixes documented in §2.5.4 drive **recovery**, not
detection, and appear here only as an advisory hint.

## Scope matters, or the check cries wolf

§2.5.1 restricts the census to `source_type = 'librarian_inferred'`. A
legitimate document-sourced ref can itself reach the 255-char cap (long vault
paths normalize to exactly 255) and is charset-legal, so an unscoped
shape-based census would classify healthy document rows as damaged. Every
query here carries that predicate.

`NULL` refs are legitimate engine-era data, outside the central invariant's
scope; they are counted separately as `null_ref_count` for visibility only.

Read-only by construction: the database is opened through a `mode=ro` URI and
no statement other than SELECT is ever issued. Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path

# The engine's keep-set, verbatim from normalizeSourceRef (7.1.0 dist:4082).
_NORMALIZE_STRIP = re.compile(r"[^A-Za-z0-9._\- ]")
_NORMALIZE_CAP = 255

# Normative token shape (PR #188 §2.2): exactly 32 lowercase hex characters.
# §2.5.1's census keys on this regex, so it is an equality test, not a prefix.
_TOKEN_RE = re.compile(r"^librarian-[0-9a-f]{32}$")

# Row type the census and every verdict are scoped to (§2.5.1).
LIBRARIAN_SOURCE_TYPE = "librarian_inferred"

# Recovery-shape hints (§2.5.4). serde_json::Map is a BTreeMap and
# `preserve_order` is not active for this crate, so keys serialize
# alphabetically and "evidence" sorts before "proposal_id" — every mangled
# blob begins "evidence". These distinguish which recovery path a damaged row
# would take; they are NOT used for detection.
_RECOVERY_SHAPES = (
    # (prefix, spec path, what survived)
    ("evidenceproposal_id", "§2.5.4b", "proposal_id intact (empty-evidence serialization)"),
    ("evidencechunk_id", "§2.5.4c", "proposal_id truncated away; recover via content_hash"),
)

# Explicit override for locating the engine package, for installs where the
# bundled JS is not in a discoverable node_modules tree.
ENV_ENGINE_PACKAGE = "CT_ENGINE_PACKAGE_JSON"

ENGINE_PACKAGE = "@equationalapplications/core-llm-wiki"


def normalize_source_ref(value):
    """Faithful port of the engine's normalizeSourceRef."""
    if not isinstance(value, str):
        return None
    return _NORMALIZE_STRIP.sub("", value).strip()[:_NORMALIZE_CAP]


def engine_would_rewrite(value):
    """True if `findRowsForSourceRefMigration`'s selector matches this row.

    All five predicates, ORed, exactly as the engine evaluates them. Only the
    GLOB is implied by the keep-set; TRIM adds genuine coverage because space
    is a legal character, so a whitespace-padded ref clears the GLOB and is
    still selected.
    """
    if not isinstance(value, str):
        # SQLite columns are dynamically typed: an imported database can hold
        # an INTEGER, REAL or BLOB here. Nothing non-textual is a value the
        # engine's text predicates would select.
        return False
    if value.strip() != value:          # TRIM(source_ref) != source_ref
        return True
    if "/" in value:                    # INSTR(source_ref, '/') > 0
        return True
    if "\\" in value:                   # INSTR(source_ref, '\') > 0
        return True
    if "\x00" in value:                 # INSTR(source_ref, CHAR(0)) > 0
        return True
    return bool(_NORMALIZE_STRIP.search(value))  # GLOB '*[^-A-Za-z0-9._ ]*'


def is_normalizer_fixed_point(value):
    """True if the engine's rewrite would leave this value unchanged."""
    if not isinstance(value, str):
        return True
    return normalize_source_ref(value) == value


def is_token(value):
    """True if the ref is a well-formed post-#188 token (§2.2)."""
    return isinstance(value, str) and bool(_TOKEN_RE.match(value))


def recovery_shape(value):
    """Advisory (spec_path, description) for a damaged row, or None.

    Per §2.5.4 these shapes drive recovery, never detection.
    """
    if not isinstance(value, str):
        return None
    for prefix, spec_path, desc in _RECOVERY_SHAPES:
        if value.startswith(prefix):
            return (spec_path, desc)
    return None


def classify_source_ref(value):
    """Classify one `source_ref` into a pre-flight state.

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
    """
    if value is None:
        return "null"
    if not isinstance(value, str):
        # A non-TEXT storage value (INTEGER/REAL/BLOB) is certainly not a
        # token, and reaching the regex with one would raise TypeError —
        # which census_source_refs does not catch and run_checks has no
        # boundary for, so `ct_doctor check` would abort on exactly the
        # imported-database case this check exists to inspect.
        return "mangled"
    if is_token(value):
        return "token"
    if engine_would_rewrite(value):
        return "at_risk"
    return "mangled"


class CensusResult:
    """Outcome of a source_ref census, scoped to librarian_inferred rows."""

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
    )

    def __init__(
        self,
        counts=None,
        total=0,
        error=None,
        table_present=False,
        null_ref_count=0,
        scoped=True,
        recovery_hints=None,
        missing_evidence_rows=0,
        unanchored_rows=0,
        evidence_table_present=None,
    ):
        self.counts = counts or {}
        self.total = total
        self.error = error
        self.table_present = table_present
        # NULL refs are legitimate (§2.5.1) and reported for visibility only,
        # never folded into the damaged counts.
        self.null_ref_count = null_ref_count
        # False when the schema has no source_type column and the census could
        # not be restricted to librarian_inferred rows.
        self.scoped = scoped
        self.recovery_hints = recovery_hints or {}
        self.missing_evidence_rows = missing_evidence_rows
        self.unanchored_rows = unanchored_rows
        self.evidence_table_present = evidence_table_present

    @property
    def damaged(self):
        return self.counts.get("mangled", 0)

    @property
    def at_risk(self):
        return self.counts.get("at_risk", 0)

    @property
    def tokens(self):
        return self.counts.get("token", 0)

    def shape(self):
        """Compact 'state=n' summary, or 'empty' when there are no rows."""
        parts = [f"{k}={v}" for k, v in sorted(self.counts.items())]
        if self.null_ref_count:
            parts.append(f"null_ref_count={self.null_ref_count}")
        return ", ".join(parts) if parts else "empty"

    def as_dict(self):
        return {
            "table_present": self.table_present,
            "evidence_table_present": self.evidence_table_present,
            "scoped_to_librarian_inferred": self.scoped,
            "total": self.total,
            "counts": dict(self.counts),
            "null_ref_count": self.null_ref_count,
            "missing_evidence_rows": self.missing_evidence_rows,
            "unanchored_rows": self.unanchored_rows,
            "recovery_hints": dict(self.recovery_hints),
            "error": self.error,
        }


def _connect_readonly(db_path):
    """Open the brain database strictly read-only."""
    uri = "file:" + Path(db_path).as_posix() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5.0)


def _table_exists(conn, name):
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)
    )
    return cur.fetchone() is not None


def _columns(conn, table):
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def census_source_refs(db_path):
    """Census `librarian_inferred` source_refs. Read-only; never raises."""
    if not Path(db_path).is_file():
        return CensusResult(error="brain database not found")
    try:
        conn = _connect_readonly(db_path)
    except sqlite3.Error as exc:
        return CensusResult(error=f"cannot open database read-only: {exc}")
    try:
        if not _table_exists(conn, "llm_wiki_entries"):
            # A brain that has never run the wiki engine has no entries table.
            # That is a legitimate state, not an error.
            return CensusResult(table_present=False)

        cols = _columns(conn, "llm_wiki_entries")
        scoped = "source_type" in cols
        if scoped:
            sql = (
                "SELECT id, source_ref FROM llm_wiki_entries WHERE source_type = ?"
            )
            rows = conn.execute(sql, (LIBRARIAN_SOURCE_TYPE,)).fetchall()
        else:
            # Older schema with no source_type column: we cannot scope, so we
            # report that plainly rather than risk the §2.5.1 false positive.
            rows = conn.execute("SELECT id, source_ref FROM llm_wiki_entries").fetchall()

        counts = {}
        hints = {}
        null_refs = 0
        total = 0
        token_ids = []
        for entry_id, ref in rows:
            if ref is None:
                null_refs += 1
                continue
            total += 1
            state = classify_source_ref(ref)
            counts[state] = counts.get(state, 0) + 1
            if state == "token":
                token_ids.append(entry_id)
            else:
                hint = recovery_shape(ref)
                if hint:
                    key = f"{hint[0]} {hint[1]}"
                    hints[key] = hints.get(key, 0) + 1

        evidence_present = _table_exists(conn, "librarian_evidence")
        missing_evidence = 0
        unanchored = 0
        if evidence_present and token_ids:
            have = set()
            # Chunk the IN list: SQLite's default variable limit is 999.
            for i in range(0, len(token_ids), 500):
                batch = token_ids[i : i + 500]
                q = "SELECT entry_id FROM librarian_evidence WHERE entry_id IN ({})".format(
                    ",".join("?" * len(batch))
                )
                have.update(r[0] for r in conn.execute(q, batch))
            missing_evidence = sum(1 for t in token_ids if t not in have)
            if "unanchored" in _columns(conn, "librarian_evidence"):
                unanchored = conn.execute(
                    "SELECT COUNT(*) FROM librarian_evidence WHERE unanchored = 1"
                ).fetchone()[0]

        return CensusResult(
            counts=counts,
            total=total,
            table_present=True,
            null_ref_count=null_refs,
            scoped=scoped,
            recovery_hints=hints,
            missing_evidence_rows=missing_evidence,
            unanchored_rows=unanchored,
            evidence_table_present=evidence_present,
        )
    except sqlite3.Error as exc:
        return CensusResult(error=f"census query failed: {exc}", table_present=True)
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def has_evidence_table(db_path):
    """True if the post-#188 CT-owned librarian_evidence table exists.

    Its absence on a brain full of token rows means provenance was dropped in
    transit — the export was not brain-complete (PR #188 §2.5.5).
    """
    if not Path(db_path).is_file():
        return None
    try:
        conn = _connect_readonly(db_path)
    except sqlite3.Error:
        return None
    try:
        return _table_exists(conn, "librarian_evidence")
    except sqlite3.Error:
        return None
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def _candidate_engine_manifests(sidecar_path=None, env=None):
    """Plausible locations of the engine's package.json."""
    env = os.environ if env is None else env
    out = []
    override = env.get(ENV_ENGINE_PACKAGE)
    if override:
        out.append(Path(os.path.expanduser(override)))
    rel = Path("node_modules") / ENGINE_PACKAGE / "package.json"
    # A development checkout of curated-thoughts next to / above the sidecar.
    if sidecar_path:
        base = Path(sidecar_path).resolve()
        for parent in list(base.parents)[:6]:
            out.append(parent / rel)
            out.append(parent / "Resources" / rel)
    return out


def detect_engine_version(sidecar_path=None, env=None):
    """Best-effort core-llm-wiki version. Returns (version|None, source|None).

    Reads package.json off disk rather than via `node -e`: the package's
    exports map blocks a `require` of its package.json (PR #188 §2.6, which
    uses `pnpm ls --json` for the same reason). A direct file read is
    unaffected.

    The engine ships inside the desktop app's JS bundle, so on an installed
    app there is often no readable package.json. Unknown is a legitimate,
    non-fatal answer — but when it is found it is the single most useful fact
    about whether an imported brain is safe.
    """
    for manifest in _candidate_engine_manifests(sidecar_path=sidecar_path, env=env):
        try:
            if not manifest.is_file():
                continue
            data = json.loads(manifest.read_text(errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        version = data.get("version")
        if isinstance(version, str) and version.strip():
            return version.strip(), str(manifest)
    return None, None

#!/usr/bin/env python3
"""ct_preflight.py — import pre-flight for a Curated Thoughts brain.

Curated Thoughts is memory-in-a-box: a brain exported from one machine is
meant to be imported on another and keep working. Two things can quietly
destroy an imported graph before an agent ever reads it, and both are
checkable without writing a byte.

## 1. The engine rewrites `source_ref` on every launch

core-llm-wiki's `setup()` runs an unconditional legacy-ref back-rewrite:
`findRowsForSourceRefMigration()` selects every row whose `source_ref`
matches the SQLite GLOB `*[^-A-Za-z0-9._ ]*` — which every JSON blob does —
and pushes it through `normalizeSourceRef`:

    value.replace(/[^A-Za-z0-9._\\- ]/g, "").trim().slice(0, 255)

That destroys the embedded evidence JSON: the `proposal_id` key needed for
retraction, and the evidence array needed for provenance display. It fires on
every app launch and every outbox-worker transition, over the shared brain.db.
See curated-thoughts PR #188 (issue #186) for the full analysis.

The consequence for an *imported* brain is the part this check exists for:
importing a brain onto a machine whose engine still has the rewrite means the
damage happens on that machine, to data that was intact when it was exported.

## 2. The fix changes what a healthy row looks like

Post-#188, CT writes a normalizer-idempotent token (`librarian-<hex>`) into
`source_ref` and keeps the evidence in a CT-owned `librarian_evidence` table
the engine never touches. So a healthy brain has token rows; a brain that
still carries JSON refs is *at risk*, not yet damaged.

This module classifies every `source_ref` into one of those states, so a user
importing a brain learns whether it is engine-proof, at risk, or already
damaged — before an agent starts trusting it.

Read-only by construction: the database is opened through a `mode=ro` URI and
no statement other than SELECT is ever issued. Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path

# The engine's keep-set, verbatim from normalizeSourceRef (dist:3905).
_NORMALIZE_STRIP = re.compile(r"[^A-Za-z0-9._\- ]")
_NORMALIZE_CAP = 255

# Shape of a post-#188 engine-proof token: "librarian-" + lowercase hex.
_TOKEN_RE = re.compile(r"^librarian-[0-9a-f]+$")

# Prefixes left behind when an evidence JSON blob is run through the
# normalizer (the '{"evidence":[{"proposal_id":...' shape loses its
# punctuation and collapses into these).
_MANGLED_PREFIXES = ("evidenceproposal_id", "evidencechunk_id")

# Explicit override for locating the engine package, for installs where the
# bundled JS is not in a discoverable node_modules tree.
ENV_ENGINE_PACKAGE = "CT_ENGINE_PACKAGE_JSON"

ENGINE_PACKAGE = "@equationalapplications/core-llm-wiki"


def normalize_source_ref(value):
    """Faithful port of the engine's normalizeSourceRef."""
    if value is None:
        return None
    return _NORMALIZE_STRIP.sub("", value).strip()[:_NORMALIZE_CAP]


def engine_would_rewrite(value):
    """True if the engine's GLOB selector matches this row.

    The selector is `source_ref GLOB '*[^-A-Za-z0-9._ ]*'`: it matches any
    value containing at least one character outside the keep-set. Those are
    exactly the rows `setup()` rewrites.
    """
    if value is None:
        return False
    return bool(_NORMALIZE_STRIP.search(value))


def is_normalizer_fixed_point(value):
    """True if the engine's rewrite would leave this value unchanged."""
    if value is None:
        return True
    return normalize_source_ref(value) == value


def classify_source_ref(value):
    """Classify one source_ref into a pre-flight state.

    Returns one of:
      "null"       — no ref
      "token"      — post-#188 engine-proof token
      "mangled"    — already destroyed by a previous engine rewrite
      "at_risk"    — structured/JSON ref the engine will rewrite on next setup()
      "stable"     — charset-legal ref (e.g. a document path) already at a
                     normalizer fixed point
    """
    if value is None:
        return "null"
    if _TOKEN_RE.match(value):
        return "token"
    # Damage fingerprint from PR #188 §1.1: the JS cap is exactly 255 and the
    # surviving text starts with the collapsed evidence-key prefix.
    if value.startswith(_MANGLED_PREFIXES):
        return "mangled"
    if len(value) == _NORMALIZE_CAP and is_normalizer_fixed_point(value):
        # Length-255 *and* already charset-legal is the truncation signature;
        # a legitimate ref landing on exactly 255 chars is vanishingly rare.
        return "mangled"
    if engine_would_rewrite(value):
        return "at_risk"
    return "stable"


class CensusResult:
    """Outcome of a source_ref census."""

    __slots__ = ("counts", "total", "error", "table_present")

    def __init__(self, counts=None, total=0, error=None, table_present=False):
        self.counts = counts or {}
        self.total = total
        self.error = error
        self.table_present = table_present

    @property
    def damaged(self):
        return self.counts.get("mangled", 0)

    @property
    def at_risk(self):
        return self.counts.get("at_risk", 0)

    def shape(self):
        """Compact 'state=n' summary, or 'empty' when there are no rows."""
        if not self.counts:
            return "empty"
        return ", ".join(f"{k}={v}" for k, v in sorted(self.counts.items()))

    def as_dict(self):
        return {
            "table_present": self.table_present,
            "total": self.total,
            "counts": dict(self.counts),
            "error": self.error,
        }


def _connect_readonly(db_path):
    """Open the brain database strictly read-only."""
    uri = "file:" + Path(db_path).as_posix() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=5.0)


def census_source_refs(db_path):
    """Classify every llm_wiki_entries.source_ref. Read-only; never raises."""
    if not Path(db_path).is_file():
        return CensusResult(error="brain database not found")
    try:
        conn = _connect_readonly(db_path)
    except sqlite3.Error as exc:
        return CensusResult(error=f"cannot open database read-only: {exc}")
    try:
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_wiki_entries'"
        )
        if cur.fetchone() is None:
            # A brain that has never run the wiki engine has no entries table.
            # That is a legitimate state, not an error.
            return CensusResult(table_present=False)
        counts = {}
        total = 0
        for (ref,) in conn.execute("SELECT source_ref FROM llm_wiki_entries"):
            state = classify_source_ref(ref)
            counts[state] = counts.get(state, 0) + 1
            total += 1
        return CensusResult(counts=counts, total=total, table_present=True)
    except sqlite3.Error as exc:
        return CensusResult(error=f"census query failed: {exc}", table_present=True)
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def has_evidence_table(db_path):
    """True if the post-#188 CT-owned librarian_evidence table exists.

    Its presence is the clearest signal that the brain was written by a
    post-fix Curated Thoughts, and its absence on a brain full of token rows
    would mean provenance was dropped in transit.
    """
    if not Path(db_path).is_file():
        return None
    try:
        conn = _connect_readonly(db_path)
    except sqlite3.Error:
        return None
    try:
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='librarian_evidence'"
        )
        return cur.fetchone() is not None
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

    The engine ships inside the desktop app's JS bundle, so on an installed
    app there is often no readable package.json. Unknown is a legitimate,
    non-fatal answer — hence best-effort — but when it *is* found it is the
    single most useful fact about whether an imported brain is safe.
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

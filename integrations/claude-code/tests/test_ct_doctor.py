#!/usr/bin/env python3
"""Tests for ct_doctor.py using a mock sidecar fixture.

The mock is a tiny Python script that speaks canned JSON-RPC over stdio,
mimicking `curated-thoughts-mcp --mcp` (initialize + tools/list). Tests run
against tempfile dirs and env overrides — nothing on the host is touched.

Run directly:            python3 tests/test_ct_doctor.py
Or via the doctor:       ct_doctor.py --self-test

Copied from integrations/hermes; keep logically identical. The copy lands in
two steps: this file currently carries the fixtures and the classes that
exercise ct_status and ct_preflight, which ship as of Task 2. The ct_doctor
classes — and the base-class lines that reach into ct_doctor — arrive with
ct_doctor.py itself in Task 3.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

# Allow running from any cwd: resolve the integration relative to this file
# (tests live inside the integration: integrations/claude-code/tests/).
HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
sys.path.insert(0, str(INTEGRATION / "scripts"))

import ct_preflight  # noqa: E402
import ct_status  # noqa: E402


IS_WINDOWS = sys.platform == "win32"

# The mock sidecar fixture is a shebang script. POSIX execs it directly via
# the `#!` line; Windows CreateProcess cannot (WinError 193, CI run
# 34066939677) because it has no PATHEXT association. The *shipped* code is
# platform-correct — on Windows ct_env.sidecar_candidates() targets
# curated-thoughts-mcp.exe, which shutil.which resolves — so these tests are
# skipped rather than the fixture rewritten.
MOCK_SPAWN_SKIP = (
    "POSIX-only: mock sidecar is a shebang script, only directly "
    "executable on POSIX (WinError 193 on Windows)"
)
POSIX_PATHS_SKIP = (
    "POSIX-only: asserts POSIX-absolute candidate paths (/usr/bin, .app "
    "bundles); pathlib renders those drive-relative on Windows"
)


MOCK_SIDECAR = r'''#!/usr/bin/env python3
"""Mock curated-thoughts-mcp: canned JSON-RPC over stdio.

Env knobs:
  MOCK_TOOLS        comma-separated tool names to advertise (default: 14)
  MOCK_EXIT_START   if set, exit with this code before answering
  MOCK_HANG         if set, never respond (sleep forever)
"""
import json, os, sys, time

def main():
    tools = os.environ.get("MOCK_TOOLS", ",".join(
        ["wiki_context", "wiki_search", "wiki_traverse_graph", "wiki_get_ontology",
         "vault_semantic_search", "vault_related_chunks", "vault_write_note",
         "vault_upsert_index_entry", "curated_add_wisdom", "curated_update_wisdom",
         "curated_archive_wisdom", "curated_list_wisdom", "curated_get_wisdom",
         "curated_search_wisdom"])).split(",")
    if os.environ.get("MOCK_EXIT_START"):
        sys.exit(int(os.environ["MOCK_EXIT_START"]))
    hang = os.environ.get("MOCK_HANG")
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("method") == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "rmcp-mock", "version": "2.5.0"}}}), flush=True)
        elif msg.get("method") == "tools/list":
            if hang:
                time.sleep(3600)
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "tools": [{"name": t, "description": "mock", "inputSchema": {}} for t in tools]}}),
                flush=True)

main()
'''


class DoctorTestCase(unittest.TestCase):
    """Base: isolated fake home + mock sidecar in a tempfile dir."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ct-doctor-test-")
        self.fake_home = Path(self._tmp.name)
        self.bin_dir = self.fake_home / "bin"
        self.bin_dir.mkdir()
        self.mock_path = self.bin_dir / "curated-thoughts-mcp"
        self.mock_path.write_text(MOCK_SIDECAR)
        self.mock_path.chmod(
            self.mock_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
        )
        self._env_patches = {}
        self.patch_env("HOME", str(self.fake_home))
        # The environment contract is Curated Thoughts' own: CURATED_BRAIN_DIR.
        # There is no CT_VAULT_DIR — nothing in Curated Thoughts reads it.
        self.patch_env("CURATED_BRAIN_DIR", str(self.fake_home / ".brain"))
        self.patch_env("CURATED_BRAIN_DB", None)
        self.patch_env("CURATED_BRAIN_CONFIG", None)
        self.patch_env("OLLAMA_HOST", "http://127.0.0.1:1")  # nothing listens
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for key, value in self._env_patches.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()

    def patch_env(self, key, value):
        self._env_patches[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    # helpers ------------------------------------------------------------

    def make_brain(self, vault=True, vault_exists=True):
        """Create a brain dir with brain.db + config.json, and its vault.

        Mirrors the real layout: the brain dir holds the database and the
        config, and the *vault* is a separate documents tree named by
        config.json's vault_path.
        """
        brain = self.fake_home / ".brain"
        brain.mkdir(parents=True, exist_ok=True)
        (brain / "brain.db").write_bytes(b"")
        config = {}
        if vault:
            vault_dir = self.fake_home / "documents"
            if vault_exists:
                vault_dir.mkdir(parents=True, exist_ok=True)
            config["vault_path"] = str(vault_dir)
        (brain / "config.json").write_text(json.dumps(config))
        return brain

    def brain_db(self):
        return self.fake_home / ".brain" / "brain.db"

    def with_path(self):
        """Return env dict putting the mock first on PATH."""
        return {"PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"]}


class NormalizerPortTests(unittest.TestCase):
    """The classifier reimplements core-llm-wiki's normalizeSourceRef:

        value.replace(/[^A-Za-z0-9._\\- ]/g, "").trim().slice(0, 255)

    If this port drifts, every pre-flight verdict is wrong, so it is pinned
    directly rather than only through the census.
    """

    def test_strips_disallowed_characters(self):
        self.assertEqual(
            ct_preflight.normalize_source_ref('{"a":1}'), "a1"
        )

    def test_keeps_allowed_charset(self):
        keep = "abcXYZ019._- "
        self.assertEqual(ct_preflight.normalize_source_ref(keep), keep.strip())

    def test_trims_then_caps_at_255(self):
        out = ct_preflight.normalize_source_ref("a" * 400)
        self.assertEqual(len(out), 255)

    def test_glob_selector_matches_exactly_the_rewritable(self):
        # engine_would_rewrite must agree with the GLOB '*[^-A-Za-z0-9._ ]*'
        self.assertTrue(ct_preflight.engine_would_rewrite('{"proposal_id":"p1"}'))
        self.assertTrue(ct_preflight.engine_would_rewrite("has/slash"))
        self.assertFalse(ct_preflight.engine_would_rewrite("librarian-deadbeef"))
        self.assertFalse(ct_preflight.engine_would_rewrite("docs_note-1.md"))

    def test_five_predicate_selector(self):
        """PR #188 §2.2: the selector ORs five predicates, not just the GLOB.

        Only TRIM adds coverage the GLOB lacks — space is inside the keep-set,
        so a whitespace-padded ref clears the GLOB and is still selected.
        """
        # TRIM(source_ref) != source_ref
        self.assertTrue(ct_preflight.engine_would_rewrite("  padded.md  "))
        self.assertTrue(ct_preflight.engine_would_rewrite("trailing "))
        self.assertTrue(ct_preflight.engine_would_rewrite(" leading"))
        # INSTR '/' and '\\'
        self.assertTrue(ct_preflight.engine_would_rewrite("docs/note.md"))
        self.assertTrue(ct_preflight.engine_would_rewrite("docs\\note.md"))
        # INSTR CHAR(0)
        self.assertTrue(ct_preflight.engine_would_rewrite("nul\x00byte"))
        # GLOB
        self.assertTrue(ct_preflight.engine_would_rewrite('{"proposal_id":"p"}'))
        # None of the five
        self.assertFalse(ct_preflight.engine_would_rewrite("docs_note-1.md"))
        self.assertFalse(ct_preflight.engine_would_rewrite("librarian-" + "a" * 32))

    def test_space_padded_ref_is_at_risk_not_stable(self):
        # The regression the GLOB-only port missed entirely.
        self.assertEqual(
            ct_preflight.classify_source_ref("  documents_note.md  "), "at_risk"
        )

    def test_token_shape_is_exactly_32_hex(self):
        """§2.2 is normative: 'librarian-' + exactly 32 lowercase hex."""
        good = "librarian-" + "0123456789abcdef" * 2  # 32 chars
        self.assertTrue(ct_preflight.is_token(good))
        self.assertEqual(ct_preflight.classify_source_ref(good), "token")
        for bad in (
            "librarian-abc",                  # too short
            "librarian-" + "a" * 31,          # off by one
            "librarian-" + "a" * 33,          # off by one
            "librarian-" + "A" * 32,          # uppercase
            "librarian-" + "g" * 32,          # non-hex
            "librarian-",                     # empty digest
        ):
            self.assertFalse(ct_preflight.is_token(bad), bad)
            # Detection is the positive token test: not-a-token is damaged.
            self.assertNotEqual(ct_preflight.classify_source_ref(bad), "token", bad)

    def test_token_is_a_fixed_point_of_all_predicates(self):
        token = "librarian-" + "ab12" * 8
        self.assertTrue(ct_preflight.is_normalizer_fixed_point(token))
        self.assertFalse(ct_preflight.engine_would_rewrite(token))
        self.assertEqual(ct_preflight.classify_source_ref(token), "token")

    def test_json_ref_is_at_risk_not_mangled(self):
        self.assertEqual(
            ct_preflight.classify_source_ref('{"evidence":[],"proposal_id":"p1"}'),
            "at_risk",
        )

    def test_already_normalized_non_token_is_mangled(self):
        # A normalizer fixed point that is not a token: the evidence is gone.
        self.assertEqual(
            ct_preflight.classify_source_ref("evidenceproposal_idprop_abc"),
            "mangled",
        )

    def test_recovery_shapes_are_advisory_only(self):
        """§2.5.4 shapes drive recovery, not detection."""
        a, b = "evidenceproposal_idprop_ab", "evidencechunk_idc1content_hashff"
        self.assertIn("2.5.4b", ct_preflight.recovery_shape(a)[0])
        self.assertIn("2.5.4c", ct_preflight.recovery_shape(b)[0])
        self.assertIsNone(ct_preflight.recovery_shape("librarian-" + "a" * 32))
        # Detection does not depend on them: an unrecognised mangled blob is
        # still classified damaged.
        self.assertEqual(ct_preflight.classify_source_ref("some.other.junk"), "mangled")

    def test_null_ref(self):
        self.assertEqual(ct_preflight.classify_source_ref(None), "null")


class StatusSnapshotTests(DoctorTestCase):
    """The session-start snapshot: fast, read-only, fail-open."""

    @unittest.skipIf(IS_WINDOWS, MOCK_SPAWN_SKIP)
    def test_healthy_brain_reports_ok(self):
        self.make_brain()
        snap = ct_status.snapshot(env={**os.environ, **self.with_path()})
        self.assertEqual(snap["status"], ct_status.OK, snap["notes"])

    def test_missing_vault_is_degraded_with_note(self):
        self.make_brain(vault_exists=False)
        snap = ct_status.snapshot(env={**os.environ, **self.with_path()})
        self.assertEqual(snap["status"], ct_status.DEGRADED)
        self.assertTrue(any("vault" in n for n in snap["notes"]), snap["notes"])

    def test_context_section_always_carries_routing_reminder(self):
        self.make_brain()
        section = ct_status.context_section(env={**os.environ, **self.with_path()})
        self.assertIn("wiki_context", section)
        self.assertIn("out-of-band", section)

    def test_snapshot_never_raises_on_broken_env(self):
        snap = ct_status.snapshot(env={"CURATED_BRAIN_DIR": "\x00bad"})
        self.assertIn(snap["status"], (ct_status.OK, ct_status.DEGRADED, ct_status.UNKNOWN))


def load_suite():
    return unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])


if __name__ == "__main__":
    unittest.main(verbosity=2)
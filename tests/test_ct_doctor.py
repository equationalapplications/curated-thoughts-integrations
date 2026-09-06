#!/usr/bin/env python3
"""Tests for ct_doctor.py using a mock sidecar fixture.

The mock is a tiny Python script that speaks canned JSON-RPC over stdio,
mimicking `curated-thoughts-mcp --mcp` (initialize + tools/list). Tests run
against tempfile dirs and env overrides — nothing on the host is touched.

Run directly:            python3 tests/test_ct_doctor.py
Or via the doctor:       ct_doctor.py --self-test
"""

from __future__ import annotations

import contextlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Allow running from any cwd: locate the doctor next to this file.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / ".." / "integrations" / "hermes" / "scripts"))

import ct_doctor  # noqa: E402
import ct_env  # noqa: E402
import ct_preflight  # noqa: E402
import ct_status  # noqa: E402


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

# The check contract, in run order. Consumers of `check --json` rely on it.
EXPECTED_CHECKS = (
    "sidecar-binary",
    "sidecar-identity",
    "sidecar-mcp",
    "brain-dir",
    "vault",
    "embedding-backend",
    "hermes-registration",
    "import-preflight",
    "version-compat",
)

# 8-tool read-only tier names (shared/compat.yaml v2.4-read)
TIER8 = ",".join(
    [
        "wiki_context",
        "wiki_search",
        "wiki_traverse_graph",
        "wiki_get_ontology",
        "vault_semantic_search",
        "vault_related_chunks",
        "vault_write_note",
        "vault_upsert_index_entry",
    ]
)


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
        self.patch_env(
            "HERMES_CONFIG", str(self.fake_home / ".hermes" / "config.yaml")
        )
        for key in ct_doctor.EMBED_ENV_KEYS:
            self.patch_env(key, None)
        self.patch_env("OLLAMA_HOST", "http://127.0.0.1:1")  # nothing listens
        # Re-resolve module-level paths against the fake home.
        ct_doctor.HERMES_CONFIG = Path(os.environ["HERMES_CONFIG"])
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for key, value in self._env_patches.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        ct_doctor.HERMES_CONFIG = Path(
            os.environ.get(
                "HERMES_CONFIG", str(Path.home() / ".hermes" / "config.yaml")
            )
        )
        self._tmp.cleanup()

    def patch_env(self, key, value):
        self._env_patches[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    # helpers ------------------------------------------------------------

    def write_config(self, body=None):
        cfg = self.fake_home / ".hermes" / "config.yaml"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(
            body
            if body is not None
            else (
                "mcp_servers:\n"
                "  curated-thoughts:\n"
                "    command: curated-thoughts-mcp\n"
                '    args: ["--mcp"]\n'
                "plugins:\n"
                "  enabled:\n"
                "    - curated-thoughts\n"
            )
        )
        return cfg

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

    def results_by_name(self, env=None):
        results = ct_doctor.run_checks(
            timeout=3.0,
            env={"PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"], **(env or {})},
        )
        return {r.name: r for r in results}

    def with_path(self):
        """Return env dict putting the mock first on PATH."""
        return {"PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"]}


class MockSidecarRpcTests(DoctorTestCase):
    """The mock itself speaks protocol correctly (guards the fixture)."""

    def test_mock_answers_tools_list(self):
        tools, version, err = ct_doctor.mcp_tools_list(str(self.mock_path), timeout=5)
        self.assertIsNone(err)
        self.assertEqual(len(tools), 14)
        self.assertIn("curated_add_wisdom", tools)
        self.assertEqual(version, "2.5.0")

    def test_mock_read_only_tier(self):
        tools, _, err = ct_doctor.mcp_tools_list(
            str(self.mock_path), timeout=5, env={"MOCK_TOOLS": TIER8}
        )
        self.assertIsNone(err)
        self.assertEqual(len(tools), 8)


class ToolCountTieringTests(DoctorTestCase):
    def test_full_tier_14_tools_pass(self):
        r = ct_doctor.check_sidecar_reachable(
            str(self.mock_path), timeout=5, env=self.with_path()
        )
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("14", r.detail)

    def test_read_only_tier_8_tools_warns(self):
        r = ct_doctor.check_sidecar_reachable(
            str(self.mock_path), timeout=5, env={**self.with_path(), "MOCK_TOOLS": TIER8}
        )
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("dormant", r.detail)
        self.assertIn(">=2.5", r.hint)  # actionable: upgrade hint

    def test_below_tier_warns(self):
        r = ct_doctor.check_sidecar_reachable(
            str(self.mock_path),
            timeout=5,
            env={**self.with_path(), "MOCK_TOOLS": "wiki_search,wiki_context"},
        )
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("below every known tier", r.detail)

    def test_zero_tools_fails(self):
        """tools/list succeeding with 0 tools is a broken install, not a tier."""
        orig = ct_doctor.mcp_tools_list
        ct_doctor.mcp_tools_list = lambda *a, **k: ([], "2.5.0", None)
        try:
            r = ct_doctor.check_sidecar_reachable(str(self.mock_path), timeout=5)
        finally:
            ct_doctor.mcp_tools_list = orig
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("0 tools", r.detail)

    def test_unreachable_sidecar_fails(self):
        r = ct_doctor.check_sidecar_reachable(
            str(self.mock_path),
            timeout=3,
            env={**self.with_path(), "MOCK_HANG": "1"},
        )
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("timed out", r.detail)
        self.assertTrue(r.hint)  # actionable hint present

    def test_crashing_sidecar_fails(self):
        r = ct_doctor.check_sidecar_reachable(
            str(self.mock_path),
            timeout=3,
            env={**self.with_path(), "MOCK_EXIT_START": "7"},
        )
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertTrue(r.hint)

    def test_missing_binary_fails_with_hint(self):
        r = ct_doctor.check_sidecar_reachable(None, timeout=3)
        self.assertEqual(r.status, ct_doctor.FAIL)
        # The hint must be platform-neutral: no .deb, no dpkg, no apt.
        self.assertNotRegex(r.hint.lower(), r"\bdeb\b|dpkg|apt-get")
        self.assertIn("Curated Thoughts", r.hint)


class BrainDirTests(DoctorTestCase):
    """The brain dir holds brain.db + config.json. It is not the vault."""

    def test_missing_brain_dir_fails(self):
        r = ct_doctor.check_brain_dir()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("CURATED_BRAIN_DIR", r.detail)
        self.assertIn("CURATED_BRAIN_DIR", r.hint)

    def test_present_brain_dir_passes(self):
        self.make_brain()
        r = ct_doctor.check_brain_dir()
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_brain_dir_not_a_directory_fails(self):
        (self.fake_home / ".brain").write_text("not a dir")
        r = ct_doctor.check_brain_dir()
        self.assertEqual(r.status, ct_doctor.FAIL)

    def test_brain_dir_without_db_or_config_warns(self):
        (self.fake_home / ".brain").mkdir()
        r = ct_doctor.check_brain_dir()
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("brain.db", r.detail)
        self.assertIn("config.json", r.detail)

    def test_env_override_respected(self):
        alt = self.fake_home / "elsewhere"
        alt.mkdir()
        (alt / "brain.db").write_bytes(b"")
        (alt / "config.json").write_text("{}")
        self.patch_env("CURATED_BRAIN_DIR", str(alt))
        r = ct_doctor.check_brain_dir()
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn(str(alt), r.detail)

    def test_explicit_db_path_moves_config_beside_it(self):
        # CURATED_BRAIN_DB without CURATED_BRAIN_CONFIG puts config.json next
        # to the database, matching curated-thoughts' resolve_brain_paths.
        alt = self.fake_home / "split"
        alt.mkdir()
        db = alt / "brain.db"
        db.write_bytes(b"")
        self.patch_env("CURATED_BRAIN_DB", str(db))
        paths = ct_env.resolve_brain_paths()
        self.assertEqual(paths.db_path, db)
        self.assertEqual(paths.config_path, alt / "config.json")


class VaultTests(DoctorTestCase):
    """The vault is config.json's vault_path — machine-specific, and the
    first thing that breaks when a brain is imported from another machine."""

    def test_missing_config_fails(self):
        (self.fake_home / ".brain").mkdir()
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("not found", r.detail)

    def test_malformed_config_fails(self):
        brain = self.fake_home / ".brain"
        brain.mkdir()
        (brain / "config.json").write_text("{not json")
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("malformed JSON", r.detail)

    def test_vault_path_absent_from_config_fails(self):
        brain = self.fake_home / ".brain"
        brain.mkdir()
        (brain / "config.json").write_text("{}")
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("vault_path", r.detail)

    def test_vault_path_wrong_type_fails(self):
        brain = self.fake_home / ".brain"
        brain.mkdir()
        (brain / "config.json").write_text('{"vault_path": 42}')
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("not a non-empty string", r.detail)

    def test_present_vault_passes(self):
        self.make_brain()
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("documents", r.detail)

    def test_imported_brain_with_foreign_vault_path_fails(self):
        # The signature import symptom: config.json names an absolute path
        # that only ever existed on the machine the brain came from.
        self.make_brain(vault_exists=False)
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("imported from another", r.hint)

    def test_tilde_in_vault_path_is_expanded(self):
        brain = self.fake_home / ".brain"
        brain.mkdir()
        (brain / "config.json").write_text('{"vault_path": "~/docs-tilde"}')
        (self.fake_home / "docs-tilde").mkdir()
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertNotIn("~", r.detail)


class RegistrationTests(DoctorTestCase):
    def test_unregistered_config_fails(self):
        self.write_config("mcp_servers:\n  other-server:\n    command: foo\n")
        r = ct_doctor.check_hermes_registration()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("curated-thoughts", r.hint)
        self.assertIn("mcp_servers", r.hint)

    def test_missing_config_fails(self):
        r = ct_doctor.check_hermes_registration()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("config", r.hint)

    def test_no_mcp_servers_section_fails(self):
        self.write_config("plugins: []\n")
        r = ct_doctor.check_hermes_registration()
        self.assertEqual(r.status, ct_doctor.FAIL)

    def test_registered_passes(self):
        self.write_config()
        r = ct_doctor.check_hermes_registration()
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_registered_without_mcp_flag_warns(self):
        self.write_config(
            "mcp_servers:\n"
            "  curated-thoughts:\n"
            "    command: curated-thoughts-mcp\n"
            "    args: []\n"
        )
        r = ct_doctor.check_hermes_registration()
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("--mcp", r.hint)


class IdentityTests(DoctorTestCase):
    """Identity is decided by 'is this a dev build', not by a Linux prefix."""

    def test_linux_system_path_passes(self):
        r = ct_doctor.check_sidecar_identity("/usr/bin/curated-thoughts-mcp", None)
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_macos_app_bundle_passes(self):
        # Tauri stages the sidecar inside the .app bundle; that is a normal
        # install, not a shadowing dev build.
        p = "/Applications/Curated Thoughts.app/Contents/MacOS/curated-thoughts-mcp"
        r = ct_doctor.check_sidecar_identity(p, p)
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("macos-app-bundle", r.detail)

    def test_windows_install_path_passes(self):
        p = r"C:\Users\me\AppData\Local\Programs\Curated Thoughts\curated-thoughts-mcp.exe"
        r = ct_doctor.check_sidecar_identity(p, p)
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_shadowing_build_warns(self):
        # A same-named binary from a cargo target dir must WARN, with an
        # un-shadow fix hint.
        target = self.fake_home / "proj" / "target" / "debug" / "curated-thoughts-mcp"
        target.parent.mkdir(parents=True)
        target.write_text("#!/bin/sh\n")
        target.chmod(0o755)
        r = ct_doctor.check_sidecar_identity(str(target), str(target))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("PATH", r.hint)

    def test_tools_crate_build_warns(self):
        p = "/home/me/curated-thoughts/tools/curated-thoughts-mcp"
        r = ct_doctor.check_sidecar_identity(p, p)
        self.assertEqual(r.status, ct_doctor.WARN)

    def test_no_dpkg_dependency_anywhere_in_hints(self):
        # Guards the OS-agnostic requirement: no check may tell a macOS or
        # Windows user to reach for a Linux package manager.
        for r in (
            ct_doctor.check_sidecar_binary((None, None, "none")),
            ct_doctor.check_sidecar_identity(None, None),
            ct_doctor.check_sidecar_reachable(None),
            ct_doctor.check_brain_dir(),
        ):
            blob = (r.detail + " " + r.hint).lower()
            self.assertNotRegex(blob, r"\bdeb\b|dpkg|apt-get|yum |\.deb")


class PlatformDiscoveryTests(DoctorTestCase):
    def test_macos_candidates_are_app_bundles(self):
        cands = [str(p) for p in ct_env.sidecar_candidates(platform="darwin")]
        self.assertTrue(any(".app/Contents/MacOS" in c for c in cands), cands)

    def test_windows_candidates_use_exe_and_env_roots(self):
        env = {"LOCALAPPDATA": r"C:\Users\me\AppData\Local"}
        cands = [str(p) for p in ct_env.sidecar_candidates(platform="win32", env=env)]
        self.assertTrue(cands)
        self.assertTrue(all(c.endswith(".exe") for c in cands), cands)

    def test_linux_candidates_cover_usr_and_local(self):
        cands = [str(p) for p in ct_env.sidecar_candidates(platform="linux")]
        self.assertTrue(any(c.startswith("/usr/bin") for c in cands), cands)
        self.assertTrue(any(".local/bin" in c for c in cands), cands)

    def test_path_lookup_wins_over_bundled(self):
        path, _resolved, source = ct_env.find_sidecar(
            env={"PATH": str(self.bin_dir)}
        )
        self.assertEqual(path, str(self.mock_path))
        self.assertEqual(source, "PATH")

    def test_no_binary_warns(self):
        r = ct_doctor.check_sidecar_identity(None, None)
        self.assertEqual(r.status, ct_doctor.WARN)


class EmbeddingTests(DoctorTestCase):
    def test_no_backend_warns_never_fails(self):
        r = ct_doctor.check_embedding()
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("fastembed", r.hint)

    def test_env_key_passes(self):
        os.environ["CT_EMBED_API_KEY"] = "test-only-not-a-secret"
        try:
            r = ct_doctor.check_embedding()
            self.assertEqual(r.status, ct_doctor.PASS)
        finally:
            del os.environ["CT_EMBED_API_KEY"]


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

    def test_token_is_a_fixed_point(self):
        token = "librarian-" + "ab12" * 8
        self.assertTrue(ct_preflight.is_normalizer_fixed_point(token))
        self.assertEqual(ct_preflight.classify_source_ref(token), "token")

    def test_json_ref_is_at_risk_not_mangled(self):
        self.assertEqual(
            ct_preflight.classify_source_ref('{"proposal_id":"p1","evidence":[]}'),
            "at_risk",
        )

    def test_mangled_prefix_is_detected(self):
        self.assertEqual(
            ct_preflight.classify_source_ref("evidenceproposal_id p1 chunk"),
            "mangled",
        )

    def test_255_char_legal_ref_is_treated_as_truncated(self):
        self.assertEqual(ct_preflight.classify_source_ref("a" * 255), "mangled")

    def test_plain_path_ref_is_stable(self):
        self.assertEqual(
            ct_preflight.classify_source_ref("documents_note.md"), "stable"
        )

    def test_null_ref(self):
        self.assertEqual(ct_preflight.classify_source_ref(None), "null")


class ImportPreflightTests(DoctorTestCase):
    """The check that protects an imported graph before an agent trusts it."""

    def _seed_entries(self, refs, with_evidence_table=False):
        import sqlite3

        self.make_brain()
        db = self.brain_db()
        conn = sqlite3.connect(db)
        try:
            conn.execute("CREATE TABLE llm_wiki_entries (id TEXT, source_ref TEXT)")
            conn.executemany(
                "INSERT INTO llm_wiki_entries VALUES (?, ?)",
                [(f"e{i}", r) for i, r in enumerate(refs)],
            )
            if with_evidence_table:
                conn.execute(
                    "CREATE TABLE librarian_evidence "
                    "(entry_id TEXT PRIMARY KEY, proposal_id TEXT, "
                    "evidence_json TEXT, created_at INTEGER)"
                )
            conn.commit()
        finally:
            conn.close()
        return db

    def test_no_table_yet_passes(self):
        self.make_brain()
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("nothing to verify", r.detail)

    def test_healthy_token_brain_passes(self):
        self._seed_entries(
            ["librarian-" + f"{i:032x}" for i in range(3)], with_evidence_table=True
        )
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("engine-proof", r.detail)

    def test_mangled_rows_fail_loudly(self):
        self._seed_entries(["evidenceproposal_id p1 chunk_id c1", "librarian-ab"])
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("mangled", r.detail)
        self.assertIn("#188", r.hint)

    def test_json_refs_flagged_before_damage(self):
        # Not yet damaged, but the next app launch destroys them.
        self._seed_entries(['{"proposal_id":"p1","evidence":[{"chunk_id":"c1"}]}'])
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("will rewrite", r.detail)
        self.assertIn("setup()", r.hint)

    def test_tokens_without_evidence_table_fail(self):
        # The export hazard: entries travelled, librarian_evidence did not.
        self._seed_entries(["librarian-abc123"], with_evidence_table=False)
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("provenance did not", r.hint)

    def test_missing_database_warns_not_fails(self):
        self.make_brain()
        self.brain_db().unlink()
        r = ct_doctor.check_import_preflight()
        self.assertEqual(r.status, ct_doctor.WARN)

    def test_census_never_writes_to_the_database(self):
        db = self._seed_entries(["librarian-abc"], with_evidence_table=True)
        before = db.read_bytes()
        mtime = db.stat().st_mtime
        ct_doctor.check_import_preflight()
        self.assertEqual(db.read_bytes(), before, "pre-flight must not write")
        self.assertEqual(db.stat().st_mtime, mtime)

    def test_engine_version_detected_from_manifest(self):
        pkg = (
            self.fake_home
            / "node_modules"
            / "@equationalapplications"
            / "core-llm-wiki"
            / "package.json"
        )
        pkg.parent.mkdir(parents=True)
        pkg.write_text('{"version": "6.0.1"}')
        version, source = ct_preflight.detect_engine_version(
            env={"CT_ENGINE_PACKAGE_JSON": str(pkg)}
        )
        self.assertEqual(version, "6.0.1")
        self.assertIn("core-llm-wiki", source)

    def test_engine_version_unknown_is_not_an_error(self):
        version, source = ct_preflight.detect_engine_version(env={})
        self.assertIsNone(version)
        self.assertIsNone(source)


class CompatTests(DoctorTestCase):
    def test_tier_matrix_versions(self):
        self.assertEqual(ct_doctor._tier_for((2, 4, 3))[0], "v2.4-read")
        self.assertEqual(ct_doctor._tier_for((2, 4, 9))[0], "v2.4-read")
        self.assertEqual(ct_doctor._tier_for((2, 5, 0))[0], "v2.5-full")
        self.assertEqual(ct_doctor._tier_for((2, 9, 1))[0], "v2.5-full")
        self.assertIsNone(ct_doctor._tier_for((2, 3, 0)))

    def test_version_parse(self):
        self.assertEqual(ct_doctor._parse_version("rmcp 2.4.3"), (2, 4, 3))
        self.assertEqual(ct_doctor._parse_version("2.5"), (2, 5, 0))
        self.assertIsNone(ct_doctor._parse_version("no version here"))

    def test_compat_file_agreement(self):
        # The embedded tier matrix must agree with shared/compat.yaml.
        compat = HERE / ".." / "shared" / "compat.yaml"
        if not compat.exists():
            self.skipTest("shared/compat.yaml not present")
        text = compat.read_text()
        self.assertIn("tools: 8", text)
        self.assertIn("tools: 14", text)
        self.assertIn('">=2.4,<2.5"', text)
        self.assertIn('">=2.5"', text)


class ExitCodeTests(DoctorTestCase):
    def test_exit_code_mapping(self):
        R = ct_doctor.CheckResult
        self.assertEqual(
            ct_doctor.exit_code_for([R("a", ct_doctor.PASS, "")]), 0
        )
        self.assertEqual(
            ct_doctor.exit_code_for([R("a", ct_doctor.WARN, "")]), 2
        )
        self.assertEqual(
            ct_doctor.exit_code_for(
                [R("a", ct_doctor.WARN, ""), R("b", ct_doctor.FAIL, "")]
            ),
            1,
        )


class FullRunTests(DoctorTestCase):
    def test_json_output_shape(self):
        self.make_brain()
        self.write_config()
        out = subprocess.run(
            [
                sys.executable,
                str(HERE / ".." / "integrations" / "hermes" / "scripts" / "ct_doctor.py"),
                "check",
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"]},
        )
        data = json.loads(out.stdout)
        self.assertIn("exit_code", data)
        self.assertEqual(len(data["checks"]), len(EXPECTED_CHECKS))
        for chk in data["checks"]:
            self.assertIn(chk["status"], ("PASS", "WARN", "FAIL"))

    def test_doctor_is_read_only(self):
        # A full run must not create or modify anything in the fake home
        # beyond what the test itself set up.
        self.make_brain()
        self.write_config()
        before = sorted(str(p) for p in self.fake_home.rglob("*"))
        ct_doctor.run_checks(timeout=3, env=self.with_path())
        after = sorted(str(p) for p in self.fake_home.rglob("*"))
        self.assertEqual(before, after)


class SelfTestCliTests(unittest.TestCase):
    """Gap: `ct_doctor.py --self-test` as a real subprocess, from a temp cwd."""

    DOCTOR = (HERE / ".." / "integrations" / "hermes" / "scripts" / "ct_doctor.py").resolve()

    @classmethod
    def setUpClass(cls):
        # ct_doctor.py --self-test runs THIS module; without this guard each
        # spawned child would spawn another --self-test forever.
        if os.environ.get("CT_DOCTOR_IN_SELF_TEST") == "1":
            raise unittest.SkipTest("recursion guard: already inside --self-test child")

    def _run_self_test(self):
        with tempfile.TemporaryDirectory(prefix="ct-selftest-cwd-") as cwd:
            return subprocess.run(
                [sys.executable, str(self.DOCTOR), "--self-test"],
                capture_output=True,
                text=True,
                timeout=180,
                cwd=cwd,  # temp cwd proves the script resolves tests/ from __file__
                env={**os.environ, "CT_DOCTOR_IN_SELF_TEST": "1"},
            )

    def test_self_test_exits_zero_with_ok_summary(self):
        proc = self._run_self_test()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # unittest.TextTestRunner writes its summary to stderr.
        self.assertIn("OK", proc.stderr)
        self.assertIn("Ran ", proc.stderr)

    def _run_doctor(self, *argv):
        with tempfile.TemporaryDirectory(prefix="ct-selftest-cwd-") as cwd:
            return subprocess.run(
                [sys.executable, str(self.DOCTOR), *argv],
                capture_output=True,
                text=True,
                timeout=180,
                cwd=cwd,
                env={**os.environ, "CT_DOCTOR_IN_SELF_TEST": "1"},
            )

    def test_self_test_accepted_after_subcommand(self):
        # The regression: `check --self-test` used to exit 2 (unrecognized),
        # because --self-test lives on the main parser. It must now run the
        # suite and take precedence over the subcommand.
        proc = self._run_doctor("check", "--self-test")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Ran ", proc.stderr)

    def test_self_test_wins_over_subcommand_options(self):
        # Even alongside a subcommand option, the global flag wins: the
        # suite runs instead of emitting check's JSON payload.
        proc = self._run_doctor("check", "--json", "--self-test")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Ran ", proc.stderr)
        self.assertNotIn('"exit_code"', proc.stdout)

    def test_self_test_accepted_before_subcommand(self):
        proc = self._run_doctor("--self-test", "check")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Ran ", proc.stderr)

    def test_unknown_option_still_errors(self):
        # Stripping --self-test must not turn the parser permissive:
        # a typo'd option still exits 2 rather than silently running check.
        proc = self._run_doctor("check", "--jsno")
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("unrecognized arguments", proc.stderr)


class CheckJsonCliTests(DoctorTestCase):
    """Gap: --json shape from the real CLI path (not run_checks directly)."""

    def test_json_cli_parseable_and_contracted(self):
        self.make_brain()
        self.write_config()
        out = subprocess.run(
            [
                sys.executable,
                str(HERE / ".." / "integrations" / "hermes" / "scripts" / "ct_doctor.py"),
                "check",
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "PATH": str(self.bin_dir) + os.pathsep + os.environ["PATH"]},
        )
        data = json.loads(out.stdout)
        self.assertIn("exit_code", data)
        self.assertIn("checks", data)
        self.assertEqual(len(data["checks"]), len(EXPECTED_CHECKS))
        names = [c["name"] for c in data["checks"]]
        # The full contract, in order — brain-dir and vault are distinct
        # checks, and import-preflight replaced the old static okf-hygiene.
        self.assertEqual(names, list(EXPECTED_CHECKS))
        for chk in data["checks"]:
            self.assertEqual(set(chk), {"name", "status", "detail", "hint"})
            self.assertIn(chk["status"], ("PASS", "WARN", "FAIL"))


class VersionCompatTests(DoctorTestCase):
    """Version is corroborating metadata; tool count is the tier authority.

    The sidecar has no --version flag, and MCP serverInfo reports the rmcp
    framework version rather than the Curated Thoughts release — which is why
    the old serverInfo sanity-window heuristic was removed. An undiscoverable
    version must therefore be unremarkable (PASS), never a warning that every
    macOS and Windows user sees.
    """

    def _patch_no_dpkg(self):
        """Force the dpkg-query branch to fail (as on macOS/Windows)."""
        orig = ct_doctor.subprocess.run

        def fake_run(cmd, *a, **k):
            if cmd[:2] == ["dpkg-query", "-W"]:
                raise FileNotFoundError("no dpkg on this platform")
            return orig(cmd, *a, **k)

        ct_doctor.subprocess.run = fake_run
        self.addCleanup(setattr, ct_doctor.subprocess, "run", orig)

    def _patch_dpkg_version(self, version):
        orig = ct_doctor.subprocess.run

        def fake_run(cmd, *a, **k):
            if cmd[:2] == ["dpkg-query", "-W"]:
                return subprocess.CompletedProcess(cmd, 0, version, "")
            return orig(cmd, *a, **k)

        ct_doctor.subprocess.run = fake_run
        self.addCleanup(setattr, ct_doctor.subprocess, "run", orig)

    def test_undiscoverable_version_with_tool_count_passes(self):
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path), tool_count=14)
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("v2.5-full", r.detail)
        self.assertIn("tool count", r.detail)

    def test_undiscoverable_version_without_tool_count_still_passes(self):
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path), tool_count=None)
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_dpkg_version_agreeing_with_tools_passes(self):
        self._patch_dpkg_version("2.5.1")
        r = ct_doctor.check_version_compat(str(self.mock_path), tool_count=14)
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("v2.5-full", r.detail)

    def test_version_disagreeing_with_tool_count_warns(self):
        # The genuinely useful case: package says 2.5, but a stale sidecar
        # process is still serving the 8-tool surface.
        self._patch_dpkg_version("2.5.1")
        r = ct_doctor.check_version_compat(str(self.mock_path), tool_count=8)
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("disagree", r.hint)
        self.assertIn("v2.4-read", r.detail)

    def test_pre_tier_version_warns(self):
        self._patch_dpkg_version("2.3.0")
        r = ct_doctor.check_version_compat(str(self.mock_path), tool_count=8)
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("outside every tier", r.detail)

    def test_tier_for_tool_count(self):
        self.assertEqual(ct_doctor._tier_for_tool_count(14), "v2.5-full")
        self.assertEqual(ct_doctor._tier_for_tool_count(20), "v2.5-full")
        self.assertEqual(ct_doctor._tier_for_tool_count(8), "v2.4-read")
        self.assertIsNone(ct_doctor._tier_for_tool_count(3))
        self.assertIsNone(ct_doctor._tier_for_tool_count(0))


class StatusSnapshotTests(DoctorTestCase):
    """The session-start snapshot: fast, read-only, fail-open."""

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

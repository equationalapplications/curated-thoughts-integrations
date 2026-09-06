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
        self.patch_env("CT_VAULT_DIR", str(self.fake_home / ".brain"))
        self.patch_env(
            "HERMES_CONFIG", str(self.fake_home / ".hermes" / "config.yaml")
        )
        for key in ct_doctor.EMBED_ENV_KEYS:
            self.patch_env(key, None)
        self.patch_env("OLLAMA_HOST", "http://127.0.0.1:1")  # nothing listens
        # Re-resolve module-level paths against the fake home.
        ct_doctor.VAULT_DIR = Path(os.environ["CT_VAULT_DIR"])
        ct_doctor.HERMES_CONFIG = Path(os.environ["HERMES_CONFIG"])
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for key, value in self._env_patches.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        ct_doctor.VAULT_DIR = Path(
            os.environ.get("CT_VAULT_DIR", str(Path.home() / ".brain"))
        )
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
            )
        )
        return cfg

    def make_brain(self):
        brain = self.fake_home / ".brain"
        brain.mkdir(parents=True, exist_ok=True)
        return brain

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
        self.assertIn("v2.5", r.hint)  # actionable: upgrade hint

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
        self.assertIn("deb", r.hint)


class VaultTests(DoctorTestCase):
    def test_vault_missing_fails(self):
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn("CT_VAULT_DIR", r.detail)
        self.assertIn("CT_VAULT_DIR", r.hint)

    def test_vault_present_passes(self):
        self.make_brain()
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_vault_not_a_directory_fails(self):
        brain = self.fake_home / ".brain"
        brain.write_text("not a dir")
        r = ct_doctor.check_vault()
        self.assertEqual(r.status, ct_doctor.FAIL)

    def test_env_override_respected(self):
        alt = self.fake_home / "elsewhere"
        alt.mkdir()
        os.environ["CT_VAULT_DIR"] = str(alt)
        try:
            ct_doctor.VAULT_DIR = alt
            r = ct_doctor.check_vault()
            self.assertEqual(r.status, ct_doctor.PASS)
            self.assertIn(str(alt), r.detail)
        finally:
            ct_doctor.VAULT_DIR = Path(self.fake_home / ".brain")


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
    def test_dpkg_path_passes(self):
        r = ct_doctor.check_sidecar_identity("/usr/bin/curated-thoughts-mcp", None)
        self.assertEqual(r.status, ct_doctor.PASS)

    def test_shadowing_build_warns(self):
        # A same-named binary resolving outside the dpkg prefixes (e.g. a
        # cargo target dir) must WARN, with an un-shadow fix hint.
        target = self.fake_home / "proj" / "target" / "debug" / "curated-thoughts-mcp"
        target.parent.mkdir(parents=True)
        target.write_text("#!/bin/sh\n")
        target.chmod(0o755)
        r = ct_doctor.check_sidecar_identity(str(target), str(target))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("PATH", r.hint)

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


class OkfAndCompatTests(DoctorTestCase):
    def test_okf_advisory_always_passes_with_hint(self):
        r = ct_doctor.check_okf_hygiene()
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("If-Match", r.hint)

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
        self.assertEqual(len(data["checks"]), 8)
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
        self.assertEqual(len(data["checks"]), 8)
        names = [c["name"] for c in data["checks"]]
        self.assertIn("version-compat", names)
        for chk in data["checks"]:
            self.assertEqual(set(chk), {"name", "status", "detail", "hint"})
            self.assertIn(chk["status"], ("PASS", "WARN", "FAIL"))


class VersionFallbackTests(DoctorTestCase):
    """Gap: check_version_compat's serverInfo.version sanity-window branch.

    dpkg-query is unavailable/failing in the test env, so the fallback reads
    serverInfo.version from the (mocked) handshake. We monkeypatch
    mcp_tools_list to control the reported version deterministically and to
    avoid real subprocess handshakes.
    """

    def setUp(self):
        super().setUp()
        self._orig_mcp_tools_list = ct_doctor.mcp_tools_list
        self.addCleanup(self._restore)

    def _restore(self):
        ct_doctor.mcp_tools_list = self._orig_mcp_tools_list

    def _mock_handshake(self, server_version):
        def fake(path, timeout=ct_doctor.MCP_TIMEOUT, env=None):
            return (["wiki_context"], server_version, None)

        ct_doctor.mcp_tools_list = fake

    def _patch_no_dpkg(self):
        """Force the dpkg-query branch to fail so the fallback is exercised."""
        orig = ct_doctor.subprocess.run

        def fake_run(cmd, *a, **k):
            if cmd[:2] == ["dpkg-query", "-W"]:
                raise FileNotFoundError("no dpkg in test env")
            return orig(cmd, *a, **k)

        ct_doctor.subprocess.run = fake_run
        self.addCleanup(setattr, ct_doctor.subprocess, "run", orig)

    def test_in_window_low_bound_1_0(self):
        # 1.0.0 passes the sanity window (so it's reported as a detected
        # version) but is below every tier → WARN "outside every tier",
        # NOT the "could not determine" path.
        self._mock_handshake("1.0.0")
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("serverInfo.version='1.0.0'", r.detail)
        self.assertIn("outside every tier", r.detail)

    def test_in_window_high_bound_30_0(self):
        # (30,0) itself would be in the window, but any full triple like
        # 30.0.0 compares greater than (30, 0) and is rejected → undetermined
        # WARN. Effectively the sanity window's usable ceiling is < 30.
        self._mock_handshake("30.0.0")
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("could not determine", r.detail)

    def test_in_window_realistic_2_5(self):
        self._mock_handshake("2.5.0")
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path))
        self.assertEqual(r.status, ct_doctor.PASS)
        self.assertIn("v2.5-full", r.detail)

    def test_out_of_window_zero_rejected(self):
        # 0.x < (1,0): the sanity window must reject it → undetermined WARN.
        self._mock_handshake("0.9.4")
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("could not determine", r.detail)

    def test_out_of_window_above_30_rejected(self):
        # > (30,0) is not a plausible sidecar version (it's a framework
        # version) → the sanity window rejects it → undetermined WARN.
        self._mock_handshake("99.99.0")
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("could not determine", r.detail)

    def test_unparseable_server_version_rejected(self):
        self._mock_handshake("rmcp-abc-dev")
        self._patch_no_dpkg()
        r = ct_doctor.check_version_compat(str(self.mock_path))
        self.assertEqual(r.status, ct_doctor.WARN)
        self.assertIn("could not determine", r.detail)


def load_suite():
    return unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])


if __name__ == "__main__":
    unittest.main(verbosity=2)

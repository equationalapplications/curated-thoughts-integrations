#!/usr/bin/env python3
"""Subprocess tests for integrations/hermes/scripts/install.sh.

Run install.sh with bash itself, HOME pointed at a tempfile dir so nothing on
the host is touched. Covers the reviewer-identified gaps:
  - fresh install creates the plugin dir and copies files
  - idempotent rerun exits 0
  - an existing curated-thoughts config entry is never modified (byte-compare)
  - a loose ~/.hermes/skills/curated-thoughts* collision only WARNs; files stay
  - __pycache__/.git present in the SOURCE checkout are pruned from the DEST
    copy only, never from the source itself

Run directly:  python3 tests/test_install.py
Or:            python3 -m unittest discover -s tests
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE / ".."
INSTALL_SH = (REPO / "integrations" / "hermes" / "scripts" / "install.sh").resolve()
PLUGIN_SRC = (REPO / "integrations" / "hermes").resolve()
SCRIPT_TIMEOUT = 60  # every subprocess gets a hard timeout


def run_install(home: Path, extra_env=None, cwd="/", install_sh=INSTALL_SH):
    """Run install.sh with bash, HOME=home, cwd outside the repo tree.

    ``install_sh`` lets a test point at a copy of the plugin tree so it can
    stage fixtures without writing into the shared repository checkout.
    """
    env = {
        **os.environ,
        "HOME": str(home),
        # keep the config check deterministic even if the host sets this
        "HERMES_CONFIG": str(home / ".hermes" / "config.yaml"),
    }
    env.pop("CT_INSTALL_EDIT", None)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", str(install_sh)],
        capture_output=True,
        text=True,
        timeout=SCRIPT_TIMEOUT,
        env=env,
        cwd=cwd,
    )


class InstallShTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ct-install-test-")
        self.home = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    # helpers ------------------------------------------------------------

    @property
    def dest(self) -> Path:
        return self.home / ".hermes" / "plugins" / "curated-thoughts"

    def installed_paths(self) -> list[str]:
        return sorted(str(p.relative_to(self.dest)) for p in self.dest.rglob("*"))

    def source_paths(self) -> list[str]:
        return sorted(str(p.relative_to(PLUGIN_SRC)) for p in PLUGIN_SRC.rglob("*"))


class FreshInstallTests(InstallShTestCase):
    def test_fresh_install_creates_plugin_dir_and_copies_files(self):
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(self.dest.is_dir())
        copied = self.installed_paths()
        # Every tracked source file lands in the destination (junk dirs are
        # intentionally pruned from dest, so exclude them from the expectation).
        for rel in self.source_paths():
            if "__pycache__" in rel.split("/") or rel.split("/")[0] == ".git":
                continue
            self.assertIn(rel, copied)
        for sentinel in (
            "plugin.yaml",
            "__init__.py",
            "scripts/ct_doctor.py",
            "scripts/ct_env.py",
            "scripts/ct_preflight.py",
            "scripts/ct_status.py",
            "scripts/install.sh",
            "hooks/session-start.py",
        ):
            self.assertTrue((self.dest / sentinel).is_file(), sentinel)
        # Shipped skills make it over too.
        self.assertTrue((self.dest / "skills" / "curated-thoughts-usage" / "SKILL.md").is_file())
        self.assertIn("copied plugin contents", proc.stdout)
        self.assertIn("creating:", proc.stdout)

    def test_fresh_install_prints_mcp_block_but_does_not_write_config(self):
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("mcp_servers:", proc.stdout)
        self.assertIn("CT_INSTALL_EDIT=1", proc.stdout)
        self.assertFalse((self.home / ".hermes" / "config.yaml").exists())


class IdempotencyTests(InstallShTestCase):
    def test_rerun_exits_zero_and_refreshes_files(self):
        first = run_install(self.home)
        self.assertEqual(first.returncode, 0, first.stderr)
        # Drop a marker file the way a user's extra file would persist.
        marker = self.dest / "scripts" / "user-extra.txt"
        marker.write_text("keep me\n")
        second = run_install(self.home)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("destination exists", second.stdout)
        self.assertIn("refreshing plugin files", second.stdout)
        self.assertTrue(self.dest.is_dir())
        self.assertTrue((self.dest / "plugin.yaml").is_file())
        # Merge-copy semantics: pre-existing extra files are left in place.
        self.assertTrue(marker.is_file())

    def test_rerun_does_not_duplicate_config_append(self):
        first = run_install(self.home, extra_env={"CT_INSTALL_EDIT": "1"})
        self.assertEqual(first.returncode, 0, first.stderr)
        cfg = self.home / ".hermes" / "config.yaml"
        after_first = cfg.read_bytes()
        second = run_install(self.home, extra_env={"CT_INSTALL_EDIT": "1"})
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(cfg.read_bytes(), after_first)
        self.assertIn("already present", second.stdout)


class ConfigPreservationTests(InstallShTestCase):
    def test_existing_curated_thoughts_entry_is_never_modified(self):
        cfg_dir = self.home / ".hermes"
        cfg_dir.mkdir(parents=True)
        cfg = cfg_dir / "config.yaml"
        original = (
            "# my hermes config\n"
            "theme: dark\n"
            "mcp_servers:\n"
            "  curated-thoughts:\n"
            "    command: /custom/path/curated-thoughts-mcp\n"
            "    args: [\"--mcp\", \"--custom-flag\"]\n"
            "  other-server:\n"
            "    command: foo\n"
        )
        cfg.write_text(original)
        before = cfg.read_bytes()
        proc = run_install(self.home, extra_env={"CT_INSTALL_EDIT": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(cfg.read_bytes(), before, "config must be byte-identical")
        self.assertIn("already present", proc.stdout)
        self.assertIn("nothing changed", proc.stdout)

    def test_existing_section_without_ct_entry_is_not_touched_even_with_edit(self):
        cfg_dir = self.home / ".hermes"
        cfg_dir.mkdir(parents=True)
        cfg = cfg_dir / "config.yaml"
        original = "mcp_servers:\n  other-server:\n    command: foo\n"
        cfg.write_text(original)
        before = cfg.read_bytes()
        proc = run_install(self.home, extra_env={"CT_INSTALL_EDIT": "1"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(cfg.read_bytes(), before, "manual-insertion case must not write")
        self.assertIn("INSIDE that section", proc.stdout)


class SkillCollisionTests(InstallShTestCase):
    def test_loose_skill_collision_warns_and_files_untouched(self):
        skills = self.home / ".hermes" / "skills"
        coll1 = skills / "curated-thoughts-usage"
        coll2 = skills / "curated-thoughts-ops"
        coll1.mkdir(parents=True)
        coll2.mkdir(parents=True)
        (coll1 / "SKILL.md").write_text("user's own loose skill\n")
        (coll2 / "SKILL.md").write_text("user's own loose skill\n")
        before1 = (coll1 / "SKILL.md").read_bytes()
        before2 = (coll2 / "SKILL.md").read_bytes()
        before_tree = sorted(str(p) for p in skills.rglob("*"))

        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # WARN lines land on stderr with actionable text.
        self.assertIn("WARN:", proc.stderr)
        self.assertIn("COLLISION (pre-existing, untouched)", proc.stdout)
        self.assertIn(str(coll1), proc.stdout)
        self.assertIn("never move, rename, or delete", proc.stderr)
        # Collision contents and tree are byte-for-byte untouched.
        self.assertEqual((coll1 / "SKILL.md").read_bytes(), before1)
        self.assertEqual((coll2 / "SKILL.md").read_bytes(), before2)
        self.assertEqual(sorted(str(p) for p in skills.rglob("*")), before_tree)

    def test_no_collision_reports_clean(self):
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("WARN:", proc.stderr)
        self.assertIn("nothing to warn about", proc.stdout)


class PruneJunkTests(InstallShTestCase):
    """__pycache__/.git in the SOURCE checkout are pruned from the DEST copy
    only — the source itself must never be modified."""

    def setUp(self):
        super().setUp()
        # Stage the dirty checkout in an isolated *copy* of the plugin tree.
        # Writing junk into the shared PLUGIN_SRC would fail on a read-only
        # checkout and race with parallel test processes.
        src_tmp = tempfile.TemporaryDirectory(prefix="ct-install-src-")
        self.addCleanup(src_tmp.cleanup)
        self.src = Path(src_tmp.name) / "hermes"
        shutil.copytree(PLUGIN_SRC, self.src)
        self.install_sh = self.src / "scripts" / "install.sh"

        self.junk_pycache = self.src / "scripts" / "__pycache__"
        self.junk_pycache.mkdir(parents=True, exist_ok=True)
        (self.junk_pycache / "junk.cpython-311.pyc").write_bytes(b"\x00junk")
        self.junk_git = self.src / ".git"
        self.junk_git.mkdir(exist_ok=True)
        (self.junk_git / "HEAD").write_text("ref: fake\n")

    def test_junk_pruned_from_dest_not_from_source(self):
        self.assertTrue(self.junk_pycache.exists(), "fixture needs source junk")
        proc = run_install(self.home, install_sh=self.install_sh)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # DEST: no __pycache__ or .git anywhere under the installed plugin.
        for p in self.dest.rglob("*"):
            self.assertNotIn(p.name, ("__pycache__", ".git"), str(p))
        # SOURCE: untouched — pruning must never mutate the checkout.
        self.assertTrue(self.junk_pycache.exists())
        self.assertTrue((self.junk_pycache / "junk.cpython-311.pyc").exists())
        self.assertTrue(self.junk_git.exists(), "source .git must not be deleted")
        self.assertTrue((self.junk_git / "HEAD").exists())
        self.assertIn("copied plugin contents", proc.stdout)


class StaleManifestPruneTests(InstallShTestCase):
    """Pre-0.2 installs shipped plugin.json + hooks/hooks.json (Claude Code's
    format — Hermes never read them). The installer must prune them from the
    plugin-owned DEST so a stale copy can't mask the real plugin.yaml, the
    way a stale destination copy misled dogfood debugging on 2026-09-06."""

    def test_upgrade_from_pre_02_install_prunes_stale_claude_code_manifests(self):
        # Simulate the real upgrade path: a destination that predates the
        # plugin.yaml era, holding the two stale files (and nothing else —
        # hooks/hooks.json lives in a hooks/ dir the repo no longer ships).
        self.dest.mkdir(parents=True)
        (self.dest / "plugin.json").write_text('{"name": "curated-thoughts"}\n')
        stale_hooks = self.dest / "hooks"
        stale_hooks.mkdir()
        (stale_hooks / "hooks.json").write_text("{}\n")
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse((self.dest / "plugin.json").exists())
        self.assertFalse((self.dest / "hooks" / "hooks.json").exists())
        # hooks/ itself REMAINS — the merge-copy lands the real
        # hooks/session-start.py; only the stale hooks.json is pruned.
        self.assertFalse(stale_hooks.exists() and not (stale_hooks / "session-start.py").exists(),
                         "hooks/ exists but session-start.py did not land")
        self.assertTrue((stale_hooks / "session-start.py").exists())
        # The real manifest still landed.
        self.assertTrue((self.dest / "plugin.yaml").exists())

    def test_stale_manifests_in_source_checkout_are_also_pruned_from_dest(self):
        # A dirty checkout carrying the old files must not re-pollute DEST.
        src_tmp = tempfile.TemporaryDirectory(prefix="ct-install-src-")
        self.addCleanup(src_tmp.cleanup)
        src = Path(src_tmp.name) / "hermes"
        shutil.copytree(PLUGIN_SRC, src)
        (src / "plugin.json").write_text('{"name": "curated-thoughts"}\n')
        (src / "hooks").mkdir(exist_ok=True)
        (src / "hooks" / "hooks.json").write_text("{}\n")
        proc = run_install(self.home, install_sh=src / "scripts" / "install.sh")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse((self.dest / "plugin.json").exists())
        self.assertFalse((self.dest / "hooks" / "hooks.json").exists())
        # SOURCE stays untouched — pruning must never mutate the checkout.
        self.assertTrue((src / "plugin.json").exists())
        self.assertTrue((src / "hooks" / "hooks.json").exists())
        self.assertTrue((self.dest / "plugin.yaml").exists())

    def test_symlinked_hooks_dir_is_not_followed_during_prune(self):
        # If DEST/hooks is a symlink, pruning must refuse it rather than
        # delete hooks.json out of whatever it points at.
        outside_tmp = tempfile.TemporaryDirectory(prefix="ct-install-outside-")
        self.addCleanup(outside_tmp.cleanup)
        outside = Path(outside_tmp.name)
        victim = outside / "hooks.json"
        victim.write_text('{"do": "not delete me"}\n')
        self.dest.mkdir(parents=True)
        (self.dest / "hooks").symlink_to(outside, target_is_directory=True)
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(victim.exists(), "install reached through the hooks symlink")
        self.assertEqual(
            victim.read_text(), '{"do": "not delete me"}\n',
            "install wrote through the hooks symlink")
        self.assertIn("replacing symlinked directory", proc.stderr)
        # The link is replaced by the real plugin-owned directory.
        self.assertFalse((self.dest / "hooks").is_symlink())
        self.assertTrue((self.dest / "hooks" / "session-start.py").exists())



class PluginShapeTests(InstallShTestCase):
    """The plugin must be shaped for Hermes, not for Claude Code."""

    def test_hermes_manifest_declares_session_start_hook(self):
        manifest = (PLUGIN_SRC / "plugin.yaml").read_text()
        self.assertIn("name: curated-thoughts", manifest)
        self.assertIn("provides_hooks:", manifest)
        self.assertIn("on_session_start", manifest)

    def test_register_entry_point_exists(self):
        init = (PLUGIN_SRC / "__init__.py").read_text()
        self.assertIn("def register(ctx)", init)
        self.assertIn("register_hook", init)
        self.assertIn("on_session_start", init)
        self.assertIn("register_skill", init)

    def test_no_claude_code_plugin_manifests_remain(self):
        # plugin.json and hooks/hooks.json were Claude Code's format; Hermes
        # never read them, so shipping them again would be dead weight that
        # silently does nothing.
        self.assertFalse((PLUGIN_SRC / "plugin.json").exists())
        self.assertFalse((PLUGIN_SRC / "hooks" / "hooks.json").exists())


class RepoWideContractTests(unittest.TestCase):
    """Guards the two contract errors this branch exists to fix."""

    def _repo_text_files(self):
        skip_dirs = {".git", "__pycache__"}
        for path in REPO.resolve().rglob("*"):
            if not path.is_file():
                continue
            if any(part in skip_dirs for part in path.parts):
                continue
            if path.suffix not in {".py", ".sh", ".yaml", ".yml", ".json", ".md"}:
                continue
            try:
                yield path, path.read_text(errors="replace")
            except OSError:
                continue

    # Usage syntax, not bare mention: comments documenting why these were
    # removed are legitimate and must not trip the guard.
    # Only environment *reads* are matched. Shell-expansion syntax
    # (${CLAUDE_PLUGIN_ROOT}) is deliberately not matched here: the one place
    # it could do damage was hooks/hooks.json, whose absence is asserted by
    # PluginShapeTests, and matching it textually would flag the comments that
    # document why these variables were removed.
    _VAULT_USES = (
        re.compile(r"""environ(?:\.get)?[\(\[]\s*["']CT_VAULT_DIR"""),
    )
    _ROOT_USES = (
        re.compile(r"""environ(?:\.get)?[\(\[]\s*["']CLAUDE_PLUGIN_ROOT"""),
    )

    def _offenders(self, patterns):
        out = []
        for p, text in self._repo_text_files():
            if any(pat.search(text) for pat in patterns):
                out.append(str(p.relative_to(REPO.resolve())))
        return sorted(out)

    def test_ct_vault_dir_is_never_read(self):
        # CT_VAULT_DIR never existed in Curated Thoughts; reading it meant the
        # doctor described a path the sidecar was not using.
        self.assertEqual(self._offenders(self._VAULT_USES), [])

    def test_claude_plugin_root_is_never_read(self):
        # Claude Code's variable. Hermes sets PLUGIN_ROOT, so any expansion of
        # CLAUDE_PLUGIN_ROOT silently resolves to an empty path under Hermes.
        self.assertEqual(self._offenders(self._ROOT_USES), [])

    def test_curated_brain_dir_is_the_contract(self):
        doctor = (PLUGIN_SRC / "scripts" / "ct_env.py").read_text()
        self.assertIn('"CURATED_BRAIN_DIR"', doctor)
        self.assertIn('"CURATED_BRAIN_DB"', doctor)
        self.assertIn('"CURATED_BRAIN_CONFIG"', doctor)

    def test_no_linux_package_manager_in_user_facing_hints(self):
        # Curated Thoughts ships on macOS and Windows too; a fix hint must
        # never assume dpkg/apt.
        pattern = re.compile(r"\.deb\b|dpkg -i|apt-get")
        offenders = []
        for p, text in self._repo_text_files():
            if p.name in {"ct_doctor.py", "ct_env.py", "ct_status.py"} and pattern.search(text):
                offenders.append(str(p.relative_to(REPO.resolve())))
        self.assertEqual(offenders, [], f"Linux-only install advice in {offenders}")


class PluginEnablementTests(InstallShTestCase):
    """plugins.enabled scoping — a disabled entry must not read as enabled."""

    def _write_config(self, body):
        cfg = self.home / ".hermes" / "config.yaml"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(body)
        return cfg

    MCP = (
        "mcp_servers:\n"
        "  curated-thoughts:\n"
        "    command: curated-thoughts-mcp\n"
        '    args: ["--mcp"]\n'
    )

    def test_entry_under_disabled_is_not_reported_enabled(self):
        self._write_config(
            self.MCP + "plugins:\n  enabled:\n    - other\n  disabled:\n"
            "    - curated-thoughts\n"
        )
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("does not list 'curated-thoughts'", proc.stdout)
        self.assertNotIn("is listed under plugins.enabled", proc.stdout)

    def test_entry_under_enabled_is_reported_enabled(self):
        self._write_config(
            self.MCP + "plugins:\n  enabled:\n    - curated-thoughts\n"
            "  disabled:\n    - noisy\n"
        )
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("is listed under plugins.enabled", proc.stdout)

    def test_no_plugins_section_prints_guidance(self):
        self._write_config(self.MCP)
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("No 'plugins:' section found", proc.stdout)
        self.assertIn("enabled:", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)

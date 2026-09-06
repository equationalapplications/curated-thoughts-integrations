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

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE / ".."
INSTALL_SH = (REPO / "integrations" / "hermes" / "scripts" / "install.sh").resolve()
PLUGIN_SRC = (REPO / "integrations" / "hermes").resolve()
SCRIPT_TIMEOUT = 60  # every subprocess gets a hard timeout


def run_install(home: Path, extra_env=None, cwd="/"):
    """Run install.sh with bash, HOME=home, cwd outside the repo tree."""
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
        ["bash", str(INSTALL_SH)],
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
        for sentinel in ("plugin.json", "scripts/ct_doctor.py", "scripts/install.sh"):
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
        self.assertTrue((self.dest / "plugin.json").is_file())
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
        # Simulate a dirty source checkout. The real checkout has a tracked
        # __pycache__ under scripts/ (fixture below asserts the prune works
        # even when it exists in source); a stray .git dir is the other case.
        self.junk_pycache = PLUGIN_SRC / "scripts" / "__pycache__"
        self.junk_pycache.mkdir(parents=True, exist_ok=True)
        (self.junk_pycache / "junk.cpython-311.pyc").write_bytes(b"\x00junk")
        self.junk_git = PLUGIN_SRC / ".git"
        existed_before = self.junk_git.exists()
        if not existed_before:
            self.junk_git.mkdir()
            (self.junk_git / "HEAD").write_text("ref: fake\n")
        self._git_preexisted = existed_before
        self.addCleanup(self._cleanup_junk)

    def _cleanup_junk(self):
        if not self._git_preexisted:
            import shutil

            shutil.rmtree(self.junk_git, ignore_errors=True)

    def test_junk_pruned_from_dest_not_from_source(self):
        self.assertTrue(self.junk_pycache.exists(), "fixture needs source junk")
        proc = run_install(self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # DEST: no __pycache__ or .git anywhere under the installed plugin.
        for p in self.dest.rglob("*"):
            self.assertNotIn(p.name, ("__pycache__", ".git"), str(p))
        # SOURCE: untouched — pruning must never mutate the checkout.
        self.assertTrue(self.junk_pycache.exists())
        self.assertTrue((self.junk_pycache / "junk.cpython-311.pyc").exists())
        if self._git_preexisted:
            self.assertTrue(self.junk_git.exists())
            self.assertTrue((self.junk_git / "HEAD").exists())
        else:
            self.assertTrue(self.junk_git.exists(), "source .git must not be deleted")
            self.assertTrue((self.junk_git / "HEAD").exists())
        self.assertIn("copied plugin contents", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)

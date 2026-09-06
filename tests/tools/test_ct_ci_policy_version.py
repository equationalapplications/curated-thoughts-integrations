"""Version hygiene: bumps, mirrors and changelog entries."""
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_policy  # noqa: E402


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def make_repo(tmp, version="0.1.0", changelog="## 0.1.0 — 2026-01-01\n\n- initial\n"):
    """A throwaway git repo holding one implemented integration."""
    root = Path(tmp)
    d = root / "integrations" / "demo"
    (d / "scripts").mkdir(parents=True)
    (d / "integration.yaml").write_text(textwrap.dedent(f"""\
        id: demo
        name: Demo
        version: {version}
        language: python
        status: implemented
        requires_sidecar: ">=2.5"
        compat_tier: v2.5-full
        version_mirror: plugin.yaml#version
        matrix:
          os: [ubuntu-latest]
          python: ["3.13"]
        checks:
          test: python -m unittest discover -s tests
        """), encoding="utf-8")
    (d / "plugin.yaml").write_text(f"name: demo\nversion: {version}\n", encoding="utf-8")
    (d / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
    (d / "scripts" / "run.py").write_text("VALUE = 1\n", encoding="utf-8")
    (d / "README.md").write_text("# demo\n", encoding="utf-8")
    (d / "tests").mkdir()
    (d / "tests" / "test_run.py").write_text("def test_x():\n    pass\n", encoding="utf-8")
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "ci@example.com")
    git(root, "config", "user.name", "CI")
    git(root, "add", "-A")
    git(root, "commit", "-m", "base")
    return root


class TestExemptions(unittest.TestCase):
    def test_readme_is_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/README.md"))

    def test_changelog_is_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/CHANGELOG.md"))

    def test_tests_are_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/tests/test_run.py"))

    def test_docs_are_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/docs/notes.md"))

    def test_shipped_script_is_not_exempt(self):
        self.assertFalse(ct_ci_policy.is_exempt("integrations/demo/scripts/run.py"))


class TestVersionGate(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_repo(self.tmp.name)

    def change(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", f"change {rel}")

    def test_unchanged_tree_passes(self):
        self.assertEqual(ct_ci_policy.gate_versions(self.root, "HEAD"), [])

    def test_code_change_without_bump_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 2\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(any("version" in p and "demo" in p for p in problems), problems)

    def test_docs_only_change_without_bump_passes(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/README.md", "# demo\n\nmore words\n")
        self.assertEqual(ct_ci_policy.gate_versions(self.root, base), [])

    def test_tests_only_change_without_bump_passes(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/tests/test_run.py", "def test_y():\n    pass\n")
        self.assertEqual(ct_ci_policy.gate_versions(self.root, base), [])

    def test_mixed_tests_and_code_change_without_bump_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/tests/test_run.py", "def test_y():\n    pass\n")
        self.change("integrations/demo/scripts/run.py", "VALUE = 3\n")
        self.assertTrue(ct_ci_policy.gate_versions(self.root, base))

    def test_bump_without_changelog_entry_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 4\n")
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "0.2.0"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 0.2.0\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(any("CHANGELOG" in p for p in problems), problems)

    def test_bump_with_changelog_entry_passes(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 5\n")
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "0.2.0"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 0.2.0\n")
        self.change(
            "integrations/demo/CHANGELOG.md",
            "## 0.2.0 — 2026-02-02\n\n- bumped\n\n## 0.1.0 — 2026-01-01\n\n- initial\n",
        )
        self.assertEqual(ct_ci_policy.gate_versions(self.root, base), [])

    def test_mirror_mismatch_fails_even_with_no_change(self):
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 9.9.9\n")
        problems = ct_ci_policy.gate_versions(self.root, "HEAD")
        self.assertTrue(any("plugin.yaml#version" in p for p in problems), problems)

    def test_lowered_version_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "0.0.9"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 0.0.9\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(any("greater" in p for p in problems), problems)


class TestRobustness(unittest.TestCase):
    """C1/I1: a policy violation is a named failure, never a traceback."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_repo(self.tmp.name)

    def change(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", f"change {rel}")

    def test_non_semver_version_reports_gate_failure_not_traceback(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 6\n")
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "v2.0.0"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: v2.0.0\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(
            any("cannot be compared" in p and "§5.1" in p for p in problems), problems
        )

    def test_bad_base_ref_is_clean_usage_error(self):
        import argparse
        import contextlib
        import io

        sys.path.insert(0, str(REPO / "tools"))
        import ct_ci

        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            code = ct_ci.cmd_policy(
                argparse.Namespace(repo=self.root, base="no-such-ref")
            )
        self.assertEqual(code, 2)
        self.assertIn("--base", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()

"""README integrations-table sync against the manifests."""
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_readme  # noqa: E402


def make_repo(manifests, readme):
    """A throwaway repo: manifests maps id -> integration.yaml body."""
    from ct_ci_readme import README_NAME

    root = tempfile.TemporaryDirectory()
    path = Path(root.name)
    for ident, body in manifests.items():
        directory = path / "integrations" / ident
        directory.mkdir(parents=True)
        (directory / "integration.yaml").write_text(body, encoding="utf-8")
    (path / README_NAME).write_text(readme, encoding="utf-8")
    return root, path


HERMES_YAML = "id: hermes\nversion: 0.2.2\nstatus: implemented\n"
DEEPSEEK_YAML = "id: deepseek\nversion: 0.1.2\nstatus: implemented\n"
OPENCLAW_YAML = "id: openclaw\nversion: 0.0.0\nstatus: planned\n"

README = """\
# curated-thoughts-integrations

## Integrations

| Harness | Directory | Status | Version |
|---------|-----------|--------|---------|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [`integrations/hermes/`](integrations/hermes/) | implemented | [0.2.1](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=hermes) |
| DeepSeek Harness | [`integrations/deepseek/`](integrations/deepseek/) | implemented | 0.1.0 |
| OpenClaw | `integrations/openclaw/` | planned | — |

Rows marked *planned* are placeholders.
"""


class TestRewrite(unittest.TestCase):
    def test_stale_implemented_row_gets_the_manifest_version(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            self.assertTrue(ct_ci_readme.rewrite(path))
            text = (path / "README.md").read_text(encoding="utf-8")
            self.assertIn(
                "| [Hermes Agent](https://github.com/NousResearch/hermes-agent) "
                "| [`integrations/hermes/`](integrations/hermes/) | implemented "
                "| [0.2.2](https://github.com/equationalapplications/"
                "curated-thoughts-integrations/releases?q=hermes) |",
                text,
            )

    def test_bare_version_becomes_a_linked_version(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            ct_ci_readme.rewrite(path)
            text = (path / "README.md").read_text(encoding="utf-8")
            self.assertIn(
                "| DeepSeek Harness | [`integrations/deepseek/`](integrations/deepseek/) "
                "| implemented | [0.1.2](https://github.com/equationalapplications/"
                "curated-thoughts-integrations/releases?q=deepseek) |",
                text,
            )

    def test_planned_row_keeps_a_dash(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            ct_ci_readme.rewrite(path)
            text = (path / "README.md").read_text(encoding="utf-8")
            self.assertIn("| OpenClaw | `integrations/openclaw/` | planned | — |", text)

    def test_status_column_follows_the_manifest(self):
        graduated = OPENCLAW_YAML.replace("planned", "implemented")
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": graduated},
            README,
        )
        with root:
            ct_ci_readme.rewrite(path)
            text = (path / "README.md").read_text(encoding="utf-8")
            self.assertIn(
                "| OpenClaw | `integrations/openclaw/` | implemented "
                "| [0.0.0](https://github.com/equationalapplications/"
                "curated-thoughts-integrations/releases?q=openclaw) |",
                text,
            )

    def test_rewrite_is_idempotent(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            self.assertTrue(ct_ci_readme.rewrite(path))
            once = (path / "README.md").read_text(encoding="utf-8")
            self.assertFalse(ct_ci_readme.rewrite(path))
            self.assertEqual(once, (path / "README.md").read_text(encoding="utf-8"))

    def test_non_table_lines_are_untouched(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            ct_ci_readme.rewrite(path)
            text = (path / "README.md").read_text(encoding="utf-8")
            self.assertIn("Rows marked *planned* are placeholders.", text)


class TestCheck(unittest.TestCase):
    def test_current_readme_passes(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            ct_ci_readme.rewrite(path)
            self.assertEqual(ct_ci_readme.check(path), [])

    def test_stale_row_is_reported_without_writing(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            problems = ct_ci_readme.check(path)
            self.assertEqual(len(problems), 2, problems)
            self.assertTrue(any("hermes" in p and "0.2.2" in p for p in problems), problems)
            self.assertTrue(any("deepseek" in p for p in problems), problems)
            # --check writes nothing
            self.assertIn("0.2.1", (path / "README.md").read_text(encoding="utf-8"))

    def test_manifest_without_a_row_is_reported(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            "# curated-thoughts-integrations\n\nNo table at all.\n",
        )
        with root:
            problems = ct_ci_readme.check(path)
            self.assertEqual(len(problems), 3, problems)
            self.assertTrue(all("has no row" in p for p in problems), problems)

    def test_row_for_an_unknown_integration_is_reported(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML},
            README,
        )
        with root:
            problems = ct_ci_readme.check(path)
            self.assertTrue(any("deepseek" in p and "unknown" in p for p in problems), problems)
            self.assertTrue(any("openclaw" in p and "unknown" in p for p in problems), problems)


class TestRealRepo(unittest.TestCase):
    def test_real_readme_is_current(self):
        # The repository's own README must satisfy the gate; a release bump
        # that forgets the table row fails here, not at release time.
        self.assertEqual(ct_ci_readme.check(REPO), [])


class TestCli(unittest.TestCase):
    def _run(self, repo):
        import subprocess

        return subprocess.run(
            [sys.executable, str(REPO / "tools" / "ct_ci.py"), "--repo", str(repo), "readme", "--check"],
            capture_output=True,
            text=True,
        )

    def test_check_passes_on_the_real_repo(self):
        result = self._run(REPO)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_fails_cleanly_on_a_stale_repo(self):
        root, path = make_repo(
            {"hermes": HERMES_YAML, "deepseek": DEEPSEEK_YAML, "openclaw": OPENCLAW_YAML},
            README,
        )
        with root:
            result = self._run(path)
            self.assertEqual(result.returncode, 1)
            self.assertIn("FAIL", result.stderr)
            self.assertIn("hermes", result.stderr)
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()

"""Warning-only tag-drift check: warn iff the exact <id>-v<version> tag is absent."""
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import check_tag_drift  # noqa: E402


def manifest(version="1.2.3", status="implemented", id_="demo"):
    return {"id": id_, "version": version, "status": status}


def run(manifests, tags):
    return [line for line, _ in check_tag_drift.check(manifests, tags)]


class TestCheck(unittest.TestCase):
    def test_exact_tag_present_is_silent(self):
        self.assertEqual(run([manifest()], {"demo-v1.2.3"}), [])

    def test_exact_tag_absent_warns_in_annotation_format(self):
        self.assertEqual(
            run([manifest()], {"demo-v1.2.2"}),
            ["::warning title=tag drift::demo main 1.2.3 unreleased (no tag demo-v1.2.3)"],
        )

    def test_newer_tag_does_not_excuse_missing_exact_tag(self):
        self.assertEqual(len(run([manifest()], {"demo-v1.3.0"})), 1)

    def test_non_semver_version_warns_distinctly_and_skips(self):
        self.assertEqual(
            run([manifest(version="1.2")], set()),
            ["WARN: demo version 1.2 is not SemVer"],
        )

    def test_non_implemented_status_is_skipped(self):
        self.assertEqual(run([manifest(status="planned")], set()), [])


class TestMain(unittest.TestCase):
    def test_main_exits_zero_and_writes_step_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = Path(tmp) / "summary.md"
            out = io.StringIO()
            with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), \
                    redirect_stdout(out):
                code = check_tag_drift.main(tags=set())
            self.assertEqual(code, 0)
            self.assertIn("::warning title=tag drift::", out.getvalue())
            self.assertIn("unreleased (no tag", summary.read_text())

    def test_main_survives_git_failure(self):
        out = io.StringIO()
        with mock.patch.object(check_tag_drift, "list_tags", side_effect=OSError("no git")), \
                redirect_stdout(out):
            self.assertEqual(check_tag_drift.main(), 0)
        self.assertIn("WARN: could not list tags", out.getvalue())


if __name__ == "__main__":
    unittest.main()

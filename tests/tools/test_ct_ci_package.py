"""Release tag parsing, tarball construction and release bodies."""
import hashlib
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_package  # noqa: E402


class TestParseTag(unittest.TestCase):
    def test_simple_tag(self):
        self.assertEqual(ct_ci_package.parse_tag("hermes-v0.2.1"), ("hermes", "0.2.1"))

    def test_hyphenated_id(self):
        self.assertEqual(
            ct_ci_package.parse_tag("claude-code-v1.0.0"), ("claude-code", "1.0.0")
        )

    def test_prerelease_tag(self):
        self.assertEqual(
            ct_ci_package.parse_tag("hermes-v0.3.0-rc.1"), ("hermes", "0.3.0-rc.1")
        )

    def test_malformed_tag_raises(self):
        for bad in ("hermes-0.2.1", "v0.2.1", "hermes-vX.Y.Z", "hermes"):
            with self.subTest(tag=bad):
                with self.assertRaises(ValueError):
                    ct_ci_package.parse_tag(bad)


class TestPrerelease(unittest.TestCase):
    def test_release_is_not_prerelease(self):
        self.assertFalse(ct_ci_package.is_prerelease("0.2.1"))

    def test_rc_is_prerelease(self):
        self.assertTrue(ct_ci_package.is_prerelease("0.3.0-rc.1"))


class TestBuild(unittest.TestCase):
    def test_tarball_contains_scripts_and_excludes_pycache(self):
        with tempfile.TemporaryDirectory() as out:
            path = ct_ci_package.build(REPO, "hermes", Path(out))
            self.assertEqual(path.name, "hermes-0.2.0.tar.gz")
            with tarfile.open(path) as archive:
                names = archive.getnames()
            self.assertTrue(any(n.endswith("scripts/ct_doctor.py") for n in names), names[:5])
            self.assertTrue(any(n.endswith("_compat_generated.py") for n in names))
            self.assertFalse(any("__pycache__" in n for n in names))

    def test_archive_members_share_a_versioned_root(self):
        with tempfile.TemporaryDirectory() as out:
            path = ct_ci_package.build(REPO, "hermes", Path(out))
            with tarfile.open(path) as archive:
                roots = {n.split("/")[0] for n in archive.getnames()}
            self.assertEqual(roots, {"hermes-0.2.0"})

    def test_checksums_match_the_files(self):
        with tempfile.TemporaryDirectory() as out:
            tarball = ct_ci_package.build(REPO, "hermes", Path(out))
            sums = ct_ci_package.write_checksums([tarball], Path(out))
            digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
            self.assertIn(digest, sums.read_text(encoding="utf-8"))
            self.assertIn(tarball.name, sums.read_text(encoding="utf-8"))


class TestChangelogSection(unittest.TestCase):
    def test_extracts_the_matching_section(self):
        body = ct_ci_package.changelog_section(REPO / "integrations" / "hermes", "0.2.0")
        self.assertIn("Environment contract", body)
        self.assertNotIn("# Changelog", body)

    def test_missing_section_raises(self):
        with self.assertRaises(ValueError):
            ct_ci_package.changelog_section(REPO / "integrations" / "hermes", "9.9.9")


if __name__ == "__main__":
    unittest.main()

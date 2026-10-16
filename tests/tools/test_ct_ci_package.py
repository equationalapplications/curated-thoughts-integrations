"""Release tag parsing, tarball construction and release bodies."""
import hashlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_package  # noqa: E402
import ct_ci_manifest  # noqa: E402

# CI policy tests must track the manifest, not pin a snapshot version:
# any legitimate release bump (e.g. 0.2.1-rc.1) would otherwise re-break
# this suite. The contract under test is "packaging reflects integration.yaml".
HERMES_VERSION = ct_ci_manifest.load_manifest(
    REPO / "integrations" / "hermes" / "integration.yaml"
)["version"]


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
            self.assertEqual(path.name, f"hermes-{HERMES_VERSION}.tar.gz")
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
            self.assertEqual(roots, {f"hermes-{HERMES_VERSION}"})

    def test_checksums_match_the_files(self):
        with tempfile.TemporaryDirectory() as out:
            tarball = ct_ci_package.build(REPO, "hermes", Path(out))
            sums = ct_ci_package.write_checksums([tarball], Path(out))
            digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
            self.assertIn(digest, sums.read_text(encoding="utf-8"))
            self.assertIn(tarball.name, sums.read_text(encoding="utf-8"))


class TestCacheFiltering(unittest.TestCase):
    """Tool caches never ship, whatever the manifest says (issue #33).

    release.yml runs ruff inside the integration directory before packaging,
    and the packager walks the tree rather than reading .gitignore — so a
    `.ruff_cache/` used to land in the release tarball. The filter is central
    (ct_ci_package.CACHE_DIR_NAMES), so it is proven here against the real
    manifests' package blocks AND against an empty one.
    """

    PLANTED = (
        ".ruff_cache/0.16.9/abc",
        "sub/.ruff_cache/0.16.9/def",
        "__pycache__/m.cpython-313.pyc",
        "scripts/__pycache__/x.cpython-39.pyc",
        ".pytest_cache/v/cache/nodeids",
        ".mypy_cache/3.13/x.json",
        "top.pyc",
        "scripts/legacy.pyo",
    )
    REAL = ("README.md", "scripts/ct_doctor.py", ".claude-plugin/plugin.json")

    def _tree(self, root):
        for rel in self.PLANTED + self.REAL:
            path = Path(root) / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x", encoding="utf-8")
        return Path(root)

    def test_caches_never_selected_regardless_of_manifest(self):
        blocks = {"empty": {}}
        for name in ("hermes", "claude-code"):
            data = ct_ci_manifest.load_manifest(
                REPO / "integrations" / name / "integration.yaml"
            )
            blocks[name] = data.get("package") or {}
        for label, package in blocks.items():
            with self.subTest(manifest=label), tempfile.TemporaryDirectory() as tmp:
                chosen = sorted(
                    rel for _path, rel in ct_ci_package._selected_files(self._tree(tmp), package)
                )
                self.assertEqual(chosen, sorted(self.REAL))

    def test_dot_directories_that_are_not_caches_still_ship(self):
        # .claude-plugin/ is load-bearing (the Claude Code manifest): the
        # filter is a closed list of cache names, not "every dot-dir".
        with tempfile.TemporaryDirectory() as tmp:
            chosen = [rel for _p, rel in ct_ci_package._selected_files(self._tree(tmp), {})]
        self.assertIn(".claude-plugin/plugin.json", chosen)

    def test_built_tarball_has_no_cache_members(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            integration = repo / "integrations" / "demo"
            self._tree(integration)
            (integration / "integration.yaml").write_text(
                "id: demo\nname: Demo\nversion: 1.2.3\nlanguage: python\n"
                "status: implemented\n",
                encoding="utf-8",
            )
            out = Path(tmp) / "dist"
            tarball = ct_ci_package.build(repo, "demo", out)
            with tarfile.open(tarball) as archive:
                names = archive.getnames()
        for cache in ct_ci_package.CACHE_DIR_NAMES:
            self.assertFalse(any(f"/{cache}/" in n for n in names), (cache, names))
        self.assertFalse(any(n.endswith((".pyc", ".pyo")) for n in names), names)
        self.assertTrue(any(n.endswith("scripts/ct_doctor.py") for n in names), names)


class TestChangelogSection(unittest.TestCase):
    def test_extracts_the_matching_section(self):
        body = ct_ci_package.changelog_section(REPO / "integrations" / "hermes", "0.2.0")
        self.assertIn("Environment contract", body)
        self.assertNotIn("# Changelog", body)

    def test_missing_section_raises(self):
        with self.assertRaises(ValueError):
            ct_ci_package.changelog_section(REPO / "integrations" / "hermes", "9.9.9")

    def test_dated_heading_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "CHANGELOG.md").write_text(
                "# Changelog\n\n## 0.2.0 — 2026-09-06\n\n- Shipped.\n",
                encoding="utf-8",
            )
            self.assertEqual(ct_ci_package.changelog_section(directory, "0.2.0"), "- Shipped.")

    def test_prefix_match_does_not_return_a_prerelease_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "CHANGELOG.md").write_text(
                "# Changelog\n\n## 0.2.0-beta\n\n- Beta notes.\n\n## 0.1.0\n\n- Old.\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                ct_ci_package.changelog_section(directory, "0.2.0")

    def test_empty_section_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "CHANGELOG.md").write_text(
                "# Changelog\n\n## 1.0.0\n\n## 0.9.0\n\n- Something.\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                ct_ci_package.changelog_section(directory, "1.0.0")


class TestCmdPackageErrors(unittest.TestCase):
    def test_malformed_tag_fails_cleanly(self):
        result = subprocess.run(
            [sys.executable, "tools/ct_ci.py", "package", "--tag", "hermes-vX.Y.Z"],
            capture_output=True,
            text=True,
            cwd=REPO,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("Traceback", result.stdout)


if __name__ == "__main__":
    unittest.main()

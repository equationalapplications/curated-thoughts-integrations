"""Schema validation for integration.yaml manifests."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_manifest  # noqa: E402

VALID = {
    "id": "hermes",
    "name": "Curated Thoughts for Hermes Agent",
    "version": "0.2.0",
    "language": "python",
    "status": "implemented",
    "requires_sidecar": ">=2.5",
    "compat_tier": "v2.5-full",
    "version_mirror": "plugin.yaml#version",
    "matrix": {"os": ["ubuntu-latest"], "python": ["3.9", "3.13"]},
    "checks": {"test": "python -m unittest discover -s tests"},
    "package": {"include": ["**"], "exclude": ["**/__pycache__/**"]},
}


def errs(overrides=None, drop=()):
    data = dict(VALID)
    for key in drop:
        data.pop(key)
    data.update(overrides or {})
    return ct_ci_manifest.validate_manifest(data, Path("integrations/hermes/integration.yaml"))


class TestValidateManifest(unittest.TestCase):
    def test_valid_manifest_has_no_errors(self):
        self.assertEqual(errs(), [])

    def test_missing_required_field_is_reported_by_name(self):
        messages = errs(drop=("version",))
        self.assertTrue(any("version" in m for m in messages), messages)

    def test_non_semver_version_rejected(self):
        self.assertTrue(errs({"version": "0.2"}))

    def test_prerelease_version_accepted(self):
        self.assertEqual(errs({"version": "0.3.0-rc.1"}), [])

    def test_unknown_language_rejected(self):
        self.assertTrue(errs({"language": "cobol"}))

    def test_python_language_requires_matrix_python(self):
        messages = errs({"matrix": {"os": ["ubuntu-latest"], "node": ["20"]}})
        self.assertTrue(any("matrix.python" in m for m in messages), messages)

    def test_node_language_requires_matrix_node(self):
        messages = errs({
            "language": "node",
            "matrix": {"os": ["ubuntu-latest"], "python": ["3.13"]},
        })
        self.assertTrue(any("matrix.node" in m for m in messages), messages)

    def test_node_language_with_matrix_node_is_valid(self):
        self.assertEqual(
            errs({
                "language": "node",
                "matrix": {"os": ["ubuntu-latest"], "node": ["20"]},
                "checks": {"test": "npm test"},
            }),
            [],
        )

    def test_planned_integration_may_omit_checks_and_matrix(self):
        self.assertEqual(
            errs({"status": "planned"}, drop=("checks", "matrix", "version_mirror")),
            [],
        )

    def test_unknown_top_level_key_rejected(self):
        self.assertTrue(errs({"colour": "blue"}))

    def test_error_messages_name_the_manifest_path(self):
        messages = errs(drop=("name",))
        self.assertTrue(all("integrations/hermes/integration.yaml" in m for m in messages), messages)


class TestDiscoverManifests(unittest.TestCase):
    def test_finds_every_real_integration_sorted_by_id(self):
        found = ct_ci_manifest.discover_manifests(REPO)
        ids = [i for i, _, _ in found]
        self.assertEqual(ids, sorted(ids))
        self.assertIn("hermes", ids)


if __name__ == "__main__":
    unittest.main()

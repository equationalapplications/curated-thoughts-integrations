"""Which integrations CI exercises for a given change."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_discover  # noqa: E402


class TestSelect(unittest.TestCase):
    def test_all_selects_every_implemented_integration(self):
        entries = ct_ci_discover.select(REPO, base_ref=None, all_=True)
        self.assertEqual({e["id"] for e in entries}, {"hermes"})

    def test_planned_integrations_are_never_selected(self):
        entries = ct_ci_discover.select(REPO, base_ref=None, all_=True)
        self.assertNotIn("openclaw", [e["id"] for e in entries])

    def test_matrix_is_the_flat_os_x_interpreter_cross_product(self):
        entries = ct_ci_discover.select(REPO, base_ref=None, all_=True)
        self.assertEqual(len(entries), 6)  # hermes: 3 os x 2 python
        triples = {(e["os"], e["python"]) for e in entries}
        self.assertEqual(
            triples,
            {
                (os_name, py)
                for os_name in ("ubuntu-latest", "macos-latest", "windows-latest")
                for py in ("3.9", "3.13")
            },
        )

    def test_entries_carry_a_scalar_os_interpreter_dir_language_and_checks(self):
        for entry in ct_ci_discover.select(REPO, base_ref=None, all_=True):
            self.assertIsInstance(entry["os"], str)
            self.assertIsInstance(entry["python"], str)
            self.assertEqual(entry["dir"], "integrations/hermes")
            self.assertEqual(entry["language"], "python")
            self.assertIn("test", entry["checks"])

    def test_shared_path_change_selects_everything(self):
        self.assertTrue(
            ct_ci_discover.affects_all(["shared/compat.yaml"])
        )
        self.assertTrue(ct_ci_discover.affects_all(["tools/ct_ci.py"]))
        self.assertTrue(ct_ci_discover.affects_all([".github/workflows/ci.yml"]))

    def test_integration_only_change_does_not_affect_all(self):
        self.assertFalse(
            ct_ci_discover.affects_all(["integrations/hermes/scripts/ct_env.py"])
        )

    def test_implemented_integration_with_empty_matrix_is_an_error(self):
        with self.assertRaises(ValueError):
            ct_ci_discover._entries(
                "hollow",
                Path("/repo/integrations/hollow"),
                {"language": "python", "matrix": {"os": [], "python": []}},
                Path("/repo"),
            )


class TestCli(unittest.TestCase):
    def test_discover_all_emits_json(self):
        out = subprocess.run(
            [sys.executable, str(REPO / "tools" / "ct_ci.py"), "discover", "--all"],
            capture_output=True, text=True, check=True,
        ).stdout
        entries = json.loads(out)
        self.assertEqual(len(entries), 6)
        self.assertEqual({e["id"] for e in entries}, {"hermes"})


if __name__ == "__main__":
    unittest.main()

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
        self.assertEqual([e["id"] for e in entries], ["hermes"])

    def test_planned_integrations_are_never_selected(self):
        entries = ct_ci_discover.select(REPO, base_ref=None, all_=True)
        self.assertNotIn("openclaw", [e["id"] for e in entries])

    def test_entries_carry_the_matrix_and_checks(self):
        entry = ct_ci_discover.select(REPO, base_ref=None, all_=True)[0]
        self.assertIn("windows-latest", entry["os"])
        self.assertIn("3.9", entry["python"])
        self.assertIn("test", entry["checks"])
        self.assertEqual(entry["dir"], "integrations/hermes")

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


class TestCli(unittest.TestCase):
    def test_discover_all_emits_json(self):
        out = subprocess.run(
            [sys.executable, str(REPO / "tools" / "ct_ci.py"), "discover", "--all"],
            capture_output=True, text=True, check=True,
        ).stdout
        entries = json.loads(out)
        self.assertEqual([e["id"] for e in entries], ["hermes"])


if __name__ == "__main__":
    unittest.main()

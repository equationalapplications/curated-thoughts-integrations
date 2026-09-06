"""compat.yaml drift: tiers, ranges, generated freshness, banned literals."""
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_policy  # noqa: E402


class TestRangeIntersection(unittest.TestCase):
    def test_open_range_intersects_open_tier(self):
        self.assertTrue(ct_ci_policy.ranges_intersect(">=2.5", ">=2.5"))

    def test_requiring_newer_than_a_closed_tier_does_not_intersect(self):
        self.assertFalse(ct_ci_policy.ranges_intersect(">=2.5", ">=2.4,<2.5"))

    def test_overlapping_ranges_intersect(self):
        self.assertTrue(ct_ci_policy.ranges_intersect(">=2.4", ">=2.4,<2.5"))


class TestBannedLiterals(unittest.TestCase):
    def test_the_matrix_values_are_banned(self):
        banned = ct_ci_policy.banned_literals(REPO)
        self.assertIn("librarian_evidence", banned)
        self.assertIn("^librarian-[0-9a-f]{32}$", banned)
        self.assertIn("7.1.0", banned)

    def test_literal_in_code_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.py"
            path.write_text(
                textwrap.dedent(
                    '''
                    """Docstring mentioning librarian_evidence is fine."""
                    TABLE = "librarian_evidence"
                    '''
                ),
                encoding="utf-8",
            )
            problems = ct_ci_policy.scan_compat_literals(
                path, "integrations/demo/scripts/x.py", ct_ci_policy.banned_literals(REPO)
            )
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("librarian_evidence", problems[0])

    def test_docstrings_and_comments_are_not_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.py"
            path.write_text(
                textwrap.dedent(
                    '''
                    """The evidence lives in librarian_evidence (PR #188 §2.2)."""
                    # tool counts are 8 and 14
                    import _compat_generated
                    TABLE = _compat_generated.EVIDENCE_TABLE
                    '''
                ),
                encoding="utf-8",
            )
            problems = ct_ci_policy.scan_compat_literals(
                path, "integrations/demo/scripts/x.py", ct_ci_policy.banned_literals(REPO)
            )
        self.assertEqual(problems, [])

    def test_the_generated_module_itself_is_exempt(self):
        problems = ct_ci_policy.scan_compat_literals(
            REPO / "integrations/hermes/scripts/_compat_generated.py",
            "integrations/hermes/scripts/_compat_generated.py",
            ct_ci_policy.banned_literals(REPO),
        )
        self.assertEqual(problems, [])


class TestCompatGate(unittest.TestCase):
    def test_the_repository_passes_its_own_compat_gate(self):
        self.assertEqual(ct_ci_policy.gate_compat(REPO), [])


if __name__ == "__main__":
    unittest.main()

"""The generated compat constants module and its freshness gate."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_generate  # noqa: E402

COMPAT = {
    "compat": {
        "tiers": {
            "v2.4-read": {"sidecar": ">=2.4,<2.5", "tools": 8, "write_path": "dormant"},
            "v2.5-full": {"sidecar": ">=2.5", "tools": 14, "write_path": "full"},
        },
        "engine": {
            "states": {
                "mangles-structured-refs": {
                    "engine": "<=7.1.0",
                    "safe": False,
                    "pinned_version": "7.1.0",
                }
            },
            "data_safety": {
                "source_ref_shape": "^librarian-[0-9a-f]{32}$",
                "evidence_table": "librarian_evidence",
            },
        },
        "portability": {"required_tables": ["llm_wiki_entries", "librarian_evidence"]},
    }
}


class TestRender(unittest.TestCase):
    def setUp(self):
        self.text = ct_ci_generate.render(COMPAT)

    def test_output_is_importable_python(self):
        namespace = {}
        exec(compile(self.text, "_compat_generated.py", "exec"), namespace)
        self.assertEqual(namespace["FULL_TIER_TOOLS"], 14)
        self.assertEqual(namespace["READ_TIER_TOOLS"], 8)
        self.assertEqual(namespace["EVIDENCE_TABLE"], "librarian_evidence")
        self.assertEqual(namespace["SOURCE_REF_SHAPE"], "^librarian-[0-9a-f]{32}$")
        self.assertEqual(namespace["ENGINE_PINNED_VERSION"], "7.1.0")
        self.assertIs(namespace["ENGINE_SAFE"], False)

    def test_tiers_carry_parsed_version_bounds(self):
        namespace = {}
        exec(compile(self.text, "_compat_generated.py", "exec"), namespace)
        self.assertEqual(
            namespace["TIERS"],
            (
                ("v2.4-read", (2, 4), (2, 5), 8, "dormant"),
                ("v2.5-full", (2, 5), None, 14, "full"),
            ),
        )

    def test_header_forbids_hand_editing_and_names_its_source(self):
        self.assertIn("DO NOT EDIT", self.text)
        self.assertIn("shared/compat.yaml", self.text)
        self.assertIn("tools/ct_ci.py generate", self.text)

    def test_render_is_deterministic(self):
        self.assertEqual(self.text, ct_ci_generate.render(COMPAT))

    def test_generated_module_imports_nothing(self):
        self.assertNotIn("\nimport ", self.text)


class TestFreshness(unittest.TestCase):
    def test_committed_files_are_current(self):
        self.assertEqual(ct_ci_generate.check_current(REPO), [])

    def test_targets_covers_implemented_python_integrations_only(self):
        names = [p.parent.parent.name for p in ct_ci_generate.targets(REPO)]
        self.assertEqual(names, ["hermes"])


if __name__ == "__main__":
    unittest.main()

"""Shared activity-target vectors run against Hermes's builder.

`tests/fixtures/activity_targets.json` is the language-neutral contract for
what an autonomous-work activity may send to CT (spec
2026-10-16-hermes-autonomous-work-wisdom-design.md, "Privacy amendment",
R1-R4). Each case is `{name, tool, args, cwd, env, expected_query,
expected_line}`: `env` is the builder's whole view of the environment, `cwd`
"" means no working directory, and a null `expected_query` means no query at
all. The TypeScript port (packages/ct-wisdom-core) reads the same file.

It lives in tests/tools/ (run on every PR by the policy job) so a fixture-only
edit still runs it; nothing is written.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VECTORS = REPO / "tests" / "fixtures" / "activity_targets.json"
sys.path.insert(0, str(REPO / "integrations" / "hermes" / "scripts"))

import ct_wisdom_activity as act  # noqa: E402

FIELDS = {"name", "tool", "args", "cwd", "env", "expected_query", "expected_line"}
# `key_distinct_from`: the name of another vector whose activity KEY (local
# de-duplication only, never sent) must differ from this one's, even when the
# sanitized queries are equal.
OPTIONAL = {"key_distinct_from"}


def build(case):
    return act.activity_for(case["tool"], case["args"], cwd=case["cwd"], env=case["env"])


def load():
    return json.loads(VECTORS.read_text(encoding="utf-8"))


class TestActivityTargetVectors(unittest.TestCase):
    def test_vector_file_shape(self):
        cases = load()
        self.assertGreaterEqual(len(cases), 50)
        names = [c["name"] for c in cases]
        self.assertEqual(len(names), len(set(names)), "vector names are unique")
        for case in cases:
            self.assertEqual(set(case) - OPTIONAL, FIELDS, case.get("name"))
            if "key_distinct_from" in case:
                self.assertIn(case["key_distinct_from"], names, case["name"])
            self.assertIsInstance(case["cwd"], str)
            self.assertIsInstance(case["env"], dict)
            self.assertEqual(case["expected_query"] is None, case["expected_line"] is None,
                             case["name"])

    def test_every_vector(self):
        for case in load():
            with self.subTest(case["name"]):
                a = build(case)
                if case["expected_query"] is None:
                    self.assertTrue(a is None or not act.query_for(a),
                                    "expected no query, got %r" % (a and a.line))
                    continue
                self.assertIsNotNone(a)
                self.assertEqual(act.query_for(a), case["expected_query"])
                self.assertEqual(a.line, case["expected_line"])
                # R4: the visible label is built from the same sanitized line.
                block = act.render_activity_block(
                    {"id": "f1", "title": "T", "text": "x", "provenance": "p"}, [], a)
                self.assertIn("_for: %s_" % case["expected_line"], block)

    def test_keys_distinct(self):
        cases = {c["name"]: c for c in load()}
        checked = 0
        for case in cases.values():
            other = case.get("key_distinct_from")
            if not other:
                continue
            with self.subTest(case["name"]):
                a, b = build(case), build(cases[other])
                self.assertEqual(act.query_for(a), act.query_for(b))
                self.assertNotEqual(a.key, b.key)
                checked += 1
        self.assertGreater(checked, 0)


if __name__ == "__main__":
    unittest.main()

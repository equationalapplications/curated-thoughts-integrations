#!/usr/bin/env python3
"""Tests for ct_tool_dedup.py — transform_tool_result dedup of CT recall.

Envelope (investigation Target 5 [V]): Hermes hands the hook
json.dumps({"result": "<CT JSON string>"}) for an MCP tool.

Run: python3 -m unittest tests.test_ct_tool_dedup -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_tool_dedup  # noqa: E402

TOOL = "mcp__curated-thoughts__curated_recall_context"


def envelope(ids, extra_outer=None):
    inner = {
        "wiki_entries": [{"id": i, "title": "T" + i, "text": "body " + i} for i in ids],
        "code_chunks": [],
        "query": "q",
    }
    outer = {"result": json.dumps(inner)}
    outer.update(extra_outer or {})
    return json.dumps(outer)


def unwrap(out):
    outer = json.loads(out)
    text = outer["result"]
    inner = json.loads(text.split("\n<!-- ct-fact:")[0])
    return outer, inner, text


class TestToolDedup(unittest.TestCase):
    def setUp(self):
        ct_ledger.LEDGER_CACHE.clear()
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)

    def call(self, result, tool=TOOL, sid="s1"):
        return ct_tool_dedup.on_transform_tool_result(
            tool_name=tool, args={}, result=result, session_id=sid,
            task_id="", tool_call_id="c", turn_id="u", api_request_id="",
            duration_ms=1, status="ok", error_type=None, error_message=None,
        )

    def test_stubs_ledgered_and_trails_new(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        outer, inner, text = unwrap(self.call(envelope(["f1", "f2"])))
        self.assertEqual(
            inner["wiki_entries"][0],
            {"id": "f1", "in_context": True, "note": "already in context: ct-fact:f1"},
        )
        self.assertEqual(inner["wiki_entries"][1]["title"], "Tf2")
        self.assertTrue(text.endswith("\n<!-- ct-fact:f2 -->"))
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), {"f1", "f2"})

    def test_other_outer_keys_preserved(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        outer, _inner, _ = unwrap(self.call(envelope(["f1"], {"_meta": {"k": 1}})))
        self.assertEqual(outer["_meta"], {"k": 1})

    def test_no_cache_trails_all_without_stubbing(self):
        outer, inner, text = unwrap(self.call(envelope(["f1"])))
        self.assertEqual(inner["wiki_entries"][0]["title"], "Tf1")
        self.assertIn("<!-- ct-fact:f1 -->", text)
        self.assertIsNone(ct_ledger.LEDGER_CACHE.get("s1"))

    def test_all_known_and_none_new_still_stubs(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        _o, inner, text = unwrap(self.call(envelope(["f1"])))
        self.assertTrue(inner["wiki_entries"][0]["in_context"])
        self.assertNotIn("\n<!-- ct-fact:", text)

    def test_pass_through_cases(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        cases = [
            (envelope(["f1"]), "mcp__curated-thoughts__curated_get_wiki_entry"),
            (envelope(["f1"]), "terminal"),
            ("not json", TOOL),
            (json.dumps({"error": "boom"}), TOOL),
            (json.dumps({"result": "truncated {not json"}), TOOL),
            (json.dumps({"result": json.dumps({"no_wiki": []})}), TOOL),
            (envelope([]), TOOL),
            (None, TOOL),
        ]
        for result, tool in cases:
            self.assertIsNone(self.call(result, tool=tool), (tool, result))

    def test_invalid_ids_left_alone(self):
        result = json.dumps({"result": json.dumps({"wiki_entries": [{"id": "bad id"}]})})
        self.assertIsNone(self.call(result))

    def test_never_raises(self):
        self.assertIsNone(ct_tool_dedup.on_transform_tool_result())


if __name__ == "__main__":
    unittest.main()

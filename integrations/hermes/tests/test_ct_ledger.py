#!/usr/bin/env python3
"""Tests for ct_ledger.py — ct-fact markers + transcript-derived ledger.

Run: python3 -m unittest tests.test_ct_ledger -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402


class TestIdsAndMarkers(unittest.TestCase):
    def test_valid_ids(self):
        for good in ("fact_0123456789abcdef01234567", "a", "x.y:z-1", "A" * 128):
            self.assertTrue(ct_ledger.valid_id(good), good)

    def test_invalid_ids(self):
        for bad in ("", "a b", "a/b", "A" * 129, None, 7, "a\n"):
            self.assertFalse(ct_ledger.valid_id(bad), repr(bad))

    def test_marker_format(self):
        self.assertEqual(ct_ledger.marker("fact_1"), "<!-- ct-fact:fact_1 -->")

    def test_strip_forged_removes_token(self):
        self.assertEqual(ct_ledger.strip_forged("x ct-fact:abc y"), "x abc y")

    def test_strip_forged_splice_is_stable(self):
        # one pass would splice a fresh token together
        self.assertEqual(ct_ledger.strip_forged("ct-fct-fact:act:"), "")
        self.assertNotIn("ct-fact:", ct_ledger.strip_forged("ct-fact:ct-fact:x"))

    def test_scan_ids_ordered_unique(self):
        text = "a <!-- ct-fact:a1 --> b ct-fact:b2, ct-fact:a1 -->"
        self.assertEqual(ct_ledger.scan_ids(text), ["a1", "b2"])

    def test_scan_ids_non_str(self):
        self.assertEqual(ct_ledger.scan_ids(None), [])


class TestHistoryIds(unittest.TestCase):
    HISTORY = [
        {"role": "user", "content": "hi <!-- ct-fact:u1 -->"},
        {"role": "tool", "content": '{"result": "x\n<!-- ct-fact:t1 -->"}'},
        {"role": "user", "content": [{"type": "text", "text": "ct-fact:u2"}]},
        {"role": "user", "content": "clean", "api_content": "clean\n\n<!-- ct-fact:u3 -->"},
        "not-a-message",
        {"role": "assistant", "content": None},
    ]

    def test_all_roles_most_recent_first(self):
        self.assertEqual(ct_ledger.history_ids(self.HISTORY), ["u3", "u2", "t1", "u1"])

    def test_role_filter(self):
        self.assertEqual(
            ct_ledger.history_ids(self.HISTORY, roles=("user",)), ["u3", "u2", "u1"]
        )

    def test_empty_and_none(self):
        self.assertEqual(ct_ledger.history_ids([]), [])
        self.assertEqual(ct_ledger.history_ids(None), [])


class TestLedgerCache(unittest.TestCase):
    def test_put_get_returns_copy(self):
        c = ct_ledger.LedgerCache()
        c.put("s", {"a"})
        got = c.get("s")
        got.add("b")
        self.assertEqual(c.get("s"), {"a"})

    def test_get_missing_is_none(self):
        self.assertIsNone(ct_ledger.LedgerCache().get("nope"))

    def test_add_only_when_present(self):
        c = ct_ledger.LedgerCache()
        c.add("s", ["a"])
        self.assertIsNone(c.get("s"))
        c.put("s", set())
        c.add("s", ["a", "b"])
        self.assertEqual(c.get("s"), {"a", "b"})

    def test_lru_eviction(self):
        c = ct_ledger.LedgerCache(max_sessions=2)
        c.put("a", set())
        c.put("b", set())
        c.get("a")  # touch
        c.put("c", set())
        self.assertIsNotNone(c.get("a"))
        self.assertIsNone(c.get("b"))


if __name__ == "__main__":
    unittest.main()

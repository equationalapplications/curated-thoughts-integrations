"""Fail-closed table (spec "Fail-closed table"): every unclear state costs
at most a missed delivery, never a repeat and never an error."""

from __future__ import annotations

import json
import os
import time
import unittest

from _support import Env, FakeCT, fact, llm, patched, prompt, tool, updated_response

import ct_hook_store
import ct_wisdom_da as da


class FailClosedTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1")], match={"q": [fact("live1")],
                                                          "src/a.py": [fact("act1")]})

    def tearDown(self):
        self.e.cleanup()

    def h(self, payload, **env):
        with patched(self.fake):
            return da.handle(payload, dict(self.e.env, **env))

    def test_tool_events_for_an_unscanned_session_deliver_nothing(self):
        self.h(prompt("s1", "q"))  # pending store, never scanned
        self.assertIsNone(self.h(tool("s1", args={"path": "src/a.py"})))
        self.assertIsNone(self.h(tool("nostore", args={"path": "src/a.py"})))
        self.assertEqual(self.fake.queries(), ["q"])

    def test_corrupt_store_fails_closed_and_is_rescanned(self):
        self.h(llm("s1"))
        path = da.session_path(self.e.wdir, "s1")
        with open(path, "w") as handle:
            handle.write("{not json")
        self.assertIsNone(self.h(tool("s1", args={"path": "src/a.py"})))
        # The next model call treats it as unseen: scanned, block re-rendered.
        self.assertIsNotNone(self.h(llm("s1", iteration=2)))

    def test_mismatched_store_is_invalid(self):
        self.h(llm("s1"))
        path = da.session_path(self.e.wdir, "s1")
        with open(path) as handle:
            data = json.load(handle)
        data["session_id"] = "other"
        with open(path, "w") as handle:
            json.dump(data, handle)
        self.assertIsNone(da.load_store(self.e.wdir, "s1"))

    def test_off_store_never_delivers(self):
        self.h(llm("s1"))
        store = self.e.store("s1")
        store["state"] = "off"
        da.save_store(self.e.wdir, "s1", store)
        for payload in (llm("s1"), prompt("s1", "q"), tool("s1", args={"path": "src/a.py"})):
            self.assertIsNone(self.h(payload))

    def test_breaker_opens_after_three_failures_and_pauses_every_path(self):
        self.h(llm("s1"))
        self.fake.fail = "timeout"
        for _ in range(3):
            self.h(prompt("s1", "q"))
        self.fake.fail = None
        before = len(self.fake.queries())
        self.h(prompt("s1", "q"))
        self.h(tool("s1", args={"path": "src/a.py"}))
        self.assertEqual(len(self.fake.queries()), before)

    def test_spawn_failure_drops_the_ct_cache(self):
        self.h(llm("s1"))
        self.assertTrue(os.path.exists(os.path.join(self.e.wdir, "ct.json")))
        self.fake.fail = "spawn"
        self.h(prompt("s1", "q"))
        self.assertFalse(os.path.exists(os.path.join(self.e.wdir, "ct.json")))

    def test_ct_missing_or_without_match(self):
        self.fake.discover = False
        self.assertIsNone(self.h(llm("s1")))
        self.assertEqual(self.e.store("s1")["bootstrap_block"], "")
        self.assertIsNone(self.h(prompt("s1", "q")))
        self.fake.discover, self.fake.capable = True, False
        e2 = Env()
        try:
            with patched(self.fake):
                da.handle(llm("s2"), e2.env)
                self.assertIsNone(da.handle(prompt("s2", "q"), e2.env))
        finally:
            e2.cleanup()
        self.assertEqual(self.fake.queries(), [])

    def test_lock_timeout_is_silent(self):
        self.h(llm("s1"))
        orig = ct_hook_store.LOCK_WAIT
        with da.locked(da.session_path(self.e.wdir, "s1")):
            ct_hook_store.LOCK_WAIT = 0.05
            try:
                started = time.monotonic()
                self.assertIsNone(self.h(tool("s1", args={"path": "src/a.py"})))
                self.assertIsNone(self.h(prompt("s1", "q")))
                self.assertLess(time.monotonic() - started, 1.5)
            finally:
                ct_hook_store.LOCK_WAIT = orig

    def test_store_write_failure_inserts_nothing(self):
        orig = da.save_store

        def broken(*_a, **_k):
            raise OSError("disk full")

        da.save_store = broken
        try:
            self.assertIsNone(self.h(llm("s1")))
        finally:
            da.save_store = orig
        self.assertIsNone(self.e.store("s1"))

    def test_never_emits_an_empty_tool_response(self):
        self.h(llm("s1"))
        recall = json.dumps({"wiki_entries": []})
        out = self.h(tool("s1", name="curated_recall_context", category="mcp", response=recall))
        self.assertIsNone(out)
        out = updated_response(self.h(tool("s1", response="")))
        self.assertTrue(out)  # an empty result may carry a block, never becomes ""

    def test_internal_exception_returns_none(self):
        orig = da.tool_response_transform
        da._HANDLERS["tool_response_transform"] = lambda *_a: 1 / 0
        try:
            self.assertIsNone(self.h(tool("s1")))
        finally:
            da._HANDLERS["tool_response_transform"] = orig

    def test_lost_on_splice_overflow_never_repeated(self):
        self.fake.match = {"q": [fact("live1", text="\n" * 900)]}
        self.h(llm("s1"))
        self.h(prompt("s1", "q"))
        out = self.h(tool("s1", args={"path": "x"}, response="\n" * 1100))
        self.assertIsNone(out)
        self.assertIsNone(self.e.store("s1")["pending_live"])
        self.assertNotIn("live1", self.e.store("s1")["delivered_ids"])


class RecallDedupTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1")])

    def tearDown(self):
        self.e.cleanup()

    def test_ids_in_context_become_stubs_and_new_ids_join_the_ledger(self):
        with patched(self.fake):
            da.handle(llm("s1"), self.e.env)
            resp = json.dumps({"wiki_entries": [{"id": "boot1", "title": "t", "text": "x"},
                                                {"id": "new1", "title": "n", "text": "y"}],
                               "other": 1})
            out = updated_response(da.handle(tool("s1", name="ct_curated_recall_context",
                                                  category="mcp", response=resp), self.e.env))
        data = json.loads(out)
        self.assertEqual(data["wiki_entries"][0], {"id": "boot1", "in_context": True,
                                                   "note": "already in context: ct-fact:boot1"})
        self.assertEqual(data["wiki_entries"][1]["id"], "new1")
        self.assertEqual(data["other"], 1)
        self.assertIn("new1", self.e.store("s1")["tool_ids"])

    def test_nothing_stubbed_leaves_bytes_unchanged(self):
        with patched(self.fake):
            da.handle(llm("s1"), self.e.env)
            resp = json.dumps({"wiki_entries": [{"id": "new1"}]})
            self.assertIsNone(da.handle(tool("s1", name="curated_recall_context", category="mcp",
                                             response=resp), self.e.env))
            self.assertIsNone(da.handle(tool("s1", name="curated_recall_context", category="mcp",
                                             response="not json"), self.e.env))

    def test_scan_counts_recall_entries_in_cloned_history(self):
        msgs = [{"role": "system", "content": "s", "cache_control": True},
                {"role": "tool", "content": json.dumps({"wiki_entries": [{"id": "boot1"}]})}]
        with patched(self.fake):
            out = da.handle(llm("branch", messages=msgs), self.e.env)
        self.assertIsNone(out)  # boot1 already visible: the bootstrap has nothing new
        self.assertEqual(self.e.store("branch")["seen_ids"], ["boot1"])


if __name__ == "__main__":
    unittest.main()

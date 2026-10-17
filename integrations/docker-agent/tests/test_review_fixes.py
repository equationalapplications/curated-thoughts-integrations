"""Regression tests for the PR #59 review findings (items 1-3, 5, 6)."""

from __future__ import annotations

import json
import os
import unittest

from _support import (Env, FakeCT, fact, llm, patched, prompt, tool,
                      updated_messages, updated_response)

import ct_hook_store
import ct_wisdom_da as da


class Base(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1"), fact("boot2")],
                           match={"q": [fact("boot1"), fact("boot2"), fact("live1")]})

    def tearDown(self):
        self.e.cleanup()

    def h(self, payload, **env):
        with patched(self.fake):
            return da.handle(payload, dict(self.e.env, **env))


class LockTimeoutKeepsTheBlock(Base):
    """Item 1: a lock timeout must not drop the bootstrap from a call."""

    def test_block_is_inserted_even_when_the_lock_is_busy(self):
        first = updated_messages(self.h(llm("s1")))
        saved = ct_hook_store.LOCK_WAIT
        with da.locked(da.session_path(self.e.wdir, "s1")):
            ct_hook_store.LOCK_WAIT = 0.05
            try:
                again = updated_messages(self.h(llm("s1", iteration=2)))
            finally:
                ct_hook_store.LOCK_WAIT = saved
        self.assertEqual(again, first)


class TransientBootstrapFailureIsRetried(Base):
    """Item 2: timeout / exit / spawn / probe timeout / discovery miss are not final."""

    def recall_failing(self, rclass):
        good = self.fake.recall_wiki

        def failing(path, query):
            self.fake.calls.append(("recall", query, None, None))
            return None, rclass

        self.fake.recall_wiki = failing
        return good

    def test_timeout_stays_pending_then_recovers(self):
        good = self.recall_failing("timeout")
        self.assertIsNone(self.h(llm("s1")))
        store = self.e.store("s1")
        self.assertEqual((store["state"], store["boot_attempts"]), ("pending", 1))
        self.fake.recall_wiki = good
        out = updated_messages(self.h(llm("s1", iteration=2)))
        self.assertIn("ct-fact:boot1", out[2]["content"])
        self.assertEqual(self.e.store("s1")["state"], "on")

    def test_timeouts_feed_the_breaker(self):
        self.recall_failing("timeout")
        for i in range(3):
            self.h(llm("s%d" % i))
        self.assertTrue(da.breaker_for(self.e.wdir).is_open())

    def test_discovery_miss_is_retried_and_bounded(self):
        self.fake.discover = False
        for i in range(1, da.BOOTSTRAP_TRIES + 2):
            self.h(llm("s1", iteration=i))
        store = self.e.store("s1")
        self.assertEqual(store["state"], "on")
        self.assertEqual(store["bootstrap_block"], "")
        discovers = [c for c in self.fake.calls if c[0] == "discover"]
        self.assertEqual(len(discovers), da.BOOTSTRAP_TRIES)

    def test_no_deliveries_while_pending(self):
        self.recall_failing("exit")
        self.h(llm("s1"))
        self.assertIsNone(self.h(tool("s1", args={"path": "src/a.py"})))

    def test_parse_error_is_final(self):
        def parse_error(path, query):
            return None, None

        self.fake.recall_wiki = parse_error
        self.assertIsNone(self.h(llm("s1")))
        self.assertEqual(self.e.store("s1")["state"], "on")


class FirstMessageExcludesTheBootstrap(Base):
    """Item 3: the first message's match runs before the first model call."""

    def test_first_prompt_excludes_bootstrap_recall_and_recalls_once(self):
        self.h(prompt("s1", "q"))
        match = [c for c in self.fake.calls if c[0] == "match"][0]
        self.assertEqual(sorted(match[3]), ["boot1", "boot2"])
        self.h(llm("s1"))
        self.assertEqual(len(self.fake.queries("recall")), 1)
        out = updated_response(self.h(tool("s1", args={"path": "src/a.py"})))
        self.assertIn("ct-fact:live1", out)
        self.assertEqual(out.count("ct-fact:boot1"), 0)


class SpliceFallsBackToTheDeferredBlock(Base):
    """Item 5: deferred alone when deferred + activity would not fit."""

    def test_deferred_alone_when_both_do_not_fit(self):
        self.fake.match = {"q": [fact("live1")], "src/a.py": [fact("act1", text="z\n" * 200)]}
        self.h(llm("s1"))
        self.h(prompt("s1", "q"))
        response = "\n" * (da.RESULT_MAX_LINES - da.PRECHECK_MARGIN_LINES - 1)
        # Lines are the binding limit: the activity block adds ~250 lines.
        out = updated_response(self.h(tool("s1", args={"path": "src/a.py"}, response=response)))
        self.assertIsNotNone(out)
        self.assertIn("ct-fact:live1", out)
        self.assertNotIn("ct-fact:act1", out)
        store = self.e.store("s1")
        self.assertIn("live1", store["delivered_ids"])
        self.assertNotIn("act1", store["delivered_ids"])


class CtCacheKeyedOnTheDiscoveryView(Base):
    """Item 6: a cache written under one PATH is not trusted under another."""

    def test_cache_ignored_under_a_different_path(self):
        self.h(llm("s1"))
        with open(os.path.join(self.e.wdir, "ct.json")) as handle:
            self.assertIn("view", json.load(handle))
        before = len([c for c in self.fake.calls if c[0] == "discover"])
        self.h(prompt("s1", "q"))
        self.assertEqual(len([c for c in self.fake.calls if c[0] == "discover"]), before)
        self.h(prompt("s1", "q"), PATH="/somewhere/else")
        self.assertEqual(len([c for c in self.fake.calls if c[0] == "discover"]), before + 1)


if __name__ == "__main__":
    unittest.main()

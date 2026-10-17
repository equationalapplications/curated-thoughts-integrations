"""Regression tests for the second PR #59 review (items 1-5)."""

from __future__ import annotations

import unittest

from _support import Env, FakeCT, fact, llm, patched, prompt, tool, updated_response

import ct_wisdom
import ct_wisdom_da as da


class Base(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1"), fact("boot2")])

    def tearDown(self):
        self.e.cleanup()

    def h(self, payload, **env):
        with patched(self.fake):
            return da.handle(payload, dict(self.e.env, **env))


class AttachmentsFailClosed(Base):
    """Item 1: nothing after the first `<attached_file` ever reaches CT."""

    def test_closing_tag_inside_the_content_cannot_leak(self):
        self.h(llm("s1"))
        text = ('why?\n\n<attached_file path="a.txt">\nfirst\n</attached_file>\nSECRET-ONE\n'
                '</attached_file>')
        self.h(prompt("s1", text))
        self.assertEqual(self.fake.queries(), ["why?"])

    def test_unusual_framing_cannot_leak(self):
        self.h(llm("s1"))
        for text in ('explain <attached_file name=x>SECRET-TWO</attached_file>',
                     'explain\n<attached_file path="b">SECRET-THREE'):
            self.h(prompt("s1", text))
        self.assertEqual(self.fake.queries(), ["explain", "explain"])
        self.h(prompt("s1", '<attached_file path="c">\nSECRET-FOUR\n</attached_file>'))
        self.assertEqual(self.fake.queries(), ["explain", "explain"])
        self.assertFalse(any("SECRET" in q for q in self.fake.queries()))


class NoStoreDeletionOnError(Base):
    """Item 2: a failed confirm leaves the store (maybe another process's) alone."""

    def test_store_survives_a_failed_confirm(self):
        self.fake.match = {"q": [fact("live1")]}
        self.h(prompt("s1", "q"))  # pending store with a pending result
        orig = da.note_ids

        def boom(*_a, **_k):
            raise RuntimeError("disk trouble")

        da.note_ids = boom
        try:
            self.assertIsNone(self.h(llm("s1")))
        finally:
            da.note_ids = orig
        store = self.e.store("s1")
        self.assertIsNotNone(store)
        self.assertEqual(store["state"], "pending")
        self.assertIsNotNone(store["pending_live"])
        self.assertIsNotNone(self.h(llm("s1", iteration=2)))  # retried, now on


class ClaimReleasedWhenTheFinalResultCannotCarryIt(Base):
    """Item 3: a block claimed on a streamed chunk that does not fit the final
    result leaves the ledger again."""

    def test_release(self):
        self.fake.match = {"pnpm test": [fact("act1")]}
        self.h(llm("s1"))
        chunk = tool("s1", name="shell", category="shell", args={"cmd": "pnpm test"},
                     response="> start\n", use_id="sh1")
        self.assertIsNotNone(self.h(chunk))
        self.assertIn("act1", self.e.store("s1")["delivered_ids"])
        final = dict(chunk, tool_response="x\n" * (da.RESULT_MAX_LINES + 5))
        self.assertIsNone(self.h(final))
        store = self.e.store("s1")
        self.assertNotIn("act1", store["delivered_ids"])
        self.assertNotIn("act1", store["order"])
        self.assertNotIn("sh1", store["claims"])
        # Released means deliverable again later.
        self.h(llm("s1", iteration=2))
        out = updated_response(self.h(tool("s1", name="shell", category="shell",
                                           args={"cmd": "pnpm test --other"}, use_id="sh2")))
        self.assertIsNone(out)  # same key (run pnpm test): no requery by design
        self.fake.match["make build"] = [fact("act1")]
        self.h(llm("s1", iteration=3))
        out = updated_response(self.h(tool("s1", name="shell", category="shell",
                                           args={"cmd": "make build"}, use_id="sh3")))
        self.assertIn("ct-fact:act1", out)


class ClaimReleasedWhenTheFinalResultIsRejected(Base):
    """CodeRabbit: a claim must also be released when the final result fails
    the eligibility checks (error result, JSON list), not only on size."""

    def claim(self, use_id):
        self.fake.match = {"pnpm test": [fact("act1")]}
        self.h(llm("s1"))
        chunk = tool("s1", name="shell", category="shell", args={"cmd": "pnpm test"},
                     response="> start\n", use_id=use_id)
        self.assertIsNotNone(self.h(chunk))
        self.assertIn("act1", self.e.store("s1")["delivered_ids"])
        return chunk

    def test_error_result_releases(self):
        chunk = self.claim("e1")
        self.assertIsNone(self.h(dict(chunk, tool_error=True, tool_response="boom")))
        self.assertNotIn("act1", self.e.store("s1")["delivered_ids"])
        self.assertNotIn("e1", self.e.store("s1")["claims"])

    def test_json_list_result_releases(self):
        chunk = self.claim("j1")
        self.assertIsNone(self.h(dict(chunk, tool_response="[1, 2]")))
        self.assertNotIn("act1", self.e.store("s1")["delivered_ids"])

    def test_session_key_hashes_a_trailing_newline(self):
        import ct_hook_store
        self.assertNotEqual(ct_hook_store.session_key("abc\n"), "abc\n")
        self.assertEqual(len(ct_hook_store.session_key("abc\n")), 64)


class FirstMessageExcludesOnlyRenderedIds(Base):
    """Item 4: only ids the bootstrap block will actually carry are excluded."""

    def test_unrenderable_entries_are_not_excluded(self):
        self.fake.recall = [fact("boot1"), fact("empty", title=" ", text=" ")]
        self.fake.recall[1]["title"], self.fake.recall[1]["text"] = "", ""
        self.fake.match = {"q": []}
        self.h(prompt("s1", "q"))
        match = [c for c in self.fake.calls if c[0] == "match"][0]
        self.assertEqual(match[3], ["boot1"])


class PromptBudget(Base):
    """Item 5: ct time in user_prompt_submit is capped (8 s) under the 10 s
    hook timeout; a step that cannot finish in time is not started."""

    def test_match_skipped_and_breaker_fed_when_the_budget_is_spent(self):
        self.h(llm("s1"))
        now = [1000.0]
        orig_clock, orig_find = da._clock, da.find_ct

        def slow_find(*a, **k):
            now[0] += da.PROMPT_BUDGET - 1  # discovery ate the budget
            return orig_find(*a, **k)

        da._clock, da.find_ct = (lambda: now[0]), slow_find
        try:
            self.assertIsNone(self.h(prompt("s1", "q")))
        finally:
            da._clock, da.find_ct = orig_clock, orig_find
        self.assertEqual(self.fake.queries(), [])
        with open(da.breaker_for(self.e.wdir)._path) as handle:
            self.assertIn('"count": 1', handle.read())

    def test_recall_not_started_without_time_for_it(self):
        now = [1000.0]
        orig_clock, orig_find = da._clock, da.find_ct

        def slow_find(*a, **k):
            now[0] += da.PROMPT_BUDGET - ct_wisdom.RECALL_TIMEOUT + 0.5
            return orig_find(*a, **k)

        da._clock, da.find_ct = (lambda: now[0]), slow_find
        try:
            self.h(prompt("s1", "q"))
        finally:
            da._clock, da.find_ct = orig_clock, orig_find
        self.assertEqual(self.fake.queries("recall"), [])


if __name__ == "__main__":
    unittest.main()

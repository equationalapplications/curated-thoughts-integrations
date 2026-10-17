"""Per-user-message delivery: matched at user_prompt_submit, delivered in
the turn's first eligible tool result (spec D6, user decision 1)."""

from __future__ import annotations

import json
import threading
import unittest

from _support import Env, FakeCT, fact, llm, patched, prompt, tool, updated_response

import ct_wisdom_da as da


class DeferredBase(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1")],
                           match={"how do I deploy": [fact("live1"), fact("live2")]})

    def tearDown(self):
        self.e.cleanup()

    def h(self, payload, **env):
        with patched(self.fake):
            return da.handle(payload, dict(self.e.env, **env))

    def start(self, sid="s1", text="how do I deploy"):
        self.h(llm(sid))
        return self.h(prompt(sid, text))


class DeferredDeliveryTests(DeferredBase):
    def test_prompt_emits_nothing_and_stores_pending(self):
        self.assertIsNone(self.start())
        pending = self.e.store("s1")["pending_live"]
        self.assertEqual([f["id"] for f in pending["result"]["entries"]], ["live1", "live2"])
        match = [c for c in self.fake.calls if c[0] == "match"][0]
        self.assertEqual(match[2], 2)
        self.assertEqual(match[3], ["boot1"])  # exclude = ledger

    def test_first_eligible_tool_result_carries_the_block_marker_first(self):
        self.start()
        out = updated_response(self.h(tool("s1", args={"path": "README"})))
        self.assertTrue(out.startswith("file text\n\n\n## Curated Thoughts — relevant now\n\n"))
        self.assertIn("\n<!-- ct-fact:live1 --> **Title live1** (provenance: stated)\nText of live1", out)
        self.assertLess(out.index("ct-fact:live1"), out.index("Title live1"))
        store = self.e.store("s1")
        self.assertIsNone(store["pending_live"])
        self.assertEqual(store["delivered_ids"][:2], ["live1", "live2"])

    def test_only_the_first_result_gets_it(self):
        self.start()
        self.assertIsNotNone(self.h(tool("s1", args={"path": "a"})))
        self.fake.match = {}
        second = self.h(tool("s1", args={"path": "a"}, use_id="call_2"))
        self.assertIsNone(second)

    def test_json_object_result_gets_a_key(self):
        self.start()
        out = updated_response(self.h(tool("s1", name="transfer_task", category="transfer",
                                            args={"agent": "x"}, response='{"ok": true}')))
        data = json.loads(out)
        self.assertTrue(data["ok"])
        self.assertIn("ct-fact:live1", data["curated_thoughts_wisdom"])

    def test_ineligible_results_leave_pending_for_the_next(self):
        self.start()
        cases = [
            tool("s1", error=True),
            tool("s1", response="[1, 2]"),
            tool("s1", response="x" * 50000),
            tool("s1", response="\n" * 1950),
            tool("s1", name="curated_get_wiki_entry", category="mcp", response="{}"),
        ]
        for payload in cases:
            self.assertIsNone(self.h(payload))
            self.assertIsNotNone(self.e.store("s1")["pending_live"])
        self.assertIsNotNone(self.h(tool("s1")))

    def test_pending_expires_at_the_next_prompt(self):
        self.start()
        self.fake.match = {"next": []}
        self.h(prompt("s1", "next"))
        self.assertIsNone(self.e.store("s1")["pending_live"])
        self.assertIsNone(self.h(tool("s1")))

    def test_followup_submit_takes_the_same_path(self):
        self.h(llm("s1"))
        self.h(prompt("s1", "how do I deploy", event="user_followup_submit"))
        self.assertIsNotNone(self.e.store("s1")["pending_live"])

    def test_rendered_against_the_ledger_at_claim_time(self):
        self.start()
        # A recall between the prompt and the tool result put live1 in context.
        recall = json.dumps({"wiki_entries": [{"id": "live1", "title": "t", "text": "x"}]})
        self.h(tool("s1", name="curated_recall_context", category="mcp", response=recall))
        out = updated_response(self.h(tool("s1")))
        self.assertNotIn("ct-fact:live1", out)
        self.assertIn("ct-fact:live2", out)

    def test_everything_already_in_context_delivers_nothing(self):
        self.fake.match = {"q": [fact("boot1")]}
        self.fake.honor_exclude = False
        self.start(text="q")
        self.assertIsNone(self.e.store("s1")["pending_live"])
        self.assertIsNone(self.h(tool("s1")))

    def test_parallel_results_claim_once(self):
        self.start()
        outs = []
        barrier = threading.Barrier(6)

        def worker(i):
            barrier.wait()
            outs.append(self.h(tool("s1", args={"path": "f%d" % i}, use_id="c%d" % i)))

        with patched(self.fake):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        texts = [updated_response(o) for o in outs if o]
        self.assertEqual(sum(t.count("ct-fact:live1") for t in texts), 1)

    def test_corrections_only_when_superseding_something_in_context(self):
        self.fake.corrections = {"q": [fact("new1", supersedes=["boot1"]),
                                       fact("new2", supersedes=["unseen"])]}
        self.fake.match = {"q": []}
        self.start(text="q")
        out = updated_response(self.h(tool("s1")))
        self.assertIn("<!-- ct-fact:new1 -->", out)
        self.assertIn("supersedes ct-fact:boot1", out)
        self.assertNotIn("new2", out)

    def test_block_respects_the_live_budget(self):
        self.fake.match = {"q": [fact("big1", text="a" * 3000), fact("big2")]}
        self.start(text="q")
        out = updated_response(self.h(tool("s1", response="r")))
        block = out[len("r\n\n"):]
        self.assertLessEqual(len(block), 1200)
        self.assertTrue(block.endswith("…"))

    def test_prompt_provenance(self):
        self.h(llm("s1"))
        for text in ("", "   ", "<system-update>\nThe context changed\n</system-update>"):
            self.assertIsNone(self.h(prompt("s1", text)))
        self.assertEqual(self.fake.queries(), [])

    def test_a_prompt_that_starts_with_a_tag_is_still_the_users(self):
        self.h(llm("s1"))
        self.h(prompt("s1", "<div> is not centered"))
        self.assertEqual(self.fake.queries(), ["<div> is not centered"])

    def test_attached_file_contents_never_reach_ct(self):
        self.h(llm("s1"))
        text = ('why does this fail?\n\n<attached_file path="notes.txt">\nSECRET-BODY\n'
                '</attached_file>')
        self.h(prompt("s1", text))
        self.assertEqual(self.fake.queries(), ["why does this fail?"])
        self.h(prompt("s1", '\n\n<attached_file path="a">\nonly\n</attached_file>'))
        self.assertEqual(self.fake.queries(), ["why does this fail?"])


class TransientModeTests(DeferredBase):
    def test_off_by_default(self):
        self.assertIsNone(self.start())

    def test_prompt_mode_emits_additional_context_for_confirmed_sessions(self):
        self.h(llm("s1"))
        out = self.h(prompt("s1", "how do I deploy"), CT_WISDOM_DA_LIVE="prompt")
        ctx = out["hook_specific_output"]
        self.assertEqual(ctx["hook_event_name"], "user_prompt_submit")
        self.assertIn("ct-fact:live1", ctx["additional_context"])
        store = self.e.store("s1")
        self.assertIn("live1", store["delivered_ids"])
        self.assertIsNone(store["pending_live"])
        # Treated as permanently in context: never delivered again.
        self.fake.honor_exclude = False
        self.assertIsNone(self.h(prompt("s1", "how do I deploy"), CT_WISDOM_DA_LIVE="prompt"))

    def test_pending_session_falls_back_to_deferred(self):
        out = self.h(prompt("s1", "how do I deploy"), CT_WISDOM_DA_LIVE="prompt")
        self.assertIsNone(out)
        self.assertIsNotNone(self.e.store("s1")["pending_live"])


if __name__ == "__main__":
    unittest.main()

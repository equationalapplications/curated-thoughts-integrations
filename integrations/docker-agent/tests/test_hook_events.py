"""Per-event contract tests: before_llm_call (scan, bootstrap, insertion,
step), the process entry point, and the sandbox no-op (spec D2-D5)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

from _support import (BASE_MESSAGES, HOOKS, Env, FakeCT, fact, llm, patched, prompt, tool,
                      updated_messages)

import ct_wisdom_da as da


class BootstrapInsertionTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1"), fact("boot2")])

    def tearDown(self):
        self.e.cleanup()

    def run_llm(self, payload):
        with patched(self.fake):
            return da.handle(payload, self.e.env)

    def test_first_call_scans_renders_and_inserts(self):
        out = self.run_llm(llm("s1"))
        msgs = updated_messages(out)
        self.assertEqual(len(msgs), len(BASE_MESSAGES) + 2)
        inserted = msgs[2]
        self.assertEqual(inserted["role"], "system")
        self.assertTrue(inserted["turn_scoped"])
        self.assertTrue(inserted["cache_control"])
        self.assertIn("<!-- ct-fact:boot1 -->", inserted["content"])
        store = self.e.store("s1")
        self.assertEqual(store["state"], "on")
        self.assertEqual(store["bootstrap_ids"], ["boot1", "boot2"])
        self.assertEqual(store["step"], 1)

    def test_block_bytes_identical_on_every_call_and_never_rerendered(self):
        first = updated_messages(self.run_llm(llm("s1")))
        self.fake.recall = [fact("other")]
        for i in range(2, 6):
            again = updated_messages(self.run_llm(llm("s1", iteration=i)))
            self.assertEqual(again[2], first[2])
        self.assertEqual(self.fake.queries("recall").__len__(), 1)
        self.assertEqual(self.e.store("s1")["step"], 5)

    def test_insertion_before_existing_extras(self):
        msgs = BASE_MESSAGES + [
            {"role": "system", "content": "env info", "turn_scoped": True, "cache_control": True},
            {"role": "user", "content": "q"},
        ]
        out = updated_messages(self.run_llm(llm("s1", messages=msgs)))
        self.assertEqual(out[2]["role"], "system")
        self.assertTrue(out[2]["turn_scoped"])
        self.assertNotIn("cache_control", out[2])
        self.assertEqual(out[3]["content"], "env info")

    def test_insertion_after_cache_mark_when_history_system_follows(self):
        # Helper-shaped list (experiment D): a history system message sits
        # after the cache-marked invariant prefix.
        msgs = [
            {"role": "system", "content": "You are a helper."},
            {"role": "system", "content": "## Filesystem Tools", "cache_control": True},
            {"role": "system", "content": "You are a member of a team..."},
            {"role": "user", "content": "Please proceed."},
        ]
        out = updated_messages(self.run_llm(llm("child", messages=msgs)))
        self.assertIn("ct-fact:boot1", out[2]["content"])
        self.assertEqual(out[3]["content"], "You are a member of a team...")

    def test_insertion_without_any_cache_mark_goes_after_leading_system(self):
        msgs = [{"role": "system", "content": "a"}, {"role": "user", "content": "q"}]
        out = updated_messages(self.run_llm(llm("s1", messages=msgs)))
        self.assertEqual(out[1]["turn_scoped"], True)
        self.assertEqual(out[2]["role"], "user")

    def test_already_present_block_is_not_inserted_twice(self):
        first = updated_messages(self.run_llm(llm("s1")))
        self.assertIsNone(self.run_llm(llm("s1", messages=first, iteration=2)))

    def test_message_fields_survive_round_trip(self):
        msgs = BASE_MESSAGES + [
            {"role": "user", "content": "q", "message_id": "m1", "created_at": "t"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
             "function": {"name": "read_file", "arguments": "{}"}}], "thinking_signature": "sig"},
            {"role": "tool", "content": "x", "tool_call_id": "c1", "is_error": True},
        ]
        out = updated_messages(self.run_llm(llm("s1", messages=msgs)))
        self.assertEqual([m for m in out if not m.get("turn_scoped")], msgs)

    def test_empty_recall_records_empty_block_and_never_renders_later(self):
        self.fake.recall = []
        self.assertIsNone(self.run_llm(llm("s1")))
        self.fake.recall = [fact("late")]
        self.assertIsNone(self.run_llm(llm("s1", iteration=2)))
        store = self.e.store("s1")
        self.assertEqual(store["bootstrap_block"], "")
        self.assertEqual(store["state"], "on")
        self.assertEqual(len(self.fake.queries("recall")), 1)

    def test_scan_seeds_ledger_and_filters_bootstrap(self):
        msgs = BASE_MESSAGES + [
            {"role": "user", "content": "q"},
            {"role": "tool", "content": "x\n\n<!-- ct-fact:boot1 --> **T** ..."},
        ]
        out = updated_messages(self.run_llm(llm("branch", messages=msgs)))
        store = self.e.store("branch")
        self.assertEqual(store["seen_ids"], ["boot1"])
        block = out[2]["content"]
        self.assertNotIn("ct-fact:boot1", block)
        self.assertIn("ct-fact:boot2", block)

    def test_scan_reads_multi_content_parts(self):
        msgs = BASE_MESSAGES + [{"role": "user", "content": "", "multi_content": [
            {"type": "text", "text": "see <!-- ct-fact:mc1 -->"}]}]
        self.run_llm(llm("s1", messages=msgs))
        self.assertIn("mc1", self.e.store("s1")["seen_ids"])

    def test_unreadable_messages_latch_off(self):
        payload = llm("s1")
        payload["messages"] = "not a list"
        self.assertIsNone(self.run_llm(payload))
        store = self.e.store("s1")
        self.assertEqual((store["state"], store["off_reason"]), ("off", "unreadable"))
        self.assertIsNone(self.run_llm(llm("s1", iteration=2)))
        self.assertEqual(self.e.store("s1")["state"], "off")

    def test_pending_store_from_prompt_is_confirmed_by_first_call(self):
        self.fake.match = {"hello there": [fact("live1")]}
        with patched(self.fake):
            da.handle(prompt("s1", "hello there"), self.e.env)
        self.assertEqual(self.e.store("s1")["state"], "pending")
        self.run_llm(llm("s1"))
        store = self.e.store("s1")
        self.assertEqual(store["state"], "on")
        self.assertEqual(store["pending_live"]["result"]["entries"][0]["id"], "live1")

    def test_helper_session_gets_its_own_block(self):
        self.run_llm(llm("parent"))
        out = updated_messages(self.run_llm(llm("child-uuid", agent="helper")))
        self.assertIn("ct-fact:boot1", out[2]["content"])
        self.assertEqual(len(self.fake.queries("recall")), 2)


class EntryPointTests(unittest.TestCase):
    """The real process: exit 0 always, JSON or nothing on stdout."""

    SCRIPT = str(HOOKS / "ct_wisdom_da.py")

    def run_proc(self, stdin, extra_env=None):
        e = Env()
        try:
            env = dict(os.environ, DOCKER_AGENT_DATA_DIR=e.root, PATH="/nonexistent")
            env.update(extra_env or {})
            return subprocess.run([sys.executable, self.SCRIPT], input=stdin.encode(),
                                  capture_output=True, env=env, timeout=60)
        finally:
            e.cleanup()

    def test_garbage_stdin_exits_zero_silently(self):
        for stdin in ("", "not json", "[1,2]", '{"hook_event_name": "nope"}', "{"):
            proc = self.run_proc(stdin)
            self.assertEqual(proc.returncode, 0, stdin)
            self.assertEqual(proc.stdout, b"", stdin)

    def test_prompt_without_ct_exits_zero(self):
        proc = self.run_proc(json.dumps(prompt("s1", "hi")))
        self.assertEqual((proc.returncode, proc.stdout), (0, b""))

    def test_before_llm_call_without_ct_exits_zero_without_output(self):
        proc = self.run_proc(json.dumps(llm("s1")))
        self.assertEqual((proc.returncode, proc.stdout), (0, b""))


class SandboxNoOpTests(unittest.TestCase):
    def test_every_event_is_silent_inside_a_sandbox(self):
        e = Env(SANDBOX_VM_ID="vm-123")
        fake = FakeCT(recall=[fact("b")], match={"q": [fact("x")]})
        try:
            with patched(fake):
                for payload in (llm("s1"), prompt("s1", "q"), tool("s1")):
                    self.assertIsNone(da.respond(payload, dict(e.env, CT_WISDOM_VERBOSE="1")))
            self.assertEqual(fake.calls, [])
            self.assertFalse(os.path.exists(e.wdir))
        finally:
            e.cleanup()


if __name__ == "__main__":
    unittest.main()

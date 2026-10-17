"""Verbose mode on Docker Agent (spec D10; verbose spec D1, D2, D8)."""

from __future__ import annotations

import json
import os
import unittest

from _support import Env, FakeCT, fact, llm, patched, prompt, tool

import ct_wisdom_da as da
import ct_wisdom_verbose


def scenario(env):
    fake = FakeCT(recall=[fact("boot1")], match={"q": [fact("live1")], "nomatch": [],
                                                 "src/a.py": [fact("act1")]})
    outs = []
    with patched(fake):
        outs.append(da.respond(llm("s1"), env))
        outs.append(da.respond(prompt("s1", "q"), env))
        outs.append(da.respond(tool("s1", args={"path": "src/a.py"}), env))
        outs.append(da.respond(prompt("s1", "nomatch"), env))
        outs.append(da.respond(tool("s1", args={"path": "src/a.py"}, use_id="c2"), env))
    return outs


def strip_system_message(out):
    if not out:
        return out
    out = {k: v for k, v in out.items() if k != "system_message"}
    return out or None


class VerboseTests(unittest.TestCase):
    def setUp(self):
        self.on, self.off = Env(), Env()

    def tearDown(self):
        self.on.cleanup()
        self.off.cleanup()

    def log(self, e):
        return os.path.join(e.wdir, ct_wisdom_verbose.LOG_NAME)

    def test_off_is_byte_identical_and_writes_nothing(self):
        off = scenario(self.off.env)
        for out in off:
            self.assertNotIn("system_message", out or {})
        self.assertFalse(os.path.exists(self.log(self.off)))
        zero = Env(CT_WISDOM_VERBOSE="0")
        try:
            self.assertEqual(scenario(zero.env), off)
        finally:
            zero.cleanup()

    def test_on_keeps_model_visible_bytes_and_records(self):
        off = scenario(self.off.env)
        on = scenario(dict(self.on.env, CT_WISDOM_VERBOSE="1"))
        self.assertEqual([strip_system_message(o) for o in on], off)
        notices = [o["system_message"] for o in on if o and "system_message" in o]
        self.assertTrue(any("delivered 2 facts" in n or "delivered 1 fact" in n for n in notices))
        with open(self.log(self.on), encoding="utf-8") as handle:
            records = [json.loads(line) for line in handle]
        channels = {(r["channel"], r["event"]) for r in records}
        self.assertIn(("deferred", "delivery"), channels)
        self.assertIn(("activity", "delivery"), channels)
        self.assertTrue(all(r["host"] == "docker-agent" for r in records))
        reasons = {r["reason"] for r in records if r["event"] == "skip"}
        self.assertIn("no_match", reasons)
        activity = [r for r in records if r["channel"] == "activity"][0]
        self.assertEqual((activity["query"], activity["activity"]), ("src/a.py", "read src/a.py"))

    def test_expired_pending_is_recorded(self):
        env = dict(self.on.env, CT_WISDOM_VERBOSE="1")
        fake = FakeCT(recall=[], match={"q": [fact("live1")], "r": []})
        with patched(fake):
            da.respond(llm("s1"), env)
            da.respond(prompt("s1", "q"), env)
            out = da.respond(prompt("s1", "r"), env)
        self.assertIn("no_tool_call", out["system_message"])

    def test_log_override_and_secret_free(self):
        target = os.path.join(self.on.root, "custom.jsonl")
        env = dict(self.on.env, CT_WISDOM_VERBOSE="1", CT_WISDOM_VERBOSE_LOG=target,
                   OPENROUTER_API_KEY="sk-or-SECRETVALUE123456")
        on = scenario(env)
        with open(target, encoding="utf-8") as handle:
            text = handle.read()
        self.assertTrue(text)
        self.assertNotIn("SECRETVALUE", text)
        self.assertNotIn("SECRETVALUE", json.dumps(on))
        self.assertFalse(os.path.exists(self.log(self.on)))

    def test_raising_sink_never_changes_output(self):
        off = scenario(self.off.env)
        orig = ct_wisdom_verbose._append

        def boom(*_a):
            raise OSError("nope")

        ct_wisdom_verbose._append = boom
        try:
            on = scenario(dict(self.on.env, CT_WISDOM_VERBOSE="1"))
        finally:
            ct_wisdom_verbose._append = orig
        self.assertEqual([strip_system_message(o) for o in on], off)


if __name__ == "__main__":
    unittest.main()

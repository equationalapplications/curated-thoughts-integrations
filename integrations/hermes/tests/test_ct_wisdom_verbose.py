#!/usr/bin/env python3
"""Tests for ct_wisdom_verbose.py — the opt-in verbose recorder.

Spec: docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md (D1-D5).

Run: python3 -m unittest tests.test_ct_wisdom_verbose -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_wisdom_verbose as V  # noqa: E402

SECRET = "sk-test-SECRET-should-never-appear-1234"


def _item(fid, title="T", text="x", score=0.8, supersedes=None, provenance="user_stated"):
    out = {"id": fid, "title": title, "text": text, "supersedes": supersedes or [],
           "provenance": provenance}
    if score is not None:
        out["score"] = score
    return out


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.log = os.path.join(self.tmp, "sub", "v.jsonl")
        self.notices = []
        prev = V.set_sink(self.notices.append)
        self.addCleanup(V.set_sink, prev)
        self.env = {"CT_WISDOM_VERBOSE": "1", "CT_WISDOM_VERBOSE_LOG": self.log,
                    "OPENAI_API_KEY": SECRET, "HOME": self.tmp}

    def events(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]


class TestEnabled(unittest.TestCase):
    def test_truth_table(self):
        for value in ("1", "true", "TRUE", "yes", "on", " On "):
            self.assertTrue(V.enabled({"CT_WISDOM_VERBOSE": value}), value)
        for value in ("", "0", "false", "no", "off", "2x"):
            self.assertFalse(V.enabled({"CT_WISDOM_VERBOSE": value}), value)
        self.assertFalse(V.enabled({}))

    def test_bad_env_view_is_off(self):
        self.assertFalse(V.enabled(object()))


class TestLogPath(unittest.TestCase):
    def test_override_wins_and_expands_tilde(self):
        env = {"CT_WISDOM_VERBOSE_LOG": "~/x.jsonl", "HERMES_HOME": "/hh"}
        self.assertEqual(V.log_path("hermes", env), os.path.expanduser("~/x.jsonl"))
        self.assertEqual(V.log_path("claude-code", env), os.path.expanduser("~/x.jsonl"))

    def test_hermes_home(self):
        path = V.log_path("hermes", {"HERMES_HOME": "/srv/hermes"})
        self.assertEqual(path, os.path.join("/srv/hermes", "logs", V.LOG_NAME))

    def test_hermes_default(self):
        path = V.log_path("hermes", {})
        self.assertEqual(path, os.path.join(os.path.expanduser("~"), ".hermes", "logs", V.LOG_NAME))

    def test_claude_code_plugin_data(self):
        path = V.log_path("claude-code", {"CLAUDE_PLUGIN_DATA": "/data/p"})
        self.assertEqual(path, os.path.join("/data/p", "wisdom", V.LOG_NAME))

    def test_claude_code_without_data_dir_has_no_log(self):
        self.assertIsNone(V.log_path("claude-code", {}))


class TestRecordDelivery(Harness):
    def _delivery(self, **over):
        event = {
            "host": "hermes", "channel": "pre_llm_call", "session_id": "s1",
            "query": "how do I deploy?",
            "result": {"gate": "semantic-v1:m",
                       "entries": [_item("e1", "Deploy", score=0.74), _item("e2", "Old", score=0.7),
                                   _item("e3", "Big", score=0.66)],
                       "corrections": [_item("c1", "Fix", score=None, supersedes=["zz"])]},
            "ledger": {"e2", "b1"},
            "delivered": ["e1"],
            "block": "## Curated Thoughts — relevant now\n\n**Deploy** <!-- ct-fact:e1 -->\nx",
        }
        event.update(over)
        return event

    def test_writes_one_v1_event_with_allowlisted_fields(self):
        V.record_delivery(self._delivery(), env=self.env)
        [ev] = self.events()
        self.assertEqual(ev["v"], 1)
        self.assertEqual(ev["event"], "delivery")
        self.assertIsNone(ev["reason"])
        self.assertEqual((ev["host"], ev["channel"], ev["session_id"]),
                         ("hermes", "pre_llm_call", "s1"))
        self.assertEqual(ev["query"], "how do I deploy?")
        self.assertEqual(ev["gate"], "semantic-v1:m")
        self.assertEqual(ev["delivered_ids"], ["e1"])
        self.assertEqual(ev["block_chars"], len(self._delivery()["block"]))
        self.assertEqual(ev["block"], self._delivery()["block"])
        self.assertEqual(ev["ledger_size"], 2)
        self.assertTrue(ev["ts"].endswith("Z"))
        outcomes = {m["id"]: (m["kind"], m["outcome"], m["score"]) for m in ev["matched"]}
        self.assertEqual(outcomes, {
            "e1": ("entry", "delivered", 0.74),
            "e2": ("entry", "in_context", 0.7),
            "e3": ("entry", "budget", 0.66),
            "c1": ("correction", "not_applicable", None),
        })
        # Corrections first, the order the block renders them in.
        self.assertEqual([m["id"] for m in ev["matched"]], ["c1", "e1", "e2", "e3"])
        self.assertEqual(ev["matched"][1]["title"], "Deploy")
        self.assertEqual(ev["matched"][1]["text"], "x")
        self.assertEqual(ev["matched"][1]["provenance"], "user_stated")
        self.assertEqual(set(ev), {"v", "ts", "host", "channel", "session_id", "event", "reason",
                                   "query", "gate", "matched", "delivered_ids", "block_chars",
                                   "block", "ledger_size"})

    def test_notice_reaches_sink_with_block(self):
        V.record_delivery(self._delivery(), env=self.env)
        [text] = self.notices
        self.assertIn("Curated Thoughts wisdom: delivered 1 fact", text)
        self.assertIn("+ e1", text)
        self.assertIn("= e2", text)
        self.assertIn("**Deploy** <!-- ct-fact:e1 -->", text)

    def test_off_writes_nothing_and_never_calls_sink(self):
        env = dict(self.env, CT_WISDOM_VERBOSE="0")
        V.record_delivery(self._delivery(), env=env)
        V.record_non_delivery({"host": "hermes", "reason": "breaker_open"}, env=env)
        self.assertFalse(os.path.exists(self.log))
        self.assertEqual(self.notices, [])

    def test_no_env_or_keys_in_log_or_notice(self):
        V.record_delivery(self._delivery(query="q", env_dump=dict(self.env)), env=self.env)
        V.record_non_delivery({"host": "hermes", "reason": "timeout", "extra": SECRET}, env=self.env)
        with open(self.log, encoding="utf-8") as handle:
            raw = handle.read()
        self.assertNotIn(SECRET, raw)
        self.assertNotIn("OPENAI_API_KEY", raw)
        self.assertNotIn(SECRET, "".join(self.notices))

    def test_raising_sink_is_swallowed_and_log_still_written(self):
        def boom(text):
            raise RuntimeError("sink down")

        V.set_sink(boom)
        V.record_delivery(self._delivery(), env=self.env)
        self.assertEqual(len(self.events()), 1)

    def test_unwritable_log_is_swallowed_and_sink_still_called(self):
        blocker = os.path.join(self.tmp, "file")
        Path(blocker).write_text("x")
        env = dict(self.env, CT_WISDOM_VERBOSE_LOG=os.path.join(blocker, "v.jsonl"))
        V.record_delivery(self._delivery(), env=env)
        self.assertEqual(len(self.notices), 1)

    def test_garbage_event_is_swallowed(self):
        V.record_delivery(None, env=self.env)
        V.record_delivery({"result": "junk", "ledger": 5, "delivered": None}, env=self.env)
        V.record_non_delivery(42, env=self.env)

    def test_rotation_at_size_cap(self):
        os.makedirs(os.path.dirname(self.log))
        with open(self.log, "w", encoding="utf-8") as handle:
            handle.write("x" * 64)
        orig = V.MAX_LOG_BYTES
        V.MAX_LOG_BYTES = 32
        self.addCleanup(setattr, V, "MAX_LOG_BYTES", orig)
        V.record_delivery(self._delivery(), env=self.env)
        self.assertTrue(os.path.exists(self.log + ".1"))
        self.assertEqual(len(self.events()), 1)

    def test_log_file_is_private(self):
        if os.name != "posix":
            self.skipTest("POSIX permissions")
        V.record_delivery(self._delivery(), env=self.env)
        self.assertEqual(os.stat(self.log).st_mode & 0o077, 0)


class TestNonDelivery(Harness):
    def _skip(self, reason, result=None, ledger=(), query="q"):
        V.record_non_delivery({"host": "hermes", "channel": "pre_llm_call", "session_id": "s",
                               "reason": reason, "query": query, "result": result,
                               "ledger": set(ledger)}, env=self.env)
        return self.events()[-1]

    def test_plain_reason_kept(self):
        ev = self._skip("breaker_open", query=None)
        self.assertEqual((ev["event"], ev["reason"]), ("skip", "breaker_open"))
        self.assertNotIn("query", ev)
        self.assertNotIn("block", ev)

    def test_zero_hits_split(self):
        cases = [
            ({"gate": "uncalibrated", "entries": [], "corrections": []}, (), "gate_uncalibrated"),
            ({"gate": "semantic-v1:m", "entries": [], "corrections": []}, (), "no_match"),
            ({"entries": [_item("a"), _item("b")], "corrections": []}, ("a", "b"), "deduped"),
            ({"entries": [_item("a", title="", text="")], "corrections": []}, (), "budget"),
            ({"entries": [], "corrections": [_item("c", supersedes=["q"])]}, (), "no_match"),
        ]
        for result, ledger, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(self._skip("zero_hits", result, ledger)["reason"], expected)

    def test_skip_notice_names_reason(self):
        self._skip("zero_hits", {"entries": [_item("a", "Alpha")], "corrections": []}, ("a",))
        self.assertIn("nothing delivered (deduped)", self.notices[-1])
        self.assertIn("= a", self.notices[-1])


if __name__ == "__main__":
    unittest.main()

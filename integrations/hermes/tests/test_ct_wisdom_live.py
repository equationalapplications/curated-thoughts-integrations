#!/usr/bin/env python3
"""Tests for ct_wisdom_live.py — relevance-timed mid-session delivery.

Behavior tests patch `ct_wisdom_live.subprocess.run` (same pattern as
test_ct_wisdom.SubprocessPatchMixin) so they run on every OS.

Run: python3 -m unittest tests.test_ct_wisdom_live -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_live  # noqa: E402

CT = "/fake/ct"


def _item(fid, title="T", text="x", supersedes=None, provenance="human-verified"):
    return {"id": fid, "title": title, "text": text, "score": 0.9,
            "supersedes": supersedes or [], "provenance": provenance}


class RunPatch:
    def _patch_run(self, handler):
        orig = ct_wisdom_live.subprocess.run
        ct_wisdom_live.subprocess.run = handler
        self.addCleanup(setattr, ct_wisdom_live.subprocess, "run", orig)

    def _ok(self, payload, seen=None):
        def handler(cmd, *a, **k):
            if seen is not None:
                seen.append((cmd, k))
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload).encode(), b"")
        return handler


class TestCapability(unittest.TestCase, RunPatch):
    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        self.addCleanup(ct_wisdom_live.reset_capability_cache)

    def test_exit_zero_is_capable_and_memoized(self):
        calls = []

        def handler(cmd, *a, **k):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, b"usage", b"")

        self._patch_run(handler)
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))
        self.assertEqual(calls, [[CT, "wisdom", "match", "--help"]])

    def test_nonzero_is_incapable_and_memoized(self):
        self._patch_run(lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 2, b"", b"no"))
        self.assertFalse(ct_wisdom_live.has_match_capability(CT))
        self._patch_run(lambda cmd, *a, **k: self.fail("must be memoized"))
        self.assertFalse(ct_wisdom_live.has_match_capability(CT))

    def test_timeout_is_none_not_memoized(self):
        def boom(cmd, *a, **k):
            raise subprocess.TimeoutExpired(cmd, 3)

        self._patch_run(boom)
        self.assertIsNone(ct_wisdom_live.has_match_capability(CT))
        self._patch_run(lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"", b""))
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))


class TestMatchWisdom(unittest.TestCase, RunPatch):
    def test_argv_and_subprocess_contract(self):
        seen = []
        self._patch_run(self._ok({"entries": [], "corrections": []}, seen))
        ct_wisdom_live.match_wisdom(CT, "-weird query", 2, ["-a1", "b2"])
        cmd, kwargs = seen[0]
        self.assertEqual(
            cmd,
            [CT, "wisdom", "match", "--json", "--max", "2",
             "--exclude=-a1", "--exclude=b2", "--", "-weird query"],
        )
        self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
        self.assertTrue(kwargs["capture_output"])
        self.assertEqual(kwargs["timeout"], ct_wisdom_live.LIVE_TIMEOUT)
        self.assertEqual(kwargs["cwd"], os.path.expanduser("~"))
        self.assertNotIn("shell", kwargs)

    def test_success_normalizes_items(self):
        self._patch_run(self._ok({
            "entries": [_item("e1"), {"id": "bad id"}, "junk",
                        {"id": "e2", "title": 5, "supersedes": ["ok", "bad id"],
                         "provenance": " "}],
            "corrections": [_item("c1", supersedes=["e0"])],
        }))
        result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertIsNone(cls)
        self.assertEqual([i["id"] for i in result["entries"]], ["e1", "e2"])
        self.assertEqual(result["entries"][1],
                         {"id": "e2", "title": "", "text": "", "supersedes": ["ok"],
                          "provenance": None})
        self.assertEqual(result["corrections"][0]["supersedes"], ["e0"])

    def test_missing_lists_default_empty(self):
        self._patch_run(self._ok({"schema": 1}))
        result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertEqual(result, {"entries": [], "corrections": []})
        self.assertIsNone(cls)

    def test_failure_classes(self):
        def timeout(cmd, *a, **k):
            raise subprocess.TimeoutExpired(cmd, 3)

        def spawn(cmd, *a, **k):
            raise OSError("gone")

        cases = [
            (timeout, "timeout"),
            (spawn, "spawn"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 1, b"", b""), "exit"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"not json", b""), "parse_error"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"[]", b""), "parse_error"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b'{"entries": {}}', b""), "parse_error"),
        ]
        for handler, expected in cases:
            self._patch_run(handler)
            result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
            self.assertIsNone(result)
            self.assertEqual(cls, expected)


class TestBreaker(unittest.TestCase):
    def test_opens_after_n_failures_and_closes_after_pause(self):
        now = [100.0]
        b = ct_wisdom_live.Breaker(fails=3, pause=300, clock=lambda: now[0])
        b.record_failure()
        b.record_failure()
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertTrue(b.is_open())
        now[0] += 299
        self.assertTrue(b.is_open())
        now[0] += 1
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertFalse(b.is_open())  # count reset on close

    def test_success_resets_count(self):
        b = ct_wisdom_live.Breaker(fails=2, pause=10, clock=lambda: 0.0)
        b.record_failure()
        b.record_success()
        b.record_failure()
        self.assertFalse(b.is_open())


# ---------------------------------------------------------------------------
# Task 4: ledger inputs, render, pre_llm_call hook
# ---------------------------------------------------------------------------


class LiveHarness(RunPatch):
    """Patches discovery + capability + match; resets all process state."""

    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        ct_wisdom_live.reset_session_state()
        ct_ledger.LEDGER_CACHE.clear()
        orig_breaker = ct_wisdom_live._BREAKER
        ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker()
        self.addCleanup(setattr, ct_wisdom_live, "_BREAKER", orig_breaker)
        self.addCleanup(ct_wisdom_live.reset_capability_cache)
        self.addCleanup(ct_wisdom_live.reset_session_state)
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        orig_d = ct_wisdom.discover_ct
        ct_wisdom.discover_ct = lambda env=None: (CT, None)
        self.addCleanup(setattr, ct_wisdom, "discover_ct", orig_d)
        orig_c = ct_wisdom_live.has_match_capability
        ct_wisdom_live.has_match_capability = lambda p: True
        self.addCleanup(setattr, ct_wisdom_live, "has_match_capability", orig_c)
        self.calls = []
        self.reply = ({"entries": [], "corrections": []}, None)
        orig_m = ct_wisdom_live.match_wisdom

        def fake_match(path, text, max_n, exclude):
            self.calls.append({"text": text, "max_n": max_n, "exclude": list(exclude)})
            return self.reply

        ct_wisdom_live.match_wisdom = fake_match
        self.addCleanup(setattr, ct_wisdom_live, "match_wisdom", orig_m)
        orig_b = ct_wisdom.bootstrap_block
        self.boot = {}
        ct_wisdom.bootstrap_block = lambda sid: self.boot.get(sid)
        self.addCleanup(setattr, ct_wisdom, "bootstrap_block", orig_b)

    def hook(self, sid="s1", msg="how do I deploy?", history=None, first=False):
        return ct_wisdom_live.on_pre_llm_call(
            session_id=sid, user_message=msg,
            conversation_history=history or [], is_first_turn=first,
            task_id="t", turn_id="u", model="m", platform="cli",
        )


class TestBootstrapIds(LiveHarness, unittest.TestCase):
    def test_known_block_ids(self):
        self.boot["s1"] = "## h\n\n**A** <!-- ct-fact:b1 -->\nx"
        self.assertEqual(ct_wisdom_live.bootstrap_ids("s1", False), ["b1"])

    def test_first_turn_without_block_is_empty_and_remembered(self):
        self.assertEqual(ct_wisdom_live.bootstrap_ids("s2", True), [])
        self.assertEqual(ct_wisdom_live.bootstrap_ids("s2", False), [])

    def test_restored_session_unknown(self):
        self.assertIsNone(ct_wisdom_live.bootstrap_ids("s3", False))


class TestUserText(unittest.TestCase):
    def test_str_list_and_other(self):
        self.assertEqual(ct_wisdom_live.user_text("  hi  "), "hi")
        self.assertEqual(
            ct_wisdom_live.user_text([{"type": "text", "text": "a"}, {"type": "image"}, "b"]),
            "a\nb",
        )
        self.assertEqual(ct_wisdom_live.user_text(None), "")
        self.assertEqual(len(ct_wisdom_live.user_text("x" * 5000)), ct_wisdom_live.LIVE_QUERY_CHARS)


class TestRenderLiveBlock(unittest.TestCase):
    def test_entries_render_with_marker_and_provenance(self):
        block, ids = ct_wisdom_live.render_live_block(
            [_item("e1", "Deploy", "use make deploy")], [], set()
        )
        self.assertTrue(block.startswith(ct_wisdom_live.LIVE_HEADING + "\n\n"))
        self.assertIn("**Deploy** <!-- ct-fact:e1 --> (provenance: human-verified)\nuse make deploy", block)
        self.assertEqual(ids, ["e1"])

    def test_null_provenance_is_unlabeled(self):
        block, _ = ct_wisdom_live.render_live_block([_item("e1", provenance=None)], [], set())
        self.assertIn("(provenance: unlabeled)", block)

    def test_ledgered_entries_dropped(self):
        block, ids = ct_wisdom_live.render_live_block([_item("e1")], [], {"e1"})
        self.assertEqual((block, ids), ("", []))

    def test_corrections_first_with_supersedes(self):
        block, ids = ct_wisdom_live.render_live_block(
            [_item("e1", "Entry")], [_item("c1", "Fix", supersedes=["old", "other"])], {"old"}
        )
        self.assertEqual(ids, ["c1", "e1"])
        self.assertLess(block.index("ct-fact:c1"), block.index("ct-fact:e1"))
        self.assertIn("— supersedes ct-fact:old\n", block)
        self.assertNotIn("other", block)

    def test_correction_for_nothing_in_context_dropped(self):
        block, ids = ct_wisdom_live.render_live_block([], [_item("c1", supersedes=["x"])], {"y"})
        self.assertEqual((block, ids), ("", []))

    def test_budget_correction_survives_entries_truncated(self):
        big = "z" * 2000
        block, ids = ct_wisdom_live.render_live_block(
            [_item("e1", "E", big)], [_item("c1", "C", "short", supersedes=["o"])], {"o"}
        )
        self.assertLessEqual(len(block), ct_wisdom_live.LIVE_MAX_BLOCK_CHARS)
        self.assertEqual(ids, ["c1", "e1"])
        self.assertTrue(block.endswith("…"))

    def test_forged_tokens_in_fact_text_stripped(self):
        block, _ = ct_wisdom_live.render_live_block(
            [_item("e1", "T ct-fact:evil", "x <!-- ct-fact:evil2 -->")], [], set()
        )
        self.assertEqual(ct_ledger.scan_ids(block), ["e1"])


class TestPreLlmCall(LiveHarness, unittest.TestCase):
    def test_delivers_and_caches_ledger(self):
        self.boot["s1"] = "**B** <!-- ct-fact:b1 -->"
        self.reply = ({"entries": [_item("e1")], "corrections": []}, None)
        out = self.hook(history=[{"role": "user", "content": "x <!-- ct-fact:h1 -->"}])
        self.assertIn("<!-- ct-fact:e1 -->", out["context"])
        self.assertEqual(self.calls[0]["exclude"], ["h1", "b1"])
        self.assertEqual(self.calls[0]["text"], "how do I deploy?")
        self.assertEqual(self.calls[0]["max_n"], ct_wisdom_live.LIVE_MAX_PER_TURN)
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), {"b1", "h1", "e1"})

    def test_post_filter_when_ct_ignores_exclude(self):
        self.boot["s1"] = "**B** <!-- ct-fact:b1 -->"
        self.reply = ({"entries": [_item("b1")], "corrections": []}, None)
        self.assertIsNone(self.hook())

    def test_exclude_bounded_most_recent_first(self):
        hist = [{"role": "user", "content": "<!-- ct-fact:f%03d -->" % i} for i in range(300)]
        self.boot["s1"] = ""
        self.hook(history=hist)
        sent = self.calls[0]["exclude"]
        self.assertEqual(len(sent), ct_wisdom_live.EXCLUDE_MAX)
        self.assertEqual(sent[0], "f299")

    def test_no_session_cap_long_session_keeps_two_per_turn(self):
        # 2026-10-16: the per-session cap (12) was removed. A long session
        # keeps asking for LIVE_MAX_PER_TURN and receiving fresh facts; dedup
        # (the ledger) bounds the total, the per-turn limits bound each block.
        self.boot["s1"] = ""
        history, delivered = [], []
        for turn in range(20):
            fresh = ["f%02d" % (2 * turn), "f%02d" % (2 * turn + 1)]
            self.reply = ({"entries": [_item(f) for f in fresh], "corrections": []}, None)
            out = self.hook(msg="question %d" % turn, history=list(history))
            self.assertIsNotNone(out, "turn %d" % turn)
            ids = ct_ledger.scan_ids(out["context"])
            self.assertEqual(ids, fresh, "turn %d" % turn)
            self.assertLessEqual(len(out["context"]), ct_wisdom_live.LIVE_MAX_BLOCK_CHARS)
            delivered.extend(ids)
            history.append({"role": "user", "content": "question %d\n\n%s" % (turn, out["context"])})
        self.assertEqual([c["max_n"] for c in self.calls], [ct_wisdom_live.LIVE_MAX_PER_TURN] * 20)
        self.assertEqual(len(set(delivered)), 40)

    def test_many_live_ids_in_history_still_ask_the_per_turn_max(self):
        hist = [{"role": "user", "content": "<!-- ct-fact:u%02d -->" % i} for i in range(50)]
        self.boot["s1"] = ""
        self.hook(history=hist)
        self.assertEqual(self.calls[0]["max_n"], ct_wisdom_live.LIVE_MAX_PER_TURN)

    def test_session_cap_constant_is_gone(self):
        self.assertFalse(hasattr(ct_wisdom_live, "LIVE_MAX_PER_SESSION"))

    def test_restored_session_fails_closed(self):
        out = self.hook(sid="restored", history=[{"role": "user", "content": "hi"}])
        self.assertIsNone(out)
        self.assertEqual(self.calls, [])
        self.assertIsNone(ct_ledger.LEDGER_CACHE.get("restored"))

    def test_first_turn_without_bootstrap_proceeds(self):
        self.reply = ({"entries": [_item("e1")], "corrections": []}, None)
        self.assertIsNotNone(self.hook(sid="fresh", first=True))

    def test_empty_session_id_noop(self):
        self.assertIsNone(self.hook(sid=""))
        self.assertEqual(self.calls, [])

    def test_empty_query_noop_but_ledger_cached(self):
        self.boot["s1"] = "<!-- ct-fact:b1 -->"
        self.assertIsNone(self.hook(msg="   "))
        self.assertEqual(self.calls, [])
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), {"b1"})

    def test_capability_missing_noop(self):
        ct_wisdom_live.has_match_capability = lambda p: False
        self.boot["s1"] = ""
        self.assertIsNone(self.hook())
        self.assertEqual(self.calls, [])

    def test_breaker_opens_after_timeouts(self):
        self.boot["s1"] = ""
        self.reply = (None, "timeout")
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            self.assertIsNone(self.hook())
        self.assertIsNone(self.hook())
        self.assertEqual(len(self.calls), ct_wisdom_live.BREAKER_FAILS)

    def test_spawn_failure_resets_discovery_and_capability(self):
        self.boot["s1"] = ""
        self.reply = (None, "spawn")
        resets = []
        orig = ct_wisdom.reset_discovery_cache
        ct_wisdom.reset_discovery_cache = lambda: resets.append(1)
        self.addCleanup(setattr, ct_wisdom, "reset_discovery_cache", orig)
        self.assertIsNone(self.hook())
        self.assertEqual(resets, [1])

    def test_never_raises(self):
        def boom(*a, **k):
            raise RuntimeError("boom")

        ct_wisdom_live.match_wisdom = boom
        self.boot["s1"] = ""
        self.assertIsNone(self.hook())


# ---------------------------------------------------------------------------
# verbose mode (spec 2026-10-16-wisdom-verbose-mode-design.md, D8)
# ---------------------------------------------------------------------------

SECRET = "sk-live-SECRET-never-logged-9876"


class TestMatchKeepsGateAndScore(unittest.TestCase, RunPatch):
    def test_gate_and_score_kept_when_present(self):
        self._patch_run(self._ok({"schema": 1, "gate": "semantic-v1:m",
                                  "entries": [_item("e1")], "corrections": []}))
        result, _ = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertEqual(result["gate"], "semantic-v1:m")
        self.assertEqual(result["entries"][0]["score"], 0.9)

    def test_render_ignores_them(self):
        plain = {"id": "e1", "title": "T", "text": "x", "supersedes": [], "provenance": "p"}
        scored = dict(plain, score=0.42)
        self.assertEqual(ct_wisdom_live.render_live_block([plain], [], set()),
                         ct_wisdom_live.render_live_block([scored], [], set()))


class TestVerbose(LiveHarness, unittest.TestCase):
    """Verbose on or off, the hook returns the same bytes; on, it records."""

    SCENARIOS = (
        ("delivery", {"entries": [_item("e1", "Deploy"), _item("e2")], "corrections": []}, None),
        ("deduped", {"entries": [_item("b1")], "corrections": []}, None),
        ("no_match", {"gate": "semantic-v1:m", "entries": [], "corrections": []}, None),
        ("uncalibrated", {"gate": "uncalibrated", "entries": [], "corrections": []}, None),
        ("timeout", None, "timeout"),
    )

    def setUp(self):
        super().setUp()
        import ct_wisdom_verbose

        self.V = ct_wisdom_verbose
        self.tmp = tempfile.mkdtemp()
        self.log = os.path.join(self.tmp, "v.jsonl")
        self.notices = []
        prev = ct_wisdom_verbose.set_sink(self.notices.append)
        self.addCleanup(ct_wisdom_verbose.set_sink, prev)

    def env(self, on):
        values = {"CT_WISDOM_VERBOSE_LOG": self.log, "ZAI_API_KEY": SECRET}
        values["CT_WISDOM_VERBOSE"] = "1" if on else "0"
        return mock.patch.dict(os.environ, values)

    def run_scenarios(self, on):
        outs = []
        for name, reply, cls in self.SCENARIOS:
            ct_ledger.LEDGER_CACHE.clear()
            self.boot["s1"] = "**B** <!-- ct-fact:b1 -->"
            self.reply = (reply, cls)
            with self.env(on):
                outs.append((name, self.hook()))
        return outs

    def events(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle]

    def test_off_is_identical_and_silent(self):
        off = self.run_scenarios(False)
        self.assertFalse(os.path.exists(self.log))
        self.assertEqual(self.notices, [])
        # Same as a run with the recorder removed entirely.
        noop = mock.patch.multiple(self.V, record_delivery=lambda *a, **k: None,
                                   record_non_delivery=lambda *a, **k: None)
        with noop:
            bare = self.run_scenarios(False)
        self.assertEqual(off, bare)
        self.assertIn("ct-fact:e1", off[0][1]["context"])

    def test_on_records_and_bytes_unchanged(self):
        off = self.run_scenarios(False)
        on = self.run_scenarios(True)
        self.assertEqual(on, off)
        events = self.events()
        self.assertEqual([(e["event"], e["reason"]) for e in events], [
            ("delivery", None), ("skip", "deduped"), ("skip", "no_match"),
            ("skip", "gate_uncalibrated"), ("skip", "timeout"),
        ])
        first = events[0]
        self.assertEqual((first["host"], first["channel"], first["session_id"]),
                         ("hermes", "pre_llm_call", "s1"))
        self.assertEqual(first["query"], "how do I deploy?")
        self.assertEqual(first["block"], off[0][1]["context"])
        self.assertEqual(first["delivered_ids"], ["e1", "e2"])
        self.assertEqual(first["matched"][0]["score"], 0.9)
        self.assertEqual(first["ledger_size"], 1)
        self.assertEqual(len(self.notices), 5)
        self.assertIn(off[0][1]["context"], self.notices[0])

    def test_early_skips_are_recorded(self):
        with self.env(True):
            self.hook(sid="restored", history=[{"role": "user", "content": "hi"}])
            self.boot["s1"] = ""
            self.hook(msg="   ")
        self.assertEqual([e["reason"] for e in self.events()],
                         ["restored_unknown_bootstrap", "empty_query"])

    def test_recorder_failures_never_change_the_return(self):
        off = self.run_scenarios(False)

        def boom(*a, **k):
            raise RuntimeError("recorder down")

        self.V.set_sink(boom)
        with mock.patch.object(self.V, "_append", boom):
            failing = self.run_scenarios(True)
        with mock.patch.object(self.V, "build_event", boom):
            failing_build = self.run_scenarios(True)
        self.assertEqual(failing, off)
        self.assertEqual(failing_build, off)

    def test_no_env_or_keys_logged(self):
        self.run_scenarios(True)
        with open(self.log, encoding="utf-8") as handle:
            raw = handle.read()
        self.assertNotIn(SECRET, raw)
        self.assertNotIn("ZAI_API_KEY", raw)
        self.assertNotIn(SECRET, "\n".join(self.notices))


if __name__ == "__main__":
    unittest.main()

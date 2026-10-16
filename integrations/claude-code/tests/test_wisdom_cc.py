#!/usr/bin/env python3
"""Unit tests for hooks/ct_wisdom_cc.py, the Claude Code wisdom adapter.

Spec: docs/superpowers/specs/2026-10-16-claude-code-wisdom-parity-leg-design.md.
In-process. The `ct` subprocess layer of the vendored core (discovery,
capability probe, `ct wisdom match`, `ct recall`) is patched, and every store
lives in a temp CLAUDE_PLUGIN_DATA. Nothing on the host is read or written.

Run: python3 -m unittest tests.test_wisdom_cc -v
"""

from __future__ import annotations

import ast
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
sys.path.insert(0, str(INTEGRATION / "hooks"))

import ct_wisdom_cc as cc  # noqa: E402
import ct_ledger  # noqa: E402  (importable because the adapter put scripts/ on sys.path)
import ct_wisdom  # noqa: E402
import ct_wisdom_live  # noqa: E402

SID = "0b34da00-163b-41f8-bb00-04f831b7d8ff"
TOOL = "mcp__curated-thoughts__curated_recall_context"


def item(fid, supersedes=None, text=None, title=None):
    return {"id": fid, "title": title if title is not None else "T" + fid,
            "text": text if text is not None else "body " + fid,
            "supersedes": supersedes or [], "provenance": None}


def prompt_payload(prompt="what about deploys?", **extra):
    payload = {"session_id": SID, "prompt_id": "p-1", "hook_event_name": "UserPromptSubmit",
               "prompt": prompt, "cwd": "/tmp/project",
               "transcript_path": "/nonexistent/should-never-be-read.jsonl",
               "permission_mode": "default"}
    payload.update(extra)
    return payload


def tool_payload(entries, tool_name=TOOL, **extra):
    inner = {"wiki_entries": entries, "code_chunks": [], "query": "q"}
    payload = {"session_id": SID, "hook_event_name": "PostToolUse", "tool_name": tool_name,
               "tool_input": {"query": "q"},
               "tool_response": [{"type": "text", "text": json.dumps(inner)}],
               "tool_use_id": "call_1", "mcp_server": {"name": "curated-thoughts", "source": "user"}}
    payload.update(extra)
    return payload


def entry(fid):
    return {"id": fid, "title": "T" + fid, "text": "body " + fid}


class AdapterTestCase(unittest.TestCase):
    """Temp plugin-data dir + patched ct layer; restores everything after."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = tmp.name
        self.env = {"CLAUDE_PLUGIN_DATA": self.data}
        self.match_calls = []
        self.match_result = ({"entries": [], "corrections": []}, None)
        self.recall_entries = []
        self.capable = True
        self.discovered = ("/fake/ct", None)
        self._patch(ct_wisdom, "discover_ct", lambda env=None: self.discovered)
        self._patch(ct_wisdom_live, "has_match_capability", lambda path: self.capable)
        self._patch(ct_wisdom_live, "match_wisdom", self._fake_match)
        self._patch(ct_wisdom, "recall_wiki", lambda path, query: (list(self.recall_entries), None))

    def _patch(self, mod, name, value):
        orig = getattr(mod, name)
        setattr(mod, name, value)
        self.addCleanup(setattr, mod, name, orig)

    def _fake_match(self, path, text, max_n, exclude):
        self.match_calls.append({"text": text, "max_n": max_n, "exclude": list(exclude)})
        result, failure = self.match_result
        if callable(result):
            return result(path, text, max_n, exclude)
        return result, failure

    # helpers -------------------------------------------------------------
    def start(self, source="startup", sid=SID, boot=None):
        if boot is not None:
            self.recall_entries = [("T" + f, "body " + f, f) for f in boot]
        return cc.session_start({"session_id": sid, "hook_event_name": "SessionStart",
                                 "source": source, "cwd": "/tmp/project"}, env=self.env)

    def store(self, sid=SID):
        return cc.load_store(self.data, sid)

    def deliver(self, **extra):
        return cc.user_prompt_submit(prompt_payload(**extra), env=self.env)

    def context_of(self, directive):
        self.assertIsNotNone(directive)
        specific = directive["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "UserPromptSubmit")
        return specific["additionalContext"]


# ---------------------------------------------------------------------------
# AC 1 — import path
# ---------------------------------------------------------------------------


class ImportPathTests(unittest.TestCase):
    def test_core_modules_come_from_this_plugin_not_hermes(self):
        scripts = (INTEGRATION / "scripts").resolve()
        for mod in (ct_ledger, ct_wisdom, ct_wisdom_live):
            self.assertEqual(Path(mod.__file__).resolve().parent, scripts, mod.__name__)

    def test_adapter_uses_the_core_constants(self):
        self.assertEqual(cc.ct_wisdom_live.LIVE_MAX_PER_TURN, 2)
        # No per-session cap (removed 2026-10-16).
        self.assertFalse(hasattr(cc.ct_wisdom_live, "LIVE_MAX_PER_SESSION"))
        self.assertEqual(cc.ct_wisdom_live.EXCLUDE_MAX, 256)
        self.assertEqual(cc.ct_wisdom_live.BREAKER_FAILS, 3)
        self.assertEqual(cc.ct_wisdom_live.BREAKER_PAUSE, 300)


# ---------------------------------------------------------------------------
# store (D3)
# ---------------------------------------------------------------------------


class StoreTests(AdapterTestCase):
    def test_uuid_is_its_own_key_and_odd_ids_are_hashed(self):
        self.assertEqual(cc.session_key(SID), SID)
        odd = cc.session_key("../../etc/passwd")
        self.assertRegex(odd, r"^[0-9a-f]{64}$")

    def test_round_trip(self):
        st = cc.new_store(SID, "on", "block", ["a", "b"])
        cc.save_store(self.data, SID, st)
        back = self.store()
        self.assertEqual(back["bootstrap_ids"], ["a", "b"])
        self.assertEqual(back["state"], "on")
        self.assertEqual(cc.ledger_of(back), {"a", "b"})

    def test_missing_corrupt_or_mismatched_store_reads_as_none(self):
        self.assertIsNone(self.store())
        path = cc.session_path(self.data, SID)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_text("{not json", encoding="utf-8")
        self.assertIsNone(self.store())
        Path(path).write_text(json.dumps(dict(cc.new_store("other", "on", "", []))),
                              encoding="utf-8")
        self.assertIsNone(self.store())
        st = cc.new_store(SID, "on", "", [])
        st["v"] = 99
        Path(path).write_text(json.dumps(st), encoding="utf-8")
        self.assertIsNone(self.store())

    def test_exclude_is_newest_first_unique_and_capped(self):
        st = cc.new_store(SID, "on", "", ["boot"])
        cc.note_ids(st, "live_ids", ["x", "y"])
        cc.note_ids(st, "tool_ids", ["boot", "z"])
        self.assertEqual(cc.exclude_of(st), ["z", "boot", "y", "x"])
        big = cc.new_store(SID, "on", "", [])
        cc.note_ids(big, "tool_ids", ["f%04d" % i for i in range(400)])
        excl = cc.exclude_of(big)
        self.assertEqual(len(excl), 256)
        self.assertEqual(excl[0], "f0399")

    def test_no_data_dir_means_no_store(self):
        self.assertIsNone(cc.data_dir({}))
        self.assertIsNone(cc.data_dir({"CLAUDE_PLUGIN_DATA": ""}))
        self.assertEqual(cc.data_dir({"CLAUDE_PLUGIN_DATA": self.data}), self.data)

    def test_prune_drops_only_old_session_files(self):
        cc.save_store(self.data, "old", cc.new_store("old", "on", "", []))
        cc.save_store(self.data, "new", cc.new_store("new", "on", "", []))
        old_path = cc.session_path(self.data, "old")
        past = time.time() - 31 * 86400
        os.utime(old_path, (past, past))
        cc.prune(self.data)
        self.assertFalse(os.path.exists(old_path))
        self.assertTrue(os.path.exists(cc.session_path(self.data, "new")))

    def test_lock_wait_is_bounded(self):
        path = cc.session_path(self.data, SID)
        with cc.locked(path):
            started = time.monotonic()
            with self.assertRaises(cc.LockTimeout):
                with cc.locked(path, wait=0.2):
                    pass
            self.assertLess(time.monotonic() - started, 2.0)


# ---------------------------------------------------------------------------
# provenance (D5) + main thread (D6)
# ---------------------------------------------------------------------------


class ProvenanceTests(unittest.TestCase):
    def test_a_typed_prompt_is_a_user_turn(self):
        self.assertTrue(cc.is_genuine_user_turn(prompt_payload()))

    def test_main_thread_of_an_agent_session_is_a_user_turn(self):
        self.assertTrue(cc.is_genuine_user_turn(prompt_payload(agent_type="reviewer")))

    def test_inline_markup_mid_prompt_is_fine(self):
        self.assertTrue(cc.is_genuine_user_turn(prompt_payload(prompt="why is <b> bold?")))

    def test_unclear_provenance_is_rejected(self):
        bad = [
            prompt_payload(agent_id="afa1d7c4a183dfbd9"),
            prompt_payload(prompt_id=""),
            {k: v for k, v in prompt_payload().items() if k != "prompt_id"},
            prompt_payload(session_id=""),
            prompt_payload(prompt=""),
            prompt_payload(prompt="   \n"),
            prompt_payload(prompt=None),
            prompt_payload(hook_event_name="UserPromptExpansion"),
            prompt_payload(prompt='<agent-message from="afa1">\n[Subagent hand-back] ...'),
            prompt_payload(prompt="<task-notification>\n<task-id>x</task-id>"),
            prompt_payload(prompt="  \n<teammate-message teammate_id=\"t\">hi"),
            prompt_payload(prompt="<system-reminder/>"),
            "not a dict",
        ]
        for payload in bad:
            with self.subTest(payload=payload):
                self.assertFalse(cc.is_genuine_user_turn(payload))


class MainThreadTests(AdapterTestCase):
    def test_subagent_prompt_never_delivers_or_writes(self):
        self.start()
        self.match_result = ({"entries": [item("a")], "corrections": []}, None)
        before = self.store()
        self.assertIsNone(self.deliver(agent_id="sub1"))
        self.assertEqual(self.match_calls, [])
        self.assertEqual(self.store(), before)

    def test_subagent_tool_result_passes_through_and_is_not_recorded(self):
        self.start(boot=["a"])
        before = self.store()
        out = cc.post_tool_use(tool_payload([entry("a"), entry("b")], agent_id="sub1",
                                            agent_type="general-purpose"), env=self.env)
        self.assertIsNone(out)
        self.assertEqual(self.store(), before)


# ---------------------------------------------------------------------------
# breaker (persisted, D8)
# ---------------------------------------------------------------------------


class BreakerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "breaker.json")
        self.now = [1000.0]
        self.clock = lambda: self.now[0]

    def breaker(self):
        return cc.PersistedBreaker(self.path, clock=self.clock)

    def test_opens_after_three_failures_across_processes(self):
        for _ in range(2):
            self.breaker().record_failure()
        self.assertFalse(self.breaker().is_open())
        self.breaker().record_failure()
        self.assertTrue(self.breaker().is_open())

    def test_closes_after_the_pause(self):
        for _ in range(3):
            self.breaker().record_failure()
        self.now[0] += 299
        self.assertTrue(self.breaker().is_open())
        self.now[0] += 2
        self.assertFalse(self.breaker().is_open())
        self.breaker().record_failure()
        self.assertFalse(self.breaker().is_open(), "count restarted after the pause")

    def test_success_resets_the_count(self):
        self.breaker().record_failure()
        self.breaker().record_failure()
        self.breaker().record_success()
        self.breaker().record_failure()
        self.assertFalse(self.breaker().is_open())

    def test_corrupt_file_reads_as_closed(self):
        Path(self.path).write_text("garbage", encoding="utf-8")
        self.assertFalse(self.breaker().is_open())


# ---------------------------------------------------------------------------
# SessionStart rules (D7)
# ---------------------------------------------------------------------------


class SessionStartRuleTests(AdapterTestCase):
    def test_startup_renders_bootstrap_and_seeds_the_store(self):
        block = self.start(boot=["a", "b"])
        self.assertIn(ct_ledger.marker("a"), block)
        st = self.store()
        self.assertEqual(st["state"], "on")
        self.assertEqual(st["bootstrap_ids"], ["a", "b"])
        self.assertEqual(st["bootstrap_block"], block)

    def test_startup_with_no_hits_still_seeds_an_empty_ledger(self):
        self.assertEqual(self.start(boot=[]), "")
        st = self.store()
        self.assertEqual(st["state"], "on")
        self.assertEqual(cc.ledger_of(st), set())

    def test_startup_reseeds_an_existing_store(self):
        self.start(boot=["a"])
        cc.save_store(self.data, SID, dict(self.store(), state="off", off_reason="resume"))
        self.start(boot=["c"])
        st = self.store()
        self.assertEqual((st["state"], st["bootstrap_ids"], st["live_ids"]), ("on", ["c"], []))

    def test_clear_with_a_new_id_is_a_fresh_session(self):
        # Observed on Claude Code 2.1.301: /clear mints a new session_id (F12).
        self.start(boot=["a"])
        block = self.start("clear", sid="new-session-id", boot=["b"])
        self.assertIn(ct_ledger.marker("b"), block)
        self.assertEqual(self.store("new-session-id")["state"], "on")

    def test_clear_with_a_retained_id_latches_off(self):
        self.start(boot=["a"])
        block = self.start("clear", boot=["b"])
        self.assertIn(ct_ledger.marker("b"), block, "bootstrap still renders")
        st = self.store()
        self.assertEqual((st["state"], st["off_reason"]), ("off", "clear_same_id"))

    def test_resume_latches_off_and_does_not_re_emit_the_replayed_block(self):
        self.start(boot=["a"])
        self.assertEqual(self.start("resume", boot=["zzz"]), "")
        st = self.store()
        self.assertEqual((st["state"], st["off_reason"]), ("off", "resume"))
        self.assertEqual(st["bootstrap_ids"], ["a"])

    def test_resume_of_an_unknown_session_renders_and_records_off(self):
        block = self.start("resume", boot=["a"])
        self.assertIn(ct_ledger.marker("a"), block)
        st = self.store()
        self.assertEqual((st["state"], st["bootstrap_ids"]), ("off", ["a"]))

    def test_compact_continues_and_replays_the_stored_block(self):
        first = self.start(boot=["a"])
        cc.save_store(self.data, SID, cc.note_ids(self.store(), "live_ids", ["x"]))
        before = self.store()
        self.recall_entries = [("Tq", "other", "q")]
        replay = self.start("compact")
        self.assertEqual(replay, first, "byte-identical replay, no new recall")
        after = self.store()
        self.assertEqual(after["state"], "on")
        self.assertEqual(cc.ledger_of(after), cc.ledger_of(before))

    def test_compact_of_an_off_session_stays_off(self):
        self.start(boot=["a"])
        self.start("resume")
        self.assertIn(ct_ledger.marker("a"), self.start("compact"))
        self.assertEqual(self.store()["state"], "off")

    def test_compact_without_a_store_writes_nothing(self):
        self.start("compact", boot=["a"])
        self.assertIsNone(self.store())

    def test_fork_and_unknown_sources_latch_off(self):
        for source, reason in (("fork", "fork"), ("weird", "unknown_source"), (None, "unknown_source")):
            with self.subTest(source=source):
                sid = "s-%s" % source
                self.start(source, sid=sid, boot=["a"])
                st = self.store(sid)
                self.assertEqual((st["state"], st["off_reason"]), ("off", reason))

    def test_off_has_no_re_arm_path(self):
        self.start(boot=["a"])
        self.start("resume")
        self.start("compact")
        self.start("clear")
        self.match_result = ({"entries": [item("n")], "corrections": []}, None)
        self.assertIsNone(self.deliver())
        self.assertEqual(self.match_calls, [])

    def test_no_data_dir_still_renders_the_bootstrap(self):
        self.recall_entries = [("Ta", "body a", "a")]
        block = cc.session_start({"session_id": SID, "source": "startup"}, env={"CLAUDE_PLUGIN_DATA": ""})
        self.assertIn(ct_ledger.marker("a"), block)

    def test_empty_session_id_renders_nothing(self):
        self.recall_entries = [("Ta", "body a", "a")]
        self.assertEqual(cc.session_start({"session_id": "", "source": "startup"}, env=self.env), "")

    def test_bootstrap_failure_classes_render_empty(self):
        self.discovered = (None, None)
        self.assertEqual(self.start(boot=["a"]), "")
        self.assertEqual(self.store()["state"], "on", "a store with an empty ledger is still known")


# ---------------------------------------------------------------------------
# UserPromptSubmit delivery (D8) + AC 3
# ---------------------------------------------------------------------------


class DeliveryTests(AdapterTestCase):
    def test_delivers_a_marked_block_and_records_it_before_output(self):
        self.start(boot=["a"])
        self.match_result = ({"entries": [item("b")], "corrections": []}, None)
        context = self.context_of(self.deliver())
        self.assertTrue(context.startswith(ct_wisdom_live.LIVE_HEADING))
        self.assertIn(ct_ledger.marker("b"), context)
        st = self.store()
        self.assertEqual(st["live_ids"], ["b"])
        self.assertEqual(self.match_calls[0]["exclude"], ["a"])
        self.assertEqual(self.match_calls[0]["max_n"], 2)
        self.assertEqual(self.match_calls[0]["text"], "what about deploys?")

    def test_ledger_is_what_the_next_trigger_reads(self):
        self.start(boot=["a"])
        self.match_result = ({"entries": [item("b")], "corrections": []}, None)
        self.deliver()
        cc.post_tool_use(tool_payload([entry("c")]), env=self.env)
        self.match_result = ({"entries": [item("a"), item("b"), item("c")], "corrections": []}, None)
        self.assertIsNone(self.deliver(), "everything is already in the store ledger")
        self.assertEqual(set(self.match_calls[1]["exclude"]), {"a", "b", "c"})
        self.assertEqual(self.match_calls[1]["exclude"][0], "c", "newest first")

    def test_corrections_only_when_superseding_something_in_the_ledger(self):
        self.start(boot=["old"])
        self.match_result = ({"entries": [], "corrections": [item("new", supersedes=["old"]),
                                                             item("stray", supersedes=["nope"])]}, None)
        context = self.context_of(self.deliver())
        self.assertIn("supersedes ct-fact:old", context)
        self.assertNotIn("stray", context)
        self.assertEqual(self.store()["live_ids"], ["new"])

    def test_no_session_cap_long_session_keeps_two_per_turn(self):
        # 2026-10-16: the per-session cap (12) was removed. Every turn asks
        # for LIVE_MAX_PER_TURN; the store ledger dedups, so the total is
        # bounded by the distinct facts that match.
        self.start()
        delivered = []
        for turn in range(20):
            fresh = ["f%02d" % (2 * turn), "f%02d" % (2 * turn + 1)]
            self.match_result = ({"entries": [item(f) for f in fresh], "corrections": []}, None)
            context = self.context_of(self.deliver(prompt="question %d" % turn))
            self.assertEqual(ct_ledger.scan_ids(context), fresh, "turn %d" % turn)
            self.assertLessEqual(len(context), ct_wisdom_live.LIVE_MAX_BLOCK_CHARS)
            delivered.extend(fresh)
        self.assertEqual([c["max_n"] for c in self.match_calls], [2] * 20)
        self.assertEqual(self.store()["live_ids"], delivered)

    def test_many_live_ids_in_the_store_still_ask_the_per_turn_max(self):
        self.start()
        st = self.store()
        cc.save_store(self.data, SID, cc.note_ids(st, "live_ids", ["f%02d" % i for i in range(50)]))
        self.deliver()
        self.assertEqual(self.match_calls[0]["max_n"], 2)

    def test_post_filter_rereads_the_store_after_the_match(self):
        # The lock is not held across `ct wisdom match`: a concurrent writer
        # (a parallel PostToolUse) can record an id meanwhile, and the
        # post-filter must see it.
        self.start()

        def concurrent(path, text, max_n, exclude):
            with cc.locked(cc.session_path(self.data, SID), wait=0.5):
                st = cc.load_store(self.data, SID)
                cc.save_store(self.data, SID, cc.note_ids(st, "tool_ids", ["late"]))
            return {"entries": [item("late"), item("fresh")], "corrections": []}, None

        self.match_result = (concurrent, None)
        context = self.context_of(self.deliver())
        self.assertNotIn(ct_ledger.marker("late"), context)
        self.assertIn(ct_ledger.marker("fresh"), context)

    def test_block_is_capped(self):
        self.start()
        self.match_result = ({"entries": [item("a", text="x" * 5000), item("b")], "corrections": []}, None)
        context = self.context_of(self.deliver())
        self.assertLessEqual(len(context), ct_wisdom_live.LIVE_MAX_BLOCK_CHARS)
        self.assertEqual(self.store()["live_ids"], ["a"])

    def test_zero_hits_emit_nothing(self):
        self.start()
        self.assertIsNone(self.deliver())
        self.assertEqual(self.store()["live_ids"], [])

    def test_query_is_truncated(self):
        self.start()
        self.deliver(prompt="q" * 5000)
        self.assertEqual(len(self.match_calls[0]["text"]), ct_wisdom_live.LIVE_QUERY_CHARS)


class TranscriptNeverReadTests(unittest.TestCase):
    def test_the_adapter_source_never_touches_transcript_path(self):
        source = (INTEGRATION / "hooks" / "ct_wisdom_cc.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        literals = [n.value for n in ast.walk(tree)
                    if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        self.assertNotIn("transcript_path", literals)


# ---------------------------------------------------------------------------
# AC 4 — fail closed
# ---------------------------------------------------------------------------


class FailClosedTests(AdapterTestCase):
    def setUp(self):
        super().setUp()
        self.match_result = ({"entries": [item("a")], "corrections": []}, None)

    def assert_silent(self):
        self.assertIsNone(self.deliver())

    def test_no_store_means_no_delivery(self):
        self.assert_silent()
        self.assertEqual(self.match_calls, [])

    def test_no_data_dir_means_no_delivery(self):
        self.start()
        self.assertIsNone(cc.user_prompt_submit(prompt_payload(), env={"CLAUDE_PLUGIN_DATA": ""}))

    def test_corrupt_store_means_no_delivery(self):
        self.start()
        Path(cc.session_path(self.data, SID)).write_text("{", encoding="utf-8")
        self.assert_silent()

    def test_off_session_means_no_delivery(self):
        self.start()
        self.start("resume")
        self.assert_silent()
        self.assertEqual(self.match_calls, [])

    def test_capability_absent_is_a_silent_no_op(self):
        self.start()
        for value in (False, None):
            self.capable = value
            self.assert_silent()
        self.assertEqual(self.match_calls, [])

    def test_discovery_miss_is_a_silent_no_op(self):
        self.start()
        self.discovered = (None, None)
        self.assert_silent()

    def test_breaker_trips_after_three_failures_and_pauses(self):
        self.start()
        for failure in ("timeout", "exit", "timeout"):
            self.match_result = (None, failure)
            self.assert_silent()
        self.assertEqual(len(self.match_calls), 3)
        self.match_result = ({"entries": [item("a")], "corrections": []}, None)
        self.assert_silent()
        self.assertEqual(len(self.match_calls), 3, "breaker open: ct not called")
        breaker_path = os.path.join(self.data, "wisdom", "breaker.json")
        state = json.loads(Path(breaker_path).read_text(encoding="utf-8"))
        state["open_until"] = time.time() - 1
        Path(breaker_path).write_text(json.dumps(state), encoding="utf-8")
        self.assertIsNotNone(self.deliver())

    def test_parse_and_spawn_failures_do_not_trip_the_breaker(self):
        self.start()
        for failure in ("parse_error", "spawn", "parse_error", "spawn"):
            self.match_result = (None, failure)
            self.assert_silent()
        self.match_result = ({"entries": [item("a")], "corrections": []}, None)
        self.assertIsNotNone(self.deliver())

    def test_resume_keeps_bootstrap_but_stops_delivery(self):
        block = self.start(boot=["b"])
        self.assertIn(ct_ledger.marker("b"), block)
        self.start("resume")
        self.assertEqual(self.store()["bootstrap_block"], block)
        self.assert_silent()

    def test_a_raising_core_never_escapes(self):
        self.start()

        def boom(*a, **k):
            raise RuntimeError("core bug")

        self._patch(ct_wisdom_live, "match_wisdom", boom)
        self.assert_silent()


# ---------------------------------------------------------------------------
# PostToolUse stub rewrite (D9)
# ---------------------------------------------------------------------------


class ToolRewriteTests(AdapterTestCase):
    def rewrite(self, payload):
        return cc.post_tool_use(payload, env=self.env)

    def inner_of(self, directive):
        specific = directive["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "PostToolUse")
        blocks = specific["updatedToolOutput"]
        self.assertIsInstance(blocks, list)
        return json.loads(blocks[0]["text"])

    def test_known_ids_become_stubs_and_new_ids_are_recorded(self):
        self.start(boot=["a"])
        out = self.rewrite(tool_payload([entry("a"), entry("b")]))
        inner = self.inner_of(out)
        self.assertEqual(inner["wiki_entries"][0],
                         {"id": "a", "in_context": True, "note": "already in context: ct-fact:a"})
        self.assertEqual(inner["wiki_entries"][1], entry("b"))
        self.assertEqual(inner["code_chunks"], [])
        self.assertEqual(self.store()["tool_ids"], ["b"])

    def test_nothing_known_means_no_output_but_ids_recorded(self):
        self.start()
        self.assertIsNone(self.rewrite(tool_payload([entry("b")])))
        self.assertEqual(self.store()["tool_ids"], ["b"])
        out = self.rewrite(tool_payload([entry("b")]))
        self.assertTrue(self.inner_of(out)["wiki_entries"][0]["in_context"])

    def test_only_the_recall_tool_is_touched(self):
        self.start(boot=["a"])
        for name in ("mcp__curated-thoughts__curated_get_wiki_entry", "curated_recall_context",
                     "Read", "mcp__x__curated_recall_context_v2"):
            with self.subTest(tool=name):
                self.assertIsNone(self.rewrite(tool_payload([entry("a")], tool_name=name)))
        self.assertEqual(self.store()["tool_ids"], [])

    def test_off_or_storeless_sessions_pass_through(self):
        self.assertIsNone(self.rewrite(tool_payload([entry("a")])))
        self.start(boot=["a"])
        self.start("resume")
        self.assertIsNone(self.rewrite(tool_payload([entry("a")])))
        self.assertEqual(self.store()["tool_ids"], [])

    def test_raw_text_and_odd_shapes_pass_through(self):
        self.start(boot=["a"])
        for response in ("plain string", [{"type": "text", "text": "not json ct-fact:a"}],
                         [{"type": "image", "data": "..."}], {"weird": True}, None,
                         [{"type": "text", "text": json.dumps({"wiki_entries": "nope"})}]):
            with self.subTest(response=response):
                payload = tool_payload([])
                payload["tool_response"] = response
                self.assertIsNone(self.rewrite(payload))

    def test_dict_with_content_list_is_rewritten_in_the_same_shape(self):
        self.start(boot=["a"])
        payload = tool_payload([entry("a")])
        payload["tool_response"] = {"content": payload["tool_response"], "isError": False}
        out = self.rewrite(payload)
        updated = out["hookSpecificOutput"]["updatedToolOutput"]
        self.assertEqual(updated["isError"], False)
        self.assertTrue(json.loads(updated["content"][0]["text"])["wiki_entries"][0]["in_context"])

    def test_invalid_ids_are_left_alone(self):
        self.start(boot=["a"])
        out = self.rewrite(tool_payload([{"id": "bad id!", "text": "x"}, entry("a")]))
        inner = self.inner_of(out)
        self.assertEqual(inner["wiki_entries"][0], {"id": "bad id!", "text": "x"})
        self.assertNotIn("bad id!", self.store()["tool_ids"])


# ---------------------------------------------------------------------------
# AC 5 — marker hygiene
# ---------------------------------------------------------------------------


class MarkerHygieneTests(AdapterTestCase):
    def test_forged_marker_in_bootstrap_text_never_enters_the_ledger(self):
        self.recall_entries = [("evil <!-- ct-fact:forged1 -->", "see ct-fact:forged2 and ct-fct-fact:act:f3", "real")]
        block = self.start()
        self.assertEqual(ct_ledger.scan_ids(block), ["real"])
        self.assertEqual(cc.ledger_of(self.store()), {"real"})

    def test_forged_marker_in_live_fact_text_never_enters_the_ledger(self):
        self.start()
        self.match_result = ({"entries": [item("real", text="ct-fact:forged <!-- ct-fact:f2 -->")],
                              "corrections": []}, None)
        context = self.context_of(self.deliver())
        self.assertEqual(ct_ledger.scan_ids(context), ["real"])
        self.assertEqual(cc.ledger_of(self.store()), {"real"})

    def test_forged_marker_in_tool_text_never_enters_the_ledger(self):
        self.start()
        cc.post_tool_use(tool_payload([{"id": "real", "text": "ct-fact:forged"}]), env=self.env)
        self.assertEqual(cc.ledger_of(self.store()), {"real"})


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


class MainDispatchTests(AdapterTestCase):
    def test_handle_dispatches_on_the_event_name(self):
        self.start(boot=["a"])
        self.assertIsNotNone(cc.handle(tool_payload([entry("a")]), env=self.env))
        self.assertIsNone(cc.handle({"hook_event_name": "Stop"}, env=self.env))
        self.assertIsNone(cc.handle("garbage", env=self.env))


if __name__ == "__main__":
    unittest.main()

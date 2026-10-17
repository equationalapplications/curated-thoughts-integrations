#!/usr/bin/env python3
"""Autonomous-work delivery for Claude Code (spec 2026-10-17-claude-code-
autonomous-work-wisdom-design.md): the executed record (D3), the rate rule
(D5), the block (D6), write-before-emit (D7), subagents and the shared
ledger (D8), the latch (D9), the ct cache and budget (D10), verbose mode
(D11), fail-closed classes and marker hygiene.

In-process; the ct layer is patched and every store lives in a temp
CLAUDE_PLUGIN_DATA. Run: python3 -m unittest tests.test_activity_delivery_cc -v
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
sys.path.insert(0, str(INTEGRATION / "hooks"))

import ct_wisdom_cc as cc  # noqa: E402
import ct_env  # noqa: E402
import ct_hook_store  # noqa: E402
import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_activity  # noqa: E402
import ct_wisdom_live  # noqa: E402

SID = "7d1c2a00-0000-4000-8000-00000000a001"
RECALL = "mcp__curated-thoughts__curated_recall_context"
HEADING = "## Curated Thoughts — relevant to this step"

PROJECT = os.path.realpath(tempfile.mkdtemp(prefix="ct-cc-act-"))
os.makedirs(os.path.join(PROJECT, ".git"))
for _rel in ("src/a.py", "src/b.py", "README.md", "package.json"):
    os.makedirs(os.path.dirname(os.path.join(PROJECT, _rel)), exist_ok=True)
    open(os.path.join(PROJECT, _rel), "a").close()


def tearDownModule():
    shutil.rmtree(PROJECT, ignore_errors=True)


def fact(fid, title=None, text=None, supersedes=None):
    return {"id": fid, "title": title or ("Title " + fid), "text": text or ("Text of " + fid),
            "provenance": "stated", "supersedes": list(supersedes or []), "score": 0.8}


_N = [0]


def call(tool="Read", args=None, response="1\tx\n", use_id=None):
    if use_id is None:
        _N[0] += 1
        use_id = "toolu_%04d" % _N[0]
    return {"tool_name": tool, "tool_input": args if args is not None else {"file_path": "src/a.py"},
            "tool_use_id": use_id, "tool_response": response}


def recall_response(ids):
    inner = {"wiki_entries": [{"id": f, "title": "T" + f, "text": "body " + f} for f in ids],
             "code_chunks": [], "query": "q"}
    return [{"type": "text", "text": json.dumps(inner)}]


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = tmp.name
        self.env = {"CLAUDE_PLUGIN_DATA": self.data, "HOME": os.path.join(self.data, "home"),
                    "USER": "tester", "PATH": os.environ.get("PATH", "")}
        self.boot = []
        self.match = {}            # query -> [fact]
        self.fail = None           # failure class returned by match
        self.honor_exclude = True
        self.calls = []            # ("discover"|"probe"|"match", query, max_n, exclude)
        self.discovered = ("/fake/ct", None)
        self.capable = True
        self._patch(ct_wisdom, "discover_ct", self._discover)
        self._patch(ct_wisdom_live, "has_match_capability", self._probe)
        self._patch(ct_wisdom_live, "match_wisdom", self._match)
        self._patch(ct_wisdom, "recall_wiki",
                    lambda p, q: ([("T" + f, "body " + f, f) for f in self.boot], None))
        ct_wisdom_activity.reset_state()

    def _patch(self, mod, name, value):
        orig = getattr(mod, name)
        setattr(mod, name, value)
        self.addCleanup(setattr, mod, name, orig)

    def _discover(self, env=None):
        self.calls.append(("discover", None, None, None))
        return self.discovered

    def _probe(self, path):
        self.calls.append(("probe", None, None, None))
        return self.capable

    def _match(self, path, text, max_n, exclude):
        self.calls.append(("match", text, max_n, list(exclude)))
        if self.fail:
            return None, self.fail
        facts = self.match(text) if callable(self.match) else self.match.get(text, [])
        if self.honor_exclude:
            facts = [f for f in facts if f["id"] not in exclude]
        return {"entries": [dict(f) for f in facts][:max_n], "corrections": [],
                "gate": "semantic-v1:test"}, None

    def queries(self):
        return [c[1] for c in self.calls if c[0] == "match"]

    # host events ---------------------------------------------------------
    def start(self, source="startup", sid=SID):
        return cc.session_start({"session_id": sid, "hook_event_name": "SessionStart",
                                 "source": source, "cwd": PROJECT}, env=self.env)

    def executed(self, c, sid=SID, agent_id=None, failure=False):
        payload = {"session_id": sid, "cwd": PROJECT, "tool_name": c["tool_name"],
                   "tool_input": c["tool_input"], "tool_use_id": c["tool_use_id"],
                   "hook_event_name": "PostToolUseFailure" if failure else "PostToolUse"}
        if failure:
            payload["error"] = "Exit code 1"
        else:
            payload["tool_response"] = {"ok": True}
        if agent_id:
            payload.update(agent_id=agent_id, agent_type="general-purpose")
        return cc.respond(payload, env=self.env)

    def batch(self, calls, sid=SID, agent_id=None, run=True, env=None):
        """Run the batch's executed hooks (unless run=False), then PostToolBatch."""
        if run:
            for c in calls:
                if c["tool_name"] in cc.ACTIVITY_TOOLS:
                    self.executed(c, sid=sid, agent_id=agent_id)
        payload = {"session_id": sid, "cwd": PROJECT, "hook_event_name": "PostToolBatch",
                   "permission_mode": "default", "transcript_path": "/nonexistent.jsonl",
                   "tool_calls": calls}
        if agent_id:
            payload.update(agent_id=agent_id, agent_type="general-purpose")
        return cc.respond(payload, env=env or self.env)

    def store(self, sid=SID):
        return cc.load_store(self.data, sid)

    @staticmethod
    def block(out):
        if not out or "hookSpecificOutput" not in out:
            return None
        specific = out["hookSpecificOutput"]
        assert specific["hookEventName"] == "PostToolBatch"
        return specific["additionalContext"]


class DeliveryTests(Base):
    def test_one_fact_marker_first_within_budget(self):
        self.match = {"src/a.py": [fact("act1"), fact("act2")]}
        self.start()
        block = self.block(self.batch([call()]))
        self.assertTrue(block.startswith(HEADING + "\n_for: read src/a.py_\n\n<!-- ct-fact:act1 -->"),
                        block)
        self.assertNotIn("act2", block)
        self.assertLessEqual(len(block), ct_wisdom_activity.ACTIVITY_MAX_BLOCK_CHARS)
        self.assertEqual(self.queries(), ["src/a.py"])
        self.assertEqual([c[2] for c in self.calls if c[0] == "match"], [1])
        self.assertEqual(self.store()["activity_ids"], ["act1"])
        self.assertIn("act1", cc.ledger_of(self.store()))

    def test_absolute_path_sends_the_project_relative_target(self):
        self.match = {"src/a.py": [fact("act1")]}
        self.start()
        out = self.batch([call(args={"file_path": os.path.join(PROJECT, "src", "a.py")})])
        self.assertIsNotNone(self.block(out))
        self.assertEqual(self.queries(), ["src/a.py"])
        self.assertNotIn(PROJECT, json.dumps(self.calls))

    def test_denied_call_never_queries(self):
        # H3: a denied call is in the batch, but no PostToolUse fired for it.
        self.match = {"src/a.py": [fact("act1")]}
        self.start()
        out = self.batch([call(response="PreToolUse:Read hook error: denied")], run=False)
        self.assertIsNone(out)
        self.assertEqual(self.queries(), [])

    def test_executed_failure_counts(self):
        self.match = {"pnpm test": [fact("pt")]}
        self.start()
        c = call("Bash", {"command": "pnpm test"}, response="Exit code 1")
        self.executed(c, failure=True)
        self.assertIsNotNone(self.block(self.batch([c], run=False)))
        self.assertEqual(self.queries(), ["pnpm test"])

    def test_one_query_per_batch_then_the_next_key(self):
        self.match = {"src/a.py": [fact("a1")], "src/b.py": [fact("b1")]}
        self.start()
        block = self.block(self.batch([call(), call(args={"file_path": "src/b.py"})]))
        self.assertIn("ct-fact:a1", block)
        self.assertEqual(self.queries(), ["src/a.py"])
        block = self.block(self.batch([call(), call(args={"file_path": "src/b.py"})]))
        self.assertIn("ct-fact:b1", block)
        self.assertEqual(self.queries(), ["src/a.py", "src/b.py"])

    def test_same_key_never_requeries_and_file_verbs_fold(self):
        self.match = {"src/a.py": [fact("a1"), fact("a2")]}
        self.start()
        self.batch([call()])
        self.assertIsNone(self.batch([call("Edit", {"file_path": "src/a.py", "old_string": "x",
                                                    "new_string": "y"})]))
        self.assertEqual(self.queries(), ["src/a.py"])

    def test_ct_tools_never_trigger_and_their_ids_join_the_ledger(self):
        self.start()
        out = self.batch([call(RECALL, {"query": "src/a.py"}, response=recall_response(["r1"]))])
        self.assertIsNone(out)
        self.assertEqual(self.queries(), [])
        self.assertIn("r1", cc.ledger_of(self.store()))

    def test_recall_in_the_same_batch_is_ledgered_before_render(self):
        self.match = {"src/a.py": [fact("r1"), fact("a1")]}
        self.start()
        block = self.block(self.batch([call(RECALL, {"query": "x"}, response=recall_response(["r1"])),
                                       call()]))
        self.assertIn("r1", self.calls[-1][3])  # excluded at the source
        self.assertIn("ct-fact:a1", block)
        self.assertNotIn("ct-fact:r1", block)

    def test_recall_in_the_same_batch_is_post_filtered(self):
        self.match = {"src/a.py": [fact("r1")]}
        self.honor_exclude = False
        self.start()
        self.assertIsNone(self.batch([call(RECALL, {"query": "x"},
                                           response=recall_response(["r1"])), call()]))

    def test_bootstrap_fact_is_never_redelivered(self):
        self.boot = ["boot1"]
        self.match = {"src/a.py": [fact("boot1")]}
        self.honor_exclude = False
        self.start()
        self.assertIsNone(self.batch([call()]))
        self.assertIn("boot1", self.calls[-1][3])  # excluded at the source too

    def test_user_turn_excludes_activity_ids(self):
        self.match = {"src/a.py": [fact("a1")], "deploy?": [fact("a1"), fact("u1")]}
        self.honor_exclude = False
        self.start()
        self.batch([call()])
        out = cc.user_prompt_submit({"session_id": SID, "prompt_id": "p1", "prompt": "deploy?",
                                     "hook_event_name": "UserPromptSubmit"}, env=self.env)
        context = out["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("ct-fact:a1", context)
        self.assertIn("ct-fact:u1", context)
        self.assertIn("a1", self.calls[-1][3])

    def test_non_activity_tools_are_ignored(self):
        self.start()
        self.assertIsNone(self.batch([call("Agent", {"prompt": "read src/a.py"}),
                                      call("WebFetch", {"url": "https://x"})]))
        self.assertEqual(self.queries(), [])

    def test_write_result_bytes_are_never_touched(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        c = call("Write", {"file_path": "src/a.py", "content": "SECRET"},
                 response="File created successfully at: src/a.py")
        out = self.batch([c])
        self.assertEqual(set(out), {"hookSpecificOutput"})
        self.assertEqual(set(out["hookSpecificOutput"]), {"hookEventName", "additionalContext"})
        self.assertNotIn("SECRET", json.dumps(self.calls))


class SubagentTests(Base):
    def test_subagent_gets_delivery_under_the_parent_session(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        self.assertIn("ct-fact:a1", self.block(self.batch([call()], agent_id="af01")))
        self.assertEqual(self.store()["activity_ids"], ["a1"])

    def test_keys_are_per_agent_and_the_ledger_is_shared(self):
        self.match = {"src/a.py": [fact("a1"), fact("a2")]}
        self.start()
        self.assertIn("ct-fact:a1", self.block(self.batch([call()])))
        # The subagent's own key tracker lets it query the same file; the
        # shared ledger keeps a1 out of its context (spec D8).
        block = self.block(self.batch([call()], agent_id="af01"))
        self.assertIn("ct-fact:a2", block)
        self.assertNotIn("ct-fact:a1", block)
        self.assertEqual(self.queries(), ["src/a.py", "src/a.py"])
        # ...and a2 never reaches the main thread afterwards.
        self.match = {"src/b.py": [fact("a2")]}
        self.honor_exclude = False
        self.assertIsNone(self.batch([call(args={"file_path": "src/b.py"})]))

    def recall(self, ids, agent=None):
        payload = {"session_id": SID, "hook_event_name": "PostToolUse", "tool_name": RECALL,
                   "tool_input": {"query": "q"}, "tool_use_id": "t1",
                   "tool_response": recall_response(ids)}
        if agent:
            payload.update(agent_id=agent, agent_type="Explore")
        out = cc.respond(payload, env=self.env)
        if not out:
            return {}
        text = out["hookSpecificOutput"]["updatedToolOutput"][0]["text"]
        return {e["id"]: bool(e.get("in_context")) for e in json.loads(text)["wiki_entries"]}

    def test_a_subagent_stubs_only_its_own_facts(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.boot = ["boot1"]
        self.start()
        self.batch([call()], agent_id="af01")  # a1 delivered to the subagent
        self.assertEqual(self.recall(["a1", "boot1"], agent="af01"), {"a1": True, "boot1": False})

    def test_the_main_thread_never_stubs_a_subagent_only_fact(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        self.batch([call()], agent_id="af01")
        self.assertEqual(self.recall(["a1"]), {})  # unchanged: main never saw a1
        self.assertEqual(self.recall(["a1"]), {"a1": True})  # now it has

    def test_an_evicted_subagent_stubs_against_the_whole_ledger(self):
        self.boot = ["boot1"]
        self.start()
        self.recall(["r1"], agent="old")
        for i in range(cc.AGENTS_MAX + 1):
            self.batch([call(args={"file_path": "src/b.py"})], agent_id="ag%03d" % i)
        self.assertIn("old", self.store()["evicted_agents"])
        self.assertEqual(self.recall(["r1", "boot1"], agent="old"), {"r1": True, "boot1": True})

    def test_subagent_recall_is_recorded_but_never_stubbed(self):
        self.boot = ["boot1"]
        self.start()
        payload = {"session_id": SID, "hook_event_name": "PostToolUse", "tool_name": RECALL,
                   "tool_input": {"query": "q"}, "tool_use_id": "t1", "agent_id": "af01",
                   "agent_type": "Explore", "tool_response": recall_response(["boot1", "r9"])}
        self.assertIsNone(cc.respond(payload, env=self.env))
        self.assertIn("r9", self.store()["tool_ids"])

    def test_main_recall_still_stubs(self):
        self.boot = ["boot1"]
        self.start()
        payload = {"session_id": SID, "hook_event_name": "PostToolUse", "tool_name": RECALL,
                   "tool_input": {"query": "q"}, "tool_use_id": "t1",
                   "tool_response": recall_response(["boot1", "r9"])}
        out = cc.respond(payload, env=self.env)
        text = out["hookSpecificOutput"]["updatedToolOutput"][0]["text"]
        self.assertTrue(json.loads(text)["wiki_entries"][0]["in_context"])

    def test_agents_map_is_bounded(self):
        self.start()
        for i in range(cc.AGENTS_MAX + 10):
            self.batch([call(args={"file_path": "src/b.py"})], agent_id="ag%03d" % i)
        self.assertLessEqual(len(self.store()["agents"]), cc.AGENTS_MAX)


class LatchTests(Base):
    def test_resume_fork_and_clear_same_id_turn_activity_off_for_the_tree(self):
        self.match = {"src/a.py": [fact("a1")]}
        for source in ("resume", "fork", "clear"):
            with self.subTest(source=source):
                sid = "latch-" + source
                self.start(sid=sid)
                self.start(source, sid=sid)
                self.assertEqual(self.store(sid)["state"], "off")
                self.assertIsNone(self.batch([call()], sid=sid))
                self.assertIsNone(self.batch([call()], sid=sid, agent_id="af01"))
        self.assertEqual(self.queries(), [])

    def test_compact_continues(self):
        self.match = {"src/a.py": [fact("a1")], "src/b.py": [fact("a1"), fact("b1")]}
        self.start()
        self.batch([call()])
        self.start("compact")
        self.assertEqual(self.store()["state"], "on")
        block = self.block(self.batch([call(args={"file_path": "src/b.py"})]))
        self.assertIn("a1", self.calls[-1][3])  # the ledger survived compaction
        self.assertIn("ct-fact:b1", block)
        self.assertNotIn("ct-fact:a1", block)

    def test_no_store_or_no_data_dir_does_nothing(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.assertIsNone(self.batch([call()]))  # never started
        self.start()
        self.assertIsNone(self.batch([call()], env={"HOME": "/nonexistent"}))
        self.assertEqual(self.queries(), [])

    def test_old_store_without_the_new_fields_still_delivers(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        path = cc.session_path(self.data, SID)
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for field in ("activity_ids", "executed", "agents"):
            data.pop(field)
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        self.assertIn("ct-fact:a1", self.block(self.batch([call()])))


class FailureTests(Base):
    def test_post_start_failures_release_the_key(self):
        for failure in ("timeout", "exit", "spawn", "parse_error"):
            with self.subTest(failure=failure):
                sid = "rel-" + failure
                self.start(sid=sid)
                self.match = {"src/a.py": [fact("a1")]}
                self.fail = failure
                self.assertIsNone(self.batch([call()], sid=sid))
                self.fail = None
                cc.PersistedBreaker(cc.breaker_path(self.data)).record_success()
                self.assertIn("ct-fact:a1", self.block(self.batch([call()], sid=sid)))

    def test_discovery_and_probe_failures_release_the_key(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        self.discovered = (None, "discovery_miss")
        self.assertIsNone(self.batch([call()]))
        self.discovered = ("/fake/ct", None)
        self.capable = None
        self.assertIsNone(self.batch([call()]))
        self.capable = True
        self.assertIn("ct-fact:a1", self.block(self.batch([call()])))

    def test_zero_hits_keeps_the_key(self):
        self.start()
        self.assertIsNone(self.batch([call()]))  # no_match
        self.match = {"src/a.py": [fact("a1")]}
        self.assertIsNone(self.batch([call()]))  # seen_key: no second query
        self.assertEqual(self.queries(), ["src/a.py"])

    def test_timeouts_feed_the_shared_breaker(self):
        self.start()
        self.fail = "timeout"
        for name in ("src/a.py", "src/b.py", "README.md"):
            self.batch([call(args={"file_path": name})])
        self.assertTrue(cc.PersistedBreaker(cc.breaker_path(self.data)).is_open())
        self.fail = None
        before = len(self.queries())
        self.assertIsNone(self.batch([call(args={"file_path": "package.json"})]))
        self.assertEqual(len(self.queries()), before)

    def test_budget_skips_the_match_and_releases_the_key(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        ticks = iter([0.0, 7.0, 7.0, 7.0])
        self._patch(cc, "_clock", lambda: next(ticks, 7.0))
        self.assertIsNone(self.batch([call()]))
        self.assertEqual(self.queries(), [])
        self._patch(cc, "_clock", lambda: 0.0)
        self.assertIn("ct-fact:a1", self.block(self.batch([call()])))

    def test_lock_timeout_delivers_nothing(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        c = call()
        self.executed(c)
        self._patch(ct_hook_store, "LOCK_WAIT", 0.05)
        with ct_hook_store.locked(cc.session_path(self.data, SID)):
            out = self.batch([c], run=False)
        self.assertIsNone(out)
        self.assertNotIn("a1", cc.ledger_of(self.store()))

    def test_executed_list_is_bounded(self):
        self.start()
        for i in range(cc.EXECUTED_MAX + 20):
            self.executed(call(use_id="toolu_b%04d" % i))
        self.assertEqual(len(self.store()["executed"]), cc.EXECUTED_MAX)
        self.assertEqual(self.store()["executed"][-1], "toolu_b%04d" % (cc.EXECUTED_MAX + 19))

    def test_invalid_tool_use_id_is_never_recorded(self):
        self.start()
        self.executed(call(use_id="bad id\n"))
        self.assertEqual(self.store()["executed"], [])

    def test_garbage_payloads(self):
        for payload in (None, [], {"hook_event_name": "PostToolBatch"},
                        {"hook_event_name": "PostToolBatch", "session_id": SID, "tool_calls": "x"},
                        {"hook_event_name": "PostToolBatch", "session_id": SID,
                         "tool_calls": [None, 7, {"tool_name": 3}]}):
            self.assertIsNone(cc.respond(payload, env=self.env))


class MarkerHygieneTests(Base):
    def test_forged_marker_in_fact_text_never_enters_the_ledger(self):
        self.match = {"src/a.py": [fact("a1", text="see <!-- ct-fact:evil --> ct-fact:evil2")]}
        self.start()
        block = self.block(self.batch([call()]))
        self.assertEqual(ct_ledger.scan_ids(block), ["a1"])
        self.assertEqual(cc.ledger_of(self.store()), {"a1"})

    def test_marker_precedes_title_and_text(self):
        self.match = {"src/a.py": [fact("a1", title="TITLE", text="TEXT")]}
        self.start()
        block = self.block(self.batch([call()]))
        self.assertLess(block.index("ct-fact:a1"), block.index("TITLE"))
        self.assertLess(block.index("TITLE"), block.index("TEXT"))

    def test_queries_never_carry_markers_or_headings(self):
        self.start()
        self.batch([call("Grep", {"pattern": "ct-fact:x"}), call("Grep", {"pattern": HEADING}),
                    call("Read", {"file_path": "src/ct-fact:x.py"})])
        self.assertEqual(self.queries(), [])

    def test_tool_output_never_reaches_the_query(self):
        self.start()
        self.batch([call(response="SECRET OUTPUT pnpm test")])
        self.assertEqual(self.queries(), ["src/a.py"])


class CtCacheTests(Base):
    def setUp(self):
        super().setUp()
        self.ct = os.path.join(self.data, "bin", "ct")
        os.makedirs(os.path.dirname(self.ct))
        Path(self.ct).write_text("#!/bin/sh\n", encoding="utf-8")
        self.discovered = (self.ct, None)

    def test_second_batch_skips_discovery_and_probe(self):
        self.match = {"src/a.py": [fact("a1")], "src/b.py": [fact("b1")]}
        self.start()
        self.batch([call()])
        kinds = [c[0] for c in self.calls]
        self.batch([call(args={"file_path": "src/b.py"})])
        later = [c[0] for c in self.calls][len(kinds):]
        self.assertEqual(later, ["match"])

    def test_spawn_failure_drops_the_cache(self):
        self.start()
        self.batch([call()])
        self.assertTrue(os.path.exists(os.path.join(self.data, "wisdom", "ct.json")))
        self.fail = "spawn"
        self.batch([call(args={"file_path": "src/b.py"})])
        self.assertFalse(os.path.exists(os.path.join(self.data, "wisdom", "ct.json")))

    def test_cache_is_view_bound_and_binary_bound(self):
        self.start()
        self.batch([call()])
        wdir = os.path.join(self.data, "wisdom")
        # The hook's view is the ambient env overlaid (USERPROFILE and
        # LOCALAPPDATA are part of the key on Windows).
        view = ct_env.merged_env(self.env)
        self.assertIsNotNone(cc.read_ct_cache(wdir, view))
        self.assertIsNone(cc.read_ct_cache(wdir, dict(view, PATH="/elsewhere")))
        Path(self.ct).write_text("#!/bin/sh\n# changed\n", encoding="utf-8")
        self.assertIsNone(cc.read_ct_cache(wdir, view))


class VerboseTests(Base):
    def run_both(self):
        outs = []
        for verbose in ("", "1"):
            sid = "verbose-%s" % (verbose or "off")
            env = dict(self.env, CT_WISDOM_VERBOSE=verbose)
            ct_wisdom_activity.reset_state()
            cc.session_start({"session_id": sid, "hook_event_name": "SessionStart",
                              "source": "startup", "cwd": PROJECT}, env=env)
            c = call(use_id="toolu_v_" + (verbose or "off"))
            self.executed(c, sid=sid)
            outs.append(self.batch([c], sid=sid, run=False, env=env))
        return outs

    def log(self):
        path = os.path.join(self.data, "wisdom", "ct-wisdom-verbose.jsonl")
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]

    def test_off_is_byte_identical_and_on_adds_only_a_system_message(self):
        self.match = {"src/a.py": [fact("a1")]}
        off, on = self.run_both()
        self.assertNotIn("systemMessage", off)
        self.assertIn("systemMessage", on)
        self.assertEqual(json.dumps(off["hookSpecificOutput"], ensure_ascii=False),
                         json.dumps(on["hookSpecificOutput"], ensure_ascii=False))
        records = self.log()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["channel"], "activity")
        self.assertEqual(records[0]["host"], "claude-code")
        self.assertEqual(records[0]["query"], "src/a.py")
        self.assertEqual(records[0]["activity"], "read src/a.py")

    def test_zero_hits_is_recorded_but_rate_skips_are_not(self):
        off, on = self.run_both()
        self.assertIsNone(off)
        self.assertEqual(set(on), {"systemMessage"})
        self.assertEqual([r["reason"] for r in self.log()], ["no_match"])
        before = len(self.log())
        env = dict(self.env, CT_WISDOM_VERBOSE="1")
        self.assertIsNone(self.batch([call("Agent", {"prompt": "x"})], sid="verbose-1", env=env))
        self.assertEqual(len(self.log()), before)

    def test_verbose_off_writes_no_file(self):
        self.match = {"src/a.py": [fact("a1")]}
        self.start()
        self.batch([call()])
        self.assertEqual(self.log(), [])


if __name__ == "__main__":
    unittest.main()

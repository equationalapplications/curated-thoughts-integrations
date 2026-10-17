#!/usr/bin/env python3
"""Exactly-once property test across randomized sessions (INTENT workflow 5).

Run: python3 -m unittest tests.test_exactly_once -v
"""

from __future__ import annotations

import json
import os
import random
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zlib
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_tool_dedup  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_activity  # noqa: E402
import ct_wisdom_activity_delivery as dlv  # noqa: E402
import ct_wisdom_live  # noqa: E402

UNIVERSE = ["fact_%02d" % i for i in range(16)]
TOOL = "mcp__curated-thoughts__curated_recall_context"
SESSIONS = 200


def item(fid, supersedes=None):
    return {"id": fid, "title": "T" + fid, "text": "body " + fid,
            "supersedes": supersedes or [], "provenance": None}


def present_counts(system_block, history):
    counts = Counter()
    for fid in ct_ledger.scan_ids(system_block):
        counts[fid] += system_block.count(ct_ledger.marker(fid) + "\n")
    for msg in history:
        if msg["role"] == "user":
            text = msg.get("api_content") or msg["content"]
            for fid in UNIVERSE:
                # title-line marker is followed by " (provenance:" in live blocks
                counts[fid] += text.count(ct_ledger.marker(fid) + " (provenance:")
        elif msg["role"] == "tool":
            outer = json.loads(msg["content"])
            inner = json.loads(outer["result"].split("\n<!-- ct-fact:")[0])
            for entry in inner["wiki_entries"]:
                if not entry.get("in_context"):
                    counts[entry["id"]] += 1
    return counts


class TestExactlyOnce(unittest.TestCase):
    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        ct_wisdom_live.reset_session_state()
        ct_ledger.LEDGER_CACHE.clear()
        orig_breaker = ct_wisdom_live._BREAKER
        ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker(fails=10 ** 9)
        self.addCleanup(setattr, ct_wisdom_live, "_BREAKER", orig_breaker)
        for mod, name, value in [
            (ct_wisdom, "discover_ct", lambda env=None: ("/fake/ct", None)),
            (ct_wisdom_live, "has_match_capability", lambda p: True),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        self.addCleanup(ct_wisdom_live.reset_session_state)

    def test_no_fact_twice_in_current_context(self):
        rng = random.Random(20261006)
        orig_recall = ct_wisdom.recall_wiki
        orig_match = ct_wisdom_live.match_wisdom
        self.addCleanup(setattr, ct_wisdom, "recall_wiki", orig_recall)
        self.addCleanup(setattr, ct_wisdom_live, "match_wisdom", orig_match)

        def fake_match(path, text, max_n, exclude):
            pool = UNIVERSE if rng.random() < 0.5 else [f for f in UNIVERSE if f not in exclude]
            entries = [item(f) for f in rng.sample(pool, min(len(pool), max_n))]
            corrections = []
            if exclude and rng.random() < 0.3:
                corrections.append(item(rng.choice(UNIVERSE), supersedes=[rng.choice(exclude)]))
            return {"entries": entries, "corrections": corrections}, None

        ct_wisdom_live.match_wisdom = fake_match

        for s in range(SESSIONS):
            sid = "prop-%d" % s
            boot = rng.sample(UNIVERSE, rng.randint(0, 3))
            ct_wisdom.recall_wiki = lambda p, q, b=boot: (
                [("T" + f, "body " + f, f) for f in b], None)
            system_block = ct_wisdom._render_wisdom({"session_id": sid})
            history = []
            for turn in range(rng.randint(1, 12)):
                if history and rng.random() < 0.15:  # in-place compaction at turn start
                    del history[: rng.randint(1, len(history))]
                out = ct_wisdom_live.on_pre_llm_call(
                    session_id=sid, user_message="question %d" % turn,
                    conversation_history=list(history), is_first_turn=(turn == 0),
                )
                content = "question %d" % turn
                msg = {"role": "user", "content": content}
                if out:
                    msg["api_content"] = content + "\n\n" + out["context"]
                history.append(msg)
                history.append({"role": "assistant", "content": "ok"})
                for _ in range(rng.randint(0, 2)):
                    ids = rng.sample(UNIVERSE, rng.randint(0, 4))
                    raw = json.dumps({"result": json.dumps({
                        "wiki_entries": [{"id": f, "title": "T" + f, "text": "body " + f} for f in ids],
                        "code_chunks": [], "query": "q"})})
                    new = ct_tool_dedup.on_transform_tool_result(
                        tool_name=TOOL, result=raw, session_id=sid)
                    history.append({"role": "tool", "content": new or raw})
                    counts = present_counts(system_block, history)
                    dupes = {f: n for f, n in counts.items() if n > 1}
                    self.assertEqual(dupes, {}, "session %s turn %d" % (sid, turn))
                counts = present_counts(system_block, history)
                dupes = {f: n for f, n in counts.items() if n > 1}
                self.assertEqual(dupes, {}, "session %s turn %d" % (sid, turn))


def activity_counts(text):
    """Facts visible in one tool message's activity block (JSON key or text)."""
    counts = Counter()
    blocks = []
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        if ct_wisdom_activity.ACTIVITY_RESULT_KEY in data:
            blocks.append(data[ct_wisdom_activity.ACTIVITY_RESULT_KEY])
    elif ct_wisdom_activity.ACTIVITY_HEADING in text:
        blocks.append(text[text.index(ct_wisdom_activity.ACTIVITY_HEADING):])
    for block in blocks:
        for fid in UNIVERSE:
            counts[fid] += block.count(ct_ledger.marker(fid) + " **")
    return counts, len(blocks)


def visible_counts(system_block, history):
    counts = Counter()
    for fid in ct_ledger.scan_ids(system_block):
        counts[fid] += system_block.count(ct_ledger.marker(fid) + "\n")
    for msg in history:
        if msg["role"] == "user":
            text = msg.get("api_content") or msg["content"]
            for fid in UNIVERSE:
                counts[fid] += text.count(ct_ledger.marker(fid) + " (provenance:")
        elif msg["role"] == "tool" and msg.get("kind") == "recall":
            outer = json.loads(msg["content"])
            inner = json.loads(outer["result"].split("\n<!-- ct-fact:")[0])
            for entry in inner["wiki_entries"]:
                if not entry.get("in_context"):
                    counts[entry["id"]] += 1
        elif msg["role"] == "tool":
            counts.update(activity_counts(msg["content"])[0])
    return counts


class TestExactlyOnceWithActivity(unittest.TestCase):
    """INTENT rule 1 across user-turn deliveries, activity deliveries from
    parallel tool batches on real threads, agent CT recalls, compaction and
    restore (spec 2026-10-16-hermes-autonomous-work-wisdom-design.md)."""

    SESSIONS = 120

    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        ct_wisdom_live.reset_session_state()
        dlv.reset_state()
        ct_ledger.LEDGER_CACHE.clear()
        orig_breaker = ct_wisdom_live._BREAKER
        ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker(fails=10 ** 9)
        self.addCleanup(setattr, ct_wisdom_live, "_BREAKER", orig_breaker)
        for mod, name, value in [
            (ct_wisdom, "discover_ct", lambda env=None: ("/fake/ct", None)),
            (ct_wisdom_live, "has_match_capability", lambda p: True),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        self.addCleanup(ct_wisdom_live.reset_session_state)
        self.addCleanup(dlv.reset_state)
        # Activity paths are sent only inside a project root (Privacy
        # amendment 4): the session cwd is a temp project.
        proj = os.path.realpath(tempfile.mkdtemp(prefix="ct-exactly-once-"))
        os.mkdir(os.path.join(proj, ".git"))
        self.addCleanup(shutil.rmtree, proj, True)
        env_patch = mock.patch.dict(os.environ, {"TERMINAL_CWD": proj})
        env_patch.start()
        self.addCleanup(env_patch.stop)
        # The process identity (pwd, expanduser) is a fixed fake, so results
        # never depend on the machine's user.
        identity = mock.patch.object(ct_wisdom_activity, "_system_identity",
                                     lambda: (["tester"], [], []))
        identity.start()
        self.addCleanup(identity.stop)

    def test_no_fact_twice_with_activity(self):
        rng = random.Random(20261016)
        restored = set()
        for mod, name in [(ct_wisdom, "recall_wiki"), (ct_wisdom_live, "match_wisdom"),
                          (ct_wisdom, "bootstrap_block")]:
            self.addCleanup(setattr, mod, name, getattr(mod, name))
        orig_bootstrap = ct_wisdom.bootstrap_block
        ct_wisdom.bootstrap_block = lambda sid: None if sid in restored else orig_bootstrap(sid)

        def fake_match(path, text, max_n, exclude):
            # Thread-safe, reproducible per call; ignores exclude half the time.
            r = random.Random(zlib.crc32(("%s|%d" % (text, len(exclude))).encode()))
            pool = UNIVERSE if r.random() < 0.5 else [f for f in UNIVERSE if f not in exclude]
            entries = [item(f) for f in r.sample(pool, min(len(pool), max_n))]
            corrections = []
            if exclude and r.random() < 0.3:
                corrections.append(item(r.choice(UNIVERSE), supersedes=[r.choice(exclude)]))
            return {"entries": entries, "corrections": corrections}, None

        ct_wisdom_live.match_wisdom = fake_match
        paths = ["src/m%d.py" % i for i in range(10)]
        commands = ["pytest tests/t%d" % i for i in range(4)] + ["npm test", "make build"]
        activity_blocks = 0

        def tool_call(sid, req, n, kind, out):
            call = "%s-%s-%d" % (sid, req, n)
            if kind == "recall":
                ids = rng_local[n]
                raw = json.dumps({"result": json.dumps({
                    "wiki_entries": [{"id": f, "title": "T" + f, "text": "body " + f} for f in ids],
                    "code_chunks": [], "query": "q"})})
                name, args = TOOL, {"query": "q"}
            elif kind == "terminal":
                raw, name, args = "ok\n", "terminal", {"command": rng_local[n]}
            else:
                raw = json.dumps({"content": "1|x", "total_lines": 1})
                name, args = "read_file", {"path": rng_local[n]}
            kw = dict(tool_name=name, args=args, session_id=sid, tool_call_id=call,
                      turn_id="t", api_request_id=req, task_id="")
            new = ct_tool_dedup.on_transform_tool_result(result=raw, **kw)
            if new is None:
                new = dlv.on_transform_tool_result(result=raw, **kw)
            out[n] = {"role": "tool", "content": new or raw,
                      "kind": "recall" if kind == "recall" else "work"}

        for s in range(self.SESSIONS):
            sid = "act-%d" % s
            boot = rng.sample(UNIVERSE, rng.randint(0, 3))
            ct_wisdom.recall_wiki = lambda p, q, b=boot: (
                [("T" + f, "body " + f, f) for f in b], None)
            system_block = ct_wisdom._render_wisdom({"session_id": sid})
            history = []
            for turn in range(rng.randint(1, 6)):
                if history and rng.random() < 0.15:
                    del history[: rng.randint(1, len(history))]
                if turn and sid not in restored and rng.random() < 0.08:
                    restored.add(sid)  # /resume in a new process: in-turn state gone
                    ct_ledger.LEDGER_CACHE.clear()
                    ct_wisdom_live.reset_session_state()
                    dlv.reset_state()
                out = ct_wisdom_live.on_pre_llm_call(
                    session_id=sid, user_message="question %d" % turn,
                    conversation_history=list(history), is_first_turn=(turn == 0))
                msg = {"role": "user", "content": "question %d" % turn}
                if out:
                    msg["api_content"] = msg["content"] + "\n\n" + out["context"]
                history.append(msg)
                for step in range(rng.randint(1, 4)):
                    req = "t%d:api:%d" % (turn, step + 1)
                    n_calls = rng.randint(1, 5)
                    kinds = [rng.choice(["read", "read", "terminal", "recall"])
                             for _ in range(n_calls)]
                    if sid in restored:  # recall dedup without a ledger is out of scope
                        kinds = [k if k != "recall" else "read" for k in kinds]
                    rng_local = [
                        rng.sample(UNIVERSE, rng.randint(0, 4)) if k == "recall"
                        else rng.choice(commands) if k == "terminal" else rng.choice(paths)
                        for k in kinds]
                    results = [None] * n_calls
                    threads = [threading.Thread(target=tool_call,
                                                args=(sid, req, n, kinds[n], results))
                               for n in range(n_calls)]
                    for t in threads:
                        t.start()
                    for t in threads:
                        t.join()
                    history.append({"role": "assistant", "content": "calling tools"})
                    history.extend(results)
                    blocks_this_step = sum(activity_counts(m["content"])[1]
                                           for m in results if m["kind"] == "work")
                    self.assertLessEqual(blocks_this_step, 1, "%s %s" % (sid, req))
                    if sid in restored:
                        self.assertEqual(blocks_this_step, 0, "restored session %s" % sid)
                    activity_blocks += blocks_this_step
                    counts = visible_counts(system_block, history)
                    dupes = {f: n for f, n in counts.items() if n > 1}
                    self.assertEqual(dupes, {}, "session %s turn %d step %d" % (sid, turn, step))
                history.append({"role": "assistant", "content": "done"})
        self.assertGreater(activity_blocks, 50)  # the property was actually exercised


if __name__ == "__main__":
    unittest.main()
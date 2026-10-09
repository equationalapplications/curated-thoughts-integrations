#!/usr/bin/env python3
"""Exactly-once property test across randomized sessions (INTENT workflow 5).

Run: python3 -m unittest tests.test_exactly_once -v
"""

from __future__ import annotations

import json
import random
import sys
import unittest
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_tool_dedup  # noqa: E402
import ct_wisdom  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
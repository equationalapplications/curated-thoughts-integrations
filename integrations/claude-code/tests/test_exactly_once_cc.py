#!/usr/bin/env python3
"""Exactly-once property test for the Claude Code adapter (AC 2).

Port of integrations/hermes/tests/test_exactly_once.py to Claude Code's
channels and lifecycle (spec 2026-10-16-claude-code-wisdom-parity-leg-design.md,
D7–D9). A model of "what the model can see" is driven through the real adapter
entry points over randomized sessions:

  * SessionStart(startup)  bootstrap block appended
  * UserPromptSubmit       live block appended (additionalContext)
  * PostToolUse            recall result appended, stubbed when rewritten
  * /compact               live context dropped (the summary carries no
                           markers), SessionStart(compact) output appended
  * /clear                 context wiped; new session id (observed host
                           behavior, F12) OR a retained id (forced — the
                           fail-closed branch) ⇒ OFF
  * --resume               context replayed as is, SessionStart(resume)
                           output appended ⇒ OFF for life

Property: while a session is ON no fact id is visible twice. Once a session is
OFF, live delivery never runs again and our own emissions (bootstrap + live)
never repeat a fact. Unstubbed agent-initiated tool results in an OFF session
are out of scope by design (D9, Hermes parity: restored sessions never stub).

Run: python3 -m unittest tests.test_exactly_once_cc -v
"""

from __future__ import annotations

import json
import random
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "hooks"))

import ct_wisdom_cc as cc  # noqa: E402
import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_live  # noqa: E402

UNIVERSE = ["fact_%02d" % i for i in range(16)]
TOOL = "mcp__curated-thoughts__curated_recall_context"
SESSIONS = 200


def item(fid, supersedes=None):
    return {"id": fid, "title": "T" + fid, "text": "body " + fid,
            "supersedes": supersedes or [], "provenance": None}


def visible_counts(context, ours_only=False):
    counts = Counter()
    for kind, payload in context:
        if kind in ("boot", "live"):
            for fid in UNIVERSE:
                counts[fid] += payload.count(ct_ledger.marker(fid))
        elif kind == "tool" and not ours_only:
            for block in payload:
                inner = json.loads(block["text"])
                for entry in inner["wiki_entries"]:
                    if not entry.get("in_context"):
                        counts[entry["id"]] += 1
    return counts


class TestExactlyOnceClaudeCode(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.env = {"CLAUDE_PLUGIN_DATA": tmp.name}
        self.rng = random.Random(20261016)
        self.boot = []
        self.match_calls_while_off = 0
        self.off = False
        for mod, name, value in [
            (ct_wisdom, "discover_ct", lambda env=None: ("/fake/ct", None)),
            (ct_wisdom_live, "has_match_capability", lambda p: True),
            (ct_wisdom_live, "match_wisdom", self.fake_match),
            (ct_wisdom, "recall_wiki", lambda p, q: ([("T" + f, "body " + f, f) for f in self.boot], None)),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)

    def fake_match(self, path, text, max_n, exclude):
        if self.off:
            self.match_calls_while_off += 1
        rng = self.rng
        pool = UNIVERSE if rng.random() < 0.5 else [f for f in UNIVERSE if f not in exclude]
        entries = [item(f) for f in rng.sample(pool, min(len(pool), max_n))]
        corrections = []
        if exclude and rng.random() < 0.3:
            corrections.append(item(rng.choice(UNIVERSE), supersedes=[rng.choice(exclude)]))
        return {"entries": entries, "corrections": corrections}, None

    def session_start(self, sid, source):
        return cc.session_start({"session_id": sid, "hook_event_name": "SessionStart",
                                 "source": source, "cwd": "/tmp/p"}, env=self.env)

    def check(self, context, where):
        counts = visible_counts(context, ours_only=self.off)
        dupes = {f: n for f, n in counts.items() if n > 1}
        self.assertEqual(dupes, {}, where)

    def test_no_fact_twice_in_the_live_context(self):
        rng = self.rng
        seen_events = Counter()
        for s in range(SESSIONS):
            sid = "prop-%d" % s
            self.off = False
            self.boot = rng.sample(UNIVERSE, rng.randint(0, 3))
            context = []
            block = self.session_start(sid, "startup")
            if block:
                context.append(("boot", block))
            for step in range(rng.randint(1, 14)):
                where = "session %s step %d" % (sid, step)
                roll = rng.random()
                if roll < 0.08:  # /compact
                    seen_events["compact"] += 1
                    context = []
                    replay = self.session_start(sid, "compact")
                    if replay:
                        context.append(("boot", replay))
                    self.check(context, where + " after compact")
                    continue
                if roll < 0.14:  # /clear
                    context = []
                    self.boot = rng.sample(UNIVERSE, rng.randint(0, 3))
                    if rng.random() < 0.5:  # observed host: new id => fresh session
                        seen_events["clear_new_id"] += 1
                        sid = sid + "-c%d" % step
                        self.off = False
                    else:  # retained id => OFF for life
                        seen_events["clear_same_id"] += 1
                        self.off = True
                    block = self.session_start(sid, "clear")
                    if block:
                        context.append(("boot", block))
                    self.check(context, where + " after clear")
                    continue
                if roll < 0.20:  # --resume: the transcript replays as is
                    seen_events["resume"] += 1
                    self.off = True
                    extra = self.session_start(sid, "resume")
                    if extra:
                        context.append(("boot", extra))
                    self.check(context, where + " after resume")
                    continue

                seen_events["turn"] += 1
                out = cc.user_prompt_submit(
                    {"session_id": sid, "prompt_id": "%s-%d" % (sid, step),
                     "hook_event_name": "UserPromptSubmit", "prompt": "question %d" % step},
                    env=self.env)
                if self.off:
                    self.assertIsNone(out, where + ": delivery after OFF")
                elif out:
                    context.append(("live", out["hookSpecificOutput"]["additionalContext"]))
                self.check(context, where + " after turn")
                for _ in range(rng.randint(0, 2)):
                    ids = rng.sample(UNIVERSE, rng.randint(0, 4))
                    blocks = [{"type": "text", "text": json.dumps({
                        "wiki_entries": [{"id": f, "title": "T" + f, "text": "body " + f} for f in ids],
                        "code_chunks": [], "query": "q"})}]
                    res = cc.post_tool_use({"session_id": sid, "hook_event_name": "PostToolUse",
                                            "tool_name": TOOL, "tool_response": blocks}, env=self.env)
                    shown = res["hookSpecificOutput"]["updatedToolOutput"] if res else blocks
                    if res:
                        seen_events["stub"] += 1
                    context.append(("tool", shown))
                    self.check(context, where + " after tool")
        self.assertEqual(self.match_calls_while_off, 0, "ct was consulted for an OFF session")
        # The randomization must actually exercise every lifecycle path.
        for event in ("compact", "clear_new_id", "clear_same_id", "resume", "turn", "stub"):
            self.assertGreater(seen_events[event], 10, event)


if __name__ == "__main__":
    unittest.main()

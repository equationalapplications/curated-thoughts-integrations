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
import os
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
import ct_wisdom_activity  # noqa: E402
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
        if kind in ("boot", "live", "act"):
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


class TestExactlyOnceWithActivity(TestExactlyOnceClaudeCode):
    """Spec 2026-10-17 (autonomous work): activity batches on the main thread
    and in subagents (executed and denied calls) interleaved with user turns,
    recalls (main: stubbed; subagent: recorded, never stubbed), /compact,
    --resume and both /clear branches. Each subagent has its own context; the
    session tree shares one ledger, so no fact is visible twice in any one
    context and no fact WE emit appears in two contexts of a tree."""

    FILES = ["src/m%d.py" % i for i in range(6)]
    COMMANDS = ["pnpm test", "git status", "npm run build", "make lint"]

    def setUp(self):
        super().setUp()
        project = tempfile.TemporaryDirectory()
        self.addCleanup(project.cleanup)
        self.project = project.name
        os.makedirs(os.path.join(self.project, ".git"))
        for rel in self.FILES:
            os.makedirs(os.path.dirname(os.path.join(self.project, rel)), exist_ok=True)
            open(os.path.join(self.project, rel), "a").close()
        self.env = dict(self.env, HOME=os.path.join(self.project, ".nohome"), USER="tester")
        self.uid = 0

    def call(self, rng):
        self.uid += 1
        use_id = "toolu_%06d" % self.uid
        if rng.random() < 0.6:
            tool = rng.choice(["Read", "Edit", "Write"])
            return {"tool_name": tool, "tool_input": {"file_path": rng.choice(self.FILES)},
                    "tool_use_id": use_id, "tool_response": "ok"}
        return {"tool_name": "Bash", "tool_input": {"command": rng.choice(self.COMMANDS)},
                "tool_use_id": use_id, "tool_response": "ok"}

    def recall(self, rng, sid, agent):
        ids = rng.sample(UNIVERSE, rng.randint(0, 4))
        blocks = [{"type": "text", "text": json.dumps({
            "wiki_entries": [{"id": f, "title": "T" + f, "text": "body " + f} for f in ids],
            "code_chunks": [], "query": "q"})}]
        payload = {"session_id": sid, "hook_event_name": "PostToolUse", "tool_name": TOOL,
                   "tool_response": blocks, "tool_use_id": "toolu_r%06d" % self.uid}
        if agent:
            payload.update(agent_id=agent, agent_type="general-purpose")
        res = cc.handle(payload, env=self.env)
        return res["hookSpecificOutput"]["updatedToolOutput"] if res else blocks

    def batch(self, rng, sid, agent):
        calls = [self.call(rng) for _ in range(rng.randint(1, 3))]
        for c in calls:
            if rng.random() < 0.8:  # executed; the rest were denied (spec D3)
                payload = {"session_id": sid, "hook_event_name": "PostToolUse", "cwd": self.project,
                           "tool_name": c["tool_name"], "tool_input": c["tool_input"],
                           "tool_use_id": c["tool_use_id"], "tool_response": {}}
                if agent:
                    payload["agent_id"] = agent
                cc.handle(payload, env=self.env)
        payload = {"session_id": sid, "hook_event_name": "PostToolBatch", "cwd": self.project,
                   "tool_calls": calls}
        if agent:
            payload.update(agent_id=agent, agent_type="general-purpose")
        out = cc.handle(payload, env=self.env)
        return out["hookSpecificOutput"]["additionalContext"] if out else None

    def check_tree(self, main, subs, where):
        for name, context in [("main", main)] + sorted(subs.items()):
            self.check(context, "%s [%s]" % (where, name))
        if self.off:
            return
        owner = {}
        for name, context in [("main", main)] + sorted(subs.items()):
            for kind, payload in context:
                if kind not in ("live", "act"):
                    continue
                # Delivered facts carry the full marker; a correction's
                # "supersedes ct-fact:<old>" reference is not a delivery.
                for fid in [f for f in UNIVERSE if ct_ledger.marker(f) in payload]:
                    self.assertNotIn(fid, owner, "%s: %s in %s and %s" % (
                        where, fid, owner.get(fid), name))
                    owner[fid] = name

    def test_no_fact_twice_with_activity(self):
        ct_wisdom_activity.reset_caches()
        rng = self.rng
        seen = Counter()
        for s in range(SESSIONS):
            sid = "act-%d" % s
            self.off = False
            self.boot = rng.sample(UNIVERSE, rng.randint(0, 3))
            main, subs = [], {}
            block = self.session_start(sid, "startup")
            if block:
                main.append(("boot", block))
            for step in range(rng.randint(2, 18)):
                where = "session %s step %d" % (sid, step)
                roll = rng.random()
                if roll < 0.06:
                    seen["compact"] += 1
                    main = []
                    replay = self.session_start(sid, "compact")
                    if replay:
                        main.append(("boot", replay))
                elif roll < 0.10:
                    main, subs = [], {}
                    self.boot = rng.sample(UNIVERSE, rng.randint(0, 3))
                    if rng.random() < 0.5:
                        seen["clear_new_id"] += 1
                        sid = sid + "-c%d" % step
                        self.off = False
                    else:
                        seen["clear_same_id"] += 1
                        self.off = True
                    block = self.session_start(sid, "clear")
                    if block:
                        main.append(("boot", block))
                elif roll < 0.14:
                    seen["resume"] += 1
                    self.off = True
                    subs = {}
                    extra = self.session_start(sid, "resume")
                    if extra:
                        main.append(("boot", extra))
                elif roll < 0.30:
                    seen["turn"] += 1
                    out = cc.user_prompt_submit(
                        {"session_id": sid, "prompt_id": "%s-%d" % (sid, step),
                         "hook_event_name": "UserPromptSubmit", "prompt": "q %d" % step},
                        env=self.env)
                    if self.off:
                        self.assertIsNone(out, where)
                    elif out:
                        main.append(("live", out["hookSpecificOutput"]["additionalContext"]))
                elif roll < 0.42:
                    agent = None
                    if subs and rng.random() < 0.5:
                        agent = rng.choice(sorted(subs))
                    seen["recall_sub" if agent else "recall_main"] += 1
                    shown = self.recall(rng, sid, agent)
                    (subs[agent] if agent else main).append(("tool", shown))
                else:
                    agent = None
                    if rng.random() < 0.4:
                        agent = rng.choice(sorted(subs)) if subs and rng.random() < 0.6 \
                            else "ag%04d" % len(subs)
                        subs.setdefault(agent, [])
                    block = self.batch(rng, sid, agent)
                    if block:
                        self.assertFalse(self.off, where + ": activity after OFF")
                        seen["act_sub" if agent else "act_main"] += 1
                        (subs[agent] if agent else main).append(("act", block))
                self.check_tree(main, subs, where)
        self.assertEqual(self.match_calls_while_off, 0, "ct was consulted for an OFF session")
        for event in ("compact", "clear_new_id", "clear_same_id", "resume", "turn",
                      "recall_main", "recall_sub", "act_main", "act_sub"):
            self.assertGreater(seen[event], 10, event)


if __name__ == "__main__":
    unittest.main()

"""Exactly-once, randomized (CONTRIBUTING "Test the rules"; spec
"Exactly-once argument").

A simulated Docker Agent host drives the real adapter: user turns
(user_prompt_submit), model steps (before_llm_call, whose output is the
request the model sees), parallel tool batches on real threads
(tool_response_transform: file reads, shell, agent CT recalls), resumes (a
fresh process: module caches reset, the store kept) and branches (a new
session id with cloned history). CT is scripted and often ignores
--exclude, so the adapter's own post-filter is exercised.

Property: in every request, no fact id is visible twice (a `ct-fact` marker,
or a non-stub entry of a recall result).
"""

from __future__ import annotations

import json
import random
import re
import threading
import unittest

from _support import BASE_MESSAGES, PROJECT, Env, FakeCT, fact, patched

import ct_wisdom
import ct_wisdom_da as da
import ct_wisdom_live

MARKER_RE = re.compile(r"<!-- ct-fact:([A-Za-z0-9._:-]{1,128}) -->")
UNIVERSE = ["f%02d" % i for i in range(14)]
PATHS = ["src/a.py", "src/b.py", "README.md", "docs/x.md", "Makefile"]
COMMANDS = ["pnpm test", "make build", "git status", "pytest tests"]


def visible_ids(messages):
    out = []
    for msg in messages:
        content = msg.get("content") or ""
        out += MARKER_RE.findall(content)
        if msg.get("role") == "tool" and msg.get("_recall"):
            try:
                data = json.loads(content)
            except ValueError:
                continue
            for entry in data.get("wiki_entries", []):
                if isinstance(entry, dict) and not entry.get("in_context"):
                    out.append(entry.get("id"))
    return out


class Host:
    def __init__(self, test, env, rng):
        self.t, self.env, self.rng = test, env, rng

    def request(self, sid, history, iteration):
        out = da.handle({"hook_event_name": "before_llm_call", "session_id": sid,
                         "cwd": PROJECT, "iteration": iteration,
                         "messages": history}, self.env)
        msgs = out["hook_specific_output"]["updated_messages"] if out else history
        ids = visible_ids(msgs)
        dupes = {i for i in ids if ids.count(i) > 1}
        self.t.assertFalse(dupes, "fact visible twice in %s: %s" % (sid, sorted(dupes)))
        return msgs

    def tool_call(self, sid, i):
        kind = self.rng.random()
        if kind < 0.45:
            name, args, cat, resp = "read_file", {"path": self.rng.choice(PATHS)}, "filesystem", "text\n"
        elif kind < 0.7:
            name, args, cat, resp = "shell", {"cmd": self.rng.choice(COMMANDS)}, "shell", "ok"
        elif kind < 0.85:
            ids = self.rng.sample(UNIVERSE, 3)
            resp = json.dumps({"wiki_entries": [{"id": x, "title": x, "text": "t"} for x in ids]})
            name, args, cat = "curated_recall_context", {"query": "q"}, "mcp"
        else:
            name, args, cat, resp = "write_file", {"path": self.rng.choice(PATHS), "content": "c"}, \
                "filesystem", '{"bytes_written": 1}'
        return {"hook_event_name": "tool_response_transform", "session_id": sid,
                "cwd": PROJECT, "tool_name": name, "tool_use_id": "c%d-%d" % (i, self.rng.getrandbits(48)),
                "tool_input": args, "tool_category": cat, "tool_response": resp}

    def batch(self, sid, n):
        payloads = [self.tool_call(sid, i) for i in range(n)]
        results = [None] * n

        def run(i):
            results[i] = da.handle(payloads[i], self.env)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        msgs = [{"role": "assistant", "content": "", "tool_calls": [{"id": p["tool_use_id"]} for p in payloads]}]
        for p, out in zip(payloads, results):
            content = out["hook_specific_output"]["updated_tool_response"] if out else p["tool_response"]
            msg = {"role": "tool", "tool_call_id": p["tool_use_id"], "content": content}
            if p["tool_name"] == "curated_recall_context":
                msg["_recall"] = True
            msgs.append(msg)
        return msgs


def fresh_process():
    ct_wisdom.reset_discovery_cache()
    ct_wisdom_live.reset_capability_cache()


class ExactlyOnceTests(unittest.TestCase):
    SESSIONS = 40

    def test_randomized_sessions(self):
        for seed in range(self.SESSIONS):
            with self.subTest(seed=seed):
                self.run_session(seed)

    def run_session(self, seed):
        rng = random.Random(seed)
        e = Env()
        try:
            def match(query):
                return [fact(x) for x in rng.sample(UNIVERSE, rng.randint(0, 3))]

            fake = FakeCT(recall=[fact(x) for x in rng.sample(UNIVERSE, 3)], match=match,
                          honor_exclude=rng.random() < 0.5)
            host = Host(self, e.env, rng)
            sessions = {"s%d" % seed: [dict(m) for m in BASE_MESSAGES]}
            with patched(fake):
                for turn in range(rng.randint(2, 6)):
                    sid = rng.choice(sorted(sessions))
                    history = sessions[sid]
                    event = rng.random()
                    if event < 0.15:
                        fresh_process()  # resume: same id, same history, new process
                    elif event < 0.3 and len(history) > 2:
                        cut = rng.randint(2, len(history))
                        new = "b%d-%d" % (seed, turn)
                        sessions[new] = [dict(m) for m in history[:cut]]
                        sid, history = new, sessions[new]
                    da.handle({"hook_event_name": "user_prompt_submit", "session_id": sid,
                               "prompt": "question %d" % turn}, e.env)
                    history.append({"role": "user", "content": "question %d" % turn})
                    for step in range(1, rng.randint(1, 5) + 1):
                        host.request(sid, history, step)
                        if rng.random() < 0.8:
                            history.extend(host.batch(sid, rng.randint(1, 4)))
                    final = host.request(sid, history, 99)
                    history.append({"role": "assistant", "content": "answer"})
                    self.assertTrue(final)
        finally:
            e.cleanup()


if __name__ == "__main__":
    unittest.main()

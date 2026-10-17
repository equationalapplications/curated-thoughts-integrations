"""Shared test support: import paths, a fake `ct`, payload builders.

The fake replaces the four CT entry points the adapter reaches through the
vendored modules (discovery, capability probe, recall, match), so no `ct`
binary, brain or network is touched. Stdlib only.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import sys
import tempfile
from pathlib import Path

TESTS = Path(__file__).resolve().parent
INTEGRATION = TESTS.parent
HOOKS = INTEGRATION / "hooks"
SCRIPTS = INTEGRATION / "scripts"
for _p in (str(SCRIPTS), str(HOOKS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ct_wisdom  # noqa: E402
import ct_wisdom_da  # noqa: E402
import ct_wisdom_live  # noqa: E402


def fact(fid, title=None, text=None, provenance="stated", supersedes=None, score=0.8):
    return {"id": fid, "title": title or ("Title " + fid), "text": text or ("Text of " + fid),
            "provenance": provenance, "supersedes": list(supersedes or []), "score": score}


class FakeCT:
    """Scripted CT. `match` maps a query to a list of facts (or a callable
    query -> facts); `recall` is the bootstrap's wiki entries."""

    PATH = "/fake/bin/ct"

    def __init__(self, recall=(), match=None, corrections=None, fail=None,
                 discover=True, capable=True, honor_exclude=True):
        self.recall = list(recall)
        self.match = match if match is not None else {}
        self.corrections = corrections or {}
        self.fail = fail          # failure class returned by match, or None
        self.discover = discover
        self.capable = capable
        self.honor_exclude = honor_exclude
        self.calls = []           # (kind, query, max_n, exclude)

    def discover_ct(self, env=None):
        self.calls.append(("discover", None, None, None))
        return (self.PATH, None) if self.discover else (None, None)

    def has_match_capability(self, path):
        self.calls.append(("probe", None, None, None))
        return self.capable

    def recall_wiki(self, path, query):
        self.calls.append(("recall", query, None, None))
        return [(f["title"], f["text"], f["id"]) for f in self.recall], None

    def match_wisdom(self, path, text, max_n, exclude):
        self.calls.append(("match", text, max_n, list(exclude)))
        if self.fail:
            return None, self.fail
        facts = self.match(text) if callable(self.match) else self.match.get(text, [])
        if self.honor_exclude:
            facts = [f for f in facts if f["id"] not in exclude]
        corr = self.corrections.get(text, []) if isinstance(self.corrections, dict) else []
        return {"entries": [dict(f) for f in facts][:max_n],
                "corrections": [dict(c) for c in corr], "gate": "semantic-v1:test"}, None

    def queries(self, kind="match"):
        return [c[1] for c in self.calls if c[0] == kind]


@contextlib.contextmanager
def patched(fake):
    saved = (ct_wisdom.discover_ct, ct_wisdom_live.has_match_capability,
             ct_wisdom.recall_wiki, ct_wisdom_live.match_wisdom)
    ct_wisdom.discover_ct = fake.discover_ct
    ct_wisdom_live.has_match_capability = fake.has_match_capability
    ct_wisdom.recall_wiki = fake.recall_wiki
    ct_wisdom_live.match_wisdom = fake.match_wisdom
    try:
        yield fake
    finally:
        (ct_wisdom.discover_ct, ct_wisdom_live.has_match_capability,
         ct_wisdom.recall_wiki, ct_wisdom_live.match_wisdom) = saved


class Env:
    """A temp data dir and the env view a hook would see."""

    def __init__(self, **extra):
        self.root = tempfile.mkdtemp(prefix="ct-da-test-")
        self.env = {"DOCKER_AGENT_DATA_DIR": self.root, "PATH": os.environ.get("PATH", ""),
                    "HOME": os.environ.get("HOME", self.root)}
        self.env.update(extra)

    @property
    def wdir(self):
        return ct_wisdom_da.wisdom_dir(self.env)

    def store(self, sid):
        return ct_wisdom_da.load_store(self.wdir, sid)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


# ---------------------------------------------------------------------------
# payload builders (shapes recorded from the pinned binary, spec P5-P7, P15)
# ---------------------------------------------------------------------------

BASE_MESSAGES = [
    {"role": "system", "content": "You are a test agent."},
    {"role": "system", "content": "## Filesystem Tools\n...", "cache_control": True},
]


def llm(sid, messages=None, iteration=1, cwd="/work/proj/app", agent="root"):
    msgs = [dict(m) for m in (messages if messages is not None else BASE_MESSAGES)]
    if messages is None:
        msgs.append({"role": "user", "content": "hello"})
    return {"hook_event_name": "before_llm_call", "session_id": sid, "cwd": cwd,
            "agent_name": agent, "iteration": iteration, "model_id": "mock/m",
            "messages": msgs}


def prompt(sid, text, event="user_prompt_submit"):
    return {"hook_event_name": event, "session_id": sid, "cwd": "/work/proj/app",
            "agent_name": "root", "prompt": text}


def tool(sid, name="read_file", args=None, response="file text\n", category="filesystem",
         error=False, cwd="/work/proj/app", use_id="call_1"):
    payload = {"hook_event_name": "tool_response_transform", "session_id": sid, "cwd": cwd,
               "agent_name": "root", "tool_name": name, "tool_use_id": use_id,
               "tool_input": args if args is not None else {"path": "src/a.py"},
               "tool_category": category, "tool_response": response}
    if error:
        payload["tool_error"] = True
    return payload


def updated_messages(out):
    return out["hook_specific_output"]["updated_messages"] if out else None


def updated_response(out):
    return out["hook_specific_output"]["updated_tool_response"] if out else None

#!/usr/bin/env python3
"""Tests for ct_wisdom_activity.py — autonomous-work wisdom delivery (Hermes).

Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md

Run: python3 -m unittest tests.test_ct_wisdom_activity -v
"""

from __future__ import annotations

import json
import os
import random
import shlex
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_activity as act  # noqa: E402
import ct_wisdom_live  # noqa: E402
import ct_wisdom_verbose  # noqa: E402

ORIGINAL_SEAM = act._record_activity_delivery


# ---------------------------------------------------------------------------
# Task 3: activity line builder and query
# ---------------------------------------------------------------------------

CASES = [
    ("read_file", {"path": "src/billing/invoice.py"},
     "read src/billing/invoice.py", "src/billing/invoice.py"),
    ("write_file", {"path": "./a/b.py", "content": "SECRET_CONTENT"}, "write a/b.py", "a/b.py"),
    ("patch", {"path": "x.py", "old_string": "o", "new_string": "SECRET_NEW"}, "edit x.py", "x.py"),
    ("search_files", {"pattern": "MCP tool name", "path": "src"},
     "search MCP tool name in src", "MCP tool name"),
    ("search_files", {"pattern": "TODO"}, "search TODO", "TODO"),
    ("terminal", {"command": "pnpm test"}, "run pnpm test", "pnpm test"),
    ("terminal", {"command": "npm run build"}, "run npm run", "npm run"),
    ("terminal", {"command": "pytest tests/billing -q"},
     "run pytest tests/billing", "pytest tests/billing"),
    ("terminal", {"command": "API_KEY=sk-123 python deploy.py --token x"},
     "run python deploy.py", "python deploy.py"),
    ("terminal", {"command": "curl -H 'Authorization: Bearer x' https://h"}, "run curl", "curl"),
    ("terminal", {"command": "git commit -m 'msg SECRET'"}, "run git commit", "git commit"),
    ("terminal", {"command": "/usr/local/bin/python3 -m pytest"},
     "run python3 pytest", "python3 pytest"),
    ("terminal", {"command": "pytest tests/test_x.py"},
     "run pytest tests/test_x.py", "pytest tests/test_x.py"),
    ("terminal", {"command": "cat .env.local | grep KEY"}, "run cat .env.local", "cat .env.local"),
    ("terminal", {"command": "echo sk-live-abcdef"}, "run echo", "echo"),
    ("terminal", {"command": "export TOKEN=abc && make"}, "run export", "export"),
    ("terminal", {"command": "mysql -uroot -pS3cr3t db"}, "run mysql", "mysql"),
    ("terminal", {"command": "psql -W secretpw"}, "run psql", "psql"),
    ("terminal", {"command": "deploy --token abcsecret"}, "run deploy", "deploy"),
    ("terminal", {"command": "git -C somedir status"}, "run git", "git"),
    ("terminal", {"command": "python -m mypkg.cli --key v"}, "run python mypkg.cli", "python mypkg.cli"),
    ("terminal", {"command": "python3.11 -m pytest -q"}, "run python3.11 pytest", "python3.11 pytest"),
    ("terminal", {"command": "node -m x"}, "run node", "node"),
    ("terminal", {"command": 'grep "SecretPassword" app.log'}, "run grep", "grep"),
    ("terminal", {"command": "grep 'SecretPassword'"}, "run grep", "grep"),
    ("terminal", {"command": "python -m 'secretmod'"}, "run python", "python"),
    ("terminal", {"command": "git push https://user:pw@host/r.git"}, "run git push", "git push"),
    ("terminal", {"command": "deploy ghp_abcdefghijklmnop1234"}, "run deploy", "deploy"),
    ("terminal", {"command": "tool a1b2c3d4e5f6g7h8i9"}, "run tool", "tool"),
]


class TestActivityLine(unittest.TestCase):
    def test_cases(self):
        for tool, args, line, query in CASES:
            with self.subTest(tool=tool, args=args):
                a = act.activity_for(tool, args, cwd="/work/repo")
                self.assertIsNotNone(a)
                self.assertEqual(a.line, line)
                self.assertEqual(act.query_for(a), query)

    def test_query_never_has_the_verb(self):
        for tool, args, line, _ in CASES:
            a = act.activity_for(tool, args, cwd="/work/repo")
            verb = line.split(" ", 1)[0]
            self.assertFalse(act.query_for(a).startswith(verb + " "), line)

    def test_paths(self):
        cwd = "/work/repo"
        env = {"USER": "alice", "HOME": "/Users/alice"}
        self.assertEqual(act.normalize_path("/work/repo/src/x.py", cwd, env), "src/x.py")
        # Privacy amendment R2: outside cwd, the basename only.
        self.assertEqual(act.normalize_path("/Users/alice/other/proj/y.py", cwd, env), "y.py")
        self.assertEqual(act.normalize_path("~/notes/z.md", cwd, env), "z.md")
        # 0.6.3 R1: HOME itself is not a valid cwd; a project inside it is.
        self.assertEqual(act.normalize_path("~/notes/z.md", "/Users/alice", env), "z.md")
        self.assertEqual(act.normalize_path("~/proj/z.md", "/Users/alice/proj", env), "z.md")
        self.assertEqual(act.normalize_path("../../etc/passwd", cwd, env), "etc/passwd")
        self.assertEqual(act.normalize_path("a\\b\\c.py", cwd, env), "a/b/c.py")
        self.assertEqual(act.normalize_path("./", cwd, env), None)
        self.assertEqual(act.normalize_path("", cwd, env), None)
        self.assertEqual(act.normalize_path(None, cwd, env), None)
        self.assertLessEqual(len(act.normalize_path("d/" * 300 + "f.py", cwd, env)),
                             act.TARGET_CHARS)

    def test_cwd_validity(self):
        env = {"USER": "alice", "HOME": "/Users/alice"}
        for cwd in ("", "/", "/Users", "/home", "/work", "C:/", "C:\\", "C:\\Users", "c:",
                    "relative/dir", None, "/Users/alice", "~", "/home/bob", "C:foo",
                    "C:\\Users\\bob"):
            with self.subTest(cwd=cwd):
                self.assertIsNone(act.valid_cwd(cwd, env))
        self.assertIsNone(act.valid_cwd("/var/lib", {"HOME": "/var/lib/alice"}))
        self.assertIsNone(act.valid_cwd("/data/home", {"HOME": "/data/home/alice"}))
        self.assertEqual(act.valid_cwd("/Users/alice/proj", env), "/Users/alice/proj")
        self.assertEqual(act.valid_cwd("~/proj", env), "/Users/alice/proj")
        self.assertEqual(act.valid_cwd("/root/app", {"HOME": "/root"}), "/root/app")
        self.assertEqual(act.valid_cwd("/work/repo/", env), "/work/repo")
        self.assertEqual(act.valid_cwd("C:\\Users\\carol\\proj", {}), "c:/Users/carol/proj")

    def test_no_line(self):
        for tool, args in [
            ("patch", {"mode": "patch", "patch": "*** Update File: a.py\n+SECRET"}),
            ("execute_code", {"code": "print('SECRET')"}),
            ("web_search", {"query": "secret"}),
            ("read_file", {}),
            ("read_file", {"path": 7}),
            ("terminal", {"command": ""}),
            ("terminal", {"command": "A=1 B=2"}),
            ("terminal", {"command": "'unterminated"}),
            ("terminal", {"command": "$(cat secret)"}),
            ("terminal", {"command": 42}),
            ("search_files", {"pattern": ""}),
            ("read_file", "not-a-dict"),
        ]:
            with self.subTest(tool=tool, args=args):
                self.assertIsNone(act.activity_for(tool, args, cwd="/w"))

    def test_ct_tools(self):
        for name in ("mcp__curated-thoughts__curated_recall_context",
                     "mcp_curated_thoughts_curated_get_wiki_entry", "curated_recall_context",
                     "mcp__curated-thoughts__wiki_context"):
            self.assertTrue(act.is_ct_tool(name), name)
        for name in ("read_file", "terminal", "search_files", "mcp__github__search"):
            self.assertFalse(act.is_ct_tool(name), name)

    def test_secret_args_never_in_line_or_query(self):
        secret = "SUPERSECRET"
        for tool, args in [
            ("write_file", {"path": "a.py", "content": secret}),
            ("patch", {"path": "a.py", "old_string": secret, "new_string": secret, "patch": secret}),
            ("read_file", {"path": "a.py", "offset": 1, "limit": secret}),
            ("search_files", {"pattern": "p", "file_glob": secret, "context": secret}),
            ("terminal", {"command": "ls", "workdir": secret}),
        ]:
            a = act.activity_for(tool, args, cwd="/w")
            self.assertNotIn(secret, a.line)
            self.assertNotIn(secret, act.query_for(a))

    def test_randomized_commands_secret_safety(self):
        rng = random.Random(20261016)
        words = ["git", "npm", "pytest", "make", "python", "status", "test", "build", "src/a.py"]
        nasty = ["sk-ABCDEF1234567890xyz", "ghp_0123456789abcdefABCD", "user:pw@host",
                 "https://u:p@h/x", "$TOKEN", "${SECRET}", "A=B", "'quoted secret'",
                 '"dq secret"', "--password=hunter2", "-pHUNTER2", "AKIAABCDEFGHIJKLMNOP",
                 "xoxb-123-456", "a1b2c3d4e5f6g7h8i9j0", "|", "&&", ";", ">", "out.txt"]
        for _ in range(500):
            parts = [rng.choice(words + nasty) for _ in range(rng.randint(1, 7))]
            command = " ".join(parts)
            a = act.activity_for("terminal", {"command": command}, cwd="/w")
            if a is None:
                continue
            query = act.query_for(a)
            tokens = query.split(" ")
            self.assertLessEqual(len(tokens), 2, command)
            for ch in "=@:$'\"|&;<>":
                self.assertNotIn(ch, query, command)
            for bad in ("sk-", "ghp_", "AKIA", "xox", "hunter2", "HUNTER2", "a1b2c3"):
                self.assertNotIn(bad, query, command)
            # Each query token is one of the command's own leading tokens.
            try:
                raw = shlex.split(command)
            except ValueError:
                raw = command.split()
            basenames = [os.path.basename(t) for t in raw]
            for token in tokens:
                self.assertIn(token, raw + basenames, command)
            # The second token is the word right after the program (or the
            # module after `python -m`), never a value that follows a flag.
            if len(tokens) == 2:
                i = basenames.index(tokens[0])
                after = raw[i + 1:]
                self.assertTrue(after[:1] == [tokens[1]] or after[:2] == ["-m", tokens[1]],
                                command)


    def test_randomized_search_patterns_privacy(self):
        """Privacy amendment R3: planted secrets, quotes, assignments, absolute
        paths and user names never reach a search query."""
        rng = random.Random(20261017)
        env = {"USER": "zelda", "HOME": "/home/zelda"}
        safe = ["TODO", "error", "404", "MCP", "tool", "name", "ct_wisdom.py", "def",
                "a\u00f1o", "fix", "fail-closed", "v1.2"]
        nasty = ["password=letmein", 'API_KEY="hunter2pass"', "'q'", "`x`", "a=b", "==",
                 "sk-ABCDEF1234567890xyz", "ghp_0123456789abcdefABCD", "AKIAABCDEFGHIJKLMNOP",
                 "a1b2c3d4e5f6g7h8i9j0", "/home/zelda/x", "~/notes", "zelda", "Zelda/notes",
                 "home/zelda", "C:\\Users\\zelda", "../up", "\\\\srv\\share", "/etc/passwd",
                 "\u201csmart\u201d", "password:letmein", "token:", "--password", "-v",
                 "Bearer", "alice@example.com", "\\ProgramData\\corp", "src/billing",
                 "\\w+", "foo(bar)", "zelda_notes", "my-Zelda.md", "C:foo", "x;y", "a,b",
                 "#hash", "100%", "$HOME", "auth", "APIKEY", "Secret"]
        for _ in range(500):
            parts = [rng.choice(safe + nasty) for _ in range(rng.randint(1, 6))]
            pattern = " ".join(parts)
            for cwd in ("/", "/work/repo", "/home/zelda"):
                a = act.activity_for("search_files", {"pattern": pattern}, cwd=cwd, env=env)
                if any(p in nasty for p in parts):
                    self.assertIsNone(a, pattern)
                    continue
                self.assertIsNotNone(a, pattern)
                query = act.query_for(a)
                self.assertEqual(query, pattern)
                for bad in ("=", "'", '"', "`", "zelda", "Zelda", "~", "sk-", "ghp_", "AKIA",
                            ":", "@", "/", "\\", "(", "$", "%"):
                    self.assertNotIn(bad, query, pattern)
                self.assertLessEqual(len(query), 80)
                self.assertLessEqual(len(query.split()), 6)
                self.assertFalse(any(w.startswith("-") for w in query.split()), pattern)

    def test_randomized_paths_privacy(self):
        """Privacy amendment R1/R2: every tool path, under any cwd, drops the
        user name, and outside a valid cwd keeps the basename only."""
        rng = random.Random(20261018)
        envs = [{"USER": "zelda", "LOGNAME": "zelda", "HOME": "/Users/zelda"},
                {"USER": "zelda", "HOME": "/"}, {"USERNAME": "zelda", "HOME": "/root"}]
        heads = ["/Users/zelda", "/home/zelda", "~", "/", "/work/repo", "C:\\Users\\zelda",
                 "/srv", "..", "", "Users/zelda", "zelda", "./", "C:", "C:..", "\\etc",
                 "/Users/zelda/proj", "/home/runner", "\\\\?\\C:", "/C:", "/mnt/c:",
                 "\\\\?\\C:\\Users\\zelda", "/home/bob"]
        mids = ["clients", "acme", "zelda", "Zelda", "src", "..", ".", "home", "Users",
                "secret-plans", "d\u00e9j\u00e0", "zelda.txt", "my-zelda", "ZELDA@corp",
                "root", "node"]
        cwds = ["", "/", "/Users", "/home", "/work", "/work/repo", "/Users/zelda", "C:/",
                "C:\\Users\\zelda", "/Users/zelda/proj", "~", "/home/bob", "/mnt/c:"]
        for _ in range(1000):
            segs = [rng.choice(mids) for _ in range(rng.randint(0, 4))]
            head = rng.choice(heads)
            sep = "\\" if head.startswith("C:") else "/"
            raw = sep.join(([head] if head else []) + segs + ["f%d.md" % rng.randint(0, 9)])
            cwd = rng.choice(cwds)
            env = rng.choice(envs)
            tool = rng.choice(["read_file", "write_file", "patch"])
            a = act.activity_for(tool, {"path": raw}, cwd=cwd, env=env)
            if a is None:
                continue
            query = act.query_for(a)
            comps = query.split("/")
            self.assertNotIn("zelda", query.casefold(), (raw, cwd, query))
            self.assertNotIn("bob", query, (raw, cwd, env, query))
            self.assertNotIn("\\", query, (raw, cwd))
            self.assertNotIn("~", query, (raw, cwd))
            self.assertFalse(query.startswith("/"), (raw, cwd))
            self.assertNotIn(":", query, (raw, cwd))
            self.assertTrue(a.line.endswith(" " + query), (raw, cwd))
            under = act.valid_cwd(cwd, env)
            absolute = raw.startswith(("/", "~", "C:", "\\"))
            if absolute and under is None:
                self.assertEqual(len(comps), 1, (raw, cwd, query))

    def test_credential_shaped_search_pattern_rejected(self):
        for pattern in ("sk-live-abcdef", "find ghp_abcdefghijklmnop1234 here",
                        "AKIAABCDEFGHIJKLMNOP", "token a1b2c3d4e5f6g7h8i9"):
            self.assertIsNone(act.activity_for("search_files", {"pattern": pattern}, cwd="/w"),
                              pattern)
        self.assertIsNotNone(act.activity_for("search_files", {"pattern": "error 404"}, cwd="/w"))

    def test_own_marker_or_heading_is_never_a_target(self):
        for pattern in ("ct-fact:evil", "## Curated Thoughts \u2014 relevant now", "a\nb"):
            self.assertIsNone(act.activity_for("search_files", {"pattern": pattern}, cwd="/w"))

    def test_query_caps(self):
        a = act.activity_for("search_files", {"pattern": "x" * 80, "path": "y" * 600}, cwd="/w")
        self.assertLessEqual(len(act.query_for(a)), act.ACTIVITY_QUERY_CHARS)
        self.assertLessEqual(len(a.query), act.TARGET_CHARS)
        # 0.6.3 allowlist: over 80 chars is refused, never truncated.
        self.assertIsNone(act.activity_for("search_files", {"pattern": "x" * 81}, cwd="/w"))

    def test_keys_use_full_local_path(self):
        env = {"USER": "alice", "HOME": "/Users/alice"}
        a = act.activity_for("read_file", {"path": "/srv/a/README.md"}, cwd="/", env=env)
        b = act.activity_for("read_file", {"path": "/srv/b/README.md"}, cwd="/", env=env)
        self.assertEqual((a.query, b.query), ("README.md", "README.md"))
        self.assertNotEqual(a.key, b.key)
        # The same file by two spellings is one key; read/write/edit fold.
        c = act.activity_for("patch", {"path": "README.md"}, cwd="/srv/a", env=env)
        self.assertEqual(a.key, c.key)
        # The key never holds the raw path.
        self.assertNotIn("/srv/a", repr(a.key))

    def test_user_names_once_per_call(self):
        calls = []
        orig = act.user_names

        def counting(env=None):
            calls.append(1)
            return orig(env)

        act.user_names = counting
        self.addCleanup(setattr, act, "user_names", orig)
        act.activity_for("search_files", {"pattern": "TODO", "path": "a/b"}, cwd="/w/r", env={})
        act.activity_for("terminal", {"command": "make all"}, cwd="/w/r", env={})
        self.assertEqual(len(calls), 2)

    def test_service_accounts_and_short_names_not_private(self):
        for user in ("root", "node", "app", "user", "admin", "test", "ubuntu", "runner",
                     "docker", "www-data", "nobody", "daemon", "ec2-user", "vscode",
                     "codespace"):
            self.assertEqual(act.user_names({"USER": user, "HOME": "/home/" + user}),
                             frozenset(), user)
        self.assertEqual(act.user_names({"USER": "Alice", "HOME": "/home/bob"}),
                         frozenset({"alice", "bob"}))
        # Privacy amendment 3: HOME's basename counts only directly under
        # /Users, /home or C:\Users; short names count (exact match only).
        for home in ("/github/home", "/opt/build", "/var/lib/jenkins", "/", "/root",
                     "/data/home/alice", "D:\\Profiles\\erin"):
            self.assertEqual(act.user_names({"HOME": home}), frozenset(), home)
        self.assertEqual(act.user_names({"USERPROFILE": "C:\\USERS\\Erin"}), frozenset({"erin"}))
        self.assertEqual(act.user_names({"USER": "jo"}), frozenset({"jo"}))
        names = act.user_names({"USER": "jo"})
        self.assertTrue(act._has_name("JO", names))
        self.assertFalse(act._has_name("join.py", names))
        self.assertTrue(act._has_name("Sample.py", act.user_names({"USER": "sam"})))

    def test_session_cwd_is_lazy(self):
        calls = []
        orig = act.session_cwd

        def counting(task_id=None):
            calls.append(task_id)
            return "/srv/proj"

        act.session_cwd = counting
        self.addCleanup(setattr, act, "session_cwd", orig)
        act.activity_for("terminal", {"command": "make all"}, env={}, task_id="t1")
        act.activity_for("web_search", {"query": "x"}, env={}, task_id="t1")
        self.assertEqual(calls, [])
        a = act.activity_for("read_file", {"path": "/srv/proj/src/a.py"}, env={}, task_id="t1")
        self.assertEqual(a.query, "src/a.py")
        act.activity_for("search_files", {"pattern": "TODO"}, env={}, task_id="t2")
        self.assertEqual(calls, ["t1", "t2"])

    def test_session_cwd_prefers_hermes_session_record(self):
        fake = type(sys)("tools.terminal_tool")
        fake.resolve_task_overrides = lambda task_id: {}
        fake.get_session_cwd = lambda task_id: "/srv/proj" if task_id == "t1" else None
        self.addCleanup(sys.modules.pop, "tools.terminal_tool", None)
        sys.modules["tools.terminal_tool"] = fake
        self.assertEqual(act.session_cwd("t1"), "/srv/proj")
        fake.resolve_task_overrides = lambda task_id: {"cwd": "/srv/override"}
        self.assertEqual(act.session_cwd("t1"), "/srv/override")

        def boom(task_id):
            raise RuntimeError("x")

        fake.resolve_task_overrides = boom
        fake.get_session_cwd = boom
        old = os.environ.get("TERMINAL_CWD")
        self.addCleanup(lambda: os.environ.__setitem__("TERMINAL_CWD", old)
                        if old is not None else os.environ.pop("TERMINAL_CWD", None))
        os.environ["TERMINAL_CWD"] = "/srv/term"
        self.assertEqual(act.session_cwd("t1"), "/srv/term")
        os.environ.pop("TERMINAL_CWD")
        self.assertEqual(act.session_cwd(""), os.getcwd())

    def test_session_cwd_never_imports_hermes(self):
        sys.modules.pop("tools.terminal_tool", None)
        act.session_cwd("t1")
        self.assertNotIn("tools.terminal_tool", sys.modules)


# ---------------------------------------------------------------------------
# Task 4: key tracker and rate rule
# ---------------------------------------------------------------------------


class TestActivityState(unittest.TestCase):
    def key(self, tool, path):
        return act.activity_for(tool, {"path": path}, cwd="/w").key

    def test_one_start_per_step(self):
        st = act.ActivityState()
        self.assertIsNone(st.admit("s", "t:api:1", self.key("read_file", "a.py")))
        self.assertEqual(st.admit("s", "t:api:1", self.key("read_file", "b.py")), "step_used")
        self.assertIsNone(st.admit("s", "t:api:2", self.key("read_file", "b.py")))

    def test_seen_key_and_file_fold(self):
        st = act.ActivityState()
        self.assertIsNone(st.admit("s", "r1", self.key("read_file", "a.py")))
        self.assertEqual(st.admit("s", "r2", self.key("patch", "a.py")), "seen_key")
        self.assertEqual(st.admit("s", "r3", self.key("write_file", "a.py")), "seen_key")
        # a rejected key does not consume the step
        self.assertIsNone(st.admit("s", "r3", self.key("read_file", "c.py")))

    def test_lru_and_sessions(self):
        st = act.ActivityState()
        for i in range(act.RECENT_KEYS_MAX + 1):
            self.assertIsNone(st.admit("s", "r%d" % i, self.key("read_file", "f%d.py" % i)))
        self.assertIsNone(st.admit("s", "rx", self.key("read_file", "f0.py")))  # evicted
        self.assertIsNone(st.admit("other", "r1", self.key("read_file", "f1.py")))

    def test_run_and_search_keys_distinct_from_files(self):
        st = act.ActivityState()
        self.assertIsNone(st.admit("s", "r1", act.activity_for(
            "terminal", {"command": "make test"}, cwd="/w").key))
        self.assertIsNone(st.admit("s", "r2", act.activity_for(
            "search_files", {"pattern": "make test"}, cwd="/w").key))
        self.assertEqual(st.admit("s", "r3", act.activity_for(
            "terminal", {"command": "make test -j4"}, cwd="/w").key), "seen_key")


# ---------------------------------------------------------------------------
# Task 5: prefetch, render, splice, hooks, seam
# ---------------------------------------------------------------------------


def item(fid, title=None, text=None, supersedes=None, provenance="stated"):
    return {"id": fid, "title": title if title is not None else "Title " + fid,
            "text": text if text is not None else "Body of " + fid,
            "supersedes": supersedes or [], "provenance": provenance}


class Harness(unittest.TestCase):
    """Fakes CT (discovery, probe, match) and runs prefetches synchronously."""

    def setUp(self):
        act.reset_state()
        ct_ledger.LEDGER_CACHE.clear()
        self.addCleanup(act.reset_state)
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        orig_breaker = ct_wisdom_live._BREAKER
        ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker()
        self.addCleanup(setattr, ct_wisdom_live, "_BREAKER", orig_breaker)
        self.calls = []
        self.match_result = ({"entries": [item("f1")], "corrections": []}, None)
        self.deliveries = []

        def fake_match(path, text, max_n, exclude):
            self.calls.append({"text": text, "max_n": max_n, "exclude": list(exclude)})
            return self.match_result

        for mod, name, value in [
            (ct_wisdom, "discover_ct", lambda env=None: ("/fake/ct", None)),
            (ct_wisdom_live, "has_match_capability", lambda p: True),
            (ct_wisdom_live, "match_wisdom", fake_match),
            (act, "_spawn", lambda target: target()),
            (act, "_record_activity_delivery", lambda event: self.deliveries.append(event)),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)

    def pre(self, tool="read_file", args=None, sid="s1", call="c1", req="t:api:1"):
        return act.on_pre_tool_call(
            tool_name=tool, args={"path": "src/x.py"} if args is None else args,
            task_id="", session_id=sid, tool_call_id=call, turn_id="t",
            api_request_id=req, middleware_trace=[])

    def post(self, result, tool="read_file", args=None, sid="s1", call="c1", req="t:api:1"):
        return act.on_transform_tool_result(
            tool_name=tool, args={"path": "src/x.py"} if args is None else args,
            result=result, task_id="", session_id=sid, tool_call_id=call, turn_id="t",
            api_request_id=req, duration_ms=5, status="ok", error_type=None,
            error_message=None)


READ_RESULT = json.dumps({"content": "1|print('hi')\n", "total_lines": 1}, ensure_ascii=False)


class TestDelivery(Harness):
    def test_happy_path_json_object(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"old1"})
        self.assertIsNone(self.pre())
        out = self.post(READ_RESULT)
        data = json.loads(out)
        self.assertEqual(data["content"], "1|print('hi')\n")
        block = data[act.ACTIVITY_RESULT_KEY]
        self.assertTrue(block.startswith(act.ACTIVITY_HEADING))
        self.assertIn("_for: read src/x.py_", block)
        self.assertIn(ct_ledger.marker("f1"), out)  # raw text: the ledger scan finds it
        self.assertEqual(ct_ledger.scan_ids(out), ["f1"])
        self.assertIn("f1", ct_ledger.LEDGER_CACHE.get("s1"))
        self.assertEqual(self.calls, [{"text": "src/x.py", "max_n": 1, "exclude": ["old1"]}])
        self.assertTrue(out.startswith(READ_RESULT[:-1]))  # original bytes kept

    def test_write_file_still_landed(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        result = json.dumps({"bytes_written": 12, "dirs_created": False})
        self.pre(tool="write_file", args={"path": "a.py", "content": "x"})
        out = self.post(result, tool="write_file", args={"path": "a.py", "content": "x"})
        data = json.loads(out.strip())
        self.assertIn("bytes_written", data)
        self.assertFalse(data.get("error"))

    def test_plain_text_appended(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre(tool="terminal", args={"command": "pnpm test"})
        out = self.post("ok 3 passed", tool="terminal", args={"command": "pnpm test"})
        self.assertTrue(out.startswith("ok 3 passed\n\n" + act.ACTIVITY_HEADING))
        self.assertEqual(self.calls[0]["text"], "pnpm test")

    def test_empty_object(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre()
        out = self.post("{}")
        self.assertEqual(list(json.loads(out)), [act.ACTIVITY_RESULT_KEY])

    def test_unsupported_results_claim_nothing(self):
        for result in ('[1, 2]', '"str"', '42', {"multimodal": True},
                       json.dumps({act.ACTIVITY_RESULT_KEY: "x"})):
            with self.subTest(result=result):
                act.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                self.pre()
                self.assertIsNone(self.post(result))
                self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), set())
                self.assertEqual(self.deliveries, [])

    def test_block_shape_and_budget(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.match_result = ({"entries": [item("f1", text="word " * 400)],
                              "corrections": []}, None)
        self.pre()
        block = json.loads(self.post(READ_RESULT))[act.ACTIVITY_RESULT_KEY]
        self.assertLessEqual(len(block), act.ACTIVITY_MAX_BLOCK_CHARS)
        self.assertTrue(block.endswith("…"))
        m, t, b = block.index(ct_ledger.marker("f1")), block.index("**Title f1**"), block.index("word")
        self.assertLess(m, t)
        self.assertLess(t, b)
        self.assertIn("(provenance: stated)", block)
        self.assertEqual(block.count("ct-fact:"), 1)

    def test_one_fact_even_if_ct_returns_more(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.match_result = ({"entries": [item("f1"), item("f2")], "corrections": []}, None)
        self.pre()
        out = self.post(READ_RESULT)
        self.assertEqual(ct_ledger.scan_ids(out), ["f1"])
        self.assertNotIn("f2", ct_ledger.LEDGER_CACHE.get("s1"))

    def test_correction_only_when_superseding_ledger(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"old"})
        self.match_result = ({"entries": [item("f1")], "corrections": [
            item("c_nope", supersedes=["absent"]), item("c1", supersedes=["old"])]}, None)
        self.pre()
        block = json.loads(self.post(READ_RESULT))[act.ACTIVITY_RESULT_KEY]
        self.assertIn(ct_ledger.marker("c1"), block)
        self.assertIn("supersedes ct-fact:old", block)
        self.assertNotIn("c_nope", block)

    def test_skips_ids_already_in_ledger(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        self.match_result = ({"entries": [item("f1"), item("f2")], "corrections": []}, None)
        self.pre()
        self.assertEqual(ct_ledger.scan_ids(self.post(READ_RESULT)), ["f2"])

    def test_zero_hits(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        self.pre()
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual(self.deliveries, [])

    def test_seam_called_once_with_documented_keys(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre()
        out = self.post(READ_RESULT)
        self.assertEqual(len(self.deliveries), 1)
        ev = self.deliveries[0]
        self.assertEqual(set(ev), {"host", "channel", "session_id", "query", "activity",
                                   "result", "ledger", "delivered", "block", "tool_name",
                                   "api_request_id"})
        self.assertEqual((ev["host"], ev["channel"]), ("hermes", "activity"))
        self.assertEqual(ev["delivered"], ["f1"])
        self.assertEqual(ev["query"], "src/x.py")
        self.assertEqual(ev["block"], json.loads(out)[act.ACTIVITY_RESULT_KEY])
        self.assertEqual(ev["api_request_id"], "t:api:1")

    def test_default_seam_returns_none(self):
        self.assertIsNone(ORIGINAL_SEAM({"host": "hermes", "channel": "activity"}))

    def test_other_calls_in_step_pass_through(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre(call="c1")
        self.pre(call="c2", args={"path": "src/y.py"})
        self.assertIsNone(self.post(READ_RESULT, call="c2", args={"path": "src/y.py"}))
        self.assertIsNotNone(self.post(READ_RESULT, call="c1"))
        self.assertEqual(len(self.calls), 1)

    def test_second_claim_of_same_fact_skipped(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre(call="c1", req="r1")
        self.pre(call="c2", req="r2", args={"path": "src/y.py"})
        self.assertIsNotNone(self.post(READ_RESULT, call="c1", req="r1"))
        self.assertIsNone(self.post(READ_RESULT, call="c2", req="r2", args={"path": "src/y.py"}))


class TestFailClosed(Harness):
    def assert_no_query(self, **kw):
        self.assertIsNone(self.pre(**kw))
        self.assertEqual(self.calls, [])

    def test_no_ledger(self):
        self.assert_no_query()
        self.assertIsNone(self.post(READ_RESULT))

    def test_ledger_dropped_between_hooks(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre()
        ct_ledger.LEDGER_CACHE.clear()
        self.assertIsNone(self.post(READ_RESULT))

    def test_empty_ids(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assert_no_query(req="")
        self.assert_no_query(call="")
        self.assertIsNone(act.on_pre_tool_call(tool_name="read_file", args={"path": "a"},
                                               session_id="", tool_call_id="c",
                                               api_request_id="r"))
        self.assertEqual(self.calls, [])

    def test_ct_tool_never_triggers(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assert_no_query(tool="mcp__curated-thoughts__curated_recall_context",
                             args={"query": "src/x.py", "path": "src/x.py"})

    def test_breaker_open(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            ct_wisdom_live._BREAKER.record_failure()
        self.assert_no_query()

    def test_timeout_and_exit_feed_shared_breaker(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        for i, cls in enumerate(["timeout", "exit", "timeout"]):
            self.match_result = (None, cls)
            self.pre(call="c%d" % i, req="r%d" % i, args={"path": "f%d.py" % i})
            self.assertIsNone(self.post(READ_RESULT, call="c%d" % i, req="r%d" % i,
                                        args={"path": "f%d.py" % i}))
        self.assertTrue(ct_wisdom_live._BREAKER.is_open())

    def test_spawn_resets_caches(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        resets = []
        for mod, name in [(ct_wisdom, "reset_discovery_cache"),
                          (ct_wisdom_live, "reset_capability_cache")]:
            orig = getattr(mod, name)
            setattr(mod, name, lambda n=name: resets.append(n))
            self.addCleanup(setattr, mod, name, orig)
        self.match_result = (None, "spawn")
        self.pre()
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual(sorted(resets), ["reset_capability_cache", "reset_discovery_cache"])

    def test_discovery_and_capability(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        orig = ct_wisdom.discover_ct
        ct_wisdom.discover_ct = lambda env=None: (None, "discovery_miss")
        self.pre()
        self.assertIsNone(self.post(READ_RESULT))
        ct_wisdom.discover_ct = orig
        orig_cap = ct_wisdom_live.has_match_capability
        ct_wisdom_live.has_match_capability = lambda p: False
        self.addCleanup(setattr, ct_wisdom_live, "has_match_capability", orig_cap)
        self.pre(call="c2", req="r2", args={"path": "b.py"})
        self.assertIsNone(self.post(READ_RESULT, call="c2", req="r2", args={"path": "b.py"}))
        self.assertEqual(self.calls, [])

    def test_budget_exceeded(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        started = []
        act._spawn = lambda target: started.append(target)  # never runs
        now = [100.0]
        orig_clock = act._clock
        act._clock = lambda: now[0]
        self.addCleanup(setattr, act, "_clock", orig_clock)
        self.pre()
        now[0] += ct_wisdom_live.LIVE_TIMEOUT + 0.01
        self.assertIsNone(self.post(READ_RESULT))
        started[0]()  # the late thread finishes: its result is discarded
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), set())
        self.assertEqual(self.deliveries, [])

    def test_pre_hook_never_raises(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        orig = act.activity_for

        def boom(*a, **k):
            raise RuntimeError("boom")

        act.activity_for = boom
        self.addCleanup(setattr, act, "activity_for", orig)
        self.assertIsNone(self.pre())
        self.assertIsNone(act.on_pre_tool_call())  # no kwargs at all

    def test_transform_never_raises(self):
        self.assertIsNone(act.on_transform_tool_result())
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre()
        orig = act.splice
        act.splice = lambda r, b: (_ for _ in ()).throw(RuntimeError("boom"))
        self.addCleanup(setattr, act, "splice", orig)
        self.assertIsNone(self.post(READ_RESULT))

    def test_no_prefetch_for_call(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNone(self.post(READ_RESULT, call="never-pre"))

    def test_prefetch_from_other_session_ignored(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        ct_ledger.LEDGER_CACHE.put("s2", set())
        self.pre(sid="s1")
        self.assertIsNone(self.post(READ_RESULT, sid="s2"))

    def test_pending_bounded(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        act._spawn = lambda target: None
        for i in range(act.PENDING_MAX + 10):
            self.pre(call="c%d" % i, req="r%d" % i, args={"path": "f%d.py" % i})
        self.assertLessEqual(act.pending_count(), act.PENDING_MAX)


class TestParallelThreads(Harness):
    """Up to 8 Hermes worker threads in one step: one CT call, one delivery."""

    def test_eight_threads_one_step(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        act._spawn = lambda target: threading.Thread(target=target, daemon=True).start()
        outs = [None] * 8
        barrier = threading.Barrier(8)

        def worker(i):
            args = {"path": "f%d.py" % i}
            barrier.wait()
            self.pre(call="c%d" % i, args=args)
            outs[i] = self.post(READ_RESULT, call="c%d" % i, args=args)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(sum(1 for o in outs if o is not None), 1)


# ---------------------------------------------------------------------------
# Task 6: registration and marker hygiene
# ---------------------------------------------------------------------------


class TestMarkerHygiene(Harness):
    def delivered_block(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre()
        out = self.post(READ_RESULT)
        act.reset_state()
        return out, json.loads(out)[act.ACTIVITY_RESULT_KEY]

    def test_activity_query_never_carries_block(self):
        _, block = self.delivered_block()
        for tool, args in [
            ("search_files", {"pattern": block}),
            ("read_file", {"path": block}),
            ("terminal", {"command": block}),
            ("patch", {"path": "a.py", "old_string": block, "new_string": block}),
        ]:
            a = act.activity_for(tool, args, cwd="/w")
            if a is None:
                continue
            q = act.query_for(a)
            self.assertNotIn("ct-fact:", q)
            self.assertNotIn(act.ACTIVITY_HEADING, q)
            self.assertNotIn("Title f1", q)

    def test_history_scan_finds_activity_markers(self):
        out, _ = self.delivered_block()
        text_out = "plain\n\n" + act.render_activity_block(item("f9"), [], act.activity_for(
            "read_file", {"path": "a.py"}, cwd="/w"))
        history = [{"role": "tool", "content": out}, {"role": "tool", "content": text_out}]
        self.assertEqual(sorted(ct_ledger.history_ids(history)), ["f1", "f9"])

    def test_user_turn_query_ignores_tool_results(self):
        out, _ = self.delivered_block()
        seen = []
        orig = ct_wisdom_live.match_wisdom
        ct_wisdom_live.match_wisdom = lambda p, text, n, ex: (
            seen.append(text) or ({"entries": [], "corrections": []}, None))
        self.addCleanup(setattr, ct_wisdom_live, "match_wisdom", orig)
        ct_wisdom_live.reset_session_state()
        self.addCleanup(ct_wisdom_live.reset_session_state)
        ct_wisdom_live.on_pre_llm_call(
            session_id="s9", user_message="hello there", is_first_turn=True,
            conversation_history=[{"role": "tool", "content": out}])
        self.assertEqual(seen, ["hello there"])
        self.assertIn("f1", ct_ledger.LEDGER_CACHE.get("s9"))  # and it is ledgered

    def test_marker_precedes_fact_content(self):
        a = act.activity_for("read_file", {"path": "a.py"}, cwd="/w")
        for it, sup in [(item("f1"), []), (item("c1", supersedes=["o"]), ["o"]),
                        (item("f2", text="x" * 5000), [])]:
            block = act.render_activity_block(it, sup, a)
            self.assertLess(block.index(ct_ledger.marker(it["id"])),
                            block.index("**" + it["title"]))


class TestRegistration(unittest.TestCase):
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "ct_plugin_activity_under_test", HERE.parent / "__init__.py")
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)

    def test_registers_pre_tool_call_and_transform(self):
        hooks = {}

        class Ctx:
            def register_skill(self, *a, **k):
                pass

            def register_hook(self, name, cb):
                hooks[name] = cb

        self.plugin.register(Ctx())
        self.assertIn("pre_tool_call", hooks)
        self.assertIn("transform_tool_result", hooks)
        self.assertIsNone(hooks["pre_tool_call"](tool_name="read_file", args={"path": "a"}))

    def test_transform_composes_dedup_then_activity(self):
        import ct_tool_dedup
        calls = []
        for mod, name, value in [
            (ct_tool_dedup, "on_transform_tool_result",
             lambda **k: calls.append("dedup") or ("D" if k.get("tool_name") == "ct" else None)),
            (act, "on_transform_tool_result", lambda **k: calls.append("act") or "A"),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)
        self.assertEqual(self.plugin._transform_tool_result(tool_name="ct"), "D")
        self.assertEqual(self.plugin._transform_tool_result(tool_name="read_file"), "A")
        self.assertEqual(calls, ["dedup", "dedup", "act"])


class TestVerboseWiring(Harness):
    """Seam wired to ct_wisdom_verbose (spec "Seam for verbose mode")."""

    def setUp(self):
        super().setUp()
        act._record_activity_delivery = ORIGINAL_SEAM  # undo the Harness stub
        self.tmp = tempfile.mkdtemp()
        self.log = os.path.join(self.tmp, "v.jsonl")
        self.notices = []
        prev = ct_wisdom_verbose.set_sink(self.notices.append)
        self.addCleanup(ct_wisdom_verbose.set_sink, prev)
        for key in ("CT_WISDOM_VERBOSE", "CT_WISDOM_VERBOSE_LOG"):
            self.addCleanup(self._restore_env, key, os.environ.get(key))
        os.environ["CT_WISDOM_VERBOSE_LOG"] = self.log

    @staticmethod
    def _restore_env(key, value):
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value

    def events(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def run_delivery(self, verbose):
        if verbose:
            os.environ["CT_WISDOM_VERBOSE"] = "1"
        else:
            os.environ.pop("CT_WISDOM_VERBOSE", None)
        act.reset_state()
        ct_ledger.LEDGER_CACHE.put("s1", set())
        args = {"path": "src/x.py", "content": "SECRET_CONTENT_VALUE"}
        self.pre(tool="write_file", args=args)
        return self.post(json.dumps({"bytes_written": 3}), tool="write_file", args=args)

    def test_off_bytes_unchanged_and_nothing_written(self):
        off = self.run_delivery(False)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.notices, [])
        on = self.run_delivery(True)
        self.assertEqual(off, on)

    def test_on_records_activity_delivery(self):
        out = self.run_delivery(True)
        events = self.events()
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual((ev["host"], ev["channel"], ev["event"]), ("hermes", "activity", "delivery"))
        self.assertEqual(ev["query"], "src/x.py")
        self.assertEqual(ev["activity"], "write src/x.py")
        self.assertEqual(ev["delivered_ids"], ["f1"])
        self.assertEqual(ev["block"], json.loads(out)[act.ACTIVITY_RESULT_KEY])
        self.assertEqual([m["outcome"] for m in ev["matched"]], ["delivered"])
        with open(self.log, encoding="utf-8") as handle:
            raw = handle.read()
        self.assertNotIn("SECRET_CONTENT_VALUE", raw)
        self.assertEqual(len(self.notices), 1)
        self.assertIn("[activity]", self.notices[0])

    def test_on_records_skip_after_query(self):
        os.environ["CT_WISDOM_VERBOSE"] = "1"
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        self.pre()
        self.assertIsNone(self.post(READ_RESULT))
        ev = self.events()
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["channel"], ev[0]["event"]), ("activity", "skip"))
        self.assertEqual(ev[0]["reason"], "deduped")
        self.assertEqual(ev[0]["query"], "src/x.py")

    def test_rate_and_filter_skips_are_not_recorded(self):
        os.environ["CT_WISDOM_VERBOSE"] = "1"
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.pre(call="c1")
        self.post(READ_RESULT, call="c1")
        self.events_before = len(self.events())
        self.pre(call="c2", req="r2")  # seen_key
        self.pre(call="c3", args={"path": "other.py"})  # step_used
        self.pre(call="c4", req="r4", tool="web_search", args={"query": "x"})  # no_activity
        self.pre(call="c5", req="r5", tool="mcp__curated-thoughts__curated_recall_context",
                 args={"query": "x"})  # ct_tool
        self.assertEqual(len(self.events()), self.events_before)

    def test_label_and_verbose_use_sanitized_target(self):
        """Privacy amendment R4: the `_for:` label and the verbose `activity`
        and `query` fields carry the sanitized target, never the raw path."""
        os.environ["CT_WISDOM_VERBOSE"] = "1"
        for name, value in (("USER", "alice"), ("HOME", "/Users/alice")):
            old = os.environ.get(name)
            os.environ[name] = value
            self.addCleanup(lambda n=name, o=old: os.environ.__setitem__(n, o)
                            if o is not None else os.environ.pop(n, None))
        ct_ledger.LEDGER_CACHE.put("s1", set())
        args = {"path": "/Users/alice/clients/acme/contract.md"}
        self.pre(args=args)
        out = self.post(READ_RESULT, args=args)
        block = json.loads(out)[act.ACTIVITY_RESULT_KEY]
        self.assertIn("_for: read contract.md_", block)
        self.assertEqual(self.calls[-1]["text"], "contract.md")
        ev = self.events()
        self.assertEqual(ev[-1]["query"], "contract.md")
        self.assertEqual(ev[-1]["activity"], "read contract.md")
        with open(self.log, encoding="utf-8") as handle:
            raw = handle.read()
        for leak in ("alice", "clients", "acme/"):
            self.assertNotIn(leak, raw)
            self.assertNotIn(leak, out)

    def test_breaker_open_recorded_once_for_a_would_be_trigger(self):
        os.environ["CT_WISDOM_VERBOSE"] = "1"
        ct_ledger.LEDGER_CACHE.put("s1", set())
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            ct_wisdom_live._BREAKER.record_failure()
        self.pre(call="c1")
        self.pre(call="c2", args={"path": "y.py"})  # same step: not a second record
        ev = self.events()
        self.assertEqual([(e["event"], e["reason"]) for e in ev], [("skip", "breaker_open")])
        self.assertEqual(ev[0]["query"], "src/x.py")


if __name__ == "__main__":
    unittest.main()

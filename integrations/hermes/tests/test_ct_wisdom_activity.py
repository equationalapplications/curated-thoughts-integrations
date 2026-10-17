#!/usr/bin/env python3
"""Tests for ct_wisdom_activity.py — autonomous-work wisdom delivery (Hermes).

Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md

Run: python3 -m unittest tests.test_ct_wisdom_activity -v
"""

from __future__ import annotations

import atexit
import json
import os
import random
import shlex
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_activity as act  # noqa: E402
import ct_wisdom_live  # noqa: E402
import ct_wisdom_verbose  # noqa: E402

ORIGINAL_SEAM = act._record_activity_delivery


class HarnessFree:
    """The real _ct_warm, captured before any Harness stub replaces it."""
    real_ct_warm = staticmethod(getattr(act, "_ct_warm", lambda: None))


def make_tree(base, entries):
    """Create `entries` under `base`: "x/" a directory, "x" an empty file."""
    for entry in entries:
        path = os.path.join(base, *entry.rstrip("/").split("/"))
        if entry.endswith("/"):
            os.makedirs(path, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            Path(path).touch()


def temp_base():
    base = os.path.realpath(tempfile.mkdtemp(prefix="ct-activity-test-"))
    atexit.register(shutil.rmtree, base, True)
    return base


# Privacy amendment 4: a path is sent only inside a project root. Every test
# that needs one uses this temp project (never the checkout, so the suite
# also runs from outside it).
PROJ = temp_base()
make_tree(PROJ, [".git/", "mypkg/__init__.py"])


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
     "run pytest", "pytest"),
    ("terminal", {"command": "API_KEY=sk-123 python deploy.py --token x"},
     "run python", "python"),
    ("terminal", {"command": "curl -H 'Authorization: Bearer x' https://h"}, "run curl", "curl"),
    ("terminal", {"command": "git commit -m 'msg SECRET'"}, "run git commit", "git commit"),
    ("terminal", {"command": "python3 -m pytest"},
     "run python3 pytest", "python3 pytest"),
    ("terminal", {"command": "pytest tests/test_x.py"},
     "run pytest", "pytest"),
    ("terminal", {"command": "cat .env.local | grep KEY"}, "run cat", "cat"),
    ("terminal", {"command": "echo sk-live-abcdef"}, "run echo", "echo"),
    ("terminal", {"command": "export TOKEN=abc && make"}, "run export", "export"),
    ("terminal", {"command": "mysql -uroot -pS3cr3t db"}, "run mysql", "mysql"),
    ("terminal", {"command": "psql -W secretpw"}, "run psql", "psql"),
    ("terminal", {"command": "deploy --token abcsecret"}, "run deploy", "deploy"),
    ("terminal", {"command": "git -C somedir status"}, "run git", "git"),
    ("terminal", {"command": "python -m mypkg.cli --key v"}, "run python mypkg", "python mypkg"),
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
    def setUp(self):
        # The process identity (pwd, expanduser) never leaks into these tests.
        orig = act._system_identity
        act._system_identity = lambda: ([], [], [])
        self.addCleanup(setattr, act, "_system_identity", orig)
        act.reset_state()
        self.addCleanup(act.reset_state)

    def test_cases(self):
        for tool, args, line, query in CASES:
            with self.subTest(tool=tool, args=args):
                a = act.activity_for(tool, args, cwd=PROJ)
                self.assertIsNotNone(a)
                self.assertEqual(a.line, line)
                self.assertEqual(act.query_for(a), query)

    def test_query_never_has_the_verb(self):
        for tool, args, line, _ in CASES:
            a = act.activity_for(tool, args, cwd=PROJ)
            verb = line.split(" ", 1)[0]
            self.assertFalse(act.query_for(a).startswith(verb + " "), line)

    def world(self):
        base = temp_base()
        home = os.path.join(base, "Users", "alice")
        proj = os.path.join(home, "code", "proj")
        make_tree(proj, [".git/"])
        return base, home, proj, {"USER": "alice", "HOME": home}

    def test_paths(self):
        base, home, proj, env = self.world()
        n = act.normalize_path
        self.assertEqual(n(os.path.join(proj, "src", "x.py"), proj, env), "src/x.py")
        self.assertEqual(n("x.py", os.path.join(proj, "src"), env), "src/x.py")
        self.assertEqual(n("src/../a.py", proj, env), "a.py")
        self.assertEqual(n("a\\b\\c.py", proj, env), "a/b/c.py")
        self.assertEqual(n("~/code/proj/a.md", proj, env), "a.md")
        # Privacy amendment 4: everything outside the root is no query.
        for raw in (os.path.join(home, "notes.txt"), "~/notes/z.md", "~", "~bob/x.md",
                    "../../etc/passwd", "../other/x.py", "./", "", None, "C:foo.md",
                    "\\\\?\\C:\\", "/mnt/c:", "docs/a:b.md"):
            with self.subTest(raw=raw):
                self.assertIsNone(n(raw, proj, env))
        self.assertIsNone(n("src/x.py", "", env))
        self.assertIsNone(n("src/x.py", home, env))
        self.assertIsNone(n("src/x.py", base, env))
        # Over TARGET_CHARS is no query, never a cut.
        self.assertIsNone(n("d/" * 300 + "f.py", proj, env))
        self.assertEqual(n("a" * 196 + ".py", proj, env), "a" * 196 + ".py")

    def test_project_root(self):
        base, home, proj, env = self.world()
        self.assertEqual(act.project_root(proj, env), proj)
        self.assertEqual(act.project_root(os.path.join(proj, "a", "b"), env), proj)
        self.assertIsNone(act.project_root("", env))
        self.assertIsNone(act.project_root("relative/dir", env))
        # HOME and its ancestors are never a root, and the search stops there.
        make_tree(home, [".git/", "notes/"])
        make_tree(base, ["Users/package.json"])
        act.reset_state()
        self.assertIsNone(act.project_root(home, env))
        self.assertIsNone(act.project_root(os.path.join(home, "notes"), env))
        self.assertEqual(act.project_root(proj, env), proj)
        # Every marker, and *.sln.
        for i, marker in enumerate(act.ROOT_MARKERS + ("App.sln",)):
            d = os.path.join(base, "srv", "p%d" % i)
            make_tree(d, [marker + ("/" if marker in (".git", ".hg") else "")])
            self.assertEqual(act.project_root(os.path.join(d, "src"), env), d, marker)

    def test_project_root_top_level(self):
        """The filesystem root is never a root; other direct children of it
        (`/app`, `/workspace`) can be, except homes locations and `/mnt`."""
        orig = act._fixed_marker
        act._fixed_marker = lambda directory: True
        self.addCleanup(setattr, act, "_fixed_marker", orig)
        act.reset_state()
        self.addCleanup(act.reset_state)
        top = os.path.realpath(os.sep)
        self.assertIsNone(act.project_root(top, {"HOME": top}))
        for name in ("home", "Users", "mnt"):
            self.assertIsNone(act.project_root(os.path.join(top, name), {"HOME": top}), name)
        app = os.path.join(top, "nonexistent-ct-app")
        self.assertEqual(act.project_root(app, {"HOME": top}), os.path.realpath(app))
        deep = os.path.join(top, "nonexistent-ct", "app")
        self.assertEqual(act.project_root(deep, {"HOME": top}), os.path.realpath(deep))

    def test_project_root_cached_and_no_subprocess(self):
        base = temp_base()
        d = os.path.join(base, "srv", "late")
        make_tree(d, ["src/"])
        act.reset_state()
        self.addCleanup(act.reset_state)
        import subprocess

        def no_subprocess(*a, **k):
            raise AssertionError("project_root must not run a subprocess")

        for mod, names in ((subprocess, ("Popen", "run", "call", "check_call", "check_output")),
                           (os, ("system", "popen", "posix_spawn", "posix_spawnp", "spawnv",
                                 "spawnve", "spawnvp", "spawnvpe", "spawnl", "spawnle",
                                 "spawnlp", "spawnlpe", "execv", "execve", "fork"))):
            for name in names:
                if hasattr(mod, name):
                    self.addCleanup(setattr, mod, name, getattr(mod, name))
                    setattr(mod, name, no_subprocess)
        self.assertIsNone(act.project_root(d, {}))
        self.assertEqual(act.activity_for("read_file", {"path": "src/a.py"}, cwd=d, env={}), None)
        make_tree(d, [".git/"])
        self.assertIsNone(act.project_root(d, {}))  # "no root" cached briefly
        now = [1000.0]
        orig_clock = act._root_clock
        act._root_clock = lambda: now[0]
        self.addCleanup(setattr, act, "_root_clock", orig_clock)
        act.reset_state()
        self.assertEqual(act.project_root(d, {}), d)
        make_tree(base, ["srv/late2/"])
        d2 = os.path.join(base, "srv", "late2")
        self.assertIsNone(act.project_root(d2, {}))
        make_tree(d2, ["go.mod"])
        now[0] += act._ROOT_CACHE_TTL + 1
        self.assertEqual(act.project_root(d2, {}), d2)

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
                self.assertIsNone(act.activity_for(tool, args, cwd=PROJ))

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
            a = act.activity_for(tool, args, cwd=PROJ)
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
            a = act.activity_for("terminal", {"command": command}, cwd=PROJ)
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
        """Privacy amendment 4: on a real temp tree, every query is a path
        strictly inside the cwd's project root, never naming the user."""
        rng = random.Random(20261019)
        base = temp_base()
        home = os.path.join(base, "Users", "zelda")
        proj = os.path.join(home, "code", "proj")
        other = os.path.join(base, "srv", "other")
        make_tree(base, ["Users/zelda/code/proj/.git/", "Users/zelda/code/proj/src/",
                         "Users/zelda/private/", "srv/other/package.json", "home/bob/",
                         "Users/package.json"])
        try:
            os.symlink(os.path.join(home, "private"), os.path.join(proj, "escape"),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            pass
        # `base` stands in for `/`: it and its direct children are top level.
        orig_root = act._fs_root
        act._fs_root = lambda d: d == base or not d.startswith(base + os.sep)
        self.addCleanup(setattr, act, "_fs_root", orig_root)
        act.reset_state()
        self.addCleanup(act.reset_state)
        envs = [{"USER": "zelda", "HOME": home}, {"USERNAME": "zelda", "HOME": base},
                {"LOGNAME": "zelda"}, {"USER": "zelda", "HOME": base + os.sep}]
        heads = [proj, home, base, other, "~", "~/code/proj", "..", "../..", "", ".",
                 "C:", "C:..", "\\\\?\\C:", "/mnt/c:", "\\etc",
                 os.path.join(base, "home", "bob"), os.path.join(proj, "escape"),
                 os.path.join(proj, "src")]
        mids = ["clients", "acme", "zelda", "Zelda", "src", "..", ".", "home", "Users",
                "secret-plans", "d\u00e9j\u00e0", "zelda.txt", "my-zelda", "ZELDA@corp",
                "root", "node", "zz", "a:b"]
        cwds = [proj, os.path.join(proj, "src"), home, base, other, "",
                os.path.join(base, "home"), os.path.join(home, "code")]
        sent = 0
        for _ in range(1500):
            segs = [rng.choice(mids) for _ in range(rng.randint(0, 4))]
            head = rng.choice(heads)
            sep = rng.choice(["/", "\\"])
            raw = sep.join(([head] if head else []) + segs + ["f%d.md" % rng.randint(0, 9)])
            cwd, env = rng.choice(cwds), rng.choice(envs)
            a = act.activity_for(rng.choice(["read_file", "write_file", "patch"]),
                                 {"path": raw}, cwd=cwd, env=env)
            if a is None:
                continue
            sent += 1
            query = act.query_for(a)
            comps = query.split("/")
            ctx = (raw, cwd, env, query)
            self.assertNotIn("zelda", query.casefold(), ctx)
            self.assertNotIn(base, query, ctx)
            for bad in ("\\", ":", "~"):
                self.assertNotIn(bad, query, ctx)
            self.assertFalse(set(comps) & {"", ".", ".."}, ctx)
            self.assertTrue(a.line.endswith(" " + query), ctx)
            root = act.project_root(cwd, env)
            self.assertIn(root, (proj, other), ctx)
            # No output component exists outside the root.
            real = os.path.realpath(os.path.join(root, *comps))
            self.assertIsNotNone(act._below(real, root), ctx)
        self.assertGreater(sent, 50)

    def test_credential_shaped_search_pattern_rejected(self):
        for pattern in ("sk-live-abcdef", "find ghp_abcdefghijklmnop1234 here",
                        "AKIAABCDEFGHIJKLMNOP", "token a1b2c3d4e5f6g7h8i9"):
            self.assertIsNone(act.activity_for("search_files", {"pattern": pattern}, cwd=PROJ),
                              pattern)
        self.assertIsNotNone(act.activity_for("search_files", {"pattern": "error 404"}, cwd=PROJ))

    def test_own_marker_or_heading_is_never_a_target(self):
        for pattern in ("ct-fact:evil", "## Curated Thoughts \u2014 relevant now", "a\nb"):
            self.assertIsNone(act.activity_for("search_files", {"pattern": pattern}, cwd=PROJ))

    def test_query_caps(self):
        a = act.activity_for("search_files", {"pattern": "x" * 80, "path": "y" * 600}, cwd=PROJ)
        self.assertLessEqual(len(a.line), len("search ") + 80 + len(" in ") + act.TARGET_CHARS)
        self.assertLessEqual(len(act.query_for(a)), act.ACTIVITY_QUERY_CHARS)
        self.assertLessEqual(len(a.query), act.TARGET_CHARS)
        # 0.6.3 allowlist: over 80 chars is refused, never truncated.
        self.assertIsNone(act.activity_for("search_files", {"pattern": "x" * 81}, cwd=PROJ))

    def test_keys_use_full_local_path(self):
        base = temp_base()
        make_tree(base, ["srv/a/.git/", "srv/b/.git/"])
        pa, pb = os.path.join(base, "srv", "a"), os.path.join(base, "srv", "b")
        a = act.activity_for("read_file", {"path": "README.md"}, cwd=pa, env={})
        b = act.activity_for("read_file", {"path": "README.md"}, cwd=pb, env={})
        self.assertEqual((a.query, b.query), ("README.md", "README.md"))
        self.assertNotEqual(a.key, b.key)
        # The same file by two spellings is one key; read/write/edit fold.
        c = act.activity_for("patch", {"path": os.path.join(pa, "README.md")}, cwd=pa, env={})
        self.assertEqual(a.key, c.key)
        # The key never holds the raw path.
        self.assertNotIn(base, repr(a.key))

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

    def test_user_names_and_name_hit(self):
        for user in ("root", "node", "app", "user", "admin", "test", "ubuntu", "runner",
                     "docker", "www-data", "nobody", "daemon", "ec2-user", "vscode",
                     "codespace"):
            self.assertEqual(act.user_names({"USER": user, "HOME": "/home/" + user}),
                             frozenset(), user)
        self.assertEqual(act.user_names({"USER": "Alice", "HOME": "/home/bob"}),
                         frozenset({"alice", "bob"}))
        # A HOME / USERPROFILE basename counts under Users, home or Profiles.
        self.assertEqual(act.user_names({"HOME": "/nfs/home/alice"}), frozenset({"alice"}))
        self.assertEqual(act.user_names({"USERPROFILE": "D:\\Profiles\\erin"}),
                         frozenset({"erin"}))
        self.assertEqual(act.user_names({"HOME": "/"}), frozenset())
        self.assertEqual(act.user_names({"USER": "jo"}), frozenset({"jo"}))
        hit = act.name_hit
        self.assertTrue(hit("JO.md", {"jo"}))
        self.assertTrue(hit("docs/jo-notes", {"jo"}))
        self.assertFalse(hit("src/join.py", {"jo"}))
        self.assertTrue(hit("src/Sample.py", {"sam"}))
        self.assertTrue(hit("docs/john_smith.md", {"john smith"}))
        self.assertTrue(hit("docs/John Smith notes.md", {"john smith"}))
        self.assertFalse(hit("docs/plan.md", {"john smith"}))
        self.assertTrue(hit("docs/jose\u0301.md", {"jos\u00e9"}))
        self.assertFalse(hit("anything", frozenset()))

    def test_name_sources(self):
        """Review of PR #61: pw_name always counts; a HOME / USERPROFILE /
        pw_dir basename counts only under Users, home or Profiles."""
        self.assertEqual(act.user_names({"HOME": "/config"}), frozenset())
        self.assertEqual(act.user_names({"HOME": "/github/home"}), frozenset())
        self.assertEqual(act.user_names({"HOME": "/opt/app-root/src"}), frozenset())
        self.assertEqual(act.user_names({"HOME": "/Users/Dana"}), frozenset({"dana"}))
        self.assertEqual(act.user_names({"USERPROFILE": "C:\\Users\\Erin"}), frozenset({"erin"}))
        act._system_identity = lambda: (["zed"], ["/home/quinn", "/opt/svc"], ["/opt/svc"])
        self.assertEqual(act.user_names({}), frozenset({"zed", "quinn"}))
        act._system_identity = lambda: (["runner"], ["/home/runner"], ["/home/runner"])
        self.assertEqual(act.user_names({}), frozenset())

    def test_tokenizer_splits_on_any_non_alphanumeric(self):
        for text in ("jo\u2013notes.md", "jo\u2019s.md", "jo\u00d72.md", "jo\u00f7x.md",
                     "jo_x", "x.jo", "jo"):
            self.assertTrue(act.name_hit(text, {"jo"}), text)
        for text in ("join.py", "enjoy", "jo2.md"):
            self.assertFalse(act.name_hit(text, {"jo"}), text)

    def test_git_bash_home(self):
        self.assertEqual(act._git_bash("/c/Users/x", windows=True), "C:\\Users\\x")
        self.assertEqual(act._git_bash("/d", windows=True), "D:\\")
        self.assertEqual(act._git_bash("/c/Users/x", windows=False), "/c/Users/x")
        self.assertEqual(act._git_bash("/srv/x", windows=True), "/srv/x")

    def test_case_folding_only_where_case_insensitive(self):
        orig = act._OS
        self.addCleanup(setattr, act, "_OS", orig)
        act._OS = orig._replace(case_insensitive=True)
        self.assertEqual(act._below("/w/PROJ/Src/X.py", "/w/proj"), ["Src", "X.py"])
        act._OS = orig._replace(case_insensitive=False)
        self.assertIsNone(act._below("/w/PROJ/Src/X.py", "/w/proj"))
        # NFC is normalized everywhere.
        self.assertEqual(act._below("/w/cafe\u0301/a.md", "/w/caf\u00e9"), ["a.md"])

    def test_system_home_stops_the_walk(self):
        """With HOME unset, the process home (expanduser / pw_dir) still is a
        home: a dotfiles repo there is never a root."""
        base = temp_base()
        home = os.path.join(base, "srv", "me")
        make_tree(home, [".git/", "notes/", "code/proj/.git/"])
        act._system_identity = lambda: ([], [home], [home])
        self.assertIsNone(act.project_root(os.path.join(home, "notes"), {}))
        proj = os.path.join(home, "code", "proj")
        self.assertEqual(act.project_root(proj, {}), proj)
        self.assertIsNone(act.normalize_path(os.path.join(home, "notes", "a.md"),
                                             os.path.join(home, "notes"), {}))

    def test_stop_dirs(self):
        base = temp_base()
        orig_root = act._fs_root
        act._fs_root = lambda d: d == base or not d.startswith(base + os.sep)
        self.addCleanup(setattr, act, "_fs_root", orig_root)
        j = lambda *parts: os.path.join(base, *parts)  # noqa: E731
        for d in (base, j("home"), j("Users"), j("USERS"), j("Profiles"), j("mnt"),
                  j("Users", "Alice"), j("home", "bob"), j("Profiles", "erin"),
                  j("var", "home"), j("var", "home", "bob"), j("nfs", "home", "bob"),
                  j("export", "home", "bob"), j("data", "home", "bob"), j("mnt", "c"),
                  j("mnt", "C", "Users"), j("mnt", "c", "Users", "Bob")):
            self.assertTrue(act._stop_dir(d), d)
        for d in (j("srv"), j("app"), j("workspace"), j("srv", "app"), j("Users", "Alice", "code"),
                  j("mnt", "c", "dev"), j("mnt", "cd"), j("x", "mnt", "c"), j("srv", "home"),
                  j("x", "home", "bob"), j("d", "Profiles", "erin"), j("x", "USERS", "bob"),
                  j("srv", "web", "src", "pages", "home", "components"), j("opt", "home", "x")):
            self.assertFalse(act._stop_dir(d), d)

    def test_negative_root_cached_briefly(self):
        base = temp_base()
        d = os.path.join(base, "srv", "fresh")
        make_tree(d, ["src/"])
        now = [5000.0]
        orig_clock = act._root_clock
        act._root_clock = lambda: now[0]
        self.addCleanup(setattr, act, "_root_clock", orig_clock)
        self.assertIsNone(act.project_root(d, {}))
        make_tree(d, [".curated-thoughts-project"])
        now[0] += act._ROOT_NEGATIVE_TTL + 0.1
        self.assertEqual(act.project_root(d, {}), d)
        os.remove(os.path.join(d, ".curated-thoughts-project"))
        now[0] += act._ROOT_NEGATIVE_TTL + 0.1
        self.assertEqual(act.project_root(d, {}), d)  # a found root is kept 30 s
        self.assertGreater(act._ROOT_CACHE_TTL, act._ROOT_NEGATIVE_TTL)

    def test_git_bash_cwd_and_path_args(self):
        """The Git Bash `/c/...` mapping applies to the cwd and path args too
        (wiring checked on any platform by mapping into a temp project)."""
        base = temp_base()
        proj = os.path.join(base, "dev", "proj")
        make_tree(proj, [".git/"])
        orig = act._git_bash
        act._git_bash = lambda p, windows=None: (
            os.path.join(base, *p.split("/")[2:]) if p.startswith("/c/") else p)
        self.addCleanup(setattr, act, "_git_bash", orig)
        a = act.activity_for("read_file", {"path": "/c/dev/proj/src/a.py"}, cwd="/c/dev/proj",
                             env={})
        self.assertEqual(a.query, "src/a.py")

    def test_root_cache_is_lru_and_keyed_on_raw_strings(self):
        base = temp_base()
        make_tree(base, ["srv/a/.git/", "srv/b/.git/"])
        calls = []
        orig = act._real

        def counting(path):
            calls.append(path)
            return orig(path)

        act._real = counting
        self.addCleanup(setattr, act, "_real", orig)
        a, b = os.path.join(base, "srv", "a"), os.path.join(base, "srv", "b")
        self.assertEqual(act.project_root(a, {}), a)
        calls.clear()
        self.assertEqual(act.project_root(a, {}), a)
        self.assertEqual(calls, [], "a cache hit resolves nothing")
        orig_max = act._root_cache.maxsize
        act._root_cache.maxsize = 2
        self.addCleanup(setattr, act._root_cache, "maxsize", orig_max)
        act.project_root(b, {})
        act.project_root(a, {})  # hit: moves a to the end
        act.project_root(os.path.join(base, "srv"), {})  # evicts b, not a
        keys = [k[0] for k in act._root_cache]
        self.assertIn(a, keys)
        self.assertNotIn(b, keys)

    def test_sln_scan_only_after_fixed_markers(self):
        base = temp_base()
        make_tree(base, ["p/.git/", "q/App.sln", "r/"])
        orig = os.scandir
        scanned = []
        os.scandir = lambda d: scanned.append(d) or orig(d)
        self.addCleanup(setattr, os, "scandir", orig)
        self.assertTrue(act._has_marker(os.path.join(base, "p")))
        self.assertEqual(scanned, [])
        self.assertTrue(act._has_marker(os.path.join(base, "q")))
        self.assertFalse(act._has_marker(os.path.join(base, "r")))
        self.assertEqual(len(scanned), 2)

    def test_search_key_with_out_of_root_path(self):
        env = {"USER": "alice"}
        a = act.activity_for("search_files", {"pattern": "TODO", "path": "/elsewhere/a"},
                             cwd=PROJ, env=env)
        b = act.activity_for("search_files", {"pattern": "TODO", "path": "/elsewhere/b"},
                             cwd=PROJ, env=env)
        self.assertEqual((a.line, b.line), ("search TODO", "search TODO"))
        self.assertNotEqual(a.key, b.key)

    def test_subcommand_tools_table(self):
        """Privacy amendment 5: only listed tools send a subcommand, and only
        a listed verb; every verb is a plain word."""
        for tool in ("npx", "pytest", "rm", "cat", "cd", "less", "mkdir", "cp", "mv", "vim"):
            self.assertNotIn(tool, act._SUBCOMMAND_TOOLS, tool)
        for tool, verbs in act._SUBCOMMAND_TOOLS.items():
            for verb in verbs:
                self.assertRegex(verb, act._SUBCOMMAND_RE, (tool, verb))
        for tool in ("make", "just", "rake"):
            self.assertEqual(act._SUBCOMMAND_TOOLS[tool], act._MAKE_TARGETS)
        self.assertTrue(act.word_check("test", set(), act._MAKE_TARGETS))
        self.assertFalse(act.word_check("deploy-prod", set(), act._MAKE_TARGETS))

    def test_python_module_root_lookup_is_lazy(self):
        calls = []
        orig = act.session_cwd

        def counting(task_id=None):
            calls.append(task_id)
            return PROJ

        act.session_cwd = counting
        self.addCleanup(setattr, act, "session_cwd", orig)
        a = act.activity_for("terminal", {"command": "python -m pytest"}, env={}, task_id="t")
        self.assertEqual((a.query, calls), ("python pytest", []))
        a = act.activity_for("terminal", {"command": "python -m mypkg"}, env={}, task_id="t")
        self.assertEqual((a.query, calls), ("python mypkg", ["t"]))
        a = act.activity_for("terminal", {"command": "python -m nothere"}, env={}, task_id="t")
        self.assertEqual(a.query, "python")

    def test_sandbox_home_does_not_block_the_root_above(self):
        """Every home blocks its ancestors, except a sandbox HOME inside the
        candidate root (a dot-dir directly under it, `.cache/home` or
        `tmp/home`, and not a real user home), so `repo/.home` does not hide
        `repo`. A real user home (pw_dir) there still blocks it."""
        base = temp_base()
        repo = os.path.join(base, "srv", "repo")
        make_tree(repo, [".git/", ".home/x/"])
        env = {"USER": "svc", "HOME": os.path.join(repo, ".home")}
        self.assertEqual(act.normalize_path("src/x.py", repo, env), "src/x.py")
        self.assertIsNone(act.project_root(os.path.join(repo, ".home", "x"), env))
        act.reset_state()
        act._system_identity = lambda: ([], [os.path.join(repo, ".home")],
                                        [os.path.join(repo, ".home")])
        self.assertIsNone(act.normalize_path("src/x.py", repo, env))

    def test_homes_cached(self):
        calls = []
        orig = act._canon

        def counting(path):
            calls.append(path)
            return orig(path)

        act._canon = counting
        self.addCleanup(setattr, act, "_canon", orig)
        env = {"HOME": os.path.join(temp_base(), "Users", "z")}
        act._homes(env)
        first = len(calls)
        self.assertGreater(first, 0)
        act._homes(env)
        self.assertEqual(len(calls), first, "a homes cache hit resolves nothing")

    def test_sandbox_home_rule(self):
        """Privacy amendment 6: a HOME inside a candidate root does not block
        it only as a sandbox: a dot-dir directly under the root, or
        `.cache/home` / `tmp/home`, and never a real user home."""
        root = os.path.join(os.sep, "w", "repo")
        j = lambda *parts: os.path.join(root, *parts)  # noqa: E731
        for home in (j(".home"), j(".nix-home"), j(".cache", "home"), j("tmp", "home")):
            self.assertTrue(act._sandbox_home(home, root, []), home)
        for home in (j("home"), j("sub", ".home"), j("build", "home"), j(".cache", "x"),
                     os.path.join(os.sep, "elsewhere", ".home"), root):
            self.assertFalse(act._sandbox_home(home, root, []), home)
        self.assertFalse(act._sandbox_home(j(".home"), root, [j(".home")]))

    def test_userprofile_is_the_real_home_without_pwd(self):
        base = temp_base()
        work = os.path.join(base, "d", "work")
        make_tree(work, [".git/", ".winhome/Documents/"])
        env = {"USERPROFILE": os.path.join(work, ".winhome")}
        act._system_identity = lambda: ([], [], [])  # no pwd (Windows)
        self.assertIsNone(act.project_root(os.path.join(work, "tools"), env))
        act.reset_state()
        act._system_identity = lambda: ([], [], ["/elsewhere/me"])  # pwd exists
        self.assertEqual(act.project_root(os.path.join(work, "tools"), env),
                         os.path.realpath(work))

    def test_python_flags_and_exe_suffix(self):
        for cmd, q in (("python -u -m pytest", "python pytest"),
                       ("python -X dev -W ignore -m pip", "python pip"),
                       ("python -X", "python"), ("python -m", "python"),
                       ("git.exe status", "git status"), ("GIT.EXE status", "GIT status"),
                       ("python3.exe -m pytest", "python3 pytest"),
                       ("python -mpytest", "python pytest"),
                       ("python3 -umpytest -q", "python3 pytest"),
                       ("python -mnothere", "python"),
                       ("python3.11.2 -m pytest", None), ("run.ps1", None)):
            self.assertEqual(act.command_target(cmd, {}, frozenset()), q, cmd)
        self.assertIsNone(act._PYTHON_RE.match("python3.11.2"))
        self.assertIsNotNone(act._PYTHON_RE.match("python3.11"))

    def test_project_package_cached_and_top_only(self):
        base = temp_base()
        make_tree(base, ["tests/__init__.py"])
        calls = []
        orig = os.listdir
        os.listdir = lambda p: calls.append(p) or orig(p)
        self.addCleanup(setattr, os, "listdir", orig)
        self.assertEqual(act._project_package("tests.acme_merger_due_diligence", base), "tests")
        first = len(calls)
        self.assertEqual(act._project_package("tests.other", base), "tests")
        self.assertEqual(len(calls), first, "cached per (root, top)")
        self.assertIsNone(act._project_package("nothere.x", base))

    def test_sent_python_module_string_is_name_checked(self):
        """Re-review finding 7: a multi-word name that only appears once the
        program and the module are joined ("n p" in "python pytest")."""
        self.assertEqual(act.command_target("python -m pytest", names=frozenset({"n p"})),
                         "python")
        self.assertEqual(act.command_target("python -m pytest", names=frozenset({"alice"})),
                         "python pytest")

    def test_python_module_flag_parsing(self):
        pm = act._python_module
        for rest, module in ((["-m", "pytest"], "pytest"), (["-u", "-m", "pytest"], "pytest"),
                             (["-uB", "-m", "x"], "x"), (["-OO", "-m", "x"], "x"),
                             (["-Xdev", "-m", "x"], "x"), (["-X", "dev", "-m", "x"], "x"),
                             (["-Wignore", "-m", "x"], "x"), (["-W", "ignore", "-m", "x"], "x"),
                             (["-i", "-R", "-x", "-m", "x"], "x"), (["-um", "x"], "x"),
                             (["-BXdev", "-m", "x"], "x"),
                             (["--version", "-m", "x"], None), (["-c", "code", "-m", "x"], None),
                             (["-mpytest"], "pytest"), (["-umpytest", "-q"], "pytest"),
                             (["-BOmhttp.server"], "http.server"), (["-mu", "x"], "u"),
                             (["-Z", "-m", "x"], None), (["-X"], None),
                             (["-m"], None), (["script.py", "-m", "x"], None), ([], None),
                             (["-", "-m", "x"], None)):
            self.assertEqual(pm(rest), module, rest)

    def test_project_package_must_be_real_and_exact_case(self):
        base = temp_base()
        make_tree(base, ["ns/x.py", "Tests/__init__.py", "src/app/__init__.py", "tool.py",
                         "Tool2.py"])
        pp = act._project_package
        self.assertIsNone(pp("ns.x", base), "a folder without __init__.py")
        self.assertIsNone(pp("tests", base), "case differs (Tests)")
        self.assertEqual(pp("Tests.y", base), "Tests")
        self.assertEqual(pp("app.cli", base), "app")
        self.assertEqual(pp("tool", base), "tool")
        self.assertIsNone(pp("tool2", base), "case differs (Tool2.py)")

    def test_project_package_negative_cache_is_short(self):
        base = temp_base()
        now = [100.0]
        orig = act._root_clock
        act._root_clock = lambda: now[0]
        self.addCleanup(setattr, act, "_root_clock", orig)
        self.assertIsNone(act._project_package("late", base))
        make_tree(base, ["late/__init__.py"])
        self.assertIsNone(act._project_package("late", base))  # cached briefly
        now[0] += act._ROOT_NEGATIVE_TTL + 0.1
        self.assertEqual(act._project_package("late", base), "late")

    def test_files_inside_an_inner_home_are_never_sent(self):
        """A sandbox HOME inside the repo does not hide the repo, but nothing
        inside it is ever sent, including through a Git Bash HOME form."""
        base = temp_base()
        repo = os.path.join(base, "d", "work")
        make_tree(repo, [".git/", ".home/Documents/", ".home/.aws/", "src/"])
        env = {"USER": "al", "HOME": os.path.join(repo, ".home")}
        n = act.normalize_path
        self.assertEqual(n("src/x.py", repo, env), "src/x.py")
        for raw in (".home/Documents/taxes.pdf", ".home/.aws/credentials", ".home",
                    os.path.join(repo, ".home", "Documents", "taxes.pdf")):
            self.assertIsNone(n(raw, repo, env), raw)
        # Git Bash: HOME=/d/work/.home names the same folder (mapped on win32).
        orig = act._git_bash
        act._git_bash = lambda p, windows=None: (
            os.path.join(base, *p.split("/")[1:]) if p.startswith("/d/") else p)
        self.addCleanup(setattr, act, "_git_bash", orig)
        act.reset_state()
        env = {"USER": "al", "HOME": "/d/work/.home"}
        self.assertEqual(n("src/x.py", repo, env), "src/x.py")
        self.assertIsNone(n(".home/Documents/taxes.pdf", repo, env))

    def test_blocked_requires_user_homes(self):
        """No fail-open default: calling without `user` is an error, and a
        real user home inside a candidate root blocks it even at a sandbox
        path, while the same folder as a plain sandbox HOME does not."""
        base = temp_base()
        repo = os.path.join(base, "srv", "repo")
        home = os.path.join(repo, ".home")
        make_tree(repo, [".git/", ".home/", "src/"])
        with self.assertRaises(TypeError):
            act._blocked(repo, [], [home])
        with self.assertRaises(TypeError):
            act._find_root(os.path.join(repo, "src"), [], [home])
        self.assertFalse(act._blocked(repo, [home], [home], []))
        self.assertTrue(act._blocked(repo, [home], [home], [home]))
        self.assertEqual(act._find_root(os.path.join(repo, "src"), [home], [home], []), repo)
        self.assertIsNone(act._find_root(os.path.join(repo, "src"), [home], [home], [home]))

    def test_project_package_stats_before_listing(self):
        base = temp_base()
        make_tree(base, ["pkg/__init__.py", "Tests/__init__.py"])
        listed = []
        orig = os.listdir
        os.listdir = lambda p: listed.append(p) or orig(p)
        self.addCleanup(setattr, os, "listdir", orig)
        self.assertIsNone(act._project_package("nothere", base))
        self.assertEqual(listed, [], "a miss lists nothing")
        self.assertEqual(act._project_package("pkg.sub", base), "pkg")
        self.assertTrue(listed, "a hit confirms the exact case by listing")
        if act._OS.case_insensitive:
            self.assertIsNone(act._project_package("tests", base))

    def test_inner_homes_computed_once_per_root(self):
        base = temp_base()
        repo = os.path.join(base, "srv", "repo")
        make_tree(repo, [".git/", ".home/", "src/"])
        env = {"USER": "svc", "HOME": os.path.join(repo, ".home")}
        calls = []
        orig = act._homes
        act._homes = lambda e: calls.append(1) or orig(e)
        self.addCleanup(setattr, act, "_homes", orig)
        for name in ("a.py", "b.py", "c.py"):
            self.assertEqual(act.normalize_path("src/" + name, repo, env), "src/" + name)
        self.assertIsNone(act.normalize_path(".home/x", repo, env))
        self.assertEqual(len(calls), 1, "homes looked up once for the root and its inner list")

    def test_ttl_cache(self):
        now = [0.0]
        orig = act._root_clock
        act._root_clock = lambda: now[0]
        self.addCleanup(setattr, act, "_root_clock", orig)
        cache = act._TTLCache(2)
        cache.put("a", 1)
        cache.put("b", None)
        self.assertEqual(cache.get("a", 5), (True, 1))
        self.assertEqual(cache.get("b", lambda v: 1 if v is None else 5), (True, None))
        now[0] = 2
        self.assertEqual(cache.get("b", lambda v: 1 if v is None else 5), (False, None))
        self.assertEqual(cache.get("a", lambda v: 1 if v is None else 5), (True, 1))
        cache.put("c", 3)  # evicts the least recently used ("b")
        self.assertEqual(sorted(cache), ["a", "c"])

    def test_word_check(self):
        names = {"alice"}
        for word in ("test", "run-script", "rebase", "build2"):
            self.assertIs(act.word_check(word, names), True, word)
        for word in ("alice", "alicetools", "x/alice_notes.txt", "tests/billing", "mypkg.cli",
                     "deploy.py", "Build", "../x", "/etc/passwd", "~/x", "C:foo", "a\\b", "-v",
                     "a" * 32, "abc1def2ghi3jkl4m"):
            self.assertIs(act.word_check(word, names), False, word)

    def test_realpath_root_rechecked(self):
        """A cwd symlinked into HOME (or an ancestor, or a homes location)
        finds a root by its logical path; the real root fails the stop rules
        again, so nothing is sent."""
        base = temp_base()
        home = os.path.join(base, "srv", "bob")
        make_tree(home, [".git/", "Documents/", "code/proj/.git/"])
        link = os.path.join(base, "work", "link")
        good = os.path.join(base, "work", "good")
        os.makedirs(os.path.dirname(link))
        try:
            os.symlink(home, link, target_is_directory=True)
            os.symlink(os.path.join(home, "code", "proj"), good, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        env = {"USER": "bob", "HOME": home}
        self.assertIsNone(act.project_root(link, env))
        self.assertIsNone(act.normalize_path("Documents/taxes.pdf", link, env))
        self.assertEqual(act.project_root(good, env), os.path.realpath(os.path.join(home, "code", "proj")))

    def test_canon_maps_the_macos_firmlink_alias(self):
        orig = act._OS, act._real
        self.addCleanup(lambda: (setattr(act, "_OS", orig[0]), setattr(act, "_real", orig[1])))
        act._real = lambda p: p
        act._OS = orig[0]._replace(darwin=True)
        self.assertEqual(act._canon("/System/Volumes/Data/Users/bob"), "/Users/bob")
        self.assertEqual(act._canon("/Users/bob"), "/Users/bob")
        act._OS = orig[0]._replace(darwin=False)
        self.assertEqual(act._canon("/System/Volumes/Data/Users/bob"),
                         "/System/Volumes/Data/Users/bob")

    def test_walk_checks_fixed_markers_before_any_sln_scan(self):
        base = temp_base()
        make_tree(base, ["srv/outer/.git/", "srv/outer/mid/App.sln", "srv/outer/mid/inner/src/",
                         "srv/top.sln"])
        start = os.path.join(base, "srv", "outer", "mid", "inner", "src")
        scanned = []
        orig = os.scandir
        os.scandir = lambda d: scanned.append(d) or orig(d)
        self.addCleanup(setattr, os, "scandir", orig)
        # The nearer *.sln wins over the farther .git; nothing above .git is scanned.
        self.assertEqual(act.project_root(start, {}), os.path.join(base, "srv", "outer", "mid"))
        self.assertNotIn(os.path.join(base, "srv", "outer"), scanned)
        self.assertNotIn(os.path.join(base, "srv"), scanned)
        # Re-walking (after the short "no root" cache) does not rescan.
        before = len(scanned)
        act._root_cache.clear()
        act.project_root(start, {})
        self.assertEqual(len(scanned), before)

    def test_pwd_identity_cached_and_cleared(self):
        self.assertTrue(hasattr(act._pwd_identity, "cache_clear"))
        act._pwd_identity()
        self.assertEqual(act._pwd_identity.cache_info().currsize, 1)
        act.reset_state()
        self.assertEqual(act._pwd_identity.cache_info().currsize, 0)

    def test_session_cwd_is_lazy(self):
        calls = []
        orig = act.session_cwd

        def counting(task_id=None):
            calls.append(task_id)
            return PROJ

        act.session_cwd = counting
        self.addCleanup(setattr, act, "session_cwd", orig)
        act.activity_for("terminal", {"command": "make all"}, env={}, task_id="t1")
        act.activity_for("web_search", {"query": "x"}, env={}, task_id="t1")
        act.activity_for("search_files", {"pattern": "TODO"}, env={}, task_id="t2")
        act.activity_for("read_file", {}, env={}, task_id="t2")
        self.assertEqual(calls, [])
        a = act.activity_for("read_file", {"path": "src/a.py"}, env={}, task_id="t1")
        self.assertEqual(a.query, "src/a.py")
        act.activity_for("search_files", {"pattern": "TODO", "path": "src"}, env={},
                         task_id="t3")
        self.assertEqual(calls, ["t1", "t3"])

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
        return act.activity_for(tool, {"path": path}, cwd=PROJ).key

    @staticmethod
    def admit(st, sid, req, key):
        """What transform_tool_result does: claim the step and the key at once."""
        return st.start(sid, req, key)

    def test_one_start_per_step(self):
        st = act.ActivityState()
        self.assertIsNone(self.admit(st, "s", "t:api:1", self.key("read_file", "a.py")))
        self.assertEqual(self.admit(st, "s", "t:api:1", self.key("read_file", "b.py")),
                         "step_used")
        self.assertIsNone(self.admit(st, "s", "t:api:2", self.key("read_file", "b.py")))

    def test_seen_key_and_file_fold(self):
        st = act.ActivityState()
        self.assertIsNone(self.admit(st, "s", "r1", self.key("read_file", "a.py")))
        self.assertEqual(self.admit(st, "s", "r2", self.key("patch", "a.py")), "seen_key")
        self.assertEqual(self.admit(st, "s", "r3", self.key("write_file", "a.py")), "seen_key")
        # a rejected key does not consume the step
        self.assertIsNone(self.admit(st, "s", "r3", self.key("read_file", "c.py")))

    def test_lru_and_sessions(self):
        st = act.ActivityState()
        for i in range(act.RECENT_KEYS_MAX + 1):
            self.assertIsNone(self.admit(st, "s", "r%d" % i, self.key("read_file", "f%d.py" % i)))
        self.assertIsNone(self.admit(st, "s", "rx", self.key("read_file", "f0.py")))  # evicted
        self.assertIsNone(self.admit(st, "other", "r1", self.key("read_file", "f1.py")))

    def test_run_and_search_keys_distinct_from_files(self):
        st = act.ActivityState()
        self.assertIsNone(self.admit(st, "s", "r1", act.activity_for(
            "terminal", {"command": "make test"}, cwd=PROJ).key))
        self.assertIsNone(self.admit(st, "s", "r2", act.activity_for(
            "search_files", {"pattern": "make test"}, cwd=PROJ).key))
        self.assertEqual(self.admit(st, "s", "r3", act.activity_for(
            "terminal", {"command": "make test -j4"}, cwd=PROJ).key), "seen_key")

    def test_start_records_step_and_key_and_release_key(self):
        st = act.ActivityState()
        k = self.key("read_file", "a.py")
        self.assertIsNone(st.start("s", "r1", k))
        self.assertEqual(st.peek("s", "r1", k), "step_used")
        self.assertEqual(st.peek("s", "r2", k), "seen_key")
        st.release_key("s", k)  # the step stays used, the key is free
        self.assertEqual(st.start("s", "r1", k), "step_used")
        self.assertIsNone(st.start("s", "r2", k))

    def test_peek_is_pure(self):
        """Finding 6: a peek records nothing, not even session or key recency."""
        st = act.ActivityState()
        k = self.key("read_file", "a.py")
        self.assertIsNone(st.start("s", "r1", k))
        for i in range(act.SESSIONS_MAX + 1):
            self.assertIsNone(st.peek("other%d" % i, "r1", k))
        self.assertEqual(st.peek("s", "r2", k), "seen_key", "peeks evicted a real session")
        keys = [self.key("read_file", "f%d.py" % i) for i in range(act.RECENT_KEYS_MAX)]
        for i, key in enumerate(keys[1:], 2):
            self.assertIsNone(st.start("s", "r%d" % i, key))
        st.peek("s", "rx", k)  # must not refresh k's recency
        self.assertIsNone(st.start("s", "ry", self.key("read_file", "new.py")))
        self.assertIsNone(st.peek("s", "rz", k), "a peek refreshed the key's recency")


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
        env_patch = mock.patch.dict(os.environ, {"TERMINAL_CWD": PROJ})
        env_patch.start()
        self.addCleanup(env_patch.stop)
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
            (act, "_ct_warm", lambda: True),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)

    def post(self, result, tool="read_file", args=None, sid="s1", call="c1", req="t:api:1"):
        return act.on_transform_tool_result(
            tool_name=tool, args={"path": "src/x.py"} if args is None else args,
            result=result, task_id="", session_id=sid, tool_call_id=call, turn_id="t",
            api_request_id=req, duration_ms=5, status="ok", error_type=None,
            error_message=None)


READ_RESULT = json.dumps({"content": "1|print('hi')\n", "total_lines": 1}, ensure_ascii=False)
# A terminal result that proves the command ran (terminal_tool_result.py:255
# at the pin): proves_ran needs a JSON object with an int exit_code.
TERMINAL_OK = json.dumps({"output": "pushed", "exit_code": 0, "error": None})


class TestDelivery(Harness):
    def test_happy_path_json_object(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"old1"})
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
        out = self.post(result, tool="write_file", args={"path": "a.py", "content": "x"})
        data = json.loads(out.strip())
        self.assertIn("bytes_written", data)
        self.assertFalse(data.get("error"))

    def test_terminal_result_gets_the_block(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        out = self.post(TERMINAL_OK, tool="terminal", args={"command": "pnpm test"})
        data = json.loads(out)
        self.assertEqual(data["exit_code"], 0)
        self.assertTrue(data[act.ACTIVITY_RESULT_KEY].startswith(act.ACTIVITY_HEADING))
        self.assertEqual(self.calls[0]["text"], "pnpm test")

    def test_patch_result_gets_the_block(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        out = self.post(json.dumps({"success": True, "diff": "--- a\n+++ b\n",
                                    "files_modified": ["/w/a.py"]}),
                        tool="patch",
                        args={"path": "a.py", "old_string": "x", "new_string": "y"})
        self.assertIsNotNone(out)
        self.assertIn(act.ACTIVITY_RESULT_KEY, json.loads(out))
        self.assertEqual(self.calls[0]["text"], "a.py")

    def test_search_files_result_gets_the_block(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        out = self.post(json.dumps({"total_count": 0}), tool="search_files",
                        args={"pattern": "TODO"})
        self.assertIsNotNone(out)
        self.assertIn(act.ACTIVITY_RESULT_KEY, json.loads(out))
        self.assertEqual(self.calls[0]["text"], "TODO")

    def test_non_activity_tool_skips_as_no_activity(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        classes = []
        orig = act._skip
        act._skip = lambda sid, cls, *a, **k: classes.append(cls) or orig(sid, cls, *a, **k)
        self.addCleanup(setattr, act, "_skip", orig)
        self.assertIsNone(self.post(json.dumps({"output": "", "exit_code": 0, "error": None}),
                                    tool="web_search", args={"query": "q"}))
        self.assertEqual(self.calls, [])
        self.assertEqual(classes, ["no_activity"])

    def test_plain_text_result_sends_nothing(self):
        """No activity tool returns plain text at the pin: it proves nothing."""
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNone(self.post("ok 3 passed", tool="terminal",
                                    args={"command": "pnpm test"}))
        self.assertEqual(self.calls, [])

    def test_empty_object_sends_nothing(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNone(self.post("{}"))
        self.assertEqual(self.calls, [])

    def test_unsupported_results_claim_nothing(self):
        for result in ('[1, 2]', '"str"', '42', {"multimodal": True},
                       json.dumps({"content": "x", act.ACTIVITY_RESULT_KEY: "x"})):
            with self.subTest(result=result):
                act.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                self.assertIsNone(self.post(result))
                self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), set())
                self.assertEqual(self.deliveries, [])

    def test_block_shape_and_budget(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.match_result = ({"entries": [item("f1", text="word " * 400)],
                              "corrections": []}, None)
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
        out = self.post(READ_RESULT)
        self.assertEqual(ct_ledger.scan_ids(out), ["f1"])
        self.assertNotIn("f2", ct_ledger.LEDGER_CACHE.get("s1"))

    def test_correction_only_when_superseding_ledger(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"old"})
        self.match_result = ({"entries": [item("f1")], "corrections": [
            item("c_nope", supersedes=["absent"]), item("c1", supersedes=["old"])]}, None)
        block = json.loads(self.post(READ_RESULT))[act.ACTIVITY_RESULT_KEY]
        self.assertIn(ct_ledger.marker("c1"), block)
        self.assertIn("supersedes ct-fact:old", block)
        self.assertNotIn("c_nope", block)

    def test_skips_ids_already_in_ledger(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        self.match_result = ({"entries": [item("f1"), item("f2")], "corrections": []}, None)
        self.assertEqual(ct_ledger.scan_ids(self.post(READ_RESULT)), ["f2"])

    def test_zero_hits(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual(self.deliveries, [])

    def test_seam_called_once_with_documented_keys(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
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
        """The first transform of the step queries; the others pass through."""
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNotNone(self.post(READ_RESULT, call="c2", args={"path": "src/y.py"}))
        self.assertIsNone(self.post(READ_RESULT, call="c1"))
        self.assertEqual([c["text"] for c in self.calls], ["src/y.py"])

    def test_second_claim_of_same_fact_skipped(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNotNone(self.post(READ_RESULT, call="c1", req="r1"))
        self.assertIsNone(self.post(READ_RESULT, call="c2", req="r2", args={"path": "src/y.py"}))


class TestFailClosed(Harness):
    def assert_no_query(self, **kw):
        self.assertIsNone(self.post(READ_RESULT, **kw))
        self.assertEqual(self.calls, [])

    def test_no_ledger(self):
        self.assert_no_query()
        self.assertIsNone(self.post(READ_RESULT))

    def test_ledger_dropped_between_hooks(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        ct_ledger.LEDGER_CACHE.clear()
        self.assertIsNone(self.post(READ_RESULT))

    def test_empty_ids(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assert_no_query(req="")
        self.assert_no_query(call="")
        self.assertIsNone(self.post(READ_RESULT, req=""))
        self.assertIsNone(self.post(READ_RESULT, call=""))
        self.assertIsNone(self.post(READ_RESULT, sid=""))
        self.assertEqual(self.calls, [])

    def test_ct_tool_never_triggers(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assert_no_query(tool="mcp__curated-thoughts__curated_recall_context",
                             args={"query": "src/x.py", "path": "src/x.py"})
        self.assertIsNone(self.post(READ_RESULT, tool="mcp__curated-thoughts__curated_recall_context",
                                    args={"query": "src/x.py", "path": "src/x.py"}, req="r2"))
        self.assertEqual(self.calls, [])

    def test_breaker_open(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            ct_wisdom_live._BREAKER.record_failure()
        self.assert_no_query()

    def test_timeout_and_exit_feed_shared_breaker(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        for i, cls in enumerate(["timeout", "exit", "timeout"]):
            self.match_result = (None, cls)
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
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual(sorted(resets), ["reset_capability_cache", "reset_discovery_cache"])

    def test_discovery_and_capability(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        orig = ct_wisdom.discover_ct
        ct_wisdom.discover_ct = lambda env=None: (None, "discovery_miss")
        self.assertIsNone(self.post(READ_RESULT))
        ct_wisdom.discover_ct = orig
        orig_cap = ct_wisdom_live.has_match_capability
        ct_wisdom_live.has_match_capability = lambda p: False
        self.addCleanup(setattr, ct_wisdom_live, "has_match_capability", orig_cap)
        self.assertIsNone(self.post(READ_RESULT, call="c2", req="r2", args={"path": "b.py"}))
        self.assertEqual(self.calls, [])

    def late_spawn(self):
        """_spawn that does not run the worker and moves the clock past the
        budget (so the transform's wait is zero); returns the held targets."""
        started = []
        now = [100.0]
        orig_clock = act._clock
        act._clock = lambda: now[0]
        self.addCleanup(setattr, act, "_clock", orig_clock)

        def spawn(target):
            started.append(target)
            now[0] += ct_wisdom_live.LIVE_TIMEOUT + 0.01

        act._spawn = spawn
        return started

    def test_budget_exceeded(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        started = self.late_spawn()
        self.assertIsNone(self.post(READ_RESULT))
        started[0]()  # the late thread finishes: its result is discarded
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), set())
        self.assertEqual(self.deliveries, [])

    def test_transform_never_raises_when_the_builder_does(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        orig = act.activity_for

        def boom(*a, **k):
            raise RuntimeError("boom")

        act.activity_for = boom
        self.addCleanup(setattr, act, "activity_for", orig)
        self.assertIsNone(self.post(READ_RESULT))

    def test_transform_never_raises(self):
        self.assertIsNone(act.on_transform_tool_result())
        ct_ledger.LEDGER_CACHE.put("s1", set())
        orig = act.splice
        act.splice = lambda r, b: (_ for _ in ()).throw(RuntimeError("boom"))
        self.addCleanup(setattr, act, "splice", orig)
        self.assertIsNone(self.post(READ_RESULT))

    def test_steps_are_per_session(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        ct_ledger.LEDGER_CACHE.put("s2", set())
        self.assertIsNotNone(self.post(READ_RESULT, sid="s1"))
        self.assertIsNotNone(self.post(READ_RESULT, sid="s2"))
        self.assertEqual(len(self.calls), 2)


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
            outs[i] = self.post(READ_RESULT, call="c%d" % i, args=args)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(sum(1 for o in outs if o is not None), 1)


# ---------------------------------------------------------------------------
# Amendment 8: approval-gated query, key release, budget miss on the breaker
# ---------------------------------------------------------------------------

# Hermes's in-tool refusals at the pin (ee8dd6c8): tools/terminal_tool.py
# (_error_json, status blocked / pending_approval) and the file write guards
# (tool_error with a BLOCKED / Refusing message).
REFUSALS = (
    json.dumps({"output": "", "exit_code": -1, "error": "BLOCKED: this command matches the "
                "user-defined deny rule 'git push*'.", "status": "blocked"}),
    json.dumps({"output": "", "exit_code": -1, "error": "BLOCKED: User denied this command.",
                "status": "blocked", "user_summary": "denied"}),
    json.dumps({"output": "", "exit_code": -1, "error": "", "status": "pending_approval",
                "approval_pending": True, "command": "git push", "description": "push"}),
    json.dumps({"error": "BLOCKED: write to SSH config file(s) (x) denied."}),
    json.dumps({"error": "Refusing to write to sensitive system path: /etc/hosts"}),
)
# Finding 4: wording and statuses beyond the exact prefixes above. Real
# strings at the pin: terminal_tool.py's fallback "Command denied: ...",
# approval.py's "approval_required" action-gate status and its "denied by
# user" / "was not approved" reasons, the MCP trust gate's "did not approve
# ... was NOT run", async delegation's "rejected", plus case variants.
MORE_REFUSALS = (
    json.dumps({"output": "", "exit_code": -1, "error": "Command denied: rm -rf. Use the "
                "approval prompt to allow it, or rephrase the command.", "status": "blocked"}),
    json.dumps({"error": "Command denied: flagged"}),
    json.dumps({"approved": False, "status": "approval_required", "command": "x",
                "description": "dangerous", "message": "Asking the user for approval."}),
    json.dumps({"status": "Blocked"}),
    json.dumps({"status": "DENIED"}),
    json.dumps({"status": "rejected", "error": "capacity"}),
    json.dumps({"status": "refused"}),
    json.dumps({"error": "blocked: lower-case prefix"}),
    json.dumps({"error": "  refusing to write"}),
    json.dumps({"error": "Action was not approved: the approval prompt was not answered."}),
    json.dumps({"error": "Command denied by user."}),
    json.dumps({"message": "Write denied by the user's policy."}),
    json.dumps({"error": "The user did not approve running write-capable MCP tool 'x'. "
                "The command was NOT run."}),
    json.dumps({"output": "", "approval_pending": True}),
    "BLOCKED: plain-text refusal",
    "  blocked by policy",
)
GIT_PUSH = {"command": "git push origin main"}


class CountingBreaker(ct_wisdom_live.Breaker):
    def __init__(self):
        super().__init__()
        self.failures = 0
        self.successes = 0

    def record_failure(self):
        self.failures += 1
        super().record_failure()

    def record_success(self):
        self.successes += 1
        super().record_success()


class TestApprovalGate(Harness):
    def setUp(self):
        super().setUp()
        self.breaker = CountingBreaker()
        ct_wisdom_live._BREAKER = self.breaker
        ct_ledger.LEDGER_CACHE.put("s1", set())

    def test_blocked_call_does_not_hold_the_step(self):
        """A call Hermes blocks before it runs (another plugin, a denied
        approval directive, guardrails) never reaches the transform, and the
        plugin registers no pre_tool_call hook (TestRegistration), so it
        leaves no trace: the next call of the same step queries."""
        self.assertIsNotNone(self.post(READ_RESULT, call="c2"))
        self.assertEqual([c["text"] for c in self.calls], ["src/x.py"])

    def test_refused_call_sends_nothing_and_frees_the_step(self):
        for result in REFUSALS:
            with self.subTest(result=result):
                act.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                self.calls.clear()
                self.deliveries.clear()
                self.assertIsNone(self.post(result, tool="terminal", args=GIT_PUSH))
                self.assertEqual(self.calls, [])
                self.assertEqual(self.deliveries, [])
                # The step is free again: a later call of the same step queries.
                self.assertIsNotNone(self.post(READ_RESULT, call="c2"))
                self.assertEqual([c["text"] for c in self.calls], ["src/x.py"])
                # The refused key was never recorded: it queries when it runs.
                self.post(TERMINAL_OK, tool="terminal", args=GIT_PUSH, call="c3", req="r2")
                self.assertEqual([c["text"] for c in self.calls], ["src/x.py", "git push"])
        self.assertEqual(self.breaker.failures, 0)

    def test_refusal_shapes_prove_nothing(self):
        """Every refusal the old word list caught still sends nothing, for
        every activity tool: none of them carries a proof shape."""
        for result in REFUSALS + MORE_REFUSALS:
            for tool in ("terminal", "read_file", "write_file", "patch", "search_files"):
                with self.subTest(tool=tool, result=result):
                    self.assertFalse(act.proves_ran(tool, act._parse(result)))

    def test_blocked_call_never_reaching_transform_sends_nothing(self):
        """A plugin block, the approve gate's denial, guardrails or ACP edit
        approval stop the call before execution: Hermes runs no transform, so
        nothing is recorded and the same activity queries once it runs."""
        self.post(TERMINAL_OK, tool="terminal", args=GIT_PUSH, call="c2", req="r2")
        self.assertEqual([c["text"] for c in self.calls], ["git push"])
        self.assertEqual(self.breaker.failures, 0)

    def test_query_uses_the_args_that_ran(self):
        """A plugin `modify` directive rewrites args after our pre hook."""
        self.post(READ_RESULT, args={"path": "src/y.py"})
        self.assertEqual([c["text"] for c in self.calls], ["src/y.py"])

    def test_modified_to_no_activity_frees_the_step(self):
        self.assertIsNone(self.post(READ_RESULT, args={"path": "/elsewhere/x"}))
        self.post(READ_RESULT, call="c2", args={"path": "src/z.py"})
        self.assertEqual([c["text"] for c in self.calls], ["src/z.py"])

    def test_breaker_open_at_transform_sends_nothing(self):
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            ct_wisdom_live._BREAKER.record_failure()
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual(self.calls, [])


class TestKeyRelease(Harness):
    def setUp(self):
        super().setUp()
        ct_ledger.LEDGER_CACHE.put("s1", set())

    def step(self, req, call, path="src/x.py"):
        args = {"path": path}
        return self.post(READ_RESULT, call=call, req=req, args=args)

    def assert_released(self, why):
        self.assertIsNone(self.step("r1", "c1"), why)
        n = len(self.calls)
        # The step stays used: another call of r1 does not query.
        self.assertIsNone(self.step("r1", "c1b", path="src/other.py"), why)
        self.assertEqual(len(self.calls), n, why)
        # The key is free: a later step retries the same activity.
        self.match_result = ({"entries": [item("f1")], "corrections": []}, None)
        act._spawn = lambda target: target()
        self.assertIsNotNone(self.step("r2", "c2"), why)

    def test_ct_failures_release_the_key(self):
        for cls in ("timeout", "exit", "parse_error", "spawn"):
            with self.subTest(cls=cls):
                act.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker()
                self.match_result = (None, cls)
                self.assert_released(cls)

    def test_budget_releases_the_key(self):
        started = []
        act._spawn = lambda target: started.append(target)
        orig_wait = act._wait
        act._wait = lambda p: False  # the budget ran out
        self.addCleanup(setattr, act, "_wait", orig_wait)
        self.assertIsNone(self.step("r1", "c1"))
        act._wait = orig_wait
        started.pop()()  # the abandoned worker finishes: only now is the key free
        self.assert_released("budget")

    def test_discovery_and_capability_misses_release_the_key(self):
        """The key is freed; the miss itself is remembered for
        CT_UNUSABLE_PAUSE (TestUnusableCt), so the retry comes after it."""
        now = [500.0]
        orig_clock = act._clock
        act._clock = lambda: now[0]
        self.addCleanup(setattr, act, "_clock", orig_clock)
        orig = ct_wisdom.discover_ct
        ct_wisdom.discover_ct = lambda env=None: (None, "discovery_miss")
        self.assertIsNone(self.step("r1", "c1"))
        ct_wisdom.discover_ct = orig
        self.assertIsNone(self.step("r2", "c2"), "still remembered as unusable")
        now[0] += act.CT_UNUSABLE_PAUSE + 1
        self.assertIsNotNone(self.step("r3", "c3"))

    def test_zero_hits_keeps_the_key(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        self.assertIsNone(self.step("r1", "c1"))
        self.assertIsNone(self.step("r2", "c2"))
        self.assertEqual(len(self.calls), 1, "seen_key: no second query")


class TestBudgetBreaker(Harness):
    """recordActivityBudgetMiss: a budget miss counts as ONE breaker failure;
    a refused or never-run call counts zero."""

    def setUp(self):
        super().setUp()
        self.breaker = CountingBreaker()
        ct_wisdom_live._BREAKER = self.breaker
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.started = []
        act._spawn = lambda target: self.started.append(target)
        orig_wait = act._wait
        act._wait = lambda p: False
        self.addCleanup(setattr, act, "_wait", orig_wait)

    def test_budget_miss_counts_once_even_if_ct_later_times_out(self):
        self.match_result = (None, "timeout")
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual(self.breaker.failures, 1)
        self.started[0]()  # the worker's own timeout arrives late
        self.assertEqual((self.breaker.failures, self.breaker.successes), (1, 0))

    def test_late_success_does_not_reset_the_miss(self):
        self.post(READ_RESULT)
        self.started[0]()
        self.assertEqual((self.breaker.failures, self.breaker.successes), (1, 0))

    def test_three_budget_misses_open_the_shared_breaker(self):
        for i in range(ct_wisdom_live.BREAKER_FAILS):
            args = {"path": "f%d.py" % i}
            self.post(READ_RESULT, call="c%d" % i, req="r%d" % i, args=args)
        self.assertTrue(ct_wisdom_live._BREAKER.is_open())

    def test_worker_first_records_its_own_outcome_once(self):
        act._wait = lambda p: p.done.wait(0)
        act._spawn = lambda target: target()
        self.match_result = (None, "timeout")
        self.post(READ_RESULT)
        self.assertEqual(self.breaker.failures, 1)

    def test_cold_budget_miss_is_not_a_breaker_failure(self):
        """Finding 1: on a cold process the 3 s wait also covers discovery and
        the capability probe. A miss then says nothing about CT's health: the
        transform records nothing and the worker's own outcome settles."""
        act._ct_warm = lambda: False
        for i in range(ct_wisdom_live.BREAKER_FAILS):
            args = {"path": "f%d.py" % i}
            before = (self.breaker.failures, self.breaker.successes)
            self.assertIsNone(self.post(READ_RESULT, call="c%d" % i, req="r%d" % i, args=args))
            self.assertEqual((self.breaker.failures, self.breaker.successes), before,
                             "the cold miss itself records nothing")
            self.match_result = (None, "timeout") if i == 1 else (
                {"entries": [item("f1")], "corrections": []}, None)
            self.started[i]()  # the late worker: a genuine success, or CT's own timeout
        self.assertEqual((self.breaker.failures, self.breaker.successes), (1, 2))
        self.assertFalse(ct_wisdom_live._BREAKER.is_open())
        # The cold miss freed its key: a later step retries it.
        act._spawn = lambda target: target()
        act._wait = lambda p: p.done.wait(0)
        self.match_result = ({"entries": [item("f1")], "corrections": []}, None)
        self.assertIsNotNone(self.post(READ_RESULT, call="c9", req="r9", args={"path": "f0.py"}))

    def test_warm_flag_reads_the_discovery_and_probe_caches(self):
        real = HarnessFree.real_ct_warm  # the Harness stubs act._ct_warm
        orig_path = ct_wisdom._accepted_ct_path
        self.addCleanup(setattr, ct_wisdom, "_accepted_ct_path", orig_path)
        self.addCleanup(ct_wisdom_live.reset_capability_cache)
        ct_wisdom._accepted_ct_path = None
        ct_wisdom_live.reset_capability_cache()
        self.assertFalse(real())
        ct_wisdom._accepted_ct_path = "/fake/ct"
        self.assertFalse(real(), "discovery cached, probe not run yet")
        with ct_wisdom_live._capability_lock:
            ct_wisdom_live._capability["/fake/ct"] = True
        self.assertTrue(real())
        with ct_wisdom_live._capability_lock:
            ct_wisdom_live._capability["/fake/ct"] = False
        self.assertFalse(real())

    def test_worker_finishing_as_the_wait_times_out_is_used(self):
        """Finding 5: the worker settles just after _wait() gave up. Its ready
        result is delivered and its success settles the breaker, with no
        budget failure."""
        def wait_then_finish(p):
            self.started.pop()()  # the worker wins the race
            return False          # ...but the wait already reported a timeout
        act._wait = wait_then_finish
        out = self.post(READ_RESULT)
        self.assertIsNotNone(out)
        self.assertEqual(ct_ledger.scan_ids(out), ["f1"])
        self.assertEqual((self.breaker.failures, self.breaker.successes), (0, 1))

    def test_worker_failure_as_the_wait_times_out_counts_once(self):
        def wait_then_finish(p):
            self.started.pop()()
            return False
        act._wait = wait_then_finish
        self.match_result = (None, "timeout")
        self.assertIsNone(self.post(READ_RESULT))
        self.assertEqual((self.breaker.failures, self.breaker.successes), (1, 0))

    def test_refused_and_unrun_calls_count_zero(self):
        self.post(REFUSALS[0], tool="terminal", args=GIT_PUSH)
        self.assertEqual((self.breaker.failures, self.started), (0, []))


# ---------------------------------------------------------------------------
# Task 6: registration and marker hygiene
# ---------------------------------------------------------------------------


class TestMarkerHygiene(Harness):
    def delivered_block(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
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
            a = act.activity_for(tool, args, cwd=PROJ)
            if a is None:
                continue
            q = act.query_for(a)
            self.assertNotIn("ct-fact:", q)
            self.assertNotIn(act.ACTIVITY_HEADING, q)
            self.assertNotIn("Title f1", q)

    def test_history_scan_finds_activity_markers(self):
        out, _ = self.delivered_block()
        text_out = "plain\n\n" + act.render_activity_block(item("f9"), [], act.activity_for(
            "read_file", {"path": "a.py"}, cwd=PROJ))
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
        a = act.activity_for("read_file", {"path": "a.py"}, cwd=PROJ)
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

    def test_registers_transform_and_no_pre_tool_call(self):
        """Finding 2: the step is claimed in transform_tool_result, so the
        plugin needs (and registers) no pre_tool_call hook."""
        hooks = {}

        class Ctx:
            def register_skill(self, *a, **k):
                pass

            def register_hook(self, name, cb):
                hooks[name] = cb

        self.plugin.register(Ctx())
        self.assertNotIn("pre_tool_call", hooks)
        self.assertIn("transform_tool_result", hooks)

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
        self.assertIsNone(self.post(READ_RESULT))
        ev = self.events()
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["channel"], ev[0]["event"]), ("activity", "skip"))
        self.assertEqual(ev[0]["reason"], "deduped")
        self.assertEqual(ev[0]["query"], "src/x.py")

    def test_rate_and_filter_skips_are_not_recorded(self):
        os.environ["CT_WISDOM_VERBOSE"] = "1"
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.post(READ_RESULT, call="c1")
        self.events_before = len(self.events())
        self.post(READ_RESULT, call="c2", req="r2")  # seen_key
        self.post(READ_RESULT, call="c3", args={"path": "other.py"})  # step_used
        self.post(READ_RESULT, call="c4", req="r4", tool="web_search",
                  args={"query": "x"})  # no_activity
        self.post(READ_RESULT, call="c5", req="r5",
                  tool="mcp__curated-thoughts__curated_recall_context",
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
        args = {"path": os.path.join(PROJ, "clients", "acme", "contract.md")}
        out = self.post(READ_RESULT, args=args)
        block = json.loads(out)[act.ACTIVITY_RESULT_KEY]
        self.assertIn("_for: read clients/acme/contract.md_", block)
        self.assertEqual(self.calls[-1]["text"], "clients/acme/contract.md")
        ev = self.events()
        self.assertEqual(ev[-1]["query"], "clients/acme/contract.md")
        self.assertEqual(ev[-1]["activity"], "read clients/acme/contract.md")
        with open(self.log, encoding="utf-8") as handle:
            raw = handle.read()
        for leak in (PROJ, json.dumps(PROJ)[1:-1], os.path.basename(PROJ)):
            self.assertNotIn(leak, raw)
            self.assertNotIn(leak, out)
        # A file outside the project is never a query at all.
        self.calls.clear()
        self.post(READ_RESULT, call="c9", req="r9",
                  args={"path": os.path.join(os.path.dirname(PROJ), "x.md")})
        self.assertEqual(self.calls, [])

    def test_breaker_open_recorded_once_for_a_would_be_trigger(self):
        os.environ["CT_WISDOM_VERBOSE"] = "1"
        ct_ledger.LEDGER_CACHE.put("s1", set())
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            ct_wisdom_live._BREAKER.record_failure()
        self.post(READ_RESULT, call="c1")
        self.post(READ_RESULT, call="c2", args={"path": "y.py"})  # same step: not a second record
        ev = self.events()
        self.assertEqual([(e["event"], e["reason"]) for e in ev], [("skip", "breaker_open")])
        self.assertEqual(ev[0]["query"], "src/x.py")


# ---------------------------------------------------------------------------
# PR #72 re-review (Amendment 8 update 2)
# ---------------------------------------------------------------------------


class TestUnusableCt(Harness):
    """A broken or absent ct costs a bounded number of waits, then goes
    quiet for CT_UNUSABLE_PAUSE (re-review findings 1 and 2)."""

    def setUp(self):
        super().setUp()
        self.breaker = CountingBreaker()
        ct_wisdom_live._BREAKER = self.breaker
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.now = [1000.0]
        orig_clock = act._clock
        act._clock = lambda: self.now[0]
        self.addCleanup(setattr, act, "_clock", orig_clock)
        self.discovered = []
        self.probed = []
        self.discover_answer = ("/fake/ct", None)
        self.probe_answer = True
        self.probe_hangs = True  # None after PROBE_TIMEOUT; False: an instant OSError
        ct_wisdom.discover_ct = lambda env=None: self.discovered.append(1) or self.discover_answer
        ct_wisdom_live.has_match_capability = self.fake_probe
        self.resets = []
        for mod, name in [(ct_wisdom, "reset_discovery_cache"),
                          (ct_wisdom_live, "reset_capability_cache")]:
            orig = getattr(mod, name)
            setattr(mod, name, lambda n=name: self.resets.append(n))
            self.addCleanup(setattr, mod, name, orig)

    def fake_probe(self, path):
        self.probed.append(path)
        if self.probe_answer is None and self.probe_hangs:
            self.now[0] += ct_wisdom.PROBE_TIMEOUT
        return self.probe_answer

    def step(self, n, path=None):
        args = {"path": path or "f%d.py" % n}
        return self.post(READ_RESULT, call="c%d" % n, req="r%d" % n, args=args)

    def test_stuck_probe_is_a_breaker_failure_then_skips_without_waiting(self):
        self.probe_answer = None  # `ct wisdom match --help` timed out
        self.assertIsNone(self.step(1))
        self.assertEqual(self.breaker.failures, 1)
        spawned = []
        act._spawn = lambda target: spawned.append(target)
        for n in range(2, 6):
            self.assertIsNone(self.step(n))
        self.assertEqual((spawned, len(self.probed)), ([], 1), "later steps must not wait")
        self.now[0] += act.CT_UNUSABLE_PAUSE + 1
        act._spawn = lambda target: target()
        self.probe_answer = True
        self.assertIsNotNone(self.step(9), "retried after the pause")

    def test_stuck_discovery_is_a_breaker_failure_then_skips(self):
        self.discover_answer = (None, "probe_timeout")  # `ct --help` timed out
        self.assertIsNone(self.step(1))
        self.assertIsNone(self.step(2))
        self.assertEqual((len(self.discovered), self.breaker.failures), (1, 1))

    def test_cold_hang_then_probe_timeout_goes_quiet(self):
        """The transform gave up (cold), the worker's probe then timed out:
        the next steps skip at once."""
        act._ct_warm = lambda: False
        held = []
        act._spawn = lambda target: held.append(target)
        act._wait = lambda p: False
        self.probe_answer = None
        self.assertIsNone(self.step(1))
        held.pop()()
        self.assertEqual(self.breaker.failures, 1)
        self.assertIsNone(self.step(2))
        self.assertEqual(held, [], "no second wait while ct is unusable")

    def test_discovery_miss_is_memoized_per_path(self):
        self.discover_answer = (None, None)  # e.g. chart-testing's ct first on PATH
        self.assertIsNone(self.step(1))
        for n in range(2, 6):
            self.assertIsNone(self.step(n))
        self.assertEqual(len(self.discovered), 1)
        self.assertEqual(self.breaker.failures, 0, "a missing ct is not a sick CT")
        with mock.patch.dict(os.environ, {"PATH": "/opt/new/bin"}):
            self.discover_answer = ("/fake/ct", None)
            self.assertIsNotNone(self.step(7), "a PATH change retries at once")

    def test_capability_missing_is_memoized(self):
        self.probe_answer = False  # an old ct without `wisdom match`
        self.assertIsNone(self.step(1))
        self.assertIsNone(self.step(2))
        self.assertEqual((len(self.probed), self.breaker.failures), (1, 0))

    def test_discover_ct_docstring_says_a_miss_is_not_memoized(self):
        source = Path(ct_wisdom.__file__).read_text(encoding="utf-8")  # setUp stubs the function
        start = source.index("def discover_ct(")
        body = source[start:source.index('"""', source.index('"""', start) + 3)]
        self.assertNotIn("(memoized)", body)


class TestReview3(TestUnusableCt):
    """PR #72 third review."""

    def test_probe_spawn_error_is_spawn_class(self):
        """1: has_match_capability's None from an OSError (instant) is not a
        timeout: caches reset, no breaker charge, not remembered."""
        self.probe_answer, self.probe_hangs = None, False
        self.assertIsNone(self.step(1))
        self.assertEqual(self.breaker.failures, 0)
        self.assertEqual(sorted(self.resets), ["reset_capability_cache", "reset_discovery_cache"])
        self.assertIsNone(act._ct_unusable())
        self.probe_answer = True
        self.assertIsNotNone(self.step(2), "the next step tries again")

    def test_path_change_resets_the_caches(self):
        """2: the memo clearing on a PATH change also resets discovery and
        the capability cache, so the retry really re-discovers."""
        self.probe_answer = False
        self.assertIsNone(self.step(1))
        self.resets.clear()
        with mock.patch.dict(os.environ, {"PATH": "/opt/new/bin"}):
            self.probe_answer = True
            self.assertIsNotNone(self.step(2))
        self.assertEqual(sorted(self.resets), ["reset_capability_cache", "reset_discovery_cache"])

    def test_one_cold_probe_in_flight(self):
        """5: while a cold probe runs, another cold step does not spawn one."""
        act._ct_warm = lambda: False
        held = []
        act._spawn = lambda target: held.append(target)
        act._wait = lambda p: False
        self.assertIsNone(self.step(1))
        self.assertIsNone(self.step(2))
        self.assertEqual(len(held), 1, "a second cold probe started")
        held.pop()()
        self.assertIsNone(self.step(3))
        self.assertEqual(len(held), 1, "the probe slot was not freed")

    def test_exception_after_start_frees_the_key(self):
        """4: anything raising after the claim (constructor, warm check,
        render, ledger claim) leaves neither step nor key held."""
        for name in ("_Prefetch", "_ct_warm", "render_activity_block"):
            with self.subTest(name=name):
                act.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                orig = getattr(act, name)

                def boom(*a, **k):
                    raise RuntimeError("boom")

                setattr(act, name, boom)
                self.assertIsNone(self.step(1, path="same.py"))
                setattr(act, name, orig)
                self.assertIsNotNone(self.step(2, path="same.py"), name)
        act.reset_state()
        ct_ledger.LEDGER_CACHE.put("s1", set())
        with mock.patch.object(ct_ledger.LEDGER_CACHE, "claim", side_effect=RuntimeError):
            self.assertIsNone(self.step(1, path="same.py"))
        self.assertIsNotNone(self.step(2, path="same.py"), "ledger claim")

    def test_more_refusal_wording(self):
        """3: declined, approval timed out, not allowed: an `error` or a
        missing proof field sends nothing, whatever the wording."""
        for err in ("User declined to run this command", "Approval timed out after 60s",
                    "Not allowed: path is outside the sandbox",
                    "Timed out waiting for approval"):
            self.assertFalse(act.proves_ran("terminal", {"error": err}), err)
            self.assertFalse(act.proves_ran("terminal", {"message": err}), err)
            # Output wording is never read: a command that ran and printed it sends.
            self.assertTrue(act.proves_ran("terminal", {"output": err, "exit_code": 0,
                                                        "error": None}), err)

    def test_comment_and_docstring(self):
        """8, 9."""
        source = Path(act.__file__).read_text(encoding="utf-8")
        self.assertNotIn("The name check runs on the full module (the program passed it", source)
        self.assertIn("ct_unavailable", act._blocked_report.__doc__)


class TestKeyInFlight(Harness):
    """Re-review finding 4: after a cold budget miss the key stays held
    while the worker runs, and is freed when it settles without delivery."""

    def setUp(self):
        super().setUp()
        ct_ledger.LEDGER_CACHE.put("s1", set())
        act._ct_warm = lambda: False
        self.held = []
        act._spawn = lambda target: self.held.append(target)
        orig_wait = act._wait
        act._wait = lambda p: False
        self.addCleanup(setattr, act, "_wait", orig_wait)

    def test_no_second_query_while_the_first_is_in_flight(self):
        self.assertIsNone(self.post(READ_RESULT, call="c1", req="r1"))
        self.assertIsNone(self.post(READ_RESULT, call="c2", req="r2"))
        self.assertEqual(len(self.held), 1, "a second worker started for the same key")

    def test_key_freed_when_the_late_worker_settles(self):
        self.match_result = (None, "timeout")
        self.post(READ_RESULT, call="c1", req="r1")
        self.held.pop()()
        act._spawn = lambda target: target()
        act._wait = lambda p: p.done.wait(0)
        self.match_result = ({"entries": [item("f1")], "corrections": []}, None)
        self.assertIsNotNone(self.post(READ_RESULT, call="c2", req="r2"))


class TestSpawnFailure(Harness):
    def test_spawn_failure_frees_the_step_and_the_key(self):
        """Re-review finding 5: Thread.start raising leaves nothing held."""
        ct_ledger.LEDGER_CACHE.put("s1", set())

        def boom(target):
            raise RuntimeError("can't start new thread")

        act._spawn = boom
        self.assertIsNone(self.post(READ_RESULT, call="c1"))
        act._spawn = lambda target: target()
        self.assertIsNotNone(self.post(READ_RESULT, call="c2"), "same step, same key")


class TestTransformCost(Harness):
    """Re-review finding 6."""

    def test_used_step_skips_before_building_the_activity(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNotNone(self.post(READ_RESULT, call="c1"))
        built = []
        orig = act.activity_for
        act.activity_for = lambda *a, **k: built.append(1) or orig(*a, **k)
        self.addCleanup(setattr, act, "activity_for", orig)
        self.assertIsNone(self.post(READ_RESULT, call="c2", args={"path": "src/y.py"}))
        self.assertEqual(built, [])

    def test_result_parsed_once(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        result = json.dumps({"content": "x", "total_lines": 1, "pad": "unique-%d" % id(self)})
        seen = []
        real_loads = json.loads

        def counting(text, *a, **k):
            if text == result:
                seen.append(1)
            return real_loads(text, *a, **k)

        with mock.patch.object(act.json, "loads", counting):
            self.assertIsNotNone(self.post(result))
        self.assertEqual(len(seen), 1)


class TestRefusalReview2(unittest.TestCase):
    """Re-review finding 3, now under proves_ran: wording, nesting and
    JSON-string errors all fail on `error`; Hermes's kwargs are not read;
    output fields stay ignored."""

    def test_more_free_text(self):
        for err in ("Rejected by policy", "The user rejected this call",
                    "Cancelled by user", "Operation cancelled", "operation canceled",
                    "request was rejected"):
            for key in ("error", "message"):
                self.assertFalse(act.proves_ran("read_file", {key: err}), (key, err))

    def test_nested_and_json_string_errors(self):
        for result in (
                {"error": {"message": "BLOCKED: denied"}},
                {"error": {"code": 403, "reason": "user denied the action"}},
                {"error": json.dumps({"status": "blocked"})},
                {"error": json.dumps({"error": "Refusing to write"})},
                {"error": {"error": {"message": "not approved"}}}):
            for tool in ("terminal", "read_file", "write_file", "patch", "search_files"):
                self.assertFalse(act.proves_ran(tool, result), (tool, result))

    def test_transform_ignores_the_kwargs(self):
        """The result body is the proof. At the pin Hermes derives the kwargs
        from that body, and says status="error" for any non-zero exit (a
        command that ran), so they are not read."""
        h = Harness("run")
        h.setUp()
        try:
            ct_ledger.LEDGER_CACHE.put("s1", set())
            out = act.on_transform_tool_result(
                tool_name="terminal", args={"command": "pnpm test"},
                result=json.dumps({"output": "1 failed", "exit_code": 1, "error": None}),
                task_id="", session_id="s1", tool_call_id="c1", turn_id="t",
                api_request_id="r1", duration_ms=5, status="error",
                error_type="tool_error", error_message="[exit 1]")
            self.assertIsNotNone(out)
            self.assertEqual([c["text"] for c in h.calls], ["pnpm test"])
        finally:
            h.doCleanups()

    def test_output_fields_still_ignored(self):
        for tool, result in (
                ("terminal", {"output": "rejected by remote: cancelled by user",
                              "exit_code": 1, "error": None}),
                ("read_file", {"content": "Operation cancelled by user", "total_lines": 1})):
            self.assertTrue(act.proves_ran(tool, result), result)

    def test_word_list_is_gone(self):
        for name in ("is_refusal", "_refused", "_refusal_value", "_refusal_text",
                     "_refused_status", "_REFUSED_STATUSES", "_REFUSED_PREFIXES",
                     "_REFUSED_PHRASES", "_REFUSED_ERROR_TYPE_WORDS",
                     "_ENVELOPE_TEXT_KEYS", "_REFUSAL_DEPTH"):
            self.assertFalse(hasattr(act, name), name)


if __name__ == "__main__":
    unittest.main()

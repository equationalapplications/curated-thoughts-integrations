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
        """A HOME that is not a real user home (not in a homes location, not
        pw_dir) blocks only itself, so a sandbox HOME inside a repo does not
        hide the repo. pw_dir blocks its ancestors wherever it is."""
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
                       ("python3.11.2 -m pytest", None), ("run.ps1", None)):
            self.assertEqual(act.command_target(cmd, {}, frozenset()), q, cmd)
        self.assertIsNone(act._PYTHON_RE.match("python3.11.2"))
        self.assertIsNotNone(act._PYTHON_RE.match("python3.11"))

    def test_project_package_cached_and_top_only(self):
        base = temp_base()
        make_tree(base, ["tests/__init__.py"])
        calls = []
        orig = os.path.isdir
        os.path.isdir = lambda p: calls.append(p) or orig(p)
        self.addCleanup(setattr, os.path, "isdir", orig)
        self.assertEqual(act._project_package("tests.acme_merger_due_diligence", base), "tests")
        first = len(calls)
        self.assertEqual(act._project_package("tests.other", base), "tests")
        self.assertEqual(len(calls), first, "cached per (root, top)")
        self.assertIsNone(act._project_package("nothere.x", base))

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
            "terminal", {"command": "make test"}, cwd=PROJ).key))
        self.assertIsNone(st.admit("s", "r2", act.activity_for(
            "search_files", {"pattern": "make test"}, cwd=PROJ).key))
        self.assertEqual(st.admit("s", "r3", act.activity_for(
            "terminal", {"command": "make test -j4"}, cwd=PROJ).key), "seen_key")


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
        args = {"path": os.path.join(PROJ, "clients", "acme", "contract.md")}
        self.pre(args=args)
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
        self.pre(call="c9", req="r9", args={"path": os.path.join(os.path.dirname(PROJ), "x.md")})
        self.assertEqual(self.calls, [])

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

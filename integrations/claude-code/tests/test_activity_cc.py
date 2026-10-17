#!/usr/bin/env python3
"""The Claude Code activity binding (spec 2026-10-17-claude-code-autonomous-
work-wisdom-design.md, D1, D4): Claude Code tool names translated into the
vendored Hermes builder, the shared privacy vectors and golden blocks run
through it, the Hermes secret-safety cases ported, CT tools never trigger.

Run: python3 -m unittest tests.test_activity_cc -v
"""

from __future__ import annotations

import json
import os
import random
import shlex
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
REPO = INTEGRATION.parent.parent
sys.path.insert(0, str(INTEGRATION / "hooks"))

import ct_wisdom_cc  # noqa: E402,F401  (puts scripts/ on sys.path)
import ct_wisdom_activity  # noqa: E402
import ct_wisdom_cc_activity as act  # noqa: E402

VECTORS = REPO / "tests" / "fixtures" / "activity_targets.json"
BLOCKS = REPO / "tests" / "fixtures" / "activity_blocks.json"

PROJECT = os.path.realpath(tempfile.mkdtemp(prefix="ct-cc-project-"))
os.makedirs(os.path.join(PROJECT, ".git"))
for _rel in ("src/a.py", "src/billing/invoice.py", "a/b.py", "x.py", "nb.ipynb"):
    os.makedirs(os.path.dirname(os.path.join(PROJECT, _rel)), exist_ok=True)
    open(os.path.join(PROJECT, _rel), "a").close()
ENV = {"USER": "alice", "HOME": "/Users/alice"}


def tearDownModule():
    shutil.rmtree(PROJECT, ignore_errors=True)


def line(tool_name, args, cwd=PROJECT):
    a = act.activity_for(tool_name, args, cwd, ENV)
    return (a.line, act.query_for(a)) if a else None


CASES = [
    ("Read", {"file_path": os.path.join(PROJECT, "src/billing/invoice.py")},
     "read src/billing/invoice.py", "src/billing/invoice.py"),
    ("Read", {"file_path": "src/a.py"}, "read src/a.py", "src/a.py"),  # relative (H12)
    ("Write", {"file_path": "./a/b.py", "content": "SECRET_CONTENT"}, "write a/b.py", "a/b.py"),
    ("Edit", {"file_path": "x.py", "old_string": "o", "new_string": "SECRET_NEW"},
     "edit x.py", "x.py"),
    ("MultiEdit", {"file_path": "x.py", "edits": [{"old_string": "S", "new_string": "S"}]},
     "edit x.py", "x.py"),
    ("NotebookEdit", {"notebook_path": "nb.ipynb", "new_source": "SECRET"},
     "edit nb.ipynb", "nb.ipynb"),
    ("Grep", {"pattern": "MCP tool name", "path": "src"},
     "search MCP tool name in src", "MCP tool name"),
    ("Grep", {"pattern": "TODO"}, "search TODO", "TODO"),
    ("Bash", {"command": "pnpm test", "description": "Run tests"}, "run pnpm test", "pnpm test"),
    ("Bash", {"command": "npm run build"}, "run npm run", "npm run"),
    ("Bash", {"command": "pytest tests/billing -q"}, "run pytest", "pytest"),
    ("Bash", {"command": "API_KEY=sk-123 python deploy.py --token x"}, "run python", "python"),
    ("Bash", {"command": "curl -H 'Authorization: Bearer x' https://h"}, "run curl", "curl"),
    ("Bash", {"command": "git commit -m 'msg SECRET'"}, "run git commit", "git commit"),
    ("Bash", {"command": "cat .env.local | grep KEY"}, "run cat", "cat"),
    ("Bash", {"command": "mysql -uroot -pS3cr3t db"}, "run mysql", "mysql"),
    ("Bash", {"command": "git push https://user:pw@host/r.git"}, "run git push", "git push"),
]


class BindingTests(unittest.TestCase):
    def test_cases(self):
        for tool_name, args, want_line, want_query in CASES:
            with self.subTest(tool=tool_name, args=args):
                self.assertEqual(line(tool_name, args), (want_line, want_query))

    def test_query_never_has_the_verb(self):
        for tool_name, args, want_line, _ in CASES:
            verb = want_line.split(" ", 1)[0]
            self.assertFalse(line(tool_name, args)[1].startswith(verb + " "))

    def test_no_activity(self):
        for tool_name, args in [
            ("Agent", {"prompt": "SECRET", "subagent_type": "general-purpose"}),
            ("WebFetch", {"url": "https://x", "prompt": "p"}), ("TodoWrite", {"todos": []}),
            ("Glob", {"pattern": "*.txt"}), ("Glob", {"pattern": "**/*.py", "path": "src"}),
            ("Read", {}), ("Read", {"file_path": 7}), ("Read", {"file_path": "."}),
            ("Read", {"path": "src/a.py"}),  # not the Claude Code arg name
            ("Bash", {"command": ""}), ("Bash", {"command": "A=1 B=2"}),
            ("Bash", {"command": "$(cat s)"}), ("Bash", {"command": 42}),
            ("Grep", {"pattern": ""}), ("Read", "not-a-dict"), (None, {"file_path": "a"}),
            ("mcp__github__get_file", {"path": "src/a.py"}),
        ]:
            with self.subTest(tool=tool_name, args=args):
                self.assertIsNone(line(tool_name, args))

    def test_outside_a_project_root_sends_nothing(self):
        bare = os.path.realpath(tempfile.mkdtemp(prefix="ct-cc-noroot-"))
        self.addCleanup(shutil.rmtree, bare, True)
        open(os.path.join(bare, "x.py"), "w").close()
        ct_wisdom_activity.reset_caches()
        self.assertIsNone(line("Read", {"file_path": os.path.join(bare, "x.py")}, cwd=bare))

    def test_untranslated_args_never_reach_the_builder(self):
        self.assertEqual(act.translate("Edit", {"file_path": "a", "old_string": "S",
                                                "new_string": "N", "replace_all": True}),
                         ("patch", {"path": "a"}))
        self.assertEqual(act.translate("Write", {"file_path": "a", "content": "S"}),
                         ("write_file", {"path": "a"}))
        self.assertEqual(act.translate("Bash", {"command": "ls", "description": "S",
                                                "run_in_background": True}),
                         ("terminal", {"command": "ls"}))
        self.assertEqual(act.translate("Grep", {"pattern": "p", "path": "src", "glob": "S",
                                                "output_mode": "content", "-n": True}),
                         ("search_files", {"pattern": "p", "path": "src"}))
        self.assertIsNone(act.translate("Agent", {"prompt": "x"}))

    def test_secret_args_never_in_line_or_query(self):
        secret = "SUPERSECRET"
        for tool_name, args in [
            ("Write", {"file_path": "src/a.py", "content": secret}),
            ("Edit", {"file_path": "src/a.py", "old_string": secret, "new_string": secret}),
            ("Read", {"file_path": "src/a.py", "offset": 1, "limit": secret}),
            ("Grep", {"pattern": "p", "glob": secret, "type": secret}),
            ("Bash", {"command": "ls", "description": secret}),
        ]:
            got = line(tool_name, args)
            self.assertIsNotNone(got, tool_name)
            self.assertNotIn(secret, got[0])
            self.assertNotIn(secret, got[1])

    def test_randomized_commands_secret_safety(self):
        rng = random.Random(20261017)
        words = ["git", "npm", "pytest", "make", "python", "status", "test", "build", "src/a.py"]
        nasty = ["sk-ABCDEF1234567890xyz", "ghp_0123456789abcdefABCD", "user:pw@host",
                 "https://u:p@h/x", "$TOKEN", "${SECRET}", "A=B", "'quoted secret'",
                 '"dq secret"', "--password=hunter2", "-pHUNTER2", "AKIAABCDEFGHIJKLMNOP",
                 "xoxb-123-456", "a1b2c3d4e5f6g7h8i9j0", "|", "&&", ";", ">", "out.txt"]
        for _ in range(500):
            command = " ".join(rng.choice(words + nasty) for _ in range(rng.randint(1, 7)))
            got = line("Bash", {"command": command})
            if got is None:
                continue
            query = got[1]
            tokens = query.split(" ")
            self.assertLessEqual(len(tokens), 2, command)
            for ch in "=@:$'\"|&;<>/.":
                self.assertNotIn(ch, query, command)
            for bad in ("sk-", "ghp_", "AKIA", "xox", "hunter2", "HUNTER2", "a1b2c3"):
                self.assertNotIn(bad, query, command)
            try:
                raw = shlex.split(command)
            except ValueError:
                raw = command.split()
            for token in tokens:
                self.assertIn(token, raw, command)

    def test_own_marker_or_heading_is_never_a_target(self):
        for q in ("ct-fact:evil", "## Curated Thoughts — relevant now", "a\nb"):
            self.assertIsNone(line("Grep", {"pattern": q}))
        self.assertIsNone(line("Read", {"file_path": "x/ct-fact:evil"}))


class CtToolTests(unittest.TestCase):
    def test_ct_tools(self):
        for name in ("mcp__curated-thoughts__curated_recall_context",
                     "mcp__curated-thoughts__curated_get_wiki_entry",
                     "mcp__plugin_curated-thoughts_ct__wiki_context",
                     "mcp__ct__curated_recall_context"):
            self.assertTrue(act.is_ct_tool(name), name)
        for name in ("Read", "Bash", "mcp__github__search", "Agent", None, 7):
            self.assertFalse(act.is_ct_tool(name), name)
        self.assertTrue(act.is_recall_tool("mcp__curated-thoughts__curated_recall_context"))
        self.assertFalse(act.is_recall_tool("mcp__curated-thoughts__curated_get_wiki_entry"))
        self.assertFalse(act.is_recall_tool("curated_recall_context"))

    def test_activity_tools_are_the_hooks_json_matcher(self):
        hooks = json.loads((INTEGRATION / "hooks" / "hooks.json").read_text(encoding="utf-8"))
        for event in ("PostToolUse", "PostToolUseFailure"):
            matchers = [g.get("matcher") for g in hooks["hooks"][event]]
            self.assertIn("|".join(act.ACTIVITY_TOOLS), matchers, event)
        self.assertEqual(set(act.ACTIVITY_TOOLS), set(act.TOOL_MAP))


class SharedVectorTests(unittest.TestCase):
    """tests/fixtures/activity_targets.json through the Claude Code binding:
    each Hermes-named vector is translated to the Claude Code tool with the
    same meaning and built in its own fake filesystem world, as
    tests/tools/test_activity_target_vectors.py builds them for Hermes."""

    TO_CC = {
        "read_file": ("Read", {"path": "file_path"}),
        "write_file": ("Write", {"path": "file_path", "content": "content"}),
        "patch": ("Edit", {"path": "file_path", "old_string": "old_string",
                           "new_string": "new_string"}),
        "search_files": ("Grep", {"pattern": "pattern", "path": "path"}),
        "terminal": ("Bash", {"command": "command"}),
    }

    def world(self, cases, tmp=None):
        if tmp is None:
            tmp = os.path.realpath(tempfile.mkdtemp(prefix="ct-cc-world-"))
            self.addCleanup(shutil.rmtree, tmp, True)
        else:
            os.makedirs(tmp)

        def vmap(value):
            if isinstance(value, str) and value.startswith("/"):
                return os.path.join(tmp, *[p for p in value.split("/") if p])
            return value

        for case in cases:
            for entry in case["fs"]:
                if isinstance(entry, dict):
                    target, link = vmap(entry["to"]), vmap(entry["symlink"])
                    os.makedirs(target, exist_ok=True)
                    os.makedirs(os.path.dirname(link), exist_ok=True)
                    if not os.path.lexists(link):
                        try:
                            os.symlink(target, link, target_is_directory=True)
                        except (OSError, NotImplementedError):
                            return None, None
                elif entry.endswith("/"):
                    os.makedirs(vmap(entry), exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(vmap(entry)), exist_ok=True)
                    Path(vmap(entry)).touch()
        return tmp, vmap

    def build(self, case, tmp, vmap):
        tool_name, fields = self.TO_CC[case["tool"]]
        args = {fields[k]: (vmap(v) if k == "path" else v)
                for k, v in case["args"].items() if k in fields}
        cwd = vmap(case["cwd"])
        if cwd.startswith(tmp):
            os.makedirs(cwd, exist_ok=True)
        env = {k: (vmap(v) if k in ("HOME", "USERPROFILE") else v) for k, v in case["env"].items()}
        home = [vmap(case["system_home"])] if case.get("system_home") else []
        identity = ([case["system_user"]] if case.get("system_user") else [], home, home)
        saved = ct_wisdom_activity._fs_root, ct_wisdom_activity._system_identity
        ct_wisdom_activity._fs_root = lambda d: d == tmp or not d.startswith(tmp + os.sep)
        ct_wisdom_activity._system_identity = lambda: identity
        ct_wisdom_activity.reset_caches()
        try:
            return act.activity_for(tool_name, args, cwd, env)
        finally:
            ct_wisdom_activity._fs_root, ct_wisdom_activity._system_identity = saved
            ct_wisdom_activity.reset_caches()

    def test_every_vector(self):
        cases = json.loads(VECTORS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 290)
        ran = 0
        for case in cases:
            with self.subTest(case["name"]):
                tmp, vmap = self.world([case])
                if tmp is None:
                    self.skipTest("symlinks unavailable")
                a = self.build(case, tmp, vmap)
                ran += 1
                if case["expected_query"] is None:
                    self.assertTrue(a is None or not act.query_for(a), a and a.line)
                    continue
                self.assertIsNotNone(a)
                self.assertEqual(act.query_for(a), case["expected_query"])
                self.assertEqual(a.line, case["expected_line"])
                self.assertNotIn(tmp, repr(a))
                block = act.render_activity_block(
                    {"id": "f1", "title": "T", "text": "x", "provenance": "p"}, [], a)
                label = case["expected_line"]
                if len(label) > ct_wisdom_activity.LABEL_CHARS:
                    label = label[:ct_wisdom_activity.LABEL_CHARS - 1] + "…"
                self.assertIn("_for: %s_" % label, block)
        self.assertEqual(ran, len(cases))

    def test_keys_distinct(self):
        cases = {c["name"]: c for c in json.loads(VECTORS.read_text(encoding="utf-8"))}
        checked = 0
        for case in cases.values():
            other = case.get("key_distinct_from")
            if not other:
                continue
            with self.subTest(case["name"]):
                parent = os.path.realpath(tempfile.mkdtemp(prefix="ct-cc-pair-"))
                self.addCleanup(shutil.rmtree, parent, True)
                built = []
                for one in (case, cases[other]):
                    where = os.path.join(parent, "w")
                    tmp, vmap = self.world([one], tmp=where)
                    if tmp is None:
                        self.skipTest("symlinks unavailable")
                    built.append(self.build(one, tmp, vmap))
                    shutil.rmtree(where, ignore_errors=True)
                a, b = built
                self.assertEqual(act.query_for(a), act.query_for(b))
                self.assertNotEqual(a.key, b.key)
                checked += 1
        self.assertGreater(checked, 0)


class GoldenBlockTests(unittest.TestCase):
    """tests/fixtures/activity_blocks.json through the binding's renderer."""

    def test_every_block(self):
        cases = json.loads(BLOCKS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 2)
        self.assertTrue(any(c["superseded"] for c in cases))
        for case in cases:
            with self.subTest(case["name"]):
                activity = act.Activity("read", "x", ("file", "k"), case["line"], "x")
                self.assertEqual(act.render_activity_block(case["item"], case["superseded"],
                                                           activity), case["expected"])


if __name__ == "__main__":
    unittest.main()

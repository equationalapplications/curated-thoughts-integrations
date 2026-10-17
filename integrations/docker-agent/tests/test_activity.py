"""Autonomous-work delivery (spec D7): the Docker Agent activity map, the
privacy rules R1-R4, the Hermes secret-safety tests ported to Docker Agent's
tool names, the key and step rules, and delivery into the tool result."""

from __future__ import annotations

import json
import os
import random
import shlex
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

from _support import INTEGRATION, PROJECT, Env, FakeCT, fact, llm, patched, prompt, tool, updated_response

import ct_wisdom_activity
import ct_wisdom_da as da
import ct_wisdom_da_activity as act

CWD = PROJECT
ENV = {"USER": "alice", "HOME": "/Users/alice"}


def line(tool_name, args, cwd=CWD):
    a = act.activity_for(tool_name, args, cwd, ENV)
    return (a.line, act.query_for(a)) if a else None


CASES = [
    ("read_file", {"path": "src/billing/invoice.py"},
     "read src/billing/invoice.py", "src/billing/invoice.py"),
    ("write_file", {"path": "./a/b.py", "content": "SECRET_CONTENT"}, "write a/b.py", "a/b.py"),
    ("edit_file", {"path": "x.py", "edits": [{"oldText": "o", "newText": "SECRET_NEW"}]},
     "edit x.py", "x.py"),
    ("search_files_content", {"query": "MCP tool name", "path": "src"},
     "search MCP tool name in src", "MCP tool name"),
    ("search_files_content", {"query": "TODO", "path": "."}, "search TODO", "TODO"),
    ("search_files_content", {"query": "TODO"}, "search TODO", "TODO"),
    ("shell", {"cmd": "pnpm test"}, "run pnpm test", "pnpm test"),
    ("shell", {"command": "npm run build"}, "run npm run", "npm run"),
    ("shell", {"cmd": "pytest tests/billing -q"}, "run pytest", "pytest"),
    ("shell", {"cmd": "API_KEY=sk-123 python deploy.py --token x"}, "run python", "python"),
    ("shell", {"cmd": "curl -H 'Authorization: Bearer x' https://h"}, "run curl", "curl"),
    ("shell", {"cmd": "git commit -m 'msg SECRET'"}, "run git commit", "git commit"),
    ("shell", {"cmd": "cat .env.local | grep KEY"}, "run cat", "cat"),
    ("shell", {"cmd": "echo sk-live-abcdef"}, "run echo", "echo"),
    ("shell", {"cmd": "export TOKEN=abc && make"}, "run export", "export"),
    ("shell", {"cmd": "mysql -uroot -pS3cr3t db"}, "run mysql", "mysql"),
    ("shell", {"cmd": "psql -W secretpw"}, "run psql", "psql"),
    ("shell", {"cmd": 'grep "SecretPassword" app.log'}, "run grep", "grep"),
    ("shell", {"cmd": "git push https://user:pw@host/r.git"}, "run git push", "git push"),
    ("shell", {"cmd": "deploy ghp_abcdefghijklmnop1234"}, "run deploy", "deploy"),
]


class ActivityLineTests(unittest.TestCase):
    def test_cases(self):
        for tool_name, args, want_line, want_query in CASES:
            with self.subTest(tool=tool_name, args=args):
                self.assertEqual(line(tool_name, args), (want_line, want_query))

    def test_query_never_has_the_verb(self):
        for tool_name, args, want_line, _ in CASES:
            verb = want_line.split(" ", 1)[0]
            self.assertFalse(line(tool_name, args)[1].startswith(verb + " "))

    def test_no_line(self):
        for tool_name, args in [
            ("read_multiple_files", {"paths": ["a", "b"]}),
            ("list_directory", {"path": "src"}),
            ("transfer_task", {"agent": "x", "task": "SECRET"}),
            ("read_file", {}), ("read_file", {"path": 7}), ("read_file", {"path": "."}),
            ("shell", {"cmd": ""}), ("shell", {"cmd": "A=1 B=2"}), ("shell", {"cmd": "$(cat s)"}),
            ("shell", {"cmd": 42}), ("search_files_content", {"query": ""}),
            ("read_file", "not-a-dict"), (None, {"path": "a"}),
        ]:
            with self.subTest(tool=tool_name, args=args):
                self.assertIsNone(line(tool_name, args))

    def test_secret_args_never_in_line_or_query(self):
        secret = "SUPERSECRET"
        for tool_name, args in [
            ("write_file", {"path": "a.py", "content": secret}),
            ("edit_file", {"path": "a.py", "edits": [{"oldText": secret, "newText": secret}]}),
            ("read_file", {"path": "a.py", "line": 1, "limit": secret}),
            ("search_files_content", {"query": "p", "excludePatterns": [secret], "is_regex": True}),
            ("shell", {"cmd": "ls", "cwd": secret, "timeout": secret}),
        ]:
            got = line(tool_name, args)
            self.assertNotIn(secret, got[0])
            self.assertNotIn(secret, got[1])

    def test_randomized_commands_secret_safety(self):
        rng = random.Random(20261016)
        words = ["git", "npm", "pytest", "make", "python", "status", "test", "build", "src/a.py"]
        nasty = ["sk-ABCDEF1234567890xyz", "ghp_0123456789abcdefABCD", "user:pw@host",
                 "https://u:p@h/x", "$TOKEN", "${SECRET}", "A=B", "'quoted secret'",
                 '"dq secret"', "--password=hunter2", "-pHUNTER2", "AKIAABCDEFGHIJKLMNOP",
                 "xoxb-123-456", "a1b2c3d4e5f6g7h8i9j0", "|", "&&", ";", ">", "out.txt"]
        for _ in range(500):
            command = " ".join(rng.choice(words + nasty) for _ in range(rng.randint(1, 7)))
            got = line("shell", {"cmd": command})
            if got is None:
                continue
            query = got[1]
            tokens = query.split(" ")
            self.assertLessEqual(len(tokens), 2, command)
            for ch in "=@:$'\"|&;<>":
                self.assertNotIn(ch, query, command)
            for bad in ("sk-", "ghp_", "AKIA", "xox", "hunter2", "HUNTER2", "a1b2c3"):
                self.assertNotIn(bad, query, command)
            try:
                raw = shlex.split(command)
            except ValueError:
                raw = command.split()
            basenames = [os.path.basename(t) for t in raw]
            for token in tokens:
                self.assertIn(token, raw + basenames, command)

    def test_own_marker_or_heading_is_never_a_target(self):
        for q in ("ct-fact:evil", "## Curated Thoughts \u2014 relevant now", "a\nb"):
            self.assertIsNone(line("search_files_content", {"query": q}))
        self.assertIsNone(line("read_file", {"path": "x/ct-fact:evil"}))

    def test_query_caps(self):
        a = act.activity_for("search_files_content", {"query": "x" * 600, "path": "y" * 600},
                             CWD, ENV)
        if a is None:  # 0.6.3 allowlist: an over-long pattern sends nothing at all
            return
        self.assertLessEqual(len(act.query_for(a)), ct_wisdom_activity.ACTIVITY_QUERY_CHARS)
        self.assertLessEqual(len(a.query), ct_wisdom_activity.TARGET_CHARS)


class SharedVectorTests(unittest.TestCase):
    """tests/fixtures/activity_targets.json (the Hermes privacy amendments,
    project-root allowlist) run through the Docker Agent builder. Each
    Hermes-named vector is translated to the Docker Agent tool with the same
    meaning and built in its own fake filesystem world, exactly as
    tests/tools/test_activity_target_vectors.py builds them for Hermes."""

    VECTORS = INTEGRATION.parent.parent / "tests" / "fixtures" / "activity_targets.json"
    TO_DA = {
        "read_file": ("read_file", {"path": "path"}),
        "write_file": ("write_file", {"path": "path", "content": "content"}),
        "patch": ("edit_file", {"path": "path"}),
        "search_files": ("search_files_content", {"pattern": "query", "path": "path"}),
        "terminal": ("shell", {"command": "cmd"}),
    }

    def world(self, cases, tmp=None):
        if tmp is None:
            tmp = os.path.realpath(tempfile.mkdtemp(prefix="ct-da-world-"))
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
        tool_name, fields = self.TO_DA[case["tool"]]
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
        ct_wisdom_activity.reset_state()
        try:
            return act.activity_for(tool_name, args, cwd, env)
        finally:
            ct_wisdom_activity._fs_root, ct_wisdom_activity._system_identity = saved
            ct_wisdom_activity.reset_state()

    def test_every_vector(self):
        cases = json.loads(self.VECTORS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 200)
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
                block = ct_wisdom_activity.render_activity_block(
                    {"id": "f1", "title": "T", "text": "x", "provenance": "p"}, [], a)
                label = case["expected_line"]
                if len(label) > ct_wisdom_activity.LABEL_CHARS:
                    label = label[:ct_wisdom_activity.LABEL_CHARS - 1] + "\u2026"
                self.assertIn("_for: %s_" % label, block)
        self.assertEqual(ran, len(cases))

    def test_keys_distinct(self):
        cases = {c["name"]: c for c in json.loads(self.VECTORS.read_text(encoding="utf-8"))}
        checked = 0
        for case in cases.values():
            other = case.get("key_distinct_from")
            if not other:
                continue
            with self.subTest(case["name"]):
                # Each case in its own world, one after the other, at the SAME
                # path (the shared runner's rule): no fs cross-talk, and keys
                # (digests of full paths) stay comparable.
                parent = os.path.realpath(tempfile.mkdtemp(prefix="ct-da-pair-"))
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

    def test_untranslated_args_never_reach_the_builder(self):
        self.assertEqual(act.translate("edit_file", {"path": "a", "edits": [{"oldText": "S"}]}),
                         ("patch", {"path": "a"}))
        self.assertEqual(act.translate("shell", {"command": "ls"}), ("terminal", {"command": "ls"}))


class CtToolTests(unittest.TestCase):
    def test_ct_tools(self):
        for name, cat in (("curated_recall_context", "mcp"), ("ct_curated_get_wiki_entry", "mcp"),
                          ("mcp__curated-thoughts__wiki_context", None)):
            self.assertTrue(act.is_ct_tool(name, cat), name)
        for name, cat in (("read_file", "filesystem"), ("shell", "shell"),
                          ("github_search", "mcp"), ("ct_curated_x", "filesystem")):
            self.assertFalse(act.is_ct_tool(name, cat), name)
        self.assertTrue(act.is_recall_tool("ct_curated_recall_context", "mcp"))
        self.assertFalse(act.is_recall_tool("curated_get_wiki_entry", "mcp"))


class ActivityDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.fake = FakeCT(recall=[fact("boot1")], match={
            "src/a.py": [fact("act1"), fact("act2")], "pnpm test": [fact("act3")]})

    def tearDown(self):
        self.e.cleanup()

    def h(self, payload):
        with patched(self.fake):
            return da.handle(payload, self.e.env)

    def test_delivers_one_fact_marker_first_within_budget(self):
        self.h(llm("s1"))
        out = updated_response(self.h(tool("s1", args={"path": "src/a.py"})))
        block = out[len("file text\n\n\n"):]
        self.assertTrue(block.startswith("## Curated Thoughts \u2014 relevant to this step\n"
                                         "_for: read src/a.py_\n\n<!-- ct-fact:act1 -->"))
        self.assertNotIn("act2", block)
        self.assertLessEqual(len(block), ct_wisdom_activity.ACTIVITY_MAX_BLOCK_CHARS)
        self.assertEqual(self.fake.queries(), ["src/a.py"])
        self.assertEqual([c[2] for c in self.fake.calls if c[0] == "match"], [1])

    def test_one_query_per_step(self):
        self.h(llm("s1"))
        self.h(tool("s1", args={"path": "src/a.py"}))
        self.assertIsNone(self.h(tool("s1", name="shell", category="shell",
                                      args={"cmd": "pnpm test"})))
        self.assertEqual(self.fake.queries(), ["src/a.py"])
        self.h(llm("s1", iteration=2))
        self.assertIsNotNone(self.h(tool("s1", name="shell", category="shell",
                                         args={"cmd": "pnpm test"})))

    def test_same_key_never_requeries_and_file_verbs_fold(self):
        self.h(llm("s1"))
        self.h(tool("s1", args={"path": "src/a.py"}))
        self.h(llm("s1", iteration=2))
        self.assertIsNone(self.h(tool("s1", name="edit_file", args={"path": "src/a.py",
                                                                    "edits": []})))
        self.assertEqual(self.fake.queries(), ["src/a.py"])

    def test_ct_tools_never_trigger(self):
        self.h(llm("s1"))
        self.h(tool("s1", name="curated_recall_context", category="mcp",
                    args={"query": "src/a.py"}, response="{}"))
        self.assertEqual(self.fake.queries(), [])

    def test_already_in_ledger_is_skipped(self):
        self.fake.match = {"src/a.py": [fact("boot1")]}
        self.fake.honor_exclude = False
        self.h(llm("s1"))
        self.assertIsNone(self.h(tool("s1", args={"path": "src/a.py"})))

    def test_write_result_keeps_its_json(self):
        self.h(llm("s1"))
        out = updated_response(self.h(tool("s1", name="write_file",
                                            args={"path": "src/a.py", "content": "x"},
                                            response='{"bytes_written": 3}')))
        data = json.loads(out)
        self.assertEqual(data["bytes_written"], 3)
        self.assertIn("ct-fact:act1", data["curated_thoughts_wisdom"])

    def test_deferred_and_activity_share_one_result(self):
        self.fake.match["deploy?"] = [fact("live1")]
        self.h(llm("s1"))
        self.h(prompt("s1", "deploy?"))
        out = updated_response(self.h(tool("s1", args={"path": "src/a.py"})))
        self.assertLess(out.index("relevant now"), out.index("relevant to this step"))
        self.assertIn("ct-fact:live1", out)
        self.assertIn("ct-fact:act1", out)

    def test_subagent_sessions_get_activity(self):
        self.h(llm("child"))
        self.assertIsNotNone(self.h(tool("child", args={"path": "src/a.py"})))

    def test_parallel_batch_one_query(self):
        self.h(llm("s1"))
        outs = []
        barrier = threading.Barrier(8)

        def worker(i):
            barrier.wait()
            outs.append(self.h(tool("s1", args={"path": "src/a.py" if i == 0 else "f%d" % i},
                                    use_id="c%d" % i)))

        with patched(self.fake):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len([c for c in self.fake.calls if c[0] == "match"]), 1)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for hooks/session-start.py and hooks/hooks.json.

The hook is exercised the way Claude Code runs it: as a subprocess, with a
JSON payload on stdin and an environment that points every Curated Thoughts
lookup at temp dirs. HOME/USERPROFILE and CURATED_BRAIN_DIR are overridden
and CLAUDE_PLUGIN_ROOT is a temp copy of the plugin, so nothing on the host
is read or written.

Run directly: python3 tests/test_hook.py
"""

from __future__ import annotations

import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
HOOK = INTEGRATION / "hooks" / "session-start.py"
HOOKS_JSON = INTEGRATION / "hooks" / "hooks.json"

# The payload Claude Code writes to the hook's stdin. The hook ignores every
# field; it must still drain it rather than leave the writer blocked.
PAYLOAD = json.dumps(
    {
        "session_id": "test-session",
        "transcript_path": "/tmp/does-not-exist.jsonl",
        "cwd": "/tmp",
        "hook_event_name": "SessionStart",
        "source": "startup",
    }
)

# Env vars that would otherwise leak the developer's real install into a run.
_SCRUB = (
    "CURATED_BRAIN_DIR",
    "CURATED_BRAIN_DB",
    "CURATED_BRAIN_CONFIG",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_CT_SIDECAR",
)

WISDOM = INTEGRATION / "hooks" / "ct_wisdom_cc.py"

FAKE_CT = r'''
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "ct_calls.log"), "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\n")
with open(os.path.join(here, "ct_fixture.json"), encoding="utf-8") as handle:
    fixture = json.load(handle)
if args == ["--help"]:
    print("Curated Thoughts (fake ct for tests)")
elif args[:1] == ["recall"]:
    print(json.dumps({"wiki": fixture["wiki"]}))
elif args[:3] == ["wisdom", "match", "--help"]:
    print("usage: ct wisdom match")
elif args[:2] == ["wisdom", "match"]:
    print(json.dumps(fixture["match"]))
else:
    sys.exit(2)
'''


def _install_fake_ct(bin_dir):
    """`ct` on PATH: a /bin/sh shim (POSIX) or a .bat (Windows) that runs the
    absolute interpreter on fake_ct.py, so a spaced interpreter path works."""
    script = bin_dir / "fake_ct.py"
    script.write_text(FAKE_CT, encoding="utf-8")
    if os.name == "nt":
        (bin_dir / "ct.bat").write_text(
            '@"%s" "%s" %%*\r\n' % (sys.executable, script), encoding="utf-8"
        )
    else:
        shim = bin_dir / "ct"
        shim.write_text('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, script),
                        encoding="utf-8")
        shim.chmod(0o755)


class HookTestCase(unittest.TestCase):
    """Runs the hook out-of-process against temp dirs only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

        self.home = self.root / "home"
        self.home.mkdir()
        self.brain = self.home / ".brain"
        self.brain.mkdir()
        (self.brain / "config.json").write_text(
            json.dumps({"vault_path": str(self.home / "vault")}), encoding="utf-8"
        )
        (self.home / "vault").mkdir()

        # A real copy of the plugin, so CLAUDE_PLUGIN_ROOT resolves to a
        # scripts/ somewhere other than the checkout.
        self.plugin = self.root / "plugin"
        shutil.copytree(
            INTEGRATION / "scripts",
            self.plugin / "scripts",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        shutil.copytree(
            INTEGRATION / "hooks",
            self.plugin / "hooks",
            ignore=shutil.ignore_patterns("__pycache__"),
        )

        # A fake `ct` first on PATH, so the wisdom bootstrap never reaches a
        # real Curated Thoughts install on the developer's machine. It
        # answers the identity probe, `ct recall` (no hits unless a test
        # rewrites ct_fixture.json) and `ct wisdom match`.
        self.ct_bin = self.root / "bin"
        self.ct_bin.mkdir()
        self.write_ct_fixture()
        _install_fake_ct(self.ct_bin)
        self.plugin_data = self.root / "plugin-data"

    def write_ct_fixture(self, wiki=(), entries=(), corrections=()):
        (self.ct_bin / "ct_fixture.json").write_text(
            json.dumps({"wiki": list(wiki),
                        "match": {"entries": list(entries), "corrections": list(corrections)}}),
            encoding="utf-8",
        )

    def run_hook(self, script=None, payload=None, **env_overrides):
        """Run the hook as a subprocess; return (proc, elapsed_seconds)."""
        env = dict(os.environ)
        for name in _SCRUB:
            env.pop(name, None)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env["CURATED_BRAIN_DIR"] = str(self.brain)
        env["CLAUDE_PLUGIN_ROOT"] = str(self.plugin)
        env["CLAUDE_PLUGIN_DATA"] = str(self.plugin_data)
        env["PATH"] = str(self.ct_bin) + os.pathsep + env.get("PATH", "")
        for key, value in env_overrides.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value

        target = script or (self.plugin / "hooks" / "session-start.py")
        started = time.monotonic()
        proc = subprocess.run(
            [sys.executable, str(target)],
            input=PAYLOAD if payload is None else json.dumps(payload),
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        return proc, time.monotonic() - started


class OutputShapeTests(HookTestCase):
    """The directive Claude Code reads: one JSON line, SessionStart shape."""

    def test_emits_one_session_start_directive_and_exits_zero(self):
        proc, _ = self.run_hook()
        self.assertEqual(proc.returncode, 0, proc.stderr)

        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, "expected exactly one JSON line: %r" % proc.stdout)

        directive = json.loads(lines[0])
        self.assertEqual(list(directive), ["hookSpecificOutput"])
        specific = directive["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "SessionStart")
        self.assertIsInstance(specific["additionalContext"], str)
        self.assertTrue(specific["additionalContext"].startswith("## Curated Thoughts"))

    def test_context_carries_the_routing_reminder(self):
        # Every branch of ct_status.context_section appends it; the hook must
        # pass the section through untouched.
        proc, _ = self.run_hook()
        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("wiki_context", context)

    def test_emits_no_hermes_shaped_context_key(self):
        # Hermes emits {"context": ...}; Claude Code ignores that shape.
        proc, _ = self.run_hook()
        self.assertNotIn("context", json.loads(proc.stdout))
    def test_a_none_section_prints_nothing_at_all(self):
        # context_section() returns None when its internal snapshot() raises.
        # The hook must print nothing rather than an empty additionalContext,
        # the same `if section:` guard the Hermes hook uses.
        (self.plugin / "scripts" / "ct_status.py").write_text(
            "def context_section(env=None):\n    return None\n",
            encoding="utf-8",
        )
        proc, _ = self.run_hook()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")

    def test_an_empty_section_prints_nothing_at_all(self):
        (self.plugin / "scripts" / "ct_status.py").write_text(
            'def context_section(env=None):\n    return ""\n',
            encoding="utf-8",
        )
        proc, _ = self.run_hook()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")



class DegradedTests(HookTestCase):
    """A broken brain dir must surface, not be swallowed."""

    def test_missing_brain_dir_reports_degraded(self):
        missing = self.root / "no-such-brain"
        proc, _ = self.run_hook(CURATED_BRAIN_DIR=str(missing))
        self.assertEqual(proc.returncode, 0, proc.stderr)

        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("DEGRADED", context)
        self.assertIn(str(missing), context)


class PluginRootTests(HookTestCase):
    """The script locates itself from __file__ and ignores the environment.

    hooks.json expands ${CLAUDE_PLUGIN_ROOT} into the path the script is
    invoked by, so __file__ already carries that information. Reading the
    variable would trip Hermes's repo-wide guard for no benefit — see the
    spec's section 11, Q6, resolved by design.
    """

    MARKER = (
        "def context_section(env=None):\n"
        '    return "## Curated Thoughts\\nTEMP-ROOT-MARKER"\n'
    )

    def test_scripts_come_from_the_file_location(self):
        # The temp plugin's own copy of the hook must import the scripts
        # sitting beside it, not the checkout's.
        (self.plugin / "scripts" / "ct_status.py").write_text(
            self.MARKER, encoding="utf-8"
        )
        proc, _ = self.run_hook()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("TEMP-ROOT-MARKER", context)

    def test_a_wrong_plugin_root_is_ignored_not_obeyed(self):
        # The point of the design: a set-but-wrong CLAUDE_PLUGIN_ROOT cannot
        # steer the import, because the script never looks at it.
        (self.plugin / "scripts" / "ct_status.py").write_text(
            self.MARKER, encoding="utf-8"
        )
        proc, _ = self.run_hook(CLAUDE_PLUGIN_ROOT=str(self.root / "nope"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        context = json.loads(proc.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("TEMP-ROOT-MARKER", context)

    def test_unset_plugin_root_changes_nothing(self):
        proc, _ = self.run_hook(CLAUDE_PLUGIN_ROOT=None)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        directive = json.loads(proc.stdout)
        self.assertEqual(
            directive["hookSpecificOutput"]["hookEventName"], "SessionStart"
        )

    def test_the_source_never_reads_the_variable(self):
        # Mirrors Hermes's RepoWideContractTests guard, asserted here too so a
        # regression fails in this integration's own suite first.
        pattern = re.compile(
            r"""environ(?:\.get)?[\(\[]\s*["']CLAUDE_PLUGIN_ROOT"""
        )
        for script in (HOOK, WISDOM):
            self.assertIsNone(pattern.search(script.read_text(encoding="utf-8")), script)

class BudgetTests(HookTestCase):
    """Session start waits on this hook; hooks.json allows it 15s."""

    def test_completes_well_inside_the_timeout(self):
        # Interpreter startup is included, plus the wisdom bootstrap's two
        # fake-`ct` spawns (identity probe + recall), each its own
        # interpreter. A loose ceiling, not a measurement of either part.
        _, elapsed = self.run_hook()
        self.assertLess(elapsed, 3.0, "hook took %.3fs" % elapsed)


class HooksManifestTests(unittest.TestCase):
    """hooks.json is what registers the script; keep its contract asserted."""

    ACTIVITY_TOOLS = "Read|Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob"
    # event -> [(matcher or None, script, timeout seconds)], in order
    EXPECTED = {
        "SessionStart": [("startup|resume|clear|compact|fork", "session-start.py", 15)],
        "UserPromptSubmit": [(None, "ct_wisdom_cc.py", 15)],
        "PostToolUse": [("mcp__.*__curated_recall_context", "ct_wisdom_cc.py", 10),
                        (ACTIVITY_TOOLS, "ct_wisdom_cc.py", 5)],
        "PostToolUseFailure": [(ACTIVITY_TOOLS, "ct_wisdom_cc.py", 5)],
        # Autonomous-work delivery (spec 2026-10-17, D2, D10): 15 s, above the
        # adapter's 9 s CT budget plus two bounded 2 s lock waits.
        "PostToolBatch": [(None, "ct_wisdom_cc.py", 15)],
    }

    def setUp(self):
        self.manifest = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))

    def test_registers_exactly_the_expected_events(self):
        self.assertEqual(sorted(self.manifest["hooks"]), sorted(self.EXPECTED))

    def test_matchers_and_timeouts(self):
        for event, expected in self.EXPECTED.items():
            with self.subTest(event=event):
                entries = self.manifest["hooks"][event]
                self.assertEqual(len(entries), len(expected))
                for entry, (matcher, _script, timeout) in zip(entries, expected):
                    self.assertEqual(entry.get("matcher"), matcher)
                    hooks = entry["hooks"]
                    self.assertEqual(len(hooks), 1)
                    self.assertEqual(hooks[0]["type"], "command")
                    self.assertEqual(hooks[0]["timeout"], timeout)
                    self.assertNotIn("async", hooks[0])

    def test_batch_timeout_is_above_the_internal_budget(self):
        sys.path.insert(0, str(HOOK.parent))
        import ct_wisdom_cc
        worst = ct_wisdom_cc.ACTIVITY_CT_BUDGET + 2 * ct_wisdom_cc.LOCK_WAIT + 1.0
        self.assertLess(worst, self.EXPECTED["PostToolBatch"][0][2])

    def test_post_tool_use_matcher_is_recall_only(self):
        # Rule m4: never curated_get_wiki_entry (plan-time lookups carry no
        # wiki ids). Claude Code matchers are regexes over the tool name.
        matcher = re.compile(self.EXPECTED["PostToolUse"][0][0])
        self.assertTrue(matcher.fullmatch("mcp__curated-thoughts__curated_recall_context"))
        self.assertFalse(matcher.fullmatch("mcp__curated-thoughts__curated_get_wiki_entry"))

    def test_activity_matcher_is_an_exact_name_list(self):
        # Letters and `|` only: Claude Code compares exact names, so
        # `NotebookEdit` and MCP tools never match `Edit` by substring.
        self.assertRegex(self.ACTIVITY_TOOLS, r"^[A-Za-z|]+$")

    def test_command_tries_python3_then_python_with_quoted_paths(self):
        for event, expected in self.EXPECTED.items():
            for index, (_matcher, script, _timeout) in enumerate(expected):
                with self.subTest(event=event, index=index):
                    command = self.manifest["hooks"][event][index]["hooks"][0]["command"]
                    # Windows has `python`, most POSIX installs have `python3`;
                    # the fallback is what makes one manifest work on both.
                    self.assertIn('python3 "${CLAUDE_PLUGIN_ROOT}/hooks/%s"' % script, command)
                    self.assertIn('|| python "${CLAUDE_PLUGIN_ROOT}/hooks/%s"' % script, command)

    def test_the_registered_scripts_exist(self):
        self.assertTrue(HOOK.is_file())
        self.assertTrue(WISDOM.is_file())


class WisdomHookTests(HookTestCase):
    """The wisdom hooks end to end as subprocesses: fake `ct`, temp store."""

    SID = "5f0c1d7e-0000-4000-8000-000000000001"

    def start_payload(self, source="startup"):
        return {"session_id": self.SID, "hook_event_name": "SessionStart",
                "source": source, "cwd": str(self.root)}

    def prompt_payload(self, prompt="how do we deploy?"):
        return {"session_id": self.SID, "prompt_id": "p-%d" % time.monotonic_ns(),
                "hook_event_name": "UserPromptSubmit", "prompt": prompt,
                "cwd": str(self.root), "permission_mode": "default"}

    def directive(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        if not lines:
            return None
        self.assertEqual(len(lines), 1, proc.stdout)
        return json.loads(lines[0])["hookSpecificOutput"]

    def store(self):
        path = self.plugin_data / "wisdom" / "sessions" / (self.SID + ".json")
        return json.loads(path.read_text(encoding="utf-8"))

    def test_startup_appends_the_bootstrap_and_seeds_the_store(self):
        self.write_ct_fixture(wiki=[{"id": "boot1", "title": "Deploys", "text": "Use the runbook."}])
        out = self.directive(self.run_hook(payload=self.start_payload())[0])
        context = out["additionalContext"]
        self.assertTrue(context.startswith("## Curated Thoughts"))
        self.assertIn("## Curated Thoughts — relevant memory", context)
        self.assertIn("<!-- ct-fact:boot1 -->", context)
        self.assertEqual(self.store()["bootstrap_ids"], ["boot1"])
        self.assertEqual(self.store()["state"], "on")

    def test_live_turn_delivers_once_then_dedups(self):
        self.run_hook(payload=self.start_payload())
        self.write_ct_fixture(entries=[{"id": "live1", "title": "Rollbacks", "text": "Tag first."}])
        wisdom = self.plugin / "hooks" / "ct_wisdom_cc.py"
        first = self.directive(self.run_hook(script=wisdom, payload=self.prompt_payload())[0])
        self.assertEqual(first["hookEventName"], "UserPromptSubmit")
        self.assertIn("<!-- ct-fact:live1 -->", first["additionalContext"])
        second = self.directive(self.run_hook(script=wisdom, payload=self.prompt_payload())[0])
        self.assertIsNone(second, "already delivered: nothing injected")
        calls = (self.ct_bin / "ct_calls.log").read_text(encoding="utf-8")
        self.assertIn('"--exclude=live1"', calls)

    def test_background_agent_report_is_not_a_user_turn(self):
        self.run_hook(payload=self.start_payload())
        self.write_ct_fixture(entries=[{"id": "live1", "title": "T", "text": "x"}])
        wisdom = self.plugin / "hooks" / "ct_wisdom_cc.py"
        payload = self.prompt_payload('<agent-message from="a1">\n[Subagent hand-back] done')
        self.assertIsNone(self.directive(self.run_hook(script=wisdom, payload=payload)[0]))

    def test_resume_turns_delivery_off(self):
        self.run_hook(payload=self.start_payload())
        self.run_hook(payload=self.start_payload("resume"))
        self.write_ct_fixture(entries=[{"id": "live1", "title": "T", "text": "x"}])
        wisdom = self.plugin / "hooks" / "ct_wisdom_cc.py"
        self.assertIsNone(self.directive(self.run_hook(script=wisdom, payload=self.prompt_payload())[0]))
        self.assertEqual(self.store()["state"], "off")

    def test_recall_tool_result_is_stubbed(self):
        self.write_ct_fixture(wiki=[{"id": "boot1", "title": "Deploys", "text": "Use the runbook."}])
        self.run_hook(payload=self.start_payload())
        inner = {"wiki_entries": [{"id": "boot1", "title": "Deploys", "text": "Use the runbook."}],
                 "code_chunks": [], "query": "deploy"}
        payload = {"session_id": self.SID, "hook_event_name": "PostToolUse",
                   "tool_name": "mcp__curated-thoughts__curated_recall_context",
                   "tool_input": {"query": "deploy"}, "tool_use_id": "t1",
                   "tool_response": [{"type": "text", "text": json.dumps(inner)}]}
        wisdom = self.plugin / "hooks" / "ct_wisdom_cc.py"
        out = self.directive(self.run_hook(script=wisdom, payload=payload)[0])
        rewritten = json.loads(out["updatedToolOutput"][0]["text"])
        self.assertTrue(rewritten["wiki_entries"][0]["in_context"])

    def test_garbage_stdin_exits_zero_silently(self):
        wisdom = self.plugin / "hooks" / "ct_wisdom_cc.py"
        proc = subprocess.run([sys.executable, str(wisdom)], input="{not json",
                              capture_output=True, text=True, timeout=30)
        self.assertEqual((proc.returncode, proc.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()

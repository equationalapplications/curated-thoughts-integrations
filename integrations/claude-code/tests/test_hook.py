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
    "CLAUDE_CT_SIDECAR",
)


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
        (self.plugin / "hooks").mkdir()
        shutil.copy2(HOOK, self.plugin / "hooks" / "session-start.py")

    def run_hook(self, script=None, **env_overrides):
        """Run the hook as a subprocess; return (proc, elapsed_seconds)."""
        env = dict(os.environ)
        for name in _SCRUB:
            env.pop(name, None)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env["CURATED_BRAIN_DIR"] = str(self.brain)
        env["CLAUDE_PLUGIN_ROOT"] = str(self.plugin)
        for key, value in env_overrides.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value

        target = script or (self.plugin / "hooks" / "session-start.py")
        started = time.monotonic()
        proc = subprocess.run(
            [sys.executable, str(target)],
            input=PAYLOAD,
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
        self.assertIsNone(pattern.search(HOOK.read_text(encoding="utf-8")))

class BudgetTests(HookTestCase):
    """Session start waits on this hook; hooks.json allows it 10s."""

    def test_completes_well_under_a_second(self):
        # Interpreter startup is included, so this is a loose ceiling on the
        # <200ms target rather than a measurement of context_section itself.
        _, elapsed = self.run_hook()
        self.assertLess(elapsed, 1.0, "hook took %.3fs" % elapsed)


class HooksManifestTests(unittest.TestCase):
    """hooks.json is what registers the script; keep its contract asserted."""

    def setUp(self):
        self.manifest = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))

    def test_registers_session_start_for_the_four_sources(self):
        entries = self.manifest["hooks"]["SessionStart"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["matcher"], "startup|resume|clear|compact")

    def test_command_tries_python3_then_python_with_quoted_paths(self):
        hook = self.manifest["hooks"]["SessionStart"][0]["hooks"][0]
        self.assertEqual(hook["type"], "command")
        self.assertEqual(hook["timeout"], 10)
        # Windows has `python`, most POSIX installs have `python3`; the
        # fallback is what makes one manifest work on both.
        self.assertIn(
            'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.py"', hook["command"]
        )
        self.assertIn(
            '|| python "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.py"', hook["command"]
        )

    def test_the_registered_script_exists(self):
        self.assertTrue(HOOK.is_file())


if __name__ == "__main__":
    unittest.main()

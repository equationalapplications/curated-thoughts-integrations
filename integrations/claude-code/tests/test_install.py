#!/usr/bin/env python3
"""Tests for scripts/install.sh.

Two kinds of test live here, and the difference matters for the Windows skip
count:

* **Text tests** read install.sh as a file and never run it. They assert the
  contract that cannot drift silently — the sidecar candidate list stays in
  parity with scripts/ct_env.py, the script copies nothing, it honours
  CLAUDE_CT_SIDECAR (not Hermes's HERMES_CT_SIDECAR), and it never writes
  ~/.claude.json itself. These run everywhere, Windows included.

* **Subprocess tests** run install.sh with bash, HOME pointed at a tempdir so
  nothing on the host is read or written. install.sh is a bash script by
  design and CI's Windows runner has no bash on PATH, so — exactly as
  integrations/hermes/tests/test_install.py does — every one of those is
  skipped when sys.platform == "win32". Git Bash being present on a
  particular developer's Windows box does not make the skip wrong; the skip
  guards the platform CI actually runs.

The `claude mcp add` path is never exercised against the real `claude`
binary. The CT_INSTALL_EDIT tests put a fake `claude` shim on a temp PATH
that logs its argv and answers `mcp get` from a state file.

Run directly: python3 tests/test_install.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
INSTALL_SH = (INTEGRATION / "scripts" / "install.sh").resolve()

sys.path.insert(0, str(INTEGRATION / "scripts"))

import ct_env  # noqa: E402

SCRIPT_TIMEOUT = 60  # every subprocess gets a hard timeout

IS_WINDOWS = sys.platform == "win32"
# install.sh is a bash script by design; CI's Windows runner has no bash on
# PATH, so the subprocess tests are skipped there rather than the shipped
# installer rewritten. Text-only tests below are not skipped.
BASH_SKIP = "POSIX-only: runs install.sh, a bash script, under bash"

INSTALL_TEXT = INSTALL_SH.read_text(encoding="utf-8")

# Env vars that would otherwise leak the developer's real install into a run.
_SCRUB = (
    "CT_INSTALL_EDIT",
    "CLAUDE_CT_SIDECAR",
    "CURATED_BRAIN_DIR",
    "CURATED_BRAIN_DB",
    "CURATED_BRAIN_CONFIG",
)

# A fake `claude`: logs every invocation's argv one line per call, answers
# `mcp get` from a state file, and creates that state file on `mcp add`. It
# never touches the developer's real configuration.
CLAUDE_SHIM = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$CLAUDE_SHIM_LOG"
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then
  if [ -f "$CLAUDE_SHIM_STATE" ]; then exit 0; fi
  printf 'No MCP server found with name: %s\\n' "${3:-}" >&2
  exit 1
fi
if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "add" ]; then
  printf 'added\\n' >"$CLAUDE_SHIM_STATE"
  exit 0
fi
exit 0
"""


# The external commands install.sh calls. A test that needs a PATH with no
# `claude` and no sidecar on it cannot simply blank PATH — the script would
# lose these too and die at line one.
REQUIRED_TOOLS = ("dirname", "uname", "sed", "cat", "printenv")


def tool_path():
    """A PATH holding only the dirs install.sh's own tools live in.

    Returns (path, reason). `reason` is non-None when such a PATH cannot be
    built without also re-exposing a real sidecar or `claude`, in which case
    the caller skips rather than pretends.
    """
    dirs = []
    for tool in REQUIRED_TOOLS:
        found = shutil.which(tool)
        if not found:
            return None, "install.sh needs {} and it is not on PATH".format(tool)
        parent = str(Path(found).resolve().parent)
        if parent not in dirs:
            dirs.append(parent)
    for d in dirs:
        for name in (ct_env.SIDECAR_NAME, "claude"):
            if shutil.which(name, path=d):
                return None, (
                    "cannot build a sidecar-free PATH: {} also holds {}".format(d, name)
                )
    return os.pathsep.join(dirs), None


def tree_snapshot(root: Path):
    """Every path under root plus its bytes, for a 'wrote nothing' assertion."""
    out = {}
    for path in sorted(root.rglob("*")):
        key = str(path.relative_to(root))
        out[key] = path.read_bytes() if path.is_file() else None
    return out


class InstallShTestCase(unittest.TestCase):
    """Runs install.sh out-of-process against tempdirs only."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ct-cc-install-test-")
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()

    # helpers ------------------------------------------------------------

    def run_install(self, extra_env=None, path=None):
        """Run install.sh with bash, HOME in a tempdir, cwd outside the repo."""
        env = dict(os.environ)
        for name in _SCRUB:
            env.pop(name, None)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        if path is not None:
            env["PATH"] = path
        if extra_env:
            for key, value in extra_env.items():
                if value is None:
                    env.pop(key, None)
                else:
                    env[key] = value
        return subprocess.run(
            ["bash", str(INSTALL_SH)],
            capture_output=True,
            text=True,
            timeout=SCRIPT_TIMEOUT,
            env=env,
            cwd=str(self.root),
        )

    def sidecar_free_env(self):
        """Env overrides that hide every bundled sidecar candidate.

        The Windows roots are redirected at an empty tempdir and HOME is
        already one, which covers every candidate except the fixed system
        paths (/usr/bin, /opt/..., /Applications). Those cannot be hidden
        from a child process, so a developer who has Curated Thoughts
        installed there gets a skip with the reason rather than a test that
        quietly asserts the wrong thing.
        """
        hide = self.root / "empty-root"
        hide.mkdir(exist_ok=True)
        real_home = str(Path(os.path.expanduser("~")).resolve())
        for cand in ct_env.sidecar_candidates(env={}):
            path = Path(str(cand))
            if str(path).startswith(real_home):
                continue  # the child's HOME is a fresh tempdir
            if path.exists():
                self.skipTest("a real sidecar is installed at {}".format(path))
        return {
            "LOCALAPPDATA": str(hide),
            "PROGRAMFILES": str(hide),
            "ProgramFiles(x86)": str(hide),
        }

    def bare_path(self):
        """A PATH with install.sh's tools but no `claude` and no sidecar."""
        path, reason = tool_path()
        if reason:
            self.skipTest(reason)
        return path

    def write_claude_shim(self):
        """Install the fake `claude` on a temp PATH; return (path, log, state)."""
        shim = self.bin / "claude"
        shim.write_text(CLAUDE_SHIM, encoding="utf-8")
        shim.chmod(0o755)
        log = self.root / "claude-argv.log"
        state = self.root / "claude-registered"
        path = os.pathsep.join([str(self.bin), self.bare_path()])
        return path, log, state

    def fake_sidecar(self, dirname="Curated Thoughts"):
        """An executable file under a directory whose name contains a space."""
        d = self.root / dirname
        d.mkdir(parents=True, exist_ok=True)
        exe = d / ct_env.SIDECAR_NAME
        exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        exe.chmod(0o755)
        return exe

    def add_calls(self, log: Path):
        """`mcp add` invocations recorded by the shim."""
        if not log.exists():
            return []
        lines = log.read_text(encoding="utf-8").splitlines()
        return [line for line in lines if line.startswith("mcp add ")]


# ---------------------------------------------------------------------------
# Text-only contract tests. These inspect install.sh; they never run it, so
# they are not skipped on Windows.
# ---------------------------------------------------------------------------


class ScriptTextTests(unittest.TestCase):
    def test_shebang_and_strict_mode(self):
        self.assertTrue(INSTALL_TEXT.startswith("#!/usr/bin/env bash"))
        self.assertIn("set -euo pipefail", INSTALL_TEXT)

    def test_prints_the_user_scope_mcp_add_command(self):
        self.assertIn("claude mcp add --scope user", INSTALL_TEXT)
        self.assertIn("--mcp", INSTALL_TEXT)

    def test_honours_the_claude_code_sidecar_override_not_the_hermes_one(self):
        """The override is CLAUDE_CT_SIDECAR — the name ct_doctor.py reads."""
        self.assertIn("CLAUDE_CT_SIDECAR", INSTALL_TEXT)
        self.assertNotIn("HERMES_CT_SIDECAR", INSTALL_TEXT)

    def test_writes_are_gated_behind_ct_install_edit(self):
        self.assertIn("CT_INSTALL_EDIT", INSTALL_TEXT)

    def test_never_edits_the_claude_config_files_directly(self):
        """D1: the only writer is `claude mcp add`, never a redirect."""
        for target in (".claude.json", ".claude/settings.json"):
            for redirect in (">", ">>"):
                self.assertNotIn(
                    "{}{}".format(redirect, target), INSTALL_TEXT.replace(" ", "")
                )

    def test_copies_nothing(self):
        """Claude Code loads a plugin in place; there is no destination tree."""
        for forbidden in ("cp -R", "cp -r", "rsync", "rm -rf", "mkdir -p"):
            self.assertNotIn(forbidden, INSTALL_TEXT)

    def test_no_unquoted_sidecar_interpolation_in_printed_commands(self):
        """The Windows path contains a space; every printed use is quoted."""
        self.assertNotIn("-- ${SIDECAR} --mcp", INSTALL_TEXT)
        self.assertNotIn("-- $SIDECAR --mcp", INSTALL_TEXT)

    def test_finishes_with_the_doctor_next_step(self):
        self.assertIn("scripts/ct_doctor.py", INSTALL_TEXT)
        self.assertIn("python3", INSTALL_TEXT)

    def test_prints_the_plugin_dir_line(self):
        self.assertIn("--plugin-dir", INSTALL_TEXT)


class CandidateParityTests(unittest.TestCase):
    """install.sh must search exactly where scripts/ct_env.py searches.

    Two copies of a search order drift. Rather than restate the list, derive
    it from ct_env and assert each location appears in the script text.
    """

    WIN_ENV = {
        "LOCALAPPDATA": "/local",
        "PROGRAMFILES": "/pf",
        "ProgramFiles(x86)": "/pf86",
    }

    def test_windows_candidates_match_ct_env(self):
        cands = ct_env.sidecar_candidates(platform="win32", env=self.WIN_ENV)
        self.assertEqual(len(cands), 6)
        suffixes = set()
        for cand in cands:
            posix = str(cand).replace("\\", "/")
            for root in self.WIN_ENV.values():
                if posix.startswith(root + "/"):
                    suffixes.add(posix[len(root) + 1 :])
        self.assertEqual(
            suffixes,
            {
                "Programs/Curated Thoughts/{}.exe".format(ct_env.SIDECAR_NAME),
                "Curated Thoughts/{}.exe".format(ct_env.SIDECAR_NAME),
            },
        )
        for suffix in suffixes:
            self.assertIn(
                suffix.replace(ct_env.SIDECAR_NAME, "${SIDECAR_NAME}"), INSTALL_TEXT
            )

    def test_windows_roots_match_ct_env(self):
        for var in self.WIN_ENV:
            self.assertIn(var, INSTALL_TEXT)

    def test_macos_candidates_match_ct_env(self):
        cands = ct_env.sidecar_candidates(platform="darwin", env={})
        self.assertEqual(len(cands), 2)
        rel = "Curated Thoughts.app/Contents/MacOS/{}".format(ct_env.SIDECAR_NAME)
        for cand in cands:
            self.assertTrue(str(cand).replace("\\", "/").endswith(rel))
        self.assertIn("/Applications/${rel}", INSTALL_TEXT)
        self.assertIn("${HOME}/Applications/${rel}", INSTALL_TEXT)
        self.assertIn(
            'rel="Curated Thoughts.app/Contents/MacOS/${SIDECAR_NAME}"', INSTALL_TEXT
        )

    def test_linux_candidates_match_ct_env(self):
        cands = ct_env.sidecar_candidates(platform="linux", env={})
        home = str(Path(os.path.expanduser("~"))).replace("\\", "/")
        for cand in cands:
            posix = str(cand).replace("\\", "/")
            if posix.startswith(home):
                posix = "${HOME}" + posix[len(home) :]
            literal = posix.replace(ct_env.SIDECAR_NAME, "${SIDECAR_NAME}")
            self.assertIn(literal, INSTALL_TEXT)


# ---------------------------------------------------------------------------
# Subprocess tests. bash only.
# ---------------------------------------------------------------------------


@unittest.skipIf(IS_WINDOWS, BASH_SKIP)
class DefaultRunTests(InstallShTestCase):
    def test_default_run_exits_zero_and_writes_nothing(self):
        before = tree_snapshot(self.home)
        proc = self.run_install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(tree_snapshot(self.home), before)

    def test_output_contains_the_mcp_add_line(self):
        proc = self.run_install()
        self.assertIn("claude mcp add --scope user curated-thoughts --", proc.stdout)
        self.assertIn("--mcp", proc.stdout)

    def test_output_contains_the_json_block(self):
        proc = self.run_install()
        self.assertIn('"mcpServers"', proc.stdout)
        self.assertIn('"curated-thoughts"', proc.stdout)
        self.assertIn('"args": ["--mcp"]', proc.stdout)

    def test_output_contains_the_plugin_dir_line(self):
        proc = self.run_install()
        self.assertIn('claude --plugin-dir "', proc.stdout)
        self.assertIn(str(INTEGRATION.resolve().name), proc.stdout)

    def test_output_ends_with_the_doctor_next_step(self):
        proc = self.run_install()
        self.assertIn("ct_doctor.py", proc.stdout)
        self.assertIn("Next step", proc.stdout)

    def test_says_nothing_was_written_without_the_opt_in(self):
        proc = self.run_install()
        self.assertIn("Nothing was written", proc.stdout)
        self.assertIn("CT_INSTALL_EDIT=1", proc.stdout)


@unittest.skipIf(IS_WINDOWS, BASH_SKIP)
class SidecarResolutionTests(InstallShTestCase):
    def test_override_path_with_a_space_survives_quoting(self):
        """The real Windows path is .../Curated Thoughts/... — with a space."""
        exe = self.fake_sidecar()
        self.assertIn(" ", str(exe))
        proc = self.run_install({"CLAUDE_CT_SIDECAR": str(exe)})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        expected = 'claude mcp add --scope user curated-thoughts -- "{}" --mcp'.format(
            exe
        )
        self.assertIn(expected, proc.stdout)
        # The JSON block normalises to forward slashes: Windows accepts them
        # and they need no JSON escaping.
        posix_exe = str(exe).replace("\\", "/")
        self.assertIn('"command": "{}"'.format(posix_exe), proc.stdout)

    def test_missing_sidecar_warns_and_still_exits_zero(self):
        """Not found is a WARN plus a placeholder block, never a failure."""
        proc = self.run_install(self.sidecar_free_env(), path=self.bare_path())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("WARN:", proc.stderr)
        self.assertIn("releases/latest", proc.stderr)
        self.assertIn('-- "<path to curated-thoughts-mcp>" --mcp', proc.stdout)

    def test_override_is_reported_as_the_source(self):
        exe = self.fake_sidecar()
        proc = self.run_install({"CLAUDE_CT_SIDECAR": str(exe)})
        self.assertIn("found (via CLAUDE_CT_SIDECAR)", proc.stdout)


@unittest.skipIf(IS_WINDOWS, BASH_SKIP)
class InstallEditTests(InstallShTestCase):
    """CT_INSTALL_EDIT=1 against a fake `claude`, never the real binary."""

    def test_registers_exactly_once_then_never_again(self):
        path, log, state = self.write_claude_shim()
        exe = self.fake_sidecar()
        env = {
            "CT_INSTALL_EDIT": "1",
            "CLAUDE_CT_SIDECAR": str(exe),
            "CLAUDE_SHIM_LOG": str(log),
            "CLAUDE_SHIM_STATE": str(state),
        }

        first = self.run_install(env, path=path)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(len(self.add_calls(log)), 1, log.read_text())
        self.assertIn("registered.", first.stdout)

        # The shim now answers `mcp get` with success, so the second run must
        # leave the existing entry alone.
        second = self.run_install(env, path=path)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(len(self.add_calls(log)), 1, log.read_text())
        self.assertIn("already registered", second.stdout)

    def test_checks_mcp_get_before_adding(self):
        path, log, state = self.write_claude_shim()
        exe = self.fake_sidecar()
        self.run_install(
            {
                "CT_INSTALL_EDIT": "1",
                "CLAUDE_CT_SIDECAR": str(exe),
                "CLAUDE_SHIM_LOG": str(log),
                "CLAUDE_SHIM_STATE": str(state),
            },
            path=path,
        )
        calls = log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(calls[0], "mcp get curated-thoughts")

    def test_add_argv_carries_the_spaced_path_as_one_argument(self):
        path, log, state = self.write_claude_shim()
        exe = self.fake_sidecar()
        self.run_install(
            {
                "CT_INSTALL_EDIT": "1",
                "CLAUDE_CT_SIDECAR": str(exe),
                "CLAUDE_SHIM_LOG": str(log),
                "CLAUDE_SHIM_STATE": str(state),
            },
            path=path,
        )
        add = self.add_calls(log)[0]
        self.assertEqual(
            add,
            "mcp add --scope user curated-thoughts -- {} --mcp".format(exe),
        )

    def test_no_claude_on_path_warns_and_writes_nothing(self):
        exe = self.fake_sidecar()
        before = tree_snapshot(self.home)
        proc = self.run_install(
            {"CT_INSTALL_EDIT": "1", "CLAUDE_CT_SIDECAR": str(exe)},
            path=self.bare_path(),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("'claude' is not on PATH", proc.stderr)
        self.assertEqual(tree_snapshot(self.home), before)

    def test_no_sidecar_means_no_registration_attempt(self):
        path, log, state = self.write_claude_shim()
        env = dict(self.sidecar_free_env())
        env.update(
            {
                "CT_INSTALL_EDIT": "1",
                "CLAUDE_SHIM_LOG": str(log),
                "CLAUDE_SHIM_STATE": str(state),
            }
        )
        proc = self.run_install(env, path=path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("no sidecar was found", proc.stderr)
        self.assertEqual(self.add_calls(log), [])

    def test_opt_in_run_does_not_write_into_home(self):
        path, log, state = self.write_claude_shim()
        exe = self.fake_sidecar()
        before = tree_snapshot(self.home)
        self.run_install(
            {
                "CT_INSTALL_EDIT": "1",
                "CLAUDE_CT_SIDECAR": str(exe),
                "CLAUDE_SHIM_LOG": str(log),
                "CLAUDE_SHIM_STATE": str(state),
            },
            path=path,
        )
        self.assertEqual(tree_snapshot(self.home), before)


if __name__ == "__main__":
    unittest.main()

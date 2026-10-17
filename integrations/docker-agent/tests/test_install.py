"""Installer tests (spec D11, user decision 6), in a throwaway HOME."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _support import INTEGRATION

INSTALL = INTEGRATION / "scripts" / "install.sh"
BASH = shutil.which("bash")
MARKER = "# curated-thoughts-integrations: docker-agent drop-in"


@unittest.skipIf(BASH is None or sys.platform.startswith("win"), "bash installer; POSIX only")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="ct-da-inst-"))
        (self.home / ".brain").mkdir()
        self.agent = self.home / "agents" / "agent.yaml"
        self.agent.parent.mkdir()
        self.agent.write_text("agents:\n  root:\n    model: x\n", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_install(self, *args, **env):
        base = {"HOME": str(self.home), "PATH": os.environ.get("PATH", ""), "CT_SKIP_DOCTOR": "1",
                "CT_PYTHON": sys.executable}
        base.update(env)
        return subprocess.run([BASH, str(INSTALL), *args], capture_output=True, text=True,
                              env=base, timeout=120, cwd=str(self.home))

    def files(self):
        return sorted(str(p.relative_to(self.home)) for p in self.home.rglob("*") if p.is_file())

    @property
    def dropin(self):
        return self.home / ".config" / "cagent" / "hooks.d" / "50-curated-thoughts.yaml"

    def test_writes_only_the_drop_in(self):
        before = self.files()
        agent_bytes = self.agent.read_bytes()
        proc = self.run_install()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(sorted(set(self.files()) - set(before)),
                         [".config/cagent/hooks.d/50-curated-thoughts.yaml"])
        self.assertEqual(self.agent.read_bytes(), agent_bytes)

    def test_drop_in_content(self):
        self.run_install()
        text = self.dropin.read_text(encoding="utf-8")
        self.assertTrue(text.startswith(MARKER + "\n# version: 0.1.0\n"))
        for event in ("before_llm_call", "user_prompt_submit", "user_followup_submit",
                      "tool_response_transform"):
            self.assertRegex(text, r"(?m)^%s:$" % event)
        commands = re.findall(r"(?m)^\s*command: (.*)$", text)
        self.assertEqual(len(commands), 4)
        hook = str(INTEGRATION / "hooks" / "ct_wisdom_da.py")
        for command in commands:
            self.assertEqual(command, "'\"%s\" \"%s\" || exit 0'" % (sys.executable, hook))
        self.assertEqual(len(re.findall(r"(?m)^\s*on_error: ignore$", text)), 4)
        self.assertIn('matcher: "*"', text)
        self.assertNotIn("session_start", text)
        self.assertNotIn(str(self.home) + "/.config", text.split("\n", 3)[3].split("command")[0])

    def test_config_dir_overrides(self):
        target = self.home / "custom-cfg"
        self.run_install(DOCKER_AGENT_CONFIG_DIR=str(target))
        self.assertTrue((target / "hooks.d" / "50-curated-thoughts.yaml").is_file())
        self.assertFalse(self.dropin.exists())
        legacy = self.home / "legacy-cfg"
        self.run_install(CAGENT_CONFIG_DIR=str(legacy))
        self.assertTrue((legacy / "hooks.d" / "50-curated-thoughts.yaml").is_file())

    def test_xdg_config_home_is_ignored_like_docker_agent(self):
        self.run_install(XDG_CONFIG_HOME=str(self.home / "xdg"))
        self.assertTrue(self.dropin.is_file())
        self.assertFalse((self.home / "xdg").exists())

    def test_rerun_rewrites_and_uninstall_removes_only_it(self):
        self.run_install()
        other = self.dropin.parent / "10-other.yaml"
        other.write_text("turn_start: []\n", encoding="utf-8")
        self.assertEqual(self.run_install().returncode, 0)
        proc = self.run_install("--uninstall")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(self.dropin.exists())
        self.assertTrue(other.exists())

    def test_never_overwrites_a_foreign_file(self):
        self.dropin.parent.mkdir(parents=True)
        self.dropin.write_text("session_start: []\n", encoding="utf-8")
        proc = self.run_install()
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(self.dropin.read_text(encoding="utf-8"), "session_start: []\n")
        self.assertNotEqual(self.run_install("--uninstall").returncode, 0)
        self.assertTrue(self.dropin.exists())

    def test_print_only_writes_nothing(self):
        before = self.files()
        proc = self.run_install("--print-only")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.files(), before)
        self.assertIn(MARKER, proc.stdout)
        self.assertIn("type: mcp", proc.stdout)

    def test_refuses_a_broken_python(self):
        proc = self.run_install(CT_PYTHON="/bin/false")
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(self.dropin.exists())

    def test_snippet_names_env_keys_and_never_values(self):
        config = self.home / ".brain" / "config.json"
        config.write_text('{"embed_profile": {"type": "external", "base_url": '
                          '"https://openrouter.ai/api/v1", "model": "m"}}', encoding="utf-8")
        proc = self.run_install(OPENROUTER_API_KEY="sk-or-v1-SECRETSECRETSECRET")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY}", proc.stdout)
        self.assertNotIn("SECRET", proc.stdout + proc.stderr)
        self.assertNotIn("SECRET", self.dropin.read_text(encoding="utf-8"))
        self.assertIn('args: ["--mcp"]', proc.stdout)

    def test_snippet_without_readable_brain_is_commented(self):
        proc = self.run_install()
        self.assertIn("#   OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY}", proc.stdout)


if __name__ == "__main__":
    unittest.main()

"""Doctor tests: check 7 (the drop-in, spec D12), the env route, and the
embedded self-test suite of the shared doctor."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _support import INTEGRATION, SCRIPTS

import ct_doctor

INSTALL = INTEGRATION / "scripts" / "install.sh"
BASH = shutil.which("bash")


class RegistrationCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ct-da-doc-"))
        self.saved = ct_doctor.DROPIN_PATH
        ct_doctor.DROPIN_PATH = self.tmp / "hooks.d" / ct_doctor.DROPIN_NAME

    def tearDown(self):
        ct_doctor.DROPIN_PATH = self.saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def install(self):
        env = {"HOME": str(self.tmp), "PATH": os.environ.get("PATH", ""), "CT_SKIP_DOCTOR": "1",
               "CT_PYTHON": sys.executable, "DOCKER_AGENT_CONFIG_DIR": str(self.tmp)}
        subprocess.run([BASH, str(INSTALL)], env=env, capture_output=True, check=True, timeout=120)

    def test_missing_drop_in_fails(self):
        r = ct_doctor.check_docker_agent_registration()
        self.assertEqual((r.name, r.status), ("docker-agent-registration", ct_doctor.FAIL))
        self.assertIn("install.sh", r.hint)

    @unittest.skipIf(BASH is None or sys.platform.startswith("win"), "bash installer")
    def test_installed_drop_in_passes(self):
        self.install()
        r = ct_doctor.check_docker_agent_registration()
        self.assertEqual(r.status, ct_doctor.PASS, r.detail)
        self.assertIn("4 hooks", r.detail)
        self.assertIn("per agent file", r.detail)

    @unittest.skipIf(BASH is None or sys.platform.startswith("win"), "bash installer")
    def test_damaged_drop_ins_warn(self):
        self.install()
        good = ct_doctor.DROPIN_PATH.read_text(encoding="utf-8")
        for bad, why in (
            (good.replace(" || exit 0", "", 1), "exit 0"),
            (good.replace("    on_error: ignore\n", "", 1), "on_error"),
            (good.replace(ct_doctor.DROPIN_MARKER, "# hand written"), "marker"),
            (good.replace("user_followup_submit:", "x_followup:"), "user_followup_submit"),
            (good.replace(str(INTEGRATION / "hooks" / "ct_wisdom_da.py"), "/gone/hook.py"),
             "/gone/hook.py"),
        ):
            with self.subTest(why=why):
                ct_doctor.DROPIN_PATH.write_text(bad, encoding="utf-8")
                r = ct_doctor.check_docker_agent_registration()
                self.assertEqual(r.status, ct_doctor.WARN)
                self.assertIn(why, r.detail)

    def test_adapter_and_env_route(self):
        self.assertEqual(ct_doctor._check_registration(cwd="/x").name, "docker-agent-registration")
        self.assertIsNone(ct_doctor._sidecar_env_route())
        self.assertEqual(ct_doctor.HARNESS_LABEL, "Docker Agent")

    def test_env_fix_quotes_paths_like_install_sh(self):
        need = ct_doctor.ct_env.EnvNeed("CURATED_BRAIN_DIR", ct_doctor.ct_env.NEED_PATH, "r",
                                        '/x/a: b #c/&anchor "q"\\z')
        ref = ct_doctor.ct_env.EnvNeed("OPENROUTER_API_KEY", ct_doctor.ct_env.NEED_REF, "r")
        text = ct_doctor._sidecar_env_fix([need, ref])
        self.assertIn('CURATED_BRAIN_DIR: "/x/a: b #c/&anchor \\"q\\"\\\\z"', text)
        self.assertIn("OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY}", text)
        self.assertEqual(ct_doctor._yaml_quote("&lead"), '"&lead"')
        if BASH and not sys.platform.startswith("win"):
            # Same bytes as install.sh's yaml_quote.
            script = 'source /dev/stdin <<<"$(sed -n "/^yaml_quote()/,/^}/p" "$1")"; yaml_quote "$2"'
            out = subprocess.run([BASH, "-c", script, "x", str(INSTALL), need.value],
                                 capture_output=True, text=True, timeout=30).stdout
            self.assertEqual(out, ct_doctor._yaml_quote(need.value))

    def test_embedding_check_accepts_the_embedder_contract_keys(self):
        # Check 6 and check 6b must agree on key names (CodeRabbit, PR #59).
        for key in ("OPENROUTER_API_KEY", "EMBED_API_KEY"):
            env = {k: "" for k in ct_doctor.EMBED_ENV_KEYS}
            env.update({key: "set", "OLLAMA_HOST": "http://127.0.0.1:1"})
            r = ct_doctor.check_embedding(env=env)
            self.assertEqual(r.status, ct_doctor.PASS, (key, r.detail))
            self.assertIn(key, r.detail)

    def test_plugin_version_comes_from_plugin_json(self):
        self.assertEqual(ct_doctor._plugin_version(), "0.1.3")

    def test_config_dir_resolution(self):
        saved = {k: os.environ.get(k) for k in ("DOCKER_AGENT_CONFIG_DIR", "CAGENT_CONFIG_DIR")}
        try:
            os.environ["CAGENT_CONFIG_DIR"] = "/legacy"
            os.environ.pop("DOCKER_AGENT_CONFIG_DIR", None)
            self.assertEqual(ct_doctor._docker_agent_config_dir(), Path("/legacy"))
            os.environ["DOCKER_AGENT_CONFIG_DIR"] = "/new"
            self.assertEqual(ct_doctor._docker_agent_config_dir(), Path("/new"))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class SelfTestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # --self-test runs THIS module; the guard stops the child recursing.
        if os.environ.get("CT_DOCTOR_IN_SELF_TEST") == "1":
            raise unittest.SkipTest("recursion guard: already inside --self-test child")

    def test_embedded_self_test_passes(self):
        proc = subprocess.run([sys.executable, str(SCRIPTS / "ct_doctor.py"), "--self-test"],
                              capture_output=True, text=True, timeout=300,
                              env={**os.environ, "CT_DOCTOR_IN_SELF_TEST": "1"})
        self.assertEqual(proc.returncode, 0, proc.stdout[-2000:] + proc.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()

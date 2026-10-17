"""Host contract: the real, pinned Docker Agent binary (spec "CI host
contract").

Needs DOCKER_AGENT_BIN (the CI job downloads docker-agent v1.150.0 and checks
its sha256); skips otherwise. The binary runs in a throwaway HOME with our
drop-in installed by scripts/install.sh, a stdlib fake `ct` on PATH, and a
scripted OpenAI-compatible endpoint (mock_openai.py) that records every
request body, so the assertions are on exactly what the model would receive.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent.parent
BIN = os.environ.get("DOCKER_AGENT_BIN")
MARKER_RE = re.compile(r"<!-- ct-fact:([A-Za-z0-9._:-]+) -->")

FACTS = {
    "recall": [{"id": "boot1", "title": "Deploy rule", "text": "Deploys go through CI."}],
    "match": {
        "how do I deploy": [{"id": "live1", "title": "Release train", "text": "Tag from main."}],
        "src/a.py": [{"id": "act1", "title": "Module a", "text": "a.py owns billing."}],
    },
}

AGENT = """\
providers:
  mock:
    base_url: http://127.0.0.1:{port}/v1
    token_key: MOCK_KEY
    api_type: openai_chatcompletions
models:
  m:
    provider: mock
    model: mock-model
agents:
  root:
    model: m
    instruction: You are a test agent.
    sub_agents: [helper]
    toolsets:
      - type: filesystem
  helper:
    model: m
    description: A helper agent.
    instruction: You are a helper.
    toolsets:
      - type: filesystem
"""


def ids_in(body):
    out = []
    for msg in body.get("messages", []):
        content = msg.get("content")
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        out += MARKER_RE.findall(content or "")
    return out


@unittest.skipUnless(BIN and os.path.isfile(BIN), "DOCKER_AGENT_BIN not set (CI host job only)")
class HostContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="ct-da-host-"))
        cls.home = cls.root / "home"
        cls.cfg = cls.home / ".config" / "cagent"
        cls.bindir = cls.root / "bin"
        cls.bindir.mkdir(parents=True)
        fake = cls.bindir / "ct"
        fake.write_text("#!%s\n" % sys.executable + (HERE / "fake_ct.py").read_text(encoding="utf-8"),
                        encoding="utf-8")
        fake.chmod(0o755)
        (cls.root / "facts.json").write_text(json.dumps(FACTS), encoding="utf-8")
        cls.base_env = {
            "HOME": str(cls.home), "PATH": "%s:%s" % (cls.bindir, os.environ.get("PATH", "")),
            "DOCKER_AGENT_CONFIG_DIR": str(cls.cfg), "TELEMETRY_ENABLED": "false",
            "DOCKER_AGENT_HIDE_TELEMETRY_BANNER": "1", "MOCK_KEY": "x",
            "FAKE_CT_FACTS": str(cls.root / "facts.json"), "FAKE_CT_LOG": str(cls.root / "ct.log"),
        }
        proc = subprocess.run(["bash", str(INTEGRATION / "scripts" / "install.sh")],
                              env=dict(cls.base_env, CT_SKIP_DOCTOR="1", CT_PYTHON=sys.executable),
                              capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, proc.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def drive(self, name, script, session, messages, extra_env=None, data=None):
        """Run the binary once; returns (request bodies, stdout)."""
        work = self.root / name
        work.mkdir(exist_ok=True)
        (work / "src").mkdir(exist_ok=True)
        (work / "src" / "a.py").write_text("print('a')\n", encoding="utf-8")
        script_path, record, port_file = work / "script.json", work / "requests.jsonl", work / "port"
        script_path.write_text(json.dumps(script), encoding="utf-8")
        for p in (record, port_file):
            if p.exists():
                p.unlink()
        server = subprocess.Popen([sys.executable, str(HERE / "mock_openai.py"), str(script_path),
                                   str(record), str(port_file)])
        try:
            for _ in range(100):
                if port_file.exists() and port_file.read_text().strip():
                    break
                time.sleep(0.05)
            agent = work / "agent.yaml"
            agent.write_text(AGENT.format(port=port_file.read_text().strip()), encoding="utf-8")
            env = dict(self.base_env, DOCKER_AGENT_DATA_DIR=str(data or (self.root / "data")))
            env.update(extra_env or {})
            proc = subprocess.run([BIN, "run", "--yolo", "--session", session, str(agent), *messages],
                                  env=env, cwd=str(work), capture_output=True, text=True, timeout=300)
            self.assertEqual(proc.returncode, 0, proc.stderr[-3000:])
        finally:
            server.terminate()
            server.wait(timeout=10)
        bodies = [json.loads(line)["body"] for line in record.read_text(encoding="utf-8").splitlines()]
        return bodies, proc.stdout

    MAIN_SCRIPT = [{"tool_calls": [{"name": "read_file", "arguments": {"path": "src/a.py"}}]},
                   {"text": "one"}, {"text": "two"}]

    def test_main_session_resume_and_ct_queries(self):
        bodies, _ = self.drive("main", self.MAIN_SCRIPT, "sess-main", ["how do I deploy", "second"])
        self.assertEqual(len(bodies), 3)
        systems = {b["messages"][0]["content"] for b in bodies}
        self.assertEqual(len(systems), 1, "bootstrap bytes changed between calls")
        self.assertEqual(MARKER_RE.findall(bodies[0]["messages"][0]["content"]), ["boot1"])
        tool_msgs = [m for m in bodies[1]["messages"] if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 1)
        content = tool_msgs[0]["content"]
        self.assertTrue(content.startswith("print('a')\n\n\n## Curated Thoughts — relevant now"))
        self.assertLess(content.index("ct-fact:live1"), content.index("ct-fact:act1"))
        self.assertLess(content.index("<!-- ct-fact:act1 -->"), content.index("Module a"))
        for body in bodies:
            ids = ids_in(body)
            self.assertEqual(len(ids), len(set(ids)), ids)

        resumed, _ = self.drive("main", [{"text": "three"}], "sess-main", ["third"])
        self.assertEqual(resumed[0]["messages"][0]["content"], bodies[0]["messages"][0]["content"])
        replay = [m for m in resumed[0]["messages"] if m.get("role") == "tool"]
        self.assertEqual(replay[0]["content"], content)
        ids = ids_in(resumed[0])
        self.assertEqual(len(ids), len(set(ids)), ids)

        calls = [json.loads(line) for line in (self.root / "ct.log").read_text().splitlines()]
        queries = [c[c.index("--") + 1] for c in calls if c[:2] == ["wisdom", "match"] and "--" in c]
        self.assertIn("how do I deploy", queries)
        self.assertIn("src/a.py", queries)  # the bare target

    def test_helper_gets_its_own_bootstrap(self):
        script = [{"tool_calls": [{"name": "transfer_task", "arguments": {
            "agent": "helper", "task": "say hi", "expected_output": "hi"}}]},
            {"text": "helper done"}, {"text": "root done"}]
        bodies, _ = self.drive("helper", script, "sess-helper", ["delegate"],
                               data=self.root / "data-helper")
        helper = [b for b in bodies if b["messages"][0]["content"].startswith("You are a helper.")]
        self.assertEqual(len(helper), 1)
        self.assertEqual(MARKER_RE.findall(helper[0]["messages"][0]["content"]), ["boot1"])

    def test_sandbox_is_a_silent_no_op(self):
        bodies, out = self.drive("sandbox", self.MAIN_SCRIPT, "sess-sbx", ["how do I deploy"],
                                 extra_env={"SANDBOX_VM_ID": "vm-test", "CT_WISDOM_VERBOSE": "1"},
                                 data=self.root / "data-sbx")
        self.assertTrue(all(not ids_in(b) for b in bodies))
        self.assertNotIn("Curated Thoughts", out)
        self.assertFalse((self.root / "data-sbx" / "curated-thoughts").exists())

    def test_verbose_on_changes_no_request_byte(self):
        off, _ = self.drive("v-off", self.MAIN_SCRIPT, "sess-v", ["how do I deploy"],
                            data=self.root / "data-voff")
        on, out = self.drive("v-on", self.MAIN_SCRIPT, "sess-v", ["how do I deploy"],
                             extra_env={"CT_WISDOM_VERBOSE": "1"}, data=self.root / "data-von")
        self.assertEqual(on, off)
        self.assertIn("Curated Thoughts wisdom: delivered", out)
        log = self.root / "data-von" / "curated-thoughts" / "wisdom" / "ct-wisdom-verbose.jsonl"
        records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertIn("deferred", {r["channel"] for r in records})


if __name__ == "__main__":
    unittest.main()

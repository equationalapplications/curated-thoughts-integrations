#!/usr/bin/env python3
"""Tests for ct_wisdom_log.py — the verbose-log reader (spec D7)."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_wisdom_log  # noqa: E402
import ct_wisdom_verbose  # noqa: E402

DELIVERY = {
    "v": 1, "ts": "2026-10-16T12:00:00.000Z", "host": "hermes", "channel": "pre_llm_call",
    "session_id": "s1", "event": "delivery", "reason": None, "query": "how do I deploy?",
    "gate": "semantic-v1:m",
    "matched": [{"id": "e1", "kind": "entry", "title": "Deploy", "text": "x", "score": 0.74,
                 "provenance": "user_stated", "supersedes": [], "outcome": "delivered"},
                {"id": "e2", "kind": "entry", "title": "Old", "text": "y", "score": 0.7,
                 "provenance": None, "supersedes": [], "outcome": "in_context"}],
    "delivered_ids": ["e1"], "block_chars": 40, "block": "## h\n\n**Deploy**", "ledger_size": 3,
}
SKIP = {"v": 1, "ts": "2026-10-16T12:01:00.000Z", "host": "hermes", "channel": "pre_llm_call",
        "session_id": "s1", "event": "skip", "reason": "breaker_open"}


class TestReader(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "v.jsonl")
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(DELIVERY) + "\n")
            handle.write("not json\n")
            handle.write(json.dumps(SKIP) + "\n")

    def run_main(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = ct_wisdom_log.main(list(argv))
        return code, out.getvalue()

    def test_formats_delivery_and_skip(self):
        code, text = self.run_main("--path", self.path)
        self.assertEqual(code, 0)
        self.assertIn("2026-10-16T12:00:00.000Z hermes pre_llm_call session=s1", text)
        self.assertIn("delivered 1 fact (40 chars) gate=semantic-v1:m", text)
        self.assertIn('query: "how do I deploy?"', text)
        self.assertIn('+ e1 0.740 user_stated "Deploy"', text)
        self.assertIn('= e2 0.700 unlabeled (already in context) "Old"', text)
        self.assertIn("nothing delivered (breaker_open)", text)
        self.assertNotIn("not json", text)

    def test_block_only_with_flag(self):
        _, text = self.run_main("--path", self.path)
        self.assertNotIn("**Deploy**", text)
        _, text = self.run_main("--path", self.path, "--block")
        self.assertIn("**Deploy**", text)

    def test_tail_n(self):
        _, text = self.run_main("--path", self.path, "-n", "1")
        self.assertNotIn("delivered 1 fact", text)
        self.assertIn("breaker_open", text)

    def test_json_passthrough(self):
        _, text = self.run_main("--path", self.path, "--json")
        self.assertEqual([json.loads(line)["event"] for line in text.splitlines()],
                         ["delivery", "skip"])

    def test_default_path_per_host(self):
        self.assertEqual(ct_wisdom_log.resolve_path("hermes", None, {"HERMES_HOME": "/hh"}),
                         ct_wisdom_verbose.log_path("hermes", {"HERMES_HOME": "/hh"}))

    def test_missing_file_is_a_clear_error(self):
        code, _ = self.run_main("--path", os.path.join(self.tmp, "nope.jsonl"))
        self.assertEqual(code, 1)

    def test_no_path_known_is_an_error(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = ct_wisdom_log.main(["--host", "claude-code"], env={"CLAUDE_CONFIG_DIR": self.tmp})
        self.assertEqual(code, 2)

    def test_claude_code_finds_plugin_data_log_outside_a_hook(self):
        target = os.path.join(self.tmp, "plugins", "data", "curated-thoughts-inline", "wisdom",
                              ct_wisdom_verbose.LOG_NAME)
        os.makedirs(os.path.dirname(target))
        Path(target).write_text(json.dumps(SKIP) + "\n")
        self.assertEqual(
            ct_wisdom_log.resolve_path("claude-code", None, {"CLAUDE_CONFIG_DIR": self.tmp}), target)


if __name__ == "__main__":
    unittest.main()

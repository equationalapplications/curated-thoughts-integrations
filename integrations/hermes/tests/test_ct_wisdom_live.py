#!/usr/bin/env python3
"""Tests for ct_wisdom_live.py — relevance-timed mid-session delivery.

Behavior tests patch `ct_wisdom_live.subprocess.run` (same pattern as
test_ct_wisdom.SubprocessPatchMixin) so they run on every OS.

Run: python3 -m unittest tests.test_ct_wisdom_live -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_wisdom_live  # noqa: E402

CT = "/fake/ct"


def _item(fid, title="T", text="x", supersedes=None, provenance="human-verified"):
    return {"id": fid, "title": title, "text": text, "score": 0.9,
            "supersedes": supersedes or [], "provenance": provenance}


class RunPatch:
    def _patch_run(self, handler):
        orig = ct_wisdom_live.subprocess.run
        ct_wisdom_live.subprocess.run = handler
        self.addCleanup(setattr, ct_wisdom_live.subprocess, "run", orig)

    def _ok(self, payload, seen=None):
        def handler(cmd, *a, **k):
            if seen is not None:
                seen.append((cmd, k))
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload).encode(), b"")
        return handler


class TestCapability(unittest.TestCase, RunPatch):
    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        self.addCleanup(ct_wisdom_live.reset_capability_cache)

    def test_exit_zero_is_capable_and_memoized(self):
        calls = []

        def handler(cmd, *a, **k):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, b"usage", b"")

        self._patch_run(handler)
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))
        self.assertEqual(calls, [[CT, "wisdom", "match", "--help"]])

    def test_nonzero_is_incapable_and_memoized(self):
        self._patch_run(lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 2, b"", b"no"))
        self.assertFalse(ct_wisdom_live.has_match_capability(CT))
        self._patch_run(lambda cmd, *a, **k: self.fail("must be memoized"))
        self.assertFalse(ct_wisdom_live.has_match_capability(CT))

    def test_timeout_is_none_not_memoized(self):
        def boom(cmd, *a, **k):
            raise subprocess.TimeoutExpired(cmd, 3)

        self._patch_run(boom)
        self.assertIsNone(ct_wisdom_live.has_match_capability(CT))
        self._patch_run(lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"", b""))
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))


class TestMatchWisdom(unittest.TestCase, RunPatch):
    def test_argv_and_subprocess_contract(self):
        seen = []
        self._patch_run(self._ok({"entries": [], "corrections": []}, seen))
        ct_wisdom_live.match_wisdom(CT, "-weird query", 2, ["-a1", "b2"])
        cmd, kwargs = seen[0]
        self.assertEqual(
            cmd,
            [CT, "wisdom", "match", "--json", "--max", "2",
             "--exclude=-a1", "--exclude=b2", "--", "-weird query"],
        )
        self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
        self.assertTrue(kwargs["capture_output"])
        self.assertEqual(kwargs["timeout"], ct_wisdom_live.LIVE_TIMEOUT)
        self.assertEqual(kwargs["cwd"], os.path.expanduser("~"))
        self.assertNotIn("shell", kwargs)

    def test_success_normalizes_items(self):
        self._patch_run(self._ok({
            "entries": [_item("e1"), {"id": "bad id"}, "junk",
                        {"id": "e2", "title": 5, "supersedes": ["ok", "bad id"],
                         "provenance": " "}],
            "corrections": [_item("c1", supersedes=["e0"])],
        }))
        result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertIsNone(cls)
        self.assertEqual([i["id"] for i in result["entries"]], ["e1", "e2"])
        self.assertEqual(result["entries"][1],
                         {"id": "e2", "title": "", "text": "", "supersedes": ["ok"],
                          "provenance": None})
        self.assertEqual(result["corrections"][0]["supersedes"], ["e0"])

    def test_missing_lists_default_empty(self):
        self._patch_run(self._ok({"schema": 1}))
        result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertEqual(result, {"entries": [], "corrections": []})
        self.assertIsNone(cls)

    def test_failure_classes(self):
        def timeout(cmd, *a, **k):
            raise subprocess.TimeoutExpired(cmd, 3)

        def spawn(cmd, *a, **k):
            raise OSError("gone")

        cases = [
            (timeout, "timeout"),
            (spawn, "spawn"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 1, b"", b""), "exit"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"not json", b""), "parse_error"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"[]", b""), "parse_error"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b'{"entries": {}}', b""), "parse_error"),
        ]
        for handler, expected in cases:
            self._patch_run(handler)
            result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
            self.assertIsNone(result)
            self.assertEqual(cls, expected)


class TestBreaker(unittest.TestCase):
    def test_opens_after_n_failures_and_closes_after_pause(self):
        now = [100.0]
        b = ct_wisdom_live.Breaker(fails=3, pause=300, clock=lambda: now[0])
        b.record_failure()
        b.record_failure()
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertTrue(b.is_open())
        now[0] += 299
        self.assertTrue(b.is_open())
        now[0] += 1
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertFalse(b.is_open())  # count reset on close

    def test_success_resets_count(self):
        b = ct_wisdom_live.Breaker(fails=2, pause=10, clock=lambda: 0.0)
        b.record_failure()
        b.record_success()
        b.record_failure()
        self.assertFalse(b.is_open())


if __name__ == "__main__":
    unittest.main()

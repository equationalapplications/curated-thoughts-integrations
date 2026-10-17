#!/usr/bin/env python3
"""Tests for proves_ran: send only when the result proves the tool ran.

Spec: docs/superpowers/specs/2026-10-17-hermes-fail-closed-ran-check-design.md

Every fixture is a result shape Hermes produces at PIN_RESULTS_COMMIT; the
comment names the pin source. When the e2e pin moves, test_pin_guard fails
until someone re-reads those sources and updates the fixtures and the
constant.

Run: python3 -m unittest tests.test_ct_wisdom_activity_ran -v
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_wisdom_activity as act  # noqa: E402

PIN_RESULTS_COMMIT = "ee8dd6c886326db4b468c2ba18d9409f123da827"

RAN = True
NOT_RAN = False

# (tool, result dict, verdict, pin source)
PIN_RESULTS = (
    # --- terminal ---
    ("terminal", {"output": "ok", "exit_code": 0, "error": None},
     RAN, "terminal_tool_result.py:255 foreground"),
    ("terminal", {"output": "FAILED 1", "exit_code": 1, "error": None,
                  "exit_code_meaning": "tests failed"},
     RAN, "terminal_tool_result.py:255 non-zero exit ran"),
    ("terminal", {"output": "[Command interrupted]", "exit_code": 130, "error": None},
     RAN, "terminal_tool_result.py:250 interrupt"),
    ("terminal", {"output": "pushed", "exit_code": 0, "error": None,
                  "approval": "Approved by user."},
     RAN, "terminal_tool_result.py:264 approved command"),
    ("terminal", {"output": "Background process started", "session_id": "p1", "pid": 42,
                  "exit_code": 0, "error": None, "notify_on_complete": True},
     RAN, "terminal_tool_background.py:173 background spawn"),
    ("terminal", {"output": "Background process started", "session_id": "p1", "pid": 42,
                  "exit_code": 0, "error": None, "promoted_from_foreground": "note"},
     RAN, "terminal_tool.py:1180 promoted spawn"),
    ("terminal", {"output": "partial", "exit_code": None, "error": None,
                  "status": "yielded_to_background", "session_id": "p2", "pid": 7,
                  "notify_on_complete": True, "note": "n"},
     RAN, "terminal_tool.py:1294 yielded"),
    ("terminal", {"output": "", "exit_code": -1, "error": "BLOCKED: User denied this command.",
                  "status": "blocked"},
     NOT_RAN, "terminal_tool.py:1041 approval denied"),
    ("terminal", {"output": "", "exit_code": -1, "error": "", "status": "pending_approval",
                  "approval_pending": True, "command": "git push"},
     NOT_RAN, "terminal_tool.py:1027 approval pending"),
    ("terminal", {"output": "", "exit_code": 1, "error": "gateway restart blocked",
                  "status": "blocked"},
     NOT_RAN, "terminal_tool_guards.py:64 guard envelope"),
    ("terminal", {"output": "", "exit_code": 124, "error": "Command timed out after 60 seconds"},
     NOT_RAN, "terminal_tool.py:1281 timeout"),
    ("terminal", {"output": "", "exit_code": -1, "error": "Command execution failed: OSError: x"},
     NOT_RAN, "terminal_tool.py:1291 execution failure"),
    ("terminal", {"output": "", "exit_code": -1, "error": "boom", "traceback": "t",
                  "status": "error"},
     NOT_RAN, "terminal_tool.py:986 fatal"),
    ("terminal", {"output": "", "exit_code": -1, "status": "degraded", "reason": "ssh down",
                  "retry_hint": "h", "error": "Terminal backend degraded: ssh down"},
     NOT_RAN, "terminal_tool.py:1359 degraded"),
    ("terminal", {"output": "", "exit_code": -1,
                  "error": "Failed to start background process: x"},
     NOT_RAN, "terminal_tool_background.py:218 failed spawn"),
    ("terminal", {"output": "", "exit_code": -1, "error": "Terminal tool disabled: x",
                  "status": "disabled"},
     NOT_RAN, "terminal_tool.py:1222 disabled backend"),
    # --- read_file ---
    ("read_file", {"content": "1|print('hi')", "total_lines": 1, "file_size": 12,
                   "truncated": False, "is_binary": False, "is_image": False,
                   "not_found": False},
     RAN, "file_operations_common.py:37 ReadResult.to_dict"),
    ("read_file", {"content": "", "total_lines": 0, "file_size": 0, "truncated": False,
                   "is_binary": False, "is_image": False, "not_found": False},
     RAN, "file_operations_common.py:38 empty file keeps content ''"),
    ("read_file", {"content": "1|# Title", "total_lines": 1, "file_size": 900,
                   "truncated": False, "extracted_document": True},
     RAN, "file_tools.py:470 extracted document"),
    ("read_file", {"content": "1|x", "total_lines": 1, "file_size": 2, "truncated": False,
                   "is_binary": False, "_warning": "read 3 times"},
     RAN, "file_tools.py:750 third read warning"),
    ("read_file", {"status": "unchanged", "message": "m", "path": "a.py", "dedup": True,
                   "content_returned": False},
     NOT_RAN, "file_tools.py:527 dedup stub"),
    ("read_file", {"error": "BLOCKED: You have called read_file on this exact region 3 times",
                   "path": "a.py", "already_read": 3},
     NOT_RAN, "file_tools.py:512 dedup BLOCK"),
    ("read_file", {"error": "BLOCKED: You have read this exact file region 4 times in a row.",
                   "path": "a.py", "already_read": 4},
     NOT_RAN, "file_tools.py:743 repeat BLOCK"),
    ("read_file", {"success": False, "note": "'p' is a FIFO, not a regular file"},
     NOT_RAN, "file_tools.py:638 special file"),
    ("read_file", {"error": "Access denied: auth.json is a protected credential store"},
     NOT_RAN, "file_tools.py:652 denylist tool_error"),
    ("read_file", {"content": "", "total_lines": 0, "file_size": 0, "truncated": False,
                   "is_binary": False, "error": "File not found: a.py", "not_found": True,
                   "similar_files": ["b.py"]},
     NOT_RAN, "file_tools.py:693 not found"),
    ("read_file", {"content": "", "total_lines": 0, "file_size": 10, "truncated": False,
                   "is_binary": True},
     NOT_RAN, "file_tools.py:694 binary sniff"),
    # --- write_file ---
    ("write_file", {"bytes_written": 12, "dirs_created": False, "verified": True,
                    "resolved_path": "/w/a.py", "files_modified": ["/w/a.py"]},
     RAN, "file_tools.py:903 WriteResult + files_modified"),
    ("write_file", {"bytes_written": 0, "dirs_created": True},
     RAN, "file_operations_common.py:57 empty file written"),
    ("write_file", {"error": "BLOCKED: write to SSH config file(s) (x) denied."},
     NOT_RAN, "file_tools.py:883 guard tool_error"),
    ("write_file", {"error": "Refusing to overwrite a.py: changed since read. "
                             "The file was NOT modified.",
                    "stale_write_blocked": True, "path": "a.py"},
     NOT_RAN, "file_tools_write_guards.py:597 stale write"),
    ("write_file", {"bytes_written": 0, "dirs_created": False,
                    "error": "Failed to write file: Permission denied"},
     NOT_RAN, "file_tools.py:913 failed write"),
    # --- patch ---
    ("patch", {"success": True, "diff": "--- a\n+++ b\n", "files_modified": ["/w/a.py"],
               "resolved_path": "/w/a.py"},
     RAN, "file_operations_common.py:86 PatchResult success"),
    ("patch", {"success": True, "no_change": True, "note": "edit already present"},
     RAN, "file_operations_common.py:88 no_change"),
    ("patch", {"success": False, "error": "Could not find old_string in a.py",
               "_hint": "old_string not found."},
     NOT_RAN, "file_tools.py:1031 not found"),
    ("patch", {"error": "old_string and new_string required"},
     NOT_RAN, "file_tools.py:1002 argument tool_error"),
    # --- search_files ---
    ("search_files", {"total_count": 2, "matches": [{"path": "a.py", "line": 1,
                                                     "content": "x"}]},
     RAN, "file_operations_common.py:152 matches"),
    ("search_files", {"total_count": 9, "matches_format": "path-grouped",
                      "matches_text": "a.py\n  1: x"},
     RAN, "file_operations_common.py:146 densified"),
    ("search_files", {"total_count": 0},
     RAN, "file_operations_common.py:141 zero matches"),
    ("search_files", {"error": "BLOCKED: You have run this exact search 4 times in a row.",
                      "pattern": "x", "already_searched": 4},
     NOT_RAN, "file_tools.py:1071 repeat BLOCK"),
    ("search_files", {"total_count": 0, "error": "Path not found: src/"},
     NOT_RAN, "file_tools.py:1120 path not found"),
)


class TestPinResults(unittest.TestCase):
    def test_pin_shapes(self):
        for tool, result, verdict, source in PIN_RESULTS:
            with self.subTest(tool=tool, source=source):
                data = json.loads(json.dumps(result))
                self.assertIs(act.proves_ran(tool, data), verdict)

    def test_every_activity_tool_has_both_verdicts(self):
        tools = {"terminal", "read_file", "write_file", "patch", "search_files"}
        for tool in tools:
            verdicts = {v for t, _, v, _ in PIN_RESULTS if t == tool}
            self.assertEqual(verdicts, {RAN, NOT_RAN}, tool)


class TestFailsClosed(unittest.TestCase):
    TOOLS = ("terminal", "read_file", "write_file", "patch", "search_files")

    def test_non_objects(self):
        for tool in self.TOOLS:
            for data in (None, "ok 3 passed", "", [1, 2], 42, True, b"{}"):
                with self.subTest(tool=tool, data=data):
                    self.assertFalse(act.proves_ran(tool, data))

    def test_empty_object(self):
        for tool in self.TOOLS:
            self.assertFalse(act.proves_ran(tool, {}), tool)

    def test_any_non_null_error_fails(self):
        good = {"terminal": {"output": "", "exit_code": 0},
                "read_file": {"content": "x"},
                "write_file": {"bytes_written": 1},
                "patch": {"success": True},
                "search_files": {"total_count": 1}}
        for tool, base in good.items():
            self.assertTrue(act.proves_ran(tool, dict(base)), tool)
            self.assertTrue(act.proves_ran(tool, dict(base, error=None)), tool)
            for err in ("", "x", {}, {"message": "m"}, False, 0, []):
                with self.subTest(tool=tool, error=err):
                    self.assertFalse(act.proves_ran(tool, dict(base, error=err)))

    def test_bools_are_not_counts(self):
        self.assertFalse(act.proves_ran("terminal", {"exit_code": True}))
        self.assertFalse(act.proves_ran("terminal", {"exit_code": False}))
        self.assertFalse(act.proves_ran("write_file", {"bytes_written": True}))
        self.assertFalse(act.proves_ran("search_files", {"total_count": False}))

    def test_negative_and_non_int_counts(self):
        for value in (-1, 1.0, "0", None):
            with self.subTest(value=value):
                self.assertFalse(act.proves_ran("terminal", {"exit_code": value}))
                self.assertFalse(act.proves_ran("write_file", {"bytes_written": value}))
                self.assertFalse(act.proves_ran("search_files", {"total_count": value}))

    def test_terminal_status_needs_the_yield_shape(self):
        self.assertFalse(act.proves_ran("terminal", {"exit_code": 0, "status": "ok"}))
        self.assertFalse(act.proves_ran("terminal", {"exit_code": 0, "status": "blocked"}))
        self.assertFalse(act.proves_ran(
            "terminal", {"exit_code": None, "status": "yielded_to_background"}))
        self.assertFalse(act.proves_ran(
            "terminal", {"exit_code": None, "status": "yielded_to_background",
                         "session_id": ""}))
        self.assertFalse(act.proves_ran(
            "terminal", {"exit_code": None, "status": "Yielded_To_Background",
                         "session_id": "p"}))
        for sid in (5, None):
            self.assertFalse(act.proves_ran(
                "terminal", {"exit_code": None, "status": "yielded_to_background",
                             "session_id": sid}))
        self.assertFalse(act.proves_ran("terminal", {"exit_code": 0, "status": None}))

    def test_read_file_rules(self):
        self.assertFalse(act.proves_ran("read_file", {"content": None}))
        self.assertFalse(act.proves_ran("read_file", {"content": ["x"]}))
        self.assertFalse(act.proves_ran("read_file", {"content": "x", "status": "ok"}))
        self.assertFalse(act.proves_ran("read_file", {"content": "x", "is_binary": True}))
        self.assertTrue(act.proves_ran("read_file", {"content": "x", "is_binary": False}))

    def test_patch_needs_true_not_truthy(self):
        for value in (1, "true", "yes", None, False):
            self.assertFalse(act.proves_ran("patch", {"success": value}), value)

    def test_unknown_tools_never_prove(self):
        for tool in ("browser_navigate", "execute_code", "mcp_x", "", None, 3):
            self.assertFalse(act.proves_ran(tool, {"output": "", "exit_code": 0,
                                                   "content": "x", "success": True,
                                                   "bytes_written": 1, "total_count": 1}))


class TestPinGuard(unittest.TestCase):
    def test_pin_guard(self):
        dockerfile = HERE / "e2e" / "Dockerfile"
        match = re.search(r"^ARG HERMES_COMMIT=([0-9a-f]{40})$",
                          dockerfile.read_text(encoding="utf-8"), re.M)
        self.assertIsNotNone(match, "ARG HERMES_COMMIT not found in tests/e2e/Dockerfile")
        self.assertEqual(
            match.group(1), PIN_RESULTS_COMMIT,
            "The Hermes pin moved. Re-read each PIN_RESULTS source at the new pin "
            "(spec 2026-10-17-hermes-fail-closed-ran-check-design.md, 'Pinned host "
            "facts'), update the fixtures and proves_ran, then PIN_RESULTS_COMMIT.")


if __name__ == "__main__":
    unittest.main()

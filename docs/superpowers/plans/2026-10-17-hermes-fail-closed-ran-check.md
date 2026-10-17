# Hermes fail-closed ran check (0.7.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hermes autonomous-work delivery sends a target to CT only when the tool's result proves the tool ran,
checked per tool. The `is_refusal` word list is removed.

**Architecture:** A new pure function `proves_ran(tool_name, data)` in `ct_wisdom_activity.py` checks the parsed tool
result against the success shape of each of the five activity tools at the Hermes pin. `_transform` calls it in
place of `_refused(...)`. Hermes's `status` / `error_type` / `error_message` kwargs are no longer read. The file is
byte-identical in hermes, claude-code and docker-agent, so all three copies are synced and bumped.

**Tech Stack:** Python 3 stdlib only, `unittest`. Node 24 is not needed.

**Spec:** `docs/superpowers/specs/2026-10-17-hermes-fail-closed-ran-check-design.md` (read it first; its "Pinned host
facts" section is the evidence for every fixture below).

## Global Constraints

- Stdlib only; the hook never raises (`ct_wisdom_activity.py` docstring).
- Pin: `NousResearch/hermes-agent@ee8dd6c886326db4b468c2ba18d9409f123da827` (`integrations/hermes/tests/e2e/Dockerfile`, `ARG HERMES_COMMIT=`).
- Integers in proof rules mean `int` and not `bool`.
- `error` must be absent or `None`; any other value (including `""`, `{}`, `False`) fails the proof.
- The skip failure class stays `"refused"` (meaning: not proven to have run).
- Tool output fields (`output`, `content` text, `matches`) are read for presence and type only, never for wording.
- `ct_wisdom_activity.py` must stay byte-identical across `integrations/{hermes,claude-code,docker-agent}/scripts/`
  (gate: `tests/tools/test_shared_script_parity.py`).
- Versions: hermes `0.7.0 → 0.7.1`, claude-code `0.4.1 → 0.4.2`, docker-agent `0.1.1 → 0.1.2`.
- Never run `ct` or the sidecar against the live brain; the e2e runs only in its container with a scratch HOME and brain.
- Run Hermes tests from `integrations/hermes`: `python3 -m unittest discover -s tests` (CI's command).

## File Structure

- Modify `integrations/hermes/scripts/ct_wisdom_activity.py`: add `proves_ran` and `_is_count`; remove the word list;
  rewire `_transform`; update the module docstring and comments.
- Create `integrations/hermes/tests/test_ct_wisdom_activity_ran.py`: the pin fixtures, the fail-closed properties and
  the pin guard. It is a separate file because `test_ct_wisdom_activity.py` is already ~2200 lines and these tests
  need no harness.
- Modify `integrations/hermes/tests/test_ct_wisdom_activity.py`: migrate the 9 tests that rely on unproven results,
  and turn the old `is_refusal` vectors into non-send checks.
- Copy to `integrations/claude-code/scripts/ct_wisdom_activity.py` and `integrations/docker-agent/scripts/ct_wisdom_activity.py`.
- Release files: `integrations/hermes/{plugin.yaml,integration.yaml,CHANGELOG.md}`,
  `integrations/claude-code/{.claude-plugin/plugin.json,integration.yaml,CHANGELOG.md}`,
  `integrations/docker-agent/{plugin.json,integration.yaml,CHANGELOG.md}`, `README.md` (rows 13, 17, 18 and the
  "Only calls that ran" bullet).
- Docs: `docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md` (pointer in the refusal section),
  `integrations/hermes/tests/e2e/e2e.sh` (check-6 comment).

---

### Task 1: `proves_ran` with pin fixtures, fail-closed properties and the pin guard

**Files:**
- Create: `integrations/hermes/tests/test_ct_wisdom_activity_ran.py`
- Modify: `integrations/hermes/scripts/ct_wisdom_activity.py` (add the function just above `def is_refusal(`; nothing is wired yet)

**Interfaces:**
- Produces: `proves_ran(tool_name, data) -> bool`, where `data` is the parsed result (a `dict` for a JSON object; any
  other value returns `False`). `PIN_RESULTS_COMMIT` (str) in the new test module.

- [ ] **Step 1: Write the failing tests**

Create `integrations/hermes/tests/test_ct_wisdom_activity_ran.py`:

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `integrations/hermes`): `python3 -m unittest tests.test_ct_wisdom_activity_ran -v`
Expected: ERROR in every test that calls `act.proves_ran` (`AttributeError: module 'ct_wisdom_activity' has no
attribute 'proves_ran'`); `test_pin_guard` PASSES.

- [ ] **Step 3: Implement `proves_ran`**

In `integrations/hermes/scripts/ct_wisdom_activity.py`, insert immediately above `def is_refusal(`:

```python
# Proof that a tool ran (INTENT rule 9, spec 2026-10-17-hermes-fail-closed-
# ran-check-design.md): the success shape of each activity tool's result at
# the Hermes pin (tests/e2e/Dockerfile HERMES_COMMIT). Every result needs to
# be a JSON object whose `error` is absent or null; then, per tool:
#   - terminal: `exit_code` an int >= 0 and no `status` (foreground run,
#     non-zero exit included, or background spawn); or `status`
#     "yielded_to_background" with a `session_id` (terminal_tool.py,
#     terminal_tool_result.py, terminal_tool_background.py);
#   - read_file: `content` a str, no `status` (the dedup stub has one), and
#     `is_binary` not true (ReadResult.to_dict);
#   - write_file: `bytes_written` an int >= 0 (WriteResult.to_dict);
#   - patch: `success` is True (PatchResult.to_dict);
#   - search_files: `total_count` an int >= 0 (SearchResult.to_dict).
# Anything else (plain text, unknown fields, another tool) proves nothing,
# so nothing is sent. Fields are checked for presence and type only; no tool
# output is read. Hermes's status kwarg is not used: it says "error" for any
# non-zero exit, a command that ran (agent/display.py).


def _is_count(value):
    """An int >= 0 that is not a bool."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def proves_ran(tool_name, data):
    """True only when `data` (the parsed tool result) proves the tool ran.
    Fails closed: any shape not listed above is False."""
    if not isinstance(data, dict) or data.get("error") is not None:
        return False
    if tool_name == "terminal":
        if "status" not in data:
            return _is_count(data.get("exit_code"))
        session = data.get("session_id")
        return (data.get("status") == "yielded_to_background"
                and isinstance(session, str) and bool(session))
    if tool_name == "read_file":
        return (isinstance(data.get("content"), str) and "status" not in data
                and data.get("is_binary") is not True)
    if tool_name == "write_file":
        return _is_count(data.get("bytes_written"))
    if tool_name == "patch":
        return data.get("success") is True
    if tool_name == "search_files":
        return _is_count(data.get("total_count"))
    return False
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest tests.test_ct_wisdom_activity_ran -v`
Expected: all PASS.
Then the whole suite: `python3 -m unittest discover -s tests`
Expected: OK (nothing is wired yet, so the existing tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add integrations/hermes/scripts/ct_wisdom_activity.py integrations/hermes/tests/test_ct_wisdom_activity_ran.py
git commit -m "feat(hermes): proves_ran, a per-tool proof that a tool ran (pin fixtures + pin guard)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire `proves_ran` into the transform and remove the word list

**Files:**
- Modify: `integrations/hermes/scripts/ct_wisdom_activity.py` (`on_transform_tool_result`, `_transform`, the refusal
  block from the `# Hermes's own refusal envelopes` comment through `def is_refusal`, the module docstring)
- Modify: `integrations/hermes/tests/test_ct_wisdom_activity.py`

**Interfaces:**
- Consumes: `proves_ran(tool_name, data) -> bool` from Task 1.
- Produces: `_transform(result, session_id, tool_call_id, tool_name=None, args=None, task_id=None, api_request_id=None)`
  (the `status`, `error_type`, `error_message` parameters are gone). `on_transform_tool_result(**kwargs)` is unchanged
  externally. `is_refusal` and every `_REFUSED_*` / `_refusal_*` / `_refused*` name no longer exist.

A throwaway prototype of this change (scratchpad, 2026-10-17) broke exactly these existing tests. All of them
used a result that proves nothing:
`TestDelivery.test_empty_object`, `TestDelivery.test_plain_text_appended`,
`TestApprovalGate.test_refused_call_sends_nothing_and_frees_the_step` (5 subtests: the follow-up `"pushed"` post),
`TestApprovalGate.test_blocked_call_never_reaching_transform_sends_nothing`,
`TestRefusalReview2.test_transform_reads_the_kwargs`.

- [ ] **Step 1: Migrate and add tests in `test_ct_wisdom_activity.py`**

1a. Below `READ_RESULT = ...` (around line 1106) add:

```python
# A terminal result that proves the command ran (terminal_tool_result.py:255
# at the pin): proves_ran needs a JSON object with an int exit_code.
TERMINAL_OK = json.dumps({"output": "pushed", "exit_code": 0, "error": None})
```

1b. Replace `test_plain_text_appended` and `test_empty_object` in `TestDelivery` with:

```python
    def test_terminal_result_gets_the_block(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        out = self.post(TERMINAL_OK, tool="terminal", args={"command": "pnpm test"})
        data = json.loads(out)
        self.assertEqual(data["exit_code"], 0)
        self.assertTrue(data[act.ACTIVITY_RESULT_KEY].startswith(act.ACTIVITY_HEADING))
        self.assertEqual(self.calls[0]["text"], "pnpm test")

    def test_plain_text_result_sends_nothing(self):
        """No activity tool returns plain text at the pin: it proves nothing."""
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNone(self.post("ok 3 passed", tool="terminal",
                                    args={"command": "pnpm test"}))
        self.assertEqual(self.calls, [])

    def test_empty_object_sends_nothing(self):
        ct_ledger.LEDGER_CACHE.put("s1", set())
        self.assertIsNone(self.post("{}"))
        self.assertEqual(self.calls, [])
```

1c. In `TestApprovalGate.test_refused_call_sends_nothing_and_frees_the_step` and
`test_blocked_call_never_reaching_transform_sends_nothing`, replace each
`self.post("pushed", tool="terminal", args=GIT_PUSH, ...)` with
`self.post(TERMINAL_OK, tool="terminal", args=GIT_PUSH, ...)` (same keyword arguments).

1d. Replace `TestApprovalGate.test_refusal_shapes` with:

```python
    def test_refusal_shapes_prove_nothing(self):
        """Every refusal the old word list caught still sends nothing, for
        every activity tool: none of them carries a proof shape."""
        for result in REFUSALS + MORE_REFUSALS:
            for tool in ("terminal", "read_file", "write_file", "patch", "search_files"):
                with self.subTest(tool=tool, result=result):
                    self.assertFalse(act.proves_ran(tool, act._parse(result)))
```

1e. Replace `TestReview3.test_more_refusal_wording` (the method that calls
`act.is_refusal(json.dumps({"error": err}))`, around line 2050) with:

```python
    def test_more_refusal_wording(self):
        """3: declined, approval timed out, not allowed: an `error` or a
        missing proof field sends nothing, whatever the wording."""
        for err in ("User declined to run this command", "Approval timed out after 60s",
                    "Not allowed: path is outside the sandbox",
                    "Timed out waiting for approval"):
            self.assertFalse(act.proves_ran("terminal", {"error": err}), err)
            self.assertFalse(act.proves_ran("terminal", {"message": err}), err)
            # Output wording is never read: a command that ran and printed it sends.
            self.assertTrue(act.proves_ran("terminal", {"output": err, "exit_code": 0,
                                                        "error": None}), err)
```

1f. Replace the whole `TestRefusalReview2` class with:

```python
class TestRefusalReview2(unittest.TestCase):
    """Re-review finding 3, now under proves_ran: wording, nesting and
    JSON-string errors all fail on `error`; Hermes's kwargs are not read;
    output fields stay ignored."""

    def test_more_free_text(self):
        for err in ("Rejected by policy", "The user rejected this call",
                    "Cancelled by user", "Operation cancelled", "operation canceled",
                    "request was rejected"):
            for key in ("error", "message"):
                self.assertFalse(act.proves_ran("read_file", {key: err}), (key, err))

    def test_nested_and_json_string_errors(self):
        for result in (
                {"error": {"message": "BLOCKED: denied"}},
                {"error": {"code": 403, "reason": "user denied the action"}},
                {"error": json.dumps({"status": "blocked"})},
                {"error": json.dumps({"error": "Refusing to write"})},
                {"error": {"error": {"message": "not approved"}}}):
            for tool in ("terminal", "read_file", "write_file", "patch", "search_files"):
                self.assertFalse(act.proves_ran(tool, result), (tool, result))

    def test_transform_ignores_the_kwargs(self):
        """The result body is the proof. At the pin Hermes derives the kwargs
        from that body, and says status="error" for any non-zero exit (a
        command that ran), so they are not read."""
        h = Harness("run")
        h.setUp()
        try:
            ct_ledger.LEDGER_CACHE.put("s1", set())
            out = act.on_transform_tool_result(
                tool_name="terminal", args={"command": "pnpm test"},
                result=json.dumps({"output": "1 failed", "exit_code": 1, "error": None}),
                task_id="", session_id="s1", tool_call_id="c1", turn_id="t",
                api_request_id="r1", duration_ms=5, status="error",
                error_type="tool_error", error_message="[exit 1]")
            self.assertIsNotNone(out)
            self.assertEqual([c["text"] for c in h.calls], ["pnpm test"])
        finally:
            h.doCleanups()

    def test_output_fields_still_ignored(self):
        for tool, result in (
                ("terminal", {"output": "rejected by remote: cancelled by user",
                              "exit_code": 1, "error": None}),
                ("read_file", {"content": "Operation cancelled by user", "total_lines": 1})):
            self.assertTrue(act.proves_ran(tool, result), result)

    def test_word_list_is_gone(self):
        for name in ("is_refusal", "_refused", "_refusal_value", "_refusal_text",
                     "_refused_status", "_REFUSED_STATUSES", "_REFUSED_PREFIXES",
                     "_REFUSED_PHRASES", "_REFUSED_ERROR_TYPE_WORDS",
                     "_ENVELOPE_TEXT_KEYS", "_REFUSAL_DEPTH"):
            self.assertFalse(hasattr(act, name), name)
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `python3 -m unittest discover -s tests`
Expected: exactly 3 FAIL: `test_plain_text_result_sends_nothing`, `test_empty_object_sends_nothing` and
`test_word_list_is_gone` (the transform still uses the word list). `test_transform_ignores_the_kwargs` already
passes (the old list did not match "[exit 1]" either). It stays as a regression guard. Everything else passes.
(Checked against a scratch prototype on 2026-10-17.)

- [ ] **Step 3: Rewire the transform**

In `on_transform_tool_result`, replace the `_transform(...)` call with:

```python
        return _transform(kwargs.get("result"), kwargs.get("session_id"),
                          kwargs.get("tool_call_id"), kwargs.get("tool_name"),
                          kwargs.get("args"), kwargs.get("task_id"),
                          kwargs.get("api_request_id"))
```

Replace the `_transform` signature and its refusal check:

```python
def _transform(result, session_id, tool_call_id, tool_name=None, args=None, task_id=None,
               api_request_id=None):
```

```python
    data = _parse(result)
    # Hermes decided by now (approvals, other plugins' blocks, guardrails),
    # but a refusal can be worded any way. Send only when the result proves
    # the tool ran (INTENT rule 9): anything else sends nothing. Nothing is
    # recorded, so the step stays free for a later call of the same step.
    if not proves_ran(tool_name, data):
        return _skip(session_id, "refused")
```

Delete everything from the comment line `# Hermes's own refusal envelopes (pin ee8dd6c8), matched case-insensitively:`
down to and including the whole `def is_refusal(...)` function, **except** the `proves_ran` block added in Task 1
(its comment, `_is_count` and `proves_ran` stay, now directly above `def _transform`).

- [ ] **Step 4: Update the module docstring**

In the module docstring, replace:

```
  * `transform_tool_result` (Hermes let the call run): unless the result is
    Hermes's refusal (`is_refusal`), build the activity from the tool's ARGS
```

with:

```
  * `transform_tool_result` (Hermes let the call run): only when the result
    proves the tool ran (`proves_ran`, per tool; anything else sends
    nothing), build the activity from the tool's ARGS
```

and after the "Fail-closed classes" list add the line:

```
  (`refused` means the result did not prove the tool ran.)
```

- [ ] **Step 5: Run the suites to verify they pass**

Run: `python3 -m unittest discover -s tests`
Expected: OK.
Run: `grep -n "is_refusal\|_refused\b\|_REFUSED_" scripts/ct_wisdom_activity.py tests/*.py`
Expected: matches only in `tests/test_ct_wisdom_activity.py`, in the `REFUSALS` / `MORE_REFUSALS` fixture names
and in the name list of `test_word_list_is_gone`. Nothing in `scripts/`.

- [ ] **Step 6: Commit**

```bash
git add integrations/hermes/scripts/ct_wisdom_activity.py integrations/hermes/tests/test_ct_wisdom_activity.py
git commit -m "feat(hermes): send only when the result proves the tool ran; drop the refusal word list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sync the copies, release hygiene and doc pointers

**Files:**
- Modify: `integrations/claude-code/scripts/ct_wisdom_activity.py`, `integrations/docker-agent/scripts/ct_wisdom_activity.py` (copies)
- Modify: `integrations/hermes/plugin.yaml:8`, `integrations/hermes/integration.yaml:8`, `integrations/hermes/CHANGELOG.md`
- Modify: `integrations/claude-code/.claude-plugin/plugin.json:3`, `integrations/claude-code/integration.yaml:13`, `integrations/claude-code/CHANGELOG.md`
- Modify: `integrations/docker-agent/plugin.json:3`, `integrations/docker-agent/integration.yaml:9`, `integrations/docker-agent/CHANGELOG.md`
- Modify: `README.md` (lines 13, 17, 18, and the bullet at line 139)
- Modify: `docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md` (end of "Refusal check (`is_refusal`)")
- Modify: `integrations/hermes/tests/e2e/e2e.sh:124`

**Interfaces:**
- Consumes: the final `ct_wisdom_activity.py` from Task 2.

- [ ] **Step 1: Copy and check parity**

```bash
cp integrations/hermes/scripts/ct_wisdom_activity.py integrations/claude-code/scripts/ct_wisdom_activity.py
cp integrations/hermes/scripts/ct_wisdom_activity.py integrations/docker-agent/scripts/ct_wisdom_activity.py
python3 -m unittest tests.tools.test_shared_script_parity -v
```
Expected: OK.

- [ ] **Step 2: Run the claude-code and docker-agent suites**

```bash
(cd integrations/claude-code && python3 -m unittest discover -s tests)
(cd integrations/docker-agent && python3 -m unittest discover -s tests)
```
Expected: OK for both. They use only the builder and renderer, so this shows they are unaffected.

- [ ] **Step 3: Bump versions**

- `integrations/hermes/plugin.yaml` and `integration.yaml`: `version: 0.7.0` → `version: 0.7.1`.
- `integrations/claude-code/.claude-plugin/plugin.json`: `"version": "0.4.1"` → `"version": "0.4.2"`; `integration.yaml`: `version: 0.4.1` → `version: 0.4.2`.
- `integrations/docker-agent/plugin.json`: `"version": "0.1.1"` → `"version": "0.1.2"`; `integration.yaml`: `version: 0.1.1` → `version: 0.1.2`.
- `README.md` rows: `[0.7.0]` → `[0.7.1]` (Hermes), `[0.4.1]` → `[0.4.2]` (Claude Code), `[0.1.1]` → `[0.1.2]` (Docker Agent).

- [ ] **Step 4: CHANGELOG entries** (directly under `## Unreleased`, keeping the `## <version> — <date>` heading format)

`integrations/hermes/CHANGELOG.md`:

```markdown
## 0.7.1 — 2026-10-17

- **Privacy: a target is sent only when the tool's result proves it ran.**
  0.7.0 decided "was this call refused?" from a list of refusal words and
  statuses, so a refusal worded some new way still sent its target (for
  example `secrets.env` or `git push`) to Curated Thoughts. Now each
  activity tool must show its own success shape: a terminal `exit_code`
  (or a command handed to the background), read_file `content`,
  write_file `bytes_written`, patch `success`, search_files
  `total_count`, with no `error`. Anything else, including plain text and
  unknown shapes, sends nothing. A command that ran and exited non-zero
  still counts as run. The word list is gone. Tests pin each shape to the
  Hermes commit the plugin is tested against and fail when that commit
  changes, so a Hermes upgrade re-checks them.
```

`integrations/claude-code/CHANGELOG.md`:

```markdown
## 0.4.2 — 2026-10-17

- Shared `ct_wisdom_activity.py` re-synced with Hermes 0.7.1 (its Hermes-only
  ran check changed). No behavior change for Claude Code.
```

`integrations/docker-agent/CHANGELOG.md`:

```markdown
## 0.1.2 — 2026-10-17

- Shared `ct_wisdom_activity.py` re-synced with Hermes 0.7.1 (its Hermes-only
  ran check changed). No behavior change for Docker Agent.
```

- [ ] **Step 5: README bullet** (around line 139): replace

```
- **Only calls that ran (since hermes 0.7.0):** nothing is sent until
  Hermes has let the call run, so a call you refuse, or another plugin
  blocks, sends nothing.
```

with

```
- **Only calls that ran (since hermes 0.7.0; proof required since
  0.7.1):** nothing is sent until Hermes has let the call run and the
  tool's result shows it really ran, so a call you refuse, or another
  plugin blocks, sends nothing, however the refusal is worded.
```

(keep the rest of the bullet, "The query starts after the tool finishes, …", unchanged).

- [ ] **Step 6: Doc pointers**

At the end of the "Refusal check (`is_refusal`)" section in
`docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md` (just before `### Versioning`), add:

```markdown
**Replaced in hermes 0.7.1 (Amendment 9):** the word list above is gone. The transform now sends only when the
result proves the tool ran, checked per tool. See
[`2026-10-17-hermes-fail-closed-ran-check-design.md`](2026-10-17-hermes-fail-closed-ran-check-design.md).
```

In `integrations/hermes/tests/e2e/e2e.sh`, replace the comment lines

```
# transform_tool_result for the blocked call. The block message deliberately
# does NOT start with "BLOCKED" (or any other wording is_refusal matches), so
# if Hermes did run our transform for it, CT would receive secrets.env and the
# check would fail: it tests "no transform", not our refusal check.
```

with

```
# transform_tool_result for the blocked call. This tests "no transform", not
# our ran check (proves_ran): the check passes only if Hermes itself never
# hands the blocked call to the transform.
```

- [ ] **Step 7: Full local verification**

```bash
(cd integrations/hermes && python3 -m unittest discover -s tests)
(cd integrations/claude-code && python3 -m unittest discover -s tests)
(cd integrations/docker-agent && python3 -m unittest discover -s tests)
python3 -m unittest discover -s tests/tools
```
Expected: OK for all four. (`tests/tools` includes the version, README and parity policy checks.)

- [ ] **Step 8: Commit**

```bash
git add integrations/claude-code integrations/docker-agent integrations/hermes README.md docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md
git commit -m "release: hermes 0.7.1, claude-code 0.4.2, docker-agent 0.1.2 (fail-closed ran check)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: e2e on a scratch profile, PR and reviews

**Files:** none changed unless the e2e or a review finds something. Record the e2e result in the PR body.

- [ ] **Step 1: Run the Hermes e2e** (container only: scratch `HERMES_HOME` and brain, plugin mounted read-only;
  never the live profile or `~/.brain`)

```bash
ZAI_API_KEY="$ZAI_API_KEY" OPENROUTER_API_KEY="$OPENROUTER_API_KEY" integrations/hermes/tests/e2e/run.sh
```
Expected: every check passes, including the real `read_file` / `terminal` delivery and check 6 (nothing sent for the
blocked `secrets.env`). If Docker or the keys are unavailable, say so in the PR and mark the e2e as not run. Do not
claim it passed.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin docs/hermes-0.7.1-fail-closed-spec
gh pr create --title "hermes 0.7.1: send only when the tool provably ran (INTENT rule 9)" --body-file <body>
```
The body links the spec and plan, gives the e2e result, and ends with the attribution line
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`. If CI did not start on the pushed head, run
`gh workflow run ci.yml --ref docs/hermes-0.7.1-fail-closed-spec`.

- [ ] **Step 3: Reviews** (CONTRIBUTING "Review, then merge")

Two independent AI reviews (GLM and Opus). Fix every blocker or major finding, then commit and push in the same flow,
until neither review finds one. Merge only with the user's go-ahead.

- [ ] **Step 4: Release tags after merge** (`hermes-v0.7.1`, `claude-code-v0.4.2`, `docker-agent-v0.1.2`), following
  the repo's release workflow.

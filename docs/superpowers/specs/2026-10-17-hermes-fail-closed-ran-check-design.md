# Hermes activity delivery: send only when the tool provably ran — design

**Date:** 2026-10-17 · **Status:** Draft for user review · **Branch:** `docs/hermes-0.7.1-fail-closed-spec`
· **Base:** `main` @ `462813e`
**Release:** hermes 0.7.0 → 0.7.1; claude-code 0.4.1 → 0.4.2 and docker-agent 0.1.1 → 0.1.2 (byte-identical
`ct_wisdom_activity.py`, user decision 1)
**Builds on:** the Hermes reference
[`2026-10-16-hermes-autonomous-work-wisdom-design.md`](2026-10-16-hermes-autonomous-work-wisdom-design.md), in
particular Amendment 8 (approval-gated query) and its "Refusal check (`is_refusal`)" section, which names this
fail-closed check as the follow-up. INTENT rule 9 (PR #73) is the rule it implements.

Tags: **[V]** verified in this session by reading `NousResearch/hermes-agent@ee8dd6c886326db4b468c2ba18d9409f123da827`
(the pin in `integrations/hermes/tests/e2e/Dockerfile`) as data via `gh api …/contents?ref=…`; never executed.
**[U]** unverified or inferred, and carried as a limitation. Line numbers are at the pin.

## Problem

`transform_tool_result` decides "did this call run?" with `is_refusal`, a list of refusal statuses and wordings
(`ct_wisdom_activity.py`, `_REFUSED_*`). A wording or status not on the list is treated as "ran", so the target
(for example `secrets.env` or `git push`) is sent to CT and its embedding provider. Each of the three PR #72 reviews
found wordings the list missed. INTENT rule 9 now says: "A call the user refused, or that another guard blocked,
sends nothing. When the integration can't tell whether a call ran, it sends nothing." A deny-list cannot meet the
second sentence: it answers "is this a known refusal?", not "is this proof the tool ran?".

## User decisions (binding, 2026-10-17)

1. **Scope:** update all three byte-identical copies of `ct_wisdom_activity.py` (hermes, claude-code,
   docker-agent) and bump all three. Splitting the Hermes hooks out of the shared file stays a separate later task.
2. **Rules:** the per-tool proof rules below, as proposed. Yielded-to-background commands and zero-match searches
   ran, so they send. A timed-out command carries an `error`, so it sends nothing.
3. (From the 0.7.0 decision, memory `hermes-refusal-fail-closed-followup`.) The check is **positive and per tool**:
   anything unknown counts as not run. The check ties the plugin to each tool's result format at the Hermes pin, so
   pin-bump tests must cover it.

## Pinned host facts (Hermes `ee8dd6c8`)

### Where the hook sits

- **[V] Our hook sees the tool's own result.** `handle_function_call` (`model_tools.py:946-959`) runs
  `_pre_dispatch_guards` (a block there returns early with `status="blocked"` and never reaches the transform), then
  `_execute_tool` (registry dispatch, wrapped by tool-execution middleware), then `post_tool_call`, then
  `_apply_transform_tool_result_hook(…, result, …)`.
- **[V] Every transform callback gets the same original `result`; the first string returned wins**
  (`model_tools.py:848-866`). Another plugin's transform cannot rewrite what ours reads.
- **[V] Tool-execution middleware can short-circuit** (`hermes_cli/middleware.py:143-183`): a middleware that never
  calls `next_call` returns its own value, and the transform then runs on that value. This is the one path where a
  result that did not come from the tool reaches us.
- **[V] Hermes's `status` kwarg cannot be used for this.** `_tool_result_observer_fields` (`model_tools.py:658-673`)
  returns `"error"` when the result has a truthy `error` *or* when `agent/display.py::_detect_tool_failure` says
  failed, and that is true for **any non-zero terminal exit** (`display.py:1016-1023`), a command that ran. The proof
  must come from the result body.
- **[V] The terminal metering wrapper returns the result unchanged** (`record_terminal_backend` →
  `record_execution_backend`, `hermes_cli/observability/shared_metrics_loop.py:347-366`).

### Result shapes of the five activity tools

`activity_for` builds an activity only for `terminal`, `read_file`, `write_file`, `patch` and `search_files`
(`_FILE_TOOLS` plus the two named tools). At the pin each of them returns a JSON object on every path, success or
failure. None returns plain text.

**terminal** (`tools/terminal_tool.py`, `terminal_tool_result.py`, `terminal_tool_background.py`,
`terminal_tool_guards.py`):
- **[V] Foreground success** (`terminal_tool_result.py:255-277`): `{"output", "exit_code": <returncode int>,
  "error": null}` plus optional `cwd`, `environment_recreated`, spill fields, `verification_evidence`, `approval`
  (the note for an approved command), `exit_code_meaning`, `hint`, `sudo_*`. **No `status` key.** A non-zero exit
  and an interrupt (130) use this same shape.
- **[V] Background spawn** (`terminal_tool_background.py:172-216`): `{"output": "Background process started",
  "session_id", "pid", "exit_code": 0, "error": null, …}`, no `status`. A failed spawn is `exit_code: -1` plus an
  `error` (`:217-221`). A foreground-to-background promotion adds `promoted_from_foreground` and keeps the rest
  (`terminal_tool.py:1169-1181`).
- **[V] Yielded to background** (`terminal_tool.py:1293-1298`): `{"output", "exit_code": null, "error": null,
  "status": "yielded_to_background", "session_id", "pid", "notify_on_complete": true, "note"}`. The command was
  running and was handed off.
- **[V] Every refusal, guard or failure has a non-null `error`:** `_error_json` (`terminal_tool.py:968-974`) always
  sets `error` (approval denied/pending with `status` `blocked`/`pending_approval`, workdir block, disabled
  backend, timeout `exit_code: 124`, execution failure); `_fatal_error_json` (`:977-992`, `status: "error"`);
  `_degraded_result` (`:1348-1366`, `status: "degraded"`); the guards' envelope (`terminal_tool_guards.py:64`,
  `exit_code: 1` plus `error` and `status`).

**read_file** (`tools/file_tools.py:607-757`, `ReadResult` in `file_operations_common.py:14-38`):
- **[V] Success:** `ReadResult.to_dict()` drops `None` and `[]` but keeps `""`, `0` and `False`, so `content` is
  always present as a string (possibly `""`) with no `error`. The extracted-document path (`file_tools.py:470-500`)
  also sets `content` (a string) plus `extracted_document: true`.
- **[V] Not a read:** the dedup stub (`:527-533`, `status: "unchanged"`, no `content`, `content_returned: false`); the
  repeat BLOCKs (`:512`, `:743`, `tool_error`, so `error`); the special-file refusal (`:638-646`, `success: false`, no
  `content`); every guard (`tool_error`); a failed read (`error`). A binary sniff returns `is_binary: true` (`:694`).

**write_file** (`file_tools.py:863-927`, `WriteResult` `file_operations_common.py:42-58`):
- **[V] Success:** `bytes_written` (int), `dirs_created`, optional `verified`, `lint`, `lsp_diagnostics`,
  `warning`, plus `resolved_path`, `files_modified`, `_warning`, `hint`. No `error`.
- **[V] Not written:** every guard (`tool_error`, `:883`), the stale-overwrite refusal (`_stale_write_refusal`,
  `file_tools_write_guards.py:594-609`: `error` plus `stale_write_blocked: true`), and a failed write (`error`; a
  checksum mismatch is a hard `error`, `file_operations_common.py:46-47`).

**patch** (`file_tools.py:959-1050`, `PatchResult` `file_operations_common.py:62-96`):
- **[V] Success:** `{"success": true, …}` with optional `no_change`/`note` (edit already present: the tool ran and
  read the file), `diff`, `files_*`, `lint`, `lsp_diagnostics`, plus `files_modified`/`resolved_path`.
- **[V] Not patched:** `success: false` with `error`, or `tool_error` from the precheck/argument checks.

**search_files** (`file_tools.py:1053-1138`, `SearchResult` `file_operations_common.py:109-166`):
- **[V] Success:** `{"total_count": <int>, …}` with optional `matches`/`matches_text`, `files`, `counts`,
  `truncated`, `limit_reason`, `warning`, `_omitted`, `_warning`, `_hint`. Zero matches is `total_count: 0`.
- **[V] Not searched:** the repeat BLOCK (`:1070-1076`, `tool_error`), guards (`tool_error`), and a failed search
  (`error`, still with `total_count`).

**[V] `tool_error`** (`tools/registry.py:1022-1025`) is always `{"error": "<message>", **extra}`.

## Design

### `proves_ran(tool_name, data)` replaces `is_refusal`

A new pure function in `ct_wisdom_activity.py`. `data` is the parsed result (`_parse`). It returns `True` only when
the result is a JSON object whose shape proves the tool ran. Everything else returns `False`. Common to every tool:

- `data` is a `dict` (plain text, JSON arrays and unparseable results are `False`);
- the `error` key is absent or `null` (any other value, including `""`, `{}` or `false`, is `False`).

Integers below mean `int` and not `bool` (`True` is an `int` in Python).

| Tool | Proven ran when (in addition to the common rules) |
|---|---|
| `terminal` | `exit_code` is an int ≥ 0 **and** `status` is absent; **or** `status == "yielded_to_background"` and `session_id` is present and non-empty |
| `read_file` | `content` is a `str` **and** `status` is absent **and** `is_binary` is not `true` |
| `write_file` | `bytes_written` is an int ≥ 0 |
| `patch` | `success is True` |
| `search_files` | `total_count` is an int ≥ 0 |
| any other tool | never (no activity is built for it anyway) |

Notes on the rules:
- **terminal:** the guards' envelope (`exit_code: 1`) fails on `error` and `status`; a timeout (`124`) fails on
  `error`; `-1` fails on the sign and `error`. A non-zero exit or an interrupt (130) with `error: null` ran and sends.
  `error: null` is accepted rather than required, so the rule does not depend on Hermes always writing the key.
- **read_file:** `content: ""` (an empty file) ran and sends. The dedup stub fails on `status` and the missing
  `content`, but its key was already seen anyway.
- **patch** `no_change: true` sends: the tool ran and found the edit already present.
- Fields are read, never matched as wording, and **tool output fields (`output`, `content` text, `matches`) are never
  inspected**, only their presence and type. No refusal wording list remains.

### Changes to `_transform`

```
data = _parse(result)
if not proves_ran(tool_name, data):          # was: if _refused(result, data, status, …)
    return _skip(session_id, "refused")       # same failure class; meaning: "not proven to have run"
mode = _splice_mode(result, data)             # now always "object" or None for a proven result
```

- The `status`, `error_type` and `error_message` kwargs are no longer read. `on_transform_tool_result` still accepts
  them (Hermes passes them), and `_transform` drops those parameters.
- **Removed:** `_REFUSED_STATUSES`, `_REFUSED_PREFIXES`, `_REFUSED_PHRASES`, `_REFUSED_ERROR_TYPE_WORDS`,
  `_ENVELOPE_TEXT_KEYS`, `_REFUSAL_DEPTH`, `_refusal_text`, `_refused_status`, `_refusal_value`, `_refused`,
  `is_refusal`. No other module or integration imports them (checked: only the Hermes test file uses `is_refusal`).
- `splice()` keeps its plain-text mode (it is a general helper and its tests stay), but the transform never reaches it
  for a proven result.
- The skip class stays `refused` so existing debug logs and tests keep their meaning. The module docstring and the
  class list say it now means "not proven to have run".
- The comment block above the old refusal constants is replaced by one naming the per-tool proof fields and the pin.

### What does NOT change

The rate rule, the step and key claim, the budget, the breaker, the unusable-ct memory, the query builder (rule 9's
content half), the renderer and verbose mode are untouched. claude-code and docker-agent use only the builder and the
renderer from this file, so their behavior does not change. They are bumped only because the file is shared.

## Alignment with INTENT.md

- **Rule 9 (main):** "When the integration can't tell whether a call ran, it sends nothing." The positive per-tool
  check is that sentence turned into code. A refusal worded in a way nobody has seen before now sends nothing, where
  before it sent the target.
- **Rule 4 (failing quietly):** a result that fails the check skips silently with one debug line, as today. There is
  no error in the session.
- **Rule 8 (relevance is CT's job):** the check decides only *whether to ask*, never what is relevant. No scoring or
  judging is added.
- **Rule 6 (keep it small):** limits unchanged.
- **Autonomous-work decisions** (memory `autonomous-work-delivery-decisions`): rate, query content and size are
  unchanged.
- **No departure from INTENT.md.**

## Known limitations

- **A faked success shape cannot be detected.** A tool-execution middleware that short-circuits and returns a result
  shaped like success (for example `{"output": "", "exit_code": 0}` for a terminal call it did not run) passes the
  check. Nothing Hermes produces at the pin does this. It needs a third-party middleware that fabricates results.
- **Coupled to the pin's result formats.** If a Hermes bump renames a proof field (for example `bytes_written`),
  that tool fails closed: deliveries stop for that tool, but nothing leaks. The pin guard test (below) makes a bump
  re-check the shapes on purpose.
- **Fewer deliveries in rare cases that did run:** a `read_file` binary sniff (`is_binary`), a timed-out command, and
  a `search_files` result with an `error` but partial counts. All three are acceptable misses under rule 9.

## Testing

All in `integrations/hermes/tests/test_ct_wisdom_activity.py` (stdlib `unittest`, as today):

1. **Pin fixtures.** A table `PIN_RESULTS` of real result strings built from the shapes above, each with the pin
   source line it came from and an expected verdict. At least, per tool:
   - terminal: foreground exit 0, exit 1 (sends), exit 130 interrupted (sends), approved with an `approval` note,
     background spawn, promoted spawn, yielded; and as non-runs: approval denied (`blocked`), pending, the guards'
     envelope, timeout 124, execution failure, fatal, degraded, failed spawn;
   - read_file: normal, empty `content`, extracted document, `content` with a `_warning`; and as non-runs: dedup
     stub, the two BLOCKs, the special-file refusal, a guard `tool_error`, not found, `is_binary`;
   - write_file: success with `files_modified`; and as non-runs: guard `tool_error`, stale-write refusal, a failed
     write;
   - patch: success, `no_change`; and as non-runs: `success: false` with `error`, a precheck `tool_error`;
   - search_files: matches, `matches_text`, zero matches; and as non-runs: the BLOCK, a guard, path not found.
2. **Fail-closed properties.** For each activity tool: plain text, a JSON array, `null`, `{}`, an object with any
   non-null `error`, `bool` in place of an int (`exit_code: true`, `bytes_written: true`, `total_count: false`), a
   negative int, and an unknown tool name all return `False`. Every old `is_refusal` vector (the refusal table at the
   pin, the extended wordings) is kept as a "does not prove ran" case. Each was a refusal and must stay a non-send.
3. **End to end in `_transform`.** A non-proving result never spawns a query (the existing "refused never spawns /
   never claims the step" tests, now keyed to `proves_ran`), and a proving result for each tool reaches the query.
4. **Pin guard.** A test reads `HERMES_COMMIT` from `tests/e2e/Dockerfile` and asserts it equals the
   `PIN_RESULTS_COMMIT` constant recorded next to the fixtures. A pin bump then fails CI until someone re-checks the
   shapes and updates the constant.
5. **Copies stay identical.** No test checks this today. Add one (in the Hermes suite) that asserts the claude-code
   and docker-agent copies of `ct_wisdom_activity.py` are byte-identical to the Hermes copy. The claude-code and
   docker-agent suites run unchanged.
6. **e2e (scratch profile, isolated HOME and brain).** Re-run the Hermes e2e harness. Its checks (a delivery on a
   real `read_file`/`terminal`, nothing for the blocked `secrets.env`) must still pass. Update the check-6 comment in
   `e2e.sh`, which names `is_refusal`.

## Versioning and docs

- hermes `0.7.0 → 0.7.1`, claude-code `0.4.1 → 0.4.2`, docker-agent `0.1.1 → 0.1.2`; CHANGELOG entries (Hermes:
  "Privacy: the autonomous-work query is sent only when the tool's result proves it ran"; the other two: "shared file
  sync, no behavior change") and README rows.
- Add an "Amendment 9: fail-closed ran check (hermes 0.7.1)" pointer in the Hermes reference spec's refusal section,
  linking here and marking the word list as replaced.

## Out of scope

- Splitting the Hermes hooks out of the shared file (handoff item 3).
- Fail-closed checks for the other hosts (DSH, OpenCode, OpenClaw, Claude Code, Docker Agent). Each has its own
  approval model, and this spec covers Hermes only.
- Detecting fabricated results from third-party middleware.

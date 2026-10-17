# Plan: Claude Code autonomous-work wisdom (claude-code 0.4.0)

Spec: [`2026-10-17-claude-code-autonomous-work-wisdom-design.md`](../specs/2026-10-17-claude-code-autonomous-work-wisdom-design.md).
Branch `feat/claude-code-autonomous-work-wisdom` off `origin/main` @ `604c904`.

Each task is TDD: write the failing test, run it red, implement, run it green.

## Task 0 — Phase 0 (done, recorded in the spec H1–H14)

Docs fetched as markdown, the 2.1.301 binary read as data, five live isolated runs with a recorder
plugin and a body-only proxy (scratchpad `cc-aw/`).

## Task 1 — Vendor the builder and bind it

1. Copy `integrations/hermes/scripts/ct_wisdom_activity.py` byte-for-byte into
   `integrations/claude-code/scripts/`.
2. `tests/tools/test_shared_script_parity.py`: `IDENTICAL_EXTRA["claude-code"] =
   ("ct_wisdom_activity.py",)`.
3. `hooks/ct_wisdom_cc_activity.py`: `TOOL_MAP`, `translate`, `activity_for(tool, args, cwd,
   env)`, `query_for`, `is_ct_tool`, `is_recall_tool`.
4. `tools/ct_ci_policy.py`: `ct_wisdom_cc_activity` in `STDLIB_ALLOWLIST`.
5. Tests `tests/test_activity_cc.py`: map cases, the 290 vectors, `key_distinct_from` pairs, the
   golden blocks, secret safety, CT tools.

## Task 2 — Store fields, executed record, ct cache

1. `new_store` gains `activity_ids`, `executed`, `agents`; `load_store` defaults them for 0.3.x
   stores; `ledger_of` includes `activity_ids`.
2. `PostToolUse` / `PostToolUseFailure` for the activity tools record `tool_use_id` (≤ 256).
3. Subagent recall: record ids, never stub (spec D8).
4. ct cache (`ct.json`) with discovery-view digest, 24 h, size/mtime signature.

## Task 3 — `PostToolBatch` delivery

Phase A (locked): state on, executed filter, CT tools' recall ids noted, first new per-agent key
claimed. Phase B: ct (cached) and match inside the 9 s budget; breaker; release on post-start
failure. Phase C (locked): re-read, render first new candidate, record, write, emit. Verbose seam.

## Task 4 — Exactly-once randomized test

Extend `tests/test_exactly_once_cc.py`: activity batches (main/subagents, executed/denied)
interleaved with user turns, recalls, compact, resume, clear (both branches); assert no id twice in
any context and no CT call for an OFF session.

## Task 5 — hooks.json and contract tests

`PostToolBatch` (15 s), `PostToolUse` + `PostToolUseFailure` with the activity-tool matcher (5 s);
`tests/test_hook.py` contract.

## Task 6 — Live e2e (isolated)

Real `claude` 2.1.301, plugin via `--plugin-dir`, real CT 3.5.1 gate in a scratch brain, ZAI
GLM-5.3-FLASH; Hermes five checks + latch + verbose. Never the real `~/.claude` or brain; no key
printed.

## Task 7 — Release and gates

0.4.0 in `integration.yaml` and `plugin.json`, CHANGELOG, README, top-level README rows; suites
(claude-code, hermes, docker-agent, tests/tools), ruff, `tools/ct_ci.py` gates; commit, push, PR,
CI, CodeRabbit.

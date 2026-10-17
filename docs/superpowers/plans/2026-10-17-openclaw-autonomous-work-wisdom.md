# OpenClaw autonomous-work wisdom — implementation plan

**Spec:** [`2026-10-17-openclaw-autonomous-work-wisdom-design.md`](../specs/2026-10-17-openclaw-autonomous-work-wisdom-design.md)
**Branch:** `feat/openclaw-autonomous-work-wisdom` · **Release:** openclaw 0.2.2 → 0.3.0

Phase 0 (A3, step ids, approval, cwd, cache safety) is done and recorded in the spec. Every task
below is test-first: write the failing test, run it, implement, run the suite.

## Task 1: binding and trigger (`src/wisdom/activity.ts`)

- Tests (`tests/test_activity_binding.ts`): the tool map (`read`/`write`/`edit` `path` with
  `file_path` fallback, `grep`/`find` `pattern`+`path`, `exec`/`bash` `command`; `ls`,
  `apply_patch`, `process`, MCP tools → none; content args never read); `executedResult`
  (approval-pending / approval-unavailable / denied / blocked → false; error with a finite
  `exitCode` → true; other errors → false; success → true).
- Tests (`tests/test_activity_vectors.ts`): the 290 shared vectors through `openclawActivitySpec`
  → `buildActivity` (Hermes tool names mapped to OpenClaw ones, same temp-dir worlds as the core
  runner); the golden blocks reached through the middleware.
- Implement `openclawActivitySpec`, `executedResult`.

## Task 2: adapter run ledger (`src/wisdom/adapter.ts`)

- Tests (`tests/test_adapter.ts`): `setTurn` with a new `runId` resets the run ledger, the same
  `runId` keeps it; `noteRunIds` only for the current run; `rebuildLedger` = run ids ∪ drained ∪
  snapshot ∪ bootstrap; `cacheLedger` unions into the run ledger; `cachedLedger` is null for a cache
  of an earlier run; `hasRun`.
- Implement.

## Task 3: the activity engine (`OpenClawActivity`)

- Tests (`tests/test_activity.ts`): delivery appends one marker-first block as a separate text
  block; one CT call per step across parallel results; a new `callId` allows another; the
  `:model:?` fallback; same key later → none; release on budget / timeout / parse error; keep on
  `no_match` / `deduped`; `no_ledger`; restored without bootstrap; capability missing; breaker
  shared with the user-turn path; 200-block result → `no_channel` with no CT call; CT tools and
  not-executed results never query; a throwing spawn / adapter never escapes; marker hygiene;
  subagent, cron and heartbeat sessions deliver; the user-turn gate is unchanged for them.
- Implement `OpenClawActivity` (`noteModelCall`, `process`).

## Task 4: wiring (`src/index.ts`, `src/host.ts`)

- `before_prompt_build` stores the turn input (with `runId`) for every session; the restored flag
  for every session; the live path keeps its gate.
- `model_call_started` → `noteModelCall`.
- The middleware: N3 for recall results, then `activity.process` for every result; async; never
  throws.
- `host.ts`: `ModelCallEvent` / `ModelCallCtx`, `ToolResultEvent.args` / `cwd` / `toolCallId`.

## Task 5: verbose and exactly-once

- `tests/test_verbose.ts`: off → byte-identical tool results and no file; on → `activity` records.
- `tests/test_exactly_once.test.ts`: add runs with multi-step parallel tool batches, activity
  deliveries, restarts mid-run; the oracle counts every tool-result block.

## Task 6: shape contract

- `tests/host/compatibility.json`: `modelCallStartedEventFields`, `modelCallContextFields`, the
  middleware result limits; `contract.test.ts`: `model_call_started` registered, no
  `before_tool_call`, fields read ⊆ recorded.

## Task 7: live e2e (`tests/e2e/`)

- `run.sh` gains an activity session (CT stub with activity facts, a recording proxy), and
  `activity_verdict.py` checks exactly-once, bare-target queries, no CT-tool trigger, the repeat
  key, persistence into the next request and the next turn, verbose records.

## Task 8: release

- openclaw 0.3.0 (`package.json`, `openclaw.plugin.json`, `integration.yaml`), CHANGELOG, README
  (integration and root), `tools/ct_ci.py readme`.
- Suites in order: openclaw, core, deepseek, opencode; `tsc`; the policy gates.

# OpenCode autonomous-work wisdom delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One fact (≤ 600 chars) per model step, keyed to what the agent is working on, appended to an approved OpenCode
tool call's result.

**Architecture:** `tool.execute.before` plans an activity from the call's args with the shared core builder.
`tool.execute.after` (the first point where the call is known to be approved) reads the session's own history (giving
the step id and the ledger), starts the core `startActivity` behind the gates, awaits it for at most 3 s, finishes with
`finishActivityOutcome` on a fresh ledger, and appends the marker-first block to the output.

**Tech Stack:** TypeScript (ESM), vitest, bun (host contract), `@equational-applications/ct-wisdom-core`, Docker e2e.

**Spec:** `docs/superpowers/specs/2026-10-17-opencode-autonomous-work-wisdom-design.md`

## Global Constraints

- Pin: opencode / `@opencode-ai/plugin` 1.18.35.
- 1 fact, ≤ 600 chars (`ACTIVITY_MAX_PER_STEP`, `ACTIVITY_MAX_BLOCK_CHARS`); 3 s budget (`TIMEOUT_MS`).
- Query = `activityQuery(buildActivity(spec, cwd, env))`; never re-implement the core's privacy rules.
- CT tools never trigger; subagents included for activity; per-message delivery stays parent-only.
- Start only at `tool.execute.after` with a plan from `before`; release on post-start failure, keep on `zero_hits`.
- Every hook catches everything; on any skip the output is left byte-identical.
- No change to `packages/ct-wisdom-core`.
- Version opencode 0.4.0 in `package.json` and `integration.yaml`; CHANGELOG; README; README table (`tools/ct_ci.py readme`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

- Create `integrations/opencode/src/wisdom-live/activity.ts`: the binding (`opencodeActivitySpec`,
  `isOpenCodeCtTool`, `isCodeModeCall`), `ActivityHost` (the gate-facing `HostAdapter`), the `OpenCodeActivity` class
  (`plan`, `deliver`) and the placement helpers (`canCarry`, `placeBlock`).
- Modify `integrations/opencode/src/wisdom-live/adapter.ts`: session `directory` in the kinds cache;
  `sessionKnown`, `sessionDirectory`; `unpersisted` set (`noteUnpersisted`, pruned by own-row scans and included in
  `buildLedger`); `activityView(sessionId)` returning `{ledger, stepOf(callID)}` from OWN rows.
- Modify `integrations/opencode/src/wisdom-live/hooks.ts`: register `tool.execute.before`; `tool.execute.after`
  branches into N3 (recording unpersisted ids) or activity.
- Tests: `tests/test_wisdom_activity.ts` (binding, vectors, golden, rate, coalescing, subagents, fail-closed, marker
  hygiene, verbose); extend `tests/test_wisdom_live_exactly_once.test.ts` (activity + parallel); extend
  `tests/host/contract.test.ts`; extend `tests/e2e/{Dockerfile,run.sh,e2e.sh}`.

---

### Task 1: Binding + vectors

**Files:** create `src/wisdom-live/activity.ts` (binding part); test `tests/test_wisdom_activity.ts`.

**Produces:** `opencodeActivitySpec(tool: unknown, args: unknown): ActivitySpec | null`,
`isOpenCodeCtTool(name: unknown): boolean`, `isCodeModeCall(callID: unknown): boolean`.

- [ ] Write tests: the tool table (`read`/`write`/`edit` → `filePath`; `grep`/`glob` → `pattern`+`path`; `bash` →
  `command`; `apply_patch`, `task`, `webfetch`, MCP → null); CT names (`curated-thoughts_curated_recall_context`,
  `ct_curated_get_wiki_entry`); code-mode ids (`call_1/2`).
- [ ] Write the vector test: map each Hermes vector to its OpenCode call
  (`read_file`→`read{filePath}`, `write_file`→`write{filePath,content}`, `patch`→`edit{filePath}`,
  `search_files`→`grep{pattern,path}`, `terminal`→`bash{command}`), run it in the core vector runner's temp-dir world
  (`activitySeams` + `resetActivityCaches`), and assert query, label, `key_distinct_from`; the golden blocks render.
- [ ] Run → FAIL (module missing). Implement. Run → PASS. Commit.

### Task 2: Adapter view + unpersisted

**Files:** modify `src/wisdom-live/adapter.ts`; test in `tests/test_wisdom_activity.ts` (adapter section).

**Produces:** `sessionKnown(id): boolean`, `sessionDirectory(id): string | null`,
`noteUnpersisted(id, ids: string[]): void`,
`activityView(id): Promise<{ ledger: Ledger; stepOf(callID: string): string | null }>`.

- [ ] Tests: the directory is cached from `fetchSession`; the view scans OWN rows only (a parent's id is not in the
  child's view); `stepOf` finds the tool part's `messageID` (falling back to the row's `info.id`); an unpersisted id is
  in every ledger until an own-row scan finds it, then it is pruned.
- [ ] Implement. Run the full opencode suite (no regressions). Commit.

### Task 3: OpenCodeActivity + hooks

**Files:** `src/wisdom-live/activity.ts` (class), `src/wisdom-live/hooks.ts`; tests in `tests/test_wisdom_activity.ts`
driven through `createWisdomHooks` with an injected `spawnFn`, `fetchHistory` and `fetchSession`.

**Consumes:** Task 1 and 2 APIs; core `ActivityTracker`, `startActivity`, `finishActivityOutcome`, `reportActivity`,
`TIMEOUT_MS`, `scanIds`.

- [ ] Tests:
  - delivery into a builtin output (marker first, `\n\n` separator) and into MCP content (last text item);
  - the MCP fit guard;
  - one CT call for two parallel calls of a step (in flight, then `step_used`);
  - the same key in a later step makes no call; a new key makes one;
  - a call with no `after` never queries;
  - budget release, then a retry in a later step;
  - `no_match` keeps the key;
  - child session delivers, and a fact its parent holds can still arrive; an unknown kind delivers nothing;
  - CT tools and code-mode calls never trigger;
  - an unsupported output sends nothing;
  - hooks never throw (throwing fetchers);
  - verbose off: nothing written, and output bytes equal a verbose-on run; verbose on: an `activity` record with
    query, label and id;
  - the user-turn query never includes tool output; the activity query never holds `ct-fact:` or the heading;
  - a recall's ids join unpersisted (a parallel recall of X blocks an activity X).
- [ ] Implement. Run → PASS. Commit.

### Task 4: Exactly-once randomized

**Files:** `tests/test_wisdom_live_exactly_once.test.ts`.

- [ ] Add activity steps (1–3 parallel calls, random tools and keys, some refused before `after`), parallel N3 recalls,
  child activity, compaction and restarts. Oracle: an id is visible at most once in a session's OWN context (child
  activity and user-turn checks), and stubs only name ids in child ∪ parent (unchanged).
- [ ] Run. Commit.

### Task 5: Host contract

**Files:** `tests/host/contract.test.ts`.

- [ ] A new test scripts `read` of an absolute in-project path, `bash pnpm test` twice and `read secrets.env`
  (auto-rejected). Assert:
  - the block is once in the tool result the model got;
  - the `--max 1` argv has the relative path after `--`;
  - one query for the repeated key;
  - none for `secrets.env`;
  - the exported tool part `state.output` carries the block.
- [ ] Run with `OPENCODE_BIN` + bun from the scratchpad host install. Commit.

### Task 6: Live e2e

**Files:** `tests/e2e/Dockerfile` (CT CLI 3.5.1, the same sha256 as deepseek), `run.sh` (forward
`CT_E2E_REAL_GATE` and `OPENROUTER_API_KEY` by name), `e2e.sh` (real-gate autonomous section: deposits,
`scheme activate instr1`, the tap, the work dir with `.git`; checks 1–5 + 6 refused + verbose).

- [ ] `docker ps` first; run `CT_E2E_REAL_GATE=1 tests/e2e/run.sh`; grep `out/` for both keys. Commit.

### Task 7: Release + gates

- [ ] Bump to 0.4.0, CHANGELOG, README section, `python3 tools/ct_ci.py readme`.
- [ ] Run sequentially: opencode, core, deepseek, openclaw vitest (`--testTimeout 60000`), `tsc --noEmit`, and the
  ct_ci gates.
- [ ] Commit, push, open the PR, wait for CI, address CodeRabbit.

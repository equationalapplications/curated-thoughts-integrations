# Intuitive Wisdom: autonomous-work delivery for OpenClaw — design

**Date:** 2026-10-17 · **Status:** Approved for implementation (user decisions binding; autonomous
brainstorm, no open questions) · **Branch:** `feat/openclaw-autonomous-work-wisdom` · **Base:** `origin/main` @ `9ad2653`
**Release:** openclaw 0.2.2 → 0.3.0 (host pin `openclaw@2026.10.3`, unchanged)
**Builds on:** the [Step-0 investigation](../investigations/2026-10-16-autonomous-work-trigger-step0-investigation.md)
(OpenClaw section, "Recommended common contract", "A6 results"), the DSH leg
[`2026-10-16-dsh-autonomous-work-wisdom-design.md`](2026-10-16-dsh-autonomous-work-wisdom-design.md) with its review and
final-review amendments, the Hermes reference
[`2026-10-16-hermes-autonomous-work-wisdom-design.md`](2026-10-16-hermes-autonomous-work-wisdom-design.md) (privacy
amendments 1–7), the OpenClaw live leg
[`2026-10-16-openclaw-wisdom-parity-leg-design.md`](2026-10-16-openclaw-wisdom-parity-leg-design.md) (facts F1–F15) and the
verbose-mode spec [`2026-10-16-wisdom-verbose-mode-design.md`](2026-10-16-wisdom-verbose-mode-design.md).

Tags: **[V]** verified in this session, either by reading the cited file in the pinned
`openclaw@2026.10.3` package (read as data in the session scratchpad, never imported into this
repo, never committed) or by a live run of the pinned host (marked "live"). **[U]** unverified or
inferred; carried as a limitation or an e2e target. Paths are relative to the package's `dist/`.

## Problem

The OpenClaw plugin asks CT for relevant facts once per user turn (`before_prompt_build`). A run
that then works on its own for many model steps (reading files, running commands, editing code)
never gets a fact keyed to what it is doing. INTENT's third step, "During autonomous work", asks
for that. Hermes (0.6.0) and DeepSeek Harness (0.6.0) shipped it; this spec brings OpenClaw to the
same behavior on the shared `ct-wisdom-core` activity API, which already holds the builder, the
key tracker, the renderer and the gates.

## User decisions (binding)

1. **Rate.** At most one CT call per model step, only when the activity key changes. No
   per-message ceiling, no session cap.
2. **Query = the bare target**, built only by the shared core builder (`buildActivity` /
   `activityQuery`). The 290 shared vectors (`tests/fixtures/activity_targets.json`) and the golden
   `tests/fixtures/activity_blocks.json` must pass for this binding.
3. **Size:** 1 fact, ≤ 600 chars per activity delivery.
4. **Subagents and scheduled runs (cron, heartbeat) are included.**
5. **CT's own tools never trigger.**
6. **No ceilings.**
7. Known limit: concept rules reached only through a path need CT activity mode
   ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)).

From the DSH final review (binding here too):

8. **A query starts only for an approved call** (verify OpenClaw's approval semantics).
9. **Delivery never starts a plan** (no CT call from the delivery side).
10. **Release the key** on post-start failures (budget, CT failure, a gate that closed, no
    channel); **keep it** on `no_match` / `deduped` (CT answered).

## Phase 0: pinned host facts (openclaw 2026.10.3)

### A3: is a middleware-rewritten tool result persisted and replayed? **Yes [V live]**

The investigation left this [U]; it had to be verified before any design work. A probe plugin
(scratchpad only) appended one extra text block `A3-PROBE <!-- ct-fact:probe-<toolCallId> -->` to
every tool result through `registerAgentToolResultMiddleware`, and two turns ran in one session with
`openclaw agent --local` (a fresh process per turn), ZAI GLM-5.3-FLASH behind a body-only recording
proxy, in an isolated `HOME` / `OPENCLAW_STATE_DIR`. The agent called `write`, then `read`.

- **The model sees it in the same run.** Request 2 (after `write`) and request 3 (after `read`) carry
  the block inside the `tool_result` of that call (the provider adapter joins the two text blocks
  with `\n`) [V live].
- **It is persisted.** The transcript store (`agents/main/agent/openclaw-agent.sqlite`,
  `transcript_events`) holds each `toolResult` with **two** text blocks, the original and ours,
  unchanged [V live].
- **It is replayed.** Turn 2 ran in a new process. Its request carries both rewritten tool results;
  their content is byte-identical to the in-run requests. The only difference is the host's own
  `cache_control` breakpoint, which moves to the newest message on every request (that is the
  provider cache marker, not content) [V live].
- **The next ledger scan sees it.** Turn 2's `before_prompt_build` `event.messages` has both
  `toolResult` messages with 2 blocks each and the probe marker [V live], which is what the shipped
  `snapshotScan` reads (OpenClaw leg deviation 1).

Code path, for the record: the embedded runner's middleware factory returns `{content, details}`
from `agent.on("tool_result")` (`builtin-openclaw-C66TYl5I.mjs:17261-17306`); `afterToolCall`
copies `afterResult.content` into the result (`agent-core-DsOZICW-.mjs:1296-1311`);
`emitToolResultMessage` builds the `toolResult` message from it (`:280-299`); the session appends
that message through `persistAgentSessionMessage` (`resource-loader-CJ9wmE3G.mjs:3794-3803`) [V].

**Truncation.** The persistence guard caps tool results (`capToolResultForPersistence`,
`sdk-BAE0lYql.mjs:259`; default 16 000 chars, more for large context windows,
`tool-result-limits-B-fhY8wF.mjs:62-86`). `truncateToolResultMessage` keeps every text block of
at most `MIN_KEEP_CHARS = 2000` whole while the small blocks fit, and shrinks only the large ones
(`tool-result-truncation-B1JI3j0I.mjs:589`, `:698-760`) [V]. A 600-char block **of its own** therefore
survives persistence even when the tool's output is cut; text appended into the output's own block
would be cut with it. Hence: our block is always a separate text block.

### Steps, runs and turns

- **`runId` is one run, not a step.** One user message (or one cron / heartbeat trigger) is one run;
  every hook of that run carries the same `ctx.runId` (`before_prompt_build`, `before_tool_call`,
  `model_call_started`, middleware) [V live].
- **`turnId` and `threadId` are absent on the embedded runtime.** The middleware event has the keys
  but no values: the extension `tool_result` event that feeds it carries neither
  (`resource-loader-CJ9wmE3G.mjs:3722-3731`) [V live + code].
- **The model step is `model_call_started.callId`.** The hook fires once per model call with
  `event.callId = "<runId>:model:<n>"` and ctx `runId` / `sessionKey` [V live: `:model:1`, `:2`, `:3`
  in a three-call run]. It is observe-only and needs no conversation-access grant
  (`compatibility.json` `conversationAccessHooks`). It is dispatched fire-and-forget
  (`attempt.model-diagnostic-events-BN112NiO.mjs:295-306`; `hooks-BSQBsmdF.mjs:70-86`), so it can be
  delayed or, with a full hook queue, dropped [V code]. A step's tool results arrive after its model
  call has streamed, so in practice the hook has run first [V live: 7 s before the first tool
  result]; the edge cases are in "Rate rule" below.
- **Tool results of one step can run in parallel** (`agent-core-DsOZICW-.mjs:1000-1080`, the batch
  launcher), and the loop awaits the whole batch before the next model call [V code].

### Approval: `before_tool_call` is before approval, the middleware is after execution

- `before_tool_call` handlers all run inside `runBeforeToolCallHook` **before** any approval is
  resolved: a `requireApproval` result is resolved only after the hook runner returns, and a
  lower-priority handler can still block (`agent-tools.before-tool-call-iy-Keqfw.mjs:2776-3000`;
  `docs/plugins/hooks/tool-policy.md` "Guard behavior") [V]. Exec approvals are resolved later
  still, **inside** the `exec` tool (`bash-tools-DQS9-f8q.mjs:308-360`, `:488-515`) [V].
- A thrown or timed-out `before_tool_call` handler **blocks the tool** (fail closed;
  `docs/plugins/hooks/reference.md` timeout table) [V].
- The middleware runs only when execution started: `afterToolCall` is called only when
  `executed.executionStarted` (`agent-core-DsOZICW-.mjs:1296`), so a call blocked by a hook, denied
  by a plugin approval or never started reaches no middleware [V].
- But the `exec` tool *starts* and then returns, without running the command, an
  `approval-pending` / `approval-unavailable` result (`details.status`, not an error) or a denied
  result (`Exec denied (…)`, `details.status: "failed"`, `exitCode: null`)
  (`bash-tools-DQS9-f8q.mjs:308-360`, `:493-509`) [V]. `isToolResultError` treats a non-zero
  `exitCode`, `failed`, `denied`, `blocked` and others as errors
  (`tool-result-error-DGhCl3TG.mjs:98-112`) [V].

**Consequence (decision 8):** the investigation's sketch, "prefetch at `before_tool_call`", would
send the target of a call the user may still deny, and would add a hook whose failure blocks tools.
This design has **no `before_tool_call` hook**. The query starts in the middleware, for a result
that shows the call ran (rule in "Trigger" below).

### Middleware contract

- Event `{threadId, turnId, toolCallId, toolName, args, cwd, isError, result: {content, details}}`;
  ctx `{runtime, agentId, sessionId, sessionKey, runId}` [V live]. `args` are the validated (or
  hook-adjusted) parameters (`builtin-openclaw-C66TYl5I.mjs:17283-17289`) [V].
- Handlers are awaited with **no host timeout** (`tool-result-middleware-Uy2oP_I9.mjs:251-264`) [V],
  so the plugin bounds itself (3 s).
- A handler that **throws**, or returns an invalid result, makes the host replace the tool result
  with `"Tool output unavailable due to post-processing error."` (`:258-266`) [V]. Valid means at
  most 200 content blocks, text blocks ≤ 100 000 chars, JSON-safe `details` (`:18-56`) [V]. The
  handler therefore never throws and appends only when the result stays valid.
- **Embedded runtime only** (`runtimes: ["openclaw"]`, already declared in the manifest). The Codex
  app-server and Copilot runtimes get no activity delivery (unchanged degraded matrix).

### Tools and arguments at the pin

| Tool | Args we read | Verb | Evidence |
|---|---|---|---|
| `read` | `path` (fallback `file_path`; never `offset`/`limit`) | read | `tool-contracts-DS9i4t9j.mjs:63-75`; alias `tools-B1jAKtDd.mjs:1570` |
| `write` | `path` (fallback `file_path`; never `content`) | write | `:111-114` |
| `edit` | `path` (fallback `file_path`; never `edits`) | edit | `:13-16` |
| `grep` | `pattern`, `path` (never `glob`, flags, `context`) | search | `:28-36` |
| `find` | `pattern`, `path` | search | `:23-27` |
| `exec` | `command` (never `workdir`, `env`, `ask`, `host`, `node`, …) | run | `bash-tools.schemas-CYQpq8j2.mjs:29-44` |
| `bash` | `command` (the reserved coding-agent tool, when present) | run | `tool-contracts-DS9i4t9j.mjs:4-8` |

All [V] at the cited lines. Every other tool gives no activity: `ls`, `apply_patch` (its only input
is the patch text, which holds file contents), `process`, web, messaging, `sessions_spawn`, MCP
tools. MCP tools are named `<safeServerName>__<tool>` (F13), so CT's are
`curated-thoughts__curated_*` or `<operator-name>__curated_*`; the core `isCtTool` matches both
(decision 5).

### Working directory

The middleware event's `cwd` is the agent's workspace directory, the directory OpenClaw's file
tools resolve relative paths against [V live: `<state>/workspace`]. It comes from the embedded
extension context (`resource-loader-CJ9wmE3G.mjs:2963-2975`). It is the only cwd used; without it
(empty or not a string) no path is sent. `process.cwd()` is never used.

### Cache safety

The block is a new text block at the end of a tool result that did not exist in the previous
request. The next request appends after the previous request's messages, which stay byte-identical
[V live, A3 run: earlier messages identical apart from the host's moving `cache_control` marker].
The system prompt (bootstrap in `prependSystemContext`) is untouched (rule 2).

### Subagents, cron and heartbeat

- Subagent sessions have their own `sessionKey` with a `subagent:` segment (F15), their own
  `before_prompt_build` per run (the hook fires for every prompt build, any trigger, F6), and the
  middleware sees their `sessionKey` [V code]. Each child therefore gets its own ledger, tracker and
  step slots.
- Cron and heartbeat runs are ordinary runs with `ctx.trigger` `cron` / `heartbeat` (F6). Nothing in
  the activity path checks the trigger or the subagent segment (decision 4). The user-turn path keeps
  its existing gate (user turns of parent sessions only) [U: cron / heartbeat / subagent runs were not
  exercised live; the shapes are the same hooks].

## Design

### Overview

```
before_prompt_build (every run, any trigger)        model_call_started (observe)
  ├─ snapshot event.messages → turn input            └─ step[sessionKey] = {runId, callId}
  │   (runId, drained ids, bootstrap ids, restored)
  ├─ run ledger reset for a new runId               tool-result middleware (runtime "openclaw")
  └─ user-turn path unchanged (user turns of        ├─ CT recall → N3 dedup (unchanged)
     parent sessions only)                          ├─ note marker ids of the result (run ledger)
                                                    └─ activity:
                                                       ├─ CT tool / not executed / no activity → pass
                                                       ├─ no snapshot for this run → no_ledger
                                                       ├─ tracker.peek(session, stepId, key)
                                                       ├─ startActivity (core gates, --max 1, exclude)
                                                       ├─ admit key; await ≤ 3 s
                                                       ├─ finishActivityOutcome (fresh ledger, select)
                                                       ├─ append ONE text block (marker first)
                                                       └─ retry → release key
```

### Trigger: the middleware, for an executed call

`activityTrigger(event)` is true only when all hold:

1. the tool is in the table above and `isCtTool(toolName)` is false (decision 5);
2. `result.details.status` is not `approval-pending`, `approval-unavailable`, `denied`, `blocked`,
   `cancelled`, `canceled` or `aborted` (the call did not run);
3. the result is not an error, **or** it is an error whose `details.exitCode` is a finite number
   (the command ran and exited non-zero: a failing `pnpm test` still counts; a denied exec, whose
   `exitCode` is `null`, does not).

Everything else passes the result through untouched. This is decision 8 for OpenClaw: a query is
started only after the host executed the call.

### Query, builder and key (shared core, unchanged)

`openclawActivitySpec(toolName, args)` maps the table to an `ActivitySpec`; the core does the rest:
`buildActivity(spec, cwd, process.env)` (privacy amendments 1–7: project-root allowlist, user names,
command and search allowlists), `activityQuery` (the bare target, ≤ 300 chars), keys with
read / write / edit folded into `file`. No OpenClaw-specific text processing exists. The core suite
already runs the 290 shared vectors and the golden blocks; this leg adds an OpenClaw test that runs
the same vector file through `openclawActivitySpec` → `buildActivity` (so the binding cannot drift
from the core) and checks the delivered block against the golden renderer output.

### Rate rule: one CT call per model step

- **Step id** = the `callId` of the latest `model_call_started` for the session, when its `runId`
  equals the middleware's `ctx.runId`. Otherwise (the hook did not fire for this run, or not yet) the
  step id is `<runId>:model:?`, one shared slot for the whole run until a step id arrives. That
  fallback can only merge steps (fewer calls), never split one.
- `ActivityTracker` (core, per `sessionKey`): `peek` before any work; `admit` only after
  `startActivity` succeeded (the DSH rule: a refused start records nothing); `release` on a
  retryable outcome.
- **Parallel tools of one step** race only on the synchronous `admit`; the first result to arrive
  with a new key wins and carries the delivery; the others pass through untouched. Unlike DSH,
  "first" is completion order, not model order (the host gives no per-step order).
- **Edge case [U]:** a `model_call_started` delayed until *after* some of its step's tool results
  would let that step use two step ids (the old and the new one), so two CT calls in one step. It
  needs the host's fire-and-forget queue to stall for the whole model call (seconds); the live run
  showed the hook firing at once. Accepted and listed under limitations.
- No per-run, per-message or per-session ceiling (decisions 1 and 6).

### Budget and failure release

- `deadline = query start + TIMEOUT_MS (3 s)`; the middleware awaits the match for at most that
  long. The CT subprocess has its own 3 s timeout. Unlike Hermes and DSH, the call cannot overlap
  the tool (it starts after execution, decision 8), so a triggering tool result can be delayed by up
  to 3 s. Only key changes trigger, at most once per step.
- `finishActivityOutcome` reports every outcome. `retry` (budget, a CT failure, a gate that closed)
  releases the key and the step slot; `zero_hits` (no_match, deduped, gate_uncalibrated) keeps them
  (decision 10). A block that cannot be placed (the result already has 200 blocks) is reported
  `no_channel` and also releases.
- The breaker is the **same** instance the user-turn path uses (rule 4).
- Delivery never plans (decision 9): the only code that starts a CT query is the trigger above, and
  it delivers into the same result. Nothing else in the plugin starts an activity query.

### Channel: one extra text block in the tool result

```
## Curated Thoughts — relevant to this step
_for: read src/billing/invoice.ts_

<!-- ct-fact:<id> --> **<title>** (provenance: <provenance>)
<text, truncated with … to fit>
```

- Rendered by the core `selectActivityDelivery` (marker first, 1 fact, ≤ 600 chars; corrections only
  when they supersede an id in context), byte-identical to Hermes's `render_activity_block`
  (golden fixture).
- Appended as `{type: "text", text: block}` after the result's last block; `details` and every other
  block pass through unchanged. Only when `content.length < 200` (host limit).
- `isError` stays what it was (the host decides it from the original result).

### Ledger and exactly-once (rule 1)

**Source of truth: what the model sees.** At a run's `before_prompt_build` the adapter stores the
snapshot (`event.messages`), the ids drained into this run, the settled bootstrap ids and the
restored flag for **every** session (today only user turns of parent sessions store it). The
activity ledger for a tool result of run R is:

- the snapshot scan of run R (user content, persisted model-prompt projections, tool results);
- ∪ the drained salvage ids of run R and the bootstrap ids;
- ∪ the **run ledger**: every id that entered context *during* run R, collected as it happens:
  - the user-turn block returned as `prependContext` (or salvaged for the next turn, so it is not
    delivered again while it waits in the queue);
  - every marker id of every tool result that passes through the middleware, after our rewrite
    (activity blocks, N3 trailers, and forged markers, which can only suppress);
  - every id the N3 cache learns (`cacheLedger` unions into it): recall envelope ids, live and
    activity deliveries.

The run ledger is reset when a `before_prompt_build` with a new `runId` stores a snapshot, because
from then on the snapshot itself carries those tool results (A3). The N3 cache (`cachedLedger`) is
scoped to the run the same way, so a stale cache from an earlier run is never used.

- **No snapshot for this run** (the plugin was loaded mid-run, a gateway restart lost memory, or
  `before_prompt_build` is blocked because the grant is missing) → `no_ledger`, no CT call. This is
  the fail-closed rule for "can't tell what is in context".
- **Restored sessions** follow the core gate (`restored_unknown_bootstrap`): a session first seen by
  this process with assistant turns in its snapshot gets no activity delivery until its bootstrap is
  settled (same rule as the user-turn path, now computed for every session).
- **Concurrency.** Node runs one middleware call at a time between awaits. The ledger is re-read
  after the awaited match (`finishActivityOutcome` rebuilds it), and the delivered id joins the run
  ledger synchronously before the handler returns, so a parallel tool result of the same step or a
  CT recall resolved meanwhile is seen.
- **At most once.** If the host discards our result (another middleware replaces it, the run is
  aborted), the id is in the run ledger but not in context: the fact may arrive in a later run, never
  twice. Compaction during a run can only remove facts the run ledger still lists (fewer deliveries).
- **Aggregate tool-result elision.** At request time OpenClaw may elide old tool results under an
  aggregate budget (`AGGREGATE_ELISION_MARKER`, `tool-result-truncation-B1JI3j0I.mjs:604`) [V code].
  The snapshot may still list their markers; that can only suppress a delivery.

### Fail-closed cases

Each means "the tool result unchanged", one debug line (`wisdom-activity: skip session=… class=…`
on `api.logger.debug`), and never a throw.

| Class | Where | Verbose record? |
|---|---|---|
| `ct_tool`, `not_executed`, `no_activity` | trigger | no |
| `empty_id` (no `sessionKey` or `runId`) | trigger | no |
| `seen_key`, `step_used` | tracker | no |
| `no_ledger` (no snapshot for this run) | trigger | yes, once per step, for a would-be trigger |
| `no_session`, `delivery_off`, `restored_unknown_bootstrap`, `capability_missing`, `breaker_open` | `startActivity` | yes, once per step |
| `spawn`, `timeout_or_exit`, `parse_error`, `hook_failed` | match | yes |
| `budget` | after the await | yes |
| `zero_hits` → `deduped` / `no_match` / `gate_uncalibrated` | finish | yes |
| `no_channel` (200 blocks already) | append | yes |

### Verbose mode (channel `activity`)

The adapter's recorder already writes `channel: before_prompt_build`; activity records override it
with `channel: "activity"` and add `activity` (the label) through the core `reportActivity`. The
notice goes to `api.logger.info` (`… [activity]`), the record to
`$OPENCLAW_STATE_DIR/logs/ct-wisdom-verbose.jsonl`. With verbose off nothing is written and every
tool result and prompt result is byte-identical (tested).

### What does NOT change

- The user-turn path (2 facts / 1200 chars, its gate, admission memo, salvage) and its block bytes.
- The bootstrap block and `prependSystemContext` (rule 2).
- The N3 recall dedup output.
- The manifest surfaces (the middleware contract is already declared); `install.sh`.
- (Amended after the live run) the plugin state moves to one process-wide holder; behavior per
  session is unchanged, except that the N3 dedup now has the ledger it was designed to read.

## Alignment with INTENT.md

- **Goal "During autonomous work":** this is that step for OpenClaw. It answers INTENT's four open
  questions for this host: the event (the tool-result middleware for an executed call, stepped by
  `model_call_started`), the query text (the bare target from the shared builder), the frequency (at
  most once per model step, on a key change) and the channel (an extra block in that tool result,
  persisted and replayed, A3).
- **Rule 1 (at most once):** marker first on every fact; the ledger is the model-visible snapshot of
  the run plus everything that entered context during the run; the delivered id is recorded before the
  handler returns; no snapshot means no delivery.
- **Rule 2 (never edit the system prompt):** delivery rides an appended tool-result block; the system
  prompt and the cached prefix are untouched [V live].
- **Rule 3 (no superseded fact):** CT filters superseded entries; corrections ride only when they
  supersede an id in context.
- **Rule 4 (fail quietly):** the middleware never throws (a throw would replace the tool output), no
  `before_tool_call` hook exists (a throw there would block the tool), 3 s budget, the shared breaker.
- **Rule 5 (provenance):** the block shows CT's provenance label.
- **Rule 6 (keep it small):** 1 fact, ≤ 600 chars per delivery, no session cap.
- **Rule 7 (read only):** `ct wisdom match` only.
- **Rule 8 (relevance is CT's):** the shared builder renders the action; nothing scores, expands or
  ranks.
- **Departures:** none from INTENT. Where OpenClaw differs from Hermes and DSH on purpose: the query
  starts after the tool ran, not at the pre-tool hook (decision 8 on a host whose pre-tool hook
  precedes approval), so it cannot overlap the tool; the step id comes from an observe-only hook
  instead of the tool call's own payload; and the in-run ledger is process-local (a restart mid-run
  fails closed).

## Known limitations

1. **Concept rules via paths** need CT activity mode (curated-thoughts#282).
2. **Latency:** a triggering tool result waits for CT (up to 3 s); no overlap with the tool.
3. **Embedded runtime only;** Codex app-server and Copilot get no activity delivery.
4. **`apply_patch` gives no activity** (its input is patch text). Models that edit through it get
   activity only from `read` / `exec` / searches.
5. **Step ids from a fire-and-forget hook [U]:** a dropped `model_call_started` merges steps; a
   stalled one could let one step make two calls.
6. **Process-local run ledger:** a gateway restart mid-run gives `no_ledger` until the next run.
7. **[U]** subagent, cron and heartbeat runs are inferred from the hook shapes, not exercised live.
8. **One trigger per step:** other new keys in the same step stay unseen and can trigger later.
9. ~~**Recalls through `tool_call`** bypass the N3 dedup~~ — closed in openclaw 0.3.5 by [2026-10-17-openclaw-meta-recall-n3-design.md](2026-10-17-openclaw-meta-recall-n3-design.md).

## Testing

Vitest in `integrations/openclaw/tests/`:

- **Binding:** the tool map, `path` / `file_path`, never content args; the 290 shared vectors
  through `openclawActivitySpec` → `buildActivity` (cwd = the vector's world); the golden block.
- **Trigger:** executed vs approval-pending / denied / error-with-exit-code / error without one.
- **Coalescing:** parallel results of one step make one CT call; a new step (new `callId`) may make
  another; the `:model:?` fallback merges; same key in a later step makes none; release on budget /
  failure lets a later step retry; `zero_hits` keeps the key.
- **Subagents / cron / heartbeat:** a `subagent:` session and `trigger: cron` / `heartbeat` runs get
  activity delivery with their own ledger; the user-turn gate is unchanged for them.
- **Fail-closed:** every class above; a throwing CT spawn, logger or adapter never throws out of the
  middleware; 200-block results; no snapshot; restored without bootstrap.
- **Marker hygiene:** marker precedes the title; activity queries never contain `ct-fact:`, the
  heading or block text; forged markers in tool output only suppress.
- **Verbose:** off → no file, byte-identical results; on → one `activity` record per delivery and
  per recorded skip.
- **Exactly-once randomized:** sessions mixing user turns (prependContext and salvage), runs with
  multi-step parallel tool batches (activity), CT recalls (N3), compaction, gateway restarts mid-run
  and between runs, random corrections and a fake CT that ignores `--exclude` half the time; the
  oracle counts each fact id in the model-visible window (bootstrap, projections, every tool-result
  block) and fails on any count above 1.
- **Shape contract:** `model_call_started` is registered and in the pin's hook list; it is not a
  conversation-access hook; no `before_tool_call` is registered; the middleware event fields read
  (`cwd`, `args`, `toolCallId`, `isError`, `result`) are in the recorded pin facts; the
  `model_call_started` event / ctx fields read are recorded.

**Live e2e** (`integrations/openclaw/tests/e2e/run.sh`, native install in an isolated
`OPENCLAW_STATE_DIR` and `HOME`, body-only recording proxy, ZAI GLM-5.3-FLASH, a CT stub): one
user message makes the agent do several tool steps (write and read a file, run a command twice, a
CT recall). Checks (Hermes-style): an activity block arrives exactly once per fact, marker first;
the repeated command neither re-queries nor re-delivers; CT's own tool never triggers a query;
every activity query is the bare target; the delivered block is in the next model request and in
the next turn's request (persisted and replayed); verbose `activity` records.

## Implementation findings (live e2e, 2026-10-17)

The first live run of the implementation delivered nothing (`no_ledger`). Two host facts the code
reading had missed:

1. **The host loads the plugin module several times per process, and serves the prompt hooks and
   the tool-result middleware from different instances [V live].** The A3 probe, instrumented with a
   module id, registered three times in one `openclaw agent --local` process (three distinct module
   ids, one shared `globalThis`); `before_prompt_build` and `model_call_started` ran on the third
   instance, the middleware on the first. Per-registration state therefore never reached the
   middleware. **Fix:** all wisdom state (adapter, breaker, bootstrap memo, activity tracker, the
   sighting / drained / admission maps) lives in one process-wide holder
   (`globalThis[Symbol.for('curated-thoughts.openclaw.plugin-state.v1')]`, versioned so new code never
   reuses an old shape); each registration only refreshes the logger it reports through. Tests that
   build plugins with `createPlugin` keep a private holder per plugin. This also fixes the shipped
   N3 recall dedup, which ran with an empty ledger in the middleware instance since 0.1.0 (it added
   marker trailers but never stubbed a repeat) — the earlier leg never exercised N3 live.
2. **MCP tools may be reached through the `tool_call` meta tool [V live].** With the stub CT sidecar
   mounted, the model called `tool_call` with `args.id = "mcp:curated-thoughts:curated-thoughts__curated_recall_context"`;
   the transcript records the MCP call as a nested `openclaw.nested-tool.v1` entry and the outer
   `tool_call` result as an external-content-wrapped JSON text. The middleware sees `tool_call`. The
   activity path is unaffected (`tool_call` is not in the map, so CT tools still never trigger), but
   the N3 recall dedup does not see such recalls: a recall routed this way can show a fact the agent
   already has. Pre-existing, out of this spec's scope; a follow-up (unwrap the meta-tool envelope or
   key on `args.id`).

## Results (2026-10-17)

- **Unit and property tests:** openclaw suite 209 tests (binding, the 290 shared vectors through the
  OpenClaw binding, the golden blocks through the middleware, trigger, coalescing, release / keep,
  fail-closed classes, shared state across module instances, verbose, the randomized exactly-once
  test: 150 sessions, 1481 activity deliveries, 153 mid-run restarts, 77 corrections, 0 violations;
  a mutation that drops the run ledger fails it).
- **Live e2e** (`tests/e2e/run_activity.sh`, openclaw 2026.10.3 native, isolated `HOME` /
  `OPENCLAW_STATE_DIR` / `CURATED_BRAIN_DIR`, ZAI GLM-5.3-FLASH through the body-only proxy, **stub CT
  and stub MCP sidecar**): 15/15 checks pass. Six tool steps (`read TASK.md`, `exec git status` ×2,
  `write` + `read .env.local`, a recall via `tool_call`) gave exactly three activity queries,
  `TASK.md`, `git status`, `.env.local`, each the single argv element after `--`; three marker-first
  blocks, each in its own tool result, byte-identical in every later request of the run and in the
  next turn's request from a fresh process (persisted and replayed); no fact marker twice in the
  final request; verbose `activity` delivery records for the three; the key in no work-dir file. The
  N3 check reports the `tool_call` routing above as known. The real CT gate was not run here (no
  native `ct` on the dev Mac); the same bare-target queries went through the real gate in the DSH
  leg's e2e.
- **AC 9 cache gate re-run** with the process-wide state (`tests/e2e/run.sh`, isolated `HOME` and
  brain): **cache-safe** (system prompt identical, turn 1 replayed byte-identically, turn-2 block in
  the last user message only, no repeated id).
- **Other suites:** core 122, deepseek 290, opencode 288 (with `--testTimeout 60000` on the slow
  dev Mac; two doctor tests time out at the 5 s default under load), all `tsc` clean; `ct_ci.py`
  validate, generate, policy and readme gates pass.

## Review amendments (PR #67 @ cee0ec4, high-effort review)

1. **Snapshot before the admission cache.** `before_prompt_build` now always stores the run's
   snapshot (`setTurn`, run-ledger reset) *before* looking up the admission memo; only the CT call
   (the live outcome) is memoized. A host re-run of a cached admission under a new `runId` keeps
   activity delivery, and the cached live block, a salvaged block and the ids drained into the
   admitted request join the new run's ledger.
2. **Config per registration.** The process-wide state no longer freezes the first registration's
   `pluginConfig.brainDir`: each registration recomputes the environment, and the spawn binding reads
   it at spawn time (`nodeSpawnFn(() => state.env)`).
3. **Budget = the match only.** `ct` discovery and the `wisdom match --help` probe are cached and
   warmed at prompt time (`adapter.ready()`, one shared attempt); the activity path awaits them
   *before* the 3 s budget starts. On expiry the abandoned child is killed (an `AbortSignal` through
   `SpawnLike.signal`; `nodeSpawnFn` kills the process tree), the core reports `budget` and never
   `recordSuccess`, and the OpenClaw host **counts the miss toward the shared breaker** (as the
   review asked). The core helpers (`settleWithin` with an expiry callback, the `signal` plumbing,
   `ActivityTracker.releaseKey`) are taken byte-identically from the OpenCode leg's branch (#66) so
   the second PR to merge reconciles trivially. Note the one divergence: the OpenCode host does not
   count a budget miss toward the breaker; OpenClaw does, from its own expiry callback, not in the
   core. The step is claimed synchronously before the `ready()` await (parallel results of one step
   still make one call) and released if the start is refused.
4. **No run id (`''`, legacy hosts) is no run.** It is normalized to absent: nothing is run-scoped,
   `noteRunIds` is a no-op, every snapshot starts clean, and activity delivery is off (`no_ledger`).
5. **Recalls through `tool_call`.** The middleware recognises a `tool_call` whose `args.id` names a
   `curated_recall_context` tool and reads the envelope ids out of the external-content wrapper
   (`{tool, result: {content: [{text: <envelope>}]}}`, the live-verified shape) into the run ledger,
   so activity never repeats them. If the result is not that shape, the run goes blind
   (`meta_unreadable`): no activity delivery until the next snapshot. N3 still cannot stub such
   recalls (limitation 9).
6. **N3 for every run, made safe under compaction.** N3 now runs with the run's ledger in every
   session (it had none outside user turns before, and none at all live). The risk is a ledger that
   holds ids compaction removed from view, which would make N3 stub a fact the agent can no longer
   see. The embedded runner fires `before_compaction` / `after_compaction` for in-run compaction
   (`builtin-openclaw-C66TYl5I.mjs` `runBestEffortCompactionHook`, ctx `{sessionKey}`) [V code]; the
   plugin registers both and marks the run **blind** (`compacted`): the ledger then reports nothing
   in context (N3 stubs nothing), the N3 cache is dropped, activity refuses the run, and the next
   snapshot (taken after compaction) clears it. Tested; the randomized test gained mid-run
   compactions (223 across 150 sessions, 0 violations).
7. **Bounded run ledger.** A `Set` plus an order list, capped at `EXCLUDE_MAX`. Forgetting an id that
   is in context could repeat it, so on overflow the oldest ids are dropped *and* the run goes blind
   (`ledger_overflow`).
8. `settleWithin` comes from the core (item 3).
9. `resultIds` reuses the adapter's exported `partTexts`.
10. The dead `deadline` / `now` seam in the activity path is gone.

After the amendments (merged with origin/main @ #66): openclaw 223 tests, core 130, deepseek 290,
opencode 332, all `tsc` clean, the `ct_ci.py` gates pass; `run_activity.sh` 15/15 again (same three
queries and blocks) and the AC 9 cache gate cache-safe again.

## Post-merge review amendments (openclaw 0.3.1)

1. **[regression] The run ledger holds only ids NEW in the run.** 0.3.0's `cacheLedger` copied the
   whole rebuilt ledger (snapshot, drained, bootstrap) into the run ledger, so a session whose history
   carried more than `EXCLUDE_MAX` (256) ids overflowed at once, went blind, and lost both N3 and
   activity for good. The snapshot's own ids (scan ∪ drained ∪ bootstrap) are now computed once per
   snapshot and kept apart; `noteRunIds` skips them and `rebuildLedger` unions them at read time.
   Overflow now means more than 256 new ids in one run. Regression test: a 300-id history.
2. **Idempotent middleware.** A second pass over the same tool result (another module instance's
   middleware) is a no-op: the result we return carries a non-enumerable
   `Symbol.for('curated-thoughts.openclaw.processed-result')` flag, and processed
   `sessionKey#runId#toolCallId` keys are remembered in the shared state. **Not done: the
   "only one instance registers the middleware" guard.** The live probe showed the host serving the
   middleware from the *first* module instance and the hooks from the *third*; a guard that registers
   only once would match that, but nothing verifies which registration the gateway runtime consults,
   and a wrong guess would silently disable N3 and activity entirely. With the per-result marker,
   several registrations are harmless, so every instance keeps registering.
3. Retryable outcomes free only the key (`releaseKey`); the step stays used.
4. The first-use locate + probe wait is bounded (`READY_WAIT_MS = 2 s`, apart from the 3 s match
   budget, the probe gets the abort signal); still unknown → `probe_pending`, the step is not
   claimed (a sibling that claimed meanwhile is re-checked before claiming).
5. `wisdomMatch` waits on the shared in-flight `ready()` instead of probing again.
6. **Breaker on budget, in the core (controller decision).** `runActivityMatch` counts an aborted
   (budget) match as one breaker failure through the new `recordActivityBudgetMiss(breaker)`, and
   never records a success for it; an abort from anywhere else (outcome `aborted`, opencode 0.4.1)
   counts nothing. The OpenClaw host no longer counts it itself; the spawn binding now reports an
   abort as `aborted`. Tests on both bindings (OpenClaw here, OpenCode in its suite): `BREAKER_FAILS
   − 1` expiries keep the breaker closed, `BREAKER_FAILS` open it (a double count fails the first).
   DeepSeek Harness passes no signal, so its budget misses do not reach this rule; a host that
   cannot abort calls `recordActivityBudgetMiss` itself on expiry (not changed for DSH here).
7. `metaRecallIds` reads part by part; "unreadable" only when no part yields an envelope and some
   part is not JSON.
8. The state key carries the package version (`plugin-state@<version>`).
9. An unexpected throw after the claim releases the key and the step.

## Versioning and docs

- openclaw `0.2.2 → 0.3.0` (`package.json`, `openclaw.plugin.json`, `integration.yaml`), CHANGELOG,
  integration README (autonomous-work section), root README (intro line, autonomous table, Where /
  Cost notes) via `tools/ct_ci.py readme` for the version table.
- No core change is needed (the activity API shipped with deepseek 0.6.0).

## Out of scope

- Claude Code and OpenCode autonomous legs.
- CT activity mode, batch form or fast path.
- Codex / Copilot runtimes.

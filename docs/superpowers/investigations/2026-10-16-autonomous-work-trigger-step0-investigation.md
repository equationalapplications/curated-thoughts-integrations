# Intuitive Wisdom: autonomous-work delivery, Step-0 feasibility investigation (all five hosts)

**Date:** 2026-10-16 · **Status:** investigation (pre-spec). Research only, no production code. ·
**Review state:** not yet reviewed
**Feature:** the INTENT end state (PR #48, `docs/intent-autonomous-work-trigger`): an agent
working on its own between user messages (reading files, running commands, editing code)
can trigger delivery of relevant curated facts, keyed to what it is doing at that moment.
The rules that apply are unchanged: a fact appears at most once in context (rule 1), the
system prompt is never edited (rule 2), deliveries stay small (rule 6), CT decides what is
relevant (rule 8), and failures are quiet (rule 4).
**Question:** for each host, which events fire during autonomous work, what text can be
sent to CT as the query, which channel can carry a fact mid-task without breaking the
prompt cache, what it costs, and whether it is feasible at the pin.

Tags: **[V]** means verified in this session by reading the cited file and line or doc
URL. **[U]** means unverified or inferred, and the spec must close it or carry it as a
plan Step-0 target. Facts carried over from earlier investigations keep their original
IDs (for example "CC F7", "OC H5", "OClaw F12") and their original evidence.

## Pinned sources

| Host | Pin | How it was read |
|---|---|---|
| Hermes Agent | `NousResearch/hermes-agent@ee8dd6c8` (2026-10-07, the PR #35 investigation pin) | `gh api …/contents?ref=ee8dd6c8`: `agent/turn_context.py`, `hermes_cli/plugins.py`, `model_tools.py`, `agent/tool_executor.py`, `tools/delegate_tool.py`, `website/docs/user-guide/features/hooks.md` |
| DeepSeek Harness | `@deepseek-ai/dsh@0.2.0-rc.2` | `npm pack` of `dsh-agent-loop`, `dsh-agent`, `dsh-tools`, `dsh-hooks-claude-code`, `dsh-hooks-codex`, `dsh-tool-subagent` (all 0.2.0-rc.2) |
| OpenCode | `opencode-ai@1.18.35` | `npm pack @opencode-ai/plugin@1.18.35` (`dist/index.d.ts`), plus the `opencode-darwin-x64@1.18.35` binary the 2026-10-16 leg already installed in the scratchpad (bundled JS read with `grep -a`, and its `strings` dump) |
| Claude Code | 2.1.301 | official docs: code.claude.com/docs/en/hooks and /prompt-caching, fetched 2026-10-16. The CC leg's live facts F1–F15 carry over |
| OpenClaw | `openclaw@2026.10.3` | the package the 2026-10-16 OpenClaw leg installed in the scratchpad: shipped `docs/plugins/hooks/*.md` and `dist/builtin-openclaw-C66TYl5I.mjs` |

Downloaded code was read as data and never executed. None of it is committed. Paths below
are relative to each package root (`package/…` for npm tarballs).

Repo state: `origin/main` @ `801b6c5` (PR #47 merged). Adapters read:
`integrations/hermes/scripts/ct_wisdom_live.py`, `integrations/deepseek/src/index.ts`,
`integrations/opencode/src/wisdom-live/*`, `integrations/claude-code/hooks/ct_wisdom_cc.py`,
`integrations/openclaw/src/index.ts`, `packages/ct-wisdom-core/src/{engine,types,constants}.ts`.

## What CT's gate taught us today (input to every query rule below)

Today's real-gate run (PR #47, `integrations/deepseek/tests/e2e/e2e.sh:590-700`, opt-in
`CT_E2E_REAL_GATE=1`) used CT 3.5.1. It scores raw cosine similarity over wiki-entry
embeddings against a per-model floor. Only `external:qwen/qwen3-embedding-4b` is
calibrated (0.70 raw, 0.64 under the `instr1` scheme) [V e2e.sh:592-596]. The run showed
that the gate stays closed on long mixed prompts and opens on short, focused text (the
controller reported this; the transcript is not in the repo) [U for the general claim].

Consequence: **autonomous queries have to be short, single-topic strings**. Feeding CT a
tool's output, a whole diff, or the assistant's reasoning would both cost more and match
less. The query rule in the synthesis follows from this.

---

## Host 1: Hermes (reference)

### 1. Triggers

- **[V]** `pre_llm_call` fires **once per user turn, before the tool loop**. The hook
  catalog says "Once per turn before the loop" (`hooks.md:456`), and the call site is
  `_collect_pre_llm_call_context` (`agent/turn_context.py:782-805`). It does **not** fire
  between model steps, so it cannot serve autonomous work.
- **[V]** `pre_api_request` fires "Per provider attempt, immediately before the request;
  **return ignored**" (`hooks.md:460`). It is per step but observe-only, so it cannot
  deliver.
- **[V]** `pre_tool_call` fires once before each tool runs. Its kwargs are `tool_name`,
  `args`, `task_id`, `session_id`, `tool_call_id`, `turn_id` and `api_request_id`
  (`hooks.md:451`; `model_tools.py:773-787`). It can block or modify arguments, and it
  cannot inject context.
- **[V]** `post_tool_call` is an observer, called after each tool (`model_tools.py:676-700`).
- **[V]** `transform_tool_result` fires after `post_tool_call` and "before conversation
  append; first string replaces the result" (`hooks.md:453`; `model_tools.py:848-865`,
  called at `:959` for every registry dispatch). The docs name our exact use case: "inject
  retrieval-augmented hints into `read_file` results" (`hooks.md:1602`). It "Applies to
  every tool", including `terminal` (`hooks.md:1617`). Agent-loop tools are handled
  outside `handle_function_call` (`model_tools.py:937-938`). Inline executors also call the
  hook (PR #35 investigation, `agent/inline_tool_executors.py:63-80`).
- **[V] Concurrency:** tool batches run on up to 8 worker threads
  (`agent/tool_executor.py:129`, `_MAX_TOOL_WORKERS = 8`). So `transform_tool_result` can
  run concurrently for one session.
- **[V] Subagents:** `delegate_task` builds a child agent with its own session and
  `parent_session_id` (`tools/delegate_tool.py:284`). It fires `subagent_start` with
  `child_session_id` (`:327-332`). The child's tool calls go through the same
  `handle_function_call`, so its hooks fire under the child's `session_id` [U that every
  child tool path carries the child id. It is inferred from the shared dispatcher].

### 2. Query source

At `transform_tool_result`, the hook has `tool_name`, `args` (file path, command, pattern)
and the full `result` string. It gets **no conversation history and no assistant text**
(`hooks.md:453`). `pre_tool_call` has the same args before the tool runs. A useful query is
the tool's target ("read_file `src/billing/invoice.py`", "terminal `pytest tests/billing`").
The result is too long and too noisy (see the gate note above).

### 3. Channel

**Tool-result augmentation through `transform_tool_result`.** Append the fact block to the
returned string. The hook runs before the result enters context, so the bytes are written
once, persisted in the session DB like any tool result, and replayed unchanged
[V `hooks.md:453`; persistence follows from the PR #35 investigation "Rewriting happens
before the result first enters context"]. The block lands after the previous request
prefix, so it is cache-safe by construction. The system prompt is untouched.

Ledger view: the next `pre_llm_call` rebuilds the ledger by scanning `conversation_history`,
tool-role messages included. Markers in the augmented result are therefore ledgered on the
next turn [V `ct_ledger.history_ids`; `ct_wisdom_live.py:373` counts only user-role ids
for the budget]. **Within the turn**, the transform has only the per-process
`LEDGER_CACHE` that `pre_llm_call` filled (PR #35 design "Ledger"). It must update that
cache under a lock, because of the 8-thread batches.

Gaps:

- (a) The M1 live budget counts user-role markers only, so activity deliveries would not
  count. They need their own counter (a distinct heading or marker class).
- (b) A restored session never fills the cache, so the transform must fail closed when the
  cache has no entry. That matches Hermes M2.
- (c) If `transform_tool_result` returns a string that replaces a CT recall result, the
  dedup stub and the augmentation must be composed in one hook, not two.

### 4. Cost and latency

The hook is synchronous Python on the tool path, so a 3 s CT call adds up to 3 s to every
tool call that triggers. **Prefetch is possible:** start `ct wisdom match` on a thread at
`pre_tool_call` (args are known), then join it at `transform_tool_result` with whatever
budget is left. Most file reads take less time than one CT call, so the join usually
waits. The real saving comes from rate limiting (see the synthesis). Measured CT latency on
the live path was 0.44–2.07 s, p95 1.22 s (PR #35 investigation, Step 10).

### 5. Verdict: **feasible with caveats**

The channel is proven and documented, and the triggers are per tool call. The caveats are
the in-turn ledger (cache plus lock), thread concurrency, a separate activity budget, and
the synchronous latency.

*Minimal sketch:* `pre_tool_call` computes an activity key from the args. If the key is
new for this session, it starts a CT match on a thread. `transform_tool_result` joins the
thread (bounded), post-filters against `LEDGER_CACHE`, appends an
`## Curated Thoughts — relevant to this step` block with markers, and records the ids. The
existing CT-recall dedup stays in the same callback.

---

## Host 2: DeepSeek Harness 0.2.0-rc.2

### 1. Triggers

- **[V] `agent/pre-step` fires for every model step, not just the first.** In `turn()`
  (`dsh-agent-loop/lib/index.js:936-1040`), each loop iteration calls
  `preStep(target, {turn, step})` (`:954-957`). After step 1, `target` becomes `"next-step"`
  (`:1006`). The loop stops after a step only when the turn ended **and** the next-step
  inbox is empty (`:998-1005`). The "firstAttempt" in the parity spec's table refers to
  retry attempts inside `step()` (`:1048-1062`): decision messages are appended once, on
  the first attempt. It does not mean the first step.
- **[V] Our adapter gates pre-step to one delivery per `(agent, turn)`** with a
  `liveTurns` set (`integrations/deepseek/src/index.ts:356-361`), so it ignores steps 2..N
  today.
- **[V]** The pre-step payload is `{agent, messages, turn, step, signal}`, where
  `messages` are "messages removed from the inbox for this step"
  (`dsh-agent/lib/types/runtime-types.d.ts:293-310`). On step ≥ 2, those are the tool
  `additionalContexts` and any steering (see the Channel section).
- **[V] `tools/pre-execute`** `(exec, next)` and **`tools/post-execute`**
  `(exec, result, next)` are core waterfalls (`dsh-tools/lib/types/index.d.ts:47`, `:70`).
  `exec` carries `name`, `arguments`, `agent` and `callId` (`:216-227`,
  `dsh-agent-loop/lib/index.js:509-517`). `result` carries `content`, `value`, `isError`
  and `additionalContexts` (`dsh-tools/.../index.d.ts:413-433`).
- **[V] Subagents** are full Agents with `parentAgent` (`dsh-agent/lib/types/index.d.ts:51-52`)
  and session metadata `origin: 'subagent'` plus `parentSession` (`:54-68`). The subagent
  tool creates them with `parent: exec.agent` (`dsh-tool-subagent/lib/index.js:490-520`).
  Hook dispatch is scope-filtered: "agent-scoped listeners receive only that agent"
  (`runtime-types.d.ts:301`). A root-registered plugin therefore sees child agents' pre-step
  and post-execute too [U that the plugin's `apply()` context is root-scoped. It is inferred
  from the CC-hooks bridge, which receives every agent]. **Finding:** the shipped DSH
  adapter has no subagent check (no `parentAgent` / `origin` test in
  `integrations/deepseek/src`), so live delivery already runs inside DSH subagents. That
  differs from the CC and OpenCode policies (main thread or parent only). Flagged for the
  spec. It is not a bug per INTENT, because each child has its own context and ledger.

### 2. Query source

At `post-execute`: `exec.name` and `exec.arguments` (path, command) and the result. At
pre-step on step ≥ 2: `agent.session.deriveMessages()` gives the whole log, including the
last `assistant/message` with its tool-call blocks and their arguments
(`dsh-agent-loop/lib/index.js:1136-1154`). One query per step can therefore be built from
**all of that step's tool calls**. The assistant's visible text is there too. Reasoning
blocks may be present depending on the provider [U].

### 3. Channel

Two persisted, append-only channels exist. Both are first-party patterns.

- **(a) Pre-step `decision.messages` on step ≥ 2.** This is the same mechanism the live leg
  already uses and has proven end to end (parity spec AC 10, "DSH leg DONE"). Messages are
  appended as `user/message` on the first attempt and the request is derived from the log
  (`index.js:1061`, `:1063`; PR #36-era semantics doc Q1).
- **(b) `tools/post-execute` → `additionalContexts: UserMessage[]`.** The loop splices
  each into the durable inbox's `next-step` queue (`index.js:572`, `:1154`). The next
  pre-step claims it (`:103-105`, `:906`) and appends it as a `user/message`. The
  first-party Claude-Code-hooks bridge maps `PostToolUse.additionalContext` exactly this way
  (`dsh-hooks-claude-code/lib/index.js:265-291`, `createUserMessage` at `:204-212`).

Both land in the session log, so they replay on resume. The ledger rule m5 ("rebuild from
`deriveMessages`") sees them at the next trigger without any change. Exactly-once
machinery: the delivered message must carry a **distinct `source.kind`** (for example
`curated-thoughts-wisdom-activity`). That keeps the live budget (M1) counting user-turn
deliveries only and gives activity deliveries their own count.

**Trap [V]:** pending `next-step` input keeps the turn open. "The conclusion never
short-circuits already-submitted next-step work: same-step `additionalContexts` … still
runs" (`runtime-types.d.ts:371-380`), and the loop runs another step while
`inbox.nextStep` is non-empty (`index.js:998-1005`). An `additionalContexts` injection
after a tool that sets `concludesTurn` would therefore **force an extra model call**.
Channel (a) avoids this, because pre-step on step N+1 only runs when the loop was already
going to call the model. Channel (a) is therefore preferred.

### 4. Cost and latency

Pre-step is awaited before the request, so a CT call adds up to 3 s per step. Prefetch:
start the match at `tools/post-execute`, or as early as `tools/pre-execute`, keyed by
`(agent, turn, step)`, and await it at the next pre-step. The calls overlap tool
execution. Per-step batching gives at most one CT call per model step, and in practice
fewer, because of the change-only rule.

### 5. Verdict: **feasible** (the strongest host)

*Minimal sketch:* drop the per-turn-only gate for an **activity path**. On pre-step with
`step ≥ 2` and `target === "next-step"`, read the previous step's tool calls from
`deriveMessages()`, build the activity key or query, and skip if it is unchanged. Await
the prefetched match, post-filter against the session-log ledger, and append one
`{id, role:'user', source:{kind:'curated-thoughts-wisdom-activity'}, content}` message to
`decision.messages`. Do not use `additionalContexts`.

---

## Host 3: OpenCode 1.18.35

### 1. Triggers

The full plugin `Hooks` surface at the pin [V `@opencode-ai/plugin/dist/index.d.ts:173-322`]:
`event`, `config`, `tool`, `auth`, `provider`, `chat.message`, `chat.params`,
`chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before`,
`shell.env`, `tool.execute.after`, `experimental.chat.messages.transform`,
`experimental.chat.system.transform`, `experimental.provider.small_model`,
`experimental.session.compacting`, `experimental.compaction.autocontinue`,
`experimental.text.complete`, `tool.definition`.

- **[V]** `chat.message` fires per user message only (OC H1, H4). Auto-continue skips it.
- **[V]** `tool.execute.before({tool, sessionID, callID}, {args})` and
  `tool.execute.after({tool, sessionID, callID, args}, {title, output, metadata})`
  (`index.d.ts:235-258`). In the binary, both are awaited around every builtin tool:
  `yield*i.trigger("tool.execute.before",…)`, then `k.execute`, then
  `yield*i.trigger("tool.execute.after",{tool:k.id,…,args:b},V)` … `return V` (opencode
  binary bundled JS; `oc-strings.txt` line 65865, re-confirmed with `grep -a` on
  `opencode-darwin-x64@1.18.35/bin/opencode`). MCP tools fire the same hooks with the
  `CallToolResult` shape (OC H5).
- **[V]** `experimental.chat.messages.transform` fires inside the prompt loop on every
  iteration (step), just before model-message conversion (bundle line 65877). It is
  **wire-only**, and parity decision 3 rejected it for delivery.
- **[V]** `chat.params` and `chat.headers` fire per LLM call. They can change only
  parameters and headers.
- **[V] Subagents:** the task tool runs a child session, and its tools fire hooks with the
  child `sessionID` (OC H7). The live leg's LD7 delivers in parent sessions only.

### 2. Query source

At `tool.execute.after`: `tool` (for example `read`, `edit`, `bash`, `grep`) and `args`
(`filePath`, `command`, `pattern`), plus `output`. There is no assistant text in the hook.
`client.session.messages()` could fetch it, at the cost of an HTTP round trip.
`tool.execute.before` gives the same args before execution, which supports prefetch.

### 3. Channel

**Tool-output augmentation in `tool.execute.after`.** For builtin tools, the hook mutates
`output.output` in place, and the same object `V` is returned as the tool result and
persisted as `state.output` [V bundle line 65865; OC H5 "Builtin tools keep
{title, output, metadata}"]. For MCP tools, append to the first `content[]` text item
(OC H5, LD2). It is persisted and appended after the prior request, so it is cache-safe.

Ledger: LD5's history scan already covers "completed tool `state.output`", so markers in
augmented tool output are ledgered across processes with no change. The in-process
`delivered` set covers the gap before persistence. The M1 count (LD6) counts only the
`curated-thoughts/wisdom` user-row marker, so activity deliveries need their own marker
line and count.

Not usable:

- `experimental.chat.messages.transform` is wire-only. It would put a fact in a request
  without persisting it, so the next step's prefix differs (cache miss), and the ledger
  could not see it.
- `chat.message` does not fire mid-task.

### 4. Cost and latency

The hooks are awaited on the tool path. Prefetch from `tool.execute.before` (start the
spawn, keep the promise in a map keyed by `callID`), then await it in `tool.execute.after`
with the remaining budget. Parallel tool calls each fire hooks, so rate limiting must be
per session and in process, and at most one call may be in flight per session.

### 5. Verdict: **feasible with caveats**

The caveats: subagent policy (most autonomous work in OpenCode happens in task children,
and LD7 excludes them), per-call rather than per-step granularity (no per-step persisted
hook), and the separate activity budget.

*Minimal sketch:* compute the activity key at `tool.execute.before`, then prefetch if the
key changed. In `tool.execute.after`, await (bounded), post-filter against the LD5 ledger,
and append the block with a distinct marker to `output.output` (builtin) or to the first
text item (MCP). Never on `curated_*` tools, where N3 applies.

---

## Host 4: Claude Code 2.1.301

### 1. Triggers

From code.claude.com/docs/en/hooks (fetched 2026-10-16):

- **[V]** `PreToolUse` and `PostToolUse` fire per tool call. `PostToolUse` input includes
  `tool_name`, `tool_input`, `tool_response`, `tool_use_id` and `duration_ms` (hooks,
  "PostToolUse input"). "`PostToolUse` fires once per tool, which means it fires
  concurrently when Claude makes parallel tool calls."
- **[V] `PostToolBatch`:** "Runs once after every tool call in a batch has resolved, before
  Claude Code sends the next request to the model … fires exactly once with the full
  batch". Its input is a `tool_calls` array, where each entry has `tool_name`,
  `tool_input`, `tool_use_id` and `tool_response`. Its `additionalContext` is "Context
  string injected once before the next model call" (hooks, "PostToolBatch"). **This is a
  per-model-step trigger.**
- **[V] Subagents:** "Hooks from settings files, managed policy settings, and plugins also
  run inside subagents … tool events such as `PreToolUse` and `PostToolUse` fire the same
  configured hooks as in the main conversation, and the input carries the `agent_id` and
  `agent_type`" (hooks, "Common input fields"; CC F4). [U] whether `PostToolBatch` also
  fires inside subagents. It is presumably a tool event, which the plan must check live.
- **[V] Async hooks:** `"async": true` runs a hook in the background. "After the background
  process exits, Claude Code delivers the `additionalContext` and `systemMessage` fields
  from the hook's JSON response to Claude on the next conversation turn … If the session is
  idle, the response waits until the next user interaction" (hooks, "How async hooks
  execute"). [U] whether "next conversation turn" means the next model request inside the
  tool loop or the next user turn. The wording suggests the user-turn boundary, which would
  arrive too late.

### 2. Query source

`tool_name` and `tool_input` (for example `Read{file_path}`, `Edit{file_path}`,
`Bash{command}`, `Grep{pattern,path}`), plus `tool_response`. `PostToolBatch` has the whole
batch. `transcript_path` is in every input, but leg D3 forbids reading it (decision 4c), so
the assistant's text is off-limits under the current policy.

### 3. Channel

**`additionalContext` on `PostToolBatch`** (or `PostToolUse`). "Claude Code wraps the
string in a system reminder and inserts it into the conversation at the point where the
hook fired … PreToolUse, PostToolUse, PostToolUseFailure, and PostToolBatch: next to the
tool result" (hooks, "Add context for Claude").

- **Persisted:** "Claude Code saves the injected text in the session transcript. For
  mid-session events like `PostToolUse` or `UserPromptSubmit`, when you resume … Claude Code
  replays the saved text rather than re-running the hook" [V hooks; CC F7 observed it for
  UserPromptSubmit].
- **Cache-safe:** "Claude Code never invalidates the cache for a plugin's skills, commands,
  agents, hooks … It appends their content after the existing conversation"
  [V prompt-caching, "Plugin components that keep the cache"].
- **Cap:** 10,000 chars per string (CC F6).

Ledger: the `${CLAUDE_PLUGIN_DATA}` store (D3) is the only ledger. An activity delivery
writes its ids to the store **before** it emits (D4, at-most-once). It needs a new
`activity_ids` list next to `live_ids` and `tool_ids`, which also gives a separate budget.
Concurrency: `PostToolBatch` runs once per batch, which removes the parallel-writer case.
D3's `flock` still applies. Subagents: D6 says main thread only (`agent_id` present ⇒
pass-through), which is consistent.

### 4. Cost and latency

Every hook is a fresh process. Each trigger pays Python startup, ct discovery (≤ 3 s), the
capability probe (≤ 3 s) and the match (≤ 3 s), unless the probe result is persisted. D8
chose not to persist it ("YAGNI"); it would have to be persisted for this path. There is no
cheap cross-process prefetch. An `async: true` PreToolUse could start the match and write
the result to the store for `PostToolBatch` to pick up [U, extra moving parts]. The
command-hook default timeout is 600 s (hooks, "timeout"), so the plugin must set its own
short `timeout`.

### 5. Verdict: **feasible with caveats**

The caveats: process-spawn cost per batch, `PostToolBatch` behavior in subagents [U],
whether async delivery reaches the next model request [U], and an extra persisted
capability or discovery cache so that each batch costs one CT call, not three spawns.

*Minimal sketch:* register `PostToolBatch` (with the main-thread filter). Build one query
from the batch's tool inputs and skip if the activity key is unchanged (the store keeps
the last keys). Run the match, then write `activity_ids` and `order` under the lock, and
emit `{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":block}}`.

---

## Host 5: OpenClaw 2026.10.3

### 1. Triggers

- **[V] `before_prompt_build` fires once per run attempt, not per model call.** It is
  dispatched from `prepareEmbeddedAttemptPromptAssembly`
  (`dist/builtin-openclaw-C66TYl5I.mjs:6694-6729`), before prompt submission. The embedded
  agent's internal tool loop then makes its model calls through `transformContext` and
  `streamFn` wrappers that are not plugin hooks (`:5985-6052`, `:6254-6290`). The docs
  describe the hook as receiving "the prepared prompt and session messages" for the
  admitted request (`docs/plugins/hooks/prompt-and-session.md:36-48`). A settled
  tool-finalization attempt skips it (`preserveExactPrompt`, `:6701-6723`).
- **[V]** `ctx.trigger` ∈ `cron | heartbeat | user` (OClaw F6). It is "a run trigger, not
  an origin classification" (`prompt-and-session.md:186-188`). Cron and heartbeat runs are
  themselves autonomous work. `heartbeat_prompt_contribution` exists for heartbeat turns
  (`:64-66`).
- **[V] Per-model-call hooks are observe-only:** `llm_input`/`llm_output`, and
  `model_call_started`/`model_call_ended` with "No prompt or response content"
  (`docs/plugins/hooks/reference.md:140`). `llm_input` did not fire on one-shot `--local`
  runs (OClaw leg results).
- **[V] Tool hooks:** `before_tool_call` (gate or approve, with a `matcher` on canonical
  ids), `after_tool_call` (observe) and `tool_result_persist` (synchronous rewrite before
  transcript write) (`reference.md:39`, `:149-151`; `tool-policy.md:274-281`).
- **[V] Tool-result middleware** runs for **every** tool result in the embedded runner:
  `agent.on("tool_result", async …)` → `runner.applyToolResultMiddleware({toolCallId,
  toolName, args, cwd, isError, result})`, and the returned `content` becomes the tool
  result handed to the agent loop (`builtin-openclaw-C66TYl5I.mjs:17261-17306`). The runner
  awaits each handler with no host timeout (`dist/tool-result-middleware-Uy2oP_I9.mjs:251-264`).
  Embedded (`runtime: "openclaw"`) only. Codex/Copilot are degraded (OClaw leg matrix).
- **[V] `enqueueNextTurnInjection`** is drained "before prompt hooks" of the **next prompt
  build** (`prompt-and-session.md:316-329`), so it is not a mid-run channel. A run's queued
  child results are leased once per attempt (`builtin-openclaw:6732-6748`).
- **[V] Subagents** have their own session with a `subagent:` key segment (OClaw F15), and
  middleware ctx carries `sessionKey` (OClaw F12).

### 2. Query source

The middleware event has `toolName`, `args` and `cwd`, plus `result.content`. No assistant
text is available mid-run to plugins (the snapshots are prompt-hook only).

### 3. Channel

**Tool-result middleware augmentation.** Return `{result}` with one extra text block (or
text appended to the first block; blocks are capped at 100,000 chars, OClaw F12). The
agent loop records the returned content as the tool result [V `:17300-17305`]. That the
transcript persists that exact content is [U]: it is likely, because `tool_result_persist`
receives the tool-result message the loop built, but no live run has exercised a rewrite
yet (OClaw leg "Not exercised live: N3 middleware rewrite"). It is append-only after the
prior request, so it is cache-safe by construction.

Ledger: the next `before_prompt_build` scans `toolResult` content in `event.messages`
(OClaw leg deviation 1), so activity markers are ledgered at the next turn. **Within a
run** there is no prompt hook between tool calls, so the middleware must keep an
in-process per-`sessionKey#runId` ledger, seeded from the last `before_prompt_build` scan
and updated by each delivery. This mirrors the Hermes `LEDGER_CACHE`.

### 4. Cost and latency

Middleware is awaited with no host timeout, so the plugin must bound itself (3 s).
`before_tool_call` sees args before execution, which makes it the prefetch point. Plugins
must declare `contracts.agentToolResultMiddleware` (already in the manifest).

### 5. Verdict: **feasible with caveats** (embedded runtime only)

The caveats: persistence of rewritten content is [U] until a live capture, there is no
per-step trigger (per tool call only), Codex/Copilot are unsupported, and the in-run
ledger is process-local. A gateway restart mid-run loses it, so the path fails closed.

*Minimal sketch:* `before_tool_call` (observe and allow) computes the key and prefetches.
The middleware awaits (bounded), post-filters against the run ledger, appends a marked
block to non-CT tool results, and records the ids. Cron and heartbeat runs follow an open
decision (see below).

---

## Cross-host synthesis

### Parity table

| | Hermes | DSH 0.2.0-rc.2 | OpenCode 1.18.35 | Claude Code 2.1.301 | OpenClaw 2026.10.3 |
|---|---|---|---|---|---|
| Per-step trigger that can deliver | no (`pre_api_request` observe-only) [V] | **yes**: `agent/pre-step` step ≥ 2 [V] | no (`messages.transform` wire-only) [V] | **yes**: `PostToolBatch` [V] | no (prompt hook once per attempt) [V] |
| Per-tool trigger that can deliver | `transform_tool_result` [V] | `tools/post-execute` `additionalContexts` [V] | `tool.execute.after` [V] | `PostToolUse` `additionalContext` [V] | tool-result middleware [V] |
| Pre-tool hook (prefetch point) | `pre_tool_call` [V] | `tools/pre-execute` [V] | `tool.execute.before` [V] | `PreToolUse` (separate process) [V] | `before_tool_call` [V] |
| Recommended channel | tool-result string append | pre-step `decision.messages` (user/message) | tool `output` append | `PostToolBatch` additionalContext (system reminder) | middleware content append |
| Persisted, replayed on resume | yes [V] | yes [V] | yes [V] | yes [V doc] | likely [U] |
| Cache-safe (append-only) | yes | yes | yes | yes [V doc] | yes (by construction) |
| Ledger sees it next trigger | history scan, tool role [V] | `deriveMessages` [V] | LD5 tool `state.output` scan [V] | plugin-data store (write first) | `event.messages` toolResult scan [V] |
| In-step ledger needs | `LEDGER_CACHE` + lock (8 threads) | none (log is the truth) | in-process `delivered` set | store lock (one writer per batch) | in-process run ledger |
| Fires in subagents | yes, child session [V/U] | yes, child agent [V/U] | yes, child session [V] | yes, with `agent_id` [V] | yes, `subagent:` key [V] |
| Hot-path cost | sync thread, 3 s | awaited pre-step, 3 s | awaited hook, 3 s | process spawn per batch | awaited, no host timeout |
| **Verdict** | feasible w/ caveats | **feasible** | feasible w/ caveats | feasible w/ caveats | feasible w/ caveats (embedded only) |

No host is "not feasible" at the pin. Every host has a persisted, append-only channel
next to tool results, and none of them needs the system prompt.

### Recommended common contract

1. **Trigger class: "after a batch of agent actions, before the next model call."**
   - Hosts with a per-step hook use it: DSH pre-step at step ≥ 2, Claude Code
     `PostToolBatch`.
   - Hosts without one use the per-tool post hook with a **per-step coalescing rule**: at
     most one CT call in flight per session, and at most one activity delivery per model
     step (Hermes and OpenClaw `turn_id`/`runId` plus step counter; OpenCode `messageID`
     of the assistant message).
   - Never on CT's own tools: the N3 dedup rule (m4) stays as is.
2. **Query construction rule (deterministic, no semantics; rule 8):**
   - The query is a short **activity line** made only of the action's target:
     `"<verb> <target>"`.
   - `<verb>` is from a fixed map (read, edit, write, run, search).
   - `<target>` is the file path relative to the workspace, the first 200 chars of a shell
     command, or a search pattern plus path.
   - Join the batch's distinct lines with newlines and cap the query at **300 chars** (far
     below the 2000 used for user turns).
   - **Never** include tool output, diffs, assistant text or reasoning. They are long and
     mixed, so the gate stays closed on them, and they would leak arbitrary content into
     CT argv.
   - Sanitize with the existing `stripForged`.
   - The integration does not expand, summarize or rank: it only renders the action.
3. **Rate-limiting rule: query only on activity-key change.**
   - Activity key = the set of `(verb class, target path directory + basename | command
     head token)` for the batch.
   - Skip the call when every element is in a per-session recent-keys set (LRU, about 32
     keys).
   - Plus a floor of at most **one CT call per model step**, and the existing breaker
     (3 failures ⇒ 300 s pause), shared with the live path.
   - "Every N tool calls" was rejected because it fires on noise and misses topic changes.
     "On file-path change" alone misses `run`/`search` work. The key-change rule covers
     both.
4. **Delivery budget (rule 6):** an activity delivery carries **at most 1 fact and 600
   chars**. It is counted separately from user-turn live deliveries (its own marker or
   source kind). The 12-per-session cap is being removed in the parallel PR. Whether
   activity deliveries get any session or turn ceiling is an open decision (below).
5. **Channel per host:**
   - Hermes: `transform_tool_result` append.
   - DSH: pre-step `decision.messages` with `source.kind: curated-thoughts-wisdom-activity`.
   - OpenCode: `tool.execute.after` output append.
   - Claude Code: `PostToolBatch` `additionalContext`.
   - OpenClaw: tool-result middleware append.

   All render the same block with heading `## Curated Thoughts — relevant to this step`
   and the standard `<!-- ct-fact:<id> -->` markers.
6. **Exactly-once:** the same ledger and post-filter as annex A. Activity ids join the
   ledger at once (in-step cache or store write before emit). Corrections may ride an
   activity delivery only when they supersede a ledgered id, same as live.
7. **Latency:** prefetch at the pre-tool hook where the host allows it (all but Claude
   Code). The total wall budget per step stays 3 s. On timeout, deliver nothing and never
   block the step past the budget.

### What must change in `packages/ct-wisdom-core` and Hermes

- **ct-wisdom-core** (TS: DSH, OpenCode, OpenClaw):
  - a new `onActivity(host, session, activity: ActivityItem[], breaker)` entry next to
    `onUserTurn`;
  - `buildActivityQuery(items)`, which holds the verb map, the 300-char cap and
    `stripForged`;
  - an `ActivityKeyTracker` (LRU per session);
  - new constants `ACTIVITY_MAX_PER_STEP = 1`, `ACTIVITY_MAX_BLOCK_CHARS = 600` and
    `ACTIVITY_QUERY_CHARS = 300`;
  - `Ledger.activityDeliveredCount`;
  - a `renderBlock` variant with the activity heading.

  `HostAdapter` gains `deliverActivity` (or a `channel` argument on `deliver`) and
  `noteActivityDelivered`. The annex A pseudocode gains an `on activity(...)` section, and
  that section is the normative change.
- **Hermes** (the Python reference, vendored byte-identical into Claude Code per CC D1, so
  every change ships to both):
  - `ct_wisdom_live.py` gains `on_pre_tool_call` (key plus prefetch thread) and an
    activity branch in the `transform_tool_result` callback, composed with
    `ct_tool_dedup`;
  - `LEDGER_CACHE` gains a lock;
  - `ct_ledger` gains an activity-marker count;
  - `__init__.py` registers `pre_tool_call`.

  This makes a Hermes 0.5.0 and a matching claude-code bump. Claude Code also needs a
  persisted discovery and capability cache in the store, and a `PostToolBatch` entry in
  `hooks.json`.
- **Test obligations (INTENT "How changes are made" 3):** the randomized exactly-once
  test gains activity events interleaved with user turns, recalls, compaction and
  restore. Plus a self-trigger guard: our own activity block is never part of the next
  activity query or user-turn query.

### Risks

1. **Latency on the tool hot path** (all hosts). 3 s per triggering step is visible. Key-
   change rate limiting and prefetch are the mitigation. Claude Code's per-batch process
   spawn is the worst case.
2. **Query sparsity.** Activity lines are terse ("edit src/billing/invoice.py"), and CT's
   gate is calibrated on user-message text. It may stay closed or misfire, which is the
   curated-thoughts#271 class again. This is CT's to tune (rule 8), so the feature may be
   structurally present and behaviorally quiet at first.
3. **Noise and cost from chatty agents.** Agents that grep repeatedly or loop over many
   files generate many distinct keys. The per-step floor bounds the call rate, not the
   relevance.
4. **Concurrency.**
   - Hermes runs tools on 8 threads: an unlocked cache would race to a duplicate.
   - OpenCode parallel `tool.execute.after`.
   - Claude Code parallel `PostToolUse` (`PostToolBatch` avoids it).
5. **Subagent divergence.** Autonomous work concentrates in subagents (OpenCode task, CC
   Explore, DSH subagent tool), and today the policies differ by host. CC and OpenCode
   exclude children, DSH doesn't check.
6. **OpenClaw persistence [U]** and the in-run ledger being process-local.
7. **Privacy and argv.** File paths and commands go into `ct` argv and CT's logs. They are
   less sensitive than tool output, but they still contain secrets in rare commands
   (`curl -H 'Authorization: …'`). A redaction rule or a "commands off" default needs a
   decision.
8. **DSH extra step.** Using `additionalContexts` instead of pre-step could extend a
   concluded turn by one model call (`runtime-types.d.ts:371-380`). The contract avoids
   it by using pre-step.

### Open decisions for the user (plain language)

1. **How often may the agent be interrupted with a fact while it works?** The proposal is
   at most one fact per model step, and only when the agent moves to a new file, command
   or search. Do you also want a ceiling per user message (for example, at most 3 during
   one long task), or none?
2. **What may we send to CT about the agent's work?** The proposal is file paths, search
   patterns and the start of shell commands, but never file contents, command output or
   the agent's own words. Is sending shell commands OK, or should commands be left out (or
   reduced to just the program name) in case one holds a secret?
3. **Should facts reach subagents?** Much of a long autonomous task runs inside helper
   agents. Today Claude Code and OpenCode never deliver there, and DSH does. Pick one rule
   for all hosts: (a) main agent only, (b) helpers too, each with its own once-only
   record, or (c) helpers only for activity, not for user messages.
4. **Cron and heartbeat runs (OpenClaw), and scheduled prompts (Claude Code).** These are
   autonomous by nature. Should they get activity delivery like any other task?
5. **How small is small?** Is one fact of up to 600 characters per delivery the right size
   for mid-task facts, compared with two facts and 1200 characters on a user message?
6. **Rollout order.** The suggestion is DSH first (cleanest channel, already proven), then
   Hermes (reference), Claude Code, OpenCode, and OpenClaw last (needs a live capture of a
   rewritten tool result).
7. **Ask CT for an activity mode first, or ship on today's `wisdom match`?** See below.
   Shipping first gives real activity queries to calibrate on, but the facts may rarely
   arrive until CT tunes the gate.

### CT-side support that would help (a recommendation only; rule 8 keeps relevance in CT)

- **An activity query mode** for `ct wisdom match`, for example `--kind activity` or
  structured `--path <p>` / `--command <c>` / `--pattern <s>` arguments. With it, CT can:
  - use an embedding instruction and floor calibrated for terse action text;
  - map paths to the facts whose source documents mention those modules or directories
    (the two-stage source-chunk search of curated-thoughts#271 suits this);
  - decide relevance itself instead of the integration composing prose.
- **A fast path.** Each match is a process spawn plus, with external embeddings, a network
  embed call. A `wisdom_match` tool on the already-running MCP sidecar, or a warm-daemon
  mode, would make per-step calls affordable. It matters most on Claude Code, where every
  hook is a new process.
- **A batch form.** Accept several activity lines in one call and return at most `--max`
  facts across them, so one step costs one call.
- **Echo the gate's decision cheaply** (already partly there with `score`): no plugin-side
  use, but it helps CT calibrate activity floors from real logs.

## Items the spec must close (Step-0 targets for the plan)

| # | Item | How |
|---|---|---|
| A1 | Claude Code `PostToolBatch` fires inside subagents, and with which `agent_id` | live isolated run (CC leg harness) |
| A2 | Claude Code async-hook "next conversation turn": the next model request or the next user turn | live run |
| A3 | OpenClaw middleware-rewritten content persisted byte-identically in the transcript and replayed | `--raw-stream` / proxy capture, as for AC 9 |
| A4 | Hermes child-agent tool hooks carry the child `session_id` on every dispatch path | read `agent/tool_executor.py` dispatch sites |
| A5 | DSH root-registered listeners receive child-agent `pre-step` / `post-execute` | stub-host contract test |
| A6 | Real-gate behavior on activity lines (does `edit src/x.py` ever open at the 0.64 floor?) | extend PR #47's opt-in real-gate e2e with activity queries |
| A7 | OpenCode MCP tool path: augmentation after the `content[]` join keeps markers on line ≥ 2 without breaking the LD2 line-1 envelope parse | unit test plus host contract |

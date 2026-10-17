# Intuitive Wisdom: autonomous-work delivery for OpenCode — design

**Date:** 2026-10-17 · **Status:** Approved for implementation (user decisions binding; autonomous
brainstorm, no open questions) · **Branch:** `feat/opencode-autonomous-work-wisdom` · **Base:** `origin/main` @ `9ad2653`
**Release:** opencode 0.3.1 → 0.4.0 (third leg, after Hermes 0.6.8 and DeepSeek Harness 0.6.0)
**Builds on:** the [Step-0 investigation](../investigations/2026-10-16-autonomous-work-trigger-step0-investigation.md)
(OpenCode section, "Recommended common contract", "A6 results"); the DSH leg
[`2026-10-16-dsh-autonomous-work-wisdom-design.md`](2026-10-16-dsh-autonomous-work-wisdom-design.md), the closest sibling,
including its review and final-review amendments; the Hermes reference
[`2026-10-16-hermes-autonomous-work-wisdom-design.md`](2026-10-16-hermes-autonomous-work-wisdom-design.md) and its privacy
amendments 1–7; the OpenCode live leg
[`2026-10-16-opencode-wisdom-parity-leg-design.md`](2026-10-16-opencode-wisdom-parity-leg-design.md) (host facts H1–H8,
LD1–LD12); and verbose mode [`2026-10-16-wisdom-verbose-mode-design.md`](2026-10-16-wisdom-verbose-mode-design.md).

Tags: **[V]** verified in this session by reading the pinned `opencode-darwin-x64@1.18.35` binary (its bundled JS,
read as data with a scratchpad script, never executed for this) or the `@opencode-ai/plugin@1.18.35` /
`@opencode-ai/sdk@1.18.35` type files. **[V run]** verified by the real-binary host-contract test in this PR.
**[U]** unverified or inferred, and carried as a limitation. Byte offsets name the position in the bundle's `strings`
dump that the 2026-10-16 legs already used.

## Problem

OpenCode asks CT for facts once per user message (`chat.message`). An agent that then works on its own (reads files,
runs commands, edits code, often in a `task` subagent) never gets a fact keyed to what it is doing. INTENT's third step,
"During autonomous work", asks for that. Hermes and DSH ship it. This spec brings OpenCode to the same behavior on the
shared `ct-wisdom-core` activity API, and it re-implements none of that API's rules.

## User decisions (binding)

1. **Rate:** one CT call per model step, and only when the activity key changes. No per-message ceiling and no session cap.
2. **Query:** the bare target from the shared core builder only (`buildActivity` / `activityQuery`). The privacy rules
   are never re-implemented. All 290 vectors in `tests/fixtures/activity_targets.json` and the golden
   `tests/fixtures/activity_blocks.json` must pass through **this binding** (OpenCode tool names and arguments).
3. **Size:** 1 fact, ≤ 600 chars.
4. **Subagents included.** This changes OpenCode's parent-only policy (LD7) **for activity delivery only**. Per-message
   delivery stays parent-only (below: "Why per-message stays parent-only").
5. **Scheduled and background runs included.**
6. **CT's own tools never trigger.**
7. **Known limit:** concept rules reached only through a path need CT activity mode
   ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)).
8. From the DSH final review: **the query starts only after the call is approved.** Verify whether OpenCode exposes an
   approval result at the pin; otherwise document. **Delivery never starts a plan.** **Release the key on post-start
   failures; keep it on no_match / deduped.**

## Pinned host facts (OpenCode 1.18.35)

### Hooks and their order

- **[V] Builtin tools** (`SessionTools.resolve`, bundle offset ≈8233432): `execute(b,w)` runs
  `trigger("tool.execute.before",{tool,sessionID,callID},{args:b})`, then `k.execute(b,H)`, then
  `trigger("tool.execute.after",{tool,sessionID,callID,args:b},V)`, and returns `V`. `V` is `{...a, attachments}`, the
  tool's `{title, output, metadata}`.
- **[V] Builtin output is truncated inside `k.execute`, before the after hook.** The tool wrapper (`Tool.define`, ≈8467968)
  calls `Truncate.output(B.output)` unless `metadata.truncated` is already set, and returns the truncated output. A block
  appended in `tool.execute.after` is never cut by the host's truncation.
- **[V] MCP tools** (≈8239660): `before`, then `x.ask({permission:<tool>,…})`, then `callTool`, then
  `after(…, m)` with `m` the MCP `CallToolResult`. After the hook the host joins the `text` items (plus resource text)
  with `"\n"`, runs `Truncate.output(joined)` with the default direction **`head`** (`MAX_LINES` 2000,
  `MAX_BYTES` 51200; the user's `tool_output.max_lines/max_bytes` config overrides both), and persists that as
  `state.output` (live-leg H5).
- **[V] Experimental code mode** (`CodeMode.invokeChildTool`, ≈29081734) fires the same hooks for MCP tools that a
  script calls, with `callID` `"<parent callID>/<n>"`. Their results feed a script, not the model directly.
- **[V] Subtasks** (`handleSubtask`, ≈8247718) fire `before`/`after` for the `task` tool in the parent. The child
  session's own tool calls go through `SessionTools.resolve` with the child `sessionID` (live-leg H7).
- **[V] The hook surface triggered by the binary** is: `chat.message`, `chat.params`, `chat.headers`,
  `command.execute.before`, `tool.execute.before` (7 call sites), `tool.execute.after` (7), `shell.env`,
  `tool.definition`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`,
  `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete`, plus
  `file.open` and `tab.new`. There is no per-step hook that can deliver (the investigation's verdict).

### Approval (decision 8)

- **[V] No approval result reaches a plugin's tool hooks.** `permission.ask` is declared in the plugin types
  (`index.d.ts:225`) but **never triggered** by the 1.18.35 binary: the trigger list above has no `permission.ask`.
- **[V] Every permission ask runs after `tool.execute.before`.** Builtin tools ask inside `k.execute` through
  `ctx.ask` (for example `read`, `grep` and `glob` call `t.ask(...)` before they touch the disk). MCP tools ask between
  `before` and `callTool`. The `ask` effect is `h.ask(...).pipe(n.orDie)`, so a refused ask aborts `execute`, and
  **`tool.execute.after` never runs for a refused call.**
- **[V] Refusals are common.** The default ruleset (≈8482966) asks for `read` of `*.env` and `*.env.*` (not
  `*.env.example`), for `external_directory` and for `doom_loop`. `opencode run` without `--auto`
  (`--yolo`, `--dangerously-skip-permissions`) **auto-rejects every ask** ("permission requested: …; auto-rejecting",
  `reply: "reject"`). So a prefetch at `tool.execute.before`, the investigation's sketch, would send `.env.local` to CT
  for a read the host then refused.
- **Consequence:** `tool.execute.after` is the first point where the plugin knows a call was approved, so the CT query
  starts there.

### Step identity

- **[V]** The hook inputs carry no assistant-message or step id (`index.d.ts:235-258`): `before` has
  `{tool, sessionID, callID}`, and `after` adds `args`.
- **[V]** The session processor writes each tool part to storage as soon as the call streams in: `tool-input-start`
  creates it as pending, and `tool-call` sets it running with `{tool, state.input}` (≈8205402; the same handler reads
  the parts back with `Me.parts(assistantMessage.id)`). The part's `messageID` is the assistant message of the model step,
  and its `callID` is the hook's `callID`. **[V run]** the host-contract test finds the part with the hook's `callID` in
  `GET /session/{id}/message` while `tool.execute.after` runs.
- **Consequence:** the step id is the `messageID` of the tool part whose `callID` matches, read from the history fetch
  the ledger needs anyway. This is the DSH rule (the step id is the assistant message id), and it gives a real "one CT
  call per model step" instead of the investigation's in-flight approximation.

### Tool names and arguments at the pin

| Tool | Schema [V] | Verb | Args we read |
|---|---|---|---|
| `read` | `{filePath, offset?, limit?}` (≈8329450) | read | `filePath` |
| `write` | `{content, filePath}` (≈8354523) | write | `filePath` (never `content`) |
| `edit` | `{filePath, oldString, newString, replaceAll?}` (≈8315439) | edit | `filePath` (never the strings) |
| `grep` | `{pattern, path?, include?}` (≈8326617) | search | `pattern`, `path` (never `include`) |
| `glob` | `{pattern, path?}` (≈8324635) | search | `pattern`, `path` |
| `bash` | `{command, timeout?, workdir?}` (≈8288561; shell tool id `bash`) | run | `command` (never `workdir`) |

Every other tool gives no activity: `apply_patch` (`{patchText}`, where paths are mixed with content), `task`,
`webfetch`, `websearch`, `todowrite`, `skill`, `lsp`, `question`, `plan_exit`, MCP tools and the MCP resource tools.
MCP tools are named `<server>_<tool>` (H6), so CT's are `curated-thoughts_curated_*`.

### Working directory

- **[V]** Tools resolve relative paths against the instance context directory: `write` uses
  `isAbsolute(filePath) ? filePath : join(ctx.directory, filePath)`, and `grep`/`glob` default `path` to it.
- **[V]** The SDK `Session` type has `directory: string` (`sdk/dist/gen/types.gen.d.ts:465-468`), and
  `client.session.get` returns it. The adapter already makes that call once per session for LD7.
- **Rule:** the activity cwd is the session's `directory` when it is a non-empty absolute path, and otherwise absent.
  Without a cwd, the core sends no path. `process.cwd()` and the plugin's `input.directory` are never used.
  **[V run]** the contract test shows that an absolute path under the project reaches CT as the project-relative path.

## Design

### Overview

```
tool.execute.before (every tool call; no I/O except the session lookup)
  ├─ empty sessionID/callID → nothing         ├─ code-mode child call ("…/n") → nothing
  ├─ CT tool → nothing (decision 6)           └─ buildActivity(opencodeSpec(tool,args), session dir, env)
  └─ no safe activity → nothing                    → plans[session#callID] = activity  (LRU 256)

tool.execute.after
  ├─ CT recall tool → N3 dedup (unchanged) + remember its ids as unpersisted
  ├─ no plan for this call → nothing (delivery never plans)
  ├─ a query already in flight for this session → nothing (coalesced; key stays unseen)
  ├─ key recently seen → nothing        ├─ result cannot carry a block → nothing
  ├─ fetch own history → step id = messageID of the tool part with this callID (none → no_step)
  ├─ step already started a query → nothing
  ├─ startActivity(gate, --exclude from the fresh ledger, `ct wisdom match --max 1 -- <target>`)
  ├─ admit(session, step, key); await within the hook's ONE 3 s deadline
  │    (fetches included); on expiry abort → the ct child is killed
  ├─ rebuild the view from memory (no second fetch) → finishActivityOutcome
  ├─ retry? → releaseKey(session, key) (this step stays used)
  └─ block → append "\n\n" + block to output.output (builtin) or to the last content text item (MCP)
```

### Plan at `before`, start at `after` (decision 8)

- **Plan** (`tool.execute.before`): build the activity from the call's arguments with the shared builder and store it
  under `sessionID#callID`, in a bounded LRU of 256 entries, so plans of refused calls (which never reach `after`) are
  evicted. Planning sends nothing and never changes `args`.
- **Start** (`tool.execute.after`): the call was approved, because a refused call never reaches this hook (see
  "Approval"). Only a call with a plan from `before` can start, so the delivery hook never builds an activity itself
  ("delivery never starts a plan"; a call without a plan is `no_plan`). All seven `before` call sites are paired with
  an `after` [V], so `no_plan` only means an evicted plan.
- **Deliver:** in the same hook, into the triggering call's own result (Hermes: "Delivery always rides the tool result
  of the call that triggered the query").
- **Cost:** no overlap with tool execution. The CT latency (measured 0.44–2.07 s, p95 1.22 s) is added to the
  triggering call's result, capped at 3 s, and at most once per step and only on a key change. A prefetch would hide
  this cost, but it would send the targets of refused calls, which decision 8 forbids.

### Activity binding

```ts
opencodeActivitySpec(tool, args): ActivitySpec | null  // the table above
isOpenCodeCtTool(name): boolean   // core isCtTool(name) || name.includes('_curated_') || name.startsWith('curated_')
```

The spec is the only OpenCode code that touches tool arguments. Everything else (paths, project roots, user names,
commands, search patterns, caps, the self-trigger guard, the key, the label and the query) is
`buildActivity` / `activityQuery` from the core. `isOpenCodeCtTool` widens the core check for OpenCode's single `_`
server separator: a CT server registered under another name (`ct_curated_recall_context`) still never triggers. A
non-CT tool that the wider check also catches only loses its trigger, and nothing is sent.

### Rate rule (decision 1)

The shared `ActivityTracker`, keyed by session id, with the **step id = assistant message id** of the call's tool part:

- `peek(session, '', key) === 'seen_key'` → skip, before any I/O (the key LRU has 32 entries).
- At most **one query in flight per session**: a second approved call of the same step whose `after` runs while the
  first is still querying is coalesced. Its key is not admitted, so a later step can trigger on it.
- `peek(session, step, key)` after the history read: `step_used` → skip. `admit` only after `startActivity`
  succeeded, so a refused start records nothing.
- `releaseKey(session, key)` when the started query got no genuine answer: `budget`, a CT failure, or a gate that
  closed by the finish (`outcome.retry`). The **step stays used**, so the key can be retried in a later step but
  never by a second query in this one (review of PR #66). `zero_hits` (no_match, deduped, gate_uncalibrated) keeps
  the key, because CT answered.
- The in-flight marker is held until the `ct` child has exited or been killed, so a dying query never overlaps a new
  one.

### Channel: the tool output, marker first

The block is the core's `renderActivityBlock` (heading `## Curated Thoughts — relevant to this step`, the
`_for: <line>_` label, then marker, title, provenance and text, ≤ 600 chars). It is byte-identical to Hermes's
renderer (the golden fixture).

- **Builtin** (`typeof output.output === 'string'`): `output.output = output.output === '' ? block : output.output + '\n\n' + block`.
  This is never truncated by the host [V].
- **MCP** (`Array.isArray(output.content)`): append `'\n\n' + block` to the **last** `text` item, so the block is the
  tail of the joined output, or push a `text` item when there is none. Rewriting `content[].text` is the same mechanism
  N3 uses (LD2). **Fit guard:** deliver only when the joined text plus a worst-case block (`BLOCK_LINES_WORST` = 8
  lines, 2402 bytes) stays under the host's default truncation limits (2000 lines, 51 200 bytes). A fact text with
  more newlines can only push its own tail past the cut; the marker comes first. Otherwise the head-direction truncation
  could cut the tail. This check runs **before** the query starts (class `unsupported_result`, nothing sent).
- Any other shape → `unsupported_result`, before the start.
- CT tools are never activity carriers, so a block never lands next to a recall envelope's line 1. Investigation
  target A7 is closed by construction.
- The rewritten output is persisted once as the tool part's `state.output` (H5 for MCP; the builtin `V` is the
  returned result), enters context after the cached prefix (rule 2) and replays on `--continue` **[V run]**.

### Ledger and exactly once (rule 1)

The activity ledger is **what the session's own agent can see**:

`scan(own persisted history: text parts and completed tool state.output)` ∪ `carry[session]` (compaction
carry-forward) ∪ `memo[session].ids` (bootstrap) ∪ `delivered[session]` (user-turn, process) ∪
`unpersisted[session]`.

- **`unpersisted`** holds ids this process placed in a tool result that may not be persisted yet: activity
  deliveries, and the ids of a CT recall envelope N3 just rewrote. Parallel calls of one step finish before their
  parts are persisted, so without it a parallel recall of fact X and an activity delivery of X could both show it.
  Each entry remembers its tool call. A scan of the session's own history drops it when any of these holds:
  - the id is shown (the history holds it);
  - the call's tool part is gone (`/undo`, revert);
  - the part is final (completed or error) without the marker (an aborted step);
  - 60 s have passed (`UNPERSISTED_TTL_MS`; a part that never lands must not block the fact for the session).

  A running part keeps it (review of PR #66).
- `buildLedger` adds `unpersisted` for **every** view (user turn, N3, activity), so a queued user message whose
  `chat.message` runs while a tool result is still in flight cannot redeliver an activity fact.
- **One fetch per triggering call** (review of PR #66): the history is read once, before the query. After it, the
  view is rebuilt from memory (`refresh`). That is enough, because every id that can join the context while the
  query runs is recorded in memory first:
  - a parallel CT recall's ids and another activity block land in `unpersisted`;
  - a user-turn delivery lands in `delivered`.

  The N3 turn cache is deliberately not merged in. For a child it unions the parent's history (LD7), which the child
  cannot see, and every id it gains within a step is already in `unpersisted`.
- The core `finishActivityOutcome` re-gates on that ledger, selects, merges the id into the N3 turn cache (so a CT
  recall later in the turn stubs it) and reports to verbose mode. It never calls `noteDelivered` (DSH review).
- **At most once:** the id joins `unpersisted` before the block is placed, and nothing can make the host drop a block
  placed in a hook output. If the process dies first, the fact is lost, never shown twice.

**Why own history and not child ∪ parent.** LD7 dedups a child's N3 against child ∪ parent history. For activity
delivery that would keep a child from ever getting a fact its parent saw, although the child cannot see the parent's
context (the `task` tool gives it only a prompt). INTENT rule 1 is about the context the agent sees, and DSH and
Hermes both give each child its own ledger. The activity view therefore scans the session's own rows. The N3 view for
children is unchanged.

### Subagents (decision 4) and scheduled runs (decision 5)

- Activity delivery runs in **any session whose kind is known** (parent or child, from `client.session.get`). A failed
  lookup still means "unknown": no delivery (fail closed, LD7).
- **Why per-message stays parent-only:** the child's only user message is the `task` prompt the parent model wrote.
  Delivering on it would key a CT query to the parent model's paraphrase, not to a person's words (LD8's
  "genuine user text"). The child's autonomous work is exactly what activity delivery covers.
- Each session has its own key tracker, step slots, breaker (`breakerFor(sessionID)`, the same instance the user-turn
  path uses for that session, rule 4) and ledger.
- `opencode run`, `--continue` and any scheduled or scripted invocation go through the same hooks. Nothing checks how
  a session started. OpenCode has no scheduler of its own; a cron job that calls `opencode run` is just a session.

### Gates, budget, breaker (rule 4)

- The core gates through `activityHost(adapter)`: `Object.create(adapter)` overriding only `deliveryEnabled`
  (session kind known), `restored` (false, LD10), `rebuildLedger` (the activity view), `deliver` and `noteDelivered`
  (no-ops). The two methods that assign adapter fields (`wisdomMatch`'s capability latch and probe cache,
  `resetDiscoveryAndProbeCaches`) are bound to the adapter, so a latch set through the host is the adapter's.
- `startActivity` checks the capability latch and the shared per-session breaker, takes `--exclude` from the fresh
  ledger (newest first, ≤ 256), and runs `ct wisdom match --json --max 1 --exclude=… -- <bare target>` through the
  adapter's `wisdomMatch` (the same probe, discovery and spawn hygiene as live delivery).
- **Budget:** ONE deadline (`TIMEOUT_MS`, 3 s) covers the whole after-hook: the `session.get` and
  `session.messages` fetches and the query. A fetch that does not answer in time fails open (no block). The CT wait
  uses the core's `settleWithin`, now shared with DSH. On expiry it aborts the query: `wisdomMatch` passes an
  `AbortSignal` to the spawn, and the opencode binding kills the process tree. The query is reported as `budget`.
  Whether a budget miss counts toward the breaker comes from the shared core in a follow-up (0.4.1 amendment 9); an
  abort from anywhere else never counts. A match that has already settled is used even past the deadline. The `before` hook's session
  lookup is bounded the same way.
- Every hook catches everything and leaves the tool result untouched on any error.

### Fail-closed classes

| Class | Where | Verbose record |
|---|---|---|
| `empty_id`, `code_mode`, `ct_tool`, `no_activity` | before | no |
| `no_plan`, `in_flight`, `seen_key`, `step_used`, `unsupported_result` | after, before any query | no |
| `no_step` (the call's tool part is not in the history) | after | no |
| `delivery_off`, `capability_missing`, `breaker_open` | start gate | yes, once per step |
| `spawn`, `timeout_or_exit`, `parse_error`, `capability_missing` | match | yes |
| `budget` | after | yes |
| `zero_hits` → `deduped` / `no_match` / `gate_uncalibrated` | finish | yes |
| `hook_failed` | either | no |

Rate and filter checks are not recorded (Hermes and DSH: they would flood the toast without saying anything about
wisdom). Each skip is one debug line through an optional `log` dependency. The plugin has no local logger today, so
`index.ts` leaves it unwired, as in the live leg.

### Verbose mode (channel `activity`)

`reportActivity` from the core sets `channel: 'activity'`, `query` (the bare target CT received) and `activity` (the
label). The OpenCode recorder writes the JSONL line to `$XDG_DATA_HOME/opencode/log/ct-wisdom-verbose.jsonl` and shows
the toast. With verbose off nothing is written, and the tool output bytes are identical to a verbose-on run (tested).

### What does NOT change

- Per-message delivery (`chat.message`: parent-only, 2 facts / 1200 chars, bootstrap) and its part bytes.
- The v0 health block in `experimental.chat.system.transform` (rule 2).
- N3's rewrite bytes, and its child ∪ parent view.
- `packages/ct-wisdom-core`: no change. This leg is a consumer of the core API.

## Alignment with INTENT.md

- **Goal "During autonomous work":** this is that step for OpenCode. Trigger: `tool.execute.after` of an approved,
  planned call. Query: the bare target. Frequency: once per model step on a key change. Channel: the tool result.
  Those answer INTENT's four open questions for this host.
- **Rule 1 (at most once):** a marker on every fact, marker first. The ledger is the session's own persisted history
  plus process-local ids not yet persisted, fetched fresh before the start and before the finish. The N3 cache learns
  activity ids, and N3 ids join `unpersisted`.
- **Rule 2:** delivery appends to a tool result; the system prompt is untouched.
- **Rule 3:** CT filters superseded entries; a correction rides only when it supersedes an id in context (core
  `activityCandidates`).
- **Rule 4:** hooks catch everything, the tool result is unchanged on failure, the 3 s budget and the shared
  per-session breaker apply, and an unknown session kind delivers nothing.
- **Rule 5:** the block shows CT's provenance label.
- **Rule 6:** 1 fact, ≤ 600 chars per delivery; no session cap.
- **Rule 7:** `ct wisdom match` only.
- **Rule 8:** the shared builder renders the action and never scores, expands or ranks it.
- **User decisions:** 1 → "Rate rule"; 2 → "Activity binding" and the vector tests; 3 → the core constants; 4 and 5 →
  "Subagents"; 6 → `isOpenCodeCtTool`; 7 → limitations; 8 → "Plan at before, start at after" and "Rate rule".
- **Departures from INTENT:** none.
- **Where OpenCode differs from DSH and Hermes on purpose:**
  1. The query starts at `after`, not at a pre-tool hook. OpenCode exposes no approval result, and asks run after
     `before` [V].
  2. The step id is read from the persisted tool part, because the hook input has no step id.
  3. A process-local `unpersisted` set covers parallel results that are not yet persisted.
  4. MCP results get a fit guard against the host's head-direction truncation.
  5. Per-message delivery stays parent-only while activity delivery reaches children.

## Known limitations

1. **Concept rules via paths** need CT activity mode (curated-thoughts#282).
2. **No prefetch overlap:** up to 3 s (typically ≤ 1.2 s) is added to a triggering result, once per step on a key
   change.
3. **One trigger per step:** other new keys in the same step stay unseen and can trigger later.
4. **`apply_patch`** (used by some model families instead of `edit`/`write`) gives no activity.
5. **A user-lowered `tool_output.max_lines/max_bytes`** can still cut an MCP block's tail. The marker comes first, so
   the fact is either visible with its marker or not visible at all.
6. **Process-local tracker:** a new process (`--continue`) may query a key again; the ledger still dedups.
7. **[U]** Event-driven approval (`permission.asked` / `permission.replied` bus events in the `event` hook) could allow a
   safe prefetch later. It is not used: the events are asynchronous to the tool hooks.
8. **Child N3 stubs** still consult the parent's history (LD7, unchanged).

## Testing

Vitest in `integrations/opencode/tests/`:

- **Binding vectors:** every shared vector, mapped from its Hermes tool to the OpenCode call (`read_file` → `read`
  `{filePath}`, `write_file` → `write`, `patch` → `edit`, `search_files` → `grep` `{pattern, path}`, `terminal` →
  `bash` `{command}`), goes through `opencodeActivitySpec` + `buildActivity` in its temp-dir world. Query and label must
  match; `key_distinct_from` pairs keep distinct keys. The golden blocks render through the same activity used by the
  binding.
- **Binding:** the tool table, no secret argument in any line or query, CT tool names, code-mode call ids.
- **Coalescing and rate:** parallel calls of one step make one CT call; a second step with the same key makes none; a
  new key in a later step makes one; a call while a query is in flight makes none; a refused call (no `after`) never
  queries; release on budget or failure and a retry in a later step; keep on no_match.
- **Subagents:** a child session gets activity delivery (own ledger: a fact its parent holds can still arrive); a child
  never gets per-message delivery; an unknown session kind gets nothing.
- **Fail-closed:** every class in the table; hooks never throw; outputs are untouched on skip; `unsupported_result`
  sends nothing.
- **Marker hygiene:** marker before title; an activity query never contains `ct-fact:` or the heading; the
  user-turn query ignores tool outputs; activity markers are found by every later ledger build (user turn, N3,
  activity).
- **Verbose:** off → nothing written; on vs off → byte-identical tool outputs; on → one `activity` record per delivery
  with query, label and id.
- **Exactly once, randomized:** 200 seeded sessions mixing user turns (parent and child), activity steps with 1–3
  parallel calls (random tools and keys, some refused), CT recalls (N3, both carriers, sometimes parallel with
  activity), compaction and process restarts, with a CT that ignores `--exclude` half the time and times out
  sometimes. Oracle: no id is visible twice in any session's own context.

**Host contract** (`tests/host/contract.test.ts`, real 1.18.35 binary, fake provider, stub `ct`): a new test scripts
`read` of an absolute in-project path, `bash` twice with the same key, and a read of `secrets.env` that the host
auto-rejects. It asserts that the tool result sent back to the model carries the activity block once, marker first; the
`ct wisdom match --max 1` argv carries the project-relative path; the same key makes no second query; the refused call
makes no query; and the exported session's tool part persists the block.

**Live e2e** (`tests/e2e`, Docker, ZAI GLM-5.3-FLASH, a work dir with `.git`): with `CT_E2E_REAL_GATE=1` (keys passed by
name), CT 3.5.1's real gate (OpenRouter `qwen/qwen3-embedding-4b`, `ct wisdom deposit`, `scheme activate instr1`,
the DSH real-gate setup). One user message makes the agent run `pnpm test` twice, write `.env.local`, try to read
`secrets.env` (auto-rejected) and call `curated_recall_context`. The checks mirror DSH/Hermes:

1. an activity block arrives, exactly once per fact, marker first;
2. the same key neither re-queries nor re-delivers;
3. the block persists in the tool part and the session continues with `--continue` without re-delivery;
4. CT tools never trigger;
5. every query is the bare target after `--`;

plus 6, the refused call sent nothing, and verbose (JSONL `activity` records). All of it runs under the container's
throwaway HOME and brain.

**Host contract (done, 2026-10-17):** all 7 real-binary tests pass on opencode 1.18.35 (macOS). The new test confirms
the [V run] facts:
- the block appended in `tool.execute.after` reaches the model and persists in the tool part;
- the tool part with the hook's `callID` is in the history while the hook runs (step ids are found);
- the absolute in-project path reaches CT as `src/index.ts`;
- the repeated `ls` key makes no second query;
- the refused `secrets.env` read sends nothing.

One host detail: a refused ask ends `opencode run`'s loop, so the model never sees that call's error result.

**E2E (done, 2026-10-17 UTC):** `CT_E2E_REAL_GATE=1 integrations/opencode/tests/e2e/run.sh`, 41 passed, 0 failed, with CT 3.5.1's
real gate and ZAI GLM-5.3-FLASH.
- **Tool steps.** The agent made seven: `read TASK.md`, a stray read the host refused, `bash pnpm test`,
  `bash pnpm test --silent`, `write .env.local`, `curated_recall_context`, and `read secrets.env` (auto-rejected).
- **Queries and deliveries.** These gave exactly three activity queries, `TASK.md`, `pnpm test` and `.env.local`
  (absolute paths normalized to the project). Two blocks came through the real gate:
  - `pnpm test` → "pnpm is used to run this repository's test suite…";
  - `.env.local` → ".env.local holds local-only secrets."

  Each arrived once, marker first, and persisted in its tool part.
- **Continue.** `--continue` re-queried `pnpm test` in the new process (limitation 6). CT got the delivered id in
  `--exclude` and answered no_match, so there was no re-delivery.
- **Verbose.** The JSONL carried the `activity` records.
- **No leaks.** A scan of every output file found neither key.
- **Finding.** A direct real-gate probe of `secrets.env` **opens** the gate (0.71, on the `.env.local` fact). The
  investigation's before-prefetch would therefore have sent the refused call's target to CT *and* delivered a fact for
  a call the host refused. The approval rule (decision 8) is what prevents it.

## Review amendments (PR #66, high-effort review)

1. `unpersisted` entries now expire. They are tied to their tool call and dropped on abort, `/undo` or 60 s; the
   same applies to N3's recall ids. Tests: an aborted step, an undone step, an undone recall, and a never-persisted
   part after 60 s each make the fact deliverable again.
2. One 3 s deadline covers the whole after-hook, fetches included, and expiry fails open (test: a hung
   `session.messages` returns well within 2 s, untouched).
3. Budget expiry kills the `ct` child. The core gained optional abort support (`SpawnLike.signal`,
   `wisdomMatch(…, signal)`, `HostAdapter.wisdomMatch(…, signal?)`, `runActivityMatch`/`startActivity(…, signal?)`;
   an aborted match is `budget`, not a breaker failure), and the opencode spawn binding kills the tree on abort.
   `ActivityTracker.releaseKey` frees only the key, so the step stays used. The in-flight marker is held until the
   child exits. Tests: core `budget.test.ts`, the kill, the same step making no second query, a later-step retry, the
   marker held during a slow exit, and real-process kills in `test_spawn_abort.ts`.
4. One history fetch per triggering call (tested); the after-query view is rebuilt from memory (see "Ledger").
5. The fit guard uses an 8-line worst case.
6. `isOpenCodeCtTool` lowercases before its OpenCode-specific checks.
7. `settleWithin(promise, ms, onExpire?)` is exported from `ct-wisdom-core` and used by opencode and deepseek
   (deepseek 0.6.1, no behavior change).
8. `activityHost` is `Object.create(adapter)` with overrides; the latch-writing methods are bound (tested).

## 0.4.1 amendments (post-merge review of 0.4.0)

Delivery semantics are unchanged (same queries, same blocks, same once-only rule). The changes are robustness and cost:

1. **Start margin.** With ≤ `START_MARGIN_MS` (200 ms) of the budget left before the start, nothing is spawned and
   neither the key nor the step is admitted.
2. **Cheap gates first.** Session kind known, capability latch and breaker are checked before the history fetch, so a
   closed gate costs no fetch. Without a step id, such a skip is reported once per activity key.
3. **`session.get`.**
   - A failure is cached for `SESSION_FAILURE_TTL_MS` (10 s); before, every tool call asked again.
   - The plan-time wait is capped at `PLAN_LOOKUP_MS` (300 ms).
   - `deliver` reuses the plan's cached lookup and never asks again.
4. **Spawn hygiene.** The abort listener is removed on `error` as well as on `close`. An aborted spawn reports
   `aborted: true`, and the core classifies it as the new `MatchOutcome` `'aborted'`, which never counts as a breaker
   failure (the user-turn path reports it as `budget`).
5. **`activityHost`** is an explicit delegating object: every HostAdapter method calls the adapter, so nothing is
   inherited and no method can write a shadowing field.
6. **Builtin-only placement.** Only builtin tools are planned, so the MCP branches of `canCarry`/`placeBlock` were
   dead and are dropped: an output must have a string `output`.
7. **One expiry rule** for `unpersisted`: `prune` deletes, `buildLedger` only filters.
8. **One shared `isObj`** (`src/obj.ts`).
9. **Breaker parity.** The rule "a budget miss counts as one breaker failure" (Hermes, OpenClaw) moves into
   `ct-wisdom-core` in a follow-up, so that every host behaves alike. OpenCode adds no host-side version. An
   `aborted` outcome from anywhere else (a user or approval abort) never counts (tested).

Tests:
- start margin;
- each closed gate makes no fetch;
- failure TTL and the capped plan wait;
- one `session.get` per session;
- `aborted` in classify, `runActivityMatch` and `onUserTurn`;
- listener removal on close and error;
- host prototype;
- MCP-shaped outputs carry nothing;
- foreign aborts never open the breaker.

## Versioning and docs

- opencode `0.3.1 → 0.4.0` (`package.json`, `integration.yaml`), CHANGELOG, README (Intuitive Wisdom section and
  limitations), README table via `tools/ct_ci.py readme`.
- deepseek `0.6.0 → 0.6.1`: the shared `settleWithin`, with no behavior change (review amendment 7).

## Out of scope

- CT activity mode, batch form and fast path; Claude Code and OpenClaw legs; the core API itself.

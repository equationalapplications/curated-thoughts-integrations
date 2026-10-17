# Intuitive Wisdom: autonomous-work delivery for DeepSeek Harness — design

**Date:** 2026-10-16 · **Status:** Approved for implementation (user decisions 1–6 binding; autonomous
brainstorm, no open questions) · **Branch:** `feat/dsh-autonomous-work-wisdom` · **Base:** `origin/main` @ `4388849`
**Release:** deepseek 0.5.0 → 0.6.0 (second leg after Hermes 0.6.0)
**Builds on:** [Step-0 investigation](../investigations/2026-10-16-autonomous-work-trigger-step0-investigation.md)
(DSH section, "Recommended common contract", "A6 results"), the Hermes reference
[`2026-10-16-hermes-autonomous-work-wisdom-design.md`](2026-10-16-hermes-autonomous-work-wisdom-design.md)
(`integrations/hermes/scripts/ct_wisdom_activity.py`), the verbose-mode spec
[`2026-10-16-wisdom-verbose-mode-design.md`](2026-10-16-wisdom-verbose-mode-design.md), and the DSH live leg of
[`2026-10-09-cross-harness-wisdom-parity-design.md`](2026-10-09-cross-harness-wisdom-parity-design.md).

Tags: **[V]** verified in this session by reading the cited file and line in the pinned
`@deepseek-ai/*@0.2.0-rc.2` tarballs (read as data in the session scratchpad, never executed, never
committed). **[U]** unverified or inferred; carried as a limitation or an e2e target.

## Problem

The DSH plugin asks CT for relevant facts once per user turn (the first `agent/pre-step` of a turn).
An agent that then works on its own for many model steps never gets a fact keyed to what it is doing.
INTENT's third step, "During autonomous work", asks for that. Hermes shipped it first (0.6.0); this
spec brings DSH to the same behavior and moves the host-neutral pieces into `ct-wisdom-core` so the
OpenCode and OpenClaw legs reuse them.

## User decisions (binding, 2026-10-16)

1. **Rate.** At most one CT call per model step, only when the activity key changes (a new file,
   command or search). No per-message ceiling, no session cap.
2. **Query = the bare target** (A6: no verb). A relative path for files, the pattern for searches,
   the program plus the next safe unquoted word for commands. Never flag values, quoted words, URLs,
   env assignments or credential-shaped tokens. Never contents, output, diffs or the agent's text.
   Port Hermes's line builder and its randomized secret-safety test exactly; the TS builder lives in
   `ct-wisdom-core`.
3. **Subagents** get deliveries too (the shipped adapter never checks for subagents; keep that).
4. **Scheduled and background runs** are included.
5. **Size:** 1 fact, ≤ 600 chars per activity delivery.
6. **CT's own tools never trigger.**

Known limit: concept rules reached only through a path need CT activity mode
([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)).

## Pinned host facts (DSH 0.2.0-rc.2)

Sources: `npm pack` of `dsh-agent-loop`, `dsh-agent`, `dsh-tools`, `dsh-llm`, `dsh-session`,
`dsh-scope`, `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-bash`, `dsh-tool-bash-persistent`,
`dsh-tool-pwsh`, `dsh-tool-pwsh-persistent`, `dsh-tool-str-replace-editor`, `dsh-tool-subagent`, all
`0.2.0-rc.2`, plus the `@deepseek-ai/dsh@0.2.0-rc.2` manifest. Paths are relative to `package/`.

### Trigger and step semantics

- **[V] `agent/pre-step` runs before every model step of a turn.** `turn()` loops
  `preStep(target, {turn, step})` with `target = "next-turn"` for step 1 and `"next-step"` afterwards
  (`dsh-agent-loop/lib/index.js:950-1006`). Steps are numbered per turn: `phase.step` resets to 0
  when the next turn starts (`:1036-1038`).
- **[V] When step ≥ 2 runs.** After a step the loop breaks only when the step ended the turn
  (`turnEnds`) **and** the next-step inbox is empty (`:997-1005`). Otherwise it calls `preStep` again,
  and then breaks only if `turnEnds` is set and the decision carries no messages (`:962`). So a
  pre-step at step ≥ 2 whose claimed inbox batch is empty can only happen when the turn is going on
  anyway (a tool step that did not conclude). Appending a message there **never forces an extra model
  call**. The one case where it could (turn ended, inbox non-empty, a listener stripped the claimed
  messages to nothing) is excluded by the rule "deliver only if the claimed batch is empty or the
  decision still carries messages" (below).
- **[V] Decision messages are persisted once.** In `step()`, `decision.messages` are appended as
  `user/message` (`surfaceOp: "append"`) on the first attempt only; provider retries do not re-append
  (`:1048-1062`). The request is then built from `session.deriveMessages()` (`:1262-1277`), so the
  message is in the model's context for this step and every later one.
- **[V] Pre-step payload.** `{agent, messages, turn, step, signal}`; `messages` are those removed
  from the inbox for this step (`dsh-agent/lib/types/runtime-types.d.ts:293-310`). The default
  decision is `{kind: "enter", messages: claimed (+ runtime context)}` (`dsh-agent-loop/lib/index.js:902-924`).
- **[V] Where the previous step's tool calls are.** The assistant message of a step is appended
  before its tools run, and its `content` holds `tool-call` blocks `{type, id, name, arguments}` where
  `arguments` is the raw JSON string from the model (`dsh-llm/lib/types/types.d.ts:85-92`;
  `dsh-agent-loop/lib/index.js:1129-1152`). Tool results are `role: "tool"` messages with
  `source: {kind: "tool", callId}` (`dsh-llm/lib/types/message.d.ts`, `ToolMessageSource`). At pre-step
  N+1 the last assistant message in `deriveMessages()` is therefore step N's, with all of its calls.
- **[V] `deriveMessages()` is the model's view.** It walks the session surface; a compaction
  `replace` deletes the shadowed nodes, and each call returns a fresh array of deep-frozen messages
  (`dsh-session/lib/types/index.d.ts:285-303`). Rebuilding the ledger from it is exactly INTENT's
  "context means what the agent can see right now".
- **[V] `tools/pre-execute`** is a waterfall `(exec, next)` that runs before each dispatch; `exec`
  carries `callId`, `name`, parsed `arguments`, `agent` and, for transport sub-dispatches (PTC
  `run_code`), a `parent` token (`dsh-tools/lib/types/index.d.ts:47`, `:216-240`). The loop builds
  `exec` from the assistant's blocks with `callId: block.id` and `arguments: JSON.parse(block.arguments)`
  (`dsh-agent-loop/lib/index.js:506-516`). It is the prefetch point.

### Tool names and arguments at the pin

| Tool (package) | Args we read | Verb |
|---|---|---|
| `read` (`dsh-tool-fs` `:262`) | `file_path` | read |
| `write` (`:527`) | `file_path` (never `content`) | write |
| `edit` (`:675`) | `file_path` (never `old_string`/`new_string`) | edit |
| `str_replace_editor` (`dsh-tool-str-replace-editor` `:267`) | `command` + `path` (never `file_text`/`old_str`/`new_str`) | `view` → read, `create` → write, `str_replace`/`insert` → edit |
| `grep` (`dsh-tool-fs-search` `:1090`) | `pattern`, `path` (never `include`) | search |
| `glob` (`:782`) | `pattern`, `path` | search |
| `bash` (`dsh-tool-bash` `:488`, `dsh-tool-bash-persistent` `:337`) | `command` (never `description`/`workdir`) | run |
| `pwsh` (`dsh-tool-pwsh` `:458`, `dsh-tool-pwsh-persistent` `:342`) | `command` | run |

All [V] at the cited lines. Every other tool (`read_image`, web, todo, subagent, MCP tools, …) gives
no activity. MCP tools are named `<server>__<tool>`; CT's are `curated-thoughts__curated_*`
[V existing `RECALL_TOOL_SUFFIX` path, live e2e].

### Scope: subagents and background agents

- **[V] Untagged listeners receive every agent.** `scopeTarget` "admits untagged listeners globally,
  and admits tagged listeners for a matching key or any of its ancestors"
  (`dsh-scope/lib/index.js:315-341`, `scopeTarget`). The plugin's `apply()` context is loaded from the bundle patch at
  the root and carries no scope tag [U: inferred from the patch loader; the shipped live delivery
  already reaches subagents on that basis, investigation A5].
- **[V] Subagents are full agents** with their own id and session log (`parentAgent`,
  `origin: 'subagent'`, `dsh-agent/lib/types/index.d.ts:51-68`; created with `parent: exec.agent`,
  `dsh-tool-subagent/lib/index.js:490-520`). Our session key is `agent.id`, so each child has its own
  ledger, key tracker and step slots. Nothing in the path checks `parentAgent` or `origin`
  (decision 3). Background jobs and scheduled prompts run the same agent loop, so nothing checks them
  either (decision 4) [U: no scheduled-run surface was exercised].

## Design

### Overview

```
tools/pre-execute (each root tool call)          agent/pre-step, step ≥ 2
  └─ planStep(agent, its assistant message)        ├─ user-turn path ran in this call? → nothing
       (idempotent per step)                       ├─ claimed batch non-empty but decision empty → nothing
                                                   ├─ planStep(agent, last assistant message)
planStep:                                          │    (reuses the prefetch, or plans now)
  ├─ no deriveMessages      → no_ledger            ├─ no query planned → nothing
  ├─ for each call in model order:                 ├─ await ≤ remaining 3 s budget → budget
  │    CT tool → skip; no activity → skip          ├─ failure → skip (breaker as live)
  │    tracker.admit(agent, step, key):            ├─ fresh ledger from deriveMessages()
  │      seen_key → next call; step_used → stop    ├─ first candidate not in ledger, rendered
  │      admitted → this call is the trigger       │    marker-first, ≤ 600 chars → zero_hits
  ├─ breaker open → breaker_open (no query)        └─ append {id: randomUUID(), role:'user',
  └─ start `ct wisdom match --max 1 -- <target>`        source:{kind:'curated-thoughts-wisdom-activity'},
     exclude = ledger now (newest first, ≤ 256)         content:[{type:'text', text: block}]}
                                                      + update the turn's N3 ledger cache
```

### Activity builder (shared, `ct-wisdom-core/src/activity.ts`)

A byte-for-byte behavioral port of `ct_wisdom_activity.py`'s builder. Host adapters map their tool
calls to a neutral spec; the core does the rest.

```ts
type ActivitySpec =
  | { verb: 'read' | 'write' | 'edit'; path: unknown }
  | { verb: 'search'; pattern: unknown; path?: unknown }
  | { verb: 'run'; command: unknown };
interface Activity { verb; target; key; line; query }   // Hermes's Activity namedtuple
buildActivity(spec, cwd?): Activity | null
activityQuery(activity): string                          // the bare target
```

- **Paths** (`normalizePath`), with the privacy rules R1–R4 of the Hermes hotfix
  (`fix/hermes-activity-privacy`; amended after the PR #56 review): `\` → `/`, `posix.normalize`; a
  relative path is kept (leading `./` and `..` dropped); **R1** an absolute or `~` path under `cwd`
  becomes relative to it, and the cwd counts only at depth ≥ 2 (never `/`, a drive root, `/Users` or
  `/home`); **R2** any other absolute or `~` path reduces to its basename, and in every path a component
  equal to the local user name (`$USER`, `$USERNAME`, `$LOGNAME`, the last component of
  `$HOME`/`$USERPROFILE`; case-insensitive), or a `Users`/`home` right before one, is dropped (nothing
  left → no activity); Windows drive letters are dropped; capped at 200 chars by keeping the tail and
  cutting at the next `/`.
- **Self-trigger guard:** a target with a control character, `ct-fact:` or `## Curated Thoughts —`
  gives no activity.
- **Commands** (`commandTarget`), exactly Hermes's rules: tokenize like Python
  `shlex.split(posix=False)` (whitespace split, quotes **kept**, a quoted word at a token start ends at
  its closing quote; an unterminated quote falls back to a plain whitespace split); stop at the first
  token containing any of ``;|&<>()` ``; drop leading `NAME=value` assignments; the program is the
  basename of the first word and must be word-shaped (`^[A-Za-z0-9._][A-Za-z0-9._/-]{0,39}$`) and not
  credential-shaped (a key prefix such as `sk-`, `ghp_`, `xox`, `AKIA`, `eyJ`, …, or ≥ 16 chars with
  ≥ 3 digits); free-text programs (`echo`, `export`, `env`, `sudo`, `ssh`, `curl`, `wget`, …) give only
  the program; a flag right after the program ends the target at the program (a flag's value is never
  sent), except `python[N.M] -m <module>`; the second word must pass the same shape test.
- **Search (R3):** no activity when the pattern holds `=`, any quote (`'`, `"`, `` ` ``), a
  credential-shaped word, or is path-shaped and does not pass R2 unchanged, or when a given search scope
  fails R2 (`.` or the workspace root itself count as "no scope"). Otherwise the pattern, capped at 200;
  the key and label add ` in <path>` for a scope; the query is the pattern alone.
- **R4:** the `_for:` label and the verbose `activity` field are built from the sanitized target only.
- **Key:** `(verb class, target)`, where read/write/edit fold into `file`.
- **Query:** `stripForged(target).trim()`, capped at `ACTIVITY_QUERY_CHARS = 300`. The verb stays in
  the key and the visible `_for: <line>_` label, never in the query.
- `isCtTool(name)`: contains `curated-thoughts`/`curated_thoughts`, or the last `__`/`.` segment starts
  with `curated_` (Hermes `is_ct_tool`).

### Key tracker and the rate rule (shared `ActivityTracker`)

Per session: the last 32 keys (LRU), the last 16 step ids that started a query, the last 16 step ids
already reported to verbose mode; sessions LRU 256. `admit(session, step, key)` returns
`'step_used'` if the step already started a query, `'seen_key'` (refreshing it) if the key is recent,
else records both and returns `null`. A rejected call changes nothing. `peek` answers without
recording; `firstReport` is true once per step.

On DSH the **step id is the assistant message id** of the step whose tool calls form the activity.
`tools/pre-execute` and the next pre-step both resolve it from `deriveMessages()`, so they agree
without any turn/step bookkeeping, and a resumed process starts a fresh tracker (the log ledger then
dedups). `planStep` walks the step's tool calls in model order and stops at the first admitted one
(Hermes: "the first call with a new key wins"; the others stay unseen and can trigger later).

### Query, prefetch and the 3 s budget

- **Prefetch** at `tools/pre-execute` for root calls only (`exec.parent === undefined`) whose `callId`
  is a tool-call block of the **last** assistant message. The listener calls `planStep`, starts the
  match without awaiting it, and returns `next()` unchanged; it never throws and never alters the
  tool decision. A plan is stored per `agentId#messageId` (bounded LRU of 64) and is idempotent: the
  second call of the same step sees the stored plan.
- **Match:** `runActivityMatch(host, activity, exclude, breaker)` (core). Capability latched absent →
  `capability_missing`; `spawn` → reset discovery/probe caches; `timeout_or_exit` → breaker failure;
  ok → breaker success; ok without a result → `parse_error`. It uses the adapter's `wisdomMatch`, so
  the same capability probe and `ct wisdom match --json --max 1 --exclude=… -- <query>` argv as live.
  The breaker is the **same** instance the user-turn path uses (rule 4: three failures pause both).
- **Budget:** `deadline = plan start + TIMEOUT_MS (3 s)`. Pre-step awaits the match for
  `max(0, deadline − now)`; a match that already settled is used even past the deadline (it costs
  nothing). Running out is class `budget`. Superseded by the 0.6.2 amendment ("Review amendments"):
  the query is aborted on expiry and the miss counts as ONE breaker failure; the key is freed, the
  step stays used.
- If no prefetch happened (a tool path that skips `pre-execute`), pre-step plans and awaits itself
  within the same budget.

### Channel: a persisted user-role message in the next step

The block, marker first (same as Hermes so truncation can never show a fact without its marker):

```
## Curated Thoughts — relevant to this step
_for: read src/billing/invoice.ts_

<!-- ct-fact:<id> --> **<title>** (provenance: <provenance>)
<text, truncated with … to fit>
```

- One fact (`ACTIVITY_MAX_PER_STEP = 1`), total ≤ `ACTIVITY_MAX_BLOCK_CHARS = 600`. A correction
  renders the same with ` — supersedes ct-fact:<old>` and is a candidate only when it supersedes an id
  in the ledger. Corrections come first, then entries not in the ledger; the first candidate that fits
  is delivered. Titles, text, provenance and the label pass through `stripForged`.
- Delivered as `{id: randomUUID(), role: 'user', source: {kind: 'curated-thoughts-wisdom-activity'},
  content: [{type: 'text', text: block}]}` appended to `decision.messages` (the 0.4.1 lesson: a
  `user/message` without a non-empty string `id` and `role: 'user'` makes the stored session
  unresumable). Its own `source.kind` lets logs, tests and verbose mode tell it from the user-turn
  message (`curated-thoughts-wisdom`).
- It is persisted once in the session log, enters context after the prior request prefix (cache-safe;
  the system prompt is untouched, rule 2) and replays on `--session-id` resume.

**Self-trigger guard (structural).** The activity query is built only from tool-call arguments; the
user-turn query only from the claimed inbox batch, which never holds our messages (ours go straight
into the decision, not the inbox). A marker-hygiene test enforces both, and the target guard above
covers block text copied into a tool argument.

### Ledger and exactly-once (rule 1)

- **Source of truth: the session log.** At pre-step the ledger is rebuilt from a fresh
  `deriveMessages()` (user and tool roles) plus the agent's bootstrap memo ids, the same
  `rebuildLedger` the user-turn path uses. It already holds the previous step's tool results (CT
  recalls' markers), every earlier activity and user-turn message, and nothing compacted away.
- **N3 cache.** The user-turn path caches its ledger for the `tools/post-execute` recall dedup. After
  an activity delivery the cache is replaced by `fresh ledger ∪ {delivered id}` (the message is not
  in the log until the step starts), so a CT recall later in the turn stubs the fact instead of showing
  it again.
- **Ordering:** pre-step for one agent is serial, so there is no in-step race; parent and child are
  separate agents with separate logs. The user-turn path (first pre-step of a turn) and the activity
  path (step ≥ 2, never in the same call) cannot both deliver into one decision.
- **At most once.** If an outer pre-step listener later rejects or replaces our decision, the message
  is never persisted and the fact simply may arrive later; nothing records it elsewhere, so it can't be
  shown twice.

### Fail-closed cases

Each means "no CT call or no delivery", one `debug` log line, and an unchanged decision.

| Class | Where | Verbose record? |
|---|---|---|
| `empty_id` (no agent id or message id) | plan | no |
| `ct_tool` (decision 6) | plan | no |
| `no_activity` (tool not in the map, or args give no safe line) | plan | no |
| `seen_key`, `step_used` | plan | no |
| `no_ledger` (no `deriveMessages`: the step's calls cannot even be read) | plan, pre-step | no |
| `breaker_open` | plan | yes, once per step, for a would-be trigger |
| `capability_missing`, `spawn`, `timeout_or_exit`, `parse_error` | match | yes |
| `budget` | pre-step | yes |
| `zero_hits` → `deduped` / `no_match` / `gate_uncalibrated` | pre-step | yes |
| `would_extend_turn` (claimed batch non-empty, decision empty) | pre-step | yes |
| `hook_failed` (unexpected exception, caught) | either | no |

### Verbose mode (channel `activity`)

`VerboseTurn` gains two optional fields, `channel` (overrides the recorder's channel) and `activity`
(the label, e.g. `read src/x.ts`); `buildRecord` copies them in the same order as the Python twin
(`query`, then `activity`). DSH reports every activity delivery and every recorded skip above with
`channel: 'activity'`, `query` (the bare target CT received), `activity`, `result`, `ledgerIds`,
`deliveredIds`, `block`. The notice reads `Curated Thoughts wisdom: delivered 1 fact (… chars) …
[activity]` on the plugin's named logger, and the JSONL line goes to `$DSH_HOME/logs/ct-wisdom-verbose.jsonl`.
With verbose off nothing is written and the decision bytes are identical (tested). Other hosts are
unaffected: both fields are optional and absent on their records.

### What does NOT change

- The user-turn path (first pre-step of a turn, 2 facts / 1200 chars) and its block bytes.
- The session-start wisdom section and health context (rule 2).
- `tools/post-execute` recall dedup, except that its turn cache learns activity ids.
- OpenCode and OpenClaw behavior: they gain nothing they call; the core additions are new exports and
  two optional verbose fields.

## Shared core API added (for the OpenCode and OpenClaw legs)

From `@equational-applications/ct-wisdom-core`:

- constants `ACTIVITY_MAX_PER_STEP`, `ACTIVITY_MAX_BLOCK_CHARS`, `ACTIVITY_QUERY_CHARS`,
  `ACTIVITY_TARGET_CHARS`, `ACTIVITY_LABEL_CHARS`, `ACTIVITY_RECENT_KEYS_MAX`,
  `ACTIVITY_STEP_IDS_MAX`, `ACTIVITY_SESSIONS_MAX`, `ACTIVITY_HEADING`;
- `ActivitySpec`, `Activity`, `buildActivity`, `activityQuery`, `normalizePath`, `commandTarget`,
  `shellWords`, `isCtTool`, `credentialShaped`;
- `ActivityTracker` (`admit`, `peek`, `firstReport`, `reset`); the "step id" is whatever the host's
  coalescing unit is (DSH: assistant message id; OpenCode/OpenClaw: the in-flight window id);
- `activityCandidates(result, ledger)`, `renderActivityBlock(item, superseded, activity)`,
  `selectActivityDelivery(result, ledger, activity)`;
- `runActivityMatch(host, activity, exclude, breaker)`;
- **the gates, so no host can skip them** (review of PR #56): `activityGate(host, session, breaker?)`
  (no session, `deliveryEnabled` latch such as Claude Code's resume-OFF, restored without a known
  bootstrap, capability latch, breaker), `startActivity(host, session, activity, breaker)` (gate +
  `--exclude` bound + match) and `finishActivity(host, session, activity, match | null)` (re-gate on a
  fresh ledger, select, turn-scoped N3 cache update, verbose report), plus `reportActivity`;
- `userNames(env)`, `nameHit`, `projectRoot`, `activitySeams` and `resetActivityCaches` (the 0.6.5
  rules and their test seams);
- `cpLen` / `cpSlice` (every cap counts and cuts by code point, like Python) and `lruSet` / `lruGet`
  (the one LRU helper of the core and the DSH host);
- `VerboseTurn.channel?` and `VerboseTurn.activity?`.

`ActivityTracker.firstReport` stays in the core for the per-tool hosts (Hermes, OpenCode, OpenClaw),
where every call of a step reaches the gate; DSH plans a step once and does not use it.

## Alignment with INTENT.md

- **Goal "During autonomous work":** this is that step for DSH. Host event (`agent/pre-step` at step
  ≥ 2, prefetched at `tools/pre-execute`), query text (the bare target), frequency (once per model step
  on key change) and channel (a persisted user-role message) answer INTENT's four open questions for
  this host.
- **Rule 1 (at most once):** marker on every fact, marker first; the ledger is rebuilt from the
  model-visible session log at every trigger; the N3 cache learns activity ids; no second record of a
  delivery exists that could replay it.
- **Rule 2 (never edit the system prompt):** delivery is an appended user message; the system prompt
  and its cached prefix are untouched.
- **Rule 3 (no superseded fact):** CT filters superseded entries; corrections ride only when they
  supersede an id in context.
- **Rule 4 (fail quietly):** every listener catches everything; the pre-execute listener never changes
  the tool decision; 3 s budget, enforced by killing the `ct` child on expiry; the shared breaker, which
  counts a budget miss once and never a host-side cancel (0.6.2 amendments).
- **Rule 5 (provenance):** the block shows CT's provenance label.
- **Rule 6 (keep it small):** 1 fact, ≤ 600 chars per delivery (decision 5), no session cap.
- **Rule 7 (read only):** `ct wisdom match` only.
- **Rule 8 (relevance is CT's):** the builder renders the action and never scores, expands or ranks.
- **User decisions:** 1 → "Key tracker and the rate rule"; 2 → "Activity builder" and the
  secret-safety tests; 3 and 4 → "Scope"; 5 → constants and "Channel"; 6 → `ct_tool`.
- **Departures:** none. Where DSH differs from Hermes on purpose: the channel is a user-role message in
  the next step instead of a tool-result splice (DSH has a per-step channel and the investigation
  recommends it), the step id is the assistant message id instead of `api_request_id`, and the ledger
  is the log at every trigger instead of an in-turn cache.

## Known limitations

1. **Concept rules via paths** need CT activity mode (curated-thoughts#282). No query expansion here.
2. **One trigger per step:** other new keys in the same step stay unseen and can trigger later.
3. **Delivery is one step later** than the work that triggered it (the fact arrives with the next
   model request, which is when the model can first use it).
4. **Process-local tracker:** a resumed session may query a key again; the ledger still dedups.
5. **PTC sub-dispatches** (`run_code` inner calls) are not model tool calls and give no activity.
6. **[U]** the root-scope assumption for the plugin context (subagent delivery) and scheduled runs
   are inferred, not exercised live in this PR.

## Testing

Vitest, in `packages/ct-wisdom-core/tests/activity.test.ts` and `integrations/deepseek/tests/`:

- **Line builder + secret safety** (core): Hermes's 29 cases and no-line cases ported verbatim, path
  rules, CT tool names, secret args never in the line or query, the 500-iteration randomized command
  test with the same nasty-token pool and assertions (≤ 2 tokens, no `=@:$'"|&;<>`, no key prefixes,
  every token one of the command's own leading words, the second word is the one right after the
  program), credential-shaped search patterns, own-text guard, caps.
- **Key tracker and rate** (core + DSH): one start per step, file fold, LRU, sessions, run vs search
  keys; on DSH, two calls of one step make one CT call, a later step with the same key makes none, a
  new key in a later step makes one, prefetch and pre-step share one plan.
- **Exactly-once randomized** (DSH): 200 sessions mixing user turns, multi-step activity steps with
  random tool calls, CT recalls (N3), compaction and resume in a new adapter/process (log carried
  over, memory dropped), random corrections and a fake CT that ignores `--exclude` half the time; no
  fact is ever visible twice in the derived context.
- **Fail-closed:** every class in the table, listeners never throw, the pre-execute decision is
  passed through unchanged, the would-extend-turn guard.
- **Marker hygiene:** the marker precedes the title in every block; activity queries never contain
  `ct-fact:`, the heading or block text; the user-turn query ignores activity messages; activity
  markers are found by the ledger rebuild.
- **Verbose:** off → nothing written and byte-identical decisions; on → one `activity` record per
  delivery with query, activity label and fact id, skips after a query recorded, rate/filter skips not.
- **Backward compatibility:** the core, opencode and openclaw suites stay green.

**Live e2e** (`integrations/deepseek/tests/e2e`, real-gate mode `CT_E2E_REAL_GATE=1`): one user
message makes the agent do several tool steps (bash `pnpm test` twice, write then read `.env.local`,
a CT recall). Checks, mirroring Hermes: (1) an activity message arrives, exactly once per fact, with
its marker; (2) a later step with the same key neither re-queries nor re-delivers; (3) the activity
message is an identified user-role message and the session resumes with `--session-id`; (4) CT's own
tools never trigger a query; (5) every activity query is the bare target; plus verbose (the logger
notice and the JSONL line). Real CT gate (OpenRouter `qwen/qwen3-embedding-4b`), ZAI GLM-5.3-FLASH,
keys by name at run time only, logs grepped for both keys afterwards.

**E2E (done, 2026-10-17 UTC):** `CT_E2E_REAL_GATE=1 integrations/deepseek/tests/e2e/run.sh`, 75 passed,
0 failed. The agent's six tool steps (`read TASK.md`, `bash pnpm test`, `bash pnpm test --silent`,
`write .env.local`, `read .env.local`, `curated_recall_context`) gave exactly three activity queries,
`TASK.md`, `pnpm test`, `.env.local` (absolute paths normalized to the workspace), and two activity
messages through the real gate (`pnpm test` → "CI rejects pushes when `pnpm test` fails.", `.env.local`
→ ".env.local holds local-only secrets …"), each once, marker first, identified user-role messages; the
session continued with `--session-id`. Verbose JSONL carried the `activity` records. Findings: the
logger notice did not appear on headless stderr (where DSH's headless logger exports is still [U]; the
JSONL log works), and the e2e also fixed a host-side detail of the harness (the jq brain-config edit now
reads the ZAI key from the environment, never from argv). A grep of every output file found neither key.
The randomized test also found two pre-existing user-turn duplicate paths in `ct-wisdom-core` (a correction
whose own id is in context; one id as both entry and correction), fixed to the Hermes `render_live_block`
rule; opencode and openclaw get patch bumps for it.

## Review amendments (PR #56, independent review)

- **Privacy R1–R4** (above): implemented in the core builder, identical to the Hermes hotfix rules;
  the shared vector file `tests/fixtures/activity_targets.json` runs in the core suite once it lands.
- **Gates in the core** (`activityGate` / `startActivity` / `finishActivity`): DSH no longer
  re-implements the ledger, cache and verbose steps; `deliveryEnabled` and the restored-session rule
  now apply to every activity delivery. A second review (PR #56 @ 39319da) removed `noteDelivered`
  from `finishActivity`: it is the user-turn bootstrap record, so an activity id stored there outlived
  its message (a rejected decision, a compaction) and blocked the fact for good, and only when a
  bootstrap record existed. The ledger is what the agent sees (the session-log scan), plus the
  turn-scoped N3 cache. `plan()` gates once (`startActivity`) and admits the key only when the start
  succeeded. Every cap (activity block, label, both query caps, the user-turn block truncation) counts
  and cuts by code point and never splits a surrogate pair. The named logger is resolved once.
- **Hot path.** Per step the DSH path reads the log at the first approved `tools/pre-execute` and at
  the next `agent/pre-step`; other calls of a planned step return before touching the log (the slot
  remembers its call ids). The pre-step read and ledger rebuild must stay: the step's tool results, CT
  recall markers included, land between the plan and the delivery, and a stale ledger could show a
  recalled fact again (test "a recall in the previous step is in the fresh ledger"). The rebuild is
  cheap: marker ids are memoized per message by object identity. DSH's `deriveMessages()` returns
  shared, deep-frozen Message objects reused for unchanged history ("pure tail growth costs O(new
  nodes)", dsh-session `Session.deriveMessages`), so a rebuild rescans only new messages, and a frozen
  object cannot change, so the memo can never go stale (a mutable message is always rescanned). This
  replaces a per-(agent, messageId) ledger cache: keyed by message identity it needs no invalidation
  rule for new tool or user messages, compaction or projections.
- **Final review (PR #56 @ 6962448).** The pre-step never plans: with no plan from an approved
  pre-execute there is no CT call and no wait, and a would-be trigger is reported as `no_plan`.
  Prefetch runs only after `next()` resolves to `{kind: 'allow'}` (`PreToolDecision` is
  `allow | deny | cancel | ask`, dsh-tools `types/index.d.ts:445`), so a denied, cancelled or pending
  call sends nothing. A started query that got no genuine answer (budget, a CT failure, a gate that
  closed, a turn the host would not extend) releases its key and step (`ActivityTracker.release`,
  `finishActivityOutcome().retry`); CT's "nothing relevant" (`zero_hits`: no_match, deduped) keeps
  it. (Since 0.6.2 only the key is freed and the step stays used; see the 0.6.2 amendment below.) `peek` is pure and a `seen_key` refusal no longer bumps recency (a deliberate difference from
  Hermes's `move_to_end`, which only affects LRU eviction order). The named logger caches only a
  successful lookup. The `str_replace_editor` verb map is a Map. The activity block was compared with
  Hermes `render_activity_block` and already matched; `tests/fixtures/activity_blocks.json` (generated
  from the Hermes renderer by `tests/fixtures/make_activity_blocks.py`) is now a golden test in both
  languages, one correction and one entry included. Hermes's `_sanitize` also defuses its own
  `## Plugin Context:` prompt frame, which DSH does not have; the fixture avoids that text.
- **One plan slot per agent** (only the newest step matters), LRU-bounded at 256 agents like the key
  tracker, instead of one 64-entry LRU across agents; prefetch remembers a planned step's call ids and
  skips the log read for its other calls; one adapter method (`snapshotMessages`) publishes log
  snapshots for both paths; one message builder (`wisdomMessage`) for both channels.
- **User-turn corrections** (`onUserTurn`): a correction is delivered only when it supersedes an id in
  context and its own id is new, and one id renders at most once per block. This is exactly the filter
  of Hermes `render_live_block` (`seen = set(ledger)`; corrections first, kept only if
  `supersedes ∩ ledger` is non-empty and the id is unseen; then entries not seen) and of the live-delivery
  spec's step 7 ("drop a correction whose `supersedes` ∩ ledger is empty"). Annex A of the parity spec
  wrote `corrections = res.corrections` unfiltered, and the TS port followed it; that was the gap.
  Nothing relevant is lost: CT emits corrections only for `--exclude` ids (CT guarantee 3), which are
  facts in context, so a correction superseding nothing in context comes only from a stale exclude list
  and has nothing to correct (INTENT rule 3 is about facts the agent sees). A newer fact that replaces
  something the agent has not seen is an ordinary wiki entry: CT returns it in `entries` when it matches
  the query (guarantee 2 keeps the superseded one out), and it is delivered like any fact. Rendering
  differences that remain from before (TS lists every `supersedes` id in a correction's title and puts
  entries before corrections; Hermes lists only ids in context, corrections first) change no ids.
- **Line builder synced to hermes 0.6.8** ("Privacy amendment 7"): only `.exe` is stripped
  (`extname`, case-insensitive; `.bat` / `.cmd` / `.com` / `.ps1` are scripts and send nothing); a path
  inside any home that lies within the project root sends nothing (the sandbox exception stays for
  root-finding only); `blocked` / `findRoot` take the user homes as a required argument; interpreter
  flags are parsed alone, combined or attached (`-uB`, `-OO`, `-um`, `-Xdev`, `-Wignore`; any unknown
  flag, a long option or `-c` stops the scan); the interpreter pattern is
  `^python([0-9]{1,2}(\.[0-9]{1,3})?)?$`; a project package is a real one (`<top>.py` or
  `<top>/__init__.py`, matched case-sensitively by directory listing), cached 30 s found / 2 s not; the
  name check runs on the full module and on the sent string. The core suite runs all 290 shared
  vectors. Only the line builder changed, so the real-gate e2e at `5ae2c60` (75/0) stands.
- **Line builder synced to hermes 0.6.7** ("Privacy amendment 6"): `python -m` sends a known module as
  listed, else only the top package and only when it exists at the root or under `src/` (cached per
  root and top); every home blocks its ancestors again, except a sandbox HOME inside a root (not a real
  user home, and a dot-dir directly under the root or `.cache/home` / `tmp/home`; with no passwd home,
  USERPROFILE counts as the real home); a trailing `.exe` / `.cmd` / `.bat` / `.com` is stripped from
  the program; the interpreter pattern is `^python(\d+(\.\d+)?)?$`; interpreter flags before `-m` are
  skipped (`-X` / `-W` with their value). The core suite runs all 267 shared vectors. Only the line
  builder changed, so the real-gate e2e at `5ae2c60` (75/0) stands. Superseded by the 0.6.8 sync above.
- **Line builder synced to hermes 0.6.6** ("Privacy amendment 5"): the command builder (one isolated
  `commandTarget`) now sends a bare program only (no path separator, `~`, `:` or dot, `python3.11` the
  one dotted form, else no query), a subcommand only for the known subcommand tools and their verbs
  (make/just/rake: the common targets), and a `python -m` module only when known or a top package in the
  project (root looked up lazily); a HOME blocks its ancestors only when it is a real user home (a
  homes-location child or the passwd home, `os.userInfo().homedir`); the canonical homes are cached. The
  core suite runs all 240 shared vectors, each case in its own world at the same path, with the
  `key_distinct_from` pairs built as (case, other, case). Superseded by the 0.6.7 and 0.6.8 syncs above.
- **Line builder synced to hermes 0.6.5** ("Privacy amendment 4: project-root allowlist", which
  supersedes the path rules below): a path is sent only relative to a project root it resolves inside
  of (marker walk on the logical cwd, real-root re-check of every stop rule, homes locations, `/mnt`
  rules, HOME / USERPROFILE / `os.homedir()` / `os.userInfo().homedir` and their ancestors, the macOS
  firmlink mapping, 2 s negative and 30 s positive root caches, a per-directory `*.sln` cache); name
  tokens (alphanumeric runs; ≥ 3-char parts by substring, shorter ones exactly; multi-word names); the
  command allowlist (program regex, plain subcommand, `-m` module, a name in a subcommand sends the
  program alone) kept in one isolated function (`commandTarget`) for the coming 0.6.6 command rules; the
  search allowlist; no truncation (nothing over 200 chars is sent); full-path keys. Node's
  `os.userInfo()` stands for `pwd` (guarded). The core suite runs all 206 shared vectors in temp-dir
  worlds (files, directories, symlinks, `system_user` / `system_home`), exactly like the Hermes runner.
  Without a session cwd no path is sent. The earlier bullet is kept for history:
- **Line builder synced to hermes 0.6.3** ("Privacy amendment 2": search-pattern allowlist and
  auth-word refusal, HOME and its ancestors never a cwd, drive-relative and rooted-backslash paths,
  embedded user-name drop, service-account exemptions, SHA-256 full-path activity keys); the core suite
  runs all 111 shared vectors, `key_distinct_from` included. A further sync to hermes 0.6.4 is pending.
- **Which cwd (DSH).** [V] DSH resolves its tools' relative paths against the session header's
  validated absolute `cwd` (`dsh-session` `SessionHeader.cwd`; `dsh-tool-fs` `session-cwd`
  `exec.agent.session.header.cwd`; `dsh-tool-bash` `resolveWorkdir`, 0.2.0-rc.2). The activity builder
  uses the same value per agent (subagents have their own). Without it the cwd is absent (absolute paths
  reduce to their basename); `process.cwd()` is never used.
- **e2e check 5** now reads tab-separated argv and asserts the query is the single element right after
  `--` with nothing after it.
- **0.6.2: abort on budget expiry** (follow-up to the shared core's abort support and
  `recordActivityBudgetMiss`, PR #70). Each started activity owns an `AbortController`; its signal goes
  to `startActivity` → `runActivityMatch` → the adapter's `wisdomMatch` (capability probe and match) →
  `SpawnLike.signal`. The pre-step's `settleWithin(match, remaining, onExpire)` aborts it on expiry, and
  `nodeSpawnFn` kills the child's process group and reports `aborted: true`. The core then counts the
  miss as ONE breaker failure; this supersedes "Running out is class `budget` (not a breaker failure)"
  above. A non-budget abort counts zero. On a retryable outcome DSH now frees only the key
  (`ActivityTracker.releaseKey`): the step stays used, so it never gets a second query, and a later
  step can retry the activity (OpenCode / OpenClaw parity). A plan whose pre-step never runs is not
  aborted; it ends at the spawns' own timeouts as before (superseded by the next amendment: such a plan
  is cancelled once its slot is replaced or evicted).
- **0.6.2: PR #71 review.**
  - *Abandoned plans are cancelled, not charged to CT.* When `plan()` replaces an agent's slot for a
    newer step, when the slot LRU (256 agents) evicts it, or on the `would_extend_turn` path, the plan's
    query is cancelled (its `ct` child killed) and its key freed. A cancel is not a budget miss: each
    plan owns a second `AbortController`, linked to its budget signal through the adapter
    (`linkCancel`), and the spawns listen to both. The core sees its budget signal un-aborted, gets
    outcome `aborted` and counts no breaker failure (core rule: an abort from anywhere but the budget
    never counts).
  - *Capability probe once per path.* `ct wisdom match --help` runs once per resolved `ct` path
    (OpenCode `probedPath` parity), not before every match, so a query no longer splits its 3 s budget
    between two processes. A spawn-class outcome clears it with the capability latch
    (`resetDiscoveryAndProbeCaches`, `_resetForTests`).
  - *Spawn errors are spawn errors.* A `ct` that cannot start is class `spawn` even when an abort
    landed first (the binding never reports `aborted` with `spawnError`, and the adapter checks
    `spawnError` first), and the adapter clears its probe cache and latch itself. Known limit: when the
    budget signal itself has aborted, the core still counts the budget miss before it looks at the
    spawn class (a core rule, unchanged here); an already-aborted budget starts no child, so this needs
    an abort in the few milliseconds before the `ENOENT` event.
  - *Binding.* An already-aborted signal resolves `aborted` without spawning. An abort that lands after
    the child exited keeps the real result (stragglers holding the pipes are still killed). One kill
    path (`killTree`) for timeout, abort and overflow: the POSIX process group, or the direct child on
    Windows. A child with no pid (failed spawn) is never signalled: Node's `child.kill()` there signals
    pid 0, the caller's own process group.

## Versioning and docs

- deepseek `0.5.0 → 0.6.0` (`package.json`, `integration.yaml`), CHANGELOG, README (Intuitive Wisdom
  section and limitations), README table via `tools/ct_ci.py readme`.
- opencode `0.3.0 → 0.3.1`, openclaw `0.2.0 → 0.2.1`: the policy gate does not require it, but they ship
  the core's correction-dedup fix, so each gets a patch bump and a CHANGELOG note; the activity API itself
  is not called there yet.

## Out of scope

- The Claude Code, OpenCode and OpenClaw autonomous legs (they reuse the core API above).
- CT activity mode, batch form or fast path (investigation "CT-side support").

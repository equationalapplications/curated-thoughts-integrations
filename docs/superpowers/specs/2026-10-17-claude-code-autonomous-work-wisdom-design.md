# Intuitive Wisdom: autonomous-work delivery for Claude Code (claude-code 0.4.0) — design

**Date:** 2026-10-17 · **Status:** Approved for implementation (user decisions binding; design
judgment delegated, autonomous brainstorm, no open questions) ·
**Branch:** `feat/claude-code-autonomous-work-wisdom` · **Base:** `origin/main` @ `604c904` (PR #59
merged: shared `hooks/ct_hook_store.py`, claude-code 0.3.3, hermes 0.6.9) ·
**Release:** claude-code 0.3.3 → **0.4.0** · **Host pin:** Claude Code **2.1.301**
**Builds on:** [Step-0 investigation](../investigations/2026-10-16-autonomous-work-trigger-step0-investigation.md)
(Host 4, the common contract, targets A1/A2), the Hermes reference
([`2026-10-16-hermes-autonomous-work-wisdom-design.md`](2026-10-16-hermes-autonomous-work-wisdom-design.md),
privacy amendments 1–7, hermes 0.6.9), the Docker Agent sibling
([`2026-10-16-docker-agent-integration-design.md`](2026-10-16-docker-agent-integration-design.md), D7/D9 and its
review fixes), the Claude Code leg
([`2026-10-16-claude-code-wisdom-parity-leg-design.md`](2026-10-16-claude-code-wisdom-parity-leg-design.md), D3–D10),
the DSH final review ([`2026-10-16-dsh-autonomous-work-wisdom-design.md`](2026-10-16-dsh-autonomous-work-wisdom-design.md),
"Final review") and verbose mode ([`2026-10-16-wisdom-verbose-mode-design.md`](2026-10-16-wisdom-verbose-mode-design.md)).

Tags: **[D]** quoted from the official docs (code.claude.com/docs/en/hooks, fetched 2026-10-17 as
markdown); **[B]** read as data from the shipped 2.1.301 binary
(`~/.local/share/claude/versions/2.1.301`, Mach-O x86_64, never executed for reading); **[E]**
observed in a live isolated run of the real `claude` 2.1.301 (temp `HOME` and `CLAUDE_CONFIG_DIR`
under the session scratchpad, a recorder plugin via `--plugin-dir`, a body-only recording proxy in
front of ZAI's Anthropic endpoint, model `GLM-5.3-FLASH`). The user's real `~/.claude` was never
read or written. **[U]** is unverified and carried as a known limit.

## Problem

Claude Code delivers facts at session start (bootstrap) and on each genuine user turn
(`UserPromptSubmit`). An agent that then works on its own for many model steps only sees the facts
that matched the user's opening request. INTENT's third step, "During autonomous work", asks that
what the agent does (the file it reads or edits, the command it runs, the pattern it searches) can
trigger a relevant fact, under the same rules.

## User decisions (binding)

1. **Rate:** one CT call per model step, and only on an activity-key change.
2. **Query:** the bare target, built only by the shared Hermes builder
   (`ct_wisdom_activity.activity_for` / `query_for`). Every vector in
   `tests/fixtures/activity_targets.json` (290) and the golden `tests/fixtures/activity_blocks.json`
   must pass through the Claude Code binding.
3. **Size:** 1 fact, ≤ 600 chars per activity delivery.
4. **Subagents included.** This changes claude-code's main-thread-only policy (leg D6) for
   activity delivery; Phase 0 verifies whether `PostToolBatch` fires in subagents and with which id.
5. **Scheduled and background runs included.**
6. **CT tools never trigger.**
7. **No ceilings** (no per-message or per-session cap).
8. **The resume/fork OFF latch applies to activity delivery too.**
9. **Known limit:** curated-thoughts#282 (concept rules are out of reach from a path alone).
10. **From the DSH final review:** query only for approved calls (in Claude Code the batch's
    executed calls); delivery never starts a plan where a prefetch design is used; release the key
    on a post-start failure, keep it on `no_match` / `deduped`.

## Phase 0: verified host facts (2.1.301)

| # | Fact | Evidence |
|---|---|---|
| H1 | `PostToolBatch` exists and "Runs once after every tool call in a batch has resolved, before Claude Code sends the next request to the model … fires exactly once with the full batch". No matcher. | [D] "PostToolBatch"; [B] call site after the tool loop (`uMn(...)`, then the next `query`); [E] one call per batch, after the batch's `PostToolUse` hooks |
| H2 | Input: the common fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`, `effort`, `hook_event_name`) plus `tool_calls: [{tool_name, tool_input, tool_use_id, tool_response}]`. `tool_response` is the serialized content the model sees. There is **no** error, denial or "executed" flag. | [D]; [B] `tool_calls: Ot.map(Q => ({tool_name, tool_input, tool_use_id, tool_response: se.get(Q.id)}))` over every `tool_use` block of the assistant message; [E] |
| H3 | **Denied calls are in the batch.** A call a `PreToolUse` hook denied arrives with `tool_response = "PreToolUse:Bash hook error: <reason>"`, and neither `PostToolUse` nor `PostToolUseFailure` fires for it. A call that ran and failed (`curl` exit 6) fires `PostToolUseFailure` and is in the batch as `"Exit code 6"`. Denial texts have many shapes (user rejection, rule denial, plugin denial, classifier, hook). | [E] runs 2 and 4; [D] PostToolUseFailure note ("doesn't fire for … a permission denial"); [B] several denial message constants |
| H4 | **Subagents:** `PostToolBatch` fires inside a subagent with the **parent's** `session_id` plus `agent_id` / `agent_type` (`general-purpose`), including background subagents. Its `additionalContext` reaches the subagent's next model request and is saved in `subagents/agent-<agent_id>.jsonl`. | [E] run 1 (A1 closed) |
| H5 | A subagent's requests do **not** contain the main thread's `SessionStart` or `UserPromptSubmit` context; the main thread's `Agent` tool result can quote text (markers included) that the subagent saw. | [E] run 5 |
| H6 | Placement: the context becomes a message right after the batch's `tool_result` message, text `PostToolBatch hook additional context: <ctx>`, with an ephemeral `cache_control`; the system prompt is untouched; the marker bytes arrive intact. | [E] proxy-recorded request bodies; [D] "next to the tool result" |
| H7 | Persisted as an `attachment` record `hook_additional_context` (`hookEvent: PostToolBatch`) in the session JSONL; on `--resume` the saved text is **replayed** at the same position and the hook is not re-run for past batches. | [E] runs 1 → 2; [D] "replays the saved text rather than re-running the hook" |
| H8 | `systemMessage` from `PostToolBatch` is shown to the user (`PostToolBatch says: …`; in `stream-json` a `system`/`informational` line) and never appears in any request. | [E] runs 1, 2 (0 occurrences in request bodies) |
| H9 | `async: true`: the output reached the **next model request** of the same turn when the process finished first (A2 closed for that case). The docs say "on the next conversation turn", and `timeout` is not enforced for async hooks. Ordering against the next request is not guaranteed. | [E] run 1 (`P0-ASYNC-1` in request 2); [D] "How async hooks execute" |
| H10 | Command-hook default timeout is 600 s, so the plugin sets its own. | [D] common fields |
| H11 | When a batch ends the turn (a tool that requests end-of-turn, such as an MCP end-turn or `SubagentHandback`), the batch hook runs but its context is dropped ("PostToolBatch block discarded"). | [B] `Cm(...)` end-turn path; [E] the subagent's last batch was never in a request |
| H12 | Tool inputs: `Read{file_path}` (absolute or relative), `Write{file_path, content}`, `Edit{file_path, old_string, new_string, replace_all}`, `Grep{pattern, path, …}`, `Glob{pattern, path}`, `Bash{command, description}`. Payload `cwd` is the session working directory. | [E] runs 1–4 |
| H13 | `PostToolUse` / `PostToolUseFailure` hooks of a batch run **before** its `PostToolBatch`. | [E] every run; [B] call order |
| H14 | Compaction drops pre-boundary context except the summary (leg F13); `/clear` mints a new session id (leg F12); `--resume` keeps the id and fires `SessionStart(resume)` (leg F11, [E] run 2). | [E] |

Closed against the investigation: A1 (fires in subagents, parent `session_id` + `agent_id`) and A2
(async output can reach the next model request, but without an ordering guarantee). **Not used:**
async hooks (H9) and `PostToolUse`-only coalescing (`PostToolBatch` exists and can inject, so the
fallback in the brief is not needed).

## Design

### Overview

```
PostToolUse / PostToolUseFailure (matcher: Read|Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob)
  └─ record tool_use_id as EXECUTED in the session store (D3)

PostToolBatch (main thread and subagents; one process per model step)
  ├─ store missing / state off (resume, fork, clear_same_id)  → nothing (D9)
  ├─ note ids from CT recall results in the batch (D8)
  ├─ activities: executed, non-CT calls, Hermes builder (D4, D5)
  ├─ first activity whose key is new for this agent → claim key (locked)
  ├─ ct (cached path) → `ct wisdom match --max 1 <bare target>`  (≤ 9 s, D10)
  ├─ re-read store (locked): first candidate not in the session ledger → record → write
  └─ emit hookSpecificOutput.additionalContext = activity block (+ systemMessage if verbose)
```

### D1. Vendored builder, binding module, parity

- `integrations/claude-code/scripts/ct_wisdom_activity.py` is a **byte-identical copy** of the
  Hermes 0.6.9 module. `tests/tools/test_shared_script_parity.py` adds it to `IDENTICAL_EXTRA` for
  claude-code, so any Hermes change forces a re-copy. Only its builder (`activity_for`,
  `query_for`, `is_ct_tool`), `Activity`, `render_candidates`, `render_activity_block`, the
  constants and `reset_state` are used. Its Hermes thread prefetch and hook callbacks are never
  called (so "delivery never starts a plan" holds trivially: there is no prefetch in this host).
- `integrations/claude-code/hooks/ct_wisdom_cc_activity.py` only **translates** a Claude Code
  call into the Hermes call with the same meaning (D4), exactly like Docker Agent's
  `ct_wisdom_da_activity.py`. The target rules (privacy amendments 1–7, P1 project root, P2 names,
  P3 command allowlist, search allowlist) therefore have one source. `ct_wisdom_cc_activity` joins
  `tools/ct_ci_policy.py`'s `STDLIB_ALLOWLIST`.

### D2. Trigger and channel: `PostToolBatch` `additionalContext`

`PostToolBatch` is the per-model-step hook (H1): one process, one decision, at most one CT call per
batch. Its `additionalContext` lands after the step's tool results (H6), is persisted and replayed
on resume (H7), and never touches the system prompt (rule 2). The hook is synchronous (H9: async
output has no ordering guarantee and no enforced timeout).

*Alternatives rejected:* `PostToolUse` with coalescing (fires per tool and in parallel; needs an
in-flight window across processes); `async: true` (H9); a `PreToolUse` prefetch in a separate
process handing results to the batch through the store (extra spawn and moving parts for a saving
the ct cache already gives, and it would query before approval, which decision 10 forbids).

### D3. Approved calls only: the executed record

H3 shows the batch also carries calls that never ran (denied by the user, a rule, a hook, a
classifier). Decision 10 allows an activity only from approved calls. There is no flag in the batch,
the denial texts have many shapes, and the transcript is off limits (leg D3), so the plugin records
the evidence itself: a `PostToolUse` and a `PostToolUseFailure` hook with the exact-name matcher
`Read|Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob` (the tools that can have an activity, D4)
append the call's `tool_use_id` to the store's `executed` list (the last 256) under the store lock.
`PostToolUseFailure` counts, because a command that ran and failed (`pnpm test` exit 1) is work the
user approved, and often the moment a fact helps; the docs say it never fires for a denial (H3).
Both run before the batch hook (H13). `PostToolBatch` builds activities only from calls whose
`tool_use_id` is in `executed`. A missing record (lock timeout, no store) means no activity from
that call (fail closed). The ids are validated (`[A-Za-z0-9_-]{1,128}`).

Cost: one short Python process per such tool call (no CT call; a store lock and write). Named in
"Known limits".

### D4. Activity map (`hooks/ct_wisdom_cc_activity.py`)

| Claude Code tool | Hermes call | Verb |
|---|---|---|
| `Read{file_path}` | `read_file{path}` | `read` |
| `Write{file_path, content}` | `write_file{path}` (never `content`) | `write` |
| `Edit{file_path, …}`, `MultiEdit{file_path, …}` | `patch{path}` (never the strings) | `edit` |
| `NotebookEdit{notebook_path, …}` | `patch{path}` | `edit` |
| `Grep{pattern, path}` | `search_files{pattern, path}` | `search` |
| `Glob{pattern, path}` | `search_files{pattern, path}` | `search` (the allowlist drops `*`, `?` and `/`, so most globs send nothing) |
| `Bash{command}` | `terminal{command}` | `run` |

Every other tool (`Agent`, `WebFetch`, MCP tools, `TodoWrite`, …) has no activity. Only the listed
args are passed; the Hermes builder runs with `cwd = payload["cwd"]` and the hook's environment (user
names, `HOME`). The CT query is `query_for(activity)`: the bare target, ≤ 300 chars, through
`ct_ledger.strip_forged`. The shared vectors and the golden blocks run through this binding.

### D5. Rate rule: one call per batch, on a key change, per agent

Per batch, the candidates are the executed, non-CT calls in batch order whose activity has a
non-empty query. Under the store lock, the first candidate whose key is not in **this agent's**
recent keys (the last 32, the Hermes `RECENT_KEYS_MAX`) wins: its key is recorded and the lock is
released. If none, nothing happens (`seen_key` / `no_activity`, not recorded in verbose). The
other calls' new keys stay unseen and can trigger in a later step (Hermes limit 2). One batch is one
model step (H1), so this is "one CT call per model step on an activity-key change" (decision 1),
with no ceiling (decision 7).

- The key is the Hermes key (`(verb class, target or local digest)`, file verbs folded).
- Recent keys live per agent: `agents[<agent_id or "">]` in the session store, LRU-bounded at 128
  agents (the main thread is never evicted; an evicted subagent loses its rate state, never the
  session ledger, see D8).
- **Release on a post-start failure** (DSH final review): when the started query gets no genuine
  answer (discovery miss, probe timeout, capability missing, budget, timeout, exit, spawn,
  parse error, an unexpected exception), the key is removed again under the lock, so the next step
  can retry it. CT's "nothing relevant" (`zero_hits`: `no_match`, `deduped`) **keeps** the key.

### D6. The block

`render_candidates(entries, corrections, ledger)` then `render_activity_block(item, superseded,
activity)`, both from the vendored Hermes module, so the bytes equal the golden fixture:

```
## Curated Thoughts — relevant to this step
_for: read src/billing/invoice.py_

<!-- ct-fact:<id> --> **<title>** (provenance: <provenance>)
<text, truncated with … to fit>
```

1 fact (`ACTIVITY_MAX_PER_STEP`), ≤ 600 chars (`ACTIVITY_MAX_BLOCK_CHARS`), marker first.
Corrections ride only when they supersede an id in the ledger. The block is the whole
`additionalContext`; Claude Code adds its own `PostToolBatch hook additional context:` prefix (H6).

### D7. Ledger and write-before-emit

The store gains `activity_ids` (activity deliveries), `executed` (D3), `agents` (D5, D8) and
`evicted_agents` (D8). The ledger
becomes `bootstrap_ids ∪ live_ids ∪ tool_ids ∪ activity_ids`; `order` stays the newest-first exclude
source, so the user-turn path also excludes activity ids. The match runs outside the lock; the
store is re-read under the lock, the first candidate whose id is not in the **current** ledger is
rendered, `activity_ids` / `order` are written, and only then is the block emitted (leg D4:
at-most-once; a killed hook loses a fact, never repeats it).

### D8. Subagents share the session's ledger (decision 4)

Subagents get activity delivery (H4). Their `session_id` is the parent's, so every event of a
session tree reads and writes one store. The ledger is **shared** across the main thread and all
its subagents:

- A fact delivered to a subagent can reach the main thread in the subagent's report, verbatim or
  paraphrased (H5), and a fact the main thread has can reach a subagent in the prompt the main
  model writes. A per-agent ledger would let either show it twice in one context. A shared ledger
  shows each fact at most once in the whole tree. The cost is a fact a subagent saw is not later
  delivered to the main thread (and the reverse), a loss in the direction INTENT rule 1 prefers.
- **Stubs follow each context, deliveries follow the tree.** Each agent's entry in `agents` (""
  for the main thread) also lists the ids in **its own** context: its activity deliveries and
  its recall ids. A CT recall result is stubbed only for ids in the calling agent's own context
  (`context_ids`): for a subagent, its own ids; for the main thread, the ledger minus ids only
  subagents got. Every new recall id is recorded in the shared `tool_ids` and in the agent's
  own list. So a subagent's recall never hides a main-thread fact it cannot see (leg D6's reason,
  kept), the main thread never sees a stub for a fact only a subagent got, and a fact already in
  a context is stubbed there (the randomized test found the duplicate an unstubbed subagent
  recall of its own activity fact would cause). The tracker holds 128 agents; an evicted
  subagent's id is remembered (1024) and its later recalls are stubbed against the whole ledger
  (the safe side).
- The batch hook also notes the ids of any CT recall result in its own `tool_calls` (the
  `wiki_entries` ids of a `*__curated_recall_context` response) before it renders, so a recall
  whose `PostToolUse` hook timed out still joins the ledger before an activity fact could repeat it.
- `UserPromptSubmit` and the bootstrap stay main-thread only (unchanged; a subagent's first prompt
  never fires `UserPromptSubmit`, leg F4).

### D9. The latch, compaction, clear, missing stores (decision 8)

- Activity delivery needs the session store with `state == "on"`. `resume`, `fork`, `clear` with a
  known id and unknown sources latch it OFF for life (leg D7), so a resumed or forked session gets
  no activity delivery anywhere in its tree, subagents included. No store (no
  `CLAUDE_PLUGIN_DATA`, a session started before the plugin, a failed seed) means nothing.
- `compact`: delivery continues; the ledger is untouched, so an activity fact compacted away is
  never delivered again (the loss INTENT allows; same as OpenCode, Docker Agent and this host's
  live path).
- `/clear`: a new session id, a fresh store (leg F12).
- Old 0.3.x stores (same `v`, without the three new fields) load with empty defaults: their ledger
  is still exact, so a session that spans the plugin upgrade keeps working.

### D10. Latency: ct cache and one wall budget

Each hook is a fresh process. The persisted Docker Agent ct cache (D9 there) is ported into the
adapter: `<data>/wisdom/ct.json` holds the accepted `ct` path, its size and mtime, whether
`wisdom match` exists, and a digest of the discovery view (`PATH`, `HOME`, `USERPROFILE`,
`LOCALAPPDATA`), valid 24 h. A hit skips the identity probe and the `match --help` probe; a `spawn`
failure deletes it. The activity path uses it; the user-turn path is unchanged.

One wall budget for every CT step of a batch, `ACTIVITY_CT_BUDGET = 9 s`: a step starts only when
its own timeout still fits (identity probe 3 s, capability probe 3 s, match 3 s). A match that no
longer fits is not started: class `budget`, a breaker failure (Docker Agent's rule for a slow CT),
and the key is released. With two bounded lock waits (2 s each) and interpreter start, the worst
case stays under the hook timeout of **15 s** in `hooks.json`. The executed-record hooks get 5 s.
The persisted breaker (3 timeout/exit failures ⇒ 300 s pause) is shared with the user-turn path.

### D11. Verbose mode

`CT_WISDOM_VERBOSE=1`: each activity delivery and each started query that delivered nothing is
recorded through `ct_wisdom_verbose` with `host: "claude-code"`, `channel: "activity"`, `query`
(the bare target), `activity` (the label), `result`, `ledger`, `delivered` and `block` (the shared
recorder's allowlist keeps exactly these; it is not edited); `breaker_open` for a would-be trigger
is recorded once per batch. Rate and filter
skips (`no_activity`, `ct_tool`, `not_executed`, `seen_key`) are not. The notices become the
batch hook's top-level `systemMessage`, which the user sees and the model never does (H8). The
`hookSpecificOutput` is byte-identical with verbose on or off (tested), and with verbose off
nothing is written.

### D12. Scheduled and background runs (decision 5)

The activity path has no provenance check: a `/loop` iteration, a scheduled prompt, a background
subagent or a headless `claude -p` run gets activity delivery like any session, as long as its
session store is on. (The user-turn provenance filter of leg D5 is unchanged.)

## Fail-closed table

Every row means: no `additionalContext`, one debug line, verbose record where noted.

| Class | Where | Meaning |
|---|---|---|
| `no_payload` | batch | not a JSON object, no `session_id`, `tool_calls` not a list |
| `no_data_dir` / `no_store` | batch, executed | no `CLAUDE_PLUGIN_DATA`, or no valid store |
| `delivery_off` | batch | latched OFF (resume, fork, clear_same_id, unknown source) |
| `ct_tool` / `no_activity` / `not_executed` / `seen_key` | batch | rate and filter rules (not recorded) |
| `breaker_open` | batch | persisted breaker open (recorded once per batch) |
| `discovery_miss`, `probe_timeout`, `capability_missing` | batch | as Hermes (recorded; key released) |
| `budget` | batch | the match no longer fits the 9 s budget (recorded; breaker failure; key released) |
| `timeout`, `exit`, `spawn`, `parse_error` | batch | as Hermes; timeout/exit feed the breaker (recorded; key released) |
| `store_changed` | batch | the store went missing or OFF while CT ran |
| `zero_hits` → `deduped` / `no_match` | batch | nothing new survived the ledger (recorded; key kept) |
| `lock_timeout` | any | the store lock was not taken within 2 s |
| `hook_failed` | any | unexpected exception, caught; exit 0 |

## Exactly-once argument (rule 1)

- Ids enter the session ledger only from: the rendered bootstrap (`scan_ids` of sanitized text),
  validated ids of delivered items (live and activity), and validated `wiki_entries` ids of CT
  recall results (main and subagents, `PostToolUse` and the batch). Fact text is never scanned.
- Every activity delivery renders against the ledger **re-read under the lock** and records its id
  in the same locked write that precedes the emit. Concurrent writers (a background subagent's
  batch, the main thread's batch, a `UserPromptSubmit`, a recall dedup) serialize on that lock.
- The ledger is shared by the whole session tree (D8), so no fact is delivered twice to any context
  in it, including through a subagent's report.
- Resumed and forked sessions, whose visible ids are unknowable, are OFF (D9). Compaction keeps
  the ledger (a loss, never a repeat). A new `/clear` id is a new, empty context.
- The block is persisted and replayed byte-identically (H7); the system prompt is never edited.

## Alignment with INTENT.md

- **Goal, "During autonomous work":** this is that step for Claude Code. INTENT's four open
  questions get host answers: the event (`PostToolBatch`, per model step), the query text (the
  bare target from the shared Hermes builder), the rate (once per step on a key change) and the
  channel (`additionalContext` next to the tool results, persisted and cache-safe).
- **Rule 1 (once):** shared session ledger, write-before-emit under the lock, marker-first block,
  OFF latch for restored sessions, recall ids recorded from subagents too.
- **Rule 2 (never edit the system prompt):** the channel is appended after the tool results (H6).
- **Rule 3 (no superseded fact):** CT filters at match time; corrections only when they supersede
  an id in the ledger (shared renderer).
- **Rule 4 (fail quietly):** every class above is silent; 9 s budget under a 15 s hook timeout; the
  persisted breaker; the process always exits 0.
- **Rule 5 (provenance):** the shared renderer labels every fact.
- **Rule 6 (keep it small):** 1 fact, ≤ 600 chars per activity delivery; no session cap (PR #49);
  limits not raised for weak matching.
- **Rule 7 (read only, through CT's commands):** `ct wisdom match` only; the transcript is never
  opened; the plugin writes only its own store and log.
- **Rule 8 (relevance is CT's):** the builder renders the action and never scores; CT's gate
  decides; no query expansion (known limit 1, curated-thoughts#282).
- **Privacy ("private, local-first"):** only approved calls (D3), only the Hermes allowlisted
  targets; tool output, file contents, diffs and the agent's text never reach CT.
- **Departures:** none. The leg's main-thread-only policy (D6) changes for activity delivery by
  user decision 4; INTENT asks every host to reach every step, and Claude Code now does.

## Known limits

1. **Concept rules are out of reach from a path alone** (A6; curated-thoughts#282). Facts that
   name the file or command arrive; a rule about a concept reached only through a path does not.
2. **One line per step:** only the first new key of a batch queries; others can trigger later.
3. **Shared ledger loss:** a fact a subagent got is not delivered to the main thread later, and
   the reverse (D8).
4. **End-turn batches** (H11): a batch that ends the turn drops its context; the fact is recorded
   and lost, never repeated.
5. **Latency:** one Python process per activity-tool call (the executed record, D3) and one per
   batch, plus up to 9 s of CT time when a batch triggers (usually one ≤ 3 s match once the ct cache
   is warm).
6. **Restored sessions get nothing** (resume/fork OFF latch, decision 8), subagents included.
7. **Compaction** never re-delivers an activity fact it removed (store ledger).
8. **Paraphrase:** a fact a model rewrote without its marker in a prompt or report is invisible to
   any ledger (the leg's residual 4e). The shared ledger closes the marker-free path only for facts
   we delivered or recall returned.
9. **Files outside a project root** (no `.git`, `pyproject.toml`, …, or
   `.curated-thoughts-project`) give no activity (privacy amendment 4).

## Testing (stdlib `unittest`, `integrations/claude-code/tests/`)

- `test_activity_cc.py`: the binding map per tool; untranslated args never reach the builder; all
  290 shared vectors through the binding (each in its own fake filesystem world, the
  `key_distinct_from` pairs, the `_for:` label); the 6 golden blocks byte-for-byte; the Hermes
  secret-safety cases ported to Claude Code names; CT tools never trigger.
- `test_activity_delivery_cc.py`: one fact marker-first ≤ 600 chars; one query per batch; key
  change and file-verb folding; executed-only (a denied call never queries); per-agent keys;
  subagent delivery under the parent session; shared ledger (subagent recall recorded, not
  stubbed; a main-thread fact never re-delivered in a subagent and vice versa); the latch
  (resume, fork, clear_same_id ⇒ nothing, subagents included); compact continues; key release on
  every post-start failure and kept on `zero_hits`; budget; breaker; ct cache hit/miss/spawn;
  old-store migration; marker hygiene (forged markers in fact text never enter the ledger; queries
  never contain markers or headings); verbose on ⇒ `systemMessage` plus a JSONL record and a
  byte-identical `hookSpecificOutput`; verbose off ⇒ no file; `main()` exits 0 on garbage.
- `test_exactly_once_cc.py`: the randomized property test gains activity batches (main and
  subagents, executed and denied calls) interleaved with user turns, recalls, compaction, resume
  and both `/clear` branches; no fact id is ever visible twice in any context of a tree.
- `test_hook.py`: the `hooks.json` contract (events, matchers, timeouts; the 15 s batch timeout is
  above the internal budget).
- `tests/tools/test_shared_script_parity.py`: the claude-code copy of `ct_wisdom_activity.py`.

**E2E (live, isolated):** real `claude` 2.1.301 with the plugin via `--plugin-dir`, isolated `HOME`
/ `CLAUDE_CONFIG_DIR` / `CURATED_BRAIN_DIR`, the real CT 3.5.1 gate (scratch brain, OpenRouter
embedder, ZAI Librarian), ZAI `GLM-5.3-FLASH`, a work dir with `.git`. Checks: the Hermes five
((1) an activity block once with its marker, (2) no re-query on a repeated key, (3) a `Write`
result still lands, (4) no query from CT tools, (5) CT receives the bare target), plus the latch
(a `--resume` gets no activity query) and verbose (`systemMessage` shown, request bodies unchanged).

### Live e2e record (2026-10-17)

Real `claude` 2.1.301, this plugin via `--plugin-dir` (the worktree tree), isolated `HOME` /
`CLAUDE_CONFIG_DIR` / `CURATED_BRAIN_DIR` under the session scratchpad, a body-only recording
proxy in front of `https://api.z.ai/api/anthropic`, model `GLM-5.3-FLASH`, the real CT 3.5.1
`ct` behind a pass-through tap that logs only `wisdom match` argv and output, a scratch brain
(external `qwen/qwen3-embedding-4b` embedder via OpenRouter, `instr1` scheme, facts deposited by
the ZAI Librarian), the real `curated-thoughts-mcp` sidecar, a work dir with `.git` and a
`TASK.md`: `pnpm test`, `pnpm test --silent`, a foreground subagent that writes and then reads
`.env.local`, then `curated_recall_context("pnpm test")`. Verbose mode on.

1. **Block once, marker first:** two activity deliveries, each in exactly one request position
   and never twice in any request: `pnpm test` → *"pnpm is the package manager and test runner
   …"* (0.809) on the main thread, `.env.local` → *".env.local is listed in .gitignore."*
   (0.787) **inside the subagent** (parent `session_id`, its `agent_id`, its query excluding the
   main thread's fact: the shared ledger).
2. **No re-query on a repeated key:** `pnpm test --silent` and the `Read .env.local` after the
   `Write` caused no CT call (four `wisdom match` calls in all: the user turn, `TASK.md`,
   `pnpm test`, `.env.local`).
3. **The write landed:** `.env.local` contains `FOO=bar`; the tool result was not touched.
4. **CT tools never trigger:** the recall made no CT call; its copy of the delivered pnpm fact
   came back stubbed (the main thread's own context).
5. **CT received the bare targets:** `TASK.md`, `pnpm test`, `.env.local`, each `--max 1`.
6. **Latch:** `--resume` of the same session: state `off` (`resume`), zero `wisdom match` calls,
   and the run-1 activity block replayed byte-identically at its original position.
7. **Verbose:** `PostToolBatch says: Curated Thoughts wisdom: delivered 1 fact (373 chars) …
   [activity]` shown to the user, JSONL records with `channel: activity`; no notice text in any
   request body.

A scan of every output and config file found neither key.

## Versioning and docs

claude-code **0.4.0** (`integration.yaml`, `.claude-plugin/plugin.json`), CHANGELOG
`## 0.4.0 — 2026-10-17`, README (the autonomous-work row, subagents, the limits), top-level README
rows via `tools/ct_ci.py readme`. Hermes and Docker Agent are not changed.

## Out of scope

- A CT activity query mode (curated-thoughts#282) or a `wisdom_match` sidecar fast path.
- Moving the ct cache into the shared `ct_hook_store.py` (it would change Docker Agent's copy; a
  follow-up can unify the two).
- Async or prefetching hooks.

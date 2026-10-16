# Intuitive Wisdom: autonomous-work delivery for Hermes — design

**Date:** 2026-10-16 · **Status:** Approved for implementation (user decisions 1–7 binding; query shape from A6) ·
**Branch:** `feat/hermes-autonomous-work-wisdom` · **Base:** `origin/main` @ `38437e6`
**Release:** hermes 0.4.3 → 0.5.0 (first host to roll out, decision 6) ·
**Query shape:** from the A6 real-gate results (PR #51)
**Builds on:** [Step-0 investigation](../investigations/2026-10-16-autonomous-work-trigger-step0-investigation.md)
(Hermes section, "Recommended common contract", target A8) and
[`2026-10-06-intuitive-wisdom-live-delivery-design.md`](2026-10-06-intuitive-wisdom-live-delivery-design.md)
(the user-turn path, ledger, breaker, `ct wisdom match` contract).

Tags: **[V]** verified in this session by reading the cited file and line at the pin.
**[U]** unverified or inferred; carried as a limitation or an e2e target.

## Problem

Today Hermes asks CT for relevant facts once per user message (`pre_llm_call`). An agent
that then works on its own for many model steps (reading files, running commands,
searching) only ever sees the facts that matched the user's opening request. INTENT's
third step, "During autonomous work", asks that the agent's own activity can trigger
relevant facts too.

## User decisions (binding, 2026-10-16)

1. **Rate.** At most one CT call per model step, and only when the activity key changes
   (a new file, command or search). No ceiling per user message, no session cap.
2. **Query.** An activity line `"<verb> <target>"`: a relative path, a search pattern, or
   for shell commands ONLY the program plus subcommand (the first two non-flag tokens).
   NEVER file contents, tool output, diffs, the agent's text or reasoning, or full command
   lines (they can hold secrets, and the text goes to the embedding provider).
3. **Subagents** get deliveries too.
4. **Scheduled and background runs** are included.
5. **Size.** 1 fact, ≤ 600 chars per activity delivery.
6. **Hermes ships first.**
7. **CT's own recall tools are never a trigger.**

## Pinned host facts (Phase 1, target A8 and friends)

Pin: `NousResearch/hermes-agent@ee8dd6c886326db4b468c2ba18d9409f123da827`
(2026-10-07), the pin of the live-delivery investigation. Read as data from a `gh api`
tarball in the session scratchpad; nothing executed, nothing committed.

### A8: `api_request_id` identifies the model step

- **[V] Where it is set.** Once per outer-loop iteration, after the preflight gate and
  before the provider retry loop:
  `s.api_request_id = agent._current_api_request_id = f"{s.turn_id}:api:{s.api_call_count}"`
  (`agent/conversation_loop.py:1652`). Retries of the same request (`_run_api_retry_loop`,
  `:1654`) therefore share one id: it names the model step, not the HTTP attempt.
- **[V] Reset per turn.** `_bind_turn_identity` sets `agent._current_api_request_id = ""`
  (`agent/turn_context.py:585`). `turn_id` is the relay id or
  `"{session_id}:{task_id}:{uuid8}"` (`:580-582`), so ids are unique per turn.
- **[V] Counter.** `api_call_count += 1` happens in `begin_iteration`
  (`agent/turn_iteration_prep.py:380`). It is decremented ("refunded") only for an
  iteration that produced no valid assistant item: preflight passes that never reached
  the provider (`agent/turn_preflight.py:111,154,179`, before `:1652` runs), a cancelled
  redirect or compression restart (`agent/turn_iteration_prep.py:445-470`), and an
  empty-response fallback hop (`agent/turn_empty_response.py:290`). A reused id therefore
  never belongs to a request whose tool calls ran.
- **[V] Read sites.** Every tool path reads the attribute at hook time:
  `tool_hook_ids()` (`agent/inline_tool_executors.py:20-28`) for the concurrent pre-hook
  (`agent/tool_executor.py:667-682`) and inline transforms (`inline_tool_executors.py:63-85`);
  `invoke_tool` for registry dispatch (`agent/agent_runtime_helpers.py:2566-2577`,
  `:2642-2652`); the sequential path (`agent/tool_executor.py:1685-1694`); and
  `handle_function_call` threads it into `_CallIds` → `hook_kwargs()` for both
  `pre_tool_call` and `transform_tool_result` (`model_tools.py:645-655`, `:779-781`,
  `:854-857`).
- **[V] Parallel tools.** A batch runs on up to 8 daemon workers
  (`agent/tool_executor.py:129`, `:1480-1481`) and the main thread waits for the batch
  and appends results in call order before the loop can issue the next request
  (`execute_tool_calls_concurrent`, `:1552-1597`; `_append_batch_results`, `:1515-1549`).
  So every call of one model response reads the same `_current_api_request_id`.
- **[V] Upstream says so.** The hook dispatcher keys concurrent callback invocations by
  `tool_call_id`, "Deliberately not `api_request_id` — one API request carries many tool
  calls" (`hermes_cli/plugins_dispatch.py:160-168`).
- **[V] Exception: abandoned workers.** A worker still running at the batch deadline is
  abandoned; the main thread writes a synthesized timeout result for its slot
  (`_unfinished_tool_result`, `agent/tool_executor.py:1494-1512`) and moves on. If that
  worker's transform fires later it may read the *next* step's id, and its returned string
  is discarded by the host. Effect on us: a fact claimed for that delivery is lost (never
  duplicated), and the late call cannot claim a step slot because slots are claimed at
  `pre_tool_call` (below).
- **[U] codex app-server runtime** (`api_mode == "codex_app_server"`) hands the whole
  turn to a subprocess before the loop (`conversation_loop.py:1622-1634`), so the id stays
  `""`. Whether its tools fire plugin hooks at all is unverified. Our rule fails closed on
  an empty id, so this runtime gets no activity delivery.

**Verdict:** `(session_id, api_request_id)` is a sound per-step coalescing key. A8 closed.

### Hook signatures, payloads and threading

- **[V] `pre_tool_call`** kwargs: `tool_name, args, task_id, session_id, tool_call_id,
  turn_id, api_request_id, middleware_trace` (+ `telemetry_schema_version`)
  (`hermes_cli/plugins.py:1971-1991`; `plugins_dispatch.py:221-223`). It fires once per
  tool execution; a blocked call never reaches the tool or `transform_tool_result`
  (`model_tools.py:940-943`). In concurrent batches the pre-hook runs on the worker thread
  inside a serializing authorization gate (`agent/tool_executor.py:711`), so it must
  return fast.
- **[V] `pre_tool_call` fails closed.** A callback that raises or exceeds
  `plugins.hook_callback_timeout` (default 30 s) **blocks the tool**
  (`plugins_dispatch.py:229-243`, `_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS = {"pre_tool_call"}` at
  `:51`; `hooks.md:396`, `:590`). Our callback therefore never raises, never blocks, and
  always returns `None`.
- **[V] `transform_tool_result`** kwargs: `tool_name, args, result, task_id, session_id,
  tool_call_id, turn_id, api_request_id, duration_ms, status, error_type, error_message`
  (`model_tools.py:845-865`; `hooks.md:453`, `:1588-1617`). All callbacks run, then the
  first `str` return wins (`model_tools.py:862`). It is timeout-bounded and fails open
  (`plugins_dispatch.py:42-48`). Each invocation runs on a daemon worker; concurrent
  invocations with different `tool_call_id` run in parallel (`plugins_dispatch.py:278-286`, gate key includes `tool_call_id`).
- **[V] What happens to the returned string.** `_commit_tool_result` runs the
  file-mutation verifier on it (`agent/tool_executor.py:1093`), which `json.loads`
  the result of `write_file`/`patch` to decide whether the write landed
  (`agent/tool_result_classification.py:44-58`). Plain text appended after a JSON object
  would make that parse fail and hide a real write from `/rollback` and `pre_verify`. Then
  `maybe_persist_tool_result` replaces a result over the per-tool threshold (default
  100 000 chars, context-scaled) with a 1 500-char **head** preview plus a file path
  (`tools/tool_result_storage.py:293-334`, `tools/budget_config.py:13-15`), and the turn
  budget can do the same to any result (`:337-360`). The channel design below handles
  both.
- **[V] Subagents.** `delegate_task` builds a child `AIAgent` with its own `session_id`
  and `parent_session_id` (`tools/delegate_tool.py:270-301`); the child runs
  `run_conversation`, so it fires `pre_llm_call` with its own session id and
  `is_first_turn=True` (`agent/turn_context.py:782-800`), and its tool hooks carry
  `getattr(agent, "session_id")` of the child on every path listed under "Read sites".
  This closes investigation target A4 for the pin.
- **[V] Scheduled runs.** Cron constructs an ordinary `AIAgent(platform="cron",
  session_id=…)` (`cron/scheduler.py:2508-2540`), and plugin hooks lazy-discover in cron
  processes (`hermes_cli/plugins.py:1867-1873`). [U] that every cron job type reaches the
  same tool executor; inferred from `run_conversation`.
- **[V] Background review forks** set `_persist_disabled = True`
  (`agent/background_review.py:1022`), which skips `pre_llm_call`
  (`agent/turn_context.py:789`). They never get a ledger, so the activity path fails
  closed there (see "Fail-closed cases").

## Design

### Overview

```
pre_tool_call (worker thread, must be fast)          transform_tool_result (worker thread)
  ├─ CT tool?            → nothing (decision 7)        ├─ CT recall tool → ct_tool_dedup (unchanged
  ├─ no ledger cached?   → nothing (fail closed)       │                    behavior, now atomic)
  ├─ activity line + key from args (never content)     └─ else: pop prefetch for tool_call_id
  ├─ key seen recently?  → nothing (decision 1)            ├─ none → return None
  ├─ step slot for (session, api_request_id) taken?        ├─ join ≤ remaining 3 s budget
  │                      → nothing (decision 1)            ├─ claim 1 fact atomically in LEDGER_CACHE
  └─ claim slot, mark key, start prefetch thread           ├─ splice block into result (marker first)
     (discover → probe → `ct wisdom match --max 1`)        └─ _record_activity_delivery(...) (seam)
```

All new logic lives in a **new Hermes-only module `scripts/ct_wisdom_activity.py`**.
The user-turn module `ct_wisdom_live.py` is not edited (a parallel verbose-mode PR adds a
call there; keeping this diff out of it avoids conflicts). The activity module imports
its public pieces: `match_wisdom`, `has_match_capability`, the shared `_BREAKER`
(looked up at call time), `EXCLUDE_MAX` and `LIVE_TIMEOUT`.

### Trigger: prefetch on `pre_tool_call`, deliver in `transform_tool_result`

- `on_pre_tool_call(**kw)` decides, under one module lock, whether this call starts a CT
  query. It never raises and always returns `None` (a raise would block the tool).
- The prefetch runs on a daemon thread: `ct_wisdom.discover_ct()` →
  `has_match_capability()` → `match_wisdom(path, query, ACTIVITY_MAX_PER_STEP,
  exclude)`. `exclude` is the session's `LEDGER_CACHE` snapshot (≤ `EXCLUDE_MAX`).
- The prefetch is stored under its `tool_call_id` (bounded LRU of 256 pending entries, so
  prefetches of blocked or crashed tools, which never reach the transform, are evicted).
- `on_transform_tool_result(**kw)` pops the entry for its `tool_call_id`, joins the thread
  for whatever is left of the budget, and delivers. A result that arrives after the
  budget is dropped; a late thread finds its entry gone and discards its result.

Delivery always rides the tool result of the call that triggered the query. Other calls
in the same step pass through untouched.

### Activity line builder and key tracker

`activity_for(tool_name, args) -> (key, line) | None`. Deterministic, no semantics, no
scoring (rule 8). Only these tools have a line; every other tool returns `None` (no
trigger). The map is for the tool names at the pin (`tools/file_tools.py:1153-1290`,
`tools/terminal_tool.py:1507`):

| Tool | Verb | Target (from args only) |
|---|---|---|
| `read_file` | `read` | `path` |
| `write_file` | `write` | `path` (never `content`) |
| `patch` | `edit` | `path` (never `old_string`/`new_string`/`patch`); patch mode without `path` → no line |
| `search_files` | `search` | `pattern`, plus ` in <path>` when `path` is given |
| `terminal` | `run` | program + subcommand (below); never the rest of `command` |

**Paths.** Normalized with `posixpath.normpath` on `/`-converted text. A relative path is
kept (leading `./` dropped). An absolute or `~` path under the process cwd becomes
relative to it; any other absolute path is reduced to its last two components
(`parent/name`), so a home directory or user name never leaves the machine. Leading `..`
components are dropped. Targets are capped at 200 chars.

**Self-trigger guard on targets.** A target containing a control character (newline,
tab), a `ct-fact:` token or a `## Curated Thoughts —` heading gives no activity, so text
copied out of one of our blocks into a tool argument can never become a query.

**Shell commands** (decision 2: only the first two non-flag tokens):

1. Tokenize with `shlex.split(command, posix=True)`; on a parse error fall back to
   `command.split()`.
2. Consider only the first simple command: stop at the first token that is a shell
   operator (`&&`, `||`, `|`, `;`, `&`, `>`, `<`, …) or contains one of `;|&<>`.
3. Skip leading `NAME=value` environment assignments (a common place for secrets).
4. The program is the basename of the first remaining token.
5. The subcommand is the next token that does not start with `-`, but only if it is
   "word-shaped": `^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$` and not credential-shaped (16+
   chars containing 3+ digits, or a known key prefix such as `sk-`, `ghp_`, `xox`,
   `AKIA`). URLs, `user:pass@host`, `$VARS`, quoted strings and assignments all fail the
   shape and are dropped. For programs whose first argument is free text or a value
   (`echo`, `printf`, `export`, `set`, `alias`, `eval`, `exec`, `env`, `sudo`, `ssh`,
   `curl`, `wget`), the subcommand is always dropped.
6. Both tokens must pass the shape rule, or there is no line.

Examples: `npm test` → `run npm test`; `npm run build` → `run npm run`;
`pytest tests/billing -q` → `run pytest tests/billing`;
`API_KEY=sk-123 python deploy.py --token x` → `run python deploy.py`;
`curl -H 'Authorization: Bearer x' https://…` → `run curl`.

**Key.** `(verb class, target)`, where the verb class folds `read`/`write`/`edit` into
`file` (reading then editing the same file is one activity). The tracker keeps the last
32 keys per session (sessions LRU 256). A key counts as seen as soon as a query is
started for it, whatever the outcome.

**The query string: the bare target** (A6 results, PR #51, investigation "A6 results").
The real CT 3.5.1 gate opened on 14/22 relevant activity lines and 0/14 near-misses and
negatives. The bare target with no verb opened best (6/7, against 4/7 for both
`<verb> <target>` and target plus hint); examples that opened: `pnpm test` 0.695,
`.github/workflows/release.yml` 0.645, `.env.local` 0.776, `src/index.ts` 0.776.
`query_for(activity)` therefore returns only the target:

- `read`/`write`/`edit`: the normalized relative path;
- `search`: the bare pattern (the ` in <path>` part stays in the key and the label only);
- `run`: program plus subcommand, under the secret-safety rules above.

It passes through `ct_ledger.strip_forged` and is capped at `ACTIVITY_QUERY_CHARS = 300`.
The verb stays in the activity **key** and in the visible `_for: <line>_` label, but is
never sent to CT. No expansion, hint or rewording is added on our side (rule 8). The
query is built only from the activity, and the activity only from the listed args.

### Rate rule: once per `api_request_id`

At `pre_tool_call`, under the module lock, the call starts a query only if all hold:

1. `session_id`, `tool_call_id` and `api_request_id` are non-empty;
2. the tool is not a CT tool (decision 7: any tool whose name ends in a
   `__curated_*` / `_curated_*` segment, starts with `curated_`, or contains
   `curated-thoughts`);
3. `LEDGER_CACHE` has an entry for the session (the user-turn hook ran in this process);
4. the breaker is closed;
5. the tool has an activity line and its key is not in the session's recent keys;
6. no query has yet been started for `(session_id, api_request_id)`.

It then marks the key seen, records the step slot (a small per-session set of recent
`api_request_id`s), and starts the prefetch. This gives at most one CT call per model
step (decision 1); no per-message or per-session ceiling exists. Because the slot is
claimed at `pre_tool_call`, calls of one step race only for the lock, and the first one
with a new key wins.

### Channel: the tool result, marker first

The block:

```
## Curated Thoughts — relevant to this step
_for: read src/billing/invoice.py_

<!-- ct-fact:<id> --> **<title>** (provenance: <provenance>)
<text, truncated with … to fit>
```

- `ACTIVITY_HEADING = "## Curated Thoughts — relevant to this step"`: distinct from the
  user-turn heading `## Curated Thoughts — relevant now`, so tests, logs and a later
  verbose mode can tell the two apart.
- The `_for:` line echoes the activity line (built from args, so nothing new is exposed).
- **Marker first.** The `ct-fact` marker precedes the title and text. If the host
  truncates the result anywhere inside the block, either the marker survives (the ledger
  sees the fact) or nothing of the fact is visible. A fact can never be visible without
  its marker, which is what rule 1 needs.
- A correction renders the same way with `— supersedes ct-fact:<old>` after the
  provenance, and survives only if it supersedes an id in the ledger (same rule as live).
- Total ≤ `ACTIVITY_MAX_BLOCK_CHARS = 600`, 1 fact (`ACTIVITY_MAX_PER_STEP = 1`), with
  the live renderer's fit / truncate-one / stop rule. Titles and text pass through
  `ct_wisdom._sanitize` (which strips forged `ct-fact:` tokens).

**Splice rule** (keeps Hermes's own parsers working, see "Pinned host facts"):

- `result` is not a `str` (multimodal) → no delivery.
- `result` parses as a JSON **object** → insert one key before the closing brace
  textually, `…, "curated_thoughts_wisdom": "<block>"}` (or `{"curated_thoughts_wisdom":
  …}` for `{}`), preserving the original bytes. Skip if the key already exists or the
  spliced text fails to parse. `write_file`/`patch` keep `bytes_written`/`success`, so the
  verifier still sees the write. The marker survives JSON string encoding unchanged
  (`<`, `!`, `-`, `:` are not escaped), and `ct_ledger.scan_ids` finds it in the raw text.
- `result` parses as JSON but not as an object (a list, a number) → no delivery.
- Anything else (plain text) → append `"\n\n" + block`.

The rewritten result enters context once, is persisted by the host like any tool result
and replayed unchanged on resume, and sits after the cached prefix: the system prompt is
never touched (rule 2) [V `hooks.md:453`; persistence per the live-delivery design].

**Self-trigger guard (structural).** The activity query is built only from tool args, and
the user-turn query only from `user_message`. Neither ever reads a tool result, so an
activity block can never be part of a later query. A marker-hygiene test enforces it.

### Ledger and exactly-once

- **Source of truth stays the transcript.** The next `pre_llm_call` rebuilds the ledger
  from `conversation_history`, which includes tool-role messages, so activity markers are
  ledgered at the next turn with no change [V `ct_ledger.history_ids` scans every role].
- **Within the turn**, the activity path uses `LEDGER_CACHE`, which `pre_llm_call` fills
  before any early return.
- **New atomic `LedgerCache.claim(session_id, ids) -> list | None`** in `ct_ledger.py`:
  under the cache's lock, return the ids not yet in the session's set and add them, or
  `None` when the session has no entry. A get-then-add pair is not enough: with 8 workers,
  an activity delivery and a concurrent CT recall (or a second activity delivery from an
  abandoned worker) could each see a fact as new and both show it.
- The activity renderer walks candidates (corrections first, then entries), claims each
  candidate's id atomically, and stops at the first successful claim that fits; a
  candidate another thread claimed first is skipped.
- `ct_tool_dedup` switches from `get` + `add` to `claim`: an entry whose id `claim` did
  not return is stubbed. Behavior is unchanged single-threaded; it becomes race-free.
- **At most once, not at least once.** Ids are claimed before the block is returned. If
  the host then discards our string (another plugin's transform won "first string",
  an abandoned worker, a tool result later replaced by a head preview that cuts the block
  before the marker), the fact is lost for now and may arrive later, after the next
  rebuild. It is never shown twice. No retry is attempted.

`ct_ledger.py` is a shared file, so the change lands byte-identically in
`integrations/claude-code/scripts/ct_ledger.py` (parity gate). Claude Code gains the
method but does not call it: no behavior change there.

### 3 s budget and breaker sharing

- One wall budget per query: `deadline = prefetch start + LIVE_TIMEOUT (3 s)`. The
  transform joins for `max(0, deadline − now)` and never waits longer. The subprocess
  itself has `LIVE_TIMEOUT` too, so a hung `ct` cannot outlive the budget by much, and the
  thread is a daemon.
- Most of the CT call overlaps tool execution, so the visible delay is
  `max(0, CT latency − tool duration)` (measured CT latency 0.44–2.07 s, p95 1.22 s, live
  investigation Step 10).
- The breaker is the **same** `ct_wisdom_live._BREAKER` the user-turn path uses:
  `timeout`/`exit` record a failure, success resets it, and `spawn` resets the discovery
  and capability caches. Three failures pause **both** paths for 300 s (rule 4).
- A join that runs out of budget is class `budget`; it does not count as a breaker
  failure by itself (the thread records the real outcome when it finishes).

### Subagents and scheduled runs

- **Subagents (decision 3):** delivered like any session. The child has its own
  `session_id`, its own first-turn `pre_llm_call` (so its own `LEDGER_CACHE` entry), its
  own key tracker and step slots [V, see "Pinned host facts"]. Parent and child contexts
  are separate, so each has its own exactly-once ledger.
- **Cron and other scheduled runs (decision 4):** delivered like any session; nothing in
  the path checks the platform.
- **Background review forks** skip `pre_llm_call`, so they have no ledger and get no
  activity delivery. That is the rule-1 fail-closed case, not a policy choice.

### Fail-closed cases

Every one means "no CT call or no delivery", one debug line
(`wisdom-activity: skip session=… class=…`), and the tool result unchanged:

| Class | Where | Meaning |
|---|---|---|
| `empty_id` | pre | no `session_id`, `tool_call_id` or `api_request_id` |
| `ct_tool` | pre | CT's own tool (decision 7) |
| `no_activity` | pre | tool not in the map, or args give no safe line |
| `no_ledger` | pre + transform | no `LEDGER_CACHE` entry: restored session, eviction, background fork |
| `breaker_open` | pre | shared breaker open |
| `seen_key` | pre | key in the session's recent keys |
| `step_used` | pre | a query already started for this `api_request_id` |
| `discovery_miss`, `probe_timeout`, `capability_missing` | prefetch | as live |
| `timeout`, `spawn`, `exit`, `parse_error` | prefetch | as live (breaker as above) |
| `budget` | transform | join ran past the 3 s deadline |
| `zero_hits` | transform | nothing new survived the ledger |
| `unsupported_result` | transform | non-`str`, JSON non-object, key collision, splice failed |
| `hook_failed` | either | unexpected exception (caught; pre returns `None`) |

### What does NOT change

- User-turn live delivery (`pre_llm_call`, 2 facts / 1200 chars, `ct_wisdom_live.py`):
  untouched, byte for byte.
- The session-start block and the system prompt (rule 2).
- `ct_tool_dedup`'s output for CT recall results (only its ledger update becomes atomic).
- Claude Code: only the shared `ct_ledger.py` copy changes; its hooks do not call
  `claim`. Its autonomous-work leg is a later spec.

### Seam for the planned verbose mode

Every activity delivery goes through one local function,
`_record_activity_delivery(event)`, called exactly once per delivered block with
`{"kind": "activity", "session_id", "fact_ids", "block", "query", "tool_name",
"api_request_id", "gate": <CT score/gate fields if present, else None>}`. It is a no-op in
this PR. The parallel verbose-mode PR adds `scripts/ct_wisdom_verbose.py` with
`record_delivery(event)`; whichever PR merges second wires the seam to it. Nothing else
in this design depends on verbose mode.

## Alignment with INTENT.md

- **Goal "During autonomous work":** this is that step for Hermes. Host events
  (`pre_tool_call` / `transform_tool_result`), query text (an activity line), frequency
  (once per model step on key change) and channel (the tool result) are the four open
  questions INTENT lists, answered for this host.
- **Rule 1 (at most once):** marker on every fact, atomic claim against the in-turn
  ledger, transcript rebuild at the next turn, marker-first rendering so truncation can
  never show a fact without its marker, fail closed without a ledger.
- **Rule 2 (never edit the system prompt):** delivery rides the tool result, an
  append-only channel.
- **Rule 3 (no superseded fact):** CT filters superseded entries; corrections ride only
  when they supersede an id in context, as on the live path.
- **Rule 4 (fail quietly):** both hooks catch everything; the pre-hook can never block a
  tool; 3 s budget; shared breaker.
- **Rule 5 (provenance):** same provenance label as live.
- **Rule 6 (keep it small):** 1 fact, ≤ 600 chars per delivery (decision 5), no
  per-session cap, consistent with PR #49. Limits are not raised to compensate for weak
  matching.
- **Rule 7 (read only, through CT's commands):** `ct wisdom match` only.
- **Rule 8 (relevance is CT's):** the line builder renders the action and never scores,
  expands or ranks; CT's gate decides.
- **User decisions 1–7:** decision 1 → "Rate rule"; 2 → "Activity line builder" and the
  secret-safety tests; 3 and 4 → "Subagents and scheduled runs"; 5 → constants; 6 → this
  spec; 7 → `ct_tool` class.
- **Departures:** none. INTENT says every host should reach every step; Hermes now does.

## Known limitations

1. **Concept rules are out of reach from a path alone (A6).** The gate never reached a
   concept-level rule from a path: migration paths stayed closed at ≤ 0.59 while the
   plain question scored 0.897, and lowering the floor would admit near-misses (up to
   0.601). Concept rules reached only via paths need CT activity mode
   ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)),
   not in this PR. Per rule 8 we add no query expansion or hints.
2. **One line per step:** only the first call with a new key in a step triggers; the
   other calls' new keys stay unseen and can trigger in a later step.
3. **First-string-wins:** if another plugin's `transform_tool_result` returns a string
   first, our block is dropped (the fact is lost, never duplicated).
4. **Large results:** a result the host replaces with a head preview loses the block
   (marker-first keeps this safe).
5. **codex app-server runtime and background review forks:** no activity delivery.
6. **Process-local state:** step slots, keys and prefetches live in the process; a gateway
   restart mid-turn simply fails closed (`no_ledger`).

## Testing

All stdlib `unittest`, in `integrations/hermes/tests/`:

- `test_ct_wisdom_activity.py`
  - line builder per tool, path normalization, search lines;
  - **secret safety:** randomized and hand-picked commands with env assignments, flags,
    tokens, URLs with credentials, quoted strings, pipes; the query never contains any
    token beyond the first two non-flag ones, never an `=`, `@`, `:`, `$` or quote, and
    never `content` / `old_string` / `new_string` / `patch` text;
  - key tracker (fold, LRU, per-session);
  - rate rule (one start per `api_request_id`, key change, empty ids, CT tools);
  - prefetch / join / budget; breaker sharing;
  - splice rule (JSON object, `{}`, JSON list, plain text, non-str, key collision,
    `write_file` result still "landed" after splice);
  - fail-closed classes, and that `on_pre_tool_call` returns `None` even when internals
    raise;
  - verbose seam called exactly once per delivery with the documented keys.
- `test_ct_ledger.py`: `claim` (new ids only, `None` without entry, thread race).
- `test_ct_tool_dedup.py`: unchanged expectations, plus a race with a concurrent claim.
- `test_exactly_once.py`: a new randomized property test interleaving user-turn
  deliveries, activity deliveries from parallel tool batches on real threads, agent CT
  recalls, compaction and restore; no fact id is ever visible twice in current context.
- **Marker hygiene:** the activity query never contains `ct-fact:` or the activity
  heading, the user-turn query ignores tool results, activity markers are found by
  `history_ids` in tool-role messages (raw text and JSON-spliced), and in every rendered
  block the marker precedes the title and text.
- `tests/tools/test_shared_script_parity.py` stays green (claude-code copy of
  `ct_ledger.py`).

E2E on a scratch `HERMES_HOME` (never the live profile or brain) is wanted but optional on
this machine; if not run it is recorded as pending in the PR.

## Versioning and docs

- hermes `0.4.3 → 0.5.0` (`plugin.yaml`, `integration.yaml`), CHANGELOG `## 0.5.0 — <date>`,
  README (the Intuitive Wisdom section and limitations), README table regenerated with
  `tools/ct_ci.py readme`.
- claude-code: patch bump only if the policy gate requires it for the shipped `ct_ledger.py`
  change, with a CHANGELOG note "no behavior change".

## Out of scope

- Other hosts' autonomous legs (DSH, OpenCode, Claude Code, OpenClaw).
- Verbose mode itself (only the seam).
- A CT-side activity query mode or batch form (investigation "CT-side support").

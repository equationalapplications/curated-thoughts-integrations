# Intuitive Wisdom: autonomous-work delivery for Hermes — design

**Date:** 2026-10-16 · **Status:** Approved for implementation (user decisions 1–7 binding; query shape from A6) ·
**Branch:** `feat/hermes-autonomous-work-wisdom` · **Base:** `origin/main` @ `38437e6`
**Release:** hermes 0.6.0 (planned as 0.5.0; verbose mode, PR #53, took 0.5.0 first) (first host to roll out, decision 6) ·
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

> Superseded in hermes 0.7.0 by "Amendment 8: approval-gated query": the query now
> starts in `transform_tool_result`; `pre_tool_call` only claims the step.

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
| `search_files` | `search` | `pattern` (no line if any word of it is credential-shaped), plus ` in <path>` when `path` is given |
| `terminal` | `run` | program + subcommand (below); never the rest of `command` |

**Paths.** Normalized with `posixpath.normpath` on `/`-converted text. A relative path is
kept (leading `./` dropped). An absolute or `~` path under the process cwd becomes
relative to it; any other absolute path is reduced to its last two components
(`parent/name`), so a home directory or user name never leaves the machine. Leading `..`
components are dropped. Targets are capped at 200 chars.
*(Superseded for paths and search patterns by the "Privacy amendment (2026-10-16,
hermes 0.6.2)", "Privacy amendment 2" (0.6.3) and "Privacy amendment 3" (0.6.4) sections below,
all replaced for paths by "Privacy amendment 4: project-root allowlist" (0.6.5): the
two-component rule leaked user names.)*

**Self-trigger guard on targets.** A target containing a control character (newline,
tab), a `ct-fact:` token or a `## Curated Thoughts —` heading gives no activity, so text
copied out of one of our blocks into a tool argument can never become a query.

**Shell commands** (decision 2: only the first two non-flag tokens):

1. Tokenize with `shlex.split(command, posix=False)`, which keeps quote characters in
   the tokens, so a quoted value (`grep "SecretPassword"`) fails the word shape below and
   is never sent (CodeRabbit, PR #52). On a parse error fall back to `command.split()`.
2. Consider only the first simple command: stop at the first token that is a shell
   operator (`&&`, `||`, `|`, `;`, `&`, `>`, `<`, …) or contains one of `;|&<>`.
3. Skip leading `NAME=value` environment assignments (a common place for secrets).
4. The program is the basename of the first remaining token.
5. The subcommand is the token **right after** the program, and only if it does not start
   with `-`. A token that follows a flag is that flag's value (`psql -W secretpw`,
   `deploy --token x`), not a subcommand, so a flag right after the program ends the
   target at the program. This is the strict reading of "the first two non-flag tokens"
   (CodeRabbit, PR #52). The one supported exception is `python[N.M] -m <module>`, which
   gives `python3 pytest`. The subcommand must also be
   "word-shaped": `^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$` and not credential-shaped (16+
   chars containing 3+ digits, or a known key prefix such as `sk-`, `ghp_`, `xox`,
   `AKIA`). URLs, `user:pass@host`, `$VARS`, quoted strings and assignments all fail the
   shape and are dropped. For programs whose first argument is free text or a value
   (`echo`, `printf`, `export`, `set`, `alias`, `eval`, `exec`, `env`, `sudo`, `ssh`,
   `curl`, `wget`), the subcommand is always dropped.
6. Both tokens must pass the shape rule, or there is no line.

Examples: `npm test` → `run npm test`; `npm run build` → `run npm run`;
`pytest tests/billing -q` → `run pytest tests/billing`;
`python3 -m pytest -q` → `run python3 pytest`; `mysql -uroot -pX db` → `run mysql`;
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

### Verbose mode (wired; spec `2026-10-16-wisdom-verbose-mode-design.md`)

Verbose mode (PR #53) merged first, so this PR wires the seam. Every activity delivery
goes through one function, `_record_activity_delivery(event)`, which calls
`ct_wisdom_verbose.record_delivery` with `host: "hermes"`, `channel: "activity"`,
`session_id`, `query` (the bare target CT received), `activity` (the label, for example
`read src/x.py`), `result` (CT's answer, with its `gate` and scores), `ledger`,
`delivered` and `block`. `_record_activity_skip(event)` calls `record_non_delivery` with
the same fields and a `reason`.

- **Recorded skips:** every outcome of a query that ran (`budget`, the CT failure
  classes, `zero_hits` → `deduped`/`no_match`, `unsupported_result`, `no_ledger`), and,
  at `pre_tool_call`, `no_ledger` / `breaker_open` for a would-be trigger (a new key in a
  step that has not queried), at most once per step.
- **Not recorded:** the per-call rate and filter checks (`empty_id`, `ct_tool`,
  `no_activity`, `seen_key`, `step_used`). They fire on most tool calls and would flood
  the user's terminal without saying anything about wisdom.
- `ct_wisdom_verbose.build_event` gains one optional allowlisted field, `activity`
  (byte-identical in both copies). Tool args other than the target never reach the log.
- With verbose off nothing is written and the tool result bytes are unchanged (tested).

## Privacy amendment (2026-10-16, hermes 0.6.2)

An independent review found that the activity builder shipped in hermes 0.6.0 and
0.6.1 could send private data to CT (which forwards the query to the brain's external
embedding provider, e.g. OpenRouter) and show it in the `_for:` label and the verbose
log:

1. **cwd `/`.** A cwd at the filesystem root (Docker `WORKDIR /`, launchd/systemd
   services) made every absolute path "under cwd": `/Users/alice/clients/acme/contract.md`
   was sent as `Users/alice/clients/acme/contract.md`.
2. **User name.** The last-two-components rule kept the user name for files directly in
   a home directory: `/Users/alice/notes.txt` → `alice/notes.txt`; a search `path` of
   `/home/bob` → `home/bob` in the label.
3. **Search patterns.** Sent verbatim, filtered only per word by the credential shape:
   `API_KEY="hunter2pass"` and `password=letmein` were sent.

These rules replace the "Paths" paragraph and the `search_files` row above. They only
tighten; every other rule stands. The shared test vectors live in
`tests/fixtures/activity_targets.json` (`{name, tool, args, cwd, env, expected_query,
expected_line}`; `cwd` `""` means none, a null `expected_query` means no query); Hermes
runs them in `tests/tools/test_activity_target_vectors.py`. **Requirement for ports:** any
port of this builder (for example a TypeScript one in `packages/ct-wisdom-core`) MUST run
`tests/fixtures/activity_targets.json` and pass every vector. No port does so yet.
R1 and R3 below were tightened again in "Privacy amendment 2".

- **User name.** The folded (NFC, casefolded) values of `USER`, `LOGNAME`, `USERNAME`
  and the basenames of `HOME` / `USERPROFILE`.
- **R1 (cwd).** The cwd is absent when it is empty, not absolute, `/`, a drive root
  (`C:/`), of depth < 2 (`/Users`, `/home`, `/work`, `C:/Users`), or the parent of the
  user's home directory. Only a cwd at depth ≥ 2 counts; a cwd equal to `HOME` counts.
- **R2 (paths).** An absolute or `~` path (`~` expanded from `HOME`) under a valid cwd
  becomes relative to it; any other absolute, `~`, drive or UNC path is reduced to its
  **basename only**. Relative paths are kept, leading `..` dropped. Then every component
  equal to the user name is dropped, and so is `Users`/`home` when followed by one. If
  nothing remains, there is no query.
- **R3 (search patterns).** No query when the pattern contains `=`, any quote (`"` `'`
  `` ` `` and the curly quotes), a credential-shaped word, or a word R2 would change: an
  absolute, `~`, drive or UNC token, a token with a `..` component, or a token with a
  user-name component (a bare word equal to the user name included). Otherwise the
  pattern is sent (≤ 200 chars) as before. The same token check applies to a command's
  subcommand (dropped when it fails), and a program named like the user gives no query.
- **R4 (one target).** The visible `_for:` label and the verbose `activity` field are
  `Activity.line`, built from the same sanitized target as the query; a raw argument is
  never shown or logged. Tested end to end through both hooks and the verbose log.

Testing adds the shared vectors, a randomized search-pattern test and a randomized path
test (planted secrets, quotes, assignments, absolute and `~` paths, user names, every
cwd class), next to the existing 500-command secret-safety test.

## Privacy amendment 2 (2026-10-16, hermes 0.6.3)

A post-merge review of 0.6.2 ran cases through the real code and found that leaks
remained: colon, flag and bearer forms in search patterns (`password:letmein`,
`token: hunter2`, `--password hunter2`, `Bearer abc123xyz`), emails, rooted backslash
paths in patterns (`\ProgramData\corp\secrets.txt`), cwd = HOME layouts
(`/Users/alice/clients/acme/contract.md` → `clients/acme/contract.md`), Windows
drive-relative paths (`C:..\Users\alice\x.md` → `C:../x.md`), and user names embedded in
a component (`notes/alice.txt`). It also found that the user-name filter removed service
accounts (`node server.js` with `USER=node` gave no activity), and that activity keys
collided when two paths reduced to the same basename. Every case is a vector in
`tests/fixtures/activity_targets.json`. These rules replace the matching parts of the
first amendment:

- **User name.** As before, minus service accounts (`root`, `node`, `app`, `user`,
  `admin`, `test`, `ubuntu`, `runner`, `docker`, `www-data`, `nobody`, `daemon`,
  `ec2-user`, `vscode`, `codespace`) and any name shorter than 3 chars. A component that
  **contains** a user name (folded substring: `alice.txt`, `alice-notes.md`,
  `alice@corp`) is dropped, and so is `Users`/`home` before one.
- **R1 (cwd).** A cwd counts only when it is strictly inside HOME (any depth below it),
  or else at depth ≥ 2 and neither HOME, nor an ancestor of HOME, nor a
  `/Users/<x>` / `/home/<x>` home directory. HOME itself no longer counts.
- **Which cwd.** Hermes's hook payload carries no cwd. [V] It does pass `task_id`, and
  Hermes resolves file-tool paths against the task's cwd override, then the session's
  recorded cwd (`tools/terminal_tool.py::get_session_cwd`, `resolve_task_overrides`;
  used by `tools/file_tools.py::_create_terminal_env_for_file_ops` at `ee8dd6c8`), then
  `TERMINAL_CWD`. The plugin uses the same order and falls back to the gateway's
  `os.getcwd()`. It reads `tools.terminal_tool` only if Hermes has already imported it.
- **R2 (paths).** Drive-relative (`C:foo.md`, `C:..\x`) and rooted backslash (`\etc\x`)
  paths count as absolute, so they are reduced to their basename.
- **R3 (search patterns), now an allowlist.** A pattern is sent only when every char is
  an ASCII letter, digit, `_`, `.`, `-`, a space or a non-ASCII letter (Unicode category
  L*, checked on the NFC form); it is at most 80 chars (longer is refused, not cut) and
  at most 6 words; no word starts with `-`, is credential-shaped or contains a user name;
  and it does not contain `bearer`, `token`, `password`, `passwd`, `secret`, `apikey`,
  `api_key`, `api-key`, `api key` or `auth` anywhere (case-insensitive). Anything else
  sends no query. Paths and regexes in patterns (`src/billing`, `\w+`) are no longer sent.
- **Keys.** The activity key (local de-duplication only, never sent or logged) uses a
  digest of the full local path, resolved against the cwd. So `/srv/a/README.md` and
  `/srv/b/README.md` are different keys even though both queries are `README.md`.
- **Hot path.** `user_names` is computed once per `activity_for` call. (`valid_cwd`, also
  computed once here, was removed by amendment 4.)

## Privacy amendment 3 (2026-10-16, hermes 0.6.4)

A high-effort review of 0.6.3 found two more leaks and several misleading results. This
amendment prefers simpler general rules to special cases. Every case is a vector in
`tests/fixtures/activity_targets.json`. These rules replace the matching parts of
amendments 1 and 2:

- **R1 (cwd), check order.** A cwd counts only when it is at depth ≥ 2, is not a
  `/Users/<x>` / `/home/<x>` home directory, and is neither HOME nor an ancestor of HOME.
  The depth and home-directory checks come first. A HOME of depth < 2 (`/` for
  `nobody`/`daemon` and many containers, `/root`) counts as no HOME. 0.6.3 treated every
  cwd as "inside HOME=/", so with cwd `/home`, `/home/bob/secret.txt` was sent as
  `bob/secret.txt`.
- **Prefix comparison.** "Under the cwd" compares components in folded form (NFC +
  casefold), as R1 does. The sent relative part keeps its original case:
  `/Users/alice/proj/src/x.py` under cwd `/Users/alice/Proj` is `src/x.py`.
- **No `:` in any component.** Such components are dropped; if nothing is left there is
  no query. 0.6.3 sent a bare drive letter for `\\?\C:\`, `/C:/` and `/mnt/c:`.
- **Private names, one general rule.** A name is private only when it is the value of
  `USER`, `LOGNAME` or `USERNAME`, or the basename of `HOME` / `USERPROFILE` when that
  directory sits directly under `/Users`, `/home` or `C:\Users` (any case). The
  service-account list stays as an extra exemption. So `HOME=/github/home` no longer makes
  `home` private, and neither does `HOME=/opt/build` for `build`.
- **A name hit gives no activity.** If any sent path component, search word, program or
  subcommand contains a private name, the whole activity is dropped. 0.6.3 dropped only
  the component, so `src/sample.py` with `USER=sam` was sent as the misleading `src`.
  This applies to a search's `path` too.
- **Short names.** Names under 3 chars are private again. They match only a whole
  component or word, never a substring: `jo/notes.md` with `USER=jo` gives nothing, while
  `src/join.py` is sent.
- **Lazy cwd.** `session_cwd` is resolved only for file and search tools.

## Privacy amendment 4: project-root allowlist (2026-10-16, hermes 0.6.5)

**Why the heuristic approach was replaced.** Amendments 1-3 tried to decide, from the
shape of a path and of the cwd, which parts were safe to send: basename-only outside a
"valid" cwd, depth and `/Users`/`/home` checks, home-ancestor checks, drive and colon
rules, name stripping. Each review found new shapes that slipped through. A review of
0.6.4 found these:

- a WSL cwd of `/mnt/c/Users` or `/mnt/c`;
- `HOME=/` with `/var/home`, `/nfs/home` or `/export/home` layouts;
- relative climbs (`../../bob/secret.txt`);
- multi-word names (`John Smith`);
- short names inside tokens (`jo.md`, `jo-notes`);
- a HOME basename under `/nfs/home` with no `USER`.

A blocklist of shapes cannot be complete. This amendment replaces it with an
allowlist that is safe by construction. It supersedes the path rules of
amendments 1-3: `valid_cwd`, the depth and home-parent heuristics, basename
reduction and name stripping are all deleted. The shared vectors were rewritten.
They now carry an `fs` field, so any port must model the filesystem.

- **P1 (paths): project root.** A path is sent only when it resolves inside a project
  root, and it is sent relative to that root. Resolving means `realpath` (symlinks
  resolved, `..` collapsed). Components are compared NFC-normalized everywhere and
  case-folded only on case-insensitive platforms (darwin, win32); the original case is
  kept.
  - **What a root is:** the nearest directory at or above the session cwd
    (`session_cwd`, as before) holding a marker: `.git` (dir or file), `.hg`,
    `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `pom.xml`,
    `build.gradle`, `Gemfile`, `composer.json`, `*.sln` or `.curated-thoughts-project`.
  - **The walk.** It runs on the logical cwd (normalized, symlinks not resolved), so the
    stop rules see `/home/bob` even where it resolves elsewhere (`/home` on macOS is
    `/System/Volumes/Data/home`).
  - **The real root is checked again.** The root the walk finds is resolved
    (`realpath`, plus macOS's firmlink alias `/System/Volumes/Data/x` → `/x`), and
    every stop rule below is applied again to that real path, against the real forms of
    the home directories. Failing any rule, there is no root. This closes a cwd that is
    a symlink or alias into HOME, into an ancestor of HOME or into a homes location (for
    example `/work/link -> /Users/bob` with `~/.git`, which made `/Users/bob` the root).
  - **Where the walk stops (and never a root):**
    - **Home directories and their ancestors.** The home directories are `HOME`,
      `USERPROFILE`, `os.path.expanduser("~")` and `pwd`'s `pw_dir` (where available),
      each compared in both its normalized and its real form. Git Bash's `/c/Users/x`
      maps to `C:\Users\x` on Windows, here and for the cwd and path arguments. So
      with `HOME` unset, a dotfiles `.git` at the real home still sends nothing.
    - **The filesystem root** (`/`, `C:\`).
    - **Known homes locations and anyone's home in one.** The homes locations are
      `/home`, `/Users` and `/Profiles` (`C:\Users`, `D:\Profiles`); `/var/home`,
      `/nfs/home`, `/export/home` and `/data/home`; and `/mnt/<letter>/Users`. So
      `C:\Users\Alice` with a `package.json` is not a root, while
      `C:\Users\Alice\code\proj` is. A project's own `src/pages/home/components`
      folder is not a homes location, so it works.
    - **WSL drives:** `/mnt` and `/mnt/<letter>`.
    - **Other direct children of the root can be roots** (`/app`, `/workspace`,
      `D:\repo`). This makes containers work. `HOME=/` stays safe through the homes
      rules.
  - **How it runs:** `os.path` checks only, and never a subprocess. The result is cached
    (LRU) on the raw cwd, `HOME` and `USERPROFILE` strings, so a hit does no filesystem
    work. A root found is kept 30 s; "no root" is kept only 2 s, so
    `touch .curated-thoughts-project` takes effect almost at once. The fixed markers are
    checked (`lexists`, never cached) for the whole walk first. A directory is scanned for
    a `*.sln` only when it is nearer than the nearest fixed-marker hit. The scan returns
    early and is cached per directory for 30 s, so a re-walk after the 2 s "no root"
    cache does not rescan. `pwd` is looked up once (`functools.lru_cache`, cleared by
    `reset_state`). For a path argument, the cached root is looked up before any
    `realpath`, and `user_names` runs only after the tool-name filter.
  - **Everything else gives no query, not a basename:** a path outside the root
    (including through a symlink), a `~` path outside it, no cwd, no root, any `:`
    outside a Windows drive prefix, or a target longer than 200 chars (never cut
    mid-token).
  - **Behaviour change:** files outside a project get no autonomous-work wisdom. A user
    can opt a folder in with an empty `.curated-thoughts-project`.
- **P2 (names), the second layer.**
  - **Private names:** the values of `USER`, `LOGNAME`, `USERNAME` and `pwd`'s
    `pw_name`. Also the basename of `HOME`, `USERPROFILE` or `pw_dir`, but only when its
    parent is named `Users`, `home` or `Profiles`. So `HOME=/config`, `/github/home` and
    `/opt/app-root/src` make no name private. Service accounts stay exempt.
  - **Matching:** the candidate query is tokenized into runs of letters and digits
    (`[^\W_]+`, Unicode `str.isalnum`), folded, so `_`, `-`, en dashes, curly quotes, `×`
    and `÷` all split tokens (`jo–notes.md` hits for `jo`). A name
    part of ≥ 3 chars hits any token containing it; a shorter part hits only an equal
    token (`jo.md` hits for `jo`, `join.py` does not). A name with spaces or punctuation
    also hits when the folded query contains the whole folded name, and its parts are
    checked as above (`john_smith.md` hits for `John Smith`).
  - **A hit in a path, a search pattern or a command's program gives no query.** A hit
    in a command's subcommand or `-m` module sends the **program alone** (the
    user-approved behavior): the name is never sent either way.
- **P3 (commands), an allowlist.** No dots, slashes or file names are ever sent from a
  command. This closes `cat Bob/secret.txt` from cwd `/mnt/c/Users`, which bypassed P1.
  - **The program** (the basename of the first word) must match
    `^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$`, must not be credential-shaped and must not name
    the user. Otherwise there is no query.
  - **The subcommand** is sent only when it is a plain verb-like word
    (`^[a-z][a-z0-9-]{0,30}$`: `test`, `rebase`, `run-script`) for which `word_check`
    returns True (no name hit, not credential-shaped).
  - **`python -m <module>`** sends the module only when it matches
    `^[a-z_][a-z0-9_.]{0,60}$` and does not name the user.
  - **Otherwise the program alone** is sent: `pytest tests/billing` → `pytest`,
    `python deploy.py` → `python`, `cat .env.local` → `cat`.
- **P4 (search).** The allowlist stays and P2 applies to the whole pattern. A `path`
  argument goes through P1: outside the root the path part is dropped, and a name hit
  gives no query. The search key still uses the full-path digest of the `path`, even
  outside the root, so two searches for one pattern in different places stay distinct.
- **P5 (cleanup).** `_resolve` returns `(target, hit, local)` with no sentinel object. The
  session cwd is resolved only when a path argument is actually used.
- **Testing.**
  - **Vector runner:** it maps virtual absolute paths into a temp directory that models
    `/` (the `_fs_root` seam). It also supplies the process identity from the optional
    `system_user` / `system_home` fields (the `_system_identity` seam). It creates the
    `fs` entries (files, directories, symlinks), builds a `key_distinct_from` pair in one
    shared world, and checks that the vector file matches its generator,
    `tests/fixtures/make_activity_targets.py`. Case folding is platform-dependent, so it
    is unit-tested in both modes rather than vectored.
  - **Randomized path test:** it builds a real tree with projects, a symlink escape and
    markers above HOME, and asserts that every query resolves strictly inside the cwd's
    project root.

## Privacy amendment 5 (2026-10-17, hermes 0.6.6)

A post-merge review of 0.6.5 confirmed that the path rules hold, but found that commands
still leaked:
- **Words after ordinary programs.** A plain-word subcommand was sent for *any* program,
  so `rm divorce-papers`, `less medical-records`, `cd acme-merger`, `cat contract` and
  `mkdir clients` were sent verbatim.
- **Script names.** A script program sent its file name: `./acme_export.sh` or an
  absolute script path sent `acme_export.sh`.

P3 of amendment 4 is replaced by:

- **P3a (the program is a bare command).** The first word, after `VAR=value` words, must
  meet all of these:
  - no path separator, `~` or `:` (`./x`, `/abs/x`, `../x`, `~/x`, `C:\x`);
  - no dot (scripts such as `.sh`, `.py` and `.js` are never sent), with `python3.11`
    style interpreter names the one dotted form;
  - it matches `^[A-Za-z0-9][A-Za-z0-9_+-]{0,40}$`, is not credential-shaped and does
    not name the user.

  Otherwise there is no query.
- **P3b (subcommands by program allowlist, not word shape).** `program subcommand` is
  sent only when:
  - the program is in a fixed table of tools with subcommands: `git`, `npm`, `pnpm`,
    `yarn`, `bun`, `cargo`, `go`, `docker`, `podman`, `kubectl`, `helm`, `gh`, `pip`,
    `pipx`, `uv`, `poetry`, `conda`, `brew`, `apt`/`apt-get`, `dnf`/`yum`, `terraform`,
    `dotnet`, `mvn`, `gradle`, `make`, `just`, `rake`, `bundle`, `rails`, `mix`, `dart`,
    `flutter`, `swift`, `deno`, `nx`, `turbo` (not `npx` or `pytest`);
  - the subcommand is in that tool's known-verb list. For `make`, `just` and `rake` that
    list is the common targets: `build`, `test`, `lint`, `fmt`, `format`, `check`,
    `clean`, `install`, `dev`, `run`, `deploy`, `release`, `docs` and `all`;
  - the subcommand passes `word_check` (a plain verb, not credential-shaped, no name hit).

  Every other program is sent alone (`rm`, `cat`, `cd`, `less`, `mkdir`, `cp`, `mv`,
  `vim`, ...), whatever follows it.
- **P3c (`python -m`).** The module is sent only when it is in a known set (`pytest`,
  `pip`, `venv`, `http.server`, `unittest`, `black`, `ruff`, `mypy`, `build`, `twine`),
  or when its top package resolves inside the project root (a package directory or a
  `.py` file at the root or under `src/`). It must also pass the name check; otherwise
  just the interpreter is sent. The project root is looked up only for that case.
- **A HOME that is not a real user home blocks only itself.** A home blocks its
  ancestors only when it is a real user home: a child of a known homes location, or
  `pw_dir`. A sandbox or Nix `HOME` inside a project (for example `repo/.home`) no longer
  hides the project above it, but such a `HOME` is still never a root itself.
- **Simplifications.**
  - One small TTL+LRU cache helper (`_TTLCache`) serves the root, `*.sln` and homes
    caches.
  - The canonical homes are cached per (`HOME`, `USERPROFILE`, process homes), so they
    are not re-resolved with `realpath` on every call.
  - `_abs_cwd` is computed once and passed into `project_root`.
  - One platform table (`_OS`) replaces three flags.
- **Testing.**
  - The vectors are rewritten for commands, and 23 of them fail on 0.6.5.
  - `test_keys_distinct` builds each case in its own world, one after the other at the
    same path, so `fs` lists never mix and keys stay comparable. A case built twice must
    give the same key.
  - `test_exactly_once` patches the process identity with a fixed fake.

## Privacy amendment 6 (2026-10-17, hermes 0.6.7)

A post-merge review of 0.6.6 found two leaks and some cleanups.

- **`python -m` sends only the top package.** 0.6.6 checked only the top package of a
  project module but sent the whole dotted name, so
  `python -m tests.acme_merger_due_diligence` sent the submodule name. Now:
  - a module in the known set (`pytest`, `pip`, `venv`, `http.server`, `unittest`,
    `black`, `ruff`, `mypy`, `build`, `twine`) is sent as listed;
  - any other module sends only its top-level package (`python tests`), and only if
    that package (a directory or a `.py` file) exists at the root or under `src/`;
  - this lookup is cached per (root, top).
- **Every home blocks its ancestors again, with one narrow sandbox exception.**
  - **The 0.6.6 leak:** 0.6.6 let only real user homes block their ancestors. So a
    custom Windows `HOME=D:\work\home` with `D:\work\.git` made `D:\work` the root, and
    `D:\work\home\Documents\taxes.pdf` was sent as `home/Documents/taxes.pdf`.
  - **The rule now:** `HOME`, `USERPROFILE`, `expanduser("~")` and `pw_dir` all block
    their ancestors.
  - **The exception:** a home strictly inside the candidate root does not block it
    only when it is a sandbox. That means it is not a real user home (a homes-location
    child, or `pw_dir`; where there is no `pwd`, Windows, `USERPROFILE`), and it sits at
    a dot-directory directly under the root (`.home`, `.nix-home`, `.sandbox`) or at
    `.cache/home` or `tmp/home`.
  - **The tension, resolved:** `D:\work\home` is inside the root and is not a homes
    child, but `home` is not a sandbox path, so it still blocks `D:\work`, while
    `repo/.home` does not block `repo`.
- **Windows executables.** A trailing `.exe`, `.cmd`, `.bat` or `.com` is dropped from
  the program before the dot check, so `git.exe status` → `git status`. A `.ps1` stays a
  script, so it sends no query.
- **Interpreter names and flags.** The interpreter pattern is now
  `^python(\d+(\.\d+)?)?$`, so `python3.11.2` is not an interpreter name. Interpreter
  flags before `-m` are skipped: `-u`, `-B`, `-O`, `-OO`, `-E`, `-s`, `-S`, `-I`, `-q`,
  `-b`, `-bb`, `-d`, `-v` and `-P`, plus `-X <opt>` and `-W <opt>`. So
  `python -u -m pytest` → `python pytest`.
- **Cleanups.** The dead `_FREE_TEXT_PROGRAMS` table is deleted, and the interpreter
  check runs once (`is_python`).

## Privacy amendment 7 (2026-10-17, hermes 0.6.8)

A post-merge review of 0.6.7 found the following:

- **Only `.exe` is stripped.**
  - **The rule:** the program's suffix is taken with `os.path.splitext` and compared
    case-insensitively. Only `.exe` is dropped: `git.exe status` → `git status`, and
    `GIT.EXE status` → `GIT status`.
  - **Scripts:** `.bat`, `.cmd`, `.com`, `.ps1` and any other dotted program are
    scripts, so they give no query (0.6.7 stripped `.cmd`, `.bat` and `.com`).
  - **Code:** `os.path.splitext` and the suffix length replace `[:-4]`.
- **Files inside a home inside the project root are never sent.** The sandbox exception
  of amendment 6 stays for root-finding: `repo/.home` does not hide `repo`. But any path
  that resolves inside any home directory that is itself inside the project root,
  sandbox or not, gives no query. So `.home/Documents/taxes.pdf` and
  `.home/.aws/credentials` read from the root send nothing. Through Git Bash's mapping,
  `HOME=D:\work\.home` works the same way. A search `path` there is dropped.
- **No fail-open defaults.** The `user` parameter of `_blocked` and `_find_root` is
  required.
- **Interpreter flags.**
  - `_python_module` parses flags alone or combined: `-uB`, `-OO`, and `-um` with `m`
    last.
  - `X` and `W` take a value, either attached (`-Xdev`, `-Wignore`) or as the next word.
  - The no-value flags are `b B d E i I O P q R s S u v x`.
  - Any unknown flag, a long option (`--version`), `-c` or a non-flag word stops the
    scan, and only `python` is sent.
- **ASCII interpreter names.** The pattern is `^python([0-9]{1,2}(\.[0-9]{1,3})?)?$`,
  so a fullwidth `python３` is no interpreter, and `python311` is an ordinary program
  sent alone.
- **Real, exact-case packages.** A project package counts only as a `<top>.py` file or
  a `<top>/` directory holding `__init__.py`, at the root or under `src/`. The name is
  matched case-sensitively by directory listing, even on case-insensitive filesystems:
  `Tests/` is not `tests`. Namespace packages (no `__init__.py`) do not count. Nothing
  marks them, so any folder would qualify, which would turn a folder name into a sent
  word. The lookup is cached 30 s when found and 2 s when not, the same as the root
  cache.
- **The name check runs on both strings.** It runs on the full module and on the exact
  string that is sent (`python <top>`). A name in either sends `python` alone. For
  example, `python -m tests.alice_notes` sends `python`, not `python tests`: a name in
  the command line is a signal that the work is about that person.
  - **Correction (0.7.0):** that example was already true in 0.6.7, whose full-module
    check gave `python` alone. The check on the sent string was redundant (the sent
    string is the program plus the module or its top package, both already checked)
    and is removed in amendment 8.

## Amendment 8: approval-gated query (2026-10-17, hermes 0.7.0)

Supersedes "Trigger: prefetch on `pre_tool_call`" and the budget/breaker bullets of
"3 s budget and breaker sharing" above. A minor bump, because the timing changes.

### Problem

0.6.x started the CT query in `pre_tool_call`, before Hermes decided whether the call
may run. A call the user then refused, or another plugin blocked, had already sent its
bare target to CT and its embedding provider. The OpenCode leg showed that a bare target
can matter: `secrets.env` alone opened CT's gate at 0.71.

### Verified host order (pin ee8dd6c8, read as data)

The agent loop (`agent/tool_executor.py::_dispatch_authorized_once`) and the direct path
(`model_tools.py::handle_function_call` → `_pre_dispatch_guards`) run, in this order:

1. tool-request middleware, then the tool-scope check;
2. **all** `pre_tool_call` callbacks (ours included), in one `invoke_hook` pass
   (`hermes_cli/plugins.py::_get_pre_tool_call_directive_details`);
3. only then the directives are resolved: any plugin's `block` wins; an `approve`
   directive asks the human gate (`_resolve_block_from_details` →
   `tools.approval.request_tool_approval`), and a denial or timeout blocks;
4. the pruned-argument check and guardrails (`agent._tool_guardrails.before_call`), then
   ACP edit approval (`acp_adapter.edit_approval`);
5. execution. Inside it, `terminal` runs `check_all_command_guards` (hardline floors,
   the user's `approvals.deny` rules, the dangerous-command prompt, `-q`/cron deny
   modes), and `write_file`/`patch` run their write guards (sensitive paths, the SSH
   config approval). A refusal here is **returned as the tool result**, not raised:
   `terminal` gives `{"output": "", "exit_code": -1, "error": "BLOCKED: …", "status":
   "blocked"}` (or `"status": "pending_approval"`), file tools give `{"error":
   "BLOCKED: …"}` or `{"error": "Refusing to write …"}`;
6. `post_tool_call`, then `transform_tool_result`, for every call that was not blocked
   in steps 1–4 and did not time out or get cancelled
   (`_publish_sequential_result`: `if not managed.blocked and not _execution_timed_out`;
   the direct path returns before the transform on a block).

So `pre_tool_call` cannot know the outcome: approvals and blocks are decided after
every callback has returned. No hook fires only for approved calls before they execute
(`pre_approval_request` / `post_approval_response` are observers and fire only for
flagged calls, so silence there does not mean "approved"). `transform_tool_result` is
the first point after the decision. It also sees the in-tool refusals of step 5, so it
must recognize them.

### Design

- **`pre_tool_call` sends nothing.** It builds the activity from the args (for the
  checks only), skips `empty_id`, `ct_tool`, `no_activity`, `no_ledger`,
  `breaker_open`, `seen_key` (peek, nothing recorded) as before, and **claims the step
  slot** for `(session, api_request_id)` with its `tool_call_id`. It records no key and
  starts nothing. Claiming here keeps 0.6.x's "first call of the step" rule under
  Hermes's parallel tool batches.
- **`transform_tool_result` decides and queries.** For the call holding the step claim:
  1. **Refused** (the result is a JSON object whose `status` is `blocked` or
     `pending_approval`, or whose `error` is a string starting with `BLOCKED` or
     `Refusing`): class `refused`. No query; nothing reaches the breaker or verbose
     mode.
  2. Unsupported result shape: `unsupported_result`.
  3. The activity is rebuilt from the transform's `args` (the args that actually ran,
     after any plugin `modify`); none → `no_activity`.
  4. No ledger (`no_ledger`) or an open breaker (`breaker_open`).
  5. The key is admitted now (`seen_key` if another call started it meanwhile).
  6. The query starts on a worker thread (discover → probe → `ct wisdom match --max 1`,
     `--exclude` from the ledger at this moment) and the transform waits up to
     `LIVE_TIMEOUT` (3 s) for it, as OpenCode and OpenClaw do.

  Every skip in 1–5 sends nothing and **releases the step claim**: nothing was spent,
  so a later sequential call of the same step may claim it. Only a started query (6)
  uses the step.
- **Pending claims** are bounded (LRU 256); a claim whose call was blocked in steps 1–4
  never reaches the transform, so it is evicted, and its key was never recorded.

### Key release (from the DSH review; the core's `finishActivityOutcome.retry`)

A started query that ends without a delivery for any reason other than `zero_hits`
(CT answered, nothing new) **releases the key**: `budget`, `timeout`, `exit`, `spawn`,
`parse_error`, `discovery_miss`, `probe_timeout`, `capability_missing`, `no_ledger`
after the query, `unsupported_result` at splice time, `hook_failed`. A claim of the same
fact by a parallel call (`claim` returns empty for every candidate) counts as
`zero_hits`. The step stays
used, so the retry happens in a later step, never twice in one. `zero_hits` (no match,
or every hit already in context) keeps the key.

### Budget miss = one breaker failure (the core's `recordActivityBudgetMiss`)

Each started query settles the breaker **exactly once**, under a per-query lock:
- the worker finishes first: `timeout`/`exit` record one failure, success records a
  success, anything else records nothing;
- the transform's 3 s wait runs out first: one failure (`budget`), and the worker's
  later outcome is ignored for the breaker (a late success no longer resets it, a late
  timeout is not counted twice).
A refused or blocked call starts no query, so it counts zero. A Hermes-cancelled or
timed-out tool never reaches the transform, so it also counts zero.

### Latency trade-off

0.6.x overlapped the CT call with tool execution; the visible delay was
`max(0, CT latency − tool time)`. Now the transform waits for the whole CT call after the
tool has run: measured CT latency 0.44–2.07 s (p95 1.22 s), capped at 3 s, plus discovery
and the capability probe on the first query of the process (both cached afterwards). It
is paid at most once per model step, and only on a step whose first activity is new for
the session; every other call passes through at once. That is the cost of never
sending a refused call's target, the same trade OpenCode (`tool.execute.after`) and
OpenClaw (the tool-result middleware) made. A user who refuses a call has said "not
this"; sending its target anyway is the worse failure.

### Other changes in 0.7.0 (0.6.8 review, minor)

- `_python_module` also parses `-m` with an attached module: `-mpytest`, `-umpytest`
  (`m` ends the flag word; the rest of the word is the module).
- The redundant name check on the sent string is removed; the full-module check stays.
  (The only difference: a user name that would span the space between the program and
  the module, such as a two-word name made of the end of `python` and the start of the
  package. Each part is still checked against each word.)
- `_project_package` `stat`s `<top>.py` / `<top>/__init__.py` first and lists the
  directory only on a hit, to confirm the exact case.
- `_resolve` computes the homes inside the project root once per root, cached with the
  root (same key and TTL), instead of on every call.

### Tests

- A call refused by Hermes (terminal `status: blocked`, `pending_approval`, a file
  tool's `BLOCKED`/`Refusing` error) sends nothing and frees the step; a call another
  plugin blocks (no transform) sends nothing; a `modify`-ed call sends its final args.
- `pre_tool_call` alone never runs `ct`.
- Key release: `budget`/`timeout`/`exit`/`parse_error`/`spawn` free the key (a later
  step re-queries the same activity), `zero_hits` keeps it; the step stays used.
- Breaker: a budget miss counts once even when the worker later times out; a late
  success does not reset it; a refused call counts zero.
- e2e: Hermes at the pin with a second plugin that blocks `read_file secrets.env` and an
  `approvals.deny` rule that refuses `git push*`; CT must receive neither target.
  **Done (2026-10-17): all checks pass**, checks 1–5 unchanged. The agent read
  `secrets.env` (blocked: `{"error": "BLOCKED by e2e-blocker: …"}`) and ran
  `git push origin main` (refused: `"status": "blocked"`, the deny-rule message); CT
  received only `TASK.md`, `pnpm test` and `.env.local`.

### Versioning

hermes `0.6.9 → 0.7.0`. claude-code `0.4.0 → 0.4.1` and docker-agent `0.1.0 → 0.1.1`
(byte-identical `ct_wisdom_activity.py`): they use only the builder and the renderer,
so their one behavior change is that `python -mpytest` now sends `python pytest`.

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
- **Privacy amendments 1-7:** serve "Why this repo exists" (CT is private and local-first):
  the query names the work, never the person or their directory layout. They only remove
  what is sent. Relevance stays CT's (rule 8): skipping files outside a project is a
  privacy rule, not a relevance judgment. Limits are unchanged (rule 6), and an activity
  that cannot be sent safely fails quietly with no query (rule 4). The project-root lookup
  only `stat`s and lists directories on the user's own machine; it writes nothing and runs
  no subprocess, and the brain is still reached only through `ct` (rule 7).
- **Amendment 8 (approval-gated query):** serves "Why this repo exists" (private,
  local-first): a call the user refused or a plugin blocked sends nothing. Rule 4 (fail
  quietly): a budget miss counts once on the shared breaker, a refusal never; the 3 s cap
  is unchanged. Rule 6: still one query per step. Rule 7: still `ct wisdom match` only.
  Rule 8: the refusal check reads Hermes's own result envelope, never scores relevance.
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

**E2E (done, 2026-10-16):** `integrations/hermes/tests/e2e/run.sh` (Docker, Hermes at the
pin, scratch `HERMES_HOME` and brain, CT 3.5.1 real gate, GLM-5.3-FLASH, verbose on). It
checks: (1) an activity block in a tool result, once, with its marker; (2) no re-query or
re-delivery on a later step with the same key; (3) a `write_file` result with the spliced
key still counts as landed for Hermes's verifier; (4) no query from CT tools; (5) CT
receives the bare target; plus the verbose notice and JSONL line. All pass. Findings: the
Tool Search bridge (`tool_search` / `tool_describe` / `tool_call`) unwraps to the real
MCP tool name `mcp__curated_thoughts__curated_recall_context`, which `is_ct_tool` and
`ct_tool_dedup` both recognize; `hermes -z` sends stderr to `/dev/null` (verbose notices
show in `hermes chat`); and the MCP sidecar needs the embedding key passed through
`mcp_servers.<name>.env` (`${OPENROUTER_API_KEY}`), because Hermes does not hand its
environment to MCP subprocesses.

## Versioning and docs

- hermes `0.5.0 → 0.6.0` (`plugin.yaml`, `integration.yaml`), CHANGELOG `## 0.6.0 — <date>`,
  README (the Intuitive Wisdom section and limitations), README table regenerated with
  `tools/ct_ci.py readme`.
- claude-code `0.3.0 → 0.3.1`: patch bump because the policy gate requires it for the shipped `ct_ledger.py`
  change, with a CHANGELOG note "no behavior change".

## Out of scope

- Other hosts' autonomous legs (DSH, OpenCode, Claude Code, OpenClaw).
- A CT-side activity query mode or batch form (investigation "CT-side support").

# Docker Agent integration (docker-agent 0.1.0) — design

**Date:** 2026-10-16 · **Status:** Approved for implementation (user decisions 1–7 binding; design
judgment delegated, autonomous brainstorm, no open questions) ·
**Branch:** `feat/docker-agent-integration` · **Base:** `origin/main` @ `180693e` (PR #55 merged)
**Builds on:** [Step-0 investigation](../investigations/2026-10-16-docker-agent-step0-investigation.md)
(the verified host facts, the [U] targets, the risks), the Claude Code leg
([`2026-10-16-claude-code-wisdom-parity-leg-design.md`](2026-10-16-claude-code-wisdom-parity-leg-design.md):
store, lock, persisted breaker, vendored core), the Hermes autonomous-work design
([`2026-10-16-hermes-autonomous-work-wisdom-design.md`](2026-10-16-hermes-autonomous-work-wisdom-design.md):
line builder, key tracker, block format, marker-first rule) and verbose mode
([`2026-10-16-wisdom-verbose-mode-design.md`](2026-10-16-wisdom-verbose-mode-design.md)).

Tags: **[V]** verified by reading the pinned source (`docker/docker-agent` **v1.150.0** @
`5277e7842058fc3fbb9943a6e88bc05a1c8e6fe2`, a `git clone --depth 1` read as data) or by
**[E]** running the pinned release binary (`docker-agent-darwin-amd64`, sha256
`73c13c4a…9b50`, matching the release digest) in an isolated `HOME` /
`DOCKER_AGENT_CONFIG_DIR` / `DOCKER_AGENT_DATA_DIR` under the session scratchpad, against a
scripted local OpenAI-compatible endpoint (`tests/host/mock_openai.py`). The user's real
`~/.config/cagent` and brain were never read or written. **[U]** is unverified and carried as a
known limit.

## Problem

Docker Agent (`docker agent run`, formerly `cagent`) has no Curated Thoughts integration. INTENT
asks every host to reach all three Intuitive Wisdom steps. The investigation found the host can
do so, but two host behaviors rule out the obvious channels: `session_start` context is recomputed
and re-sent on every run, and `user_prompt_submit` context is a transient system message placed
before the conversation (not cache-safe). This spec designs the integration around the channels
that are safe.

## User decisions (binding, 2026-10-16)

1. **Per-user-message facts:** match at `user_prompt_submit`, store the result in our session
   store, deliver it in the turn's **first eligible tool result** via `tool_response_transform`.
   A turn with no tool call gets nothing. Opt-in alternative: deliver with the message, only for
   Anthropic models with `cache_preserving_updates`, behind a documented switch, off by default.
2. **Only `docker agent run` sessions.** Sandbox, cloud, ACP/editor and API-server modes are
   silent no-ops. The README says so plainly.
3. **Activity rate:** one fact per model step AND only on an activity-key change (Hermes): bare
   target query (A6), 1 fact ≤ 600 chars, CT tools never trigger, subagents and scheduled runs
   included, no per-message ceiling, no session cap. A per-model-call hook keeps a per-session step
   counter in our store; pick the cheapest one the source shows fires per model call.
4. **Branched/resumed sessions, option (a):** before the first delivery in a session we have not
   seen, scan the conversation for our `ct-fact` markers; fail closed if it cannot be read.
5. **Each helper agent gets its own session-start block**, if the run-1 technique works.
6. **Installer** writes ONLY the drop-in `~/.config/cagent/hooks.d/50-curated-thoughts.yaml`
   (absolute paths, `on_error: ignore`, every command ending `|| exit 0`), PRINTS the MCP toolset
   snippet with an `env:` block of `${env.VAR}` references, NEVER edits agent files, supports
   `HOME` overrides for isolated tests.
7. **Python 3.9+ stdlib hooks.** The Hermes shared core is copied byte-identically, the parity
   gate covers the new tree, and harness-specific code lives in docker-agent-only modules.

## Phase 0: verified host facts (this session)

The investigation's facts stand. These are the [U] targets that block the design, closed here.

| # | Fact | Evidence |
|---|---|---|
| P1 | `session_start` fires once per `RunStream`: twice for `docker-agent run agent.yaml "q1" "q2"`, and once more for a later `--session <id>` run. Its context is **not** persisted: the resumed run's requests carry none of it. | [E] experiment A (two messages, then a resume); [V] `pkg/runtime/loop.go:405-419` |
| P2 | `updated_tool_response` is what the session stores and replays: the resumed run's request carries the rewritten tool results byte for byte. | [E] experiment A resume; [V] `toolexec/dispatcher.go:1172-1245` |
| P3 | **Run-1 technique works.** A `before_llm_call` hook that inserts `{"role":"system","content":<block>,"turn_scoped":true,"cache_control":true}` right after the invariant prefix produces, in run 1, a message list **identical** (full JSON equality of every message) to the list run 2 gets when `session_start` emits the same block. `turn_scoped` and `cache_control` are JSON fields that "survive before_llm_call hook rewrites" by contract. | [E] experiment C; [V] `pkg/chat/chat.go:112-135`, `pkg/session/session.go:2496-2535` |
| P4 | Several `session_start` hooks' contexts are **joined with `\n` into one system message** (registration order: agent hooks, then global, then drop-ins). So a block emitted from `session_start` is byte-identical only if every other `session_start` hook is too, and it cannot be told apart from theirs. | [V] `pkg/hooks/executor.go:411-566` (`aggregate`, `strings.Join(contexts, "\n")`) |
| P5 | `turn_start` and `before_llm_call` both fire once per model call (`runTurn`, `loop.go:863-891`). `turn_start` carries only the common fields (~270 bytes); `before_llm_call` adds `iteration`, `model_id` and the full `messages` list (2.4–5.7 KB in the experiments). One hook spawn costs ~50 ms on the test Mac. | [V] `pkg/runtime/hooks.go:150-157`, `:557-586`; [E] timestamps in experiments A, D |
| P6 | Sub-agents (`transfer_task`): the child gets its own `session_id` (a UUID), its own `session_start`, `turn_start`, `before_llm_call` (iteration 1, 2, …) and tool events, all with `agent_name` = the child. No `user_prompt_submit`. `subagent_stop` carries `parent_session_id`. The child's first user message is the synthesized `Please proceed.`. | [E] experiment D |
| P7 | Parallel tool calls of one model response run `tool_response_transform` in **separate processes at the same instant** (same timestamp, two pids). | [E] experiment A |
| P8 | The OpenAI chat-completions client merges all leading system messages into one; the Anthropic client hoists every system message into the top-level `system` field (investigation §2.2). Either way, the bytes the provider sees follow from the hook-visible message list, so P3's list equality is the property that matters. | [E] experiment A request bodies; [V] investigation §2.2 |
| P9 | Only `docker agent run` loads drop-ins: `config.LoadHookDropIns()` is called in `cmd/root/run.go:452` and in the sandbox env pre-pass `cmd/root/sandbox.go:249-251`, and nowhere else. `serve api/acp/a2a/mcp` and `eval` do not. | [V] grep at the pin |
| P10 | Inside a sandbox VM the runtime sets `SANDBOX_VM_ID` (`cmd/root/sandbox.go:108` refuses nesting with it). The VM re-runs `docker agent run`, which loads the drop-ins from the (read-only mounted) config dir. | [V] `cmd/root/sandbox.go:108`, `docs/configuration/sandbox/index.md:19-25` |
| P11 | The size limiter replaces a filesystem / shell / background_jobs / mcp / a2a result over **51 200 bytes or 2 000 lines** with its tail (the head for `read_file`). It runs after our transform. | [V] `pkg/hooks/builtins/limit_large_tool_results.go:19-60` |
| P12 | A stdio MCP toolset's subprocess gets the expanded `env:` entries **plus the whole OS environment** (`env = append(env, os.Environ()...)`). An `env:` value naming an unset variable is an error: "environment variable %q not set", and the toolset does not start. | [V] `pkg/tools/mcp/mcp.go:97-110`, `pkg/environment/expand.go:27-42` |
| P13 | A multi-line `system_message` prints in a non-TUI run as `⚠️  <line 1>\n<line 2>` on stdout; it never enters the session messages. | [E] experiment E; [V] `pkg/runtime/hooks.go:134-136` |
| P14 | The config dir is `$DOCKER_AGENT_CONFIG_DIR`, else `$CAGENT_CONFIG_DIR`, else `$HOME/.config/cagent` (**not** `$XDG_CONFIG_HOME`). The data dir is `$DOCKER_AGENT_DATA_DIR`, else `$HOME/.cagent`. | [V] `pkg/paths/paths.go:96-120`, `cmd/root/root.go:43-60` |
| P15 | Tool names and args at the pin: `read_file{path}`, `write_file{path,content}`, `edit_file{path,edits}`, `search_files_content{path,query,is_regex}`, `shell{cmd}` (alias `command`). Tool-event payloads carry `cwd`, `agent_name`, `tool_category` (`filesystem`, `shell`, `mcp`, `transfer`, …). | [V] `pkg/tools/builtin/filesystem/types/types.go`, `shell/types/types.go`; [E] experiments A, D |

Closed differently from the investigation's sketch: the sketch emitted the bootstrap from
`session_start`. P3 and P4 together make `before_llm_call` the better channel (D4).

## Decisions

### D1. Layout, vendored core, parity

```
integrations/docker-agent/
  integration.yaml  plugin.json  CHANGELOG.md  README.md
  hooks/ct_wisdom_da.py           # the adapter: dispatch, store, lock, breaker, every event
  hooks/ct_wisdom_da_activity.py  # docker-agent tool names -> the vendored Hermes builder
  scripts/                        # byte-identical Hermes core + install.sh
  tests/  tests/host/             # unit, randomized exactly-once, installer, host contract
```

- `scripts/` holds byte-identical copies of `ct_env.py`, `ct_status.py`, `ct_preflight.py`,
  `ct_ledger.py`, `ct_wisdom.py`, `ct_wisdom_live.py`, `ct_wisdom_verbose.py`, `ct_wisdom_log.py`,
  `ct_wisdom_activity.py` and `_compat_generated.py` (generated), plus `ct_doctor.py` with the
  three named harness regions. `tests/tools/test_shared_script_parity.py` gains the docker-agent
  tree; `ct_wisdom_activity.py` is checked for the trees that carry it.
- `ct_wisdom_activity.py` is vendored for its activity builder (`activity_for`, with every
  target rule including the Hermes **privacy amendment**), `render_candidates`,
  `render_activity_block`, `splice`, `is_ct_tool` and `Activity`. Its Hermes thread prefetch
  and hook callbacks are not called. `hooks/ct_wisdom_da_activity.py` only **translates** a
  Docker Agent call into the Hermes call with the same meaning (D7), so the target rules have
  one source, and the shared vector file `tests/fixtures/activity_targets.json` runs against the
  Docker Agent builder through that translation.
- `ct_wisdom_da` and `ct_wisdom_da_activity` join `tools/ct_ci_policy.py`'s `STDLIB_ALLOWLIST`.
- `plugin.json` (`{"name", "version"}`) is the native manifest: `version_mirror:
  plugin.json#version`, read by the doctor's `_plugin_version` and stamped into the drop-in.

### D2. Modes: only host `docker agent run` (decision 2)

- ACP, API server, A2A, MCP-server and eval modes never load drop-ins (P9), so nothing runs.
- Inside a sandbox VM the hook runs (P10) but `SANDBOX_VM_ID` is set: the adapter returns before
  reading stdin's payload fields, writes nothing and prints nothing. Cloud mode is a sandbox with
  no host config at all (investigation §8). If the VM lacks `python3`, or the absolute script path
  does not exist in the VM, `|| exit 0` turns the failure into a silent success.
- The README states the limit plainly: Intuitive Wisdom works in `docker agent run` on the host.

### D3. Hooks registered (the drop-in)

| Event | Matcher | Timeout | Why |
|---|---|---|---|
| `before_llm_call` | — | 20 s | first-call scan + bootstrap render (D5), bootstrap insertion on every call (D4), step counter (D7) |
| `user_prompt_submit` | — | 10 s | per-message match (D6) |
| `user_followup_submit` | — | 10 s | a queued follow-up is a user message too (same path) |
| `tool_response_transform` | `*` | 15 s | deferred per-message delivery (D6), activity delivery (D7), recall dedup (D8) |

Every hook: `type: command`, `on_error: ignore` (a failure, timeout or bad JSON is silent),
`command: '"<abs python3>" "<abs hooks/ct_wisdom_da.py>" || exit 0'`. CPython exits 2 when the
script file is missing; on `user_prompt_submit` exit 2 would refuse the user's message
(investigation §1.4), so `|| exit 0` is mandatory and the adapter itself always exits 0.
`session_start` and `turn_start` are **not** registered (D4, D7).

### D4. Session-start block: inserted by `before_llm_call` on every call (decision 5, P3, P4)

The block is the Hermes v1 bootstrap (`ct_wisdom.render_block`, ≤ 2 500 chars, `ct-fact` markers),
rendered once per session (D5) and stored. On **every** `before_llm_call` of a confirmed session
with a non-empty stored block, the adapter returns `updated_messages` = the incoming list with one
message inserted:

```json
{"role": "system", "content": "<stored block>", "turn_scoped": true, "cache_control": <bool>}
```

- **Position:** within the leading run of `system` messages, before the first `turn_scoped` one
  (the first extras slot, where `session_start` context would sit); if there is none, right after
  the last leading message with `cache_control` set (the end of the invariant prefix); if there
  is none, at the end of the leading system run. `cache_control` is true only when no other
  `turn_scoped` message follows ours, exactly as the host marks the last extra
  (`markLastMessageAsCacheControl`).
- **Already present:** if any incoming message has `content` equal to the block, nothing is
  inserted (no double copy if another hook or a future host change delivers it).
- **Why not `session_start`:** its context is joined with other `session_start` hooks' output
  (P4), it does not reach run 1 under the scan rule (D5), and helpers have only one run (P6).
  Insertion gives every session, helpers included, the block **from its first model call**, at a
  fixed position, with identical bytes on every call of every run (P3). The one-message delay the
  investigation predicted for option (a) does not happen.
- **Cache safety (rule 2):** the inserted bytes never change for the life of the session id; the
  request is the same as a host-emitted extra at the same position. A call whose hook fails or
  times out goes out without the block; that call and the next miss the cache once. That is the
  same exposure `session_start` has (named limit 4).
- **Compaction:** the insertion is request-only, like host extras ("Legacy per-call hook extras are
  not included in the compaction snapshot"), so the block survives every compaction and its ids are
  permanently in context.

### D5. First-call scan and confirmation (decision 4, option a)

The store (D9) has `state` ∈ `pending` (created by `user_prompt_submit` before any scan), `on`,
`off`. On a `before_llm_call` whose store is missing or `pending`:

1. `messages` must be a list of objects; otherwise `state = off` (`unreadable`) for life.
2. Scan every message's `content` and every `multi_content[].text` with `ct_ledger.scan_ids`,
   and take the entry ids of every CT recall result (a JSON object with `wiki_entries`; recall
   results carry entries, not markers; the randomized exactly-once test found a branch repeating
   a recalled fact without this). The ids found are the facts already in this context (a branch's cloned history, a resumed
   pre-install session, a pruned store). They are **seeded into the ledger** (`seen_ids`), so they
   are never delivered again. `before_llm_call` carries exactly what the model is about to see, so
   the scan is complete for that context.
3. Render the bootstrap: `ct recall` on the seed query plus the cwd basename (`ct_wisdom.query_for`),
   entries whose id is already in the ledger dropped, `render_block`. The recall is cached in the
   pending store (`boot_entries`), so a first message that ran before the first model call has
   already paid for it (D6). **Transient failures are not final** (ct_wisdom's memo rule): a
   discovery miss, a probe timeout, a recall timeout / exit / spawn or an open breaker leaves the
   session `pending` (no block, no deliveries) and the next model call retries, at most
   `BOOTSTRAP_TRIES = 3` calls; timeouts and exits feed the shared breaker. A CT answer (entries,
   none, or a parse error) is final. Record `bootstrap_block` (`""` when nothing survived, and then
   **never re-rendered**: a later first block would change the system region) and
   `bootstrap_ids`. Write the store (D4 of the Claude Code leg: store before emit), set
   `state = on`, then insert the block (D4).
4. Any exception, or a store write that fails, removes the store and inserts nothing: every
   later trigger then rescans, which is the fail-closed path.

For a session already `on`, the stored block is immutable, so it is inserted from an unlocked
read: a store-lock timeout costs that call's step tick, never the block (PR #59 review).

A session id that already has a store in `on` is never rescanned. Branching creates a new id
(investigation §3), so a branch is always scanned.

### D6. Per-user-message delivery: deferred to the first eligible tool result (decision 1)

`user_prompt_submit` (and `user_followup_submit`):

- Skip unless `session_id` and a non-empty `prompt` exist, and the prompt does not start with
  `<system-update>`, the one host envelope Docker Agent puts at the start of a user message at the
  pin (`pkg/session/session.go:1113`). A prompt that merely starts with a tag (`<div> is not
  centered`) is the user's. Docker Agent fires this event only for real user messages (P6).
- The query is the prompt with every `<attached_file path="…">…</attached_file>` block removed
  (pasted and attached content, `pkg/app/app.go:974`, `pkg/chat/chat.go:335`), so file contents
  never reach CT; nothing left → no query.
- Load the store, or create it in `pending`. `off` → skip. Breaker open → skip.
- A `pending` session (its first message runs before its first model call) recalls the bootstrap
  now and caches it (D5 step 3), so the match excludes the bootstrap's ids and the message's two
  slots go to new facts.
- `match_wisdom(path, query, 2, exclude = bootstrap recall ids + ledger newest-first ≤ 256)`.
- Write `pending_live = {"query": q, "result": <match result>}`, **replacing** any unclaimed
  pending result (it expired with its turn; verbose records it as `no_tool_call`). Emit nothing.

`tool_response_transform`, for any tool result that is **eligible**:

- not a CT tool (D8), `tool_error` false, `tool_response` a string, splice mode `text` or `object`
  (`ct_wisdom_activity.splice`), store `on`;
- the spliced result stays under the limiter with margin: ≤ 49 152 bytes and ≤ 1 990 lines (P11),
  so the limiter can never cut the block.

The first eligible result **claims** the pending result under the store lock (parallel calls race
only for the lock, P7), renders it against the **current** ledger, splices it, records the ids in
`delivered_ids`, clears `pending_live`, writes the store, and only then emits
`updated_tool_response`. The block is the live block with the marker **first** on each fact line
(the activity rule, so any truncation shows a marker or nothing):

```
## Curated Thoughts — relevant now

<!-- ct-fact:<id> --> **<title>** (provenance: <p>)[ — supersedes ct-fact:<old>]
<text>
```

≤ 2 facts, ≤ 1 200 chars, corrections first and only when they supersede an id in the ledger, the
live renderer's fit / truncate-one / stop rule. If nothing survives the ledger, the pending result
is cleared and verbose records `deduped`.

**What the user loses:** a turn in which the model calls no tool gets no per-message delivery, and
a fact arrives after the model's first step, not before it. Rule 2 is the reason (investigation
§2.3).

**Opt-in transient mode** (`CT_WISDOM_DA_LIVE=prompt`, read from the environment Docker Agent
runs in; off by default): for a session already `on`, `user_prompt_submit` renders the standard
Hermes live block (`render_live_block`) and emits it as `additional_context`. Use it only with an
Anthropic model and `provider_opts.cache_preserving_updates: true`, which keeps that context out of
the cached prefix (investigation §2.2). The README says so. Its ids join the ledger permanently:
the pinned docs say such messages "remain in history verbatim", so treating them as still in
context can only lose a delivery, never repeat one. A `pending` session (not yet scanned) falls
back to the deferred path for that message.

### D7. Autonomous-work delivery (decision 3)

`tool_response_transform` is both trigger and channel.

**Step counter (P5).** Each `before_llm_call` increments `step` in the store. `before_llm_call`
is already mandatory on every model call (D4), so it costs nothing extra; a `turn_start` counter
would add a second process spawn per model call (~50 ms) for a field we can update in the hook
that already runs. The host's `iteration` restarts at 1 per run, so the store's own counter is the
step id.

**Activity map** (`hooks/ct_wisdom_da_activity.py`): a Docker Agent call is translated into the
Hermes call with the same meaning, passing only the listed args, and handed to the vendored
`ct_wisdom_activity.activity_for(tool, args, cwd=<payload cwd>, env=<hook env>)`:

| Docker Agent tool | Hermes call | Verb |
|---|---|---|
| `read_file{path}` | `read_file{path}` | `read` |
| `write_file{path, content}` | `write_file{path}` (never `content`) | `write` |
| `edit_file{path, edits}` | `patch{path}` (never `edits`) | `edit` |
| `search_files_content{query, path}` | `search_files{pattern: query, path}` | `search` |
| `shell{cmd}` (alias `command`) | `terminal{command}` | `run` |

Every other tool (including `transfer_task`, `read_multiple_files`, MCP tools) has no activity.

**Privacy rules:** exactly the Hermes rules, from the vendored copy (hermes 0.6.3), so the Hermes spec's
"Privacy amendment" and "Privacy amendment 2" (search patterns on an allowlist) govern (the cwd counts only when it is deep enough and not the home or a
system root; paths outside it reduce to a basename; user-name components are dropped; unsafe
search patterns send nothing; the `_for:` label and the verbose `activity` field use the
sanitized target). When Hermes changes those rules, the parity gate forces the re-copy and the
shared vectors re-run here.

The CT query is the bare target (A6), ≤ 300 chars. Key = `(verb class, target)` with
read/write/edit folded into `file`.

**Rate rule**, under the store lock, before any CT call: the call may query only if the store is
`on`, the breaker is closed, `activity_step != step`, and the key is not in the session's last 32
keys. It then sets `activity_step = step` and records the key, whatever the outcome (Hermes: a key
counts as seen once a query starts). The CT call (`match_wisdom(..., 1, exclude)`) runs outside
the lock with the 3 s budget. After it, under the lock, the first candidate whose id is still not
in the ledger is rendered with `render_activity_block` (heading
`## Curated Thoughts — relevant to this step`, `_for: <label>`, marker first, ≤ 600 chars), the id
is recorded, the store is written, and the spliced result is emitted. If the per-message block
and the activity block together would not fit under the limiter margin, the per-message block is
tried alone (it has priority); the activity fact is then not recorded. Splicing and the limiter
margin follow D6. When a deferred per-message block rides the same result, it goes first and the
activity block follows it.

Subagents get activity delivery like any session (P6); so do scheduled and non-interactive runs:
nothing checks how the run started.

### D8. CT tools and recall dedup

A tool is a CT tool when `ct_wisdom_activity.is_ct_tool(name)` holds or `tool_category == "mcp"`
and the name matches `(^|_)curated_[a-z_]+$` (Docker Agent prefixes a named toolset as
`<name>_<tool>`, investigation §5). CT tools never trigger activity and never carry deferred
blocks.

For a CT tool whose name ends in `curated_recall_context`: the `tool_response` string (the MCP text
contents concatenated, investigation §5) is parsed as the CT recall envelope. Each `wiki_entries`
item whose id is in the ledger becomes the Hermes stub
`{"id", "in_context": true, "note": "already in context: ct-fact:<id>"}`; new valid ids join
`tool_ids`. `updated_tool_response` is emitted only when something was stubbed, so otherwise the
bytes are unchanged. Raw text that does not parse is never touched.

### D9. Store, lock, breaker, caches

`<data>/curated-thoughts/wisdom/` where `<data>` is `$DOCKER_AGENT_DATA_DIR`, else `~/.cagent`
(P14). A `--data-dir` flag is invisible to hooks; the store then stays in the default place, which
is harmless (named limit 8).

- `sessions/<key>.json` (key = the id when `[A-Za-z0-9_-]{1,128}`, else its sha256):

```json
{"v": 1, "session_id": "…", "state": "pending|on|off", "off_reason": null,
 "bootstrap_block": "…", "bootstrap_ids": [], "seen_ids": [], "delivered_ids": [],
 "tool_ids": [], "order": [], "step": 0, "activity_step": -1, "recent_keys": [],
 "pending_live": null, "turns": 0, "updated": 0.0}
```

- Ledger = `bootstrap_ids ∪ seen_ids ∪ delivered_ids ∪ tool_ids`; exclude = unique(reversed
  `order`)[:256]. Missing, corrupt or mismatched store → no delivery (fail closed).
- Read-modify-write under an exclusive `flock` (`msvcrt.locking` on Windows) on
  `<session>.json.lock`, bounded wait 2 s, written with tmp + `os.replace`. The lock is never held
  across a `ct` call.
- `breaker.json`: the Claude Code persisted breaker (3 timeout/exit failures pause CT calls 300 s,
  shared by every event).
- `ct.json`: the accepted `ct` path with its size and mtime, and whether `wisdom match` exists,
  valid for 24 h, and only under the discovery view it was written in (a digest of `PATH`,
  `HOME`, `USERPROFILE`, `LOCALAPPDATA`). A hit skips the two probe subprocesses; a `spawn` failure deletes it.
- Housekeeping: a session's first `before_llm_call` prunes session stores older than 30 days.
  **Lock files are never deleted:** unlinking a lock file another process has open (or is about
  to lock) lets two processes each hold an "exclusive" lock on different inodes. The store, lock,
  prune and breaker primitives live in `hooks/ct_hook_store.py`, byte-identical with Claude
  Code's copy (which had this prune bug; fixed in claude-code 0.3.3) and parity-gated.

### D10. Verbose mode

`CT_WISDOM_VERBOSE=1` turns it on (verbose spec D1). The recorder is the shared
`ct_wisdom_verbose` with `host: "docker-agent"`. The adapter hands it an env view whose
`CT_WISDOM_VERBOSE_LOG` defaults to `<data>/curated-thoughts/wisdom/ct-wisdom-verbose.jsonl`
(`log_path` knows no docker-agent default, and the shared file is not edited).

- **User-visible channel:** the collected notices become the hook output's top-level
  `system_message`, which Docker Agent shows as a warning (TUI notification, `⚠️` line in a non-TUI
  run) and never adds to the session (P13). It works on `user_prompt_submit`,
  `user_followup_submit` and `tool_response_transform`; `before_llm_call` is dispatched without an
  event sink, so bootstrap events go to the log only (the verbose spec leaves bootstrap out of
  scope anyway).
- **Records:** channel `deferred` for a per-message delivery (and the reasons nothing was:
  `no_tool_call`, `deduped`, `no_match`, CT failures), `user_prompt_submit` for the opt-in transient
  mode, `activity` for autonomous work (rate and filter skips are not recorded).
- **Off means identical:** with verbose off the recorder returns at once and every hook output is
  byte-identical to a build without it (tested).
- The reader: `python3 scripts/ct_wisdom_log.py --path <log>`.

### D11. Installer and MCP snippet (decision 6)

`scripts/install.sh [--uninstall] [--print-only]`, bash, stdlib only:

1. Resolve `python3` to an absolute path and require 3.9+ by running it (an Xcode stub fails here
   and nothing is written).
2. Resolve the config dir like Docker Agent (P14): `$DOCKER_AGENT_CONFIG_DIR`, else
   `$CAGENT_CONFIG_DIR`, else `$HOME/.config/cagent`. `$XDG_CONFIG_HOME` is deliberately ignored
   because Docker Agent ignores it.
3. Refuse paths containing `"`, `'`, `` ` ``, `$`, `\` or a newline (they cannot be quoted safely
   in the drop-in).
4. Write **only** `<config>/hooks.d/50-curated-thoughts.yaml` (tmp + rename), with the version from
   `plugin.json`, absolute paths, `on_error: ignore` and `|| exit 0` on every command. Nothing else
   is created or edited; agent files are never opened. `--uninstall` deletes that one file.
5. Print the MCP toolset snippet for the user to paste into each agent:

```yaml
    toolsets:
      - type: mcp
        command: "<absolute path to curated-thoughts-mcp>"
        args: ["--mcp"]
        env:
          OPENROUTER_API_KEY: ${env.OPENROUTER_API_KEY}
```

The `env:` lines name the external-embedder keys (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
`VOYAGE_API_KEY`, `GEMINI_API_KEY`) **set in the installer's environment**, by name only; the
others are printed commented out, because an `env:` reference to an unset variable stops the
toolset (P12). Docker Agent also passes its whole environment to the sidecar (P12), so the block
is belt and braces, and it documents what the sidecar needs (the Hermes MCP-env lesson). Then run
the doctor.

### D12. Doctor

`scripts/ct_doctor.py` is the shared doctor. Its harness regions:

- `harness-config`: `HARNESS_LABEL = "Docker Agent"`, config/data dir resolution (P14),
  `_plugin_version` from `plugin.json`.
- `registration-check` (check 7): the drop-in exists, parses as ours (marker line and version),
  names an existing `ct_wisdom_da.py` and a Python that runs, and every hook line carries
  `on_error: ignore` and `|| exit 0` → PASS; drop-in missing → FAIL with the install command;
  malformed or stale → WARN. The MCP toolset cannot be checked (it lives in agent files the doctor
  does not read), so the PASS detail reminds the user to paste the snippet.
  `_sidecar_env_route` returns `None` ("inherits"): Docker Agent passes its environment (P12).

## Fail-closed table

Every row means "nothing delivered, tool result and request unchanged, one debug line", and with
verbose on, a record where noted.

| Class | Where | Meaning |
|---|---|---|
| `sandbox` | every event | `SANDBOX_VM_ID` set (D2) |
| `no_payload` | every event | stdin empty or not a JSON object, no `session_id` |
| `unreadable` | before_llm_call | `messages` not a list of objects → `state = off` for life |
| `bootstrap_retry` | before_llm_call | transient bootstrap recall failure: stays `pending`, retried (≤ 3 calls) |
| `store_failed` | before_llm_call | store could not be written → store removed, no insertion |
| `no_store` / `pending` | tool events | the session was never scanned |
| `delivery_off` | every event | `state = off` |
| `lock_timeout` | any | the store lock was not taken within 2 s |
| `provenance` | user_prompt_submit | empty prompt or envelope tag |
| `breaker_open` | prompt, activity | persisted breaker open (recorded) |
| `discovery_miss`, `probe_timeout`, `capability_missing` | any CT call | as Hermes (recorded) |
| `timeout`, `exit`, `spawn`, `parse_error` | any CT call | as Hermes; timeout/exit feed the breaker (recorded) |
| `ct_tool` / `tool_error` / `unsupported_result` / `near_limit` | tool events | not an eligible result |
| `no_activity`, `seen_key`, `step_used` | activity | rate and filter rule (not recorded) |
| `no_tool_call` | user_prompt_submit | the previous turn's pending facts expired unclaimed (recorded) |
| `zero_hits` → `deduped` / `no_match` / `budget` | deferred, activity | nothing new survived (recorded) |
| `hook_failed` | any | unexpected exception, caught; exit 0 |

## Exactly-once argument (rule 1)

- Ids enter the ledger from four places only: the scan (`seen_ids`), the rendered bootstrap
  (`scan_ids` of a block whose titles and text were sanitized), validated ids of delivered items,
  and validated recall ids. Fact text is never scanned, so a forged `ct-fact:` in a fact cannot
  add or hide an id.
- Every delivery renders against the ledger **re-read under the lock** and records its ids in the
  same locked write that precedes the emit. Two parallel tool results cannot both deliver one id.
- Writing before emitting means a killed hook loses a delivery and never repeats one.
- The bootstrap is in every request (D4); tool-result deliveries are in the persisted history and
  replay on resume (P2). Compaction may remove a tool-result fact from view; it then stays in the
  ledger and is never delivered again (a loss INTENT allows).
- An unseen session id is scanned before anything is delivered to it (D5). The scan reads the
  exact list the model is about to receive.

## Alignment with INTENT.md

- **Goal (all three steps on every host):** step 1 via the inserted bootstrap (D4), from the first
  model call, helpers included; step 2 via the deferred tool-result delivery (D6), which loses
  turns without a tool call — said plainly here and in the README; step 3 via tool results (D7).
- **Rule 1 (once):** the store ledger, the first-call scan (user decision 4, option a), the lock,
  write-before-emit, marker-first blocks (exactly-once argument above).
- **Rule 2 (never edit the system prompt):** the reason for user decision 1 (`user_prompt_submit`
  context is a transient system message before the conversation) and for D4's byte-identical,
  fixed-position insertion. The opt-in transient mode is limited to the one provider mode that
  keeps it out of the cached prefix.
- **Rule 3 (no superseded fact):** CT filters at match time; corrections ride only when they
  supersede an id in the ledger (shared renderers).
- **Rule 4 (fail quietly):** user decision 2 (no-op outside host `docker agent run`), `on_error:
  ignore`, `|| exit 0`, a non-raising adapter that always exits 0, 3 s CT timeouts, the persisted
  breaker, the limiter margin.
- **Rule 5 (provenance):** the shared renderers label every fact.
- **Rule 6 (keep it small):** 2 500 chars at start; 2 facts / 1 200 chars per message; 1 fact /
  600 chars per activity; no session cap (user decision 3).
- **Rule 7 (read only, through CT's commands):** `ct recall` and `ct wisdom match` only; the
  host's `session.db` is never opened; the integration writes only its own store and log.
- **Rule 8 (relevance is CT's):** the activity map is deterministic and never scores; CT's gate
  decides.
- **User decisions 1–7:** 1 → D6; 2 → D2; 3 → D7 (step counter in `before_llm_call`, justified by
  P5); 4 → D5 (option a, with the scan seeding the ledger); 5 → D4 (helpers get a block, P3
  verified the technique); 6 → D11; 7 → D1.
- **Departures:** none. The deferred per-message delivery is the user's decision 1, and its cost
  (no delivery on a turn without tool calls) is stated in this spec and the README.

## Known limits

1. A turn with no tool call gets no per-message facts (D6), unless the opt-in transient mode is on.
2. Sandbox, cloud, ACP/editor, API-server and MCP-server runs get nothing (D2, P9).
3. Windows: Docker Agent runs hooks under PowerShell or `cmd`, where `|| exit 0` is not valid
   syntax. The installer refuses to run on Windows (Git Bash) and says so. Unit tests still run on
   Windows.
4. A `before_llm_call` that fails or times out sends that one request without the block: one cache
   miss for that call and the next.
5. Every model call spawns one Python process (~50 ms) with the conversation on stdin; every tool
   call spawns one, plus up to 3 s for a CT call when an activity triggers.
6. A compacted tool-result fact is never re-delivered (store ledger, as on OpenCode and Claude Code).
7. CT's MCP toolset must be pasted into each agent file by the user (no global toolsets).
8. A `--data-dir` run keeps the store in the default data dir (hooks cannot see the flag).
9. **[U]** OCI-referenced external sub-agents: assumed to get the drop-in through the same loader.
10. The opt-in transient mode cannot detect the provider; enabling it on another provider costs a
    cache miss per delivery.

## CI host contract

`tests/host/test_host_contract.py`, declared as `checks.host`, run by a dedicated `host-contract
(docker-agent)` job on ubuntu: it downloads `docker-agent-linux-amd64` v1.150.0, verifies the
release sha256 (`791fa6ba…f2d1`), installs the drop-in with `install.sh` into a throwaway `HOME`,
puts a stdlib fake `ct` on `PATH`, and drives the real binary against `tests/host/mock_openai.py`.
It asserts on the **request bodies the model would receive**:

1. the bootstrap is in every request of a two-message run and of a `--session` resume, with
   identical bytes;
2. the deferred per-message block and the activity block ride the first tool result, marker
   first, and replay unchanged on resume;
3. no fact id appears twice in any request;
4. the bare target reaches `ct wisdom match`;
5. a sub-agent gets its own bootstrap;
6. with `SANDBOX_VM_ID` set nothing is injected;
7. verbose on: the warning line and the JSONL record exist, and the request bodies equal the
   verbose-off run.

The `--fake` cassette route was rejected: its matcher compares request bodies after a few
normalizations (`pkg/fake/proxy.go:384-450`), so every change to our injected bytes would need a
re-recorded cassette, and recording needs a live provider. The mock endpoint asserts more and needs
no key. Without the binary (the per-OS matrix), the test skips; the unit suites cover the logic.

## Testing (unit, stdlib `unittest`, `integrations/docker-agent/tests/`)

- `test_hook_events.py`: each event's input/output contract; insertion position and flags; already
  present; sandbox no-op; never `""` as `updated_tool_response`; exit 0 on garbage stdin.
- `test_deferred.py`: match → pending; first eligible result claims; parallel claim (threads);
  expiry at the next prompt; ineligible results (CT tool, error, near limit, JSON list); opt-in
  transient mode.
- `test_activity.py`: line builder per tool; the shared privacy vectors; the Hermes secret-safety
  tests ported; key fold; step rule; CT tools never trigger.
- `test_exactly_once_da.py`: randomized sessions (seeded) with user turns, deferred and activity
  deliveries, recalls, parallel tool batches on real threads, resume (fresh module state) and
  branches (new id, cloned history); no fact id ever twice in the simulated request.
- `test_fail_closed.py`: every class in the table; breaker; lock timeout.
- `test_marker_hygiene.py`: forged markers in fact text never reach the ledger; queries never
  contain markers or headings; marker precedes title in every block.
- `test_verbose_da.py`: off ⇒ byte-identical outputs and no file; on ⇒ `system_message`, JSONL
  record, unchanged `hook_specific_output`; no env secrets in the log.
- `test_install.py`: drop-in content (absolute paths, `on_error: ignore`, `|| exit 0` on every
  command, version), only that file written, agent files untouched, uninstall, refusal paths,
  printed snippet (env names only, unset ones commented, never a value).
- `test_ct_doctor.py`: check 7 PASS / FAIL / WARN, `--self-test`.
- `test_manifest.py`: integration.yaml and plugin.json agree; the drop-in template events.
- `tests/tools/test_shared_script_parity.py`: the docker-agent copies.

## Versioning and docs

docker-agent **0.1.0** (`integration.yaml`, `plugin.json`), CHANGELOG `## 0.1.0 — 2026-10-16`,
README (install, the MCP snippet, the three steps, verbose mode, the limits above), a top-level
README row and Intuitive Wisdom rows (`tools/ct_ci.py readme`).

## Out of scope

- A no-Python variant; Windows hook commands; a published OCI agent; editing agent files.
- Reading Docker Agent's `session.db`.
- Any change to CT, to Hermes or to the other integrations' behavior.

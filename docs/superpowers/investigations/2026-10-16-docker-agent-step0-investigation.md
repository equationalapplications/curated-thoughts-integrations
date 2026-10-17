# Docker Agent integration: Step-0 feasibility investigation

**Date:** 2026-10-16 · **Status:** investigation (pre-spec). Research only, no production code. ·
**Review state:** not yet reviewed
**Host:** Docker Agent (`github.com/docker/docker-agent`, formerly `cagent`; docs at
https://docs.docker.com/ai/docker-agent/).
**Question:** can we integrate Curated Thoughts with Docker Agent, and exactly how would each of
the three Intuitive Wisdom steps (INTENT "Why this repo exists") work there: the session-start
block, per-user-message live delivery, and autonomous-work delivery? The same question covers
recall dedup, the MCP sidecar, verbose mode, install and distribution, and sandboxed runs.

Tags: **[V]** means verified in this session by reading the cited file and line at the pin, or the
cited doc. **[U]** means unverified or inferred. The spec must close it or carry it as a plan
Step-0 target. Doc paths like `docs/configuration/hooks/index.md` are the sources of the
docs.docker.com pages, read at the same pin. Each one carries a `canonical:` front-matter URL. For
example, the hooks page is https://docs.docker.com/ai/docker-agent/configuration/hooks/.

## Pinned source

| Item | Value |
|---|---|
| Release | **`v1.150.0`** (latest release, published 2026-10-09) |
| Commit | `5277e7842058fc3fbb9943a6e88bc05a1c8e6fe2` |
| How it was read | `git clone --depth 1 --branch v1.150.0` into the session scratchpad. The Go source, the `docs/` tree and `agent-schema.json` were read as data. Nothing was built or run, no Docker was used, and nothing downloaded is committed. |
| Release assets | `docker-agent-{darwin,linux,windows}-{amd64,arm64}` static binaries [V `gh release view v1.150.0`] |

Repo state: `origin/main` @ `4388849` (PR #52 merged). The repo files read for comparison were
`integrations/claude-code/{integration.yaml,hooks/,scripts/}`,
`integrations/hermes/scripts/ct_wisdom_verbose.py`,
`tests/tools/test_shared_script_parity.py` and `integrations/opencode/integration.yaml` (for the
`host:` check).

## Bottom line first

Docker Agent has a rich shell-hook surface, close to Claude Code's (JSON on stdin, JSON on stdout).
It also has one feature no other host has: a **drop-in hooks directory**
(`~/.config/cagent/hooks.d/*.yaml`) that applies to every agent without editing the user's
files. Two host behaviors shape the whole design, though, and they differ from what the docs
suggest:

1. **`session_start` fires once per `RunStream`, which is once per user message in the TUI, not
   once per session.** In the default configuration its context is transient: it is re-sent on
   every model call and never saved. The session-start block therefore has to be replayed
   byte-identically from our own store on every run.
2. **`user_prompt_submit` context is not cache-safe in the default configuration.** It is a
   system message placed before the whole conversation. Anthropic hoists it into the top-level
   `system` field. It changes or disappears at the next user message, which invalidates the
   cached conversation prefix on every turn after a delivery. That breaks INTENT rule 2 in
   practice. The safe channel is `tool_response_transform`, whose rewrite is saved and replayed.

| Step | Verdict | Channel |
|---|---|---|
| 1. Session start | **Feasible with caveats** | `session_start` `additional_context`, replayed byte-identically from our store on every run |
| 2. Each user message | **Not feasible as specified on the default config. Feasible with caveats as a deferred delivery** | Match at `user_prompt_submit`, deliver in the turn's first eligible tool result (`tool_response_transform`); or, opt-in, `user_prompt_submit` only with Anthropic `cache_preserving_updates` |
| 3. Autonomous work | **Feasible with caveats** | `tool_response_transform` → `updated_tool_response` (saved, replayed, append-only) |
| Recall dedup | Feasible (only when the user adds the CT MCP toolset) | `tool_response_transform` on the recall tool |
| MCP sidecar | Feasible, but needs a per-agent YAML edit (no global toolsets) | `toolsets: [{type: mcp, ...}]` / `mcps:` |
| Verbose mode | Feasible | `system_message` → TUI warning notification (not model-visible), plus a JSONL log |
| Install | Feasible without editing agent files | one `hooks.d` drop-in file, plus scripts and a store we own |
| Sandbox (`--sandbox`) and cloud | **Not feasible** (it must fail quietly) | the hooks run inside the VM, where `ct` and the brain are not reachable |

---

## 1. Hook mechanics

### 1.1 Where hooks are configured, and in what order

- **[V]** Hooks can come from four sources: the agent YAML (`agents.<name>.hooks`), the
  user-global `settings.hooks` in `~/.config/cagent/config.yaml`, **drop-in files**
  `<config-dir>/hooks.d/*.yaml` (lexicographic order), and the `--hook-*` CLI flags. They are
  additive and run in that order. "Global hooks cannot be suppressed by an individual agent."
  (`docs/configuration/hooks/index.md:203-251`, `:1241-1244`).
- **[V]** Drop-ins are designed for third-party installers: "Installing an integration means
  writing one self-contained file; uninstalling means deleting it. No shared-file edits"
  (`hooks/index.md:233-251`). A malformed drop-in "is skipped with a logged warning; a broken
  drop-in never breaks a run". The loader parses each file strictly, so a typo in an event name
  is rejected (`pkg/config/hooks_dropin.go:21-54`, `:56-65`).
- **[V]** Global and drop-in hooks are merged into **every agent of the loaded config**
  (`pkg/config/hooks.go:115-119`, `config.MergeAgentHooks` loops over `cfg.Agents`; called from
  `pkg/teamloader/teamloader.go:296`), so sub-agents get them too.
- **[V]** The config dir is `~/.config/cagent`, relocatable with `--config-dir` or
  `DOCKER_AGENT_CONFIG_DIR` (legacy `CAGENT_CONFIG_DIR`) (`pkg/paths/paths.go` `GetConfigDir`;
  `cmd/root/root.go:44-46`).
- **[V] Only `docker agent run` loads the global and drop-in hooks.** `runConfig.GlobalHooks`
  is assigned in `cmd/root/run.go:452` and in the sandbox env pre-pass
  (`cmd/root/sandbox.go:248-251`), and nowhere else (grep at the pin). **[U]** whether
  `serve api`, `serve acp`, `serve a2a` and `serve mcp` load them by another path. The grep
  says no, so editor (ACP) and API-server sessions would not get Wisdom.
- **[V] Flavors cannot be used by an installer:** a flavor is "a named YAML patch declared in
  the agent file itself" and is enabled with `--flavor` (`docs/configuration/flavors/index.md:11-19`).
  It works only for files we control.

### 1.2 Events we would use: input payloads

Common fields on every event: `session_id`, `cwd`, `hook_event_name` [V `hooks/index.md:410-418`].
Field names are snake_case (`pkg/hooks/types.go` `Input`).

| Event | When it fires (at the pin) | Extra input fields | Evidence |
|---|---|---|---|
| `session_start` | **Once per `RunStream`**. The TUI calls `RunStream` once per user message (`pkg/app/app.go:606-619`), and sub-sessions call it once at spawn (`pkg/runtime/agent_delegation.go:473`). | `source`, always `"startup"`. There is **no `resume` / `clear` / `compact` / `fork` value**. | [V] `pkg/runtime/hooks.go:140-148`, `pkg/runtime/loop.go:407-419`. The docs table says "When a session begins or resumes" (`hooks/index.md:44`). The code is more precise. |
| `user_prompt_submit` | Once per real user message, after the prompt is recorded, before the first model call. **Not** in sub-sessions (gated on `SendUserMessage`, which sub-sessions set to false). | `prompt` | [V] `loop.go:465-485`, `hooks.go:683-701`, `agent_delegation.go:253` (`WithSendUserMessage(false)`), `hooks/index.md:461`, `:1058-1066` |
| `user_followup_submit` / `user_steering_messages_submit` | Queued follow-up / drained steering messages | `prompt` / `steering_messages` | [V] `hooks/index.md:1068-1110` |
| `turn_start` | Before every model call | none (common fields only) | [V] `hooks.go:150-157`, `hooks/index.md:436` |
| `before_llm_call` | Just before every model call | `iteration`, `model_id`, plus the full `messages` array | [V] `hooks.go:557-586` |
| `pre_tool_use` | **Approval lane only:** "skipped on auto-approved calls" (unless `preempt_yolo: true`) | `agent_name`, `tool_name`, `tool_use_id`, `tool_input` | [V] `hooks/index.md:36`, `:530-532`, `:602-606` |
| `tool_input_transform` | Before guards and approval, **on every call, auto-approved ones included** | `agent_name`, `tool_name`, `tool_use_id`, `tool_category`, `tool_input`, `safety_policy` | [V] `hooks/index.md:37`, `:426` |
| `tool_response_transform` | Between tool execution and the emission and recording of the result. Also runs on synthesized error responses. | `tool_name`, `tool_use_id`, `tool_input`, `tool_response` (a **string**), `tool_error`, `tool_category` | [V] `pkg/runtime/toolexec/dispatcher.go:1172-1201` (`in.ToolCategory` set at `:1193`), `:1285-1288` (`errorResponse`), `toolexec/hooks_input.go:16-35` |
| `post_tool_use` | After the tool completes (success or failure). It **does not consume context.** | `agent_name`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, `tool_error` | [V] `hooks/index.md:430`, `:806-807` |
| `pre_compact` | Before compaction | `source` ∈ `manual`, `auto`, `overflow`, `tool_overflow` | [V] `hooks/index.md:441`, `hooks.go:748-765` |
| `before_compaction` / `after_compaction` | Before / after a compaction | token counts, `context_limit`, `compaction_reason`; `summary` on `after_` | [V] `hooks/index.md:442-443`, `hooks.go:628-681` |
| `subagent_stop` | When a child finishes. It runs on the **parent's** executor. | `agent_name` (the child), `parent_session_id`, `stop_response`. `session_id` is the **child** id. | [V] `hooks.go:767-780` |
| `session_end` | When each `RunStream` ends, so **once per user message too**, not once per session | `reason` = `stream_ended` | [V] `loop.go:232-234`, `hooks.go:341-347` |

`tool_input` shapes for the activity map [V]: `read_file{path}`, `write_file{path, content}`,
`edit_file{path, edits[]}`, `search_files_content{path, query, is_regex}`, `list_directory{path}`,
`shell{cmd}` (`pkg/tools/builtin/filesystem/types/types.go:17-83`,
`pkg/tools/builtin/shell/types/types.go:13`). The tool-name constants are in
`filesystem/...:5-13` and `shell/...:10`.

### 1.3 Output schema

- **[V]** The top-level output fields are `continue`, `stop_reason`, `suppress_output`,
  `system_message`, `decision`, `reason` and `hook_specific_output`. `{}` or empty stdout means
  "do nothing" (`hooks/index.md:472-504`).
- **[V]** `suppress_output` is a "Legacy compatibility field; has no effect and is rejected when
  true in strict mode" (`hooks/index.md:501`). We never send it.
- **[V]** `hook_specific_output.additional_context` is consumed only on `session_start`,
  `user_prompt_submit`, `user_steering_messages_submit`, `user_followup_submit`, `turn_start`
  and `pre_compact` (`hooks/index.md:717-719`; the `Context: true` flags are at
  `pkg/hooks/events/contracts.go:46-50`). Plain stdout that does not start with `{` is also
  taken as context on those events (`hooks/index.md:736-738`).
- **[V]** `hook_specific_output.updated_tool_response` (a string) replaces the result on
  `tool_response_transform`. "The rewrite reaches every downstream consumer — event subscribers,
  the persisted session file, the `post_tool_use` hook input, and the next LLM call"
  (`hooks/index.md:653-661`). An explicit empty string **clears** the response
  (`hooks/index.md:683-684`), so we must never emit `""`.
- **[V]** `system_message` becomes a runtime `WarningEvent` on events dispatched with an event
  sink (`hooks.go:134-136`). See §6.

### 1.4 Timeouts, concurrency and failure behavior

- **[V] Timeout:** per hook, an integer number of seconds, minimum 1, default **60 s**
  (`pkg/config/latest/types.go:3030-3037`; `agent-schema.json:1506-1511`). A timeout is a
  failure. The handler is killed via `exec.CommandContext` (`pkg/hooks/handler.go:224`,
  `pkg/hooks/executor.go:350-382`).
- **[V] Execution model per event** (`hooks/index.md:86-119`, `contracts.go:44-67`):
  `tool_response_transform`, `tool_input_transform`, `pre_tool_use` and `before_llm_call` run
  their matching hooks **sequentially** as a pipeline. Every other event runs its hooks
  **concurrently** (`executor.go:209-215`).
- **[V] Parallel tool calls:** the dispatcher runs "Calls in the same model batch … in
  parallel" (`toolexec/dispatcher.go:240-264`, `concurrent.MapSlice`). So
  `tool_response_transform` for two calls of one batch runs in two processes at the same time,
  and our store needs a file lock (as in Claude Code D3).
- **[V] Failure defaults** (`hooks/index.md:86-119`, `:750-775`; `executor.go:415-445`):
  - `pre_tool_use`, `tool_guard` and the content guards **fail closed** whatever `on_error`
    says.
  - Every event we would use **fails open with `warn`**. A crash, a timeout, a nonzero exit
    other than 2, or malformed JSON all count, and the user sees a warning naming the hook.
  - `on_error: ignore` stays silent. We must set it on every hook (INTENT rule 4).
- **[V] Exit code 2 is an explicit block** on block-capable events (`hooks/index.md:740-748`).
  `user_prompt_submit` can block, so **an exit of 2 would refuse the user's message**
  (`hooks.go:695-698`, `loop.go:478-483`). CPython exits with status **2** when its script file
  is missing (checked locally: `python3 /nonexistent.py; echo $?` → `2`). A bare
  `python3 /path/hook.py` command can therefore block every prompt when the path is wrong, for
  example inside a sandbox VM or after a partial uninstall. The command must force exit 0
  (`… || exit 0`), and the adapter must catch every exception and exit 0.
- **[V] A slow hook blocks the turn:** "Hooks run synchronously and can slow down agent
  execution" (`hooks/index.md:811-814`). A `user_prompt_submit` hook delays the first model
  call. A `tool_response_transform` hook delays the result reaching the model.
- **[V] Environment:** the runtime passes no explicit env (no caller of
  `runtime.WithEnv`), so command hooks **inherit the OS environment** (`handler.go:226-238`).
  They run under `$SHELL -c` (default `/bin/sh`), and on Windows under PowerShell or `cmd /C`
  (`pkg/shellpath/shellpath.go:51-92`). A hook's `env` map expands only `${env.VAR}`
  (`handler.go:181-212`).
- **[V] De-duplication:** identical hook definitions from several sources run once per dispatch
  (`hooks/index.md:182-201`). A user who copies our block into their own `config.yaml` as well
  will not get double delivery.

---

## 2. Context placement and cache safety (INTENT rule 2)

### 2.1 Where `additional_context` lands

**[V] Default configuration (`settings.cache_stable_prompts` unset, so false)**
(`pkg/userconfig/userconfig.go:114-116`, `:306-309`):

1. Each context event's output becomes a `role: system` message (`hooks.go:229-241`).
2. Before every model call, the loop concatenates
   `session_start` + `user_prompt_submit` + `turn_start` + reminder messages as **legacy
   extras** (`loop.go:867-874`), and assembles the request with
   `GetMessagesWithoutInstructionContext(a, extras…)` (`hooks.go:297-315`).
3. Assembly order (`pkg/session/session.go:2496-2535`):
   `[invariant system (agent instruction etc.)] [extras, all marked TurnScoped, the last one cache_control] [compaction summary] [conversation…]`.
   **The extras sit before the whole conversation.**
4. The extras are **never saved**. The loop comment reads "never persisted, to keep the visible
   transcript clean" (`loop.go:407-411`). `session_start` output is recomputed on every
   `RunStream`. `user_prompt_submit` output lives for one `RunStream`, which is every model call
   of that user turn (`loop.go:484`, `ls.userPromptMsgs`).

This means the docs' "`session_start` context persists for the life of the session"
(`hooks/index.md:303`, `:719`) is true only in the opt-in cache-stable mode below. In the default
mode it is re-run and re-sent on every run.

**[V] Opt-in cache-stable mode (`settings.cache_stable_prompts: true`)**
(`hooks.go:316-321`, `session.go:1003-1110`):

- On the first model call, the session freezes every source (`hooks/session-start`,
  `hooks/user-prompt`, `hooks/turn-start`) into an `InstructionContext.Initial` snapshot. That
  snapshot is saved in the session and placed in the system prefix.
- Later changes become **append-only `role: user` updates** at the current history position:
  "The context under "user-request context" changed and supersedes the previous value: …".
  When a source is empty, the update says "… no longer applies. Disregard it."
  (`session.go:1060-1100`).

### 2.2 How the providers cache

- **[V] Anthropic.** The standard client hoists **every** system message, extras included, into
  the top-level `system` field (`pkg/model/provider/anthropic/client.go:287-292`, `:390-394`;
  `cache_control.go:51-60`). The pinned Anthropic docs say: "Anthropic hashes the request prefix
  in order: `tools`, then `system`, then `messages`. Any change to the system prompt … therefore
  invalidates the prompt cache for the whole conversation" (`docs/providers/anthropic/index.md:257-262`).
- **[V] Anthropic `provider_opts.cache_preserving_updates: true`** (opt-in, Claude Opus 4.8+,
  Fable 5+ and Mythos 5+ only; `conversation_updates.go:21-36`, `:62-68`). With it,
  `TurnScoped` extras are sent as turn-scoped system messages after the last user turn, with
  `clear_at: next_user_message`, and "resent verbatim forever" at their original position
  (`system_context.go:11-48`, `conversation_updates.go:101-112`,
  `docs/providers/anthropic/index.md:284-299`: "They remain in history verbatim but stop
  applying at the next user turn").
- **[V] OpenAI.** Prompt caching is prefix-based, with explicit breakpoints on gpt-5.6+ at the
  `CacheControl` marks (`pkg/model/provider/openai/prompt_cache.go:3-13`). System messages stay
  at their position in the input array (`openai/client.go:1042-1050`), so a change in the extras
  region misses the cache for everything after it.
- **[U]** Gemini, Bedrock and the DMR / local providers. They are presumably prefix-based too.
  The spec should not rely on any of them.

### 2.3 Conclusion: per-user-message delivery via `user_prompt_submit`

**Not cache-safe in the default configuration.** Turn N sends
`[system][bootstrap][live_N][history]`. Turn N+1 sends `[system][bootstrap][live_N+1 or nothing][history]`.
The prefix diverges at the live block, so the first call of every turn that follows a delivery
re-reads the **entire conversation** uncached. On Anthropic the block is part of the top-level
`system` field, which is literally editing the system prompt after it was built. Within one turn
the bytes are stable, so the tool-loop calls of that turn still hit the cache. This is a
rule-2 violation in practice (`TurnScoped` exists for this case, but only one opt-in Anthropic
mode honors it).

The cache-stable mode does not fix it either. The first turn's live block is frozen into the
system prefix, and every later change appends a "supersedes the previous value" or "Disregard
it" message. That tells the model to discard facts we delivered earlier, which conflicts with
rules 1 and 3.

**Safest alternatives, in order:**

1. **Deferred delivery (recommended).** `user_prompt_submit` runs `ct wisdom match` on the
   prompt. It records the result as *pending* in our store and emits **no** context. The first
   eligible `tool_response_transform` of that turn appends the pending block to that tool's
   result, the same way autonomous-work delivery does. That result is saved, replayed and
   append-only, so rule 2 holds. The cost: a turn in which the model calls no tool gets no
   delivery, and the fact arrives after the model's first step rather than before it. Pending
   facts expire at the next `user_prompt_submit`.
2. **Opt-in transient delivery.** When the user runs an Anthropic model with
   `cache_preserving_updates: true`, `user_prompt_submit` context is cache-safe. The block is
   turn-scoped, so the ledger must drop live ids at the next user message, because the model
   no longer sees them. The hook cannot see the model (`user_prompt_submit` has no `model_id`),
   so this has to be a user setting. It is not something we can detect.
3. **Not recommended:** `before_llm_call` `updated_messages`, which inserts the block into the
   user message on every call. The rewrite is request-only and never saved
   (`loop.go:896-907`), so we would have to re-insert identical bytes at the same position on
   every later call forever. It also means one process spawn per model call, with the whole
   conversation on stdin.

`session_start` (step 1) is cache-safe **only if our block is byte-identical on every run**.
The extras are recomputed each run, so a re-render with different facts would edit the system
region. The block must be replayed from our store.

---

## 3. Persistence and the ledger

- **[V] Sessions:** SQLite `session.db` under the data dir (`~/.cagent` by default, or
  `--data-dir`, `DOCKER_AGENT_DATA_DIR`, `--session-db`) (`docs/features/sessions/index.md:17-31`;
  `pkg/paths/paths.go` `GetDataDir`; `cmd/root/root.go:46`, `:177`).
- **[V] `tool_response_transform` output is what gets recorded and replayed.** The transform
  runs before emission, before `recordToolResponse` and before `post_tool_use`
  (`toolexec/dispatcher.go:1176-1183`, `:1225-1245`; `hooks/index.md:661`).
- **[V] A size limiter runs after our transform.** `limit_large_tool_results` replaces any
  filesystem, shell, MCP or a2a result over 2,000 lines or 50 KiB with an excerpt. The excerpt
  keeps the **head** for `read_file` and the **tail** for other tools
  (`hooks/index.md:295`, `:696-699`; it is applied in a `defer` at `dispatcher.go:1186-1188`).
  A block appended to a large `read_file` result would be cut. The adapter must skip delivery
  when the payload is near the limit (at-most-once: the claimed fact is lost, never shown
  twice).
- **[V] Session ids:** `--session <id>` resumes with the **same id**. An unknown explicit id is
  created with that id (`docs/features/sessions/index.md:67-85`; `cmd/root/run.go:191`).
  Compaction appends a summary item to the same session (`session.go:984-989`).
  **Branching or forking** (TUI "branch by editing a past message", API fork) creates a **new**
  id and deep-clones the history up to the branch point (`pkg/session/branch.go:22-60`).
- **[V] No hook says which case it is in.** `session_start.source` is always `"startup"`
  (`hooks.go:144-147`). A fresh session, a `--session` resume, a branch and a sub-session all
  look the same, except that a sub-session can be recognized afterwards through
  `subagent_stop.parent_session_id`.
- **[V] No plugin data dir convention exists.** Docker Agent has no plugin system; its own
  features keep state in subdirectories of the data dir (for example
  `<data-dir>/memory/<config>/memory.db`, `pkg/tools/builtin/memory/create.go:52`). Hooks get no
  data-dir variable unless the user exported `DOCKER_AGENT_DATA_DIR`. A `--data-dir` flag is
  invisible to hooks.
- **[V] Transcript access:** only `before_llm_call` receives the conversation (the `messages`
  array, `hooks.go:572-578`). `before_agent_run` gets the last 10 visible messages, but only for
  routing agents (`hooks/index.md:1331-1334`). Reading `session.db` ourselves is possible but
  undocumented as an interface. Rule 7 only forbids opening the *brain's* database, but this
  would still be a fragile host-internal dependency. **[U]** whether its schema is stable.

**Proposed ledger (Claude Code D3 pattern):** our own per-session store,
`<data-dir>/curated-thoughts/wisdom/sessions/<key>.json`, holding `bootstrap_block`,
`bootstrap_ids`, `activity_ids`, `tool_ids`, `pending_live`, `order`, `state` and `step`. It is
locked with `flock` and written with tmp + `os.replace`. The ledger is
`bootstrap_ids ∪ activity_ids ∪ tool_ids`.

Live ids delivered by the deferred design count as `activity_ids`: they ride in a tool result
too. Under the opt-in transient design, live ids are tracked separately and dropped at the next
user message.

Exactly-once holds as follows:

- **Bootstrap:** the block is re-sent on every model call of every run. It also survives
  compaction, because extras are not part of the history (`docs/providers/anthropic/index.md:234-237`:
  "Legacy per-call hook extras are not included in the compaction snapshot; they are applied
  again on the next normal turn"). Its ids are permanently in context.
- **Tool-result deliveries:** they are in history, so they stay in context across resume. After
  compaction they may be gone, unless they fall in the kept tail: a summary can carry
  `FirstKeptEntry` (`session.go:165-170`, `:2313-2317`), which the hook cannot see. The store
  keeps their ids. A compacted fact may then never come back. That is a loss, never a
  duplicate, and INTENT allows it ("may be delivered again", not "must").
- **Unknown history: the gap.** A branch has a new id, no store, and cloned history that may
  carry our `ct-fact` markers. With a store-only ledger we cannot tell a branch from a fresh
  session, so a fact could repeat. See open decision 4.

---

## 4. Subagents

- **[V]** Sub-sessions (`transfer_task`, background agents, skill sub-sessions) are new sessions
  with `ParentID` = the parent id. They "start in a fresh session and do not see the
  conversation history" (`agent_delegation.go:245-286`; `session.go:1825-1827`;
  `session.go:2196`).
- **[V]** Their hooks fire with **the child's `session_id`**. Tool-event inputs are built from
  the running session (`hooks_input.go:16-23`). `session_start` fires once at the child's
  `RunStream` (`loop.go:412`), on the child agent's executor, and that executor carries the
  global hooks (§1.1).
- **[V] Events that do not reach children:** `user_prompt_submit`, because the kick-off
  message is synthesized (`loop.go:465-469`, `hooks/index.md:461`). `on_user_input` does not
  fire for sub-sessions or non-interactive runs either (`loop.go:236-240`).
- **[V] Parent link:** only on `subagent_stop`, which carries `parent_session_id` and fires on
  the parent's executor (`hooks.go:767-780`). Tool events carry `agent_name` but no parent id.
- **[U] OCI-referenced external sub-agents:** `sub_agents: [name:ref]` is resolved by
  `teamloader.resolveAgentRefs` with the same `runConfig` (`teamloader.go:1237-1270`). The
  flavors doc says external sub-agents "receive the same enabled flavors"
  (`flavors/index.md:52-53`). Whether `MergeAgentHooks` also runs on the loaded external config
  is not checked. It probably does, through the same `Load` path.

For our design: each child is its own context, so it gets its own store and its own exactly-once
ledger. This matches Hermes decision 3 ("subagents get deliveries"). A child gets a bootstrap
(one `ct recall` per child spawn, a cost to weigh) and activity delivery. It gets no live
delivery, because no user message reaches it.

---

## 5. MCP sidecar registration

- **[V]** A local stdio MCP server is a toolset:
  `toolsets: [{type: mcp, command, args, env, working_dir, tools, instruction}]`. It can be
  hoisted into a top-level `mcps:` block and referenced with `{type: mcp, ref: <name>}`
  (`docs/tools/mcp/index.md:55-75`, `:141-177`).
- **[V] No global toolsets exist.** `settings` has `hooks` and `permissions`, but no
  `toolsets` or `mcps` (`pkg/userconfig/userconfig.go` `Settings`;
  `docs/configuration/user-settings/index.md:33-60`). Adding the sidecar means **editing each
  agent file**, or the user adding it themselves.
- **[V] Env:** `${env.VAR}` expands from the OS environment in config fields
  (`tools/mcp/index.md:50`, `:72`). **[U]** whether the MCP subprocess inherits the full OS
  environment when `env:` is given. The hook handler does (`handler.go:191-195`), and the MCP
  launcher probably does too, but this was not read.
- **[V] Tool naming:** the model sees the **bare MCP tool name**
  (`curated_recall_context`), or `<toolset name>_<tool>` when the toolset has a `name:`
  (`pkg/tools/mcp/mcp.go:727-736`). On a name clash "the first one wins"
  (`docs/configuration/tools/index.md:490`). The category is `"mcp"` (`mcp.go:735`), and
  `tool_category` reaches `tool_response_transform` (`dispatcher.go:1193`).
- **[V]** The MCP text contents are **concatenated** into the one `tool_response` string
  (`mcp.go:889-897`). CT's recall returns one JSON text block, so the hook sees the CT JSON
  envelope directly.

CT-tool exclusion (Hermes decision 7) and the dedup matcher: match the regex
`(^|_)curated_[a-z_]+$` plus `tool_category == "mcp"`. This is the Hermes rule, adapted to the
`_` prefix form instead of `__`.

---

## 6. Verbose mode

- **[V]** `system_message` → `WarningEvent` (`hooks.go:134-136`; `pkg/runtime/event.go:377-390`).
  Rendering: a TUI warning notification (`pkg/tui/page/chat/runtime_events.go:72-73`), a "⚠"
  notice in the lean TUI (`pkg/leantui/events.go:148-149`), and `PrintWarning` in non-TUI runs
  (`pkg/cli/runner.go:254-258`). The event is not added to the session messages, so the model
  never sees it.
- **[V]** It works on the events we use: `session_start`, `user_prompt_submit` and the tool
  events (`hooks.go:122-136`; `pkg/runtime/tool_dispatch.go:149`). It does **not** work on
  `session_end` or `notification`, which are dispatched without a sink (`hooks.go:94-98`).
- **[U]** whether a multi-line block survives the TUI toast (it may be truncated), and whether
  warnings are styled in a way that alarms users. A one-line summary in `system_message` plus
  the full block in the log is the safe split.
- **Log:** `<data-dir>/curated-thoughts/wisdom/ct-wisdom-verbose.jsonl` (where
  `<data-dir>` is `$DOCKER_AGENT_DATA_DIR`, else `~/.cagent`), next to the store.
  `ct_wisdom_verbose.log_path` is host-switched inside a byte-identical shared file
  (`integrations/hermes/scripts/ct_wisdom_verbose.py:91-103`). To avoid editing the shared core,
  the adapter can pass an env view with `CT_WISDOM_VERBOSE_LOG` set to this default. `host` is a
  free string in `build_event` (`:176-189`).

---

## 7. Install and distribution

Options compared:

| Option | Edits the user's agents? | Reaches every agent? | Verdict |
|---|---|---|---|
| **`hooks.d` drop-in** (`~/.config/cagent/hooks.d/50-curated-thoughts.yaml`) | No | Yes, for `docker agent run` (§1.1) | **Recommended** |
| `settings.hooks` in `config.yaml` | No, but it edits a shared user file the TUI also rewrites (`user-settings/index.md:30`) | Yes | Worse: shared-file edits are exactly what `hooks.d` exists to avoid |
| A flavor | Yes (the flavor lives in the agent file) | No | Only for agents we ship |
| A published OCI agent (`myorg/ct-coder`) | No, but the user must adopt our agent | Only that agent | An optional extra, not the integration |
| `--hook-*` CLI flags / an alias | No | Only per invocation; only six events have flags (`hooks/index.md:1216-1223`), and `user_prompt_submit` and `tool_response_transform` are not among them | Not viable |

**Recommended layout of the drop-in** (it is written by the installer with resolved absolute
paths, so nothing machine-specific is committed):

```yaml
# ~/.config/cagent/hooks.d/50-curated-thoughts.yaml  (generated by install.sh)
session_start:
  - name: curated-thoughts
    type: command
    command: 'python3 "/ABS/ct_wisdom_da.py" || exit 0'
    timeout: 10
    on_error: ignore
user_prompt_submit:
  - { name: curated-thoughts, type: command, command: '…', timeout: 10, on_error: ignore }
turn_start:            # only if the per-step rate rule needs a step counter (see §9)
  - { name: curated-thoughts, type: command, command: '…', timeout: 2, on_error: ignore }
tool_response_transform:
  - matcher: "*"
    hooks:
      - { name: curated-thoughts, type: command, command: '…', timeout: 5, on_error: ignore }
```

- **Language:** Python 3.9+ stdlib, like claude-code. The Hermes core (`ct_ledger.py`,
  `ct_wisdom.py`, `ct_wisdom_live.py`, `ct_wisdom_verbose.py`, `ct_wisdom_log.py`, and the
  env/status/preflight scripts) is vendored **byte-identically** into
  `integrations/docker-agent/scripts/`, and the parity gate adds the new tree to `COPIES`
  (`tests/tools/test_shared_script_parity.py:39`). Activity delivery needs the activity module
  from the Hermes autonomous-work design. It would either be vendored the same way, which needs
  a parity decision, or written as an adapter-local module.
- **Python availability [U]:** Docker Agent is a Go binary and bundles no Python. On macOS,
  `/usr/bin/python3` can be the Xcode Command Line Tools stub, which opens an install prompt
  when the tools are absent (**[U]**, known platform behavior, not checked here). The installer
  doctor must verify `python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))'` before it
  writes the drop-in.
- **Shell [V]:** the hook command runs under `$SHELL -c`; on Windows under PowerShell or
  `cmd /C` (`shellpath.go:51-92`). `|| exit 0` works in sh, bash, zsh and fish 3+. It does not
  work in Windows PowerShell 5.1 or `cmd`. Windows needs its own command form (**[U]**).
- **Where the files live:**
  - The scripts go under `~/.config/cagent/curated-thoughts/`. The config dir is mounted
    read-only inside sandbox VMs (§8), so the hooks fail quietly there instead of hitting a
    missing file.
  - The store and the log go under the data dir, which is writable.
  - Uninstall deletes the drop-in file and the scripts dir.

---

## 8. Runtime environment: sandbox and cloud

- **[V]** `--sandbox` (or `runtime.sandbox: true` in the agent YAML) launches **Docker Agent
  itself inside a Docker Sandbox VM**. "All tools (shell, filesystem, background jobs, etc.)
  run inside the VM" (`docs/configuration/sandbox/index.md:13-25`, `:186-201`, `:343-352`).
  Hooks therefore run in the VM as well.
- **[V]** The working dir is mounted read-write. The config dir and the staged kit are mounted
  read-only. The VM "has its own filesystem and `$HOME`" (`sandbox/index.md:19-25`, `:361`).
  The default template adds `docker-agent`, `vim`, `tmux`, `kubectl`, `aws` and `docker-mcp` on
  top of `docker/sandbox-templates:shell-docker` (`sandbox/index.md:310-322`).
  **[U]** whether that base has `python3`.
- **[V]** The network is default-deny, with an allowlist (`sandbox/index.md:213-232`, `:348`).
- **[V]** Cloud mode (`--cloud`) uploads no host config, keys or kit (`sandbox/index.md:80-98`).

Consequence: in sandbox mode, `ct` and the CT brain on the host are **not reachable**. There is
no `ct` binary in the VM, and the brain is a host-local store that INTENT rule 7 says we may only
read through `ct`. A remote MCP sidecar (`remote.url`) could serve the agent's own recall
*tool* inside a sandbox, if CT exposed one over HTTP and the allowlist opened it. But it cannot
serve the hooks, which need `ct recall` / `ct wisdom match`. **The integration targets host runs
only. In sandboxed or cloud runs it must do nothing, silently.** That requires `on_error:
ignore`, `|| exit 0`, and a `discover_ct` miss treated as a silent skip. The doctor should warn
when an alias or agent has sandbox enabled.

---

## 9. Feasibility per step and design sketches

### Step 1: session-start block. **Feasible with caveats**

`session_start` (each run) → read the store for `session_id`:

- **Store has `bootstrap_block`** → emit it **byte-identically** (rule 2). This covers every
  later user message, a `--session` resume and compaction.
- **No store** → `recall_wiki` + `render_block` (≤ 2500 chars). Write the store first (D4
  ordering), then emit `{"hook_specific_output":{"hook_event_name":"session_start","additional_context":block}}`.
  If the render is empty or failed, record `bootstrap_block: ""` and **never render later in this
  session**: a later first block would change the system region mid-session.
- Caveats:
  - A pre-install session that is resumed, or a branch, has no store, so it gets a fresh
    block. A branch may then show a fact already in its cloned history (open decision 4).
  - The first run pays ≤ 3 s of recall latency before the first model call.
  - Each child sub-session pays one recall at spawn.

### Step 2: each user message. **Not feasible as specified on the default config; feasible with caveats as deferred delivery**

Default (recommended) design:

- `user_prompt_submit` → apply the provenance check: the event fires only for real user
  prompts, and the Claude Code envelope-tag rule (D5) is kept as defense.
- Then `match_wisdom(prompt, max 2, exclude = ledger)`, written to the store as `pending_live`
  (≤ 1200 chars, corrections first).
- No context is emitted.
- The first `tool_response_transform` of that turn that passes the splice rules (not a CT tool,
  `tool_error` false, payload under the limiter threshold) **claims** the pending facts under
  the lock. It appends the block (marker first, heading `## Curated Thoughts — relevant now`)
  and records the ids.
- The next `user_prompt_submit` drops any unclaimed pending facts. `user_followup_submit` and
  `user_steering_messages_submit` follow the same path.

Opt-in alternative: the user enables Anthropic `cache_preserving_updates` → emit
`additional_context` directly, treat live ids as visible only until the next user message
(§2.3, option 2).

### Step 3: autonomous work. **Feasible with caveats**

`tool_response_transform` (matcher `*`) is both the trigger and the channel:

- Build the activity line from `tool_input` with the Hermes map, adapted to Docker Agent's tool
  names: `read_file`, `write_file`, `edit_file` → `path`; `search_files_content` → `query`;
  `shell` → the first two non-flag tokens of `cmd`, under the Hermes secret rules.
- The query is the **bare target** (A6).
- Skip on the key-change check, the CT-tool check, `tool_error`, and near-limit payloads.
- `ct wisdom match --max 1` within a 3 s budget, then claim under the lock.
- Splice into the result (a JSON-object key, or a `\n\n` append, marker first, ≤ 600 chars) and
  emit `updated_tool_response`. The result is saved and replayed (§3).

Caveats:

- **No `api_request_id` equivalent.** No tool-event field identifies the model step. To keep
  Hermes's "at most one CT call per model step", a cheap `turn_start` hook can increment
  `step` in the store. That is one Python spawn per model call (common fields only, tiny stdin).
  Tool hooks then claim `(session, step)`. The other choice is to drop the per-step rule and
  rely on key-change alone (open decision 3).
- **Latency is on the hot path.** The CT call does not overlap the tool, because the transform
  runs after it. A prefetch from `tool_input_transform` (which runs on every call) would need a
  detached child process that outlives its hook, and **[U]** whether Docker Agent kills the
  hook's process group on exit. That is deferred.
- **Parallel batches.** Several transform processes run at once (§1.4). The claim is the
  locked store read-modify-write, the Claude Code D3 pattern.
- **Per-call process spawn.** Discovery, the capability probe and the match each cost a
  subprocess. A persisted capability cache is needed, as the Claude Code autonomous-work
  section already noted.

### Recall dedup. **Feasible** (needs the sidecar)

`tool_response_transform` on the recall tool (`(^|_)curated_recall_context$`):

- Each `wiki_entries` id already in the ledger becomes the Hermes stub, and new ids join
  `tool_ids`.
- Emit `updated_tool_response` only when something was stubbed. Otherwise emit nothing, so the
  bytes stay unchanged.

### Proposed layout

```
integrations/docker-agent/
  integration.yaml        # id: docker-agent, language: python, matrix like claude-code
  CHANGELOG.md  README.md
  hooks/ct_wisdom_da.py   # one adapter, dispatching on hook_event_name (Claude Code D2 pattern)
  hooks/hooks.d.yaml.in   # drop-in template; install.sh substitutes absolute paths
  scripts/                # byte-identical Hermes core + ct_env/ct_status/ct_preflight/ct_doctor
  scripts/install.sh      # writes the drop-in + scripts; --uninstall removes them; doctor first
  tests/                  # unit + exactly-once (randomized) + byte-identical bootstrap replay
  tests/host/             # host contract (below)
```

**CI and the host contract [V for the mechanism, U for the details]:**

- CI can download the pinned `docker-agent-linux-amd64` v1.150.0 release asset, verified by
  sha256.
- It can run `docker agent run --exec --fake <cassette> --session <fixed-id> agent.yaml` with an
  isolated `DOCKER_AGENT_CONFIG_DIR` (holding our drop-in) and `DOCKER_AGENT_DATA_DIR`, plus a
  fake `ct` on `PATH`.
- `--fake` "Replay[s] AI responses from cassette file (for testing)" (`cmd/root/run.go:192`). It
  is set up after the drop-ins are loaded (`run.go:452`, `:465-466`), so no live model is needed.
- The contract would assert:
  - the payload shapes, on the event ids each hook received;
  - that `updated_tool_response` reaches `session.db`;
  - that `session_start` output is byte-identical across two runs of one session.
- **[U]** how the cassette matches requests. If it matches on the request body, our injected
  bytes must be recorded into the cassette. The `--record` flag generates cassettes
  (`run.go:195`).
- The repo already has a `checks.host` key (`integrations/opencode/integration.yaml:24`).

### Risks

1. **Cache regressions from any per-turn context we emit.** Only `session_start` (replayed) and
   tool results are safe. A future Docker Agent change to extras placement would move this; the
   host contract should pin it.
2. **`session_start` docs and code disagree** ("persists" versus "never persisted"). If upstream
   makes the default persist and run once, our replay still works. If it starts persisting
   *each* run's output, we would duplicate. The host contract must catch that.
3. **Exit code 2 blocks prompts** (§1.4). It is mitigated by `|| exit 0`, but one shell-quoting
   mistake in the installer refuses every user message.
4. **Branches and pre-install resumes** have unknown history (§3). A rule-1 duplicate is
   possible without a transcript-scan ledger.
5. **ACP, API server and MCP mode** do not load drop-ins (§1.1). Editor users get nothing.
6. **Python dependency** on hosts that have Docker Agent through Docker Desktop but no usable
   `python3`.
7. **Sandbox and cloud** runs get nothing (§8). Users of `runtime.sandbox: true` may be
   surprised.
8. **Latency.** Every eligible tool result can wait up to the 3 s budget. On a slow `ct`,
   chatty agents feel it.
9. **The size limiter cuts the block** on large results (§3). Mitigated by skipping
   near-limit payloads.

---

## Open decisions for the user (plain language)

1. **Per-message facts: wait for the agent's first tool call, or ask you to switch on a model
   setting?** In Docker Agent, a fact added to your message is placed in a spot that makes the
   model re-read the whole conversation at full price on the next message. We can avoid that in
   two ways. (a) Deliver the facts with the agent's first tool result in that turn. This is safe
   everywhere, but a reply with no tool use gets nothing. (b) Deliver them with your message,
   but only if you use a recent Claude model with Docker Agent's "cache-preserving updates" switch
   on. The suggestion is (a) by default, with (b) as an opt-in.
2. **Is it OK that the integration only works in normal `docker agent run` sessions?** It does
   nothing in sandboxed or cloud runs, where it cannot reach your brain, or in the editor (ACP),
   API-server and MCP-server modes, which do not load the install file. Fixing the editor case
   would need a change in Docker Agent, or a per-agent install.
3. **How often may facts arrive while the agent works?** Hermes allows at most one per model
   step. In Docker Agent that needs one extra small hook on every model call to count the steps
   (about a twentieth of a second each). The alternative is "only when the agent moves to a new
   file or command", with no per-step cap. Which do you prefer?
4. **Branched sessions.** When you branch a conversation (edit a past message), Docker Agent
   copies the history into a new session that we cannot recognize. A fact shown before the
   branch point could then be shown a second time. We can (a) accept that small risk, or (b) add
   a hook that reads the conversation before each model call to see which facts are already
   there. That is more reliable, but it costs some speed on every call. Which one?
5. **Should helper agents get a session-start block of their own?** Each helper started by
   `transfer_task` or as a background agent is a fresh conversation. Giving each one a block
   costs one extra CT recall per helper.
6. **The MCP search tool needs a line in each agent file.** Docker Agent has no global place to
   add tools. Is it OK if the installer prints the snippet for you to paste, and never edits your
   agent files? The automatic facts work without it.
7. **Python.** Like Claude Code, this integration needs Python 3.9+ on your machine. Is that
   acceptable for Docker Agent users, or do you want a no-Python version later (a different,
   larger job)?

## Items the spec must close (Step-0 targets for the plan)

- Confirm by a live `--fake` run that `session_start` fires on every user message and that its
  output is not written to `session.db` (§2.1).
- Confirm that `updated_tool_response` is what `session.db` stores and what a `--session` resume
  replays (§3).
- Confirm that the drop-in reaches sub-agents and OCI external sub-agents (§1.1, §4 [U]).
- Measure the Python spawn cost per `tool_response_transform` and per `turn_start` on a slow
  machine.
- Decide the Windows hook command form (§7 [U]).
- Check the `--fake` cassette matching rules for the host contract (§9 [U]).
- Check whether `docker/sandbox-templates:shell-docker` has `python3` (§8 [U]). This only
  affects how quietly the integration fails inside a sandbox.

## Alignment with INTENT.md

- **Goal (three steps, every host):** step 1 is feasible. Step 2 is only feasible in a deferred
  form unless the user opts in, and the spec must say what the user loses (no delivery on turns
  without tool calls). Step 3 is feasible.
- **Rule 1 (once):** a store-backed ledger with at-most-once ordering. The one gap is branches,
  open decision 4.
- **Rule 2 (no system-prompt edits):** this rule drives the design. `user_prompt_submit` context
  is rejected on the default config, and the bootstrap is replayed byte-identically.
- **Rule 4 (fail quietly):** `on_error: ignore`, `|| exit 0`, short timeouts, and sandbox runs as
  a silent no-op.
- **Rules 3, 5, 6, 8:** unchanged from the vendored Hermes core.
- **Rule 7:** we read only through `ct` and never open `session.db` or the brain.
- **Out of scope ("harnesses without the extension points we need"):** Docker Agent *has* a
  stable system-prompt region (session-start extras replayed by us) and a way to run read-only CT
  commands (command hooks). It is in scope.

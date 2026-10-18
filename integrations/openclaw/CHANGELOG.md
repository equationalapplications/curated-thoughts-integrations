# Changelog

## Unreleased

## 0.3.5 — 2026-10-17

- Fixed: a CT recall the agent makes through OpenClaw's `tool_call` meta tool now gets the same recall dedup as a direct call — facts already in context come back as "already in context" stubs, and new facts carry their marker. Only the JSON inside OpenClaw's external-content wrapper changes; a result in any shape other than the verified one is left as it is. A rewrite whose new body would contain anything that looks like an external-content marker or an LLM special token (for example, from an escaped character in a kept entry) is refused, and the result is delivered as OpenClaw sent it.

## 0.3.4 — 2026-10-17

- Internal: the pre-flight census tests get a 20 s timeout (they ran past 5 s on Windows CI). No behavior change.

## 0.3.3 — 2026-10-17

- **Fix: a `ct` that hangs past the activity budget now counts against the breaker.** The miss is charged when the budget runs out, not when the query settles (which a hung child never did), so three misses pause CT as on DSH and Hermes.

## 0.3.2 — 2026-10-17

- **Fix: no more hang when a killed `ct` never closes its output** (Windows, or a child process that escaped its process group). The spawn binding now lives in the shared core: one kill path, a 250 ms grace for the output to close once `ct` has exited (for any reason, so a background helper holding the output open no longer turns a finished call into a timeout), no signal to a child that never started or already exited, output capped with no gap after the cap, and a call aborted before it starts spawns nothing. Unlike the old OpenClaw binding, a child that already exited is never signalled (its process-group id may have been reused), so a background helper it started can outlive a killed call.

## 0.3.1 — 2026-10-17

- **Fixed (regression in 0.3.0): long sessions lost both the recall dedup
  and autonomous-work delivery.** The run ledger copied the whole rebuilt
  ledger (history snapshot, drained and bootstrap ids) on every cache
  update, so any session whose history carried more than 256 fact ids
  overflowed it at once, went "blind", and from then on N3 stubbed nothing
  and activity delivered nothing. The run ledger now holds only ids that
  entered context during the run; the snapshot is unioned at read time, and
  overflow means more than 256 NEW ids in one run.
- **Fixed: N3 double pass across module instances.** OpenClaw loads the
  plugin several times per process; when more than one instance's
  middleware sees the same tool result, the second pass could stub the
  facts the first pass had just delivered. The middleware is now idempotent
  per tool result (a marker on the result object and the `toolCallId`).
- Fixed: a retryable activity outcome (budget, CT failure) frees the key
  for a later step but keeps the step used, so a model step never makes a
  second CT call; an unexpected error after the claim releases it.
- Fixed: the first-use locate + capability probe wait is bounded (2 s,
  separate from the 3 s match budget, the probe gets the abort signal);
  still unknown after it → `probe_pending`, and the step is not claimed.
  `wisdomMatch` reuses the in-flight probe instead of starting another.
- Changed (shared core, controller decision): an activity match that runs
  past its budget counts as ONE breaker failure on every host
  (`recordActivityBudgetMiss`, applied by the core to an aborted match); the
  OpenClaw host no longer counts it itself.
- Fixed: a `tool_call` meta-tool recall is read part by part; it is
  "unreadable" (activity off for the run) only when no part holds an
  envelope and some part is not JSON.
- The process-wide state key carries the package version, so a hot reload
  of a new build starts with fresh state.

## 0.3.0 — 2026-10-17

- Added: **autonomous-work delivery** (spec
  `docs/superpowers/specs/2026-10-17-openclaw-autonomous-work-wisdom-design.md`).
  On the embedded runtime, the tool-result middleware sees the result of
  every executed `read`, `write`, `edit`, `grep`, `find`, `exec` or `bash`
  call. The first result of a model step whose activity key is new starts
  `ct wisdom match --max 1 -- <bare target>` (the shared core builder, the 290
  shared vectors and the golden blocks), waits at most 3 s, and appends one
  marker-first block (1 fact, ≤ 600 chars) as its own text block. At most one
  CT call per model step (step = `model_call_started.callId`, a new
  observe-only hook registration); no ceilings. Subagents, cron and heartbeat
  runs are included; the user-turn path is unchanged.
  - The query starts only after the host ran the call: OpenClaw's
    `before_tool_call` runs before plugin and exec approvals (and a throwing
    one blocks the tool), so the plugin registers none. Exec results that are
    approval-pending, unavailable or denied send nothing.
  - A started query that got no answer (budget, CT failure, a gate that
    closed) releases its key; CT's "nothing relevant" keeps it.
  - The ledger is the run's prompt-hook snapshot plus a run ledger of every
    id that entered context during the run (the live block, salvaged blocks,
    tool-result markers, recalls, activity deliveries). No snapshot of the
    run in this process → no delivery.
  - Verified live (stub CT, ZAI GLM-5.3-FLASH): the rewritten tool result is
    in the next model request, in the transcript, replayed byte-identically
    by a fresh process and in the next `before_prompt_build` snapshot (A3).
  - Verbose mode records activity outcomes with channel `activity`.
- Fixed: OpenClaw loads the plugin module several times per process and
  serves the prompt hooks and the tool-result middleware from different
  instances (found live). All wisdom state now lives in one process-wide
  holder. Before this, the recall dedup ran with an empty ledger in the
  middleware instance and never stubbed a repeated fact.
- Review fixes (PR #67): the run snapshot is stored before the admission
  memo (a re-run under a new runId keeps activity delivery); the brain
  directory follows the current registration's config; discovery and the
  capability probe are warmed outside the 3 s match budget, an abandoned
  match is killed and counts toward the breaker; an empty runId is no run;
  compaction during a run (`before_compaction` / `after_compaction`) blinds
  the run (no activity delivery, no recall stubs) until the next snapshot;
  the run ledger is bounded (overflow blinds the run). Shared core budget
  helpers come from the OpenCode leg (#66), unchanged.
- Known limit: a recall the model makes through OpenClaw's `tool_call` meta
  tool is not stubbed by the recall dedup; its facts do join the run ledger
  (activity never repeats them), and an unreadable one turns activity off
  for the rest of the run.
- e2e: `tests/e2e/run_activity.sh` (isolated `HOME`, state and brain; stub CT
  and stub MCP sidecar; `activity_verdict.py`).

## 0.2.2 — 2026-10-16

- Fixed (shared `ct-wisdom-core`): a live delivery could show a fact twice
  when CT returned a correction whose own id was already in context, or the
  same id both as an entry and as a correction. A correction now rides only
  when it supersedes an id in context and is itself new, and each id is
  delivered at most once per block. This deliberately aligns the TypeScript
  core with the Hermes reference (`ct_wisdom_live.render_live_block`) and
  the live-delivery spec's step 7. Also fixed: the block and query caps
  now count and cut by code point, so a cut never splits an emoji or other
  non-BMP character (the Python hosts already did). The core
  also gained the autonomous-work activity API for a later OpenClaw leg;
  OpenClaw does not call it yet, so there is no other behavior change.
  Why dropping a correction loses nothing: CT emits a correction only for
  an id the plugin sent in `--exclude`, which is always a fact in context
  (the live-delivery spec, CT guarantee 3). A correction that supersedes
  nothing in context can only come from a stale exclude list, and its job
  (marking a fact the agent sees as replaced, INTENT rule 3) has no target.
  A newer fact that replaces something the agent has NOT seen is an ordinary
  fact: CT returns it in `entries` whenever it matches the query, and it is
  delivered like any other (CT guarantee 2 keeps the superseded one out).

## 0.2.1 — 2026-10-16

- Fixed (documented and diagnosed): a brain with an external embedder lost
  its API key at the sidecar. OpenClaw 2026.10.3 starts a plugin-declared
  stdio MCP server from the MCP SDK's default environment only (`HOME`,
  `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) plus the server's `env`, and the
  plugin manifest cannot refer to the user's environment. The fix is a user
  `mcp.servers.curated-thoughts` row, which replaces the manifest row and
  forwards the key as a `${NAME}` reference.
  - New doctor check `sidecar-env` (after `embedding-backend`). It reads the
    brain's `embed_profile` and the user row, and warns with the exact row to
    add when the key (or a non-default brain location) is not forwarded, or
    when a forwarded name is unset. Read-only; names only, never values.
  - `install.sh` and the README explain the row.

## 0.2.0 — 2026-10-16

- Added: Verbose mode for Intuitive Wisdom (opt-in, off by default). With
  `CT_WISDOM_VERBOSE=1`, every live-delivery decision is recorded: the
  delivered block with its fact ids, titles, provenance and CT's scores, or
  the reason nothing was delivered (`deduped`, `no_match`,
  `gate_uncalibrated`, `budget`, `breaker_open`, a timeout, ...). It goes to a
  local JSON Lines log (`CT_WISDOM_VERBOSE_LOG` overrides the path) and to a
  channel the user sees and the model does not. Verbose output never changes
  the system prompt, the delivered block or any tool result; with verbose off
  the hooks behave and return exactly as before (tests compare both).
  Spec: `docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md`.
  On OpenClaw the notice goes to the plugin logger (`api.logger.info`, so
  `openclaw logs --follow` shows it). No in-chat surface is used, because
  each one would reach the model. The log is
  `$OPENCLAW_STATE_DIR/logs/ct-wisdom-verbose.jsonl` (default
  `~/.openclaw/logs/`). Reader:
  `node lib/ct-wisdom-core/cli/ct-wisdom-log.js --host openclaw` from the
  installed plugin directory.

## 0.1.1 — 2026-10-16

- Changed: Intuitive Wisdom live delivery has no per-session cap. The
  vendored shared core drops `MAX_PER_SESSION = 12` and the `--max 0`
  switch, and `Ledger.liveDeliveredCount` (read only by the cap) is
  removed, with `snapshotScan`'s user-role `live` set.
  Why: an autonomous agent is better served by more wisdom than less. The
  cap stopped delivery after about 6 matching turns, though a fact that
  matches late in a session is as valuable as an early one. Noise stays
  bounded per turn (at most 2 facts in a 1200-character block, only facts
  past CT's relevance gate), delivery never touches the system prompt, and
  dedup keeps the session total to the distinct facts that match.
  Unchanged: the per-turn limits, CT's score gate, dedup and exactly-once
  delivery, the breaker, timeouts and the 256-id exclude bound.

## 0.1.0 — 2026-10-16

First release: a native **OpenClaw** plugin (host pin `openclaw@2026.10.3`,
`openclaw.compat.pluginApi >=2026.10.3`; spec
`docs/superpowers/specs/2026-10-16-openclaw-wisdom-parity-leg-design.md`, parent
`2026-10-09-cross-harness-wisdom-parity-design.md`). The manifest flips from the
stale `language: python` placeholder to `language: node`, `status: implemented`.

- **Registration.** `openclaw.plugin.json` (id `curated-thoughts`) mounts the CT
  MCP sidecar (`curated-thoughts-mcp --mcp`) as a plugin-owned stdio server and
  ships the three skills (`curated-thoughts-usage`, `-ops`, `-sidecar`; usage and
  sidecar byte-identical to Hermes). The build vendors ct-wisdom-core into
  `lib/ct-wisdom-core` and rewrites its import (`scripts/vendor_core.mjs`,
  the opencode leg's approach), so the payload loads with no `node_modules` at
  all. `scripts/install.sh` is preview-first: it stages that self-contained
  copy, then runs `openclaw plugins install … --force --accept-capabilities` and grants
  `hooks.allowConversationAccess` plus a 20 s `before_prompt_build` budget, only
  under `CT_INSTALL_EDIT=1`. The doctor (`node lib/scripts/ct_doctor.js check`)
  reads OpenClaw's JSON5 config for the entry and its grant.
- **Bootstrap (N5, greenfield v1).** A seed-query recall block (Hermes v1
  constants, `<!-- ct-fact:<id> -->` markers, id-less entries dropped) rides
  `prependSystemContext` with per-session memoized bytes.
- **Intuitive Wisdom live delivery** on `@equational-applications/ct-wisdom-core`
  (annex A). N1 = `before_prompt_build`, gated to `ctx.trigger === "user"`,
  non-`external_user` provenance and `subagent:` sessions excluded; N2 =
  `prependContext`, which the embedded runner freezes into the user turn's
  persisted model-prompt projection. The ledger is rebuilt from the hook's
  `messages` snapshot (deviation from the parent spec: `readTail` exists only on
  `session_end`), unioned with the bootstrap ids and with ids drained from our
  own next-turn injections. A result the host no longer accepts (handler
  timeout) is salvaged through `api.session.workflow.enqueueNextTurnInjection`;
  `agent_turn_prepare` observes the drain so the three channels never
  double-deliver. N3 = runtime-neutral tool-result middleware on
  `*__curated_recall_context` only (stub repeats, marker trailer for new ids).
  A rebuild/retry of one admitted request returns the identical result with no
  second CT call.
- **Tests.** Unit, a randomized 150-session exactly-once property test across
  all three channels with retries, compaction and restarts (mutation-checked),
  and a shape-level host contract against the recorded pin facts
  (`tests/host/compatibility.json`) — weaker than opencode's real-binary
  contract; no gateway runs in CI.

**AC 9 cache gate — verdict: cache-safe (embedded runner, openclaw 2026.10.3).**
Captured 2026-10-16 with `tests/e2e/run.sh`: a real native install into an
isolated state dir, two `openclaw agent --local` turns in one session against
ZAI `GLM-5.3-FLASH` through a body-only recording proxy, stub `ct`. The system
prompt carrying the bootstrap block was byte-identical across both turns (and
across the two processes); turn 1's user message with its live block was
replayed byte-identically as turn 2's prefix; turn 2's block rode only the last
user message and repeated no turn-1 id (`--exclude` carried both turn-1 ids and
the bootstrap id). The verdict rests on that request-prefix byte identity;
ZAI's provider-side cache counters were inconsistent between runs (turn-2
`cacheRead` 64 in one run, 0 in another) and are not used as evidence, while
OpenClaw's own cache observer reported `broke: false` on every call.
Codex/Copilot runtimes are not covered by this verdict.

**Live e2e:** executed (above) for N1/N2, bootstrap, restore (each `--local`
turn is a fresh process) and exactly-once. Pending: a live N3 middleware
rewrite (the model did not call the recall tool in the captured turns) and
live-gateway (`openclaw gateway`) behavior — post-merge tracking per decision 8.

# Changelog

## Unreleased

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

# OpenClaw leg — Intuitive Wisdom parity (openclaw 0.0.0 → 0.1.0) — design

**Date:** 2026-10-16 · **Status:** Approved (autonomous — design judgment delegated
by the user; brainstorming run without a question loop, alternatives and
self-review recorded below) · **Repo:** equationalapplications/curated-thoughts-integrations
**Base:** `origin/main` @ `b36123b` · **Branch:** `feat/openclaw-wisdom-parity`
**Parent spec:** `2026-10-09-cross-harness-wisdom-parity-design.md` (OpenClaw row,
decisions 5, 6, 8, 10, N5 table, AC 1–11, annex A, Risks) · **Parent plan:** Task 5.
**Host investigation:** `docs/superpowers/investigations/2026-10-09-parity-host-openclaw.md`
(docs-based, nothing executed). This spec re-verifies every load-bearing fact
against the published package at a pinned version — see "Host pin and verified facts".

## Problem

OpenClaw is the last harness without a Curated Thoughts integration:
`integrations/openclaw/` holds only a `status: planned` manifest (with a stale
`language: python`). The leg ships a greenfield native OpenClaw plugin that
(a) mounts the CT MCP sidecar and the three shared skills, (b) renders the v1
bootstrap block (N5, greenfield), and (c) delivers Intuitive Wisdom live, once
per genuine user turn, exactly-once across every channel it writes, on the
shared `@equational-applications/ct-wisdom-core` algorithm (annex A).

## Host pin and verified facts

**Pin: `openclaw@2026.10.3`** (npm, published 2026-10-13, latest stable at
verification was 2026.10.4 one day old; 2026.10.3 chosen as the newest stable
with ≥ 3 days of field time). Engines: `node >=24.16.0 <25 || >=26.1.0`.
Verification method: the published tarball was downloaded and its shipped
`docs/`, `dist/*.d.ts` and `dist/*.mjs` were read; the package was also
installed natively (`npm install openclaw@2026.10.3`, ~3 min on the dev Mac,
`openclaw --version` → `OpenClaw 2026.10.3 (59cb447)`). Tags: [D] shipped docs,
[T] shipped type declarations, [S] shipped compiled source.

| # | Fact | Evidence |
|---|---|---|
| F1 | Entry: default export `{ id, name, description, configSchema, register(api) }`; `definePluginEntry` is an identity-shaped helper (no runtime magic) — the plugin can ship without importing `openclaw` at runtime | [S] `dist/plugin-entry-*.mjs` |
| F2 | Native manifest `openclaw.plugin.json` (JSON5) at plugin root; fields used: `id`, `name`, `description`, `version`, `configSchema`, `skills: string[]` (skill dirs relative to root), `activation.onStartup`, `activation.onCapabilities: ["hook"]`, `contracts.agentToolResultMiddleware: string[]`, `mcpServers: { <name>: { transport, command, args } }` (included only while the plugin is enabled; user `mcp.servers.<name>` overrides) | [D] `plugins/manifest*.md`, `manifest/surfaces.md`, `manifest/capabilities.md` |
| F3 | `package.json#openclaw.extensions` (entry list) and `openclaw.compat.pluginApi` (semver floor) | [D] `manifest/package-json.md` |
| F4 | `api.on(name, handler, { priority, timeoutMs, … })`; `PLUGIN_HOOK_NAMES` includes `before_prompt_build`, `agent_turn_prepare`, `session_end`, … | [T] `hook-runner-global-*.d.ts` |
| F5 | `before_prompt_build` event = `{ prompt, currentUserMessage?, currentUserMessageId?, messages: unknown[] }`; result fields `prependContext`, `appendContext`, `systemPrompt`, `prependSystemContext`, `appendSystemContext`, `toolsAllow` | [T] |
| F6 | Agent hook ctx: `sessionKey?`, `sessionId?`, `runId?`, `agentId?`, `trigger?` (`"cron" \| "heartbeat" \| "user"`), `inputProvenance?.kind` (`external_user \| inter_session \| internal_system`, plus `sourceRole?: "subagent"`), `hookInvocation?.assertActive()` | [T] + [D] `hooks/prompt-and-session.md` |
| F7 | Default `before_prompt_build` budget 15 s, log-and-skip on timeout; overridable by `api.on(..., { timeoutMs })` and operator `plugins.entries.<id>.hooks.timeouts.before_prompt_build` (≤ 600000) | [S] `hooks-*.mjs` (`before_prompt_build: 15e3`), [D] `hooks/reference.md` |
| F8 | **Embedded runner places `prependContext` inside the current user message**, not at the front of the request: `composeModelPromptContext([prependContext, prompt, appendContext])` becomes the user turn's `__openclaw.modelPromptProjection` (version 1), captured **once** per admission by the transcript recorder; on every later request `projectRecordedModelPrompt` replays that frozen projection for historical user messages. CLI runner prepends it to the prompt string. | [S] `builtin-openclaw-*.mjs` `installModelPromptProjection`, `user-turn-transcript.message-*.mjs` |
| F9 | The `messages` handed to prompt hooks are a detached snapshot via `projectModelContextMessages`, which strips only `__openclaw.upstreamUserText` and tool-result `details` — `__openclaw.modelPromptProjection` survives | [S] `hooks-*.mjs` `runModifyingHook`, `model-context-message-*.mjs` |
| F10 | `api.session.workflow.enqueueNextTurnInjection({ sessionKey, agentId?, text, idempotencyKey?, placement?: "prepend_context"\|"append_context", ttlMs?, metadata? })` → `Promise<{ enqueued, id, sessionKey }>`; drained before prompt hooks on embedded/CLI, joined into the same turn `prependContext`; deduped by `idempotencyKey` | [T] + [S] `context-engine-maintenance-*.mjs` `resolvePromptBuildHookResult` |
| F11 | `agent_turn_prepare` receives `{ prompt, messages, queuedInjections: PluginNextTurnInjectionRecord[] }` (records carry `pluginId`, `text`, `metadata`) and runs after the drain, before `before_prompt_build` | [T] + [S] |
| F12 | `api.registerAgentToolResultMiddleware(handler, { matcher?, runtimes? })`; event `{ toolCallId, toolName, args, isError?, result: { content, details } }`, ctx `{ runtime, sessionKey?, sessionId?, runId?, agentId? }`; return `{ result }` replaces the result the embedded runner hands back to the agent loop. Installed plugins must declare the runtimes in `contracts.agentToolResultMiddleware`. Text blocks ≤ 100 000 chars | [T] + [S] `builtin-openclaw-*.mjs` tool_result factory, `tool-result-middleware-*.mjs` |
| F13 | MCP tools are projected as `<safeServerName>__<toolName>` (sanitized, collision suffix `-N`); an MCP CallToolResult becomes `{ content: [text blocks…], details }`; with `structuredContent` the first text block is `structuredContent:\n<json>` | [S] `agent-bundle-mcp-names-*.mjs`, `mcp-content-*.mjs` |
| F14 | Non-bundled plugins need `plugins.entries.<id>.hooks.allowConversationAccess: true` for `before_prompt_build` and `agent_turn_prepare`; `allowPromptInjection: false` blocks both and durable injections | [D] `plugins/hooks.md` |
| F15 | Subagent sessions carry a `subagent:` session-key segment (`isSubagentSessionKey`) | [S] `session-key-*.mjs` |

### Deviations from the parent spec (adapted design, documented)

1. **Ledger source is the prompt hook's `event.messages` snapshot, not `readTail`.**
   `readTail` exists only on `session_end`'s `ctx.endedTranscript` (the ended
   transcript reader, [T] `PluginHookEndedTranscript`); no per-turn transcript
   reader is exposed to plugins. `before_prompt_build`'s `messages` *is* "what
   the NEXT trigger reads" — the host's prepared model context for this run,
   including persisted `modelPromptProjection` text (F8, F9). Fail-closed rule
   carries over: `messages` absent / not an array ⇒ no delivery that turn.
2. **The durable channel is a salvage path, not a second primary.** In-turn
   `prependContext` is primary. `enqueueNextTurnInjection` is used only when
   the in-turn result can no longer be accepted (`ctx.hookInvocation.assertActive()`
   throws after the awaited CT call — handler timed out). Cross-channel dedupe
   is host-observed: the plugin registers `agent_turn_prepare` to read *its
   own* drained injection records for the turn and unions their ids into the
   turn's ledger (they are in this turn's prompt), so `before_prompt_build`
   never re-delivers them in the same request; after the turn they are in the
   persisted projection and the ordinary scan sees them.
3. **N3 matcher is name-suffix based inside the handler**, not a static
   `matcher` list: the projected id depends on the operator's server name and
   collision suffixes (F13). Rule: tool name matches
   `/__curated_recall_context(-\d+)?$/`; `curated_get_wiki_entry` never matches (m4).
4. **Restore rule:** OpenClaw re-sends the system prompt every request, so the
   bootstrap the model sees is whatever this process renders now. "Restored" =
   the first time this process sees a session whose snapshot already holds
   assistant turns; it fails closed (no live delivery) only while this process
   has no settled bootstrap record for it (Hermes M2 analog). Compaction keeps
   `sessionKey` (investigation N4); the ledger is "what the model can see"
   (Hermes scope-b semantics — the decision-3 carry-forward deviation is
   OpenCode-only).

## Approaches considered

**A — `before_prompt_build` in-turn primary + salvage injection + middleware
(chosen).** One hook reads the explicit request and the persisted context,
returns the block in the same turn; exactness from host-observed state only.
Cache-safe by construction per F8 (block rides the tail user message and is
frozen per admission). Durable path covers the 15 s timeout risk.

**B — Durable-injection primary** (compute at `agent_end`, enqueue for next
turn). Rejected: wisdom arrives one turn late (wrong moment — the product
premise is "at the moment it is relevant"), and `agent_end` sees the
assistant's reply, not the next user message.

**C — `agent_turn_prepare` as N1.** Rejected: receives `prompt` but not
`currentUserMessage` (prompt may contain reconstructed history, F5 docs), and
it is not wired on Codex/Copilot either; `before_prompt_build` has strictly
more.

**Bootstrap placement alternatives:** (i) `prependSystemContext` (chosen —
documented as provider-cacheable system space; memoized bytes per session ⇒
stable prefix); (ii) `registerMemoryPromptSupplement` (rejected: its contract
and ids are undocumented at the pin, investigation NOT-CHECKED item);
(iii) workspace bootstrap file via internal `agent:bootstrap` hook (rejected:
coarse internal hook, no typed result, mutates user workspace state).

## Architecture

```
integrations/openclaw/
  openclaw.plugin.json        F2 manifest: skills, mcpServers, contracts, activation
  package.json                openclaw.extensions → ./lib/src/index.js; compat.pluginApi >=2026.10.3
  src/index.ts                default plugin entry; registers hooks + middleware (thin)
  src/host.ts                 narrow local types for the OpenClaw API surface we touch
  src/wisdom/bootstrap.ts     v1 bootstrap: discovery, async `ct recall`, render, memo (N5)
  src/wisdom/adapter.ts       HostAdapter binding for ct-wisdom-core (ledger, N2/N3 shims)
  src/wisdom/spawn.ts         async child_process SpawnFn (3 s budget hygiene)
  src/wisdom/discover.ts      `ct` discovery + identity probe (async)
  scripts/ct_env.ts, ct_doctor.ts, ct_preflight.ts, _compat_generated.ts, _lazy_loader.ts
  scripts/install.sh          preview-first: prints/applies `openclaw plugins install` + grants
  skills/curated-thoughts-{usage,ops,sidecar}/SKILL.md
```

`ct-wisdom-core` is consumed exactly as deepseek does (`file:` dependency, built
before install in CI, vendored at `lib/ct-wisdom-core` for the release
archive). **No ct-wisdom-core changes.**

### Hook wiring (per user turn, embedded/CLI runner)

1. Host drains queued injections → `agent_turn_prepare` (ours): collect ids
   from records whose `pluginId === api.id` (metadata `ctFactIds` ∪ marker scan
   of `text`) into `drained[sessionKey#runId]`. Returns nothing.
2. `before_prompt_build` (ours, `timeoutMs: 20000`, priority default):
   - **Gate (N1):** `ctx.trigger === "user"`; `inputProvenance.kind`, when
     present, must be `external_user` and `sourceRole` must not be `subagent`;
     session key must not contain a `subagent:` segment; `sessionKey`
     non-empty. Failing the gate ⇒ return only the bootstrap (never live).
   - **Admission guard (n2 / AC 11):** key = `sessionKey#(currentUserMessageId ?? runId)`.
     Both absent ⇒ no live delivery (fail-safe). A repeat call with the same key
     (rebuild/retry of one admitted request) returns the *identical* memoized
     result — never a second computation, never a dropped block.
   - **Bootstrap (N5):** `prependSystemContext` = memoized block for
     `sessionKey|sessionId` (rendered once; settled outcomes memoized).
   - **Live (annex A via `onUserTurn`):** query = `currentUserMessage` when it is
     a string, else `prompt` (legacy hosts; documented degraded). Ledger =
     scan(`messages`: user `content` + `__openclaw.modelPromptProjection.text`,
     `toolResult` content) ∪ bootstrap memo ids ∪ `drained` ids for this run.
     Live count (M1) = distinct ids in user-role markers.
   - After the awaited CT call: `ctx.hookInvocation?.assertActive()`; if it
     throws, salvage — `enqueueNextTurnInjection({ sessionKey, agentId, text:
     block, idempotencyKey: "ct-wisdom:" + ids, placement: "prepend_context",
     ttlMs: 1 800 000, metadata: { ctFactIds: ids } })`; else return
     `{ prependContext: block, prependSystemContext: bootstrap }`.
3. Tool-result middleware (`runtimes: ["openclaw"]`): CT recall results only;
   envelope = text blocks whose JSON (optionally after the `structuredContent:\n`
   prefix) has a `wiki_entries` array; `onToolResult` stubs repeats and appends
   one `<!-- ct-fact:<id> -->` trailer line per new id to the first recall
   block; returns `{ result }` only when changed.

### Error handling

Every hook body is wrapped: an exception logs via `api.logger.warn` and returns
`undefined` (OpenClaw keeps other plugins' results). CT failures are silent no-ops
under the core breaker (3 fails → 300 s). Bootstrap has its own breaker
instance and a per-session two-attempt budget (Hermes v1 parity). Capability
probe `ct wisdom match --help` is cached positive per process; a non-zero exit
latches OFF (deterministic absence); a spawn-class failure resets discovery and
the probe (n3).

### Budgets (Risks: 15 s prompt budget)

Live CT budget is the core's 3 s. Worst case on a session's first turn:
discovery probe ≤ 3 s + bootstrap recall ≤ 5 s + capability probe ≤ 3 s +
match ≤ 3 s = 14 s; the hook registers `timeoutMs: 20000` and the installer
also proposes `hooks.timeouts.before_prompt_build: 20000`. A late result is
salvaged by the durable channel, never lost or duplicated.

## Cache safety (decision 5, AC 9)

Code-level verdict at the pin: **cache-safe on the embedded runner** — the live
block lands inside the current user message (tail of the request), is frozen
into the transcript as that message's model-prompt projection, and is replayed
byte-identically on later requests (F8); the bootstrap rides
`prependSystemContext` with per-session memoized bytes. The claim stays
**conditional** until a live capture confirms it: AC 9 is met either by a
captured two-turn request/stream comparison attached to the PR, or by invoking
the 2026-10-04 defer-and-accept default and recording it in the CHANGELOG.

## Runtime support matrix (README)

| Runtime | N1/N2 live | Durable salvage | N3 dedup | Notes |
|---|---|---|---|---|
| Embedded (default) | yes | yes | yes | target runtime |
| CLI runner | yes | yes | n/a (CLI owns tools) | prependContext prepended to prompt string |
| Codex app-server | degraded | no (no drain) | yes for projected MCP tools | `agent_turn_prepare` not wired; projection persistence unverified |
| Copilot | degraded | no | not declared | — |

## Acceptance criteria (this leg)

Inherited AC 1–11 from the parent spec, bound to OpenClaw:

1. ct-wisdom-core suite green; openclaw adapter binding tests green.
2. Randomized multi-channel exactly-once test: prependContext, salvage
   injection (drained, observed via `agent_turn_prepare`), and middleware, with
   compaction (markers dropped from the snapshot) and restore (new process,
   persisted snapshot) paths — no id ever appears twice in what the model reads
   within its visible window.
3. Ledger semantics: ledger equals the ids the next `before_prompt_build`
   snapshot actually carries (projection + tool results) ∪ bootstrap ∪ drained.
4. Fail-closed: capability absent ⇒ no-op; breaker trips ⇒ paused; restored
   session without settled bootstrap ⇒ no live delivery, bootstrap intact;
   `messages` not an array ⇒ no delivery; missing admission id ⇒ no delivery.
5. Marker hygiene: forged `ct-fact:` in fact text, user text, and recall
   entries can only suppress, never duplicate.
6. Manifest: `language: node`, `status: implemented`, `version: 0.1.0`,
   `version_mirror: package.json#version`; manifest/policy/generate/readme gates green.
7. CI: openclaw joins the integration matrix (discovered automatically) and the
   core build step; shape-level host contract runs in its `checks.test`; ci.yml
   documents the tier as weaker than opencode's real-binary contract.
8. CHANGELOG `## 0.1.0 — 2026-10-16`; integration README.
9. Cache gate per the section above.
10. Live e2e: attempted only if the host installs natively in reasonable time;
    otherwise recorded pending with the reason (decision 8: openclaw has no
    pre-merge e2e obligation beyond the cache gate).
11. Self-trigger guard: a retry/rebuild of the same admission returns the same
    result without a second CT call; drained salvage injections never re-fire
    delivery; our own delivery text never becomes the next query.

## Shape-level host contract (decision 10)

`tests/host/compatibility.json` records the pin and the fact table's checkable
items (hook names, event/result field names, manifest fields, middleware
runtime ids). `tests/host/contract.test.ts` (vitest, runs in `checks.test`)
loads the built entry against a recording stub `api`, asserts the registration
shape (hooks, options, middleware runtimes ⊆ manifest contracts, skills dirs
exist, mcpServers row), and asserts every hook name and result field we use is
in the recorded pin facts. It does **not** run the real gateway — weaker than
opencode's real-binary contract, and ci.yml says so.

## Results (2026-10-16, recorded at implementation)

- **Real-host install** (isolated `OPENCLAW_STATE_DIR`, openclaw 2026.10.3 native):
  `scripts/install.sh` → `plugins install` accepted surface
  `contracts: agentToolResultMiddleware: openclaw`, `mcpServers: curated-thoughts`,
  `skills: skills`; `plugins inspect --runtime` → `status: loaded`, typed hooks
  `agent_turn_prepare` + `before_prompt_build`, `policy.allowConversationAccess:
  true`, `hookTimeouts.before_prompt_build: 20000`, no diagnostics; `skills list`
  → all three skills `ready`; doctor check 7 PASS on the real config.
- **AC 9 — cache-safe (embedded runner).** `tests/e2e/run.sh`, two
  `openclaw agent --local` turns (fresh process each — restore path) against ZAI
  `GLM-5.3-FLASH` through a body-only recording proxy: system prompt (bootstrap
  marker `boot-procedures`, `cache_control` set) byte-identical across turns;
  turn-1 user message with its live block replayed byte-identically as turn 2's
  prefix; turn-2 block only in the last user message. Persisted transcript event
  carries `__openclaw.modelPromptProjection.text` = block + user text (F8 live).
  Provider cache counters were inconsistent between runs and are not evidence.
- **Live exactly-once:** turn-2 `ct wisdom match` argv carried
  `--exclude=w-release --exclude=w-lockfile --exclude=boot-procedures` (snapshot
  projection ids newest first, then bootstrap) and delivered only `w-third`.
- **Not exercised live:** N3 middleware rewrite (the model made no recall call),
  salvage injection (needs a real hook timeout), `openclaw gateway` mode. Covered
  by unit + property tests; post-merge tracking per parent decision 8.
- `llm_input` observation hooks did not fire on one-shot `--local` runs, hence the
  proxy-based capture.

## Out of scope / follow-ups

- Persisting the bootstrap memo in `registerSessionExtension` state across
  gateway restarts (today a restart re-renders; one cache miss).
- Codex/Copilot first-class support.
- `requiresToolAuthority` phase (CT is reached by CLI subprocess, not a tool).

## Self-review (inline, done)

- Placeholders: none. Every deviation names its evidence.
- Consistency: ledger rule (deviation 1) is the same in hook wiring, AC 3 and
  the contract; durable channel role (deviation 2) is identical in the wiring
  and AC 2.
- Scope: one plugin, one plan; tagging is post-merge (controller).
- Ambiguity resolved: query source (currentUserMessage first), admission key,
  restore definition, N3 match regex, budgets.

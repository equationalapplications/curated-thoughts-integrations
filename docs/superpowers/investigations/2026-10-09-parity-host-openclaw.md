# Step-0 Host Investigation: OpenClaw Plugin/Extension Surface vs CT 'Intuitive Wisdom Live Delivery'

*Investigator: Hermes subagent · Date: 2026-10-09 · Read-only audit*
*Question: can OpenClaw host CT live delivery? Needs: N1 (per-user-turn hook w/ message text), N2 (host-persisted append channel into the turn's request, cache-safe, never mutating the built system prompt), N3 (tool-result transform for specific MCP tools), N4 (stable session identity across compaction + history access, or fail-closed restore), N5 (access to our own bootstrap block's ids).*

## Verdict up front

**FEASIBLE — high capability parity.** OpenClaw's typed plugin hook system (`api.on(...)`) covers N1–N4 with first-class, documented seams, several of which are *stronger* than typical harness plugin surfaces (durable next-turn injections, runtime-neutral tool-result middleware with tool matchers, bounded ended-transcript reader). N5 is the only partial: there is no first-class "bootstrap block id" API; a CT plugin would have to own and self-identify the bootstrap content it injects. Main costs: all plugin APIs are explicitly **experimental** (pin host version), two permission gates are required (`allowConversationAccess`, prompt-injection default-allowed but denyable), and hook budgets (15 s default on prompt hooks) bound CT recall latency. Evidence tags: [V] = verified from fetched OpenClaw docs/source; [C] = constructed/inference from verified facts.

## Local evidence
- **No local OpenClaw checkout exists on this machine.** Searched `~/code`, `~/.hermes`, home dirs: only hits are (a) `~/hermes-agent-workspace/openclaw-ct-feasibility.md` (Aug 2026 study) and (b) a `status: planned` CI stub at `~/code/github/equationalapplications/curated-thoughts-integrations/integrations/openclaw/integration.yaml` ("not yet implemented"). Findings below are repo/docs-based. [V]
- The Aug 2026 study covers CT-as-MCP-*server* deployment (docker, stdio vs streamable-http, single-writer WAL) but not live-delivery hooks N1–N5. This file covers that gap. [V]

## Architecture context

- Gateway/channel-based (WhatsApp/Telegram/Discord…). The LLM request is assembled in the **agent loop**: session resolution → workspace/skills → bootstrap files injected into system prompt → prompt build (plugin hooks fire here) → model submission. Runs are serialized per `sessionKey` ("session lane"). [V — docs.openclaw.ai/concepts/agent-loop, github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md]
- System prompt = base prompt + skills prompt + bootstrap context + per-run overrides; compaction reserve enforced. [V — concepts/agent-loop]
- Runtime variance matters: the **embedded runner** and **CLI runner** have the fullest hook coverage; the Codex app-server harness and Copilot harness omit some seams (details under each need). [V — plugins/hooks, plugins/hooks/reference]

## The extension surface

Two hook systems ([V — docs.openclaw.ai/plugins/hooks, docs2.openclaw.ai/concepts/agent-loop]):
1. **Typed plugin hooks** — `api.on("hook_name", handler)` inside `definePluginEntry({ register(api) })`. This is the CT-relevant surface.
2. **Internal hooks** — `HOOK.md` scripts on colon events (`command:new`, `agent:bootstrap`, `session:compact:*`); coarse, no typed results.

Key typed hooks (complete catalog at docs.openclaw.ai/plugins/hooks/reference) [V]:
- Agent turn: `before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`, `before_agent_run`, `before_agent_reply`, `before_agent_finalize`, `agent_end`, `heartbeat_prompt_contribution`
- Tools: `before_tool_call` (matcher on tool ids), `after_tool_call` (observe), `tool_result_persist` (sync rewrite before transcript persistence), `before_message_write`
- Messages: `message_received` (inbound content/sender/thread), `message_sending`, `inbound_claim`, `before_dispatch`, `reply_dispatch`
- Sessions: `session_start`/`session_end` (with bounded `endedTranscript.readTail`), `before_compaction`/`after_compaction`, `before_reset`
- LLM observe: `llm_input` (system prompt, prompt, history), `llm_output`

Permissions [V — plugins/hooks]: non-bundled plugins need `plugins.entries.<id>.hooks.allowConversationAccess: true` for `before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`, `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`, `agent_end`, `before_agent_run`. `allowPromptInjection: false` blocks `agent_turn_prepare`, `before_prompt_build`, `heartbeat_prompt_contribution`, and durable next-turn injections (defaults to allowed). Hook failures have per-hook default policies: `before_agent_run`/`before_tool_call` fail closed (15 s); `before_prompt_build` logs-and-skips the failed handler (15 s); persistence hooks are synchronous with no async timeout.

## Capability table

### N1 — Hook firing once per user turn WITH the user's message text: **YES**
- `before_prompt_build` receives the prepared prompt + session messages, and on supported harnesses `currentUserMessage` (the current request before history/context projection) + `currentUserMessageId` (stable per admission). Docs explicitly say: use the explicit request for intent detection; `prompt` may contain reconstructed history; don't parse envelope markers. [V — plugins/hooks/prompt-and-session]
- `ctx.trigger === "user"` distinguishes user runs from heartbeat/cron (`eligibleTriggers: ["user"]` can restrict `before_agent_reply`; trigger context is available on prompt hooks). `ctx.inputProvenance.kind` (`external_user` / `inter_session` / `internal_system`) further classifies origin on embedded/CLI/Codex/Copilot paths. [V — prompt-and-session]
- Alternates: `agent_turn_prepare` (receives current prompt + drained injections; earlier phase); `message_received` (observe inbound content, but fires at channel ingress, not the model request); `before_agent_run` (gate, receives prompt + history; embedded/CLI + Gateway node admission only — docs warn not to rely on it for Codex/Copilot). [V — hooks/reference]
- Caveat: `currentUserMessage` is optional per harness; Codex refresh without a recorder supplies text but no admission ID. A CT plugin must handle omitted fields fail-safe. [V]

### N2 — Host-persisted append channel into that turn's request (cache-safe, never mutating built system prompt): **YES — two complementary seams**
- **In-turn (primary for live delivery):** `before_prompt_build` returns `prependContext` / `appendContext` — documented as *per-turn dynamic text*, explicitly distinct from `systemPrompt` / `prependSystemContext` / `appendSystemContext` which are "stable guidance that belongs in system prompt space". Returning context does not replace the system prompt. So CT recall for the current user message can be injected in the same hook that reads `currentUserMessage`. [V — prompt-and-session, docs2 concepts/agent-loop]
- **Durable next-turn injection:** `api.session.workflow.enqueueNextTurnInjection(...)` — host-persisted, drained before prompt hooks, exactly-once, deduped by `idempotencyKey`, dropped if expired or plugin inactive; "the right seam for … background monitor deltas … that should be visible to the model on the next turn but should not become permanent system prompt text." Survives restart (restart preserves extension state and pending injections; reset/delete/disable cleans them). [V — prompt-and-session]
- **Plugin-owned persistent state:** `api.session.state.registerSessionExtension(...)` — small JSON state persisted in session rows, patchable via Gateway `sessions.pluginPlayback`/`pluginPatch`; lets CT store per-session recall bookkeeping host-side. [V — prompt-and-session]
- Cache-safety caveat [C]: docs guarantee injections/context do not become system-prompt text, but the exact wire placement of `prependContext` relative to history (front-of-prompt vs before-user-turn) is not specified in the fetched pages — verify with `--raw-stream --raw-stream-path` capture on the embedded runner before relying on prefix-cache behavior.
- Ordering [V]: embedded/CLI path = drain queued injections → `agent_turn_prepare` → heartbeat contribution → ordinary `before_prompt_build` → finalized tool policy → authorized enrichment (`requiresToolAuthority: true` phase — useful if CT recall must respect the turn's tool policy). Not wired into Codex/Copilot prompt paths.
- Latency budget [V]: 15 s default per-handler on `before_prompt_build`; operator can raise via `plugins.entries.<id>.hooks.timeouts.before_prompt_build` (≤600000 ms). A timed-out handler's result is dropped — CT must return within budget or the wisdom is silently skipped (log-and-skip, not fail the turn).

### N3 — Tool-result transform for specific MCP tools: **YES**
- `api.registerAgentToolResultMiddleware(handler, { runtimes, matcher })` — "trusted seam for async tool-result transforms that must run before OpenClaw or Codex feeds tool output back into the model." Matcher is a list of canonical tool ids; omit to match all. Requires manifest `contracts.agentToolResultMiddleware: ["openclaw", "codex"]` (installed plugins rejected if undeclared). The legacy embedded-runner-only extension factory is removed; this is the supported path. [V — plugins/sdk-agent-harness/attempt-runtime, plugins/sdk-migration/how-to-migrate, src/plugins/agent-tool-result-middleware.ts]
- MCP tools are materialized as regular agent tools with **projected model-facing names** `<safeServerName>__<toolName>` (sanitized/truncated/collision-suffixed via `buildSafeToolName`), carrying plugin meta `mcp: { serverName, safeServerName, toolName }`. So the middleware matcher can target CT's MCP tool ids, and/or the handler can inspect `mcp` meta rather than trusting the projected name. [V — src/agents/agent-bundle-mcp-materialize.ts, agent-bundle-mcp-types.ts, PRs #98195/#118275 on raw vs projected naming]
- Complementary: typed `tool_result_persist` hook synchronously rewrites a toolResult **before transcript persistence** (affects what future turns/compaction see); `after_tool_call` is observe-only. [V — hooks/reference]
- Runtime caveat [V]: on Codex, transformed output reaches the model only for Codex *dynamic* tools (which projected MCP tools are); Codex-native tool results are relayed for observation but their transformed output never reaches the model.
- Naming caveat [C/V]: because projected ids can carry collision suffixes, pin the matcher to names printed by `openclaw mcp probe` at install time, or match on `mcp.toolName`+`mcp.serverName` meta inside the handler.

### N4 — Stable session identity across compaction + history access (or fail-closed restore): **YES**
- `ctx.sessionKey` is available across hook contexts; runs are keyed and serialized per `sessionKey`. [V — hooks/reference, concepts/agent-loop]
- Compaction preserves identity: "The built-in SQLite compactor keeps the current session identity and does not create a second runtime transcript"; compaction only changes what the model sees, full history stays on disk. Typed hooks `before_compaction`/`after_compaction` fire on the boundary (observe-only). [V — concepts/compaction, hooks/reference]
- History access: `llm_input` observe hook (system prompt, prompt, history — requires conversation access); `before_agent_run` receives `messages`; `session_end` grants a bounded immutable `endedTranscript.readTail(maxMessages, maxBytes)` reader with explicit fail-closed contract: `{ available: false, reason }` when no safe source (missing permission, deleted state, etc.) — exactly the fail-closed-restore shape CT needs. [V — hooks/reference]
- Session lifecycle: `session_start`/`session_end` with reasons (`new`, `reset`, `idle`, `daily`, `compaction`, `deleted`, `shutdown`, `restart`); `/new`/reset semantics distinct from compaction. Shutdown drain for `session_end` handlers is a 2 s total budget. [V]
- Caveat [C]: identity is stable *within the built-in runtime's session store*; if the operator resets (`/new`), CT gets `before_reset`/`session_end(reason: reset)` and should treat CT-side session memory accordingly.

### N5 — Access to our own bootstrap block's ids: **PARTIAL**
- No first-class API exposes stable ids of bootstrap blocks inside the built system prompt. Bootstrap files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md, MEMORY.md; TOOLS.md deprecated → merged into AGENTS.md) are resolved and injected into the system prompt during the agent loop. [V — automation/hooks/bundled-hooks, concepts/agent-loop, tools/plugin]
- What exists: the **internal** hook `agent:bootstrap` fires "while building bootstrap files before the system prompt is finalized" with `context.bootstrapFiles` (mutable array) + `context.agentId` — a plugin/internal hook can see and add/remove bootstrap files. The bundled `bootstrap-extra-files` hook shows the pattern (glob-inject workspace files, per-file and total char caps). [V — concepts/agent-loop, automation/hooks, src/hooks/bundled/README.md]
- Also relevant: `api.registerMemoryPromptSupplement(builder)` / `registerMemoryPromptPreparation(prepare)` register additive memory-adjacent prompt sections — OpenClaw's sanctioned slot for exactly the kind of block CT's bootstrap occupies, though the fetched pages don't document block ids on it. [V — plugins/sdk-overview/infrastructure]
- Assessment [C]: CT can fully control the *content* it contributes (via bootstrap file, memory-prompt supplement, or `before_prompt_build` system-context fields) and can therefore mint and track its own ids for recall references — parity by self-management, not by host introspection. What OpenClaw does NOT provide is a host-side handle to "the block we injected" post-build (e.g., to verify placement or ids after system-prompt assembly). `llm_input` exposes the full system prompt text, so post-hoc verification by string presence is possible [C]. Design the CT plugin to not depend on host-issued block ids; treat absence as fail-closed.

## Proposed integration shape [C — from verified seams]

One native OpenClaw plugin (TypeScript ESM, `definePluginEntry`, manifest `contracts`), plus CT MCP server registered under `mcp.servers.curated-thoughts` (streamable-http per the Aug study):
1. `api.on("before_prompt_build", ..., { requiresToolAuthority: true })` → read `currentUserMessage`, `ctx.trigger === "user"`; call CT recall over the CT MCP tool via toolAuthority check; return `{ prependContext }` (N1+N2 in-turn path).
2. In `agent_end` / `after_tool_call`: compute deltas and `api.session.workflow.enqueueNextTurnInjection(...)` for durable cross-turn wisdom (N2 durable path); keep per-session state in `registerSessionExtension`.
3. `api.registerAgentToolResultMiddleware(..., { runtimes: ["openclaw"], matcher: ["curated-thoughts__wiki_context", ...] })` → rewrite CT tool results (N3); manifest declares `agentToolResultMiddleware`.
4. `api.on("session_start"/"session_end")` + `before_compaction`/`after_compaction` keyed on `ctx.sessionKey` for identity and fail-closed restore via `endedTranscript.readTail` (N4); `before_reset` clears CT-side session state.
5. Bootstrap: ship CT guidance as a workspace bootstrap file (or `registerMemoryPromptSupplement`) and self-manage ids inside the plugin (N5); verify presence via `llm_input` if needed.
6. Config: `plugins.entries.ct-wisdom = { enabled: true, hooks: { allowConversationAccess: true } }`; operator budget `hooks.timeouts.before_prompt_build` sized to CT recall latency.

## Risks / open items
1. **Experimental API surface** [V]: "All OpenClaw plugin APIs are experimental… contracts can change between OpenClaw releases." Pin host + `openclaw.compat.pluginApi` and re-test per release.
2. **Runtime variance** [V]: Codex/Copilot prompt paths omit `agent_turn_prepare` + injection draining; `toolsAllow` narrowing rejected on Codex; `before_agent_run` not a reliable gate on Codex/Copilot. Target the **embedded runner** first.
3. **15 s prompt-hook budget** [V]: CT recall exceeding it is silently skipped. Measure; consider operator timeout config + precomputed/pushed injections (seam 2) as the fast path.
4. **Projected MCP tool naming** [V]: matchers must use exact projected ids or `mcp` meta; sanitization/collision suffixes can rename tools.
5. **Placement of `prependContext` vs provider prompt-cache prefix** — unspecified in fetched docs [C]; verify empirically with `--raw-stream` capture (N2 cache-safety claim).
6. **Permissions**: two operator grants required (`allowConversationAccess`; `allowPromptInjection` must not be `false`). Hook policy changes hot-reload under default hybrid reload mode. [V]
7. Unrelated to this audit but carried from the Aug study: CT MCP server deployment (HTTP sidecar vs same-container stdio), WAL single-writer discipline. [V — local study]

## Sources
Local: `~/hermes-agent-workspace/openclaw-ct-feasibility.md`; `~/code/github/equationalapplications/curated-thoughts-integrations/integrations/openclaw/integration.yaml`. Web (fetched 2026-10-09): docs.openclaw.ai `/plugins/hooks`, `/plugins/hooks/reference`, `/plugins/hooks/prompt-and-session`, `/plugins/sdk-overview` (+ `/infrastructure`), `/plugins/sdk-agent-harness/attempt-runtime`, `/plugins/sdk-migration/how-to-migrate`, `/plugins/manifest/capabilities` (via search), `/cli/mcp`, `/concepts/agent-loop`, `/concepts/compaction`, `/automation/hooks/bundled-hooks`, `/gateway/config-extensions`, `/tools/plugin`; docs2.openclaw.ai `/concepts/agent-loop`, `/plugins/architecture`; github.com/openclaw/openclaw `docs/plugins/hooks.md`, `docs/concepts/agent-loop.md`, `src/plugins/agent-tool-result-middleware.ts`, `src/agents/agent-bundle-mcp-materialize.ts`, `src/agents/agent-bundle-mcp-types.ts`, `src/hooks/bundled/README.md`, PRs #98193/#98195/#118275/#13861.

## NOT CHECKED
- Live runtime behavior: no OpenClaw install/checkout here, so nothing was executed — no actual hook dispatch observed, no `--raw-stream` capture of where `prependContext` lands in the provider request (prompt-cache placement), no `openclaw mcp probe` output for a real CT server.
- Exact TypeScript payload shapes of `before_prompt_build` event/ctx fields (`currentUserMessage`, `inputProvenance`, `hookInvocation`) beyond doc prose.
- Whether `registerMemoryPromptSupplement` sections receive/permit stable ids (N5).
- Behavior of third-party (non-embedded) agent harness plugins beyond docs; ACP bridge mode explicitly lacks per-session MCP injection [V — cli/mcp] and was not investigated further.
- Whether Codex-runtime middleware transforms of *projected MCP* tools specifically (vs Codex-native) reach the model — inferred yes from "dynamic tools" wording, not executed.

# Step-0 investigation — cross-harness Intuitive Wisdom parity (DSH, OpenClaw, Claude Code, OpenCode)

**Date:** 2026-10-09 · **Author:** Tessera (controller) · **Status:** rev 3 (post GLM-critique r1; per spec, all resolve-before-spec items closed)
**Directive:** Kurt, 2026-10-09 (thread): next CTI PR = parity of DSH, OpenClaw, Claude Code
(+ OpenCode) with the Hermes integration, releases for all, README revision + dedicated
Intuitive Wisdom section. Opened as DRAFT per SOP (draft-until-implemented, Kurt Oct 9).
**Rev 3 note:** incorporates all findings of the Opus 5.5 doc review (M1–M3, m1–m5);
the RESEARCH_REQUESTs were answered by direct tarball reads at the new pin
(`host-dsh-semantics.md` §Addendum, controller-verified). Rev 2 adjudicated the
GLM critique (13 findings).

## Question

Can each integration target reach the Hermes 0.4.1 "Intuitive Wisdom live delivery"
behavior, and what does parity concretely require per host?

## Method

Survey of `integrations/*` at `main` `6ec6fe9` plus six evidence investigations
(all under `docs/superpowers/investigations/` on the PR branch):

1. `2026-10-09-parity-current-state-survey.md` — repo + all five integrations vs the
   Hermes reference (N1–N5 capability model).
2. `2026-10-09-parity-host-claude-code.md` — Claude Code official docs (hooks, plugins).
3. `2026-10-09-parity-host-openclaw.md` — OpenClaw plugin/extension surface.
4. `2026-10-09-parity-host-dsh-opencode-freshness.md` — DSH/OpenCode version freshness;
   found the 2026-09-30 DSH step-0 conclusion wrong (hooks existed at the pin).
   **Supersession annotation (rev 2):** this doc's "OpenCode: still structural NO"
   headline is superseded by investigation 5 — the pin *note* understated 1.18.31's
   own surface; no newer version changes it. Freshness doc gets an annotation in the PR.
5. `2026-10-09-parity-host-opencode-recheck.md` — OpenCode SDK re-investigation from
   tarballs + host source; flips the survey's "structurally impossible" verdict.
6. `2026-10-09-parity-host-dsh-semantics.md` — DSH pre-step persistence semantics +
   `tools/post-execute` registration path — **complete**; addendum covers the
   0.2.0-rc.2 pin itself (verbatim append, log-derived request, MCP→ToolRuntime
   routing, needsPost semantics). All pre-spec evidence items are CLOSED.

Opus 5.5 doc review of rev 2: `step0-critique-opus.json` — REQUEST CHANGES on
rev 2 (M1 gate ambiguity, M2 pin-version evidence gap, M3 CC ledger/resume
contradiction; m1–m5); all resolved in rev 3 (research requests answered by
direct tarball reads at the new pin).

Capability needs (from the Hermes reference): N1 per-user-turn trigger with user
message text · N2 host-persisted cache-safe append channel (never the system prompt) ·
N3 MCP tool-result transform · N4 stable session identity + ledger-rebuild source
(fail-closed on restore) · N5 knowledge of our own bootstrap block ids.

## Verdict table (rev 2 — confidence + conditions per row)

| Host | N1 | N2 | N3 | N4 | N5 | Parity verdict (confidence, conditions) |
|---|---|---|---|---|---|---|
| Hermes 0.4.x (reference) | pre_llm_call [V] | {"context"} → api_content sidecar [V] | transform_tool_result [V] | conversation_history + memo, fail-closed restore [V] | bootstrap memo [V] | shipped 0.4.0 |
| DeepSeek (pin → 0.2.0-rc.2) | `agent/pre-step` (UserMessage[], can replace) [V] | **PERSISTED [V at pin]** — 0.2.0-rc.2 `step()` appends pre-step messages verbatim to the session log (`session.append("user/message", …, {surfaceOp:"append"})`, firstAttempt only), request built from the log via `deriveMessages()` → stable prefix across retries (inv. 6 + addendum). Note: 0.2.1-alpha.x adds a `runtime-context` rewrite branch — adapter emits plain `source.kind` (never `runtime-context`) | `tools/post-execute` — **CORE event** in `dsh-tools` event map; **MCP tools register into the harness ToolRuntime** (`syncTools` → `ctx.tools`), so MCP executions take the post-execute path (`needsPost: true` on normal outcomes) [V at pin, addendum] | agent.id stable across compaction [V] | memo exists; markers to add [V] | full port feasible — **high confidence; N1–N4 verified at the pinned version; N5 = memo + markers** |
| OpenCode (pin → 1.18.35) | `chat.message` (UserMessage, pre-LLM, persisted mutation) [V] | **CHOSEN: `chat.message` append (persisted)** — `messages.transform` REJECTED for delivery (wire-only structuredClone breaks ledger/exactly-once, F1) [V] | `tool.execute.after` (mutates output; covers MCP; persisted) [V] | `client.session.messages()` reads the persisted channel the ledger needs [V]; compaction ctx injection for gate [V] | bootstrap block greenfield [C] | full port feasible — **medium confidence; largest scope: v1 bootstrap + live + N5 all greenfield (F6)** |
| Claude Code (current) | `UserPromptSubmit` — REQUIRES provenance filter (fires on scheduled/subagent/background turns; fail-safe = skip, F4) [V] | `additionalContext` — transcript-persisted, replayed verbatim on --resume [V] | `PostToolUse` `mcp__*` matchers, `updatedToolOutput` replaces [V]; **ledger source (decided, M3): `${CLAUDE_PLUGIN_DATA}` keyed by session_id is the ONLY ledger; the transcript is never consulted — on resume, new/unknown session_id ⇒ live delivery stays OFF for that session (Hermes restored-session semantics); no "re-arm" path in v1** | session_id + transcript_path [V]; resume id stability undocumented [C-risk] | plugin-owned bootstrap logging [C] | full integration feasible — **medium confidence; v1 resume = permanently degraded (dead live delivery on resumed sessions, mirrors Hermes restored sessions); transcript-derived recovery = tracked follow-up** |
| OpenClaw (current, experimental APIs) | `before_prompt_build` (currentUserMessage + id, ctx.trigger gate) [V] | **mechanism [V] / cache placement [C — raw-stream test required, F5]**; CHOSEN: ship conditional, raw-stream capture is an implementation-phase gate | `registerAgentToolResultMiddleware` + matchers [V] | sessionKey stable across compaction; readTail fail-closed [V] | self-managed via `registerMemoryPromptSupplement` [C] | full integration feasible — **medium confidence; conditions: cache gate (F5), runtime matrix (embedded/CLI only v1, F13)** |

## Decisions (rev 2/3 — all binding for the spec)

1. **One shared algorithm, per-stack ports (F2 blocker resolved; sharing
   clarified per m3).** The intuitive-wisdom algorithm (INTENT 2026-10-01)
   is the reference; it is PORTED per language stack: **Python**
   (hermes — existing; claude-code — hook handlers are shell commands
   reading JSON on stdin, Python works), **TypeScript** (deepseek,
   opencode, and **openclaw — language flips from the stale
   `language: python` manifest placeholder to TS** per the verified plugin
   surface (`definePluginEntry`, ESM APIs); the stale manifests are
   corrected in this PR). **Code sharing (m3):** the TS legs share one
   workspace-internal core package (`@equational-applications/ct-wisdom-core`:
   ledger semantics, budgets, capability probe, breaker, rendering —
   host adapters stay thin); the Python legs share a `shared/` module
   (claude-code imports Hermes' Python core directly — both live in this
   monorepo). The spec defines a normative algorithm pseudocode annex as
   the behavioral contract for both cores.
2. **DSH corrections travel with the PR (F12):** fix the 2026-09-30 DSH step-0
   doc's "no per-user-turn hook" claim and the deepseek `compatibility.json`
   note; **bump the DSH compatibility pin to 0.2.0-rc.2** (hook surface identical
   across 0.1.5-rc.2→0.2.0-rc.2 per inv. 4); **bump the opencode pin to 1.18.35**
   (dist byte-identical 1.18.31↔1.18.35 per inv. 5).
3. **OpenCode delivery channel = `chat.message` persisted append (F1 blocker
   resolved):** delivery text appends to the user turn via `chat.message`
   (persisted), so `client.session.messages()` sees it and the exactly-once
   ledger derives from persisted history — same shape as Hermes' {"context"}
   append (host persists; adapter never touches the system prompt; INTENT
   Rule 2 holds). `experimental.chat.messages.transform` is NOT used for
   delivery (m1: it is the channel whose compaction caveat mattered).
   **Post-compaction ledger semantics (m1):** compaction hides earlier
   messages from LLM context while they remain in storage, so
   `client.session.messages()` shows "delivered" for facts the model can no
   longer see; the adapter uses `experimental.session.compacting` to carry
   the delivered-ids ledger forward across compaction, and bootstrap facts
   re-surface via the normal bootstrap path post-compaction. Injected
   delivery rides a `synthetic: true` text part.
   **Subagent policy (m2):** `chat.message` exposes no subagent flag;
   OpenCode task-tool child sessions fire it — the adapter maintains the
   delivered-ids ledger per session id, and delivers in parent sessions
   only; a child session whose ledger is empty still consults the parent
   record when one exists (best-effort), else skips (fail-safe). Named
   risk: cross-session double delivery; acceptance test covers it.
4. **Claude Code policies (F4, F6; ledger source finalized per Opus M3):**
   (a) trigger filter — respond only to hooks whose input proves a genuine
   user turn; provenance unclear ⇒ skip (fail-safe); (b) subagent policy —
   deliver in the main thread only; subagent-context hook invocations skip;
   (c) **ledger source — exactly one: the plugin's own
   `${CLAUDE_PLUGIN_DATA}` store keyed by session_id. The transcript is
   NEVER consulted by the v1 ledger.** (d) resume semantics — **true
   fail-closed (Opus M3 option i): `SessionStart(source=resume)` marks the
   session live-delivery-OFF for its entire life — there is NO re-arm path
   (every delivery is triggered by a user turn, so "re-arms on a fresh
   turn" would be meaningless and would re-deliver replayed facts against
   an empty ledger). Resumed sessions = dead live delivery in v1, exactly
   like Hermes restored sessions; bootstrap block still renders.
   Transcript-derived ledger recovery is a tracked follow-up, not v1.**
   (e) subagent double-delivery is a named risk with (b) as mitigation.
5. **OpenClaw cache safety (F5):** mechanism verified; wire placement of
   `prependContext` relative to the provider cache prefix is NOT verified. Ship
   the OpenClaw leg with the cache-safety claim **conditional**; a live
   `--raw-stream` capture is the gate for that leg — **pre-merge by default,
   or post-merge if Kurt accepts the conditional claim (per the 2026-10-04
   checkpoint ruling, an unanswered checkpoint defaults to defer-and-accept;
   that default applies here).**
6. **Exactly-once is an acceptance criterion per host (F7):** every host ships a
   randomized multi-channel exactly-once test (Hermes' `test_exactly_once.py` is
   the pattern), adapted to that host's channels, including compaction and
   restore paths. OpenClaw's host-level exactly-once guarantee scopes ONLY to
   `enqueueNextTurnInjection` — the plugin dedupes across its three channels.
   **DSH ledger rule (m5): the ledger is rebuilt from the session log
   (`deriveMessages`/history), NEVER from the adapter's own decision — a later
   listener may reject/replace the batch, so decision-time marking would count
   facts that never reached the model. The normative annex states this per host:
   the ledger's source of truth is whatever the NEXT trigger will read.**
7. **Release/version matrix (F8, explicit):** `deepseek-v0.3.1` and
   `opencode-v0.1.1` are NEVER tagged — superseded inside this PR. The PR bumps
   **deepseek → 0.4.0**, **opencode → 0.2.0** (changelogs fold the 0.3.1/0.1.1
   entries in), debuts **claude-code → 0.1.0**, **openclaw → 0.1.0** (status
   `planned → implemented`). Post-merge tags: `deepseek-v0.4.0`,
   `opencode-v0.2.0`, `claude-code-v0.1.0`, `openclaw-v0.1.0`. No hermes bump
   unless the shared annex forces docs changes (then docs-only 0.4.2).
8. **Per-host verification strategy + PR-internal ordering (F9):**

   | Host | CI can prove | Pre-merge e2e | Post-merge tracking |
   |---|---|---|---|
   | deepseek | stub-host contract + unit + exactly-once prop test | live `pre-step` e2e (harness installable locally) | — |
   | opencode | real-binary host contract (extends existing job) + unit | live `chat.message` e2e | — |
   | claude-code | hook-registration shape + unit (no host in CI) | local `claude` CLI e2e if available | resume-id stability, rewrite-replay persistence |
   | openclaw | manifest/registration shape + unit (weakest tier — no runtime in CI) | raw-stream cache gate (decision 5) | live-gateway behavior |

   Ordering inside the PR: **DSH → OpenCode → Claude Code → OpenClaw** (existing
   harnesses first, greenfield last). Each leg is independently committable.
9. **README (Kurt directive, F13):** full revision — per-integration entries for
   all five; first-class **Intuitive Wisdom** section (algorithm, per-host
   support matrix, CT ≥ 3.3.0 requirement, per-host degradation paths). The
   matrix states OpenClaw per-runtime support (embedded/CLI supported v1;
   Codex/Copilot degraded/unsupported) and install-time permission gates
   (`allowConversationAccess`, prompt-injection not disabled) + timeout
   requirements; the Claude Code entry notes the enterprise
   `allowManagedHooksOnly` deployment caveat.
10. **CI stub-host contracts:** taught/added per leg in its own commit: DSH and
    opencode get the new hooks in their existing checks; claude-code and
    openclaw get shape-level contracts (registration/manifest), explicitly
    weaker than Hermes' importable-host pattern — documented as such in ci.yml.

## Risks (rev 3)

- Cache invariant (INTENT Rule 2): sharpest on TS hosts. Mitigated by decision 3
  (OpenCode persisted append) and decision 5 (OpenClaw conditional gate). DSH N2
  persistence verified at the pin (inv. 6 addendum); the 0.2.1-alpha
  `runtime-context` rewrite branch is a named trap — the adapter emits a plain
  `source.kind` only.
- Claude Code: subagent double-delivery (mitigation 4b); `session_id` stability
  across --resume undocumented — moot for v1 exactly-once because resumed
  sessions are live-delivery-OFF (decision 4d: empty-ledger re-delivery cannot
  happen when delivery is off); `updatedToolOutput` rewrites may not replay —
  the ledger never depends on them; enterprise `allowManagedHooksOnly` limits
  where hooks run (README degradation note).
- OpenClaw: experimental APIs (pin host version); 15 s prompt-hook budget ⇒ CT
  timeouts tight (reuse 3 s live budget); runtime matrix limited v1 (decision 9).
- OpenCode scope is the largest (bootstrap + live + N5 all greenfield) — plan
  sized accordingly; it also has the best CI story (real-binary contract job).
- Exactly-once is enforced by OUR plugin logic on every host; no host-level
  guarantee substitutes (decision 6; OpenClaw's durable-injection guarantee is
  channel-scoped only).
- CT-side: `ct wisdom match` relevance gate rarely fires on real messages
  (curated-thoughts#271); supersessions await Librarian. Parity is structural,
  not behavioral, until CT lands — unchanged from Hermes status.

## Resolve-before-spec — ALL CLOSED (rev 3)

- ~~OpenCode channel choice~~ — decided (decision 3).
- ~~OpenClaw language~~ — decided (decision 1, TS).
- ~~CC trigger/subagent/resume/ledger policies~~ — decided (decision 4,
  incl. Opus M3: plugin-data ledger, resume = delivery-OFF, no re-arm).
- ~~OpenClaw cache resolution path~~ — decided (decision 5, default
  defer-and-accept per 2026-10-04 ruling).
- ~~Release/version matrix~~ — decided (decision 7).
- ~~Verification strategy + ordering~~ — decided (decision 8).
- ~~DSH N2 persistence + N3 registration path~~ — VERIFIED at the 0.2.0-rc.2
  pin (inv. 6 + addendum: verbatim append, log-derived request, MCP tools
  route through the harness ToolRuntime → post-execute; `final-result`
  outcomes bypass post-execute — the stub path tolerates that).

## NOT CHECKED (deferred — genuinely empirical, tracked for review)

- Claude Code: `session_id` byte-stability across --resume/fork (v1 makes it
  moot for exactly-once — resumed sessions are delivery-OFF); replay
  persistence of `updatedToolOutput` (ledger never depends on rewrites);
  multi-plugin rewrite conflicts.
- OpenClaw: live gateway behavior beyond the raw-stream cache gate.
- Live e2e for all four adapters (implementation-phase work per decision 8).
- DSH `tools/post-execute` coverage of `final-result`-style bypass outcomes
  (inv. 6 addendum: bypasses post-execute — the stub design must not assume
  every execution passes through it; degrades to no stub, not double text).

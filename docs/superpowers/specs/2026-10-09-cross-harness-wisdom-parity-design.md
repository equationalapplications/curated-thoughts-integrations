# Cross-harness Intuitive Wisdom parity (DSH, OpenCode, Claude Code, OpenClaw) — design

**Date:** 2026-10-09 · **Status:** Draft rev 2 (post GLM-critique r1; pending GLM re-check + Kurt approval) ·
**Controller:** Tessera · **Repo:** equationalapplications/curated-thoughts-integrations
**Base:** `origin/main` @ `272d7ea` (re-based from investigation's `6ec6fe9`; PR #36
merged 2026-10-09 12:12 EDT — see "Delta vs investigation rev 3" below)
**Investigation:** rev 3 (`docs/superpowers/investigations/2026-10-09-parity-step0-investigation.md`).
Builds on: `2026-10-06-intuitive-wisdom-live-delivery-design.md` (Hermes reference, PR #35)
and INTENT invariant adjudication (2026-10-05).

## Problem

Intuitive Wisdom live delivery — the agent knowing the curated fact at the moment it
is relevant, once, on a host-persisted append channel — shipped only for Hermes
(v0.4.0, PR #35). The other four integrations do not have it. This PR ports the
behavior to DSH (DeepSeek), OpenCode, Claude Code, and OpenClaw, corrects the stale
documentation the investigation found, revises the README with a first-class
Intuitive Wisdom section, and cuts a release per touched integration.

The behavior contract is Hermes' shipped implementation; nothing in this PR changes
the Hermes leg's behavior — with the two explicitly adjudicated deviations below
(OpenCode compaction carry-forward, Claude Code resume rule). CT stays read-only
behind the same `ct wisdom match` contract (CT ≥ 3.3.0); the plugin never scores,
ranks, or thresholds.

## Delta vs investigation rev 3 (found at re-base, 2026-10-09)

PR #36 (`fix/claude-code-usage-skill-parity`, merged today) shipped the Claude Code
plugin skeleton at **v0.1.1** (tagged `claude-code-v0.1.1`): skills (usage/ops/sidecar),
`ct_env/ct_status/ct_preflight/ct_doctor`, installer, and a SessionStart hook that
emits the status section only. It contains **no live delivery** — no
UserPromptSubmit, no PostToolUse, no wisdom module — so every investigation decision
stands. Consequence for the release matrix (decision 7): Claude Code is a feature
bump from an implemented base, not a debut: **claude-code 0.1.1 → 0.2.0** (minor:
new capability, no breaking change to its shipped surface). All other numbers
unchanged. `status: implemented` is already true for claude-code; only OpenClaw
flips `planned → implemented` in this PR.

## Capability model (from the Hermes reference)

| # | Capability | Meaning |
|---|---|---|
| N1 | per-user-turn trigger | hook/transform that fires once per genuine user turn and can read the user message |
| N2 | cache-safe append channel | host-persisted delivery surface that never touches the system prompt |
| N3 | tool-result transform | intercept of tool results (incl. MCP) for dedup stubs |
| N4 | session identity + ledger source | stable id + a persisted record the exactly-once ledger can rebuild from, fail-closed on restore |
| N5 | bootstrap awareness | knowledge of our own v1 bootstrap block's fact ids |

Per-host verdicts and all evidence are in the investigation; none are re-litigated
here. Confidence: DSH high (verified at pin), OpenCode / Claude Code / OpenClaw
medium with named conditions.

## Binding decisions (investigation rev 3, all carry into this spec)

1. **One shared algorithm, per-stack ports.** The Hermes `ct_wisdom_live.py`
   algorithm is the normative reference (annex A). Ports: **TypeScript** — DSH,
   OpenCode, OpenClaw (OpenClaw's manifest flips `language: python → node` in this
   PR; the stale manifest placeholder is corrected) — sharing one workspace-internal
   core package `@equational-applications/ct-wisdom-core` (ledger semantics, budgets,
   capability probe, breaker, rendering; host adapters stay thin). **Python** —
   Claude Code imports the Hermes core directly (`integrations/hermes/scripts/`)
   from `integrations/claude-code/hooks/`; no copy. Both cores satisfy the same
   annex contract; per-host divergence is confined to adapter shims (channel I/O,
   envelope shapes).
2. **Doc/pin corrections travel with the PR.** Fix the 2026-09-30 DSH step-0 doc's
   "no per-user-turn hook" claim; fix the deepseek `compatibility.json` note; bump
   the DSH pin to **0.2.0-rc.2**; bump the opencode pin to **1.18.35**
   (dist byte-identical 1.18.31↔1.18.35). The DSH adapter emits a plain
   `source.kind` only — never the 0.2.1-alpha `runtime-context` rewrite branch.
3. **OpenCode delivery channel = `chat.message` persisted append.**
   `experimental.chat.messages.transform` is NOT used for delivery (wire-only
   clone breaks ledger/exactly-once). Post-compaction ledger carries forward via
   `experimental.session.compacting`; injected text rides a `synthetic: true` part.
   Subagent policy: deliver in parent sessions only; child sessions with an empty
   ledger consult the parent record best-effort, else skip (fail-safe). Named risk:
   cross-session double delivery; acceptance test covers it.
   **Adjudicated deviation (m3):** carrying delivered ids forward across compaction
   means a fact compacted out of the model's context is never re-delivered — the
   *opposite* of Hermes scope-b. This is deliberate: investigation decision 3 chose
   the stronger exactly-once for OpenCode's persisted-history ledger. AC 3 for the
   OpenCode leg is therefore "post-compaction ledger = pre-compaction ledger ∪
   deliveries", not "ledger = what the model can see".
4. **Claude Code policies.** (a) trigger filter — respond only to hook inputs that
   prove a genuine user turn; unclear provenance ⇒ skip (fail-safe);
   (b) main-thread delivery only; subagent-context invocations skip;
   (c) ledger source — exactly one: the plugin's `${CLAUDE_PLUGIN_DATA}` store
   keyed by `session_id`; the transcript is NEVER consulted;
   (d) resume — true fail-closed: `SessionStart(source=resume)` marks the session
   live-delivery-OFF for its entire life; NO re-arm path (mirrors Hermes restored
   sessions; bootstrap block still renders). Transcript-derived ledger recovery is
   a tracked follow-up, not v1; (e) subagent double-delivery is a named risk with
   (b) as mitigation.
   **SessionStart matcher completion (M2):** the shipped `hooks.json` matcher is
   `startup|resume|clear|compact`; decision 4d covered only `resume`.
   - `source=compact` ⇒ **delivery continues.** The plugin-data store is on disk and
     keyed by a session id that survives compaction, so bootstrap + delivered ids
     remain known — this matches Hermes, where delivery survives compaction. The
     compaction exactly-once test (AC 2) asserts no re-delivery across the boundary.
   - `source=clear` ⇒ **empirical, fail-closed:** if `/clear` retains the session id
     with wiped context, treat exactly like `resume` (OFF-for-life — context gone,
     ids unknowable without the transcript we never read); if it starts a new
     session id, it is a fresh session. The implementation verifies which behavior
     the real host exhibits and encodes the observed one, with the test asserting
     the encoded rule.
   - `source=startup` ⇒ fresh session; bootstrap renders; N5 store re-seeded.
5. **OpenClaw cache safety is conditional.** Mechanism verified; wire placement of
   `prependContext` vs the provider cache prefix is not. The leg ships with the
   cache-safety claim conditional; a live `--raw-stream` capture gates the claim —
   pre-merge by default, or post-merge under the 2026-10-04 defer-and-accept
   default if the checkpoint goes unanswered.
6. **Exactly-once is an acceptance criterion per host.** Every host ships a
   randomized multi-channel exactly-once test (Hermes `test_exactly_once.py` is the
   pattern), adapted to that host's channels, including compaction and restore
   paths. **DSH ledger rule (m5): the ledger is rebuilt from the session log
   (`deriveMessages`/history), never from the adapter's own decision — the ledger's
   source of truth is whatever the NEXT trigger will read.**
7. **Release/version matrix (as amended by the delta above and by the
   dependabot patch release PR #38, merged 2026-10-09: deepseek 0.3.2 and
   opencode 0.1.2 shipped as tagged patch releases for the source-map-js
   lockfile fix; this PR bumps from those).**

   | Integration | From → To | Tag after merge |
   |---|---|---|
   | deepseek | **0.3.2** → **0.4.0** | `deepseek-v0.4.0` |
   | opencode | **0.1.2** → **0.2.0** | `opencode-v0.2.0` |
   | claude-code | 0.1.1 → **0.2.0** | `claude-code-v0.2.0` |
   | openclaw | 0.0.0 → **0.1.0** (`planned → implemented`) | `openclaw-v0.1.0` |

   `deepseek-v0.3.1` and `opencode-v0.1.1` are never tagged (0.3.2 and 0.1.2 are
   the tagged patch releases from PR #38). No hermes bump unless the shared annex
   forces docs changes (then docs-only 0.4.2).
8. **Verification strategy + in-PR ordering.**

   | Host | CI proves | Pre-merge e2e | Post-merge tracking |
   |---|---|---|---|
   | deepseek | stub-host contract + unit + exactly-once prop test | live `pre-step` e2e (harness installable locally) | — |
   | opencode | real-binary host contract (extends existing job) + unit | live `chat.message` e2e | — |
   | claude-code | hook-registration shape + unit (no host in CI) | local `claude` CLI e2e if available | resume-id stability, rewrite-replay persistence |
   | openclaw | manifest/registration shape + unit (weakest tier) | raw-stream cache gate (decision 5) | live-gateway behavior |

   Ordering: **DSH → OpenCode → Claude Code → OpenClaw** (existing harnesses first,
   greenfield last); each leg independently committable.
9. **README: full revision.** Per-integration entries for all five; first-class
   **Intuitive Wisdom** section (algorithm summary, per-host support matrix,
   CT ≥ 3.3.0 requirement, per-host degradation paths). Matrix states OpenClaw
   per-runtime support (embedded/CLI v1; Codex/Copilot degraded/unsupported) and
   install-time permission gates + timeout requirements; Claude Code entry notes
   the enterprise `allowManagedHooksOnly` caveat.
10. **CI stub-host contracts** taught/added per leg in its own commit; claude-code
    and openclaw get shape-level contracts, documented as weaker in `ci.yml`.

## Bootstrap (N5) scope per host (M3 — greenfield work is in scope)

"Existing v1 path" is NOT true on every host; per-host bootstrap scope:

| Host | v1 bootstrap today | Work in this PR |
|---|---|---|
| deepseek | shipped (0.3.0 auto-inclusion) | amend render to emit `ct-fact:<id>` markers; memo records ids (Hermes v1-amendment parity) |
| opencode | **none — greenfield** (investigation F6) | build the v1 bootstrap block (seed-query recall, memo, id markers) as part of the leg; its tests are AC 1–5 obligations like live delivery |
| claude-code | none (shipped hook emits status only) | extend `session-start.py` to render the bootstrap block and seed the `${CLAUDE_PLUGIN_DATA}` store with its ids (N5) |
| openclaw | **none — greenfield** (whole plugin is new) | v1 bootstrap + skills registration scope per the leg plan; same AC obligations |

Bootstrap blocks reuse each host's existing constants (seed query, block cap) from
Hermes v1 where the host has none of its own.

## Architecture

```
                     normative: annex A pseudocode (behavioral contract)
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        ▼ (TS core)                   ▼ (TS core)                    ▼ (TS core)
  integrations/deepseek/       integrations/opencode/        integrations/openclaw/
  src/wisdom/adapter.ts        src/wisdom/adapter.ts         src/wisdom/adapter.ts
        └──────────── packages/ct-wisdom-core (workspace dep) ─────┘
        ┌─────────────────────────────┬──────────────────────────────┐
        ▼ (Python, imports hermes)    ▼ (reference, unchanged)
  integrations/claude-code/      integrations/hermes/scripts/
  hooks/wisdom.py → ct_wisdom_live.py (import, no copy)
```

- `ct-wisdom-core` owns: ledger model (per-host ledger-source adapter interface),
  budgets/breaker constants and state machine, capability probe, `ct wisdom match`
  subprocess contract, fact-id marker emit/scan, sanitizer hooks, block renderer.
  Host adapters implement: channel read/write (N1/N2/N3 shims), session identity,
  ledger source binding, persistence-if-any.
- New CI workspace node `packages/ct-wisdom-core` with its own unit suite; each TS
  leg's unit tests run the shared suite against its adapter binding.

### Per-host adapter contracts

| Host | N1 trigger | N2 delivery | N3 transform | Ledger source (normative: "what the NEXT trigger reads") | Restore rule |
|---|---|---|---|---|---|
| DSH 0.2.0-rc.2 | `agent/pre-step` (firstAttempt only) | pre-step messages appended verbatim by `step()` to the session log | `tools/post-execute` (MCP tools route via harness ToolRuntime) | session log via `deriveMessages()` | agent id stable across compaction; no separate restore path |
| OpenCode 1.18.35 | `chat.message` (UserMessage, pre-LLM) | same `chat.message` append, `synthetic: true` part | `tool.execute.after` | persisted session history via `client.session.messages()`; compaction carry-forward via `experimental.session.compacting` (decision 3 deviation) | persisted history is the record; fail-safe child policy per decision 3 |
| Claude Code | `UserPromptSubmit` + provenance filter | `additionalContext` (transcript-persisted, replayed on --resume — but delivery is OFF on resume, decision 4d) | `PostToolUse` on `mcp__curated_recall_context` only (never `curated_get_wiki_entry` — no wiki ids; documented plan-time correction), rewriting the wiki-entry envelope inside the result content, never raw text | `${CLAUDE_PLUGIN_DATA}` store keyed by session_id — the ONLY ledger | `SessionStart(source=resume)` ⇒ OFF for life; `compact` ⇒ continues; `clear`/`startup` per decision 4 |
| OpenClaw | `before_prompt_build` + `ctx.trigger` gate | **three channels** (m7): in-turn `prependContext` (primary live path, cache gate = decision 5); durable `api.session.workflow.enqueueNextTurnInjection` (exactly-once scope per investigation decision 6); tool-result middleware. The adapter dedupes across all three | `registerAgentToolResultMiddleware` on CT MCP tool results only | sessionKey + readTail, fail-closed | readTail failure ⇒ no delivery that turn |

**N3 tool-match rule (m4, all hosts):** the transform fires only on tool results
from the CT recall surface (`*__curated_recall_context` naming class or the host's
equivalent), never on `curated_get_wiki_entry` (plan-time lookups carry no wiki
ids and must not be rewritten). The stub rewrites the host's wiki-entry envelope
(Hermes shape: `outer["result"] → wiki_entries`), never raw `result.text`.

## Acceptance criteria (per leg, before its "done")

1. Shared-core unit suite green for the leg's binding (TS legs) / import path
   green (claude-code).
2. Exactly-once randomized multi-channel test green for the leg, including its
   compaction and restore/resume paths (decision 6; claude-code includes the
   compact-continues and clear/resume-OFF rules).
3. Per-host ledger semantics test: ledger state equals what the next trigger
   actually reads (DSH: session-log-derived; claude-code: plugin-data store;
   opencode: persisted history, with the decision-3 carry-forward assertion;
   openclaw: readTail).
4. Fail-closed tests: capability probe absent ⇒ silent no-op; breaker trips after
   its budget ⇒ no delivery for the pause window; restore/resume rule fires ⇒
   delivery off, bootstrap intact.
5. Marker hygiene: no `ct-fact:` token can enter the ledger from fact text (sanitizer
   test) — a forged marker can only suppress, never duplicate.
6. Manifests corrected (`language`, pins, version_mirror) and manifest tests green.
7. CI tier per decision 8 green; existing jobs not regressed.
8. README + CHANGELOG entries per decision 7/9; changelog heading format
   `## <version> — <date>` preserved (release-body source).
9. **OpenClaw cache gate (m6):** the `--raw-stream` capture exists, is attached to
   the PR, and its verdict (cache-safe / not) is recorded in the leg's CHANGELOG —
   or the defer-and-accept default is invoked and recorded as such.
10. **Pre-merge live e2e (m6):** DSH live `pre-step` e2e and OpenCode live
    `chat.message` e2e executed and green before their legs flip to done (decision 8).
11. **Self-trigger guard (n2):** OpenCode test proves a `synthetic: true` delivery
    append does not re-fire N1 delivery; OpenClaw/DSH equivalents cover their own
    channels.

## Deliverables (this PR)

1. Investigation docs + freshness-doc supersession annotations
   (`docs/superpowers/investigations/`).
2. This spec at `docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md`.
3. `packages/ct-wisdom-core` + DSH, OpenCode, OpenClaw adapters; claude-code
   wisdom hook importing the Hermes core.
4. Per-leg bootstrap work per the N5 scope table (DSH marker amendment; OpenCode
   and OpenClaw greenfield v1 bootstrap; claude-code session-start extension +
   store seeding).
5. Per-leg tests per acceptance criteria; stub-host contract updates; `ci.yml` tiers.
6. Doc corrections + pin bumps (decision 2); OpenClaw manifest `language: node`.
7. README revision (decision 9); per-integration CHANGELOGs (decision 7).
8. Four tags post-merge (decision 7) — tagged by controller after merge, never in-PR.

## Risks (unchanged from investigation rev 3)

Cache invariant sharpest on TS hosts (mitigated by decisions 3 and 5); DSH
0.2.1-alpha `runtime-context` rewrite branch is a named trap (plain `source.kind`
only); Claude Code subagent double-delivery (mitigation 4b) and undocumented
resume-id stability (moot for v1 per 4d); OpenClaw experimental APIs + 15 s prompt
budget ⇒ CT timeouts tight (3 s live budget reused); OpenCode largest scope, best
CI story; exactly-once is ours alone on every host; CT-side matching sparsity
(curated-thoughts#271) means parity is structural, not behavioral, until CT lands.

## Annex A — normative algorithm pseudocode

Both cores implement exactly this; host adapters implement the `host.*` operations.

```
constants (frozen, no config surface):
  MAX_PER_TURN=2  MAX_BLOCK_CHARS=1200  MAX_PER_SESSION=12
  TIMEOUT=3s  QUERY_CHARS=2000  EXCLUDE_MAX=256
  BREAKER_FAILS=3  BREAKER_PAUSE=300s

on user_turn(session, user_message):
  if session.id is empty: return                      # invariant 3 no-op
  ledger = host.rebuild_ledger(session)               # N4 source of truth
  host.cache_ledger(session, ledger)                  # BEFORE any early return (m1):
      # the N3 transform must be able to dedup agent-initiated CT calls even on
      # turns that deliver nothing — degraded turns still dedup.
  if host.restored(session) and not ledger.known_bootstrap: return   # fail closed
  if probe.wisdom_match_absent or breaker.open: return
  query = truncate(strip(text(user_message)), QUERY_CHARS)
  if query empty: return
  # session budget (M1): counts only ids this session delivered via the LIVE
  # path (Hermes: user-role message ids). Exhaustion does NOT stop the call —
  # it forces corrections-only:
  live_used = ledger.live_delivered_count(session)
  max_n = 0 if live_used >= MAX_PER_SESSION else MAX_PER_TURN
  exclude = ledger.ids_most_recent_first[:EXCLUDE_MAX]        # m8: newest first,
      # because corrections only flow for ids actually sent — wrong ordering
      # silently delays or loses supersession corrections
  res = ct.wisdom_match(query, max=max_n, exclude=exclude)
  if res.failed:
      breaker.record_failure() if res.timeout_or_exit
      host.reset_discovery_and_probe_caches() if res.spawn   # n3: retry next turn
      return
  breaker.record_success()
  entries = [e for e in res.entries if e.id not in ledger]    # always post-filter
  corrections = res.corrections                               # exempt from budget
  block = sanitize(render(entries, corrections))       # markers on titles; strip ct-fact: from text
  if len(block) > MAX_BLOCK_CHARS: block = truncate_block(block)
  if block empty: return
  host.deliver(session, block, channel="append")       # N2, host persists
  ledger.note_delivered([e.id for e in entries])       # per-host rule (A.1)

on tool_result(session, result):                       # N3, dedup stub only
  if not host.is_ct_recall_result(result): return result      # m4 rule above
  ledger = host.cached_ledger(session)
  if ledger is None: ledger = host.rebuild_ledger(session)
  # m2: on DSH the cached view is advisory only — the stub's decision uses the
  # session-log-derived view (A.1), never the decision-time cache alone.
  repeats = [f for f in parse_fact_ids(envelope_entries(result)) if f in ledger]
  if repeats: result = rewrite_envelope_stub(result, repeats)
  return result

A.1 per-host ledger rule (decision 6, m5):
  DSH:         rebuild from session log (deriveMessages view); NEVER from the
               adapter's own decision — a later listener may reject the batch.
               The N3 transform consults the same session-log-derived view.
  OpenCode:    rebuild from persisted history via client.session.messages();
               carry delivered-ids across compaction via compacting event
               (decision 3 deviation: no re-delivery after compaction).
  Claude Code: read/write the ${CLAUDE_PLUGIN_DATA} store keyed by session_id;
               the transcript is never consulted; resume ⇒ OFF, compact ⇒
               continues (store survives), clear/startup per decision 4.
  OpenClaw:    rebuild from sessionKey readTail, fail-closed; dedupe across the
               three delivery channels (prependContext, enqueueNextTurnInjection,
               tool-result middleware).
```

Bootstrap (N5) scope is per the table above — existing on DSH (amended for
markers), greenfield on OpenCode and OpenClaw, a session-start extension on
Claude Code; its fact ids join the ledger via the memo/store on first live turn,
unchanged from Hermes semantics where a v1 path exists.

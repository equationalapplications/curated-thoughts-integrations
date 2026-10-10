# Wisdom-layer auto-inclusion on DeepSeek Harness — Step 0 investigation (DSH)

**Date:** 2026-09-30 · **Status:** investigation (pre-spec) · **Author:** Tessera (controller)
**Feature:** port the Hermes wisdom auto-inclusion design to the DSH integration
(`integrations/deepseek/`), per the 2026-09-30 handoff. Five open questions, each
answered with evidence. Tags: **[V]** = controller-verified (read the cited source
this session), **[C]** = child-reported, **[A]** = assumption flagged for the spec.

> **SUPERSEDED IN PART (2026-10-09):** the Target 2 finding that DSH has "no
> per-user-turn hook" is **wrong at host 0.2.0-rc.2** — the 0.2.0 line added the
> `agent/pre-step` waterfall (and `tools/post-execute`), which is exactly the
> per-user-turn trigger + transform pair the live-delivery design needed. The
> evidence in this document was read at pin 0.1.5-rc.2 and remains accurate
> *for that pin*; history is preserved as written. The authoritative successor
> is the 2026-10-09 cross-harness parity spec
> (`../specs/2026-10-09-cross-harness-wisdom-parity-design.md`), whose DSH leg
> re-verified the 0.2.0-rc.2 contracts from the published tarballs and shipped
> the live path (deepseek 0.4.0).

**Host evidence base:** DeepSeek Harness publishes its runtime as npm packages.
Sources read this session from the pinned host version **0.1.5-rc.2**
(`tests/host/compatibility.json`):
`@deepseek-ai/dsh-system-prompt@0.1.5-rc.2`, `@deepseek-ai/dsh-agent-loop@0.1.5-rc.2`,
`@deepseek-ai/dsh-agent@0.1.5-rc.2`, `@deepseek-ai/dsh-session@0.1.5-rc.2`
(downloaded tarballs, `lib/*.js` + `lib/**/*.d.ts` read directly).
Cross-checked against 0.2.0-rc.2 where noted: the contracts cited below are
identical in both versions **except where the spec records a version delta — notably `interpolate`, which exists only on 0.2.0-rc.2 `PromptSection` (the pinned host ignores unknown properties, so passing it is forward-compatible)**. Integration code read at cti main
(`integrations/deepseek/` @ main, plugin v0.2.2).

> **Headline (guardrail tripwire):** DSH's prompt architecture differs materially
> from Hermes in three ways. The Hermes answers to the five questions do **not**
> transfer. The deltas are tractable and the proven Hermes feature shape still
> maps — but onto different host mechanisms. Details per question; the spec must
> fork on these points, not copy.

---

## Target 1 — Session identity: what keys a DSH session? Does the id rotate on compaction/restore?

**Answer: the agent IS the session — `Agent.id: SessionId` is the stable key.
Compaction does NOT rotate it (no fork, no new session). Fork creates a NEW
SessionId (parent recorded in header); resume/restart reuses the SAME stored id.**

Evidence:

- `Agent` is "Session-backed": `interface Agent { readonly id: SessionId }`
  (`@deepseek-ai/dsh-agent/types`, types.d.ts) **[V]**.
- `Session.id` — "The session identity, derived from its durable header's single
  copy" (`@deepseek-ai/dsh-session`, index.d.ts `get id()`); the header's `id` is
  written once at creation and is the storage key ("Identifies one session in the
  store (and its persistence artifacts)", types.d.ts) **[V]**.
- **Compaction** operates by **surface replacement inside the same session log**:
  `SurfaceOp = 'append' | { op: 'replace'; startSeq; endSeq }` — "Used by
  compaction; any surface-replacing producer may use it" (types.d.ts). The
  compaction bracket is a log event pair (`compaction/start` … `compaction/end`)
  in the SAME SessionId. No identity change **[V]**.
- **Fork** is the identity-changing operation: `SessionHeader.parentSession`
  ("The session this one was forked from (seed lineage)") and
  `session/end-seed { inherited?: true }` mark the inherited prefix cut. A fork
  child gets a fresh SessionId **[V]**.
- **Resume** reopens the same log under the same id ("resume — a loop instance's
  first request over a log that already has header events (process restart, fork
  seed)", `RequestHeaderReason` docs) **[V]**.

Design consequence: a memo keyed on `agent.id` gives once-per-lifecycle for free
across compaction (the Hermes lineage-root problem does not exist here) and
across resume **within one harness process**. Two caveats for the spec:

- Memo is **process-local module state** — after a harness restart the memo is
  cold and a resumed session gets a fresh (second) injection as a changed
  system-prompt section (system node update). That matches Hermes's accepted
  resume behavior (A2 in the Hermes investigation) **[A]**.
- Whether `agent.id` equals `session.header.id` byte-for-byte in every composition
  path — pinned loop constructs the agent with the session id; e2e asserts it
  (plan Task: "session-keyed memo" tests will lock the expectation) **[A→e2e]**.

## Target 2 — Re-render semantics: does the host re-render mid-session? Where is the hook?

**Answer: YES — the host calls every context/section `text` function on EVERY
model step, not once at session start. The loop assembles the prompt per step in
its pre-step path. There is no `agent/session-start` render hook for prompt text;
`agent/session-start` is only where the plugin refreshes its cached health
snapshot today.**

Evidence:

- Registration: `ctx.systemPrompt.context({name, order, text})` — "Register
  ordered dynamic context"; `text: string | ((context: AssembleContext) => string)`
  (`PromptContext`, api-catalog + system-prompt types) **[V]**. The existing health
  block registers exactly this (see Target 4) **[V]**.
- Render: `AgentLoop` pre-step calls
  `await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))` —
  **inside the step claim path, i.e., every step** — then
  `renderContextSections(assembly)` → `joinContextSections(sections)` →
  `this.runtimeContext.project(...)` (agent-loop lib/index.js, pinned = 0.1.5-rc.2
  verified; same code at 0.2.0-rc.2) **[V]**.
- `assemble()` invokes each context's `text(context)` fresh each call
  (`typeof entry.text === "function" ? entry.text(context) : entry.text`,
  system-prompt lib/index.js) **[V]**.
- The projection dedupes only by VALUE: `project(current, sections)` returns a new
  user message only "when the retained value differs" (`RuntimeContextProjection`,
  runtime-context.d.ts + lib) **[V]**.

Design consequence: the Hermes "static string at registration" trick does NOT
exist here — DSH has no registration-time freeze. Once-per-session must be
enforced **inside the text function** (the session-keyed memo), exactly as Hermes
ended up doing. The memo is not an optimization on DSH; it is the feature.

## Target 3 — Prompt position: where does injected content land relative to conversation content?

**Answer: two different mechanisms with different cache behavior, and the
spec must choose deliberately (recommended: `section()`):**

- **`ctx.systemPrompt.context(...)` (what the health block uses today):** renders
  into the **dynamic runtime-context snapshot — a user-role message appended to
  the END of the request history** ("Current runtime context. This snapshot
  supersedes earlier runtime-context snapshots." — `joinContextSections`,
  system-prompt lib/index.js **[V]**; committed as a user message via
  `RuntimeContextProjection.project`, runtime-context.d.ts **[V]**). It is
  mid-conversation content: any change appends a NEW user message AFTER the
  cached history. An unchanged context contributes nothing new (value-dedupe).
  Cache effect of a first-time wisdom injection via context: appends after
  history — the prefix through history stays reusable; the added user message is
  paid once and stays stable afterward (value-dedupe keeps it byte-identical).
- **`ctx.systemPrompt.section(...)` (recommended for wisdom):** renders into the
  **system prompt** ("Add prompt text with `ctx.systemPrompt.section()`" —
  DSH's own plugin-practices reference, agent-preset skill package **[V]**), which
  lives at **surface node 0, before all conversation content**. Cache effect
  (agent-loop README, "Complete conversation request → KV Cache effect" **[V]**):
  an unchanged rendered prompt keeps the cached prefix; a prompt CHANGE that
  replaces a system node in place invalidates the cache from that node's first
  token — "in full when the node is node 0". UNLESS the route declares
  `systemPromptUpdate: 'in-history'`, in which case a changed prompt appends
  after the cached history.

Design consequence: with the once-per-session memo, the wisdom text function
returns the SAME string after the first render, so a section registration is
byte-stable from its first appearance onward — the cache danger (mid-session
mutation) is structurally prevented by the memo, and the FIRST injection's cost
is one cache miss at whatever step it first appears, then stable. This mirrors
the Hermes property "static block = cache-prefix-safe" as closely as DSH allows.
Registering wisdom as a second `context()` (mirroring health) would instead put a
wisdom user-message mid-history; simpler, but the block then sits after
potentially large history and reads as an interruption. Decision for the spec:
**section, ordered after the existing system content, with `{{` neutralized in
the sanitizer** (the pinned host has no `interpolate: false`; see spec).

## Target 4 — Mapping/wrapping: what type does DSH pass to the render callback?

**Answer: `AssembleContext = { agent: Agent; scope: Agent; signal?: AbortSignal }`
— there is NO session_info mapping, and NO cwd. This is the largest Hermes delta.**

Evidence:

- `interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }`
  (system-prompt types, 0.2.0-rc.2 api-catalog **[V]**; at 0.1.5-rc.2 the loop
  passes `{ agent, scope: agent, signal }` — `assembleContextFor`,
  dsh-agent lib/index.js **[V]**).
- No cwd anywhere in the assemble path. The loop supplies only `provider`,
  `model`, and `cwd` **prompt variables** (agent-loop README, "What the model
  sees": "It supplies `provider`, `model`, and `cwd` variable values") **[V]**.
- The plugin's own config row carries `brainDir` (cordis.patch.yml row config)
  and the plugin process has `process.env` / `process.cwd()` — but `process.cwd()`
  is the HARNESS process cwd, exactly the trap the Hermes design calls out
  (gateway/host cwd ≠ session cwd) **[V]**.

Design consequence: `query_for(session_info)` has no host-provided cwd on DSH.
Options for the spec (recommended: **(a)**):
- **(a) No cwd term — seed-constant query only.** The Hermes live-verified
  finding is that the static seed constant carries the matches and
  metadata-derived terms return zero wiki entries; cwd basename was an
  *additional* non-degenerate term, not the load-bearing one. On DSH, ship
  seed-only and document the divergence.
- (b) Best-effort cwd from `session.header.cwd` — but the text callback receives
  only `AssembleContext {agent, scope, signal}`; the plugin would need the
  `ctx.agents` registry or session access inside the render path (new service
  injection, more surface area, fragile across compositions).
- (c) Read a configurable query seed from the plugin's Config row (users can
  override in cordis.patch.yml) — small, optional, composes with (a).

## Target 5 — Memo lifetime: process-lifetime module global acceptable?

**Answer: YES — same conclusion as Hermes, stronger on DSH because the memo is
load-bearing (Target 2). The agent-loop's own per-agent state
(`requestHeaderLogged`, `runtimeContext` projection, `assistantStreamRevision`)
is the same shape: process-local, per-agent-instance, rebuilt on resume.**

Evidence:

- Agent-loop keeps per-attach process-local state on the loop instance
  ("Process-local revision of assistant frames for this attached Session",
  agent-loop lib/index.js **[V]**).
- `RuntimeContextProjection.retained` is likewise process-local; a restart
  rebuilds it from the log **[V]**.
- No host-provided plugin storage for cross-restart memoization is documented in
  the api-catalog `systemPrompt` service surface (methods: section, context,
  tools, variable, suppress, order resolvers — no storage) **[V]**.

Design consequence: `{agentId → rendered block}` module-global with Hermes
failure-class semantics AS SUPERSEDED BY THE SPEC (Opus spec cycle 1 B1 +
cycle 2 R2): memoize zero-hits/discovery-miss/parse-error/ENOBUFS; budget the
transient classes (2 attempts per agent, 60 s cooldown, then memoized) behind
a process-wide circuit breaker — the verbatim Hermes "never memoize timeouts"
rule would re-spawn on every model step on DSH and freeze the single-threaded
harness. LRU-bounded. The DSH module is TypeScript; port the
OrderedDict LRU as a `Map` with delete/re-insert (JS Maps preserve insertion
order — idiomatic LRU).

---

## Bonus verification — what the existing DSH integration already does (context for the spec)

- `src/index.ts` registers ONE context today:
  `ctx.systemPrompt.context({ name: 'curated-thoughts', order: ctx.systemPrompt.getContextOrder('curated-thoughts-health'), text: () => cached })` —
  a closure over a module-cached snapshot refreshed on `agent/session-start`
  **[V]**.
- `src/status.ts` `probe()` is synchronous fs/config reads; `format.ts`
  `formatStatusBlock()` returns `null` when healthy **[V]**.
- The wisdom block adds a SECOND registration (section, per Target 3) reusing
  `ct_env` discovery helpers; it must NOT disturb the health context.
- Subprocess contract on DSH is the same Node `child_process` shape as Hermes's
  Python `subprocess`: argv array, `timeout`, no shell. Node equivalent of the
  Hermes pinned-cwd rule: `cwd: os.homedir()` (`execFile`/`spawn` options) **[A —
  spec must pin this explicitly]**.

## Answers at a glance (for the spec)

| # | Question | DSH answer | Delta vs Hermes |
|---|----------|-----------|-----------------|
| 1 | Session identity | `agent.id: SessionId`; stable across compaction; fork = new id | Hermes rotates on legacy compression (lineage-root key) — DSH needs no lineage logic |
| 2 | Re-render | every step re-calls `text()`; value-dedupe appends snapshot only on change | Hermes re-rendered at compression boundaries — same conclusion (memo is load-bearing), different trigger |
| 3 | Position | sections → system node 0; contexts → trailing user-role snapshot | Hermes had one tier; DSH forces a choice — spec picks `section()` |
| 4 | Render args | `{agent, scope, signal}` — no session_info, no cwd | Hermes passed a mapping with cwd — DSH query is seed-constant-only |
| 5 | Memo lifetime | process-global module state, no host storage | Same as Hermes; port LRU to JS Map |

## Assumptions carried into the spec

- [A1] `agent.id === session.header.id` in the compositions the e2e exercises.
- [A2] Fresh injection after harness restart on a resumed session is acceptable
  (matches Hermes precedent).
- [A3] Seed-constant-only query still retrieves useful wisdom on the live vault
  (Hermes live evidence supports this; re-prove in e2e with the real sidecar).
- [A4] ~~`interpolate: false` sections are the right choice~~ **SUPERSEDED (spec
  review cycle 1): the pinned host has no `interpolate` option and interpolates
  every section — an unknown `{{name}}` throws inside `assemble()`. The spec
  passes `interpolate: false` for forward compatibility only; the real defense
  is the brace-run neutralizer in the sanitizer.**
- [A5] DSH does not support a `complete: true` section today in our targets —
  we register a normal (non-complete) section; verify at implementation time
  that no other complete section exists in the profiles we test.

## Evidence appendix — sources (2026-09-30)

```
# All read as unpacked npm tarballs this session (controller-verified):
@deepseek-ai/dsh-system-prompt@0.1.5-rc.2  lib/index.js   (assemble(), context(),
  section(), joinContextSections() "supersedes earlier runtime-context snapshots")
@deepseek-ai/dsh-agent@0.1.5-rc.2 / 0.2.0-rc.2  lib/types/dispatch.js
  (assembleContextFor returns { agent, scope: agent, ...signal }; emitAgentEvent
  = fire-and-forget emit — agent/session-start listeners are NOT awaited)
@deepseek-ai/dsh-scope@0.1.5-rc.2   lib/types/index.d.ts
  (ScopeKey = object — opaque, identity-compared; the Agent object is passed
  as scope, so scope.id is real today)
@deepseek-ai/dsh-llm@0.1.5-rc.2     lib (SystemPromptUpdate = 'in-history'
  is the only non-default mode; default = in-place system-node replace)
dsh-system-prompt pinned lib/index.js: PromptSection has NO `interpolate`
  (added by 0.2.0-rc.2); renderPrompt interpolates every section — unknown
  `{{name}}` throws inside assemble()  [spec cycle-1 R3 landmine]
dsh-system-prompt pinned lib/index.js: SECTION_ORDERS constants
  (TOOL_* 1000-2900, TOOLS_SDK 5000, DELIVERABLE_FILE_REFERENCES 9000, ...)
dsh-agent-loop pinned lib/index.js: SystemPromptProjection.project() —
  `if (latest.text === rendered) return []` (no update when unchanged)
Node docs: spawnSync EINVAL on .cmd/.bat with shell:false (CVE-2024-27980
  patch) — Windows discovery must skip those extensions
@deepseek-ai/dsh-agent-loop@0.1.5-rc.2     lib/index.js   (pre-step assemble call,
  RuntimeContextProjection.project retained-differs rule; README "Complete
  conversation request → KV Cache effect"; "Limitations": stable sessionId)
@deepseek-ai/dsh-agent@0.1.5-rc.2          lib/index.js   (assembleContextFor →
  {agent, scope, signal})
@deepseek-ai/dsh-session@0.1.5-rc.2        lib/types/*.d.ts (SessionHeader id,
  parentSession, SurfaceOp replace = compaction, session/end-seed, RequestHeaderReason)
@deepseek-ai/dsh@0.2.0-rc.2                package.json   (version map; contracts
  identical at 0.2.0-rc.2 where cross-checked, except `interpolate` — present only on 0.2.0-rc.2 `PromptSection`)
@deepseek-ai/dsh-agent-preset@0.2.0-rc.2   skills/cordis-plugin-development/
  references/practices.md ("Add prompt text with ctx.systemPrompt.section()")

# Integration (cti main):
integrations/deepseek/src/index.ts   (existing health context() registration)
integrations/deepseek/src/status.ts, src/format.ts (probe + block rendering)
integrations/deepseek/cordis.patch.yml (brainDir row config)
integrations/deepseek/tests/host/compatibility.json (pinned dsh 0.1.5-rc.2)
```

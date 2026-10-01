# curated-thoughts-integrations — DeepSeek Harness wisdom-layer auto-inclusion design

**Date:** 2026-09-30 · **Status:** APPROVED WITH NITS (Opus spec cycle 4 = final verify; implementation underway — PR #22) · **Priority:** high (Kurt directive 2026-09-30: DSH port first)

Forked from the Hermes design
([`2026-09-30-wisdom-auto-inclusion-design.md`](2026-09-30-wisdom-auto-inclusion-design.md),
review-converged, implemented in PR #21). The proven feature shape carries over;
the host mechanisms differ in the ways verified below — three material deltas
(constraints 1–3) and two design consequences (4–5). Every DSH claim below carries
its evidence in
[`../investigations/2026-09-30-wisdom-auto-inclusion-dsh-step0-investigation.md`](../investigations/2026-09-30-wisdom-auto-inclusion-dsh-step0-investigation.md)
— cited as "Step 0 [V]" with the target number.

## Problem

Same mission as Hermes, on DSH: semantically relevant CT wisdom-layer matches are
**automatically included, additively, exactly once per agent session, without
breaking LLM prompt caching**. The DSH integration (v0.2.2) injects only the
machine-scoped health snapshot; wisdom never reaches the prompt unless the agent
calls recall tools.

DSH constraint set (Step 0 [V]):

1. **No registration-time freeze.** The host calls every prompt `text` function
   on **every model step** (agent-loop pre-step → `systemPrompt.assemble()`);
   runtime contexts are value-deduped, sections are reconciled against the
   retained system node. Once-per-session must be enforced plugin-side (Target 2).
2. **`text` is synchronous**: `text: string | ((context: AssembleContext) => string)`.
   No async in the render path (Target 2).
3. **No session_info, no cwd**: the callback receives
   `{ agent: Agent; scope: Agent; signal?: AbortSignal }`. The only session
   identity is `agent.id: SessionId` (Target 4).
4. **Prompt position is a choice** (Target 3): `section()` → system node 0
   (before conversation; byte-stable text keeps the cached prefix);
   `context()` → a trailing user-role "runtime context snapshot" appended after
   history ("This snapshot supersedes earlier runtime-context snapshots").
5. **System-node mutation cost** (agent-loop README "KV Cache effect" [V]): a
   prompt change replaces a system node in place and invalidates the prefix
   cache from that node's first token — "in full when the node is node 0" —
   unless the route declares `systemPromptUpdate: 'in-history'`.

## Approach

A **second prompt registration** from the existing plugin — a `section()`, not a
second `context()`:

- **Why `section()`:** the system prompt sits before conversation content, which
  is where a session-start knowledge block belongs; the runtime-context snapshot
  path would append a user-role message after potentially large history on the
  first step, then stay pinned there (value-dedupe keeps it byte-identical, but
  its position is wrong for reference material and it is paid in every request
  either way). `section()` also matches DSH's own guidance ("Add prompt text with
  `ctx.systemPrompt.section()`", agent-preset plugin practices [V]).
- **Name:** `curated-thoughts-wisdom`. **Order: `CURATED_WISDOM_SECTION_ORDER = 6000`**
  — stated, not looked up (`getSectionOrder()` only resolves built-in names, same
  pattern as the health context's `CURATED_CONTEXT_ORDER = 130` [V, src/index.ts]).
  6000 sorts after the built-in tool sections (TOOL_* 1000–2900, TOOLS_SDK 5000)
  and before DELIVERABLE_FILE_REFERENCES (9000)/STRUCTURED_OUTPUT (9900)/
  HARNESS_SOURCE (10000)/DEPLOYMENT_PERSONA_SUFFIX (10200) (SECTION_ORDERS,
  dsh-system-prompt lib/index.js, pinned [V]).
- **`interpolate` — cannot be relied on.** The pinned host (0.1.5-rc.2)
  `PromptSection` has **no `interpolate` option** and `renderPrompt`
  interpolates every section unconditionally; an unknown `{{name}}` reference
  **throws inside `assemble()`** (dsh-system-prompt lib/index.js [V]).
  Therefore the sanitizer **neutralizes brace-runs with the lookahead rule
  from Render below (`/\{(?=\{)/g → '{ ')` — the ONLY sanctioned form; a
  plain `replaceAll('{{','{ {')` is bypassable via `{{{x}}`** (cycle-3: stale
  earlier wording removed). We still pass `interpolate: false` for forward
  compatibility (0.2.0-rc.2 added the option; unknown properties are ignored
  by the pinned host [V]).

Flow (mirrors Hermes ct_wisdom.py, ported to TypeScript):

1. **Match:** spawn `ct recall "<seed>" --json --k 3` — argv array via
   `spawnSync(ctPath, args, { timeout, cwd: os.homedir(), … })`, **never a
   shell**. `ct` is discovered separately from the sidecar (dedicated candidate
   list + identity probe, below). Single synchronous spawn: the render path has
   no async (constraint 2). Stall bound: probe 3 s + recall 5 s worst case,
   warm ≈ 0.7 s measured on Hermes (re-measure cold on DSH in the plan before
   freezing the timeouts).
2. **Query: seed constant only** — `"curated thoughts agent memory wisdom
   procedures"` (frozen from the Hermes e2e). **No cwd term: DSH provides no cwd
   to the render callback** (constraint 3), and `process.cwd()` is the harness
   process cwd — exactly the trap the Hermes design forbids. Hermes live
   evidence: the seed does the semantic work; metadata-derived terms retrieve
   zero entries. Optional per-user query override via the plugin `Config` row is
   **deferred** (out of scope v1, rejected alternative (b): reaching
   `session.header.cwd` would need new service injections in the render path).
3. **Render:** `## Curated Thoughts — relevant memory` + per-entry `**title**` +
   text, hard-capped at **2500 chars** post-sanitize (self-enforced; DSH has no
   host-side max_chars for sections). Sanitization order: remove
   `<!-- hermes-plugin-section` repeatedly until stable → indent any line-start
   `## Plugin Context: ` → **neutralize brace-runs: replace every `{` that is
   directly followed by `{` with `{ ` (`/\{(?=\{)/g → '{ '), which collapses
   any run `{{`, `{{{`, `{{{{`… to a safe form in ONE pass** (pinned-host
   `renderPrompt` interpolates sections unconditionally; an unbalanced or
   unknown `{{name}}` THROWS inside `assemble()` — pinned dsh-system-prompt
   lib/index.js [V]; cycle-2 R1: a single `{{`→`{ {` replaceAll is bypassable
   via `{{{x}}`, so the lookahead form is mandatory). Applied to titles AND
   text; a unit invariant locks "rendered block never contains `{{`" for
   brace-run and splice cases. DSH has no Hermes
   persistence-marker invariant, but the sanitizer is cheap, defense-in-depth
   against hostile wiki prose, and keeps the two ports byte-comparable — the
   exact Hermes marker strings are kept deliberately: they are the frame text
   CT-side wiki prose could plausibly carry cross-host, which is the forgery
   being defused. Zero wiki entries → return `""` (host drops empty sections).
4. **Once-semantics: memo keyed via `keyOf()`** — `{sessionId → block}` module
   global, LRU N=256 (JS `Map`, delete/re-insert for LRU order). **Key
   resolution — ONE function, `keyOf(ctx)`, referenced everywhere** (cycle-2
   R3; pinned 0.1.5-rc.2 and current 0.2.0-rc.2 both pass
   `{agent, scope: agent, signal}` [V]): the ctx is first narrowed via
   `(ctx ?? {}) as { agent?: unknown; scope?: unknown }`, then a `pick(o)`
   helper tests `typeof o === "object" && o !== null && typeof (o as { id?:
   unknown }).id === "string"` and returns `(o as { id: string }).id` — **the
   typed `agent`/`scope` values are NEVER dot-accessed directly** (CodeRabbit,
   2026-09-30; `ScopeKey = object` in dsh-scope carries no `.id` in the type,
   so `scope?.id` does not compile; `scope` receives the Agent object at
   runtime [V], so the property exists as data but only the `unknown`-narrowed
   form can read it); agent first, then scope, else no key. **No key → return
   `""` with no memo write and no spawn.** No lock needed: Node is
   single-threaded and `text()` is synchronous — the Hermes
   check-under-lock/setdefault dance has no race to guard here; document the
   difference.
   Compaction does NOT rotate the id (SurfaceOp replace is in-session), so —
   unlike Hermes — **no lineage-root logic and no mid-session byte change at
   compression boundaries at all**. Resume in a new harness process: memo is
   cold; a fresh block is recalled and appears as a system-node change (accepted
   v1 limitation, see below). **Fork** creates a new SessionId → fresh block in
   the child (correct).
5. **Fail-open WITH a retry budget (DSH-specific — Opus cycle-1 B1, hardened
   cycle-2 R2):** failure classes ported from Hermes but the retry rule is NOT
   verbatim. On DSH the render runs on EVERY model step and `spawnSync` **freezes
   the single-threaded harness** (TUI, streams, MCP stdio) for the spawn
   duration — the Hermes "retry next render" rule would stall every step of
   every session while a backend is down. Therefore: *memoized* — discovery
   miss, parse error, zero hits, and **`maxBuffer` overflow (ENOBUFS, treated
   like a parse error)**; *budgeted* — recall timeout, non-zero exit, spawn
   failure, probe timeout: at most **2 attempts per agent id, ≥60 s cooldown
   between attempts, then memoize `""` for that agent**, PLUS a **process-wide
   circuit breaker: after 4 consecutive budgeted failures across any agents,
   stop spawning process-wide for 5 minutes, then allow one probe attempt**.
   Budget counters and the breaker are per-process (module state alongside the
   memo); the discovery-cache reset on spawn failure is kept but the RESET
   ITSELF is budgeted (a candidate re-probe costs up to 3 s frozen).
   Worst-case stall invariant, stated PER PROCESS (cycle-2 R2, corrected
   cycle-3): **each budgeted attempt costs ≤ probe 3 s + recall 5 s = 8 s; the
   breaker opens after K = 4 consecutive budgeted failures, so the frozen
   total is ≤ 4 × 8 s = 32 s before the breaker opens, then ≤ 8 s per
   5-minute half-open probe; a failed half-open probe re-opens the breaker
   for another 5 minutes — regardless of how many agents fan out**. Every
   failure collapses to `""`; nothing raises into prompt assembly. Logging at
   debug. **Plan carry-overs from cycle 4 (reviewer-approved deferral):**
   (B) port Hermes `_candidate_paths` per-platform lists verbatim; (C) unit
   tests for the budget/breaker state machine with fake timers — budget
   exhaustion → memoized `""`, cooldown gate, breaker trips at K=4, failed
   half-open probe re-opens the breaker.

**Rejected for DSH (beyond the Hermes rejected list):** second runtime
`context()` for wisdom (position after history; see Approach); memoizing
transient failures **for byte-stability's sake alone** (a dark-forever session
is worse than one extra cache miss — and the miss only happens when the first
attempt failed, i.e. the prefix was already degraded). Note the budgeted
retry above is a DIFFERENT mechanism: it memoizes after the budget is spent
to bound the stall, not to protect byte stability (cycle-2 R6 wording);
async prefetch at
`agent/session-start` with sync cache read (**rejection now evidence-backed,
Opus cycle-1 M2**: `agent/session-start` is dispatched via `emitAgentEvent` —
a fire-and-forget notification whose listeners are NOT awaited (dispatch.js,
pinned [V]) — so a prefetch there cannot guarantee presence at the first
request; with the retry budget (B1 fix) the sync path's worst case is bounded
at 16 s lifetime per agent, so the added async machinery buys nothing);
MCP-over-stdio (carried over from Hermes: rejected on complexity/audit grounds);
`session.header.cwd` query term (needs new injections; seed-only is proven).

## Cache-safety analysis (spec-level invariant)

- Warm path (the design case): first assemble happens at the first model step;
  the memo is filled **during that assemble**, so the section is present from
  the very first request — it is part of system node 0 from the first token and
  byte-identical thereafter. `SystemPromptProjection.project()` emits no update
  when the rendered prompt is unchanged (`if (latest.text === rendered) return
  []`, dsh-agent-loop lib/index.js, pinned [V — cycle-1 m2 citation]), so the
  cached prefix survives every later step.
- Degenerate path: first recall times out (block absent at request 1, retry at
  request N) → the block's first appearance changes the system prompt → one
  provider prefix-cache miss from node 0, then stable. Accepted; logged as
  limitation (2).
- **LRU eviction (CodeRabbit cycle-5):** the memo AND the retry governor's
  per-agent map are both LRU-capped at `MEMO_MAX = 256` (JS `Map` delete +
  re-insert for recency, eviction of insertion-order head when over cap).
  Eviction of a governor record discards its cooldown clock and spent-budget
  flag — a later render for that agent gets a FRESH budget. A retained `''`
  memo, by contrast, still prevents spawning for the cached agent until THAT
  memo entry is itself evicted (a single render writes either the rendered
  block or `''`). The two maps are independent: governor eviction is silent,
  memo eviction is observable as a single fresh-block render and the one
  prefix-cache miss that follows. Both bounds are explicit; we do not protect
  governor records from LRU eviction, and we do not bound total per-agent
  cost beyond `MEMO_MAX`. Process-wide stall remains bounded by the circuit
  breaker (independent of any per-agent state). This is the rationale for
  README limitation (3).
- The health context is untouched: it stays a `context()`; its value-dedupe
  semantics are unchanged by this feature.

## Data flow

```
apply(ctx) ──► ctx.systemPrompt.section({ name: 'curated-thoughts-wisdom',
                                            order: 6000, interpolate: false,
                                            text: renderWisdom })
every model step ──► renderWisdom({agent, scope, signal})
                       ├─ keyOf(): no key → "" (no memo write, no spawn)
                       ├─ memo[key] hit → stored bytes (byte-identical replay)
                       ├─ miss + budget exhausted / breaker open → "" (no spawn)
                       ├─ miss: discover ct (candidates + identity probe) → fail: "" (memoized / budgeted)
                       ├─ spawnSync: ct recall <seed> --json --k 3 (timeout 5s,
                       │      killSignal SIGKILL, maxBuffer 4 MiB, windowsHide)
                       │      ETIMEDOUT→timeout, other error→spawn, ENOBUFS→memoized,
                       │      status≠0→exit — timeout/exit/spawn → "" (budgeted; spawn resets discovery cache within budget)
                       ├─ parse JSON → wiki[0..3] → empty: memoize "" → ""
                       ├─ sanitize (incl. {{-neutralize) → render ≤2500 → memoize → block
                       └─ all exceptions swallowed (debug log) → ""
resume in new process: memo cold → fresh recall → system-node update once (limitation 1)
compaction: no effect — same SessionId, memo replays identical bytes
```

## Resolved decisions (from the DSH Step 0 investigation)

- **OQ1 session identity — resolved [V]:** `agent.id: SessionId`, stable across
  compaction; fork = new id; resume = same id, cold memo in a new process.
  Memo key = **`keyOf(ctx)`** (single definition, Approach step 4 — cycle-2
  R3): `agent?.id` → `scope?.id` (when a non-empty string) → else no-op.
  Both pinned (0.1.5-rc.2 `assembleContextFor`) and current (0.2.0-rc.2
  dispatch.js) pass `{agent, scope: agent, signal}` — the 0.2.0-rc.2
  api-catalog `AssembleContext` interface omits `agent` but the
  implementation passes it; `ScopeKey` is `object` (dsh-scope [V]) and
  receives the Agent itself, so `scope?.id` is real today. A host-compat unit
  test locks the pinned shape, and the e2e asserts a non-empty block so a
  silent dark-fail is loud. (Hermes's lineage-root keying has no DSH analogue.)
  **Malformed ctx (aws-cloud-agent cycle-1 review):** if the host ever passes
  an `assembleCtx` shape without `agent` or `scope` (e.g. `{ signal: {} }`),
  `keyOf` returns `''` because both `pick(c.agent)` and `pick(c.scope)` yield
  `''` (each guarded by `typeof === "object" && !== null && typeof .id ===
  "string"`); there is no dot-access on the typed values and no path on which
  an `undefined` propagates. `renderWisdom` then short-circuits on `key === ''`
  with NO memo write and NO spawn (Approach step 4, "No key → …"). This
  silent no-op is by design — an unrecognized host shape MUST NOT raise into
  `assemble()`, and the system node 0 absence is the correct outcome. The
  wisdom-layer section simply stays empty, the prefix cache survives
  unchanged, and the session proceeds.
- **OQ2 re-render — resolved [V]:** every step re-invokes `text()`; the memo is
  the once-semantics mechanism (load-bearing, not an optimization).
- **OQ3 position — resolved [V]:** `section()` (system node 0), not `context()`.
- **OQ4 render args — resolved [V]:** `{agent, scope, signal}`; no cwd →
  seed-constant-only query.
- **OQ5 memo lifetime — resolved [V]:** process-global module state; JS Map LRU;
  no locking required (single thread).
- **Subprocess contract (DSH form):** `spawnSync` with argv array, `timeout: 5000`,
  `killSignal: 'SIGKILL'` (Node's default SIGTERM lets a hung child outlive the
  timeout — SIGKILL matches Hermes's `subprocess.run` semantics),
  `maxBuffer: 4 * 1024 * 1024` (default 1 MiB can ENOBUFS on a chatty recall
  payload; overflow is classified memoized like a parse error),
  `cwd: os.homedir()`, `stdio: ['ignore','pipe','pipe']`, `shell: false` (Node
  default when `shell` is unset — stated explicitly anyway), `windowsHide: true`.
  `spawnSync` never throws: the result's `{error, status, signal}` fields carry
  the failure (mapping above). `signal` from `AssembleContext` cannot be honored
  by `spawnSync` — an abort during a stall waits out the bound; documented as
  accepted (cycle-1 m6), bounded by the retry budget.
  Identity probe: `ct --help` output must contain `"Curated Thoughts"`
  (same probe text as Hermes), timeout 3 s, same contract.
- **Discovery (cycle-2 R5):** the plugin owns a small filtered walk over PATH —
  it does NOT call `whichOnPath` and post-filter its single result (a
  `.cmd` shim earlier on PATH would shadow a valid `ct.exe` later on PATH and
  memoize a false discovery miss). Implementation: export an
  `allPathMatches(name, env, platform)` variant from `scripts/ct_env.ts`
  (same split/exts logic, returns every existing executable hit in PATH
  order); discovery walks it, **skipping `.cmd`/`.bat` candidates entirely on
  win32** (`spawnSync` with `shell:false` fails EINVAL on patched Node for
  those — CVE-2024-27980), skipping extensionless files on win32 too, and
  probes the remaining candidates in order (identity probe as below).
  **Probe walk rule (cycle-3 N1, matching Hermes): a candidate that exists
  but FAILS the identity probe (wrong output) advances the walk to the next
  candidate; a candidate whose probe TIMES OUT ends the walk immediately as
  a budgeted `probe_timeout` failure.** **Walk bound (cycle-4 A): the whole
  discovery walk runs under ONE cumulative 3 s deadline — elapsed walk time
  counts against every subsequent probe's timeout, and exhausting the
  deadline ends the walk as budgeted `probe_timeout`** (bounds a rejecting
  nearly-3 s probe chain as well as timeouts; keeps "each budgeted attempt
  ≤ 8 s" true). **Discovery MISSES are cached PROCESS-WIDE with a 5-minute
  TTL** (aligned with the breaker window), not per agent — otherwise every
  new subagent re-walks and re-probes all candidates unbounded by the
  breaker. Unit tests for the Windows shadowing case, the
  timeout-ends-walk rule, and the deadline exhaustion. Platform
  fallback candidates after PATH: **copied from Hermes `_candidate_paths`
  verbatim, per platform** (cycle-4 B — the merged list in the previous
  revision silently dropped `/usr/bin/ct` and `/opt/homebrew/bin/ct`; the
  plan ports Hermes's exact per-platform lists, so GUI/launchd macOS
  contexts still find a Homebrew `ct`).
- **Subagents (cycle-1 m5):** each DSH subagent is its own `Agent`/SessionId, so
  each pays its own recall on its first step (memo is per agent). v1 **accepts
  the per-agent cost and documents it**; a process-wide result cache keyed on
  the (constant) query is listed as a v2 candidate, not built now (avoid a
  second cache layer before the live cost is measured in e2e).

## Error handling

Identical philosophy to Hermes: every failure mode → section absent, never an
exception in prompt assembly (DSH `assemble()` invokes `text(context)` directly
— a throw would propagate into the loop's pre-step; the render function is
non-raising by contract, with a defensive catch around the whole body).
Oversize renders are pre-truncated by the render function (DSH has no host-side
length guard for sections — the cap is entirely ours to enforce). Logging:
debug one-liners with a `wisdom` prefix.

## Testing

- **Unit (vitest, repo convention — `pnpm test` in `integrations/deepseek/`):**
  fake `ct` executables (fixture shell scripts, POSIX-only cases skipped on
  Windows per repo precedent); wiki-only consumption; k/truncation/sanitization
  (forged marker in title, in text, splice case); each no-op mode; memo
  hit/miss/eviction/empty-id; timeout kill path; discovery fallback order +
  identity-probe rejection of a non-CT `ct`; spawn-failure discovery-cache reset;
  `renderWisdom` never throws (property: injected `text` fn fed garbage
  AssembleContext objects returns `""`); spawnSync called with the pinned argv
  and `cwd` (mock `child_process` as primary pattern — no real binary needed on
  any platform).
- **e2e (isolated container ONLY — `tests/e2e/run.sh`; never a live harness):**
  extend the existing DSH e2e to assert exactly one wisdom block in the system
  node when the sidecar brain has seeded wisdom; memo replay byte-identical
  across a second step; real `ct recall` in the render path (live sidecar .deb
  plus the standalone `ct` tarball installed in the container — the 2.12.1 .deb
  does not ship the CLI; see the plan's Task 8 research); degraded/no-sidecar
  case renders `""` and the session proceeds. The container is the isolated
  harness instance — this satisfies the never-Kurt's-live-config guardrail by
  construction.
- **CI:** existing matrix + `tsc --noEmit`; no new runtime deps (Node stdlib
  `child_process` only).

## Versioning, docs, and safety pins

- **Version bump:** `integrations/deepseek/package.json` → **0.3.0** +
  CHANGELOG entry under the DeepSeek integration + one README paragraph
  (feature, no-op behavior, limitations list below).
- **Subprocess safety:** argv array via `spawnSync`, never a shell string; the
  seed is a single argv element; no user-controllable input reaches a shell (v1
  has no config surface — nothing user-controlled exists).
- **Limitations list (README, exactly five):** (1) after a harness restart on
  a resumed session the memo is cold — the first step re-recalls and the block
  may change bytes once (system-node change → one cache miss); (2) the same
  one-time cost if the first recall attempt fails transiently and a later
  render succeeds; (3) memo eviction beyond 256 live agents per process;
  (4) when the `ct` backend is down, a session stops trying after two failed
  attempts (its block stays absent for the session's life in that process);
  (5) while the backend is down, the harness may pause briefly (seconds) on
  recall attempts, bounded per process by the retry budget + circuit breaker.
  (cycle-2 R6.)
- **Skills drift check:** the three shipped CT skills describe the plugin
  context; implementation verifies their wording still matches and updates if
  needed.

## Out of scope (v1)

Carried from Hermes, plus DSH-specific: no cwd-derived query term (no host
source); no per-user query config row; no `context()` variant behind a flag (one
mechanism, reviewed once); no lineage/fork-specific memo logic (fork already
keys fresh); no OpenCode/Claude Code ports (next in Kurt's sequence); no CT core
changes; no memo seeding from persisted logs.

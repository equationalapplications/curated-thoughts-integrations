# curated-thoughts-integrations — DeepSeek Harness wisdom-layer auto-inclusion design

**Date:** 2026-09-30 · **Status:** Draft (pre-implementation; review pending) · **Priority:** high (Kurt directive 2026-09-30: DSH port first)

Forked from the Hermes design
([`2026-09-30-wisdom-auto-inclusion-design.md`](2026-09-30-wisdom-auto-inclusion-design.md),
review-converged, implemented in PR #21). The proven feature shape carries over;
the host mechanisms differ in five verified ways. Every DSH claim below carries
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
- **Name:** `curated-thoughts-wisdom`. **Order:** a stated finite number placed
  after the plugin's other contributions (same pattern as the health context's
  `CURATED_CONTEXT_ORDER = 130` — `getContextOrder()` only resolves built-in
  names, so the number is stated, not looked up [V, src/index.ts]).
- **`interpolate: false`** — the block is prose and must never have `{{…}}`
  interpreted as variable references (Step 0 A4).

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
   host-side max_chars for sections). Sanitization order kept from Hermes
   (remove `<!-- hermes-plugin-section` repeatedly until stable → then indent
   any line-start `## Plugin Context: `), applied to titles AND text. DSH has no
   Hermes persistence-marker invariant, but the sanitizer is cheap,
   defense-in-depth against hostile wiki prose, and keeps the two ports
   byte-comparable. Zero wiki entries → return `""` (host drops empty sections).
4. **Once-semantics: memo keyed on `agent.id`** — `{sessionId → block}` module
   global, LRU N=256 (JS `Map`, delete/re-insert for LRU order). **No lock
   needed**: Node is single-threaded and `text()` is synchronous — the Hermes
   check-under-lock/setdefault dance has no race to guard here; document the
   difference. Empty/absent `agent.id` → return `""` with no memo write.
   Compaction does NOT rotate the id (SurfaceOp replace is in-session), so —
   unlike Hermes — **no lineage-root logic and no mid-session byte change at
   compression boundaries at all**. Resume in a new harness process: memo is
   cold; a fresh block is recalled and appears as a system-node change (accepted
   v1 limitation, see below). **Fork** creates a new SessionId → fresh block in
   the child (correct).
5. **Fail-open:** identical failure classes to Hermes, ported verbatim:
   *memoized* — discovery miss, parse error, zero hits; *NOT memoized (retry
   next render)* — recall timeout, non-zero exit, spawn failure, probe timeout;
   spawn also invalidates the accepted-path discovery cache. Every failure
   collapses to `""`; nothing raises into prompt assembly. All logging at debug.

**Rejected for DSH (beyond the Hermes rejected list):** second runtime
`context()` for wisdom (position after history; see Approach); memoizing
transient failures to protect node-0 byte-stability (a dark-forever session is
worse than one extra cache miss — and the miss only happens when the first
attempt failed, i.e. the prefix was already degraded); async prefetch at
`agent/session-start` with sync cache read (cannot guarantee presence at the
first request, the feature's core property, for the same node-0-change cost);
MCP-over-stdio (carried over from Hermes: rejected on complexity/audit grounds);
`session.header.cwd` query term (needs new injections; seed-only is proven).

## Cache-safety analysis (spec-level invariant)

- Warm path (the design case): first assemble happens at the first model step;
  the memo is filled **during that assemble**, so the section is present from
  the very first request — it is part of system node 0 from the first token and
  byte-identical thereafter. `SystemPromptProjection.project()` emits no update
  when the rendered prompt is unchanged [V], so the cached prefix survives every
  later step.
- Degenerate path: first recall times out (block absent at request 1, retry at
  request N) → the block's first appearance changes the system prompt → one
  provider prefix-cache miss from node 0, then stable. Accepted; logged as
  limitation (2).
- The health context is untouched: it stays a `context()`; its value-dedupe
  semantics are unchanged by this feature.

## Data flow

```
apply(ctx) ──► ctx.systemPrompt.section({ name: 'curated-thoughts-wisdom',
                                            order: <stated>, interpolate: false,
                                            text: renderWisdom })
every model step ──► renderWisdom({agent, scope, signal})
                       ├─ memo[agent.id] hit → stored bytes (byte-identical replay)
                       ├─ miss + empty agent.id → "" (no memo write)
                       ├─ miss: discover ct (candidates + identity probe) → fail: "" (memoized / probe-timeout NOT memoized)
                       ├─ spawnSync: ct recall <seed> --json --k 3 (timeout 5s)
                       │      timeout/exit/spawn → "" (NOT memoized; spawn also resets discovery cache)
                       ├─ parse JSON → wiki[0..3] → empty: memoize "" → ""
                       ├─ sanitize → render ≤2500 → memoize → block
                       └─ all exceptions swallowed (debug log) → ""
resume in new process: memo cold → fresh recall → system-node update once (limitation 2)
compaction: no effect — same SessionId, memo replays identical bytes
```

## Resolved decisions (from the DSH Step 0 investigation)

- **OQ1 session identity — resolved [V]:** `agent.id: SessionId`, stable across
  compaction; fork = new id; resume = same id, cold memo in a new process.
  Memo key = `agent.id` string. (Hermes's lineage-root keying has no DSH
  analogue — simpler here.)
- **OQ2 re-render — resolved [V]:** every step re-invokes `text()`; the memo is
  the once-semantics mechanism (load-bearing, not an optimization).
- **OQ3 position — resolved [V]:** `section()` (system node 0), not `context()`.
- **OQ4 render args — resolved [V]:** `{agent, scope, signal}`; no cwd →
  seed-constant-only query.
- **OQ5 memo lifetime — resolved [V]:** process-global module state; JS Map LRU;
  no locking required (single thread).
- **Subprocess contract (DSH form):** `spawnSync` with argv array, `timeout`,
  `cwd: os.homedir()`, `stdio: ['ignore','pipe','pipe']`, `shell: false` (Node
  default when `shell` is unset — stated explicitly anyway), `windowsHide: true`.
  Identity probe: `ct --help` output must contain `"Curated Thoughts"`
  (same probe text as Hermes), timeout 3 s, same contract.
- **Discovery candidates:** port the Hermes list verbatim (`which("ct")` first,
  then platform candidates incl. Windows `%USERPROFILE%\bin\ct.exe` and
  `%LOCALAPPDATA%\CuratedThoughts\bin\ct.exe`); the plan checks what the dpkg
  sidecar ships and where.

## Error handling

Identical philosophy to Hermes: every failure mode → section absent, never an
exception in prompt assembly (DSH `assemble()` invokes `text(context)` directly
— a throw would propagate into the loop's pre-step; the render function is
non-raising by contract, with a defensive catch around the whole body).
Oversize renders are pre-truncated by `render_block` (DSH has no host-side
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
  in the container); degraded/no-sidecar case renders `""` and the session
  proceeds. The container is the isolated harness instance — this satisfies the
  never-Kurt's-live-config guardrail by construction.
- **CI:** existing matrix + `tsc --noEmit`; no new runtime deps (Node stdlib
  `child_process` only).

## Versioning, docs, and safety pins

- **Version bump:** `integrations/deepseek/package.json` → **0.3.0** +
  CHANGELOG entry under the DeepSeek integration + one README paragraph
  (feature, no-op behavior, limitations list below).
- **Subprocess safety:** argv array via `spawnSync`, never a shell string; the
  seed is a single argv element; no user-controllable input reaches a shell (v1
  has no config surface — nothing user-controlled exists).
- **Limitations list (README, exactly three):** (1) after a harness restart on
  a resumed session the memo is cold — the first step re-recalls and the block
  may change bytes once (system-node change → one cache miss); (2) the same
  one-time cost if the first recall attempt fails transiently and a later
  render succeeds; (3) memo eviction beyond 256 live agents per process.
- **Skills drift check:** the three shipped CT skills describe the plugin
  context; implementation verifies their wording still matches and updates if
  needed.

## Out of scope (v1)

Carried from Hermes, plus DSH-specific: no cwd-derived query term (no host
source); no per-user query config row; no `context()` variant behind a flag (one
mechanism, reviewed once); no lineage/fork-specific memo logic (fork already
keys fresh); no OpenCode/Claude Code ports (next in Kurt's sequence); no CT core
changes; no memo seeding from persisted logs.

# Wisdom-layer auto-inclusion at session start — Step 0 investigation

**Date:** 2026-09-30 · **Status:** investigation (pre-spec) · **Author:** Tessera (controller)
**Review state:** Opus cycle 1 = REQUEST CHANGES (1 BLOCKER, 4 MAJOR, 7 MINOR) → all applied
(dispositions in Review provenance). Opus cycle 2 (delta) = REQUEST CHANGES (2 MAJOR,
1 MINOR, 2 nits) → all applied. Opus cycle 3 (delta) = REQUEST CHANGES on one point
(R2 lineage-key design not implementable) → resolved per reviewer's offered option
(accepted v1 limitation); **cycle 4 = final verify (documents cap = 3 cycles, then
hand open items to Kurt).**
**Feature (Kurt directive, 2026-09-29):** semantically relevant wisdom-layer matches are
automatically included, additively, exactly once per agent session, without breaking LLM
prompt caching. Exit criteria (handoff 2026-09-29): session-start semantic recall → ONE
contiguous, static block injected once at bootstrap → additive with existing plugin context →
graceful no-op if recall is unavailable.

There is no bug to reproduce: this is a feature investigation. Five verification targets,
each answered with evidence. Tags: **[V]** = controller-verified (re-ran command or re-read
cited lines this session), **[C]** = child-reported, **[A]** = assumption flagged for the
spec. Environment: this repo @ `3c9e331` (branch `feat/session-start-wisdom-inclusion`);
Hermes Agent source at `~/.hermes/hermes-agent/` (the installed harness this plugin runs in);
live CT sidecar (`/usr/bin/curated-thoughts-mcp`, dpkg) with brain at `~/.brain`.

---

## Target 1 — Injection point: where does session-start context enter the prompt?

### What the harness offers (native plugin API)

`PluginContext.register_system_prompt_section(id, content, *, position="after_memory",
max_chars=4000)` — `hermes_cli/plugins.py:954-979` **[V]**:

- `content` is a **string or a callable** receiving a read-only session-info mapping
  (docstring, line 966-968).
- `id` must match `^[a-z0-9][a-z0-9._-]{0,127}$`; a duplicate id raises
  `ValueError` naming the registering plugin (lines 960-975) — a **registration-time**
  check only (it prevents two plugins claiming one id; it says nothing about render
  frequency — see Target 4).
- `position` must be in `SYSTEM_PROMPT_SECTION_POSITIONS = frozenset({"after_memory"})`
  (`plugins_dispatch.py:68`) — after-memory is the **only legal position** today **[V]**.
- `max_chars` must be 1..4000 (`MAX_SYSTEM_PROMPT_SECTION_CHARS = 4_000`,
  `plugins_dispatch.py:69-70`).

Render: `PluginManager.render_system_prompt_sections(session_info)`
(`plugins_dispatch.py:525-558`) **[V]**:

- iterates sections **sorted by id** → deterministic byte-stable output;
- **fail-open**: a callable that raises, returns non-str, returns empty, contains a
  reserved persistence marker, or exceeds `max_chars` is **skipped with a warning**
  (`_render_prompt_section_text`, lines 560-584) — never blocks the session. Note: the
  host **drops** an over-length section, it never truncates it (lines 582-584);
- aggregate budgets: `MAX_SYSTEM_PROMPT_SECTIONS = 32`,
  `MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS = 8_000` (lines 71-72). The 8000 total
  **includes framing overhead** (headings, char markers, container comments,
  separators — `format_system_prompt_section(s)`, lines 84-95).

Placement: `agent/system_prompt.py:779` appends rendered sections (position
`after_memory`) to the **volatile tier** via
`volatile_parts.extend(_plugin_section_blocks(_frozen_plugin_prompt_sections(agent),
"after_memory"))` **[V]**. The prompt has three tiers joined `\n\n` — `stable`
(identity/guidance/skills), `context` (workspace/AGENTS.md), `volatile` (skills index,
memory, USER.md, external memory provider, timestamp — plus the plugin-section blocks
added at line 779, which the module docstring's tier list does not name; the code is
authoritative) — **built once per session and reused across turns** (`agent/system_prompt.py:1-12`
docstring; AGENTS.md invariant: "Per-conversation prompt caching is sacred"). Rebuilds
happen at more boundaries than compression alone — see Target 4 **[V]**.

### What the plugin does today (v0.2.2)

`integrations/hermes/__init__.py:112-139` **[V]**: `register(ctx)` registers the three
skills, an `on_session_start` hook (refreshes a cached health snapshot), and — when the
host API exists — **already registers one system prompt section** with
`id="curated-thoughts"` whose callable returns `ct_status.context_section()` (health
snapshot + tool-routing reminder; measured 409 chars on this machine **[V]**). The
section machinery is therefore already exercised by this plugin in production; our
feature **adds a second section**, it does not introduce a new mechanism.

### Decision (carried to spec)

Inject via `ctx.register_system_prompt_section("curated-thoughts-wisdom", <callable>)`
in the same `register(ctx)`. Additive by construction: two sections under one plugin,
rendered sorted (`curated-thoughts` < `curated-thoughts-wisdom`).

Rejected alternative — the shell hook (`hooks/session-start.py`, emits a `{"context": …}`
JSON directive; verified present at repo `integrations/hermes/hooks/session-start.py`
**[V]**): it duplicates context rather than registering a bounded, budgeted section, and
shell hooks carry a first-use consent surface ("Hermes prompts once per (event, command)
pair before running a shell hook" — `hooks/session-start.py` module docstring **[V]**).
The native section API is purpose-built for exactly this and is already consent-free.

---

## Target 2 — Semantic-match source: `ct recall` vs MCP `curated_recall_context` vs shared helper

### `ct recall` (headless CLI) — verified live **[V]**

`ct recall <QUERY> [--k N] [--json]`. Live run (2026-09-30, k=5, query
"LLM prompt caching system prompt"): **0.765 s wall** (warm), JSON shape:

```json
{"results": [ {"chunk_text", "doc_path", "entity_id": "tier_working::…",
               "score": 0.614, "symbol_name": null} ],
 "wiki":    [ {"id": "fact_…", "title", "text", "source_ref": "librarian-…",
               "confidence": "certain", "entity_id": "ent_…"} ]}
```

- `results` = chunk hits **with float `score`** (measured: related query 0.598–0.614;
  unrelated query "recipes for sourdough bread" 0.385–0.387) **[V]**.
- `wiki` = **the wisdom layer** (same facts the MCP tool returns), top-k **ranked but
  unscored** — no numeric score field on wiki entries **[V]**.

Dependency facts (strace, this session **[V]**): `ct recall` opens `~/.brain/brain.db`
**read-only** and its WAL/SHM siblings read-write, and makes ~10 local `connect()` calls
(embedding backend). It does **not** talk to the sidecar process — the sidecar being up
or down is irrelevant to it (upgrades the earlier sidecar-down assumption, see Graceful
no-op). It writes no audit row of its own beyond DB journaling (the "audit row" language
belongs to the MCP tool, which describes itself as fail-closed on audit failure).

### MCP `curated_recall_context` — verified live **[V]**

`query` (required), `limit_wiki` (default 5), `limit_code` (default 10). Returns
`{"code_chunks": […], "wiki_entries": [{title, text, id, source_ref, confidence:
"certain", entity_id}]}`. Per its own description it "records one audit row (fails
closed if the audit write fails)". No numeric similarity score either.

### Shared-helper option

None exists in this repo (`integrations/hermes/scripts/` holds ct_status/ct_env/
ct_preflight/ct_doctor only — file list **[V]**). Both candidate sources are external
processes; a "shared helper" would be net-new code.

### Decision (carried to spec)

**Shell out to `ct recall --json` from the section callable; consume only the `wiki`
list** (chunks are working-tier session noise — exactly the dilution Kurt's roadmap
warns against). Rationale: the CLI is CT's purpose-built headless interface, measured
sub-second warm, and returns both layers in one call; speaking MCP-over-stdio to the
sidecar binary from a plugin callback would re-implement a protocol client for no
capability gain (and the MCP tool's fail-closed audit behavior is undesirable in a
fail-open prompt path).

**Binary discovery (revised after Opus M1): `ct` gets its OWN candidate list — it is a
different binary from the sidecar.** `ct_env.find_sidecar()` searches for
`SIDECAR_NAME = "curated-thoughts-mcp"` (`ct_env.py:34,167-187` **[V]**) — mirroring it
would point at the wrong program. Discovery for `ct`: `shutil.which("ct")` plus explicit
per-OS fallbacks (`~/.local/bin/ct` on Linux, `~/bin/ct`, and the Windows/macOS
equivalents under the user home), because gateway/service sessions may run with a
minimal PATH that omits `~/.local/bin`; the discovery source is logged at debug level.
An e2e case under a stripped PATH is in the test plan.

---

## Target 3 — Matching-input design: what query do we recall with?

The section callable receives a read-only session-info mapping with exactly these keys:
`session_id, model, provider, platform, profile_name, cwd`
(`agent/system_prompt.py:86-95`, `_plugin_session_info`) **[V]**. Render happens during
prompt assembly, **before any conversation content exists** (render is invoked from
`_frozen_plugin_prompt_sections` during first prompt build; on session resume the
callbacks are NOT re-run — the host restores frozen bytes from the persisted prompt,
`conversation_loop.py:791-796`: "Prompt-section callbacks are new-session-only; recover
their frozen bytes from the persisted prompt", via `restore_plugin_prompt_sections`,
`system_prompt.py:165-167`) **[V]** — so the
query can only be built from session metadata. There is no first-user-message input
available at bootstrap.

**Live evidence against the obvious design (Opus M3, verified this session **[V]**):**
metadata-derived queries — the repo basename `"curated-thoughts-integrations"` and the
scratch-profile basename `"ct-test"` — each returned **zero wiki entries**. The wisdom
layer does not discuss repo names or machine profile names; a cwd-derived query is
nearly pure noise for gateway sessions (`cwd` falls back to `""` → e.g. `"<user>
telegram default"`), and even in a project directory it retrieves nothing. The earlier
draft's "signal is sufficient" claim rested on a hand-written topical query, not a
metadata-derived one — retracted.

**Decision (carried to spec, revised):**

- Query = **static bootstrap seed constant** (deterministic, byte-stable across sessions,
  e.g. `"agent memory wisdom procedures"` — exact wording tuned once at e2e, then
  frozen), **plus the cwd basename only when it is non-degenerate** (non-empty, not the
  home basename, not on a small generic denylist). Semantic matching still happens —
  the seed is embedded and ranked by CT — but per-session tailoring comes only from the
  optional cwd term. (The older draft's `"<user> telegram default"` example described the
  retired cwd+platform+profile template; the seed-only template cannot produce it.)
- **Low-signal gate:** when the recall returns **zero wiki entries, skip the section**
  (return empty → host skip rule). This doubles as the natural no-op for profiles or
  machines whose brain holds nothing relevant.
- `platform` and `profile_name` are **dropped from the template** (no evidence they
  help; both are noise-prone). `session_id`/`model` stay excluded (Target 3 rationale
  unchanged).

---

## Target 4 — Once-semantics: exactly one injection per session, cache-safe

**Revised after Opus B1 — the host freeze alone does NOT give once-per-session.**

What the host does **[V]**:

1. `_frozen_plugin_prompt_sections` renders sections once at first prompt build and
   caches the tuple on the agent (`agent._plugin_system_prompt_sections_snapshot`);
   `system_prompt.py:113-136` **[V]**.
2. **`invalidate_system_prompt` deletes that snapshot** and stashes the old bytes as a
   fail-open fallback (`system_prompt.py:800-820`; docstring: plugins re-render "at the
   same boundary (maintainer-directed, #95681 arc)" because freezing plugin sections
   while memory/skills refresh "would recreate the stale-block disease"). The stashed
   `_previous` bytes return **only if the whole render RAISES** — a per-section empty
   return is not a raise, it silently omits the section. Verified callers of
   `invalidate_system_prompt` **[V]**: `conversation_compression.py:3158` (compression),
   `cli_session_mixin.py:555` (session reset/new), `cli_session_mixin.py:707`
   (rewind/truncate), `cli_commands_mixin.py:333` (/resume, /branch switch), plus
   `tui_gateway` undo (per review; not re-verified line-by-line).
3. Session resume restores sections **from the persisted prompt bytes** by parsing the
   canonical container (`_restore_plugin_prompt_sections`, `system_prompt.py:138-163`)
   — resumed sessions do not re-run plugin code **[V]**. Known loss modes **[V]**: the
   restore only accepts the container when `"Conversation started:"` immediately
   follows it, and a failed restore returns `()` silently (both sections vanish,
   nothing re-renders).

Consequence: without plugin-side state, after the first compression in a session the
callable re-runs — and if the brain gained entries since bootstrap, or `ct` fails at
that moment, the wisdom block's **bytes change or vanish mid-session**. Both
"exactly once per session" and byte-stability across rebuilds require the plugin to
hold state.

**Decision (carried to spec, revised):** the plugin keeps a **session-keyed memoized
render**: `{session_id → (query, rendered_block)}`, guarded by a lock, read at the top
of the callable; when `session_info["session_id"]` matches, return the **stored bytes
unchanged** — a re-render at any host invalidation boundary is byte-identical to
bootstrap, so once-semantics and cache-safety hold at every boundary. Eviction: the map
is bounded (drop-oldest beyond a small N; the gateway can hold several sessions) and
process-lifetime — a fresh Hermes process re-renders for the session, which is correct
(new prompt, new bootstrap). **Memo-state caveats (fixed after Opus R1/R2):** (1) a
resumed session in a NEW process does not bootstrap — the host restores the frozen
bytes from the persisted prompt and the plugin is never called, so the memo starts
empty; the first `invalidate_system_prompt` after that would miss the memo and run a
fresh recall (bytes could change or vanish). v1 accepts this as a **known limitation**
(gateway restarts are routine; the window is "restart followed by an invalidation
boundary"); the spec carries an open question on seeding the memo from the restored
section bytes. (2) On legacy (non-in-place) compression the host ROTATES
`agent.session_id` (`conversation_compression.py:3357/3386`; default in-place is
`True`, line 4092 — first compression still hits the memo under the old id, second one
misses). **Accepted v1 limitation (Opus cycle-3 ruling): no lineage signal reaches a
system-prompt-section callable** — the parent id exists host-side only
(`session:compress` event payload, `on_session_switch`, context-engine notify), none of
which the plugin can subscribe to — so a raw-keyed memo is the only implementable v1
and legacy-mode second-compressions may re-recall (bytes can change). Impact is
bounded: legacy mode is non-default and the failure needs two compressions in one
process. Open question 1 records the policy (treat rotation as a new epoch is the
fallback semantics; do NOT assume a derivable lineage key). This was anticipated in the plugin's own comment
(`__init__.py:54-57`: machine-scoped cache today; "If it ever gains session-scoped
content, this cache must become session-keyed instead"). The wisdom cache must live in
the NEW module/wisdom code, NOT by mutating the existing machine-scoped health cache.

Cache-safety statement (revised): at the **first build** (the only event that assembles
the prefix while the upstream cache is warm-empty) the block renders exactly once and
then never changes bytes for the session; at rebuild boundaries the prefix is being
rewritten anyway (no cache to preserve), and the memo guarantees the block lands back
byte-identical. "Exactly once" is therefore per session_id per process, with
byte-stable re-materialization — matching the handoff's exit criterion in user-visible
terms (one static block, one recall per session).

Design consequence (resolved wording conflict between roadmap and handoff): the
roadmap gloss says matches "accumulate across the session rather than replace"; the
handoff exit criteria (later, authoritative) say "one contiguous, **static** block
injected **once at bootstrap**". Mid-session accumulation would require mutating the
prompt — precisely what the caching invariant forbids. **Spec follows the handoff:
bootstrap-once static block; "additive" = additive with the existing
`curated-thoughts` health section (a second sibling block), not mid-session growth.**

---

## Target 5 — Threshold / volume cap

Measured reality **[V]**: **neither interface returns a similarity score for wisdom
entries.** `ct recall` wiki entries carry rank but no score; MCP wiki entries carry
`confidence: "certain"` (a provenance label, not a similarity). Chunk scores exist but
are the wrong layer. A numeric threshold over wisdom matches is therefore **not
implementable without reading the brain DB directly — which is forbidden**
(client rules: never out-of-band brain access; sidecar/`ct` are the only readers).

**Decision (carried to spec):** v1 caps **volume, not similarity**:

- `--k 3` wiki entries max (constant, tunable at e2e);
- single section, `max_chars=2500`, and the rendered text is hard-guaranteed ≤ 2500
  **after the host's strip** (the host measures stripped text and **drops** — never
  truncates — an over-length section, `plugins_dispatch.py:575-584`);
- per-entry render = title + trimmed text, hard-truncated to fit; entries are
  **sanitized**: any occurrence of the reserved container markers
  (`hermes-plugin-sections:start/end`) or anything resembling the per-section frame
  regex is stripped from fact text before rendering — a marker would get the whole
  section dropped, and a forged frame would corrupt resume-restore for BOTH plugin
  sections (`_restore_plugin_prompt_sections` returns `()` on any mismatch,
  `system_prompt.py:138-163`);
- if the recall returns fewer/zero entries the block shrinks or is skipped (empty →
  host skips it, Target 1); **the memo stores empty results too** — a bootstrap miss
  (timeout, zero hits) must not later "succeed" mid-session and inject a block that was
  absent at bootstrap (Opus R3); unit test added to the plan;
- budget note: the health section measures **409 chars** **[V]** today; wisdom's 2500
  + framing fits the 8000 aggregate with room, BUT the wisdom section sorts AFTER
  `curated-thoughts`, so a third-party or future section that sorts earlier and
  overruns the aggregate budget would silently evict the wisdom block (host drops the
  overflow section with a WARNING only) — accepted v1 risk, logged in the spec;
- no score threshold in v1. A future score-bearing wisdom-search endpoint in CT is the
  upgrade path — out of scope here, noted for the spec's non-goals.

## Graceful no-op (exit criterion 4)

Re-stated with measured failure modes **[V]** (strace, this session): the realistic
dependencies of `ct recall` are (a) the `ct` binary present and executable, (b) the
brain DB readable, (c) the embedding backend reachable. The **sidecar process being
down does not affect it** (ct reads `~/.brain` directly; it never talks to the
sidecar). Failure of any of (a)-(c) → callable returns `""` → host skip rule → section
absent. `subprocess` timeout (value fixed in spec; Windows needs
`communicate()`+kill or a new process group — a bare `timeout=` can hang on grandchild
pipes **[A]**, per Opus m5) → same. No exception escapes into prompt assembly (host
catches per-section; plugin swallows and logs debug). Cold-start latency (embedding
model load) is unmeasured — see open questions.

## Testing & e2e verification design (scratch profile only)

**Guardrail (handoff): never test against the live default Hermes profile — the next
session runs inside the harness it is modifying.** Scratch profile `ct-test` already
created (wrapper `~/.local/bin/ct-test`, config `~/.hermes/profiles/ct-test/`).

- Unit tests (repo `tests/`, stdlib unittest per `integration.yaml` checks): fake
  `ct` binary via PATH stub returning canned JSON; assert wiki-only consumption, k-cap,
  truncation+sanitization, empty/timeout/missing-binary no-ops, query-template
  stability, session-keyed memo behavior (same session_id → byte-identical; new id →
  re-render; bounded map).
- e2e (ct-test profile): install the branch payload, run a real CLI session, prove
  **exactly one** wisdom block: (a) the host logs
  `Session plugin prompt section: id=curated-thoughts-wisdom …` at INFO on every render
  (`plugins_dispatch.py:554-557` **[V]**) — expected counts: **exactly 1 in a session
  with no invalidation boundary** (i.e. no compression, /new, rewind, /resume or
  /branch — any of these legitimately produces one more render); after each boundary,
  exactly one per boundary, each byte-identical (verify via the memo: content hash
  across renders is a single value); (b) grep the
  assembled prompt bytes for the block — capture via a direct invocation of the render
  path under `HERMES_HOME=~/.hermes/profiles/ct-test` (mechanism verified working this
  session **[V]**: `render_system_prompt_sections` runs under the profile venv; empty
  result on the fresh profile confirms plugin discovery scoping).
- PATH-stripped e2e case (Opus M1): run the render with PATH lacking `~/.local/bin`,
  expect discovery via the candidate fallback.
- Cross-platform: subprocess + `shutil.which` pattern matches `ct_env.py`'s CI-covered
  pattern; Windows timeout handling in unit tests (communicate+kill path).

## Open questions (parked for spec/plan; merge tripwire applies)

1. **Re-render policy at /new, /branch, rewind (Opus B1 follow-up):** the session-keyed
   memo keys on `session_id` — confirm those boundaries preserve or change the id, and
   whether a /branch into the same session should re-recall (fresh block for the new
   branch) or replay (stable bytes). Decide in spec; default = replay (memo wins).
   Includes the **legacy-compression rotation policy** (Target 4 caveat 2): per the
   cycle-3 ruling there is no plugin-visible lineage signal, so the spec must state
   the fallback semantics (rotation = new epoch, memo miss = re-recall) and must NOT
   assume a derivable lineage key.
2. **`ct` discovery under service PATH (Opus M1):** candidate list above; e2e case
   added. Confirm the dpkg-installed CT ships `ct` at a fixed path too (`ct status`
   provenance check during implementation).
3. **Gateway render thread (Opus M2):** which thread assembles gateway prompts, and
   does a blocking `ct` call there stall other sessions? Measure cold-start `ct`
   latency (embedding model load) before deciding whether the render needs a
   bounded-wait + async-refresh pattern in v1.
4. **Prompt-bytes capture for e2e**: resolved for planning purposes — direct render-path
   invocation under the profile venv works (verified); `hermes prompt-size --json`
   exists for byte budgets. Final proof recipe written in the plan.
5. **Seed-constant wording**: chosen by e2e taste against the test brain, then frozen
   (cheap constant).
6. **k=3 vs k=5 and the 2500-char split**: defaults from budget arithmetic; tune once
   at e2e, then freeze.
7. **Windows subprocess kill semantics** (communicate+kill vs CREATE_NEW_PROCESS_GROUP)
   — pick one in the plan; unit test with the stub.
8. **Memo seeding after process restart (Opus R1):** can the plugin recover its memo
   from the restored section bytes (e.g. by parsing the persisted prompt, which the
   plugin cannot currently see), or is the v1 limitation (restart + invalidation =
   possible byte change) accepted and documented? Decide in spec; default = accepted
   limitation, documented in README.

## Review provenance

- **Cycle 1 — Opus via `opus-review --doc`** (medium effort, context:
  `plugins_dispatch.py` + plugin `__init__.py` + `system_prompt.py` excerpts; 14 turns,
  $0.61): **REQUEST CHANGES.** B1 (once-semantics claim wrong; compression et al. clear
  the snapshot) — VERIFIED against source, applied (Target 4 rewritten, memo design
  adopted). M1 (wrong binary for discovery) — VERIFIED (`SIDECAR_NAME` grep), applied
  (Target 2). M2 (sidecar-down claim unverified; cold start unmeasured) — strace run,
  claim replaced with measured dependencies; cold-start + thread questions parked. M3
  (metadata query collapses to noise) — live runs confirm zero wiki results; Target 3
  redesigned (static seed + gate). M4 (truncation/sanitization contract) — applied to
  Target 5. m1-m7 applied: docstring-vs-code citation fixed; ct-audit wording replaced
  with strace evidence; honesty ledgers merged; consent-surface claim now cited;
  Windows hang noted; per-boundary render-count expectations defined; resume-restore
  loss modes documented.
- **GLM self-review:** line-number re-verification of every [V] citation before each
  presentation; the cycle-1 self-review caught the resume-caller gap (upgraded the
  claim with `conversation_loop.py:791-796`) but missed B1 — the lesson (verify the
  lifecycle of any cached attribute, not just its read path) goes to working lessons.

**Cycle 3 dispositions (delta review, 8 turns, $0.71):** R2's lineage-key fix REJECTED
by the reviewer with source evidence (no plugin-visible lineage signal exists; parent
id lives only in host-side payloads) — the doc's cycle-2 "lineage root" design was
**removed** and replaced with an accepted-v1-limitation statement (bounded impact:
legacy mode is non-default; needs two compressions in one process), matching the
reviewer's offered resolution. Open question 1 rewritten to demand fallback semantics
instead of a derivation. One new nit fixed: e2e expectation reworded to "exactly 1 in
a session with no invalidation boundary". Reviewer also confirmed: prior R3/N1/N2
FIXED; cache-safety text verified conservative (block sits at the end of the volatile
tier).

- **sor shadow:** ledger-only runs per delivery wave (stage `task`); findings sealed
  until loop close; post-close adjudication to the review notes plus
  `immutable-source-files/agents/memories/sor-shadow-tally.md`.

**Cycle 2 dispositions (delta review, 9 turns, $0.72):** B1 "partly — memo guarantee
gaps" → R1/R2/R3 (below). M1-M4, m1-m7 all confirmed FIXED by the reviewer. New
findings, all applied: **R1** (fresh-process resume never bootstraps; memo empty →
post-restart invalidation can change bytes) — accepted v1 limitation + open question 8;
**R2** (legacy compression rotates session_id — memo keyed on raw id misses the second
compression; verified at `conversation_compression.py:3357/3386`, default in-place
`True` at 4092) — memo key re-specified as a lineage root + open question 1 extended;
**R3** (empty result memoization unspecified) — memo stores empty results, unit test
added; **N1** (§ reference) — header wording fixed; **N2** (stale template example) —
example marked as retired-template output.

## Not checked (honesty ledger, merged)

- Upstream Hermes repo state: source read locally at the checked-out revision; no
  upstream version comparison.
- Multi-brain environments: all probes ran against the single production brain
  (`~/.brain`); no-brain / second-brain `ct` behavior untested.
- `ct recall` cold-start latency and concurrency under simultaneous sessions (warm
  single probe only, ~0.7 s).
- Windows/macOS behavior of the new code path (repo CI matrix covers them; not
  exercised here).
- `tui_gateway` undo caller cited by review, not re-verified line-by-line.
- Whether OpenClaw/Claude Code siblings can express an equivalent (out of scope:
  Hermes-first).
- MCP-over-stdio alternative not prototyped (rejected on complexity/audit-semantics
  grounds without measurement — see Target 2).
- Gateway-platform sessions (Discord/Telegram) assumed to render sections identically
  to CLI (same `system_prompt.py` path); e2e proves CLI only.
- `ct recall` read-path stability while the watcher/librarian is mid-ingest — assumed
  stable, untested.
- Whether the sor shadow needs a matching-input fixture beyond the unit-test stubs —
  deferred to Step 6 wave planning.

## Evidence appendix — live command transcripts (2026-09-30, EDT)

```
$ ct recall "LLM prompt caching system prompt" --json   (k=5 default)
→ {"results": [score 0.614 / 0.601 / 0.599 …], "wiki": [5 entries]}
  real 0m0.765s

$ ct recall "recipes for sourdough bread" --json
→ chunks score 0.387 / 0.385; wiki 5 entries, no score fields

$ ct recall "wisdom layer session start inclusion" --json
→ wiki top-3: fact_43815a34 (retrieval posture), fact_fa44a397 (schema rule),
  fact_fd2702c8 (five-part model)

$ ct recall "curated-thoughts-integrations" --json ; ct recall "ct-test" --json
→ wiki = 0 entries BOTH  (Opus M3 confirmed: metadata queries retrieve nothing)

$ MCP curated_recall_context(query="wisdom layer auto-inclusion …", limit_wiki=3)
→ {"code_chunks": [], "wiki_entries": [3 entries, confidence "certain", no scores]}

$ strace -f -e openat,connect ct recall "test query for tracing" --json
→ brain.db O_RDONLY; brain.db-wal/-shm O_RDWR|O_CREAT; ~10 connect()
  (ct reads the brain directly; sidecar process not contacted)

$ ct_status.context_section() (installed v0.2.2 plugin)
→ 409 chars (health section)

$ grep SIDECAR_NAME integrations/hermes/scripts/ct_env.py
→ SIDECAR_NAME = "curated-thoughts-mcp"   (NOT "ct" — Opus M1 confirmed)

$ invalidate_system_prompt callers
→ conversation_compression.py:3158; cli_session_mixin.py:555,707;
  cli_commands_mixin.py:333  (Opus B1 confirmed)

$ session_info keys → agent/system_prompt.py:86-95
  {session_id, model, provider, platform} + profile_name, cwd

$ render call site → agent/system_prompt.py:779 (volatile tier, after_memory)
$ freeze/snapshot → agent/system_prompt.py:113-136; invalidate → 800-820
$ restore-from-prompt → system_prompt.py:138-163; caller → conversation_loop.py:791-796
$ budgets → hermes_cli/plugins_dispatch.py:68-72 (4000/section, 32 sections, 8000 total)
$ skip rules → plugins_dispatch.py:560-584; sorted render → 525-558
$ INFO log on render → plugins_dispatch.py:554-557
$ duplicate-id ValueError → hermes_cli/plugins.py:971-975
$ plugin registers section today → integrations/hermes/__init__.py:131-139 (v0.2.2)
$ sidecar discovery pattern → integrations/hermes/scripts/ct_env.py:167-187
```

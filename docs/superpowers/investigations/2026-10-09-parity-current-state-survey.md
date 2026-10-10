# Current-State Survey: curated-thoughts-integrations @ main 6ec6fe9

Purpose: map each integration's architecture and hook surface against the Hermes
"Intuitive Wisdom" live-delivery reference implementation (PR #35, hermes 0.4.0/0.4.1),
to prepare generalizing live delivery to the other integrations.

Evidence tags: [V] = verified by reading the file directly; [C] = inferred/concluded.
Worktree is read-only; nothing under `base/` was modified.

## Sections (appended incrementally)

1. Repo-level: INTENT.md, README matrix, CI, ct_ci_policy
2. Hermes reference implementation (live delivery)
3. DeepSeek current state
4. OpenCode current state
5. Placeholder dirs: openclaw, claude-code
6. Capability tables: hook surface vs live-delivery needs
7. Version/release state table
8. Gaps and risks
9. NOT CHECKED

## 1. Repo-level invariants and CI [V]

INTENT.md (docs in repo root) defines the Intuitive Wisdom goal and 8 rules with
per-rule build status. Key constraints for any live-delivery port:

- **Rule 1 (exactly-once):** every delivered fact carries a `ct-fact:<id>` marker;
  ledger rebuilt from current context before delivering; agent-initiated CT search
  results must stub already-in-context facts ("already in context" stubs).
  Status: Hermes 0.4.0 fully built (randomized exactly-once test); DeepSeek injects
  only at session start and its agent-run CT searches can repeat a fact.
- **Rule 2 (D1/D2/D3):** never edit the system prompt after it is built; session-start
  block frozen once; later facts go ONLY into append-only channels (user turn / tool
  results); on resume the host replays the saved prompt and the plugin persists nothing.
- **Rule 3 (supersession):** corrections appended saying which id they replace.
  Note: in practice no corrections arrive yet — CT's Librarian doesn't apply
  supersessions yet (CT-side gap, curated-thoughts#271 relevance-gate gap also noted).
- **Rule 4:** fail quietly; short timeouts. Hermes live delivery also has a circuit
  breaker (3 consecutive failures → 5-min pause).
- **Rule 5:** provenance labels on live delivery (bootstrap can't yet — `ct recall`
  returns no provenance).
- **Rule 6 (budgets):** Hermes bootstrap 2500 chars; live ≤2 facts/turn, ≤1200 chars,
  ≤12/session. "Never raise a limit to make up for weak matching."
- **Rule 7/8:** read-only via `ct recall` / `ct wisdom match` / sidecar tools only;
  relevance is CT's job (integrations never score/threshold).
- **Out of scope:** "Harnesses without the extension points we need: a stable
  system-prompt [section]..." — i.e. INTENT explicitly anticipates hosts that cannot
  support the full feature.

`ct wisdom match` CT contract (spec): `ct wisdom match --json [--max N]
[--exclude=<id>]... -- <text>`; exit 0 on success incl. zero matches; returns
{schema, gate, entries[{id,title,text,score,supersedes,provenance}], corrections[]};
`gate: "semantic-v1:<model>"` or `"uncalibrated"` (entries empty, corrections still
flow). **Minimum CT version for live delivery: CT 3.3.0** (shipped in
curated-thoughts#266). Against older `ct`, hooks are silent no-ops behind a
capability probe.

CI (.github/workflows/ci.yml):
- `discover` job expands integrations/<id>/integration.yaml into an os × language
  matrix; `status: planned` integrations are skipped for tests/packaging/release.
- Per-integration checks come from integration.yaml `checks:` (test/lint/shell/
  host). Hermes additionally gets a stub-host check: plugin `register(ctx)` must
  register exactly hooks `["on_session_start", "pre_llm_call",
  "transform_tool_result"]`, 3 skills, and 2 system-prompt sections with
  `{max_chars: 2500}` — **CI pins the live-delivery hook names for Hermes**; a
  DeepSeek/OpenCode live-delivery PR would need equivalent expectations defined
  for their stacks.
- OpenCode gets a dedicated `host-contract` job (real opencode binary + bun,
  tests/host/contract.test.ts), scoped to changes under integrations/opencode or
  shared/.
- Policy job: manifest schema, generated compat constants current, README version
  table current, `ct_ci_policy.py` gates.

tools/ct_ci_policy.py `gate_versions`: enforces `version_mirror` resolves and
matches (e.g. hermes integration.yaml mirrors plugin.yaml#version), a material
change requires a SemVer bump vs the base ref, and CHANGELOG.md must contain a
`## <new_version>` section (the release body is generated from it).

## 2. Hermes reference implementation (live delivery) [V]

Layout: `__init__.py` (register(ctx)) + plugin.yaml (Hermes's manifest, version
0.4.1, `provides_hooks: [on_session_start]` — note: plugin.yaml's provides_hooks
list is NOT updated with the two new hooks; they are registered in code) +
hooks/session-start.py (shell-hook alternative install path) + scripts/ + skills/
+ tests/. plugin.yaml also documents that Hermes previously ignored a
Claude-Code-format hooks/hooks.json — Hermes reads plugin.yaml + register(ctx).

**Registration (scripts/`__init__.py`):** `register(ctx)` registers 3 skills,
`register_system_prompt_section("curated-thoughts-wisdom", ..., max_chars=2500)`
plus a health section, `on_session_start`, and — since 0.4.0 —
`("pre_llm_call", _pre_llm_call)` and `("transform_tool_result", _transform_tool_result)`
via `ctx.register_hook(name, callback)`.

**Bootstrap block (ct_wisdom.py, 537 lines, v1 + 0.4.0 amendments):**
- `discover_ct()` → (path|None, failure_class): `shutil.which("ct")` + platform
  candidate list, exec-bit gate, `<ct> --help` identity probe (output must name
  "Curated Thoughts"; PROBE_TIMEOUT 3 s). probe_timeout NOT memoized;
  deterministic miss memoized.
- `recall_wiki()`: `ct recall <query> --json --k 3`, RECALL_TIMEOUT 5 s; failure
  classes timeout/exit/spawn NOT memoized; zero hits + parse errors memoized.
- `query_for()`: frozen seed + cwd basename (denylist: tmp/home/users/home-basename).
- `_sanitize()`: order matters — strip forged `ct-fact:` tokens until stable; strip
  `<!-- hermes-plugin-section` until stable; THEN indent `## Plugin Context: ` lines
  (defeats prompt-frame forgery; applied to titles AND text).
- `render_block()`: hard cap MAX_BLOCK_CHARS=2500 on final STRIPPED length (host
  drops over-length sections, never truncates); entries whole until one doesn't
  fit, that one truncated to remaining budget, rest dropped.
- `WisdomMemo`: {session_id → block} LRU 256, first-writer-wins; empty session_id
  renders "" with no memo write.
- 0.4.0 amendment: bootstrap entries carry `<!-- ct-fact:<id> -->` markers; entries
  without a valid id are dropped.

**Live delivery (ct_wisdom_live.py, 390 lines):**
- Budgets: LIVE_MAX_PER_TURN=2, LIVE_MAX_BLOCK_CHARS=1200, LIVE_MAX_PER_SESSION=12,
  LIVE_TIMEOUT=3 s, LIVE_QUERY_CHARS=2000, EXCLUDE_MAX=256, breaker 3 fails → 300 s.
- **Capability probing:** `has_match_capability(path)` runs
  `<ct> wisdom match --help` (memoized per path; probe timeout/spawn → None NOT
  memoized, retried next turn). Missing capability → `capability_missing` skip;
  old `ct` degrades to v1 behavior silently.
- **Ledger derivation (ct_ledger.py):** ledger NEVER stored across turns; rebuilt
  each turn = ids scanned from `conversation_history` (most-recent-first, reading
  BOTH `content` and host `api_content` sidecar fields) + ids in this process's
  bootstrap block memo (`bootstrap_ids()`). Fail-closed bootstrap: a session with
  no rendered bootstrap block that was not seen on its first turn (i.e. restored
  via /resume, /branch, restart) has unknowable bootstrap ids → `None` → live
  delivery skips entirely (`restored_unknown_bootstrap`). FIRST_TURN_MAX_SESSIONS=256;
  eviction beyond that is fail-closed (degrades to restored_unknown_bootstrap).
- **LedgerCache:** {session_id → set(ids)} LRU 256, written by pre_llm_call BEFORE
  early returns so transform_tool_result can dedup even on no-delivery turns.
- **pre_llm_call flow:** validate session_id → bootstrap_ids (fail-closed on
  restored) → rebuild ledger → cache it → breaker check → query = user message
  (stripped, ≤2000 chars) → discover_ct → capability probe → per-session cap check
  (12/session: counts `ct-fact:` markers in prior user-role messages) →
  `ct wisdom match --json --max N --exclude=<id>... -- <text>` →
  `render_live_block` → return `{"context": block}` (host appends to user message
  and persists exact bytes for replay = cache-safe append channel).
- **Supersession rendering:** corrections first (a correction survives only if it
  supersedes an id actually in the ledger), then non-duplicate entries; title line
  = `**title** <!-- ct-fact:id --> (provenance: x|unlabeled)` plus
  `— supersedes ct-fact:<id>` when applicable; same fit/truncate-one/stop budget
  rule as v1.
- **Exactly-once (ct_tool_dedup.py):** `transform_tool_result` handles ONLY
  tool names ending `__curated_recall_context` and only string results shaped
  `json.dumps({"result": "<CT JSON>", ...})` with `wiki_entries` — anything else
  passes through unmodified (return None). Entries whose id is in the ledger are
  replaced by `{"id", "in_context": true, "note": "already in context: ct-fact:<id>"}`
  stubs (option A: agent still sees the hit); every newly seen entry gets a
  trailing `\n<!-- ct-fact:<id> -->` marker appended to outer["result"] so the next
  turn's scan finds it. Only outer["result"] rewritten; structuredContent/_meta
  pass through verbatim (pinned accepted risk if a host renders those keys).
- **Failure handling:** every hook wraps everything in try/except → log debug +
  return None/no-op (never raises). 12 named skip classes. Breaker only counts
  timeout/exit; spawn resets discovery + capability caches.

**Tests:** test_ct_wisdom_live.py (373 lines), test_ct_ledger.py, test_ct_tool_dedup.py,
test_exactly_once.py (200 randomized sessions asserting no fact appears twice across
system block + user messages + tool results, incl. in-place compaction and random
corrections), plus 2424-line test_ct_doctor.py and 1300-line test_ct_wisdom.py.

**CT version contract:** requires CT ≥ 3.3.0 (`ct wisdom match`); capability-probed
at runtime so older CT = silent no-op (not an error). `ct recall` v1 path works on
older CT.

**Skills (curated-thoughts-usage/SKILL.md §"Wisdom that arrives on its own"):** agent-
facing contract — facts may appear under "Curated Thoughts — relevant now" with a
provenance label; `unlabeled`/agent-tier = unverified; `"in_context": true` hit =
don't re-fetch; "supersedes ct-fact:<id>" line replaces the old fact.

## 3. DeepSeek integration — current state [V]

Versions: package.json 0.3.1 = integration.yaml 0.3.1 (version_mirror);
CHANGELOG has 0.3.1 (2026-10-09, skills-parity only). GitHub releases: latest
deepseek tag = deepseek-v0.3.0 (2026-10-01); **0.3.1 has NO release tag yet**.

What exists:
- **src/wisdom.ts (542 lines, v1 bootstrap parity, 0.3.0):** TypeScript port of the
  Hermes v1 auto-inclusion. Same constants (SEED_QUERY, PROBE 3000 ms, RECALL
  5000 ms, K=3, MAX_BLOCK_CHARS 2500, MEMO_MAX 256, same BLOCK_HEADING).
  `renderBlock`/`sanitize` mirror Hermes (sanitizer neutralizes `{{` — DSH
  interpolates; no ct-fact markers yet). `discoverCt`/`probeIdentity` mirror the
  Hermes probe. Memo keyed on agent.id (= session id, stable across compaction;
  process-local, cold after restart).
- **src/index.ts:** DSH plugin with `inject = ['systemPrompt', 'skills']`; registers
  health snapshot context, `dsh.systemPrompt.section({name: 'curated-thoughts-wisdom',
  text: (assembleCtx) => renderWisdom(assembleCtx, {env: wisdomEnv})})`, and
  `dsh.on('agent/session-start', ...)` for the health refresh. Host API surface used:
  `ctx.systemPrompt.{context,section}`, `ctx.on('agent/session-start')`,
  `ctx.skills.register`. Typed via TypeScript module augmentation.
- **scripts/:** ct_doctor.ts, ct_env.ts, ct_preflight.ts, install.sh,
  _compat_generated.ts, _lazy_loader.ts. tests/: 15 files incl. test_wisdom.ts,
  e2e/ harness, host/compatibility.json (pinned DSH 0.1.5-rc.2; every published
  DSH release so far is a pre-release).
- **skills/curated-thoughts-usage/SKILL.md:** live-wisdom section byte-identical to
  Hermes (verified by diff) — 0.3.1.

DSH host surface (from the DSH step-0 investigation, pinned 0.1.5-rc.2):
- System prompt: `systemPrompt.section/context` with `text` functions re-invoked on
  EVERY model step; no registration-time freeze; value-dedupe for context().
- Events: `agent/session-start` (fire-and-forget, not awaited). No per-user-turn
  hook, no tool-result transform hook, no user-message append channel was found in
  the investigation; `section()` renders into system node 0 (cache-hostile to
  mutation) unless `systemPromptUpdate: 'in-history'`; `context()` appends a
  runtime-context USER message after history (value-deduped, cache-appendable).

**Structurally MISSING for live delivery on DSH:**
- No `pre_llm_call`-equivalent: nothing hands the plugin the current user message
  once per turn. Closest primitives: (a) a `section()`/`context()` text function
  could theoretically emit a live block, but it can't see the user message
  (AssembleContext = {agent, scope, signal} only) and mutating section() breaks
  caching at node 0; a `context()` whose VALUE changes would append a new user
  message per change — that is the only DSH append channel, and the query text for
  `ct wisdom match` would have to come from somewhere the plugin can read the
  user's message (none identified in-repo).
- No `transform_tool_result`-equivalent: no hook intercepts MCP tool results, so
  exactly-once stubbing of `curated_recall_context` hits has no surface.
- wisdom.ts has no ct-fact markers, no ledger, no `ct wisdom match` wrapper, no
  capability probe, no breaker — all of that would be a port.
- INTENT already records the degraded parity status: "DeepSeek Harness injects only
  at session start, and its agent-run CT searches can repeat a fact."
[C] Degraded-parity option that fits DSH today: keep bootstrap-only + skills
guidance, possibly add ct-fact markers to the bootstrap block and dedup at recall
time via the CT side (`--exclude`), but turn-triggered matching has no hook.

## 4. OpenCode integration — current state [V]

Versions: package.json 0.1.1 = integration.yaml 0.1.1. GitHub releases: latest
opencode tag = opencode-v0.1.0 (2026-09-18); **0.1.1 (2026-10-09, skills-parity)
has NO release tag yet**.

What exists (src/ = index.ts, format.ts, refresh.ts, status.ts — NO wisdom module):
- **src/index.ts:** single named export `CuratedThoughts: Plugin` (OpenCode 1.18.31
  ignores named exports when a `server` module exists — verified in
  tests/host/compatibility.json findings.exportForms). Returns ONE hook:
  `experimental.chat.system.transform` — appends the health status block to
  `output.system` (additive, idempotent via isStatusBlock guard), plus
  fire-and-forget health cache refresh, plus `dispose`. No wisdom anything.
- **Host surface (compatibility.json, pinned opencode 1.18.31 + plugin SDK):**
  - systemTransform fires; entries handed to hook = 1 (host's full system prompt as
    a single string); pushed entry sent as a separate system message; fresh array
    per assembly, prior entries preserved.
  - The `event` hook sees session.created/updated, message.updated,
    message.part.updated/delta, session.status/diff/idle, plugin.added,
    catalog/reference/integration.updated. NO MCP status event type exists
    (mcpStatusEvents=false). NO tool-result transform hook. NO per-user-turn
    pre-LLM hook. PluginInput keys: $, client, directory, experimental_workspace,
    project, serverUrl, worktree.
  - Skills discovered from ~/.config/opencode/skills/<name>/SKILL.md, listed in the
    system prompt.
- skills/curated-thoughts-usage/SKILL.md live-wisdom section byte-identical to
  Hermes (verified by diff) — shipped in 0.1.1.
- scripts/: ct_doctor.ts, ct_env.ts, ct_preflight.ts, install.sh, install.ts,
  loader.js.tmpl, registration.ts. tests/: incl. tests/host/contract.test.ts run
  against the real binary in CI.

**Structurally MISSING for live delivery on OpenCode:**
- No user-turn hook that sees the user message → no trigger for `ct wisdom match`.
- No tool-result transform → no exactly-once stubbing surface.
- The system transform is the only mutation point and it fires with the whole
  system array; mutating it mid-session violates INTENT Rule 2 (and the harness
  may cache prompts).
- No ledger/markers/matcher/capability-probe code exists in src/.
[C] Candidate-but-unproven paths: `message.updated` / `message.part.updated` events
could observe user messages (read-only trigger), but there is no demonstrated
mechanism to INJECT content into the outgoing request from an event; a
`context()`-style append is not part of the observed plugin API. Any live delivery
here needs a fresh host investigation (step-0 style) against the current opencode
SDK; the compatibility.json harness (probe fixtures + contract test + CI job)
already exists to run that investigation cheaply.

## 5. Placeholder integrations [V]

- **integrations/openclaw/integration.yaml** (the ONLY file): id openclaw,
  status: planned, version 0.0.0, language: python, requires_sidecar >=2.5,
  compat_tier v2.5-full. Comment: schema-validated but skipped for tests,
  packaging, release until the integration exists.
- **integrations/claude-code/integration.yaml** (the ONLY file): identical shape,
  id claude-code, language: python, status planned.
- Neither yaml claims any hook capability; nothing in-repo describes the OpenClaw
  or Claude Code hook surfaces. [C] From outside this repo (agent knowledge, not
  verified here): Claude Code plugins do have SessionStart/PreToolUse/PostToolUse/
  UserPromptSubmit-style hook events that could map to live delivery
  (UserPromptSubmit ≈ pre_llm_call trigger; PostToolUse on the CT MCP tools ≈
  tool-result transform), but the mapping, prompt-injection semantics, and caching
  behavior are unverified — the repo even documents that an earlier Hermes attempt
  using Claude Code's plugin format was wrong for Hermes, so format assumptions
  must be re-verified per host. OpenClaw's harness API is not represented anywhere
  in this repo at all.

## 6. Capability table — harness hook surface vs live-delivery needs

Live delivery needs (from the Hermes reference):
  N1 trigger-once-per-user-turn with the user's message text (pre_llm_call)
  N2 append channel into that turn's request, host-persisted for replay
     (cache-safe, never the system prompt)
  N3 tool-result transform for MCP `curated_recall_context` (exactly-once stubs
     + ct-fact markers)
  N4 session identity stable across compaction + a way to rebuild the ledger
     from what the host persists (or fail closed on restore)
  N5 access to the system-prompt bootstrap ids it rendered this process

| Need | Hermes 0.4.1 | DeepSeek 0.3.1 (DSH) | OpenCode 0.1.1 | openclaw/claude-code |
|---|---|---|---|---|
| N1 per-turn trigger w/ user msg | YES pre_llm_call [V] | NO [V—none found in DSH investigation] | NO [V—event hook sees message events but no documented injection path] | unknown [V—no data in repo] |
| N2 host-persisted append channel | YES {"context"} → api_content sidecar, byte-stable replay [V] | PARTIAL: systemPrompt context() appends a value-deduped user msg after history [V]; not proven per-turn/live | NO [V—only system-array transform; pushed entry = separate system message] | unknown |
| N3 tool-result transform | YES transform_tool_result [V] | NO [V] | NO [V] | unknown |
| N4 ledger rebuild source | conversation_history incl. api_content + memo; restored → fail-closed [V] | session log persisted by host; agent.id stable across compaction [V] but no ledger exists [V] | unknown (session events exist; persistence shape unprobed) [C] | unknown |
| N5 bootstrap ids | ct_wisdom bootstrap memo (first-turn tracking, fail-closed) [V] | memo exists; no markers yet [V] | no wisdom module [V] | n/a |
| Bootstrap auto-inclusion (v1) | YES 0.3.x+ [V] | YES 0.3.0 [V] | NO [V] | no |
| Skills parity (live guidance) | YES [V] | YES 0.3.1 [V] | YES 0.1.1 [V] | no |

## 7. Version / release state table [V]

| Integration | Manifest/CI version | CHANGELOG | Latest GitHub release | Delta (main vs released) |
|---|---|---|---|---|
| hermes | 0.4.1 (plugin.yaml + integration.yaml) | 0.4.1 + 0.4.0 (live delivery) | hermes-v0.4.1 (2026-10-09, Latest) | none — live delivery IS released |
| deepseek | 0.3.1 (package.json + integration.yaml) | 0.3.1 (2026-10-09, skills only) | deepseek-v0.3.0 (2026-10-01) | 0.3.1 unreleased (skills-parity only) |
| opencode | 0.1.1 (package.json + integration.yaml) | 0.1.1 (2026-10-09, skills only) | opencode-v0.1.0 (2026-09-18) | 0.1.1 unreleased (skills-parity only) |
| openclaw | 0.0.0, status: planned | none | none | placeholder dir (integration.yaml only) |
| claude-code | 0.0.0, status: planned | none | none | placeholder dir (integration.yaml only) |

## 8. Gaps and risks

Gaps (ordered by parity impact):
1. DeepSeek: no per-turn trigger (N1) and no tool-result transform (N3) → full live
   delivery impossible on the probed DSH surface (0.1.5-rc.2); degraded parity =
   bootstrap-only injection + skills guidance (current state, INTENT-acknowledged).
2. OpenCode: same N1/N3 absence on 1.18.31, plus no proven append channel (N2);
   even less surface than DSH. Degraded parity = health block + skills only.
3. Neither TS integration has: ct-fact markers in its bootstrap block, a ledger,
   `ct wisdom match` wrapper, capability probe, live budgets, or a breaker — a
   port is new code, not a refactor.
4. CI: the Hermes stub-host check hardcodes the 3-hook registration contract;
   equivalent per-host contracts must be designed before TS integrations gain
   hooks (opencode already has a real-binary host-contract harness to extend).
5. CT-side gaps temper value everywhere: relevance gate "rarely opens on real
   messages" (curated-thoughts#271) and Librarian doesn't apply supersessions yet,
   so corrections rarely/never flow (INTENT Rules 3/8 status).
6. Release hygiene: deepseek 0.3.1 and opencode 0.1.1 are on main, unreleased;
   the next feature PR will likely need to decide whether to ride the pending
   bumps or cut releases first (ct_ci_policy requires a CHANGELOG section + bump
   for material changes).

Risks:
- Cache invariants (INTENT Rule 2) are the sharpest failure mode: any TS port that
  mutates a system-prompt section per turn breaks host prompt caching (DSH system
  node 0 invalidation is total; opencode pushes separate system messages).
- Host-version pinning: DSH findings pinned to 0.1.5-rc.2 (all published DSH
  releases are pre-releases); opencode pinned to 1.18.31. Both must be re-probed
  before designing against them.
- Fail-closed restore semantics depend on host-specific restore behavior
  (Hermes: unknown bootstrap ids on restored sessions → live off). Each host needs
  its own equivalent rule; a host that re-renders prompts on resume could leak
  duplicates if the rule is copied blindly.
- The OpenClaw/Claude-Code hook surfaces are NOT documented in this repo; any
  claims about them must come from a step-0 investigation against those hosts.

## 9. NOT CHECKED

- Actual DeepSeek Harness / OpenCode SDK source outside this repo (hook surface
  conclusions for DSH/opencode rely on the repo's own pinned investigations and
  compatibility.json; no fresh probe was run).
- Whether newer DSH (0.1.6-alpha.2 noted in compatibility.json) or opencode
  releases added per-turn/tool-result hooks since the pins.
- integrations/deepseek/tests/test_wisdom.ts and e2e/ contents (existence
  verified, not read).
- integrations/opencode/src/refresh.ts, status.ts, format.ts internals (names +
  role verified via index.ts imports only).
- scripts/install.sh contents for deepseek/opencode; hermes scripts/ct_doctor.py,
  ct_preflight.py, ct_env.py internals.
- docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-design.md (v1 Hermes
  spec) and the opencode integration design spec — only the DSH investigation and
  live-delivery spec/investigation were read in full.
- shared/compat.yaml contents (referenced by skills; tier matrix asserted there).
- Whether the `ct wisdom match --help` capability probe would also succeed on a
  differently-named CLI that happens to answer (identity probe separation was not
  re-derived).
- GitHub release *bodies* (only tag list + dates were pulled via gh).

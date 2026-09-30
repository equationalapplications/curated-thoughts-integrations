# curated-thoughts-integrations — Hermes wisdom-layer auto-inclusion design

**Date:** 2026-09-30 · **Status:** Implemented 2026-09-30 (PR #21 — pending merge) (review-converged; Implemented after merge) · **Branch:** `feat/session-start-wisdom-inclusion` · **Priority:** high (Kurt directive 2026-09-29)
**Review:** Opus spec cycle 1 = REQUEST CHANGES (3 MAJOR, 8 MINOR, 3 nits) → all
applied (M1 cwd-pinning + measured cold start; M2 empty-id rule; M3 single-API
contract; m1 N=256; m2 lock pattern; m3 executor citation; m4 placement wording;
m5 max_chars pin; m6 sanitization precision; m7 discovery list; m8 id behavior
resolved [V]). Opus spec cycle 2 (delta) = REQUEST CHANGES (1 MINOR/MAJOR, 3 MINOR,
2 nits) → all applied (cold-path honesty + timeout-empties not memoized; citation
776-786; sanitization order + titles; identity probe for wrong-binary `ct`; /resume
coverage; README dedupe). Opus spec cycle 3 (delta) = REQUEST CHANGES (2 mechanism, 1 probe,
1 tests, 1 nit) → all applied (/branch//resume restore-not-recall corrected [V];
failure classes explicit; probe text verified + under subprocess contract; 3 tests
added; Windows path typo). **Opus spec cycle 4 (delta) = APPROVE WITH NITS** → nits
applied (conditional restore path cited, e2e expectation fixed, probe-timeout
classified not-memoized). **Spec review CONVERGED (4 cycles, code cap).**

Investigation: [`../investigations/2026-09-30-wisdom-auto-inclusion-step0-investigation.md`](../investigations/2026-09-30-wisdom-auto-inclusion-step0-investigation.md)
(3 Opus cycles; every claim below marked "measured" or "verified" carries its [V] evidence there).

## Problem

Kurt's directive: semantically relevant wisdom-layer matches must be **automatically
included, additively, exactly once per agent session, without breaking LLM prompt
caching**. Today a Hermes session gets CT context two ways, both manual or
non-semantic: the agent must *choose* to call the recall tools (usage skill), and the
plugin injects only a machine-scoped **health** section (v0.2.2, 409 chars measured)
with no wisdom content. The wisdom layer — CT's "easiest, first-class source of
context" per the memory architecture intent — never reaches the prompt unless asked
for.

Constraint set (all verified in the investigation): the Hermes prompt is
cache-prefix-managed (per-conversation caching "is sacred"; AGENTS.md invariant);
plugin sections render at every host `invalidate_system_prompt` boundary, not once per
session; the section callable sees only session metadata (no user message); and wisdom
recall results carry **no similarity score**.

## Approach

A second system-prompt section from the existing plugin — `id="curated-thoughts-wisdom"`,
registered alongside the health section in `register(ctx)` — whose callable renders a
bounded, sanitized, **memoized** wisdom block:

1. **Match:** shell out to `ct recall "<seed> [<cwd-basename>?]" --json` (dedicated
   binary-discovery candidate list — `ct` is NOT the sidecar), consume **only the
   `wiki` list**, top `k=3`. Single subprocess API:
   `subprocess.run([ct_path, "recall", query, "--json"], stdin=DEVNULL,
   capture_output=True, timeout=5, cwd=<pinned>)` — list argv, never `shell=True`;
   `cwd` pinned to the user home (deterministic working dir; verified 2026-09-30:
   `ct recall` creates no cache in the cwd and its embedding profile is
   network/backend-based, so placement is hygiene, not correctness).
2. **Query:** static seed constant `"curated thoughts agent memory wisdom procedures"`
   (tuned once at e2e, then frozen) + the cwd basename **only when non-degenerate**
   (non-empty, ≠ home basename, not in a tiny denylist). Measured: metadata-only
   queries retrieve zero entries; the seed does the semantic work.
3. **Render:** `## Curated Thoughts — relevant memory` + per-entry `**title**` +
   trimmed text; registered with **`max_chars=2500`** (pinned, not the 4000 default)
   and rendered ≤ 2500 chars post-strip (host measures stripped text and DROPS
   over-length sections); titles AND fact text sanitized, in this order: (1) remove every
   `<!-- hermes-plugin-section` substring **repeatedly until stable** (one pass can
   splice a new marker together); (2) then indent any line beginning
   `## Plugin Context: ` (removal can expose a forbidden line-start, so indentation
   must come last). A forged frame would break host resume-restore for BOTH sections
   — unit tests: forged frame in title, in text, and the splice case all restore
   cleanly);
   zero wiki entries → return `""` (host skip = graceful no-op).
4. **Once-semantics:** plugin-side session-keyed memo `{session_id → block-or-empty}`
   — bounded LRU **N=256** (worst case ≈640 KB; eviction with a later re-render is
   documented as a v1 limitation), **empty results memoized too**. **Empty
   `session_id` → return `""` without memoizing** (session_info builds ids via
   `str(getattr(agent, k, None) or "")` — a blank id must never become a shared memo
   key). Lock pattern copied from the health section (`__init__.py:97-109`): memo
   *check* under the lock, `ct` subprocess **outside** it, first writer wins
   (`setdefault`) so racing renders for one session return identical bytes.
   Re-renders at any invalidation boundary return the stored bytes → byte-identical
   re-materialization; the block sits in the **volatile tail — after memory, before
   the timestamp/environment lines** (`system_prompt.py:776-786`: the extend call is
   immediately followed by the timestamp line), so even a changed byte could not
   break the reused stable prefix.
5. **Fail-open:** discovery miss, non-zero exit, timeout (`subprocess.run(timeout=5)`
   kills and reaps on expiry; `stdin=DEVNULL` prevents TTY/pipe hangs in gateway
   mode), JSON parse error, or empty recall → no section. Nothing raises into prompt
   assembly. Verified: `ct` spawns no grandchildren (strace: threads only) — the
   single-API timeout contract is sound.

**Rejected alternatives** (full reasoning in the investigation): MCP-over-stdio
re-implementation (protocol client for no capability gain; fail-closed audit
semantics wrong for a prompt path); shell-hook context emission (unbudgeted,
duplicate of the section mechanism, consent surface); host-only freeze for
once-semantics (FALSE — `invalidate_system_prompt` re-renders; Opus cycle-1 BLOCKER);
metadata-only query (measured: retrieves nothing); similarity threshold
(unimplementable — no scores exist on wiki entries).

## Data flow

```
register(ctx) ──► register_system_prompt_section("curated-thoughts-wisdom", render_wisdom, max_chars=2500)
                          │
first prompt build ──► render_wisdom(session_info)
                          ├─ memo[session_id] hit → stored bytes
                          ├─ miss: discover ct (which → candidates+probe) → fail: "" (memoized)
                          ├─ subprocess: ct recall <query> --json  (timeout 5s) → fail: "" (NOT memoized)
                          │            non-zero exit → fail: "" (NOT memoized)
                          ├─ parse JSON → wiki[0..3] → empty: memoize "" → ""
                          ├─ sanitize → render ≤2500 → memoize → block
                          └─ all exceptions swallowed (debug log) → ""
resume in new process: host restores bytes; callable not invoked (v1 limitation:
post-restart invalidation may re-recall — documented)
```

## Resolved decisions (from the investigation's open questions)

- **OQ1 re-render policy — resolved with observed host behavior [V] (corrected in
  spec cycles 3-4):** `/new` (`cli_session_mixin.py:524`) **rotates** `session_id` →
  new epoch → the next build calls the renderer → fresh recall (correct: a genuinely
  new conversation). **`/branch` and `/resume` restore rather than re-render, with
  conditions**: `_sync_agent_to_session` (`cli_commands_mixin.py:318-333`) invalidates
  the prompt, then the next turn `_restore_or_build_system_prompt` →
  `restore_plugin_prompt_sections` (`conversation_loop.py:772-794`). The RESTORE path
  is taken when the session has non-empty history AND its stored `system_prompt`
  matches the runtime — then the callable is never invoked and the memo stays empty
  for the new id (`/branch` deliberately copies the parent's exact prompt into the
  child row, `cli_commands_mixin.py:1408-1418`, to keep the cache warm). Otherwise
  the row rebuilds → one fresh render → fresh recall (also: `/branch` from a parent
  with no stored prompt rebuilds). Both outcomes are correct: a rebuild means a new
  id gets a fresh block while the prefix is being rewritten anyway. Consequence: the first
  compression after an in-process `/branch` or `/resume` misses the memo → fresh
  recall → bytes can change (this is README limitation 1's mechanism; the
  "fresh process" qualifier is REMOVED — it happens in-process too). Rewind
  preserves id and prompt → host restore, memo unconsulted. Memo replay is the
  mechanism ONLY at compression/rebuild boundaries, where the host clears the
  snapshot and calls the renderer again.
  Legacy non-in-place compression also rotates (`conversation_compression.py:3357/3386`,
  default in-place `True` at 4092) with **no plugin-visible lineage signal** (Opus
  cycle-3) → same accepted v1 limitation.
- **OQ2 `ct` discovery:** `shutil.which("ct")` (handles `PATHEXT`/`.exe` on Windows),
  then explicit candidates: Linux `~/.local/bin/ct`, `/usr/bin/ct`,
  `/usr/local/bin/ct`, `~/bin/ct`; macOS `~/bin/ct`, `/usr/local/bin/ct`,
  `/opt/homebrew/bin/ct`; Windows `%USERPROFILE%\bin\ct.exe`,
  `%LOCALAPPDATA%\CuratedThoughts\bin\ct.exe`. Each candidate is **identity-probed** before acceptance
  (verified 2026-09-30 [V]: `ct --help` line 1 is "`ct` — headless CLI for Curated
  Thoughts brains" — chart-testing's `ct` shares the name on Homebrew; Opus spec-D);
  the probe runs under the SAME subprocess contract (list argv, `stdin=DEVNULL`,
  `timeout=3`); first candidate passing the probe wins; rejected paths logged at
  debug. A probe TIMEOUT is classified as NOT memoized (same class as a recall
  timeout — a slow first-run binary must not darken a session; spec cycle 4 nit).
  The plan still checks what path the dpkg package ships `ct` at.
- **OQ3 render blocking:** synchronous with `timeout=5` in v1. Justification:
  latency **measured 2026-09-30 [V]** — warm 0.765 s, cold-from-clean-dir 0.35–0.44 s
  (embedding resolution is backend-based, not a local model load on the recall path);
  gateway agent work runs through `run_in_executor` (`gateway/run.py:4294-4312`), so
  a synchronous render does not block the event loop. Same pattern as `ct_status`
  probes; async-refresh would add a thread + staleness semantics for a bootstrap-only
  block. Unit test pins the subprocess `cwd`.
  **Cold-path honesty (Opus spec cycle 2):** the 0.35–0.44 s figure measured a clean
  *cwd*, not a cold embedding backend (strace showed ~10 local `connect()` calls — a
  local service that may idle-unload its model). Two countermeasures: (1) the plan
  measures a true cold recall (backend restarted / idle-unloaded) before freezing
  `timeout=5`); (2) **failure classes are memoized EXPLICITLY** (spec cycle 3):
    *memoize* — zero wiki hits (deterministic for this brain), discovery miss, parse
    error; *do NOT memoize* — **timeout** and **non-zero exit** (both indicate a
    possibly-transient backend state — restarting, idle-unloaded model, connection
    refused; a dark-forever session is worse than a retry): the next render retries.
    Empty-render count expectations in tests distinguish the classes.
- **OQ5 seed constant:** `"curated thoughts agent memory wisdom procedures"` — frozen
  after e2e tuning (one change max, then hard-freeze).
- **OQ6 caps:** `k=3`, `max_chars=2500` — frozen after e2e.
- **OQ7 — superseded by the single-API contract** (`subprocess.run` +
  `stdin=DEVNULL` + `timeout`); grandchildren question closed by strace [V].

## Error handling

Every failure mode collapses to "section absent" (host skip rule), never an exception
in prompt assembly: discovery miss · spawn failure · timeout · non-zero exit ·
invalid JSON · zero wiki entries · oversize render (pre-truncated instead) · memo
corruption (defensive `except` around the read → treat as miss). Known eviction risk
(accepted): the wisdom section sorts AFTER `curated-thoughts`, so a third-party or
future section sorting earlier that overruns the 8000-char aggregate budget would
silently evict the wisdom block (host WARNING only) — logged here and in README.
Logging: debug-level one-liners with a `wisdom` prefix; never INFO (prompt renders
are noisy enough).

## Testing

- **Unit (stdlib unittest, mirrors `integration.yaml` checks):** fake `ct` on PATH;
  wiki-only consumption; k/truncation/sanitization; each no-op mode; query-template
  stability (golden string incl. degenerate-cwd cases); memo hit/miss/eviction/empty;
  timeout kill path; discovery fallback order; concurrent render (thread) safety;
  timeout-empty NOT memoized and next render retries; probe rejects a non-CT `ct`;
  empty `session_id` returns "" with NO memo write.
- **e2e (scratch profile `ct-test` ONLY — never the live default profile):** install
  branch payload → real CLI session → exactly one wisdom block in the assembled
  prompt (direct render-path invocation under `HERMES_HOME`, mechanism verified);
  plugin debug-line (`wisdom: render …`) expectations per boundary (1 with no
  invalidation boundary) — debug level, never INFO
  `/branch`//`/resume`: ZERO render lines when the restore path is taken — non-empty
  history + stored prompt matches runtime — otherwise exactly one fresh render;
  the e2e script seeds at least one exchange before branching); content hash stable
  across an induced compression. Stripped-PATH case exercises candidate
  fallback.
- **CI:** existing matrix (3 OS × py3.9-3.13) + ruff; no new deps (stdlib only).

## Versioning, docs, and safety pins

- **Version bump:** `integrations/hermes/plugin.yaml` and `integration.yaml` →
  **0.3.0** (new feature, `version_mirror` keeps them in lockstep) + CHANGELOG entry
  under the Hermes integration.
- **Subprocess safety:** `ct` is invoked with **list argv via `subprocess.run`,
  never `shell=True`**; the cwd basename and seed are passed as a single argv element.
  No user-controllable input reaches a shell.
- **README:** document the feature (one paragraph), the graceful no-op behavior, and
  exactly one limitations list (three items): (1) restored-session re-render gap —
  after `/branch`, `/resume`, or a process restart, the block comes from persisted
  bytes with an empty memo, so the first compression in that session may re-recall
  and change bytes; (2) legacy-compression rotation; (3) memo eviction beyond N=256
  live sessions.
- **Skills drift check:** the three shipped CT skills describe the plugin context;
  implementation verifies their wording still matches and updates if needed.
- **e2e compression induction:** how to force an invalidation boundary in a scratch
  CLI session (long transcript vs direct `invalidate_system_prompt` call in the
  render harness) — decided in the plan, not here.

## Out of scope (v1)

No CT core changes; no new MCP tools; no score-bearing recall endpoint (upgrade path
noted); no mid-session block mutation (handoff exit criteria: one static bootstrap
block; "additive" = additive with the health section); no memo seeding from restored
prompt bytes (open question 8 — accepted limitation); no OpenClaw/Claude Code sibling
implementations (Hermes-first); no config surface in v1 (all constants frozen in
code).

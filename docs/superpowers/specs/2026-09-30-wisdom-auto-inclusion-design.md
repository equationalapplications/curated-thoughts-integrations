# curated-thoughts-integrations — Hermes wisdom-layer auto-inclusion design

**Date:** 2026-09-30 · **Status:** Draft · **Branch:** `feat/session-start-wisdom-inclusion` · **Priority:** high (Kurt directive 2026-09-29)
**Review:** Opus spec cycle 1 = REQUEST CHANGES (3 MAJOR, 8 MINOR, 3 nits) → all
applied (M1 cwd-pinning + measured cold start; M2 empty-id rule; M3 single-API
contract; m1 N=256; m2 lock pattern; m3 executor citation; m4 placement wording;
m5 max_chars pin; m6 sanitization precision; m7 discovery list; m8 id behavior
resolved [V]) → cycle 2 delta pending.

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
   over-length sections); fact text sanitized precisely: every
   `<!-- hermes-plugin-section` substring removed, and any line beginning
   `## Plugin Context: ` indented (a forged frame would break host resume-restore for
   BOTH sections — unit test: forged frame in fact text still restores cleanly);
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
   the timestamp/environment lines** (per `system_prompt.py:149-156`), so even a
   changed byte could not break the reused stable prefix.
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
register(ctx) ──► register_system_prompt_section("curated-thoughts-wisdom", render_wisdom)
                          │
first prompt build ──► render_wisdom(session_info)
                          ├─ memo[session_id] hit → stored bytes
                          ├─ miss: discover ct (which → candidates) → fail: ""
                          ├─ subprocess: ct recall <query> --json  (timeout 5s) → fail: ""
                          ├─ parse JSON → wiki[0..3] → empty: memoize "" → ""
                          ├─ sanitize → render ≤2500 → memoize → block
                          └─ all exceptions swallowed (debug log) → ""
resume in new process: host restores bytes; callable not invoked (v1 limitation:
post-restart invalidation may re-recall — documented)
```

## Resolved decisions (from the investigation's open questions)

- **OQ1 re-render policy — resolved with observed id behavior [V]:** `/new`
  (`cli_session_mixin.py:524`) and `/branch` (`cli_commands_mixin.py` memory-manager
  note) **rotate** `session_id` → new epoch → fresh recall (correct: a genuinely new
  conversation deserves a fresh block). Rewind preserves the id → memo replay.
  Legacy non-in-place compression also rotates (`conversation_compression.py:3357/3386`,
  default in-place `True` at 4092) with **no plugin-visible lineage signal** (Opus
  cycle-3) → mid-session rotation there is an accepted v1 limitation, documented in
  README.
- **OQ2 `ct` discovery:** `shutil.which("ct")` (handles `PATHEXT`/`.exe` on Windows),
  then explicit candidates: Linux `~/.local/bin/ct`, `/usr/bin/ct`,
  `/usr/local/bin/ct`, `~/bin/ct`; macOS `~/bin/ct`, `/usr/local/bin/ct`,
  `/opt/homebrew/bin/ct`; Windows `%USERPROFILE%\bin\ct\ct.exe`,
  `%LOCALAPPDATA%\CuratedThoughts\bin\ct.exe`. First executable (verified via
  `os.access(X_OK)` on POSIX; `which` covers Windows) wins; source logged at debug.
  The plan still checks what path the dpkg package ships `ct` at.
- **OQ3 render blocking:** synchronous with `timeout=5` in v1. Justification:
  latency **measured 2026-09-30 [V]** — warm 0.765 s, cold-from-clean-dir 0.35–0.44 s
  (embedding resolution is backend-based, not a local model load on the recall path);
  gateway agent work runs through `run_in_executor` (`gateway/run.py:4294-4312`), so
  a synchronous render does not block the event loop. Same pattern as `ct_status`
  probes; async-refresh would add a thread + staleness semantics for a bootstrap-only
  block. Unit test pins the subprocess `cwd`.
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
  timeout kill path; discovery fallback order; concurrent render (thread) safety.
- **e2e (scratch profile `ct-test` ONLY — never the live default profile):** install
  branch payload → real CLI session → exactly one wisdom block in the assembled
  prompt (direct render-path invocation under `HERMES_HOME`, mechanism verified);
  INFO log-line expectations per boundary (1 with no invalidation boundary); content
  hash stable across an induced compression. Stripped-PATH case exercises candidate
  fallback.
- **CI:** existing matrix (3 OS × py3.9-3.13) + ruff; no new deps (stdlib only).

## Versioning, docs, and safety pins

- **Version bump:** `integrations/hermes/plugin.yaml` and `integration.yaml` →
  **0.3.0** (new feature, `version_mirror` keeps them in lockstep) + CHANGELOG entry
  under the Hermes integration.
- **Subprocess safety:** `ct` is invoked with **list argv via `subprocess.run`,
  never `shell=True`**; the cwd basename and seed are passed as a single argv element.
  No user-controllable input reaches a shell.
- **README:** document the feature (one paragraph), the three accepted v1 limitations
  (post-restart invalidation; legacy-compression rotation; memo eviction), and the
  graceful no-op behavior.
- **Skills drift check:** the three shipped CT skills describe the plugin context;
  implementation verifies their wording still matches and updates if needed.
- **e2e compression induction:** how to force an invalidation boundary in a scratch
  CLI session (long transcript vs direct `invalidate_system_prompt` call in the
  render harness) — decided in the plan, not here.
- **README limitations list (three):** post-restart invalidation; legacy-compression
  rotation; memo eviction beyond N=256 live sessions.

## Out of scope (v1)

No CT core changes; no new MCP tools; no score-bearing recall endpoint (upgrade path
noted); no mid-session block mutation (handoff exit criteria: one static bootstrap
block; "additive" = additive with the health section); no memo seeding from restored
prompt bytes (open question 8 — accepted limitation); no OpenClaw/Claude Code sibling
implementations (Hermes-first); no config surface beyond nothing (all constants
frozen in code; no config surface in v1.

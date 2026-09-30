# curated-thoughts-integrations — Hermes wisdom-layer auto-inclusion design

**Date:** 2026-09-30 · **Status:** Draft · **Branch:** `feat/session-start-wisdom-inclusion` · **Priority:** high (Kurt directive 2026-09-29)

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
   `wiki` list**, top `k=3`.
2. **Query:** static seed constant `"curated thoughts agent memory wisdom procedures"`
   (tuned once at e2e, then frozen) + the cwd basename **only when non-degenerate**
   (non-empty, ≠ home basename, not in a tiny denylist). Measured: metadata-only
   queries retrieve zero entries; the seed does the semantic work.
3. **Render:** `## Curated Thoughts — relevant memory` + per-entry `**title**` +
   trimmed text; hard cap 2500 chars post-strip (host measures stripped text and
   DROPS over-length sections); reserved container/frame markers stripped from fact
   text (protects host resume-restore for both sections); zero wiki entries → return
   `""` (host skip = graceful no-op).
4. **Once-semantics:** plugin-side session-keyed memo `{session_id → block-or-empty}`
   (lock-guarded, bounded LRU N=16, empty results memoized too). Re-renders at any
   invalidation boundary return the stored bytes → byte-identical re-materialization;
   the block lands at the END of the volatile tier, so even a change could not break
   the reused stable prefix (reviewer-verified conservative).
5. **Fail-open:** discovery miss, non-zero exit, timeout (5 s, `communicate()`+kill —
   Windows-safe), JSON parse error, or empty recall → no section. Nothing raises into
   prompt assembly.

**Rejected alternatives** (full reasoning in the investigation): MCP-over-stdio
re-implementation (protocol client for no capability gain; fail-closed audit
semantics wrong for a prompt path); shell-hook context emission (unbudgeted,
duplicate of the section mechanism, consent surface); host-only freeze for
once-semantics (FALSE — `invalidate_system_prompt` re-renders; Opus cycle-1 BLOCKER);
metadata-only query (measured: retrieves nothing); similarity threshold
(implementable — no scores exist on wiki entries).

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

- **OQ1 re-render policy:** memo replay wins at every boundary. Legacy
  non-in-place compression rotates `session_id` (verified: `conversation_compression.py:3357/3386`,
  default in-place `True` at 4092) and **no plugin-visible lineage signal exists**
  (Opus cycle-3) → rotation is treated as a **new epoch** (memo miss = fresh recall).
  Accepted v1 limitation, documented in README.
- **OQ2 `ct` discovery:** `shutil.which("ct")`, then `~/.local/bin/ct` (Linux),
  `~/bin/ct`, `%USERPROFILE%\bin\ct` / `%LOCALAPPDATA%\CuratedThoughts\bin\ct` (Windows),
  `~/bin/ct` / `/usr/local/bin/ct` (macOS); first executable wins; source logged at
  debug.
- **OQ3 render blocking:** synchronous with `timeout=5` in v1. Justification: warm
  recall measured 0.765 s; the same pattern as `ct_status` probes; async-refresh adds
  a thread + staleness semantics for a bootstrap-only block. Cold-start latency
  measured during implementation; if > 5 s on any CI platform, timeout becomes
  config-tunable (default stays 5) rather than async.
- **OQ5 seed constant:** `"curated thoughts agent memory wisdom procedures"` — frozen
  after e2e tuning (one change max, then hard-freeze).
- **OQ6 caps:** `k=3`, `max_chars=2500` — frozen after e2e.
- **OQ7 Windows subprocess:** `communicate(timeout=)` + `kill()` on
  `TimeoutExpired`; no process groups needed (`ct` spawns no grandchildren).

## Error handling

Every failure mode collapses to "section absent" (host skip rule), never an exception
in prompt assembly: discovery miss · spawn failure · timeout · non-zero exit ·
invalid JSON · zero wiki entries · oversize render (pre-truncated instead) · memo
corruption (defensive `except` around the read → treat as miss). Logging: debug-level
one-liners with a `wisdom` prefix; never INFO (prompt renders are noisy enough).

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

## Out of scope (v1)

No CT core changes; no new MCP tools; no score-bearing recall endpoint (upgrade path
noted); no mid-session block mutation (handoff exit criteria: one static bootstrap
block; "additive" = additive with the health section); no memo seeding from restored
prompt bytes (open question 8 — accepted limitation); no OpenClaw/Claude Code sibling
implementations (Hermes-first); no config surface beyond nothing (all constants
frozen in code; revisit if e2e demands).

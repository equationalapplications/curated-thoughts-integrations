# Wisdom-Layer Auto-Inclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `curated-thoughts-wisdom` system-prompt section to the Hermes
integration: semantically relevant wisdom-layer entries injected at session start,
once per session, cache-safe, fail-open — per the converged spec.

**Architecture:** One new stdlib-only module `integrations/hermes/scripts/ct_wisdom.py`
(discovery + identity probe → `ct recall` subprocess → wiki-only consumption →
sanitize → render → session-keyed memo), wired as a second
`register_system_prompt_section("curated-thoughts-wisdom", render, max_chars=2500)`
call in `__init__.py` alongside the existing health section. No new dependencies, no
sidecar contact, no brain writes.

**Tech Stack:** Python stdlib only (`subprocess`, `json`, `threading`,
`collections.OrderedDict`), unittest (repo convention, `integration.yaml` checks),
ruff select E9/F63/F7/F82/F401. CI matrix unchanged: exactly
`["3.9", "3.13"]` × 3 OS = 6 jobs (`integration.yaml:21`); code is 3.9-syntax
(`from __future__ import annotations`, no `match`).

**Spec:** [`docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-design.md`](../specs/2026-09-30-wisdom-auto-inclusion-design.md)
(review-converged, APPROVE WITH NITS) — the plan argues from the spec; executors read
both. Evidence base: [`../investigations/2026-09-30-wisdom-auto-inclusion-step0-investigation.md`](../investigations/2026-09-30-wisdom-auto-inclusion-step0-investigation.md).
**Review:** Opus plan cycles 1-2 = REQUEST CHANGES → all findings applied this
revision → cycle 3 delta pending. Where the spec still says "INFO log-line
expectations" (§e2e), the PLAN WINS: logging is debug-level
(`wisdom: render …` prefix), per spec's own logging constraint.

**Module contract (single source of truth for the failure classes — Opus plan M1/M2):**
- `discover_ct(env) -> (path | None, failure_class | None)` — `failure_class` is
  `"probe_timeout"` when a candidate's identity probe times out (NOT memoized), `None`
  otherwise; `path=None, class=None` = deterministic discovery miss (memoized).
- `recall_wiki(ct_path, cwd_basename) -> (entries | None, failure_class | None)` —
  `"timeout"` / `"exit"` are NOT memoized; `None, None` with zero entries IS.
- `recall_fn(session_info) -> (block_str, memoize: bool)` — the memo's ONLY signal.
- ONE orchestrator, `_render_wisdom(session_info)`, combines discover → recall →
  render and maps every failure class to `memoize`; it is the sole owner of that
  mapping (tests in Tasks 1-2 verify the parts; Task 4 verifies the mapping).
- `cwd_basename` comes from `session_info["cwd"]` (host fills it via
  `resolve_context_cwd()`, `system_prompt.py:89`) — NEVER `os.getcwd()` (gateway
  sessions would get the host process's cwd). **Owner:** a `query_for(session_info)`
  helper in `ct_wisdom.py` computes the basename AND the degeneracy rules (empty /
  home basename / denylist → seed-only); `recall_wiki` receives the final query term.
  Task 2's golden tests target `query_for`.
- The accepted `ct` path is cached process-wide after a successful probe (machine-
  scoped, like the health cache — bounds worst-case discovery cost; Opus plan m4).

**Sibling references:** `integrations/hermes/__init__.py` (lock pattern to copy,
lines 97-109; registration pattern, 131-139), `scripts/ct_env.py` (discovery pattern),
`scripts/ct_status.py` (fail-open probe pattern).

## Global Constraints

- **Scratch profile ONLY for e2e:** `~/.hermes/profiles/ct-test` (exists). NEVER the
  live default profile — the delivery session runs inside that harness.
- **Read-only brain access:** `ct recall` subprocess only. No SQLite, no `~/.brain`
  writes, no sidecar contact from the new code.
- **Single subprocess contract:** `subprocess.run([…] , stdin=DEVNULL,
  capture_output=True, timeout=N, cwd=<pinned to user home>)`. Never `shell=True`.
  Applies to the identity probe too (`timeout=3`).
- **Failure-class memoization (spec, cycle 3):** memoize zero-hits, discovery miss,
  parse error; do NOT memoize timeouts (recall or probe) or non-zero exits.
- **Sanitization order (spec, cycle 2):** remove `<!-- hermes-plugin-section`
  substrings REPEATEDLY until stable → THEN indent any `## Plugin Context: ` line →
  apply to titles AND text.
- **Memo:** `{session_id → str}`, lock-guarded check / lock-free recall /
  `setdefault` first-writer-wins; LRU bound N=256; empty `session_id` → return `""`
  with NO memo write; empty results memoized (except the failure classes above).
- **Version:** `plugin.yaml` + `integration.yaml` → 0.3.0 in the same PR
  (`version_mirror` keeps lockstep); CHANGELOG entry under Hermes.
- **Windows-safe tests:** behavior tests patch `ct_wisdom.subprocess.run` as the
  PRIMARY pattern; any test needing a real fake-`ct` file on PATH is
  `@skipIf(os.name == "nt")` (applies to ALL tasks, repo precedent
  `test_ct_doctor.py:528`).
- **Each task = RED (failing tests) → GREEN (implement) → repo checks
  (`python -m unittest discover -s tests`, `ruff check --select E9,F63,F7,F82,F401 .`
  within `integrations/hermes/`).**
- **Attribution:** commit style matches repo history.

## Task 1: Discovery + identity probe (`ct_wisdom.discover_ct`)

- [ ] **Step 1.1 (RED):** `integrations/hermes/tests/test_ct_wisdom.py` (copy the
  `sys.path` prepend from `test_ct_doctor.py:27`) — tests for candidate order (which
  → per-OS list per spec OQ2), identity probe accept (patch `subprocess.run` to
  return the verified help string), reject (chart-testing-style help text → try next
  candidate), probe timeout → `(None, "probe_timeout")`, no candidate passes →
  `(None, None)`. **Probe/recall behavior tests patch `ct_wisdom.subprocess.run`**
  (pattern: `test_ct_doctor.py:1454-1473`); any test that needs a real fake-`ct` file
  on PATH is `@skipIf(os.name == "nt")` (repo precedent `test_ct_doctor.py:528`).
- [ ] **Step 1.2 (GREEN):** implement `discover_ct(env=None)` per the module
  contract (tuple return); debug-log accepted/rejected paths; POSIX candidates
  checked with `os.access(X_OK)`, **Windows candidates with `os.path.isfile` only**;
  accepted path cached process-wide.
- [ ] **Step 1.3:** run checks; commit.

## Task 2: Recall wrapper + failure classes (`ct_wisdom.recall_wiki`)

- [ ] **Step 2.1 (RED):** tests with a fake `ct` on PATH: list-argv invocation
  (assert no shell), `stdin=DEVNULL` + `cwd` pinned (monkeypatch `subprocess.run` and
  assert kwargs), JSON parse → `(title, text)` tuples from `wiki` only, `--k 3`,
  query = seed constant + non-degenerate cwd term built from
  `session_info["cwd"]` (golden: degenerate cwd cases → seed-only, byte-stable), and
  the failure-class table: timeout → `(None, "timeout")`, non-zero exit →
  `(None, "exit")`, zero hits → `([], None)` (memoized), parse error → `(None, None)`
  (memoized). (Discovery-miss memoization is owned by the orchestrator — tested in
  Task 4.)
- [ ] **Step 2.2 (GREEN):** implement `recall_wiki(ct_path, cwd_basename)` →
  `(entries | None, failure_class | None)`; failure classes include **`"spawn"`** —
  `OSError` from `subprocess.run` (`FileNotFoundError`, `PermissionError`) — NOT
  memoized. The process-wide accepted-path cache is invalidated on `"spawn"`
  (re-discovery next render, so a reinstalled/`ct`-moved machine recovers) and has a
  test-only reset hook so tests cannot leak an accepted path between them.
- [ ] **Step 2.3:** checks; commit.

## Task 3: Sanitize + render (`ct_wisdom.render_block`)

- [ ] **Step 3.1 (RED):** tests: marker removal repeat-until-stable (splice case
  `<!-- hermes<!-- hermes-plugin-section-plugin-sections:start -->` → clean), indent
  after removal (order), titles AND text sanitized, 2500-char hard cap with
  per-entry truncation — assert `len(out.strip()) <= 2500` (host measures STRIPPED
  text) and each kept entry retains its `**title**` line — empty input → `""`,
  forged-frame restore test: **vendor a pinned copy** of
  `_PLUGIN_SECTION_FRAME_RE` + `PLUGIN_SECTIONS_START/END` + the
  `"\n\nConversation started:"` suffix rule into the test file, header comment
  citing `~/.hermes/hermes-agent/agent/system_prompt.py:34-37,138-163`, **plus a
  pinned copy of `format_system_prompt_sections` and
  `MAX_SYSTEM_PROMPT_SECTION_CHARS` citing
  `~/.hermes/hermes-agent/hermes_cli/plugins.py`** (the restore equality check
  `format_system_prompt_sections(restored) == framed` and the max-chars skip are what
  a forged frame actually breaks; without them the test proves nothing) (CI has no
  Hermes install; importing the host modules there fails all 6 jobs).
- [ ] **Step 3.2 (GREEN):** implement `render_block(entries)`.
- [ ] **Step 3.3:** checks; commit.

## Task 4: Session memo (`ct_wisdom.WisdomMemo`)

- [ ] **Step 4.1 (RED):** tests: same id → byte-identical (callable invoked once,
  recorded via counter), new id → recall again, LRU eviction at N=256, empty
  `session_id` → `""` + no memo write (counter proves no recall), empty result
  memoized, timeout class NOT memoized (second call retries), **discovery-miss
  memoized but probe-timeout NOT (orchestrator mapping, via `recall_fn`'s
  `(block, memoize)` return)**, recall_fn raising → `""` no raise (spec error list),
  memo corruption (poisoned entry) → defensive `""`, concurrent renders for one id
  return identical bytes (threads × barrier), lock pattern (recall outside lock —
  assert via instrumented lock).
- [ ] **Step 4.2 (GREEN):** implement `WisdomMemo` with `render_for(session_info,
  recall_fn)`.
- [ ] **Step 4.3 (RED):** tests for `ct_wisdom._render_wisdom(session_info)` — the
  REAL orchestrator (lives in `ct_wisdom.py`; `__init__.py` only wires it into
  `register_system_prompt_section`) with `discover_ct`/`recall_wiki` patched per
  class: all six classes exercised against the real mapping — discovery miss →
  memoized, probe_timeout → NOT memoized, recall timeout → NOT memoized, exit → NOT
  memoized, parse error → memoized, zero hits → memoized. Debug line asserted with
  `assertLogs(level="DEBUG")`: `wisdom: render session=<id> memo=hit|miss class=<c|ok>`.
- [ ] **Step 4.4 (GREEN):** implement `_render_wisdom` + the debug emit (debug level,
  never INFO — spec constraint).
- [ ] **Step 4.3:** checks; commit.

## Task 5: Wire the section (`__init__.py`)

- [ ] **Step 5.1 (RED):** load `integrations/hermes/__init__.py` via
  `importlib.util.spec_from_file_location("ct_plugin_under_test", <path>)` (the file
  does `Path(__file__)` + `sys.path` mutation; `tests/test_install.py` only greps
  source text and never imports it) — assert `register(ctx)` on a stub context
  registers a second section with id `curated-thoughts-wisdom` and `max_chars=2500`;
  render callable returns `""` (no raise) when `ct` is absent AND when `recall_fn`
  raises; memo is module-level wisdom state (NOT the health cache).
- [ ] **Step 5.2 (GREEN):** add `_wisdom_prompt_section` + registration (guarded by
  `callable(register_section)` like the existing one).
- [ ] **Step 5.3:** full repo checks; commit.

## Task 6: Version, CHANGELOG, README, skills drift

- [ ] **Step 6.1:** bump both manifests to 0.3.0; CHANGELOG entry (feature,
  limitations ×3, no-op behavior).
- [ ] **Step 6.2:** README paragraph + the ONE limitations list (restored-session
  re-render gap incl. in-process `/branch`//`/resume`; legacy-compression rotation;
  memo eviction >256 sessions).
- [ ] **Step 6.3:** skills drift check — grep the three SKILL.md files for
  descriptions of the plugin context; update wording if the new section contradicts.
- [ ] **Step 6.4:** checks; commit.

## Task 7: e2e — scratch profile only

- [ ] **Step 7.1 (cold path FIRST):** measure a true cold recall (embedding backend
  restarted or idle-unloaded) before freezing `timeout=5`; record the number in the
  PR; if > 5 s, bump the constant with the measurement as justification.
- [ ] **Step 7.2:** install the branch payload into `~/.hermes/plugins/` targets of
  the ct-test profile only (or point the profile at the repo checkout); verify with
  the render-path invocation under `HERMES_HOME=~/.hermes/profiles/ct-test` (venv:
  `~/.hermes/hermes-agent/venv/bin/python`): section ids sorted, wisdom block
  present, ≤2500 chars, health section intact.
- [ ] **Step 7.3:** real CLI session in the scratch profile. **What gets counted
  (Opus plan M3 — the host logs NO per-render INFO line):** the plugin emits its own
  debug line `wisdom: render session=<id> memo=hit|miss class=<c|ok>`; run with
  DEBUG logging and grep that prefix. Expectations: exactly 1 with no invalidation
  boundary; after compression — induced by calling
  `agent.invalidate_system_prompt()` directly in the render harness, then rebuilding
  — exactly 1 more, content hash identical; after `/branch` with non-empty history +
  stored prompt: ZERO (restore path), else exactly one.
- [ ] **Step 7.4:** stripped-PATH case: PATH without `~/.local/bin` → candidate
  fallback finds `ct`; wrong-binary case: stub `ct` earlier in PATH → identity probe
  rejects → falls through. **dpkg provenance (spec OQ2):** `dpkg -L <ct-pkg> | grep
  bin/ct` — if the package ships `ct` at a fixed path, add it to the candidates.
- [ ] **Step 7.5:** record all evidence in the PR; commit any fixups.

## Task 8: Convergence

- [ ] **Step 8.1:** push; CI green on the full matrix; CodeRabbit + review bots
  triaged per the dual-review-cycle skill (sor shadow per implementation wave,
  ledger-only).
- [ ] **Step 8.2:** flip spec Status → `Implemented 2026-09-30 (PR #<n>)` after merge
  decision gates pass (every review converged AND e2e evidence recorded); any open
  question → park, never merge past one.

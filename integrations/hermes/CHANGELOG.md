# Changelog — Hermes Agent integration

All notable changes to `integrations/hermes/` are recorded here. This file is
the source of the GitHub Release body for every `hermes-v*` tag, so the heading
format below is load-bearing: `## <version> — <date>`.

## Unreleased

## 0.5.0 — 2026-10-16

- Added: Intuitive Wisdom **autonomous-work delivery**. While the agent works
  on its own between user messages, the file it reads or edits, the command
  it runs or the pattern it searches can bring in one relevant fact
  (new `scripts/ct_wisdom_activity.py`; spec
  `docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md`).
  - Trigger: a new `pre_tool_call` hook starts `ct wisdom match --max 1` in
    the background when the tool's activity is new for the session (a new
    file, command or search), at most once per model step
    (`api_request_id`). No ceiling per user message or per session. CT's own
    tools never trigger it.
  - Query: the bare target only (CT 3.5.1 real-gate results, A6): a relative
    path, a search pattern (none if it holds a credential-shaped word), or
    program plus the word right after it for shell commands (never a flag's
    value or a quoted word; `python -m <module>` sends the module name;
    env assignments, URLs and credential-shaped tokens are dropped). Never file contents, tool output,
    diffs, the agent's text or full command lines.
  - Delivery: `transform_tool_result` of the same call adds at most 1 fact in
    at most 600 characters under `## Curated Thoughts — relevant to this
    step`, marker first. JSON-object results get a `curated_thoughts_wisdom`
    key spliced in (Hermes's own result parsers keep working); plain text
    gets the block appended. The system prompt is never touched.
  - Applies in subagents and scheduled runs; fails closed (no delivery)
    without an in-turn ledger, e.g. a restored session.
  - Budget: the 3 s timeout and the 3-failure / 300 s breaker are shared with
    user-turn delivery; the CT call overlaps the tool's own run.
  - Known limit: concept rules reached only via paths need CT activity mode
    ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)).
    From a bare path the gate reaches facts about that file or command, not
    a concept-level rule the path only implies. No query expansion is added
    here (INTENT rule 8).
- Added: `ct_ledger.LedgerCache.claim()`, an atomic check-and-add used by
  autonomous-work delivery and `ct_tool_dedup`, so parallel tool threads can
  never both show one fact. `ct_tool_dedup`'s output is unchanged.
- Unchanged: user-turn live delivery, the session-start block and the
  system prompt.

## 0.4.3 — 2026-10-16

- Changed: Intuitive Wisdom live delivery has no per-session cap. The
  `LIVE_MAX_PER_SESSION = 12` constant and the switch to `--max 0` once a
  session had received 12 live facts are removed from
  `scripts/ct_wisdom_live.py`; every turn now asks `ct wisdom match --max 2`.
  Why: an autonomous agent is better served by more wisdom than less. The
  cap stopped delivery after about 6 matching turns, though a fact that
  matches late in a session is as valuable as an early one. Noise stays
  bounded per turn (at most 2 facts in a 1200-character block, only facts
  past CT's relevance gate), delivery never touches the system prompt, and
  dedup keeps the session total to the distinct facts that match.
  Unchanged: the per-turn limits, CT's score gate, dedup and exactly-once
  delivery, the breaker, timeouts and the 256-id exclude bound.

## 0.4.2 — 2026-10-16

- Changed: the spawn-time env merge moved from `ct_doctor._merged_env` into
  `ct_env.merged_env(env=None)`, the single source of truth (issue #32).
  Semantics are unchanged: `os.environ` overlaid with `env`; a `None` value
  means "not specified" (ambient shows through); `""` suppresses the ambient
  value. `ct_doctor._merged_env` is now a thin delegate.
- Changed: `ct_status.snapshot(env=...)` (and `context_section(env=...)`)
  now MERGE `env` over `os.environ` instead of replacing the view, matching
  the doctor (issue #32). No shipped caller passes `env`, so live behavior
  is unchanged; an env-passing caller now keeps the ambient HOME/PATH.
- Changed: `ct_doctor.run_checks` accepts an optional `cwd=` (registration
  context, unused by Hermes's check 7), and check 7 is reached through a
  `_check_registration` adapter. Harness-specific doctor code is now
  delimited by `# >>> harness-specific: <name>` markers so the shared-script
  parity gate (`tests/tools/test_shared_script_parity.py`, issue #33) can
  hold the Claude Code copy to the rest verbatim.
- Fixed (packaging): release tarballs no longer pick up `.ruff_cache/` and
  other tool caches — the packager now filters them centrally (issue #33).

## 0.4.1 — YYYY-MM-DD

- Fixed: `scripts/install.sh` honors a pre-set `HERMES_HOME` instead of
  silently resetting it to `~/.hermes`. Profile-scoped installs
  (`HERMES_HOME=~/.hermes/profiles/ct-test bash install.sh`) previously
  overwrote the live default profile's plugin.

## 0.4.0 — YYYY-MM-DD

- Added: relevance-timed mid-session wisdom delivery (Intuitive Wisdom, spec
  2026-10-06-intuitive-wisdom-live-delivery-design.md). A `pre_llm_call` hook
  asks `ct wisdom match` which facts are relevant to the user's message and
  appends new ones to that turn (≤2/turn, ≤1200 chars, ≤12/session;
  corrections for superseded facts always flow). A `transform_tool_result`
  hook stubs `curated_recall_context` wiki entries already in context.
  Exactly-once is enforced by a ledger rebuilt each turn from `ct-fact:<id>`
  markers in the transcript — no plugin persistence. Requires CT ≥ 3.3.0
  (`ct wisdom match`); otherwise a silent no-op. Restored sessions fail closed.
- Changed: the bootstrap wisdom block now tags each fact with its CT id
  (`<!-- ct-fact:<id> -->`) and drops wiki entries without a valid id; the
  sanitizer strips forged `ct-fact:` tokens.

## 0.3.3 — 2026-10-06

- Fixed: the doctor's bundled-fallback spawn gate (issue #28). When a
  caller's env overrides `PATH` but that override fails to resolve the
  sidecar, discovery used to fall back to the ambient install locations and
  the probe then EXECUTED that ambient binary under the caller's env — on a
  test machine, the real installed sidecar ran against the fixture brain
  (the residual risk named in 0.3.1). `run_checks` now detects that
  combination (raw caller env has a `PATH` key; discovery reports the
  bundled source), warns on `sidecar-binary`, refuses to spawn
  (`sidecar-mcp` WARN), and withholds the path from the import-preflight
  engine lookup. A caller that overrides PATH deliberately and accepts the
  ambient install being probed under its env can opt out with
  `CT_DOCTOR_ALLOW_BUNDLED=1` in the env. Callers that do not override
  `PATH` — including the real user with a bundled install and no PATH
  entry — are unaffected.
  Test-suite hardening in the same change: the mock sidecar fixture now has
  an absolute shebang, the shared helpers put ONLY the mock dir on PATH, and
  a `setUp` precondition asserts discovery resolves the mock (realpath
  check), so a broken fixture fails the suite instead of silently probing
  the real binary. `ct_env` gained `SOURCE_PATH`/`SOURCE_BUNDLED`/
  `SOURCE_NONE` constants; the issue #28 resolution rationale is at
  `docs/superpowers/open-questions/2026-10-06-issue28-bundled-fallback-resolution.md`.
- Hardened the gate against the /code-review r4 findings (4 applied):
  the discriminator is now `env.get("PATH") is not None` (not `"PATH" in env`),
  aligning with `_merged_env`'s documented None=ambient semantics — a caller
  that passes `env={"PATH": None}` (per `_merged_env`, "caller did not
  specify") no longer falsely trips the gate; `bool(env)` collapsed to
  `env is not None` to match the gate's own view; `find_sidecar` is now
  called with the raw caller env (its wrapper re-merges), removing one
  redundant dict copy + filter pass per check; and `check_version_compat`
  short-circuits to a single PASS line when gated so a third WARN cannot
  dilute the actionable hint on a PATH-override defect. Pinned by three
  new tests (PATH=None no-gate; gated version-compat stays PASS; caller-env
  `HERMES_CONFIG` cannot override the import-time module constant).

## 0.3.2 — 2026-10-06

- Fixed: the doctor's env-reading checks (`check_brain_dir`,
  `check_vault`, `check_embedding`, `check_import_preflight`) read ambient
  `os.environ` even when the caller passed an `env` — a caller using the
  merged env view got brain directories, embedding-key verdicts, and the
  engine-manifest lookup resolved from a *different* environment than the
  one it asked about (issue #29; follow-up to the #14 fix). Every
  env-reading check now accepts `env` and resolves through the same merged
  view, and `run_checks` threads its merged env into all of them.
  Ambient-only callers (`ct_doctor check`) see no behavior change.
- Changed: the MCP probe's clientInfo version is now derived from
  `plugin.yaml` at call time instead of a hard-coded literal that had
  drifted to 0.2.0; a missing manifest degrades to `0.0.0-unknown` rather
  than crashing. Ambient-only reading of `HERMES_CONFIG` in check 7 is now
  documented as deliberate (the Hermes config is a property of the host
  install, not of the probed environment). (GLM 5.3 independent review of
  this PR, 2026-10-06 — all findings adjudicated, none Critical/Important.)

## 0.3.1 — 2026-10-06

- Fixed: `run_checks` discovered the sidecar from the ambient `os.environ`
  PATH even when callers passed an `env` whose PATH pointed elsewhere — so
  on machines with a real installed sidecar, the real binary was probed (and
  its startup migration ran) against whatever brain the caller's environment
  pointed at, including test fixture brains (issue #14; the read-only and
  self-test failures on sidecar-equipped machines). Discovery, brain-path
  resolution, and the spawn now all use the same merged env view
  (`os.environ` overlaid with the caller's `env`, matching
  `subprocess.run(env=...)`). Regression test: poison sidecar on the ambient
  PATH must never run when an env PATH override is supplied. Residual risk
  (bundled-path fallback reaching a real sidecar when the env-PATH mock is
  absent) is tracked in issue #28.

## 0.3.0 — 2026-09-30

- New system-prompt section `curated-thoughts-wisdom` that recalls the wisdom
  layer at session start and injects a short (max 2500 chars) digest of
  relevant procedures and facts, alongside the existing health section. The
  recall runs through the installed `ct` CLI with a seed query widened by the
  session's working directory; results are memoized per session id (LRU,
  256 sessions) in the `ct_wisdom` module so re-renders within a session are
  byte-identical and free.
- Known v1 limitations: (1) a *restored* session — including an in-process
  `/branch`, and `/resume` after the Hermes process restarted — receives its
  persisted prompt bytes back without a recall and its new id starts with an
  empty memo, so the first compression afterwards re-recalls and the block may
  change; (2) legacy non-in-place compression rotates the session id, which
  can trigger one extra recall after compaction; (3) live sessions beyond the
  256-slot memo window evict each other and re-recall.
- Graceful no-op: when Curated Thoughts is not installed or the brain is
  unreachable, the section silently renders empty — no errors, no prompt
  noise, sessions never block on it.

## 0.2.2 — 2026-09-10

- `import-preflight` no longer counts soft-deleted `llm_wiki_entries` rows as
  live damage. The census is now scoped to rows with `deleted_at IS NULL` when
  that column exists, so retained issue-#186 corpses can no longer flip a
  healthy brain to FAIL. Soft-deleted rows are reported separately in the
  PASS/WARN detail as informational context. On brains with no `deleted_at`
  column the behavior is unchanged.

## 0.2.1 — 2026-09-09

- Clarify the import pre-flight damage detection rule in the ops skill:
  detection applies to non-`NULL` `source_ref` values only, which the
  previous wording did not make explicit.

## 0.2.1-rc.1 — 2026-09-06

- Release rehearsal: exercise the tag-driven release pipeline end to end
  (matrix verification, tarball, SHA256SUMS, prerelease notes). This release
  is deleted after confirmation and carries no functional changes.

## 0.2.0 — 2026-09-06

- Match the Hermes runtime contracts for system-prompt sections and skills.
- Environment contract: resolve the brain via `CURATED_BRAIN_DIR`,
  `CURATED_BRAIN_DB` and `CURATED_BRAIN_CONFIG` only.
- Import pre-flight reporting engine-mangled `source_ref` provenance damage.

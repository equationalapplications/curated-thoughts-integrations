# Changelog — Hermes Agent integration

All notable changes to `integrations/hermes/` are recorded here. This file is
the source of the GitHub Release body for every `hermes-v*` tag, so the heading
format below is load-bearing: `## <version> — <date>`.

## Unreleased

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

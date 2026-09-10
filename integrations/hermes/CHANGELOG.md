# Changelog — Hermes Agent integration

All notable changes to `integrations/hermes/` are recorded here. This file is
the source of the GitHub Release body for every `hermes-v*` tag, so the heading
format below is load-bearing: `## <version> — <date>`.

## Unreleased

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

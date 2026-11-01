# Tag-drift check (warning-only) — design

**Date:** 2026-11-01 · **Status:** Approved (controller) · **Branch:** `chore/tag-drift-check`

## Problem

Four version-bump merges landed on `main` without their release tags between 2026-10-22 and 2026-10-25. The gap was
found only in a release-gap audit, days later. Nothing in CI noticed that a manifest version had no tag.

## Rule

For every integration whose `integration.yaml` has `status: implemented`, warn if and only if the exact tag
`<id>-v<version>` does not exist, where `<version>` is the manifest's `version`. No version ordering is involved: a
newer or older tag never excuses a missing exact one. A manifest version that is not SemVer (checked with the same
`SEMVER_RE` the manifest validator uses) gets a distinct `WARN: <id> version <v> is not SemVer` line and is skipped.

The check is warning-only and always exits 0. Each warning is a GitHub annotation
(`::warning title=tag drift::…`) and, when `GITHUB_STEP_SUMMARY` is set, one line in the job summary.

## Scope

`tools/check_tag_drift.py`, run as a step in `.github/workflows/ci.yml` on pushes to `main`. The step is skipped for
`pull_request` events, because a bump PR is legitimately untagged until it merges. Tests live in
`tests/tools/test_check_tag_drift.py` and stub the tag list rather than needing real git tags.

## Alignment with INTENT.md

- **Rule 4 (failing quietly beats failing the session):** the check only warns and never fails CI or any
  integration's runtime behavior.
- **Rule 6 (keep it small):** one stdlib script plus the repo's existing manifest helpers; no new dependency.
- **No departure from INTENT.md.** It adds no delivery behavior and touches no integration code.

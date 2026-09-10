# CI and releases

## Adding an integration

1. Create `integrations/<id>/` with an `integration.yaml`
   (see `shared/integration.schema.json`).
2. Start it as `status: planned`. Nothing runs against it until it is
   `implemented`.
3. Put its tests inside the integration, at `integrations/<id>/tests/`.
4. No workflow file changes. `discover` finds it from the manifest.

## Running the gates locally

```bash
pip install -r tools/requirements-ci.txt
python tools/ct_ci.py validate
python tools/ct_ci.py generate --check
python tools/ct_ci.py policy --base origin/main
python tools/ct_ci.py discover --all
```

## Releasing

Releases are per-integration and independent. There is no repository version.

1. Bump `version` in `integrations/<id>/integration.yaml` **and** in the
   native manifest named by `version_mirror`.
2. Add a `## <version> — YYYY-MM-DD` section to
   `integrations/<id>/CHANGELOG.md`. It becomes the release body.
3. Run `python tools/ct_ci.py readme` to refresh the integration's row in
   the top-level README's version table (CI's `readme --check` gate fails
   the PR if you skip this).
4. Merge, then tag: `git tag <id>-v<version> && git push origin <id>-v<version>`.
5. `release.yml` re-runs the full matrix, builds
   `<id>-<version>.tar.gz` + `SHA256SUMS`, publishes the GitHub Release,
   and pushes a README sync commit to `main` as a self-heal if the table
   still disagrees with the manifests. A SemVer prerelease suffix marks it
   as a prerelease.

## When a policy gate fails

| Gate | What it means |
|------|---------------|
| `versions` | Shipped code changed without a version bump, the CI and native manifests disagree, or the CHANGELOG has no entry for the new version. Docs and tests are exempt from the bump. |
| `architecture` | A cross-integration import, a non-stdlib import in shipped code, a direct `sqlite3` import (exempt only via a reviewed `policy.allow_sqlite_readonly` entry that still opens with `mode=ro`), a hardcoded absolute path, a `CURATED_*` variable outside the three-variable environment contract. |
| `compat` | `_compat_generated.py` is stale (run `python tools/ct_ci.py generate`), a `compat_tier` does not exist, `requires_sidecar` cannot be satisfied by its tier, or a compat.yaml value was retyped as a literal in integration code. |
| README table | The README's integrations table disagrees with the manifests, or a manifest has no row (run `python tools/ct_ci.py readme`). |

## Branch protection

Require exactly one status check: **`ci-ok`**. It aggregates `discover`,
the `integration` matrix, and `policy`, so the required-check list never has
to change when integrations are added.

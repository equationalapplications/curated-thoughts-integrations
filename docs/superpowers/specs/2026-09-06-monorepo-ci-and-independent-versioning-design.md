# Monorepo CI and Independent Per-Integration Versioning

Date: 2026-09-06
Status: approved design, not yet implemented
Repo: `curated-thoughts-integrations`

## 1. Problem

The repository ships one installable integration per agent harness
(`integrations/hermes/`, with OpenClaw, Claude Code and a future VS Code
Copilot extension planned). Today there is a single `.github/workflows/ci.yml`
hardwired to the Hermes integration: its test paths, its `install.sh`, its
plugin entry point. Three things break as harnesses multiply.

1. **The workflow does not scale.** Every new integration means editing one
   growing YAML file, and every integration's checks run on every change to
   any other.
2. **There is no release story.** `integrations/hermes/plugin.yaml` declares
   `version: 0.2.0`, but nothing publishes it, nothing verifies it was bumped,
   and consumers have no versioned artifact to install.
3. **The architectural rules are enforced by review only.** `CONTRIBUTING.md`
   forbids cross-integration dependencies, third-party dependencies in
   scripts, machine-specific paths, and direct database access. These are the
   rules that keep a brain portable; they currently survive on human
   attention.

## 2. Goals

- Each integration versions and releases **independently**, on its own
  SemVer line.
- Adding a harness means **adding a directory**, never editing a workflow.
- The `CONTRIBUTING.md` architecture rules and the `shared/compat.yaml`
  contract become **automated gates**.
- The design accommodates a **non-Python** integration (TypeScript / VS Code)
  without redesign.

### Non-goals (v1)

- Publishing to VS Code Marketplace, npm, or PyPI. Deferred until an
  integration actually needs it, so the repository carries no publish secrets
  and no irreversible publish jobs before then.
- A repository-level version. There is none, by design.
- Changelog automation via bots (changesets, release-please). The repository
  is Python-first and stdlib-only; a Node bot is not worth the dependency.

## 3. The integration manifest

Every `integrations/<harness>/` gains an `integration.yaml`. It is the **CI
contract** and is deliberately separate from the harness-native manifest
(`plugin.yaml` for Hermes, `package.json` for a VS Code extension), which
remains authoritative for its harness.

```yaml
id: hermes
name: Curated Thoughts for Hermes Agent
version: 0.2.0                       # released version; the tag must match
language: python                     # python | node
status: implemented                  # implemented | planned
requires_sidecar: ">=2.5"
compat_tier: v2.5-full               # must exist in shared/compat.yaml
version_mirror: plugin.yaml#version  # native manifest that must agree
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  python: ["3.9", "3.13"]
checks:
  test: python -m unittest discover -s tests
  lint: ruff check --select E9,F63,F7,F82,F401 .
  shell: [scripts/install.sh]
package:
  include: ["**"]
  exclude: ["**/__pycache__/**", "**/*.pyc"]
```

Field notes:

- `version_mirror` names a native-manifest field that must equal `version`.
  It is `plugin.yaml#version` for Hermes and would be `package.json#version`
  for a VS Code extension. Omitting it is allowed only when the harness has no
  native version field.
- `status: planned` integrations are schema-validated but skipped for tests,
  packaging and release. `integrations/openclaw/` and
  `integrations/claude-code/` get a `planned` manifest as part of this work,
  replacing their `.gitkeep` files.
- `matrix.python` is meaningful only for `language: python`; `language: node`
  uses `matrix.node` instead. The schema enforces the pairing.
- `checks` values are commands run with the integration directory as the
  working directory. `shell` is a list of scripts handed to shellcheck.

The schema lives at `shared/integration.schema.json`, validated by
`tools/ct_ci.py`.

### 3.1 Parsing YAML without shipping a dependency

Manifests and `shared/compat.yaml` stay YAML, because their comments carry the
issue #186 / PR #188 reasoning that makes the compatibility matrix legible.
Two consumers read them, with different constraints:

- **`tools/ct_ci.py`** runs only in CI and never ships, so it may
  `pip install PyYAML` and use a real parser. A hand-rolled mini-YAML loader
  is rejected deliberately: it is a well-known trap whose edge cases would
  surface as a broken doctor on a user's machine.
- **Shipped scripts** (the doctor, hooks, installers) must remain stdlib-only
  per `CONTRIBUTING.md` rule 4. They therefore never parse YAML. They import
  `integrations/<id>/_compat_generated.py` — a plain Python module of
  constants generated from `shared/compat.yaml` by
  `tools/ct_ci.py generate`, carrying a header that names its source and
  forbids hand-editing.

A **generated-files-are-current** gate (§5.3) regenerates the module in CI and
fails if the result differs from what is committed. `shared/compat.yaml`
remains the single source of truth; the generated module is a build product
that happens to be checked in so that a released tarball is self-contained.

## 4. Workflow topology

Two workflows replace the current single `ci.yml`.

### 4.1 `ci.yml`

Jobs:

1. **`discover`** — computes the set of integrations to exercise and emits it
   as a JSON matrix.
   - On `pull_request`: the integrations whose files changed against the merge
     base, **plus all integrations** when any shared path changed
     (`shared/**`, `tools/**`, `.github/workflows/**`, root config).
   - On `push` to `main` and on tags: **all** integrations, unconditionally.
     Path filtering is brittle around shared assets; PRs may be fast, `main`
     must be ground truth.
2. **`integration`** — a matrix job over `discover`'s output crossed with each
   integration's declared `matrix`. Runs that integration's `checks`, then its
   packaging dry run. Skips `status: planned`.
3. **`policy`** — always runs, once, repo-wide. Section 5.
4. **`ci-ok`** — an aggregator that depends on the others and fails if any
   dependency failed or was cancelled (a skipped empty matrix is success).
   Branch protection requires exactly this one check, so adding an integration
   never requires editing protection rules.

`concurrency` cancels superseded runs per ref. `permissions` is
`contents: read`. `actions/checkout` keeps `persist-credentials: false`, for
the reason already documented in the current workflow: repository-controlled
Python executes after checkout.

### 4.2 `release.yml`

Trigger: `on: push: tags: ['*-v*']`.

1. Parse the tag as `<id>-v<semver>`. An unparseable tag, or an `<id>` with no
   `integrations/<id>/integration.yaml`, fails the job.
2. Assert `integration.yaml`'s `version` equals the tag's version, and that
   `version_mirror` agrees.
3. Re-run that integration's full `checks` across its full declared matrix.
   A release never trusts a previous CI run.
4. Build `<id>-<version>.tar.gz` from `package.include`/`exclude`, plus a
   `SHA256SUMS` file.
5. Create a GitHub Release titled `<id> v<x.y.z>`, tagged with the pushed tag,
   with body taken from the matching section of
   `integrations/<id>/CHANGELOG.md`. A SemVer prerelease suffix (`-rc.1`,
   `-beta.2`) marks the Release as a prerelease.

This is the only job granted `contents: write`, and only in that job's
`permissions` block.

Both workflows pin every third-party action by commit SHA with a version
comment.

## 5. Policy gates

Implemented as `tools/ct_ci.py policy`, run as one job producing three
independently-failing groups. Every failure message names the
`CONTRIBUTING.md` rule it enforces and the offending file and line.

### 5.1 Version and manifest hygiene

- Every `integrations/*/` directory has an `integration.yaml` valid against
  the schema.
- `version` is valid SemVer and equals the `version_mirror` field.
- If any file under `integrations/<id>/` changed against the base branch, then
  `version` must be greater than the base branch's value **and**
  `integrations/<id>/CHANGELOG.md` must contain an entry for the new version.
- **Exemption set** — the bump is not required when *every* changed file under
  that integration is documentation (`README.md`, `CHANGELOG.md`, `docs/**`)
  or a test (`tests/**`, `**/test_*.py`, `**/*.test.ts`). Rationale: a release
  exists to change what a user runs, and adding a missing unit test changes
  nothing a user runs; forcing a version bump for it would train maintainers
  to bump reflexively, which is exactly how version numbers stop meaning
  anything. The consequence is accepted explicitly: tests land in the tarball
  at the *next* release rather than immediately, and the exemption is
  all-or-nothing — one shipped-code line in the same change and the bump is
  required again.
- Tags are validated in `release.yml` (§4.2), not here.

### 5.2 Architecture lint

Enforcing `CONTRIBUTING.md` rules 3, 4, and 6:

- No module under `integrations/<a>/` imports from `integrations/<b>/`.
- No non-stdlib imports in integration scripts and hooks. The check works
  from an explicit stdlib allowlist plus intra-integration relative imports;
  anything else fails.
- No direct brain access: `import sqlite3`, `brain.db`, or file writes under a
  vault or brain directory anywhere in `integrations/**`.
- No machine-specific or platform-absolute paths. The check bans `/Users/`,
  `/home/<name>/`, and **any drive-letter path** (`^[A-Za-z]:\\`) — not just
  `C:\Users\`, so a hardcoded `C:\Program Files\...` binary location fails
  too — along with any other absolute path outside a documented default. The
  sole exemption is `tests/fixtures/**`, where fake absolute paths are the
  point; fixtures elsewhere get no pass.
- No environment variable matching `CURATED_*` other than the three contract
  variables `CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`.
  This is what stops the environment contract from silently regrowing
  integration-specific knobs.

### 5.3 Compatibility drift

- `shared/compat.yaml` validates against `shared/compat.schema.json`.
- Every `compat_tier` named by an integration exists under `compat.tiers`.
- Each integration's `requires_sidecar` range intersects its tier's declared
  `sidecar` range.
- **Generated files are current.** CI re-runs `tools/ct_ci.py generate` and
  fails if any `_compat_generated.py` differs from the committed copy, naming
  the command to run. This is what keeps the generated constants honest.
- Integration code **derives** its compatibility values from
  `shared/compat.yaml` (via the generated module) rather than duplicating
  them. The lint fails when tier tool counts (`8`, `14` as capability
  constants), `pinned_version`, `source_ref_shape`, the `librarian_evidence`
  table name, or the `required_tables` list appear as literals anywhere in
  `integrations/**` outside a `_compat_generated.py`. This is the regression
  guard for the "memory in a box" data-safety rules: the compatibility matrix
  stays the single source of truth, and drift between it and the doctor
  becomes impossible rather than merely unlikely.

Where the doctor currently hardcodes such values, this work moves them to the
generated module. That is in scope: it is the change that makes the gate
meaningful.

## 6. Supporting a non-Python harness

`language: node` changes three things and nothing else:

- `checks` values run through the package manager (`npm ci` first, then the
  declared scripts).
- `matrix.node` replaces `matrix.python`.
- The package step produces a `.vsix` via `vsce package` for a VS Code
  extension, attached to the same per-integration GitHub Release as a tarball
  would be.

Registry publishing stays out of scope until the extension exists, at which
point an opt-in `publish:` block in the manifest adds a Marketplace job. The
`.vsix` build infrastructure is designed for now; the irreversible publish and
its secrets are not created now.

## 7. Housekeeping included in this work

- Add `.ruff_cache/` to `.gitignore`.
- Add `windows-latest` to the Hermes matrix. The README claims Windows
  support, and sidecar discovery and path handling are exactly where that
  claim breaks.
- Add `integrations/<id>/CHANGELOG.md` for each integration, seeded with the
  current version.
- Add per-integration CI and release badges to the README integration table.
- Replace the `.gitkeep` files in `openclaw/` and `claude-code/` with
  `status: planned` manifests.

## 8. Testing the CI tooling

`tools/ct_ci.py` is code, and is developed test-first under `tests/`. Fixture
integrations under `tests/fixtures/` cover, at minimum:

- a valid manifest,
- a `version_mirror` mismatch,
- a changed integration with no version bump,
- a changed integration with a bump but no CHANGELOG entry,
- a cross-integration import,
- a third-party import in a script,
- a hardcoded home directory,
- a hardcoded `C:\Program Files\` path,
- a docs-only change with no version bump (must pass),
- a tests-only change with no version bump (must pass),
- a mixed tests-plus-code change with no version bump (must fail),
- a rogue `CURATED_*` environment variable,
- a dangling `compat_tier`,
- a `requires_sidecar` range disjoint from its tier,
- a hardcoded compat.yaml literal,
- a stale `_compat_generated.py`.

Each fixture asserts both that the gate fails and that the message names the
right file. CI that is not tested is CI that quietly stops enforcing.

## 9. Migration

The change lands as a spec PR (this document) followed by implementation PRs,
per `CONTRIBUTING.md` rule 1. Suggested implementation order:

1. `tools/ct_ci.py` with schema validation, the `generate` subcommand, and
   its tests; manifests authored for all three integration directories. No
   workflow change yet.
2. Policy gates (§5), added to the existing `ci.yml` as one job, with the
   doctor's hardcoded compat values moved to the generated module.
3. Workflow split into `discover` / `integration` / `policy` / `ci-ok`; the
   Hermes-specific steps move into its manifest's `checks`.
4. `release.yml`, exercised end to end with a `hermes-v0.2.1-rc.1` prerelease
   tag before any real release.
5. Branch protection switched to require `ci-ok` alone.

## 10. Decisions recorded

| Decision | Choice | Rejected |
|---|---|---|
| Release trigger | Tag-driven, `<id>-v<semver>` | Changesets/release-please bot; manual `workflow_dispatch` |
| Artifacts | GitHub Release + tarball + SHA256SUMS | Registry publishing (deferred); tag-only |
| CI discovery | Manifest-driven with path filtering on PRs | One workflow per integration; monolithic always-run |
| `main`/tags scope | Always run everything | Path filtering everywhere |
| Versioning | Independent SemVer, `requires_sidecar` + `compat_tier` in each manifest | Compat centralised in compat.yaml only; lockstep with core releases |
| YAML parsing | PyYAML in CI tooling; stdlib-only shipped scripts read a generated constants module, freshness-gated | Hand-rolled mini-YAML loader; JSON manifests (loses comments) |
| Policy gates | Version hygiene + architecture lint + compat drift, all three | Minimal gates, human review |

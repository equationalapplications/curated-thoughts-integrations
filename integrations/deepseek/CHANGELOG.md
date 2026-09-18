# Changelog

## Unreleased

## 0.2.2 — 2026-09-18

Fix empty-string fallback in brain-dir resolution. `??` operators in
`cordis.patch.yml` treated an empty `HOME` or `USERPROFILE` as a set value,
producing `/.brain` at the filesystem root. Both environment rows now use
`??` with a literal `~` fallback so the sidecar refuses the path explicitly
rather than silently opening `/.brain`.

## 0.2.1

Restore executable bits on shell scripts; fix empty HOME/USERPROFILE handling in
bundle patch and expandHome; update test to assert actual homedir() fallback.

## 0.2.0 — 2026-09-18

Fixed against DeepSeek Harness 0.1.5-rc.2 (container-verified end to end —
see the e2e harness below). 0.1.2 was never tagged or released because its
plugin could not load on current DSH at all; this release supersedes it, and
0.1.2's census change is included here. Minor bump: the install procedure
changed.

- **Load failure fixed.** The plugin used `ctx.plugin(string, ...)`, which
  cordis rejects (`invalid plugin ... received string`), never declared the
  `inject` services (crash: `cannot get property "systemPrompt" without
  inject`), and passed a non-finite prompt-context order (crash: `prompt
  context "undefined" order must be a finite number`). The MCP client is now
  mounted declaratively via a shipped bundle patch; the plugin declares
  `inject = ['systemPrompt', 'skills']`; the prompt context is registered as
  `{ name, order: 130, text }`.
- **Install rewritten.** The old installer appended blocks to
  `$DSH_HOME/cordis.yml`, which DSH never reads, and DSH ignores bare
  `- name:` rows in patch files — so installing did nothing. The package now
  ships `cordis.patch.yml` declared via package.json `dsh.bundle.patch`, and
  `install.sh --profile <name>` packs the package and installs it with
  `dsh plugin --profile <name> add <tarball>`. `--profile` is required;
  DSH composes per profile and has no global plugin list.
- **Doctor no longer crashes from the release tarball.** `ct_preflight.ts`
  imported `better-sqlite3` statically; the tarball ships no node_modules, so
  `ct_doctor check` died at import. It now loads lazily and degrades the
  census check to WARN, mirroring the OpenCode integration.
- **The doctor's `dsh-registration` check now inspects profile installs.**
  It scanned `$DSH_HOME/cordis.yml`, which DSH never reads, and so failed
  every correct install. It now reports which profiles have the package
  installed — installation being what activates the bundle patch.
- **Brain path handling.** The sidecar does not expand a leading `~`
  (verified: it treats `~/.brain` as a relative path and exits), so the MCP
  row resolves `CURATED_BRAIN_DIR` at composition time (ambient value wins,
  else `$HOME/.brain`), and the plugin expands `~` itself before probing.
- **New e2e harness** (`tests/e2e/`): Docker-based, container-verified
  against DSH 0.1.5-rc.2 (pinned in `tests/host/compatibility.json`), sharing
  its base image with the OpenCode harness.

## 0.1.2 — 2026-09-10

- `import-preflight` no longer counts soft-deleted `llm_wiki_entries` rows as
  live damage. The census is now scoped to rows with `deleted_at IS NULL` when
  that column exists, so retained issue-#186 corpses can no longer flip a
  healthy brain to FAIL. Soft-deleted rows are reported separately in the
  PASS/WARN detail as informational context. On brains with no `deleted_at`
  column the behavior is unchanged.

## 0.1.1 — 2026-09-09

Security: bump devDependencies to clear 9 Dependabot alerts in
`integrations/deepseek/` (vitest 2.1.9 → 4.1.11, vite 5.4.21 → 6.4.3,
esbuild 0.21.5 → 0.25.0). No shipped-code behaviour changes — tests,
build, and typecheck all still pass. See PR #11 for the full advisory
mapping.

## 0.1.0 — 2026-09-09

Initial release. Cordis plugin module wires the Curated Thoughts MCP sidecar,
registers a cache-safe health snapshot, refreshes on `agent/session-start`,
and ships three skills ported from Hermes (`curated-thoughts-usage`,
`curated-thoughts-ops`, `curated-thoughts-sidecar`). Ships a 9-check
`ct_doctor.ts` and an idempotent POSIX `install.sh`.

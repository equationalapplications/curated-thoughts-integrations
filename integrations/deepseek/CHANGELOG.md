# Changelog

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

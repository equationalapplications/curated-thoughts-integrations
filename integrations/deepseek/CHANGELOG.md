# Changelog

## 0.1.0 — 2026-09-09

Initial release. Cordis plugin module wires the Curated Thoughts MCP sidecar,
registers a cache-safe health snapshot, refreshes on `agent/session-start`,
and ships three skills ported from Hermes (`curated-thoughts-usage`,
`curated-thoughts-ops`, `curated-thoughts-sidecar`). Ships a 9-check
`ct_doctor.ts` and an idempotent POSIX `install.sh`.

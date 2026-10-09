# Changelog

## Unreleased

## 0.1.2 — 2026-10-09

Dependency hygiene release: bump the transitive `source-map-js` 1.2.1 → 1.2.2
(Dependabot #11, GHSA-68fv-2mgg-jv7q, development scope only, reached via
`postcss`). Lockfile-only change; no shipped code or behavior is affected.

## 0.1.1 — 2026-10-09

Ships the live-wisdom usage guidance ("Wisdom that arrives on its own") in the
`curated-thoughts-usage` skill, byte-identical to the Hermes integration, so
agents on any harness read the same provenance, `in_context`, and supersession
rules.

## 0.1.0 — 2026-09-18

Initial release. OpenCode plugin wires the Curated Thoughts MCP sidecar,
registers a bounded health snapshot in the system prompt (refreshed once per
session via the `system` transform), and ships three skills ported from Hermes
(`curated-thoughts-usage`, `curated-thoughts-ops`, `curated-thoughts-sidecar`).
Ships a `ct_doctor.ts`, a provenance pre-flight (`ct_preflight.ts`), and a
preview-first POSIX `install.sh` that stages the payload, loader file, skills,
and the `mcp` entry in `opencode.json`. Delivered as a GitHub release tarball
(`opencode-v<version>`); no npm publish.

# Changelog

## Unreleased

## 0.1.0 — 2026-09-18

Initial release. OpenCode plugin wires the Curated Thoughts MCP sidecar,
registers a bounded health snapshot in the system prompt (refreshed once per
session via the `system` transform), and ships three skills ported from Hermes
(`curated-thoughts-usage`, `curated-thoughts-ops`, `curated-thoughts-sidecar`).
Ships a `ct_doctor.ts`, a provenance pre-flight (`ct_preflight.ts`), and a
preview-first POSIX `install.sh` that stages the payload, loader file, skills,
and the `mcp` entry in `opencode.json`. Delivered as a GitHub release tarball
(`opencode-v<version>`); no npm publish.

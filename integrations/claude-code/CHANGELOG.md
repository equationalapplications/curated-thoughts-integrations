# Changelog — Claude Code integration

All notable changes to `integrations/claude-code/` are recorded here. This file
is the source of the GitHub Release body for every `claude-code-v*` tag, so the
heading format below is load-bearing: `## <version> — <date>`.

## Unreleased

## 0.1.0 — 2026-09-11

- Scaffold the Claude Code plugin: `.claude-plugin/plugin.json` (plugin name
  `curated-thoughts`), the `integration.yaml` CI contract with
  `version_mirror: .claude-plugin/plugin.json#version`, and manifest tests that
  keep the two from drifting.
- Add the shared stdlib-only scripts, copied from `integrations/hermes/` and
  kept logically identical: `ct_env.py` (brain/vault/sidecar resolution),
  `ct_status.py` (session-start snapshot) and `ct_preflight.py` (read-only
  import pre-flight census). `status` flips to `implemented`, so the
  integration now generates `scripts/_compat_generated.py` from
  `shared/compat.yaml` and appears as implemented in the README table.

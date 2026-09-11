# Changelog — Claude Code integration

All notable changes to `integrations/claude-code/` are recorded here. This file
is the source of the GitHub Release body for every `claude-code-v*` tag, so the
heading format below is load-bearing: `## <version> — <date>`.

## Unreleased

## 0.1.0 — 2026-09-11

- Scaffold the Claude Code plugin: `.claude-plugin/plugin.json` (plugin name
  `curated-thoughts`), the `integration.yaml` CI contract with
  `version_mirror: .claude-plugin/plugin.json#version`, and manifest tests that
  keep the two from drifting. `status` stays `planned` until the shipped
  scripts, hook and skills land.

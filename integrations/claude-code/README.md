# Curated Thoughts for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin that connects the
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar (`curated-thoughts-mcp --mcp`) to Claude Code sessions. Sibling
to the [Hermes integration](../hermes/) — same skills, same doctor, same
three-rule discipline, re-shaped around Claude Code's plugin directory,
`SessionStart` hook and `claude mcp add` registration.

> **Status: under construction.** This directory currently holds the plugin
> manifest and CI contract only; `integration.yaml` is still `status: planned`,
> so CI schema-validates it but runs no test matrix for it yet. The scripts,
> hook and skills land in the tasks that follow — see the
> [implementation plan](../../docs/superpowers/plans/2026-09-11-claude-code-integration.md)
> and the
> [design spec](../../docs/superpowers/specs/2026-09-11-claude-code-integration-design.md).

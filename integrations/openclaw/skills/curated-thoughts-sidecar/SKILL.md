---
name: curated-thoughts-sidecar
description: Use when managing the Curated Thoughts MCP sidecar — respawns, staleness, upgrades, or same-named binary confusion.
---

# Curated Thoughts Sidecar Lifecycle

Operate the `curated-thoughts-mcp` sidecar process — the MCP server that
stands between an agent harness and the Curated Thoughts (CT) brain.

## What the sidecar is

A small local server process the harness launches as an MCP server. It owns
all reads and writes to the brain (vault notes, wisdom, embeddings). The
harness daemon does not talk to the brain directly; it talks to the sidecar.
One sidecar per brain — two servers pointed at the same brain is a bug.

## Lazy respawn

The sidecar is spawned lazily: if it is not running, the harness daemon starts
it on the **next MCP tool call**. There is no idle keeper process to babysit.

- **Killing a stale or wedged sidecar is safe.** It holds no state that isn't
  recoverable; the daemon simply respawns a fresh one on the next call.
- Procedure: kill the sidecar process, then make a trivial MCP call
  (e.g. `tools/list`) to confirm it came back and reports the expected tool
  count. This kill-then-probe is also the right step after upgrading the
  package, so a new binary replaces the old process.
- If a probe does not respawn the sidecar, the problem is registration or the
  binary itself — run the doctor (see the curated-thoughts-ops skill), don't
  restart the daemon first.

## Version upgrades

- Sidecars ship through the CT release channel (e.g. a `.deb` package).
  After installing a new version, kill any running sidecar so the next MCP
  call spawns the upgraded binary — otherwise the old process keeps serving.
- Confirm the new tool count after respawn. Fewer than the full write surface
  (`curated_add_wisdom` / `curated_update_wisdom` / `curated_archive_wisdom`
  present) means the tier changed; check `shared/compat.yaml` for what that
  version should expose.

## The two same-named-binaries trap

Two different builds can both be named `curated-thoughts-mcp`:

- the **main sidecar** installed by the release package (standard location,
  e.g. `/usr/bin/curated-thoughts-mcp`), and
- a **tools-crate build** produced by compiling the development tools crate —
  same executable name, different program.

Pointing the harness at the tools-crate build (or having both registered)
gives two servers on one brain and confusing tool lists. **Disambiguate by
path, never by name**: check which binary the harness config actually
launches, and verify it resolves to the packaged location
(`/usr/bin/...`), not a repo build output directory. If both exist, the
registered one must be the packaged main sidecar.

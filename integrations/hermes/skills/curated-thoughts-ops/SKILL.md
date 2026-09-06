---
name: curated-thoughts-ops
description: Use when Curated Thoughts looks broken — sidecar unreachable, vault errors, tier mismatches, or failed MCP tool calls.
---

# Curated Thoughts Operations

Diagnose and report problems with a Curated Thoughts (CT) integration — for
maintainers and power users. Scope is diagnosis and safe routing, never repair
by out-of-band writes.

## First move: run the doctor

Run the plugin's `ct_doctor.py` before guessing. It reports PASS / WARN / FAIL
per check, each with a fix hint:

1. **Sidecar binary** — `curated-thoughts-mcp` on PATH, and it is the MAIN
   sidecar, not a same-named tools-crate build (two servers on one brain is a
   bug). FAIL here invalidates everything downstream.
2. **Sidecar reachable** — `tools/list` over MCP; prints the tool count.
   WARN below 14 tools means the write path is dormant
   (`curated_add_wisdom` absent) — capability tier, not breakage.
3. **Vault path configured and exists** — the configured brain directory is
   present.
4. **Vault readable** — read-only probe succeeds. Any write during diagnosis
   is forbidden.
5. **Embedding backend** — the configured embedding host responds. WARN/FAIL
   degrades semantic search but the sidecar may still answer.
6. **Harness registration** — plugin dir listed under `plugins:` in the
   harness config, and the `mcp_servers.curated-thoughts` block present with
   `--mcp` args.
7. **OKF hygiene** — doc-level pointer on If-Match `updated_at` semantics for
   wisdom updates; no write test is performed.
8. **Version compat** — sidecar version against `shared/compat.yaml`
   (sidecar ↔ plugin ↔ tool-count tiers).

Exit code 0 = all PASS/WARN; nonzero = there are FAILs.

## Registration in Hermes

The MCP server is registered in `~/.hermes/config.yaml` under
`mcp_servers.curated-thoughts` with `--mcp` arguments, and the plugin
directory is listed under `plugins:`. The installer merges this block only if
absent — it never overwrites an existing entry. If both a plugin copy and a
loose `~/.hermes/skills/curated-thoughts*` skill exist, remove the loose copy
to avoid skill collisions (the installer warns; it never deletes user files).

## Safe routing when things fail

- **Report, don't improvise.** Capture the exact tool error, the doctor check
  that failed, and the tool count. Sidecar errors mean route around: use
  non-CT sources for this session and surface the error to the user.
- **Never write out-of-band.** Fixing a vault problem by hand-editing files or
  opening the database directly corrupts indexing and embeddings. The sidecar
  is the only writer, always.
- **Tier mismatch ≠ failure.** A WARN on tool count just means the sidecar
  version predates the write path; read tools still work. Check
  `shared/compat.yaml` for the expected surface at that version.
- **Fail open.** A down sidecar must not block a session; state it plainly and
  continue without CT memory.

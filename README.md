# curated-thoughts-integrations

Open-source integrations connecting [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
to AI agent harnesses. One installable integration per harness, sharing a
common architecture.

## Integrations

| Harness | Directory | Status |
|---------|-----------|--------|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [`integrations/hermes/`](integrations/hermes/) | v0.2 — implemented |
| OpenClaw | `integrations/openclaw/` | planned |
| Claude Code | `integrations/claude-code/` | planned |

## What an integration provides

Each integration ships the same three layers, adapted to its harness:

1. **Registration** — wires the Curated Thoughts MCP sidecar
   (`curated-thoughts-mcp --mcp`) into the harness's MCP configuration.
2. **Health checks** — an install/doctor script that verifies the sidecar
   binary, brain directory, vault, embedding backend, and registration, with
   actionable fix hints. Fails loudly before users get frustrated.
3. **Import pre-flight** — before an agent trusts an imported brain, the
   doctor reads the engine version and censuses the knowledge graph for
   provenance damage. See "Memory in a box" below.
4. **Skills** — harness-native skill files teaching the agent how to use
   Curated Thoughts correctly: tool routing, write paths (vault notes vs
   wisdom entries), and OKF frontmatter hygiene.

## The environment contract

Every integration resolves the brain the way Curated Thoughts does — there are
no integration-specific variables:

| Variable | Meaning |
|----------|---------|
| `CURATED_BRAIN_DIR` | Brain home (holds `brain.db` + `config.json`). Default `~/.brain`. |
| `CURATED_BRAIN_DB` | Explicit database path. |
| `CURATED_BRAIN_CONFIG` | Explicit `config.json` path. |

**The brain directory is not the vault.** The brain dir holds the database and
config; the *vault* is the documents tree, and its path lives inside
`config.json` as `vault_path`. That path is absolute and machine-specific,
which is why it is the first thing to break after an import.

## Memory in a box

A Curated Thoughts brain is meant to be exported from one machine and imported
into another harness — Hermes here, Claude Code and OpenClaw next — and keep
working. Two hazards make that non-trivial, and the doctor's import pre-flight
reports both:

- **The engine can destroy provenance.** core-llm-wiki's `setup()` rewrites any
  `source_ref` containing punctuation, which includes every structured evidence
  blob. It fires on every desktop-app launch over the shared `brain.db`
  (curated-thoughts issue #186, PR #188). An imported brain brings that
  exposure with it.
- **A partial export is worse than an incomplete one.** Entries whose chunk
  anchors did not travel look like orphans, and the PR #188 repair migration
  deletes orphans. `shared/compat.yaml` lists the tables that must travel
  together.

## The three rules every integration encodes

- **One sidecar only.** Attach only to the installed main sidecar. Two MCP
  servers on one brain is a bug.
- **Never touch the vault out-of-band.** No direct SQLite, no hand-editing
  `~/.brain`. All access goes through the sidecar's MCP tools.
- **Fail open, diagnose early.** A down sidecar must never block an agent
  session — but the doctor should catch it before the session starts.

## License

MIT — identical to the main Curated Thoughts repository.

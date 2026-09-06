# curated-thoughts-integrations

Open-source integrations connecting [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
to AI agent harnesses. One installable integration per harness, sharing a
common architecture.

## Integrations

| Harness | Directory | Status |
|---------|-----------|--------|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [`integrations/hermes/`](integrations/hermes/) | v0 — spec in review |
| OpenClaw | `integrations/openclaw/` | planned |
| Claude Code | `integrations/claude-code/` | planned |

## What an integration provides

Each integration ships the same three layers, adapted to its harness:

1. **Registration** — wires the Curated Thoughts MCP sidecar
   (`curated-thoughts-mcp --mcp`) into the harness's MCP configuration.
2. **Health checks** — an install/doctor script that verifies the sidecar
   binary, vault path, embedding backend, and registration, with actionable
   fix hints. Fails loudly before users get frustrated.
3. **Skills** — harness-native skill files teaching the agent how to use
   Curated Thoughts correctly: tool routing, write paths (vault notes vs
   wisdom entries), and OKF frontmatter hygiene.

## The three rules every integration encodes

- **One sidecar only.** Attach only to the installed main sidecar. Two MCP
  servers on one brain is a bug.
- **Never touch the vault out-of-band.** No direct SQLite, no hand-editing
  `~/.brain`. All access goes through the sidecar's MCP tools.
- **Fail open, diagnose early.** A down sidecar must never block an agent
  session — but the doctor should catch it before the session starts.

## License

MIT — identical to the main Curated Thoughts repository.

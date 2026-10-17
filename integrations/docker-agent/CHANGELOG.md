# Changelog — Curated Thoughts for Docker Agent

All notable changes to this integration. Versions follow SemVer; tags are
`docker-agent-v<version>`.

## Unreleased

## 0.1.0 — 2026-10-16

First release, for Docker Agent v1.150.0 (`docker agent run`). Spec:
`docs/superpowers/specs/2026-10-16-docker-agent-integration-design.md`.

- **Installer** (`scripts/install.sh`): writes one hooks.d drop-in,
  `~/.config/cagent/hooks.d/50-curated-thoughts.yaml` (honours
  `DOCKER_AGENT_CONFIG_DIR` / `CAGENT_CONFIG_DIR`), with absolute paths,
  `on_error: ignore` and `|| exit 0` on every hook. It never edits agent
  files; it prints the MCP toolset snippet, with an `env:` block that names
  (never copies) the keys the brain's embedder needs. `--uninstall` removes
  the drop-in, `--print-only` writes nothing.
- **Intuitive Wisdom, all three steps:**
  - session start: the bootstrap block, inserted by `before_llm_call` at a
    fixed position with identical bytes on every model call, from the first
    call of every session, helpers included;
  - each user message: matched at `user_prompt_submit`, delivered in the
    turn's first eligible tool result (a turn without a tool call gets
    none). Opt-in `CT_WISDOM_DA_LIVE=prompt` delivers with the message, for
    Anthropic models with `cache_preserving_updates`;
  - autonomous work: one fact per model step on a new file, command or
    search, in that tool's result (the Hermes rules, privacy amendment
    included).
- At most once: a per-session store, a first-call scan of unseen sessions
  (branches, pre-install resumes), a file lock for parallel tool calls,
  write-before-emit, marker-first blocks. Agent CT recalls get "already in
  context" stubs.
- Silent no-op in sandbox, cloud, ACP/editor and API-server modes.
- Verbose mode (`CT_WISDOM_VERBOSE=1`): a warning line per decision and a
  JSONL log in Docker Agent's data dir.
- Doctor check 7 inspects the drop-in.

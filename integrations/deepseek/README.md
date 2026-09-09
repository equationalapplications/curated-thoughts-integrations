# Curated Thoughts for DeepSeek Harness

A Cordis plugin module that connects DeepSeek Harness (`pnpm dsh`) to the
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar. Sibling to the
[Hermes integration](../hermes/) — same skills, same doctor, same three-rule
discipline.

## What you get

- **MCP sidecar wired in** — `@deepseek-ai/dsh-curated-thoughts` mounts
  `@deepseek-ai/dsh-mcp-client` against `curated-thoughts-mcp --mcp` and
  exposes the Curated Thoughts tool surface to dsh sessions.
- **Cached health snapshot** — a `PromptContext` whose text is the latest
  `ct_status` probe, refreshed on every `agent/session-start`. The model
  knows whether memory is usable before its first tool call.
- **Three skills** — `curated-thoughts-usage`, `curated-thoughts-ops`,
  `curated-thoughts-sidecar` (verbatim from Hermes).
- **Doctor** — `ct_doctor.ts check` runs the nine deep checks
  (sidecar binary / identity / MCP reachable / brain / vault / embedding
  backend / dsh registration / import pre-flight / version compat).
- **Idempotent installer** — `scripts/install.sh`.

## Install

```bash
cd integrations/deepseek
pnpm install
pnpm run build
CT_INSTALL_EDIT=1 ./scripts/install.sh
```

Without `CT_INSTALL_EDIT=1`, the installer prints the block to append to
`$DSH_HOME/cordis.yml` and does not write anything.

## Verify

```bash
node lib/ct_doctor.js check
node lib/ct_doctor.js check --json   # machine-readable
```

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **DeepSeek Harness:** ≥ 0.1 (Cordis plugin model; requires Node ≥ 22.19
  or ≥ 24).
- **Platforms:** macOS, Linux, Windows (verified by the CI matrix).

## License

MIT — identical to the main Curated Thoughts repository.

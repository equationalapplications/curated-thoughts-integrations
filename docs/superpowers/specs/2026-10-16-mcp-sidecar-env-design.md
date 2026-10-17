# MCP sidecar environment pass-through (bug fix)

Date: 2026-10-16. Status: implemented in hermes 0.6.1, claude-code 0.3.2,
openclaw 0.2.1, deepseek 0.5.1 (README note only for opencode).

## Problem

The hermes 0.6.0 live e2e needed `mcp_servers.curated-thoughts.env:
{OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}"}` before recall and wisdom
matching worked. A brain whose `embed_profile` is external reads its key
from the sidecar's environment, and most hosts filter that environment.
When the key is dropped, the sidecar cannot embed, and nothing reports an
error. A brain location set through `CURATED_BRAIN_DIR` (or `_DB`,
`_CONFIG`) can be dropped the same way, and the sidecar then opens
`~/.brain`.

## Verified host behavior

[V] = read in the host source at its pin. [U] = not verified.

- Hermes `ee8dd6c8` (`tools/mcp_tool_config.py`): `_build_safe_env` passes
  `PATH HOME USER LANG LC_ALL TERM SHELL TMPDIR`, `XDG_*`, a few Windows
  location vars, names injected by an external secret source, and
  `HERMES_KANBAN_*`, then overlays the entry's `env:` [V]. `${VAR}` and
  `${env:VAR}` in `mcp_servers` are interpolated after `~/.hermes/.env` is
  loaded; there is no default syntax, and an unset var keeps the literal
  `${VAR}` text [V].
- Claude Code 2.1.301 (the shipped binary): the stdio branch starts from the
  full process env, or from the MCP SDK default list plus an allowlist when
  `CLAUDE_CODE_MCP_ALLOWLIST_ENV` is truthy (or the entrypoint is
  `local-agent`), then overlays the entry's `env` [V]. Its docs describe
  `${VAR}` and `${VAR:-default}` expansion [V].
- DeepSeek Harness 0.2.0-rc.2: `dsh-mcp-client` spawns with
  `scrubbedParentEnv()`, which drops every name matching
  `/KEY|PASSWORD|SECRET|TOKEN/i` and `DSH_*`, then overlays `config.env` [V].
- OpenCode 1.18.35 (`packages/opencode/src/mcp/index.ts`):
  `{...process.env, ...mcp.environment}` [V]. No bug.
- OpenClaw 2026.10.3: a plugin-manifest stdio server gets the MCP SDK
  1.31.0 `getDefaultEnvironment()` (`HOME LOGNAME PATH SHELL TERM USER`) plus
  its `env` [V]. The manifest supports only plugin placeholders, not `${ENV}`
  [V]. A user `mcp.servers.<name>` row replaces the manifest row by name, and
  OpenClaw substitutes `${VAR}` in config strings, leaving a missing one
  unresolved [V].
- Curated Thoughts (`src-tauri/src/embedder/mod.rs`): the external key comes
  from the profile's `api_key`, else `EMBED_API_KEY`, else
  `OPENROUTER_API_KEY` when `base_url` contains `openrouter` (the default
  base), else `OPENAI_API_KEY`. A blank value counts as unset at each step
  [V]. The local profile reads `OLLAMA_HOST` [V].

## Decisions

- D1. One derivation, `ct_env.sidecar_env_needs(config, env)` (Python, shared
  by Hermes and Claude Code) and `sidecarEnvNeeds` (OpenClaw). It returns the
  names the sidecar needs: the external key (EMBED_API_KEY when set, else the
  provider default, with both accepted as satisfying), `OLLAMA_HOST` when
  local and not the default, and any brain-location var that moves the brain
  off the default layout.
- D2. Secrets are forwarded by name only (`${NAME}`). Brain paths are not
  secrets and the sidecar does not expand `~`, so they are written as
  absolute paths.
- D3. Never emit a reference to a name the brain does not use. Hermes and
  OpenClaw pass an unset `${NAME}` as literal text, which CT would send as
  the key. So the Hermes installer emits only the derived name. When it
  cannot derive one (no python3, unreadable config, local embedder), it
  prints a commented example instead.
- D4. DeepSeek forwards all three key names as
  `!!js process.env.NAME ?? ''`. Empty is "unset" to CT, so forwarding an
  unused name is harmless, and the static patch needs no brain read.
- D5. Doctor check `sidecar-env`, after `embedding-backend`. It is shared
  code in `ct_doctor.py`. Host routing comes from two hooks in the existing
  `registration-check` harness region, `_sidecar_env_route()` and
  `_sidecar_env_fix()`, so the parity gate's region list is unchanged.
  The check gives PASS when nothing is needed or everything is forwarded and
  set. It gives WARN with the exact config lines when a name is not
  forwarded, or when it is forwarded but set nowhere the host reads (for
  Hermes, the environment or `~/.hermes/.env`). It is read-only and prints
  names, never values.
- D6. OpenClaw gets the same check in `ct_doctor.ts`, plus an installer note.
  The installer does not write the `mcp.servers` row: the row replaces the
  plugin's own, and the user owns `openclaw.json`.

## Alignment with INTENT.md

- **Rule 4 (Failing quietly beats failing the session):** the bug was a
  silent failure inside the sidecar. The fix keeps sessions untouched and
  moves the diagnosis into the doctor and installer, which are offline
  tools.
- **Rule 7 (Integrations only read):** the installer and doctor read
  `config.json` read-only, as the doctor already did for `vault_path`. They
  never open the database or write the brain. Host configs are written only
  by the existing opt-in `CT_INSTALL_EDIT=1` append, and an existing entry is
  never modified.
- **Rule 8 (Relevance is CT's job):** unchanged. This only lets CT's own
  embedder run.
- No departure from INTENT.md.

# Curated Thoughts for OpenCode

An [OpenCode](https://opencode.ai) plugin that connects OpenCode sessions to
the [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar. Sibling to the
[Hermes](../hermes/) and [DeepSeek](../deepseek/) integrations — same skills,
same doctor, same three-rule discipline.

## What you get

- **MCP sidecar wired in** — a `mcp` entry in `opencode.json` runs
  `curated-thoughts-mcp --mcp`, and a loader plugin
  (`~/.config/opencode/plugins/curated-thoughts.js`) injects a health/status
  block into every session's system prompt.
- **Bounded health refresh** — the status block reflects the last probe, and
  refresh logic never blocks or reconnects at runtime.
- **Three skills** — `curated-thoughts-usage`, `curated-thoughts-ops`,
  `curated-thoughts-sidecar` (ported from Hermes).
- **Doctor** — `node lib/scripts/ct_doctor.js check` reads configuration and
  diagnoses the sidecar, brain, vault, and OpenCode registration. The doctor
  never boots OpenCode; its check 3 is the only component that handshakes the
  sidecar.
- **Provenance pre-flight** — an optional `better-sqlite3`-backed check that
  classifies brain/provenance health with the same logic as the other
  integrations' `ct_preflight`.
- **Preview-first installer** — `scripts/install.sh` prints a structured
  proposal and writes nothing until you set `CT_INSTALL_EDIT=1`.

## Install

Download the `opencode-v<version>` release tarball from the Curated Thoughts
Integrations releases page, unpack it, and run:

```bash
./scripts/install.sh                    # preview — nothing is written
CT_INSTALL_EDIT=1 ./scripts/install.sh  # apply
```

The package is **not published to npm**; there is nothing to `npm install`.
The installer touches exactly:

- the payload directory under your data home
  (`$XDG_DATA_HOME/curated-thoughts/opencode/`, default
  `~/.local/share/curated-thoughts/opencode/`),
- `~/.config/opencode/plugins/curated-thoughts.js` (the loader file),
- `~/.config/opencode/skills/curated-thoughts-*/` (three skills, as files),
- the `curated-thoughts` `mcp` entry in `opencode.json` (JSONC comments are
  preserved; a competing `.json` file is never written beside a `.jsonc`).

Skills are installed as files — OpenCode discovers them from the `skills/`
directory; nothing registers them at runtime.

## Verify

```bash
node <payload>/lib/scripts/ct_doctor.js check
node <payload>/lib/scripts/ct_doctor.js check --json   # machine-readable
```

The pre-flight check degrades gracefully when the optional `better-sqlite3`
dependency is absent — every other check is dependency-free (the plugin
runtime has zero third-party imports).

## Uninstall

Remove the loader file (`~/.config/opencode/plugins/curated-thoughts.js`),
the payload directory, the `curated-thoughts` `mcp` entry from
`opencode.json`, and `~/.config/opencode/skills/curated-thoughts-*`.

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **Platforms:** macOS, Linux, Windows (covered by the CI matrix).
- **Tested host versions** (from `tests/host/compatibility.json`,
  verified 2026-09-17 on darwin-x64; Linux/Windows are covered by the CI
  host job, not re-executed locally):
  - OpenCode `1.18.31` (npm package `opencode-ai@1.18.31`)
  - `@opencode-ai/plugin` `1.18.31`
  - `bun` `1.4.2` (test runner); host-embedded runtime as seen by the
    plugin: bun `1.3.14` / node `24.3.0`
  - Node fallback `22.23.2`

## Requirements

- OpenCode (host contract verified against the versions in
  `tests/host/compatibility.json`)
- A POSIX shell for the installer: on Windows, run `scripts/install.sh` from
  Git Bash or WSL (PowerShell and Command Prompt cannot run it directly)
- Optional: `better-sqlite3`, for the doctor's import pre-flight check

## License

MIT — identical to the main Curated Thoughts repository. OpenCode is a
third-party project; this integration is not affiliated with, endorsed by,
or produced by the OpenCode authors.

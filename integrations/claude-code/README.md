# Curated Thoughts for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin that connects the
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar (`curated-thoughts-mcp --mcp`) to Claude Code sessions. Sibling
to the [Hermes integration](../hermes/) — same skills, same doctor, same
three-rule discipline, re-shaped around Claude Code's plugin directory,
`SessionStart` hook and `claude mcp add` registration.

## What you get

- **A plugin directory** — `.claude-plugin/plugin.json` names the plugin
  `curated-thoughts`. Load it in place with `claude --plugin-dir` today; a
  marketplace listing follows once it has been dogfooded.
- **MCP sidecar wired in** — `scripts/install.sh` resolves the sidecar by
  absolute path and registers it at user scope through
  `claude mcp add --scope user curated-thoughts -- "<path>" --mcp`. It is a
  path, not a bare name, because on Windows the sidecar is not on `PATH`.
- **Session-start health snapshot** — `hooks/hooks.json` runs
  `hooks/session-start.py` on `startup|resume|clear|compact` and injects a
  `## Curated Thoughts` block as `additionalContext`, so the model knows
  whether memory is usable before its first tool call. Fast, read-only,
  always exits 0.
- **Three skills** — `/curated-thoughts:usage`, `/curated-thoughts:ops`,
  `/curated-thoughts:sidecar` (bodies verbatim from Hermes).
- **Doctor** — `python3 scripts/ct_doctor.py check` runs the nine deep checks
  (sidecar binary / identity / MCP reachable / brain / vault / embedding
  backend / Claude Code registration / import pre-flight / version compat).
  `--json` for machine-readable output, `--self-test` for the embedded
  mock-sidecar suite. Exit codes: `0` all PASS, `1` any FAIL, `2` WARN only.
- **Idempotent installer** — `scripts/install.sh`. Prints by default, writes
  only when asked, never overwrites an existing entry.

## Install

```bash
cd integrations/claude-code
./scripts/install.sh                    # prints the registration; writes nothing
CT_INSTALL_EDIT=1 ./scripts/install.sh  # runs `claude mcp add` for you
```

The default run prints the `claude mcp add` command, the equivalent JSON
block for `~/.claude.json` (user scope) or a project `.mcp.json`, and the
`claude --plugin-dir` line. It does not touch any file.

With `CT_INSTALL_EDIT=1` the installer shells out to the `claude` CLI: it
probes `claude mcp get curated-thoughts` and registers only when no entry
exists. It never edits `~/.claude.json` itself, and a second run reports
"already registered — nothing changed". Set `CLAUDE_CT_SIDECAR` to an
absolute sidecar path to skip the installer's discovery. (The doctor has no
such override; it finds the sidecar on `PATH` or in the platform install
locations.)

Registration gives you the MCP tools. The plugin adds the skills and the
session-start snapshot — load it for a session with:

```bash
claude --plugin-dir "$(pwd)"
```

**Windows.** The 2.10.1 installer places the sidecar at
`%LOCALAPPDATA%\Curated Thoughts\curated-thoughts-mcp.exe`. The path contains
a space; every place this integration prints or registers it is
double-quoted, and you should keep the quotes if you paste the command by
hand. The hook command and `install.sh` run under Git Bash on Windows; if
only `python` (not `python3`) is on your `PATH`, the hook's built-in fallback
covers it, but run the doctor as `python scripts/ct_doctor.py check`.

## Verify

```bash
python3 scripts/ct_doctor.py check
python3 scripts/ct_doctor.py check --json   # machine-readable
claude mcp list                             # curated-thoughts should report connected
```

Then, inside a session started with `--plugin-dir`:

- `/mcp` — the `curated-thoughts` server is connected and lists its tools.
- `/hooks` — the `SessionStart` hook is registered.
- `/plugin` — the `curated-thoughts` plugin is loaded.

Doctor check 7 reports plugin enablement from `~/.claude/settings.json` as
a WARN, never a FAIL: a `--plugin-dir` session leaves nothing on disk for it
to confirm.

## Environment contract

The integration resolves the brain exactly the way Curated Thoughts does, and
reads no variables of its own:

| Variable | Meaning |
|----------|---------|
| `CURATED_BRAIN_DIR` | Brain home (holds `brain.db` + `config.json`). Default `~/.brain`. |
| `CURATED_BRAIN_DB` | Explicit database path. |
| `CURATED_BRAIN_CONFIG` | Explicit `config.json` path. |

**The brain directory is not the vault.** The brain dir holds the database
and config; the vault is the documents tree, and its path lives inside
`config.json` as `vault_path`. All reads and writes go through the sidecar's
MCP tools — nothing here opens the database directly except the read-only
import pre-flight.

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **Claude Code:** 2.1.x plugin format (`.claude-plugin/plugin.json`,
  `hooks/hooks.json`, `skills/<name>/SKILL.md`).
- **Platforms:** macOS, Linux, Windows (verified by the CI matrix on
  Python 3.9 and 3.13).

## License

MIT — identical to the main Curated Thoughts repository.

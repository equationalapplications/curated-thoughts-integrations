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
  `hooks/session-start.py` on `startup|resume|clear|compact|fork` and injects a
  `## Curated Thoughts` block as `additionalContext`, so the model knows
  whether memory is usable before its first tool call. Fast, read-only,
  always exits 0.
- **Intuitive Wisdom** — the curated fact arrives when it is relevant, and
  only once. See [Intuitive Wisdom](#intuitive-wisdom) below.
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
- `/hooks` — the `SessionStart`, `UserPromptSubmit` and `PostToolUse` hooks are registered.
- `/plugin` — the `curated-thoughts` plugin is loaded.

Doctor check 7 reports plugin enablement from `~/.claude/settings.json` as
a WARN, never a FAIL: a `--plugin-dir` session leaves nothing on disk for it
to confirm.

## Intuitive Wisdom

The same algorithm as the Hermes plugin, which it runs from byte-identical
copies of the Hermes core (`scripts/ct_wisdom_live.py`, `ct_wisdom.py`,
`ct_ledger.py`). Curated Thoughts owns relevance: the plugin asks
`ct wisdom match` and never scores or ranks anything itself.

| Hook | What it does |
|------|--------------|
| `SessionStart` | Appends a `## Curated Thoughts — relevant memory` block (top 3 wiki entries for the project) after the status section, and records its fact ids in the plugin's data dir. |
| `UserPromptSubmit` | On each genuine user turn, asks `ct wisdom match` for up to 2 relevant facts not yet in context (no per-session cap; corrections to a fact already shown also flow) and appends them as `additionalContext`. The system prompt is never touched. |
| `PostToolUse` (`curated_recall_context`) | A recalled wiki entry the session already has is replaced by a one-line `already in context` stub. |

**Exactly once.** The record of what this session has seen lives in
`${CLAUDE_PLUGIN_DATA}/wisdom/` (Claude Code creates it; it survives plugin
updates) and nowhere else. The plugin never reads the transcript. Missing or
unreadable state means no delivery, never a repeat.

**When it stays quiet**, deliberately:

- **Resumed sessions** (`--resume`, `--continue`, `/resume`) and **forks** get
  no live delivery for the rest of their life. What they already contain
  cannot be known without the transcript. The status section still renders.
- **Subagents** never get live delivery or stubs. Only the main thread does.
- **Not a user turn.** Background-agent reports and other harness-generated
  prompts (anything that opens with an envelope tag such as
  `<agent-message …>`) are skipped.
- **No CT, or CT older than 3.3.0** (no `ct wisdom match`): a silent no-op.
- **CT is struggling**: three timeouts or errors in a row pause matching
  for 5 minutes.

`/compact` keeps delivering and does not repeat a fact the session already
had. `/clear` starts a fresh session.

**Requirements.** Curated Thoughts ≥ 3.3.0 with `ct` on `PATH` (or in the
platform install location), and Python 3.9+. Managed deployments that set
`allowManagedHooksOnly` disable plugin hooks, and Intuitive Wisdom with them.

### Verbose mode

Set `CT_WISDOM_VERBOSE=1` in the environment you start `claude` from to see
what each turn's wisdom delivery added, or why it added nothing. The hook
then returns a top-level `systemMessage`, which Claude Code shows in the
transcript ("… says: Curated Thoughts wisdom: delivered 2 facts …", with the
block) and does not send to the model; `additionalContext` is unchanged. Each
decision is also appended to
`${CLAUDE_PLUGIN_DATA}/wisdom/ct-wisdom-verbose.jsonl` (override:
`CT_WISDOM_VERBOSE_LOG`). Read it with
`python3 scripts/ct_wisdom_log.py --host claude-code [-n 20] [-f] [--block]`
from the plugin directory; outside a hook the reader looks under
`~/.claude/plugins/data/curated-thoughts*/`. See the [spec](../../docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md).

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

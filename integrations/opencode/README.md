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
- **Intuitive Wisdom** (0.2.0) — on a session's first turn, a short
  memory block recalled from the brain's wisdom layer; on every turn after
  that, the facts CT judges relevant to your message, delivered **once**; and
  (0.4.0) while the agent works on its own, one fact keyed to the file,
  command or search it is working on. See [Intuitive Wisdom](#intuitive-wisdom) below.
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

## Intuitive Wisdom

Needs the standalone `ct` CLI from Curated Thoughts ≥ 3.3.0 (`ct wisdom match`)
on `PATH` or at a standard location. Without it, the plugin skips wisdom and
works as before.

- **Bootstrap (first turn).** The plugin runs one `ct recall` against the
  wisdom layer and attaches the result, at most 2500 characters, to your first
  message.
- **Live delivery (every turn).** In the `chat.message` hook, before the model
  runs, the plugin asks `ct wisdom match` which facts relevant to your message
  are not yet in context, and appends up to 2 of them (1200 characters max).
  There is no per-session cap, so a long session keeps receiving relevant
  facts; corrections to facts you already have also flow.
- **No system-prompt changes.** Both blocks are `synthetic: true` text parts
  on your message, which OpenCode saves with the session. The system prompt
  (and its provider cache) stays as it is.
- **Exactly once.** Each fact carries a `<!-- ct-fact:<id> -->` marker. The
  plugin keeps no store of its own. Each turn it rebuilds the list of facts
  already in context from the session history (`session.messages`), so
  `--continue`, a restart, and compaction never repeat a fact. Compaction
  carries every delivered fact forward deliberately.
- **Recall dedup.** When the agent calls `curated_recall_context` itself,
  entries already in context are cut down to one-line stubs.
- **Autonomous work (0.4.0).** While the agent works on its own between your
  messages, each approved `read`, `write`, `edit`, `grep`, `glob` or `bash`
  call can bring **one** fact (600 characters max), appended to that tool's
  result under `## Curated Thoughts — relevant to this step`. CT receives only
  the bare target: the project-relative path, the search pattern, or the
  program and a safe subcommand (`pnpm test`). File contents, command output,
  flag values and the agent's own words are never sent, and paths outside the
  project are never sent. At most one CT call per model step, and only when
  the agent moves to a new file, command or search. Calls OpenCode refuses
  (for example a `.env` read that `opencode run` auto-rejects) send nothing:
  the query starts only after the tool ran. CT's own tools never trigger.
  Subagent sessions receive these deliveries too, each against its own
  context. The cost is up to 3 s (typically about 1 s) added to the
  triggering tool's result. Spec:
  [2026-10-17](../../docs/superpowers/specs/2026-10-17-opencode-autonomous-work-wisdom-design.md).
- **Per-message delivery in main sessions only.** Subagent (child) sessions
  never receive the per-message block (their only "message" is the prompt
  the parent model wrote). Their recall results are still deduped against
  the parent's context.
- **Known limits.** A rule that is about a concept and reached only through a
  path (an applied migration under `src/db/migrations/`) needs CT's activity
  mode
  ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282)).
  `apply_patch` calls give no activity.
- **Failure handling.** Failures are silent and bounded:
  - if `ct` is missing, or lacks `wisdom match`, the plugin does nothing;
  - three consecutive failures pause it for five minutes;
  - each `ct` call times out after 3 s.

Note: OpenCode's auxiliary calls, such as title generation, re-read the
session, so they also see delivered parts. This affects nothing except those
calls.

### Verbose mode

Set `CT_WISDOM_VERBOSE=1` before starting `opencode` to get a TUI toast per
turn (and per autonomous-work step, channel `activity`): what was delivered
(with titles) or why nothing was. Toasts are not
session parts, so the model never sees them. Each decision is also appended
to `$XDG_DATA_HOME/opencode/log/ct-wisdom-verbose.jsonl` (default
`~/.local/share/opencode/log/`; override: `CT_WISDOM_VERBOSE_LOG`). Read it
with `node lib/ct-wisdom-core/cli/ct-wisdom-log.js --host opencode [-n 20] [-f] [--block]`
from the installed plugin directory. Under `opencode run` there is no TUI, so
only the log is written. See the [spec](../../docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md).

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

**External embedder.** OpenCode starts a local MCP server with its whole
environment plus the entry's `environment` (verified at 1.18.35), so a brain
with `embed_profile.type: "external"` only needs its key (`EMBED_API_KEY`,
else `OPENROUTER_API_KEY` or `OPENAI_API_KEY`) set in the environment
OpenCode starts from. Nothing needs to be added to `opencode.json`.

## Verify

```bash
node <payload>/lib/scripts/ct_doctor.js check
node <payload>/lib/scripts/ct_doctor.js check --json   # machine-readable
```

The pre-flight check degrades gracefully when the optional `better-sqlite3`
dependency is absent — every other check is dependency-free (the plugin
runtime has zero third-party imports).

### End-to-end test (Docker, local only)

```bash
tests/e2e/run.sh
```

Builds the release artifact with `tools/ct_ci.py package`, then in a
`node:24-bookworm-slim`-based container installs the Curated Thoughts `.deb`
(default `CT_VERSION=2.12.1`) and the pinned OpenCode, runs `install.sh`
preview and apply, the doctor, and `opencode mcp list`, and re-runs the
installer to confirm it is a no-op. The sidecar `.deb` + Node 24 + non-root
user layers are shared with the DeepSeek Harness harness — see
`tests/e2e/base.Dockerfile` at the repo root. With `ZAI_API_KEY` set, a live
model (`zai/GLM-5.3-FLASH` via Z.AI's Anthropic-compatible endpoint; override
with `CT_E2E_MODEL`) must call `curated_proposals_list` through OpenCode. The
key is passed to the container by name only. No embedding backend runs, so the
embedding check is expected to WARN. Logs land in `tests/e2e/out/`.

## Uninstall

Remove the loader file (`~/.config/opencode/plugins/curated-thoughts.js`),
the payload directory, the `curated-thoughts` `mcp` entry from
`opencode.json`, and `~/.config/opencode/skills/curated-thoughts-*`.

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **Platforms:** macOS, Linux, Windows (covered by the CI matrix).
- **Tested host versions** (from `tests/host/compatibility.json`; v0
  findings first verified 2026-09-17, the 1.18.35 pin and the wisdom
  live-delivery contract verified 2026-10-16 on darwin-x64, and re-run on
  2026-10-22 with the patched Node 22.23.4 fallback; Linux is covered by the
  CI host job):
  - OpenCode `1.18.35` (npm package `opencode-ai@1.18.35`)
  - `@opencode-ai/plugin` `1.18.35`
  - `bun` `1.4.2` (test runner); host-embedded runtime as seen by the
    plugin: bun `1.3.14` / node `24.3.0`
  - Node fallback `22.23.4`

## Requirements

- OpenCode (host contract verified against the versions in
  `tests/host/compatibility.json`)
- A POSIX shell for the installer: on Windows, run `scripts/install.sh` from
  Git Bash or WSL (PowerShell and Command Prompt cannot run it directly)
- Optional: `better-sqlite3`, for the doctor's import pre-flight check
- Optional: the Curated Thoughts `ct` CLI ≥ 3.3.0, for Intuitive Wisdom

## License

MIT — identical to the main Curated Thoughts repository. OpenCode is a
third-party project; this integration is not affiliated with, endorsed by,
or produced by the OpenCode authors.

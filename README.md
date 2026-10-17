# curated-thoughts-integrations

[![CI](https://github.com/equationalapplications/curated-thoughts-integrations/actions/workflows/ci.yml/badge.svg)](https://github.com/equationalapplications/curated-thoughts-integrations/actions/workflows/ci.yml)

Open-source integrations connecting [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
to AI agent harnesses. One installable integration per harness, sharing a
common architecture.

## Integrations

| Harness | Directory | Status | Version |
|---------|-----------|--------|---------|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [`integrations/hermes/`](integrations/hermes/) | implemented | [0.6.7](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=hermes) |
| DeepSeek Harness | [`integrations/deepseek/`](integrations/deepseek/) | implemented | [0.6.0](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=deepseek) |
| OpenCode | [`integrations/opencode/`](integrations/opencode/) | implemented | [0.3.1](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=opencode) |
| OpenClaw | [`integrations/openclaw/`](integrations/openclaw/) | implemented | [0.2.2](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=openclaw) |
| Claude Code | [`integrations/claude-code/`](integrations/claude-code/) | implemented | [0.3.2](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=claude-code) |

Each version links to that integration's releases.

## What an integration provides

Each integration ships the same layers, adapted to its harness:

1. **Registration**: wires the Curated Thoughts MCP sidecar
   (`curated-thoughts-mcp --mcp`) into the harness's MCP configuration.
2. **Health checks**: an install/doctor script that verifies the sidecar
   binary, brain directory, vault, embedding backend, and registration, with
   actionable fix hints. Fails loudly before users get frustrated.
3. **Import pre-flight**: before an agent trusts an imported brain, the
   doctor reads the engine version and censuses the knowledge graph for
   provenance damage. See "Memory in a box" below.
4. **Skills**: harness-native skill files teaching the agent how to use
   Curated Thoughts correctly: tool routing, write paths (vault notes vs
   wisdom entries), and OKF frontmatter hygiene.
5. **Intuitive Wisdom**: curated facts arrive in context when they are
   relevant, never repeating one already in context. See the next section.

## Intuitive Wisdom

The agent should not have to remember to ask its memory. With Intuitive
Wisdom, every integration does two things:

- **At session start**, a short bootstrap block recalls a few procedures and
  facts from the brain's wisdom layer.
- **Once per user turn**, before the model runs, the integration asks
  Curated Thoughts (`ct wisdom match`) which curated facts are relevant to
  the user's message. The ones not yet in context are added *to that turn*.
  They never go into the system prompt, so the prompt and its provider cache
  stay untouched.
- **During autonomous work** (Hermes and DeepSeek Harness so far), while the
  agent works on its own between messages, the file it reads or edits, the
  command it runs or the pattern it searches can bring in one relevant fact.
  See [Autonomous-work delivery](#autonomous-work-delivery).

A fact is in the session's context **at most once**. Each delivered fact
carries a `ct-fact:<id>` marker, and the integration skips any fact the
session already has, whether it came from the bootstrap block, an earlier
turn, or a recall. Compaction is the one exception, and it differs by host
(see the table below). On Hermes and OpenClaw, a fact whose marker was
compacted out of context may be delivered again; on DeepSeek Harness that
can happen only after a restart. OpenCode and Claude Code never re-deliver
it. When the agent runs `curated_recall_context` itself, entries it already
has come back as one-line "already in context" stubs.

Relevance is Curated Thoughts' job: integrations never score, rank or
threshold facts (see [INTENT.md](INTENT.md)). The same algorithm runs
everywhere, as the Hermes Python core (also used by Claude Code) and the
TypeScript port in `packages/ct-wisdom-core` (DeepSeek Harness, OpenCode,
OpenClaw), with the same budgets:

- at most 2 facts per turn, in a block of at most 1200 characters. There is
  no per-session cap: a long session keeps receiving relevant facts, and
  because no fact is delivered twice, the total is bounded by the distinct
  facts that match. Corrections to a fact already shown flow on every turn;
- each `ct` call times out after 3 s;
- three consecutive timeouts or non-zero exits of `ct wisdom match` pause
  matching for 5 minutes. A `ct` that cannot be found or started does not
  count; on the TypeScript hosts, unparseable output also counts.

**Requires Curated Thoughts ≥ 3.3.0** (the first release with
`ct wisdom match`). With an older CT, or no CT at all, live delivery is a
silent no-op and the session runs as before.

### Per-host behavior

| Host | Trigger | Delivered as | Resume / restart | Compaction |
|------|---------|--------------|------------------|------------|
| [Hermes](integrations/hermes/) | `pre_llm_call` hook | appended to the user turn | a restored session (`/branch`, or `/resume` after a restart) gets no live delivery | delivery continues; a fact compacted out of context may arrive again |
| [DeepSeek Harness](integrations/deepseek/README.md#intuitive-wisdom) | first `agent/pre-step` step of a turn | a user message persisted in the session log | `--session-id` and restarts keep delivering, with no repeats (the record is rebuilt from the session log) | delivery continues; within one process the plugin also remembers what it delivered, so no repeats; after a restart, a fact compacted out of the session log may arrive again |
| [OpenCode](integrations/opencode/README.md#intuitive-wisdom) | `chat.message` hook | a `synthetic: true` part on the user message | `--continue` and restarts keep delivering, with no repeats | delivered facts are carried forward on purpose, so a compacted-out fact is never re-delivered |
| [Claude Code](integrations/claude-code/README.md#intuitive-wisdom) | `UserPromptSubmit` hook | `additionalContext` | `--resume`, `--continue`, `/resume` and forks turn live delivery **off** for the life of the session; `/clear` starts a fresh session | `/compact` keeps delivering, with no repeats |
| [OpenClaw](integrations/openclaw/README.md) | `before_prompt_build`, user turns only | `prependContext` inside the user message | a new process gets no live delivery for a session until its bootstrap is settled | the session key survives; a fact compacted out of context may arrive again |

When a resume or restore turns live delivery off, the bootstrap block stays
in context: replayed from the session's history (Hermes restores, Claude
Code `--resume`) or rendered again (OpenClaw, Claude Code forks). On OpenCode, Claude Code and OpenClaw, subagent sessions never
receive live delivery. Host-specific gates:

- **Claude Code**: managed deployments that set `allowManagedHooksOnly`
  disable plugin hooks, and Intuitive Wisdom with them.
- **OpenClaw**: needs `hooks.allowConversationAccess: true` and a 20 s
  `before_prompt_build` timeout (the installer sets both). Delivery is
  verified **cache-safe** on the embedded runner at openclaw 2026.10.3 (a
  byte-level capture on 2026-10-16) and works on the CLI runner. The Codex
  app-server and Copilot runtimes are degraded.

### Autonomous-work delivery

Since hermes 0.6.0 and deepseek 0.6.0, Hermes and DeepSeek Harness also
deliver facts *between* user messages, keyed to what the agent is doing.
The rules are the same on both (the TypeScript side lives in
`packages/ct-wisdom-core`, ready for the other hosts); the hook and the
channel differ:

| Host | Trigger | Delivered as |
|------|---------|--------------|
| Hermes | `pre_tool_call` starts the query, `transform_tool_result` delivers | spliced into that tool's result |
| DeepSeek Harness | `tools/pre-execute` starts the query, the next `agent/pre-step` (step 2 and later) delivers | a user message persisted in the session log (source kind `curated-thoughts-wisdom-activity`), before the next model step |

On Hermes:

- **Trigger:** a `read_file`, `write_file`, `patch`, `search_files` or
  `terminal` call whose activity is new for the session. At most one
  `ct wisdom match` per model step, only when the activity changes (a new
  file, command or search). There is no ceiling per message or per session.
  Curated Thoughts' own tools never trigger it.
- **What is sent to Curated Thoughts:** only the bare target, for example
  `src/billing/invoice.py`, `pnpm test` or a search pattern. For shell
  commands (since hermes 0.6.6) that is the bare program name, and nothing
  at all for a script or a path (`./acme_export.sh`, `/opt/x/tool`). Only
  well-known tools with subcommands (`git`, `npm`, `pnpm`, `cargo`,
  `docker`, `kubectl`, `make`, …) also send their subcommand, and only a
  known verb (`git rebase`, `npm test`, `make build`). Every other program
  is sent alone, so `rm divorce-papers` sends `rm` and
  `pytest tests/billing` sends `pytest`. `python -m <module>` sends the
  module only for well-known modules (`pytest`, `pip`, `http.server`, …;
  `python3 -m pytest` sends `python3 pytest`) or a package inside the
  project, and then only its top package (`python -m mypkg.cli` sends
  `python mypkg`). `git.exe status` counts as `git status`. Nothing naming
  you is sent.
  File contents, tool output, diffs and the agent's own words are never sent.
- **Privacy (since hermes 0.6.5):** a file path is sent only when it is
  inside a project (the nearest folder above the session's working
  directory holding `.git`, `.hg`, `pyproject.toml`, `package.json`,
  `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `Gemfile`,
  `composer.json`, a `*.sln` or `.curated-thoughts-project`). It is never your
  home folder or above it, anyone's home folder itself (`/home/<x>`,
  `C:\Users\<x>`), `/`, `/home`-style folders or a WSL drive root.
  Container folders such as `/app` and `/workspace` work. The path is sent
  only relative to that project, and only up to 200 characters. Files outside
  a project get no autonomous-work wisdom. Nothing naming you (`USER`,
  `LOGNAME`, `USERNAME`, your system account, your home folder's name) is
  ever sent. A search
  pattern is sent only if it is plain words (letters, digits, `_ . -`, at
  most 6 words and 80 chars) with no key-shaped or auth word. To opt a
  folder in without a build file, add an empty `.curated-thoughts-project`.
- **Delivered as:** at most 1 fact in at most 600 characters, added to that
  tool's result under `## Curated Thoughts — relevant to this step`, with
  the same `ct-fact` marker and at-most-once rule as every other delivery.
  The system prompt is never touched.
- **Where:** main sessions, subagents and scheduled (cron) runs. A restored
  session gets none until its next fresh turn (no record of what is in
  context means no delivery).
- **Cost:** the CT call starts when the tool starts, so it overlaps the
  tool; the 3 s timeout and the breaker are shared with live delivery.
- **Verbose mode** (below) records these deliveries with channel
  `activity` and the activity label (`read src/x.py`).

On DeepSeek Harness the same rules apply to the `read`, `write`, `edit`,
`str_replace_editor`, `grep`, `glob`, `bash` and `pwsh` tools; see
[its README](integrations/deepseek/README.md#autonomous-work-delivery).
The fact arrives as its own user message before the next model step, is
replayed on `--session-id`, and the record of what is in context is rebuilt
from the session log at every step. Subagents get deliveries too.

### Verbose mode

To see what Intuitive Wisdom adds to your conversation, and why it added
nothing on a turn, set `CT_WISDOM_VERBOSE=1` in the environment the host
runs in. It is off by default. When it is on, every live-delivery decision is:

- **shown to you** on a channel the model never reads (table below), and
- **recorded** as one JSON line in a local log: the query as CT received it,
  CT's gate, every matched fact with its id, title, text, provenance, score
  and outcome (delivered, already in context, or did not fit), the delivered
  block, or the reason nothing was delivered (`deduped`, `no_match`,
  `gate_uncalibrated`, `budget`, `breaker_open`, a timeout, ...).

Verbose output never changes the system prompt, the delivered block or any
tool result, so the prompt cache is unaffected. No environment variables or
keys are logged. Set `CT_WISDOM_VERBOSE_LOG=<file>` to choose the log path.

| Host | What you see | Log (default) |
|------|--------------|---------------|
| Hermes | a summary and the block on stderr | `$HERMES_HOME/logs/ct-wisdom-verbose.jsonl` |
| Claude Code | `Curated Thoughts wisdom: …` in the transcript (the hook's `systemMessage`) | `${CLAUDE_PLUGIN_DATA}/wisdom/ct-wisdom-verbose.jsonl` |
| DeepSeek Harness | the plugin's `curated-thoughts` logger | `$DSH_HOME/logs/ct-wisdom-verbose.jsonl` |
| OpenCode | a TUI toast | `$XDG_DATA_HOME/opencode/log/ct-wisdom-verbose.jsonl` |
| OpenClaw | the gateway log (`openclaw logs --follow`) | `$OPENCLAW_STATE_DIR/logs/ct-wisdom-verbose.jsonl` |

To read the log, run `python3 scripts/ct_wisdom_log.py --host hermes` (or
`--host claude-code`) from the Hermes or Claude Code plugin directory, or
`node <core>/cli/ct-wisdom-log.js --host opencode` (or `deepseek`,
`openclaw`) on the TypeScript hosts. Both take `-n N` for the last N events,
`-f` to follow, `--block` to print delivered blocks and `--json` for the raw
records. Each integration's README gives the exact path.

### Known limits

- **CT's relevance gate needs a calibrated embedder.** When CT has no
  calibrated floor for the brain's embedding model, `ct wisdom match`
  answers `gate: uncalibrated` and returns no facts (corrections still flow).
- **Matching rarely fires on real messages yet**
  ([curated-thoughts#271](https://github.com/equationalapplications/curated-thoughts/issues/271)),
  and corrections for superseded facts stay empty until CT's Librarian
  applies supersessions. Both are CT-side; the integrations are ready for
  them.
- **The session-start block has no provenance labels and may include a
  superseded fact,** because `ct recall` returns neither provenance nor
  supersession status. Live delivery (`ct wisdom match`) has both. Closing
  this needs a CT change first.
- **Autonomous-work delivery is on Hermes and DeepSeek Harness only so
  far.** On the other hosts,
  an agent working autonomously between messages gets no new facts until
  the next message (see [INTENT.md](INTENT.md) for the end state).
- **Concept rules reached only via paths need CT activity mode.** From a
  bare path, CT's gate reaches facts about that file or command, but not a
  concept-level rule the path only implies (for example a migration rule
  from a migration file's path). That needs a CT-side activity query mode
  ([curated-thoughts#282](https://github.com/equationalapplications/curated-thoughts/issues/282));
  the integrations add no query expansion of their own.
- The per-turn limits above cap how much arrives on one turn, even when
  more is relevant.

## The integrations so far

**[Hermes](integrations/hermes/)** (Python + POSIX shell) registers the
sidecar in the agent's MCP config, ships the shared doctor as
`ct_status`/`ct_preflight`, and installs the skill files directly into the
Hermes skills tree. It is the reference implementation of Intuitive Wisdom:
the bootstrap block is a system-prompt section memoized per session,
live delivery runs from the `pre_llm_call` hook, and autonomous-work
delivery runs from `pre_tool_call` and `transform_tool_result`. Without Curated Thoughts,
or with an unreachable brain, both blocks are simply absent. The edge cases
of restored sessions and the 256-session memo window are listed under 0.3.0
in its [CHANGELOG](integrations/hermes/CHANGELOG.md).

**[DeepSeek Harness](integrations/deepseek/)** (Node/TypeScript) is a Cordis
plugin module, `@equational-applications/dsh-curated-thoughts`. It mounts the
sidecar through `@deepseek-ai/dsh-mcp-client`, injects a cache-safe health
snapshot into the system prompt (refreshed on `agent/created`), and registers
the same three skills as Hermes at runtime. The pinned host is 0.2.0-rc.2
(`tests/host/compatibility.json`), verified end to end in a container on
2026-10-16. The doctor is `node lib/scripts/ct_doctor.js check`. DeepSeek
Harness ships on Windows as well as macOS and Linux, so CI verifies the
integration on all three. Install with
`CT_INSTALL_EDIT=1 ./scripts/install.sh --profile <profile>`; without
`CT_INSTALL_EDIT=1` the installer only previews.

**[OpenCode](integrations/opencode/)** (TypeScript) is an OpenCode plugin
delivered as a release tarball, not an npm package. A preview-first
installer adds the `curated-thoughts` `mcp` entry to `opencode.json`, a
loader plugin that puts a health block in the system prompt, and the three
skills as files. The host contract runs against the real pinned OpenCode
binary (1.18.35) in CI.

**[Claude Code](integrations/claude-code/)** (Python) is a Claude Code plugin
directory, loaded with `claude --plugin-dir`. The installer registers the
sidecar at user scope through `claude mcp add`, the `SessionStart` hook adds a
health snapshot and the bootstrap block, and the wisdom hooks run directly
from byte-identical copies of the Hermes core.

**[OpenClaw](integrations/openclaw/)** (TypeScript) is a native OpenClaw
plugin (pinned to openclaw 2026.10.3) that mounts the sidecar from its
manifest, ships the three skills, and puts the bootstrap block in OpenClaw's
cacheable system space. Its installer runs OpenClaw's own
`openclaw plugins install` and grants the permission and timeout above.

See each integration's README for full install and verify instructions.

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

### What reaches the sidecar

Most hosts do not hand their whole environment to an MCP server. If the brain
uses an external embedder (`embed_profile.type: "external"` in `config.json`),
the sidecar reads its key from `EMBED_API_KEY`, else `OPENROUTER_API_KEY`
(OpenRouter `base_url`, the default) or `OPENAI_API_KEY`. When the host drops
that variable, recall and wisdom matching cannot embed, and nothing reports an
error. A brain location set through `CURATED_BRAIN_DIR` can be dropped the
same way, and the sidecar then opens `~/.brain`.

| Host | What the sidecar gets | What the integration does |
|------|-----------------------|---------------------------|
| Hermes | `PATH`, `HOME`, `USER`, locale, `TMPDIR`, `XDG_*` and the entry's `env:` | `install.sh` reads the brain config and writes `env:` with `${NAME}` references; the doctor's `sidecar-env` check prints the exact fix |
| OpenClaw | The MCP SDK's short default list (`HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`) and the server's `env` | The doctor's `sidecar-env` check prints an `mcp.servers.curated-thoughts` row that forwards the key as `${NAME}` |
| DeepSeek Harness | Its environment minus every name matching `KEY`, `PASSWORD`, `SECRET` or `TOKEN` | The bundle patch forwards the three key names from DSH's own environment |
| Claude Code | Its whole environment (unless `CLAUDE_CODE_MCP_ALLOWLIST_ENV` is on) | Nothing to forward; the doctor warns if the key is not set |
| OpenCode | Its whole environment plus the entry's `environment` | Nothing to forward |

Only names are ever written to a host config. Key values stay in the
environment, or in the host's own env file, such as `~/.hermes/.env`.

## Memory in a box

A Curated Thoughts brain is meant to be exported from one machine and imported
into another harness (any of the five above) and keep working. Two hazards
make that non-trivial, and the doctor's import pre-flight reports both:

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

## Versioning

Each integration versions independently on its own SemVer line and releases
from a `<id>-v<semver>` tag, such as `hermes-v0.4.2`. There is no repository-wide
version. An integration declares the sidecar range it needs
(`requires_sidecar`) and the `shared/compat.yaml` tier it targets; CI enforces
that the two agree. See [`docs/ci.md`](docs/ci.md).

## License

MIT — identical to the main Curated Thoughts repository.

# curated-thoughts-integrations

[![CI](https://github.com/equationalapplications/curated-thoughts-integrations/actions/workflows/ci.yml/badge.svg)](https://github.com/equationalapplications/curated-thoughts-integrations/actions/workflows/ci.yml)

Open-source integrations connecting [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
to AI agent harnesses. One installable integration per harness, sharing a
common architecture.

## Integrations

| Harness | Directory | Status | Version |
|---------|-----------|--------|---------|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [`integrations/hermes/`](integrations/hermes/) | implemented | [0.4.2](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=hermes) |
| DeepSeek Harness | [`integrations/deepseek/`](integrations/deepseek/) | implemented | [0.4.1](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=deepseek) |
| OpenCode | [`integrations/opencode/`](integrations/opencode/) | implemented | [0.2.0](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=opencode) |
| OpenClaw | [`integrations/openclaw/`](integrations/openclaw/) | implemented | [0.1.0](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=openclaw) |
| Claude Code | [`integrations/claude-code/`](integrations/claude-code/) | implemented | [0.2.0](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=claude-code) |

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

- at most 2 facts per turn, in a block of at most 1200 characters, and at
  most 12 per session. Corrections to a fact already shown still flow
  after the cap is reached (a delivered correction counts toward it);
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
- **Wisdom is only requested on user messages.** An agent working
  autonomously between messages gets no new facts until the next message.
  Autonomous-work delivery is the intended end state (see
  [INTENT.md](INTENT.md)) and is not built yet.
- The per-turn and per-session budgets above cap how much arrives, even when
  more is relevant.

## The integrations so far

**[Hermes](integrations/hermes/)** (Python + POSIX shell) registers the
sidecar in the agent's MCP config, ships the shared doctor as
`ct_status`/`ct_preflight`, and installs the skill files directly into the
Hermes skills tree. It is the reference implementation of Intuitive Wisdom:
the bootstrap block is a system-prompt section memoized per session, and
live delivery runs from the `pre_llm_call` hook. Without Curated Thoughts,
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

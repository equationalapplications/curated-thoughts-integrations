# Curated Thoughts for OpenClaw

A native [OpenClaw](https://docs.openclaw.ai) plugin that connects OpenClaw
agents to the [Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar. Sibling to the [Hermes](../hermes/), [DeepSeek](../deepseek/)
and [OpenCode](../opencode/) integrations: same skills, same doctor, same
Intuitive Wisdom algorithm (`packages/ct-wisdom-core`).

Verified against **openclaw 2026.10.3** (`tests/host/compatibility.json`).
OpenClaw marks every plugin API experimental, so the plugin declares
`openclaw.compat.pluginApi: ">=2026.10.3"` and each new host version is
re-verified before the pin moves. OpenClaw itself needs Node ≥ 24.16.

## What you get

- **MCP sidecar wired in.** The manifest (`openclaw.plugin.json`) declares the
  `curated-thoughts` stdio MCP server (`curated-thoughts-mcp --mcp`), which
  OpenClaw mounts only while the plugin is enabled. A user
  `mcp.servers.curated-thoughts` entry overrides it (for example to set
  `env.CURATED_BRAIN_DIR`).
- **Three skills.** `curated-thoughts-usage`, `curated-thoughts-ops`,
  `curated-thoughts-sidecar`, loaded from the plugin's `skills/` directory.
- **Bootstrap memory block.** On a session's first turn the plugin runs a
  seed-query `ct recall` and renders the result into OpenClaw's
  provider-cacheable system space (`prependSystemContext`). The bytes are
  memoized per session.
- **Intuitive Wisdom live delivery.** On every genuine user turn the plugin asks
  CT which wisdom facts are relevant (`ct wisdom match`, CT ≥ 3.3.0 owns the
  relevance gate) and delivers at most 2 facts per turn and 12 per session
  (1200-character block) inside that turn's user message (`prependContext`). It
  never repeats what the agent can already see. Agent-initiated
  `curated_recall_context` results are deduped by a tool-result middleware.
- **Doctor.** `node lib/scripts/ct_doctor.js check` covers the sidecar, brain,
  vault, embeddings, OpenClaw registration (the plugin entry and its
  conversation-access grant) and the import pre-flight.

## Install

Build (or unpack the `openclaw-v<version>` release tarball), then:

```bash
./scripts/install.sh                    # preview: prints the plan, writes nothing
CT_INSTALL_EDIT=1 ./scripts/install.sh  # apply
```

Applying stages a self-contained copy of the plugin, with the shared core
vendored, and runs OpenClaw's own CLI:

```bash
openclaw plugins install <staged copy> --force --accept-capabilities
openclaw config set plugins.entries.curated-thoughts.hooks.allowConversationAccess true
openclaw config set plugins.entries.curated-thoughts.hooks.timeouts.before_prompt_build 20000
```

`--force` and `--accept-capabilities` are OpenClaw's consent for installing a
local, non-ClawHub source. You give that consent by opting in with
`CT_INSTALL_EDIT=1` after reading the preview. `OPENCLAW_BIN`,
`OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` are honored. Verify the running
gateway with `openclaw plugins inspect curated-thoughts --runtime --json` (expect
`status: loaded` and the typed hooks `agent_turn_prepare` and
`before_prompt_build`).

### Permission gates

- `hooks.allowConversationAccess: true` is required. OpenClaw refuses
  non-bundled `before_prompt_build` / `agent_turn_prepare` hooks without it, so
  neither the bootstrap block nor live wisdom would run.
- `hooks.allowPromptInjection` must not be `false`. It defaults to allowed.

### Timeouts

OpenClaw gives a prompt hook 15 s by default and drops a late result. The CT
live call has a 3 s budget. A session's first turn can need discovery (≤ 3 s),
the bootstrap recall (≤ 5 s), the capability probe (≤ 3 s) and the match
(≤ 3 s). The plugin therefore registers a 20 s budget and the installer sets
the same operator override. If a result still arrives late, the block is
queued with `enqueueNextTurnInjection` for the next turn rather than lost.

## How live delivery stays exactly-once

The ledger is rebuilt on every turn from what the host hands the prompt hook.
That covers earlier user turns, including their persisted model-prompt
projection where past wisdom blocks live, and earlier tool results. To it the
plugin adds the bootstrap block's ids and any of its own queued blocks that
OpenClaw drained into the current turn (observed through `agent_turn_prepare`).
A rebuild or retry of the same admitted request returns the identical result.
Compaction keeps the session key. A fact compacted out of the model's view can
be delivered again, which matches Hermes.

## Runtime support

| Runtime | Live wisdom | Late-result salvage | Recall dedup | Notes |
|---|---|---|---|---|
| Embedded (default) | yes | yes | yes | cache-safe: verified byte-level at 2026.10.3 |
| CLI runner | yes | yes | n/a | block is prepended to the prompt string |
| Codex app-server | degraded | no | projected MCP tools | no injection drain; projection persistence unverified |
| Copilot | degraded | no | not declared | — |

Subagent sessions (`subagent:` session keys or subagent provenance), heartbeat
and cron turns, and inter-session deliveries never receive live wisdom. The
bootstrap block still renders for them.

## Cache safety

At the pin, the embedded runner places `prependContext` inside the current user
message, freezes it into the transcript once per admitted request, and replays
it byte-identically on later requests. `tests/e2e/run.sh` checks this against a
real install with two model turns through a recording proxy. The 2026-10-16
verdict was **cache-safe**: the system prompt was identical across turns, the
earlier turn was replayed byte-identically, and the new block rode only the tail
user message. Re-run it when the pin moves:

```bash
ZAI_API_KEY=… tests/e2e/run.sh        # needs node >= 24.16 and python3
```

## Development

```bash
(cd ../../packages/ct-wisdom-core && pnpm install && pnpm run build)
pnpm install && pnpm run build && pnpm test
```

`tests/host/contract.test.ts` is a **shape-level** contract. It loads the built
entry against a stub API and checks every hook, field and manifest key against
the recorded pin facts, but it does not run a gateway.

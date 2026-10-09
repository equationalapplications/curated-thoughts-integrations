# Host freshness probe — DSH + OpenCode hook-point parity (CT live delivery)

**Date:** 2026-10-09 · **Status:** complete · **Question:** have DSH or OpenCode
shipped versions newer than the pins that add (a) a per-user-turn / pre-LLM hook
exposing the user message text, (b) a tool-result transform/interception hook,
(c) any append-to-user-message or context channel suitable for cache-safe
per-turn injection?

**Pins under test:**
- DeepSeek Harness: `dsh` **0.1.5-rc.2** (`integrations/deepseek/tests/host/compatibility.json`,
  verified 2026-09-18; npm latest = 0.1.5-rc.2, alpha tag = 0.1.6-alpha.2 at pin time).
  Prior DSH step-0 investigation (2026-09-30) additionally cross-checked **0.2.0-rc.2**
  tarballs — contracts identical except `interpolate` on `PromptSection`.
- OpenCode: **1.18.31** (`integrations/opencode/tests/host/compatibility.json`,
  verified 2026-09-17). Pinned surfaces: `experimental.chat.system.transform` +
  generic `event` hook; no MCP/tool-result event; no per-user-turn injection path.

Tags: **[V]** = verified this session against cited source, **[C]** = child/secondary-reported.

## Findings

### Registry state [V] — npm (registry.npmjs.org), probed 2026-10-09

**DSH (`@deepseek-ai/dsh`)** — https://registry.npmjs.org/@deepseek-ai/dsh

- dist-tags: `latest` = **0.2.0-rc.2** (published 2026-09-29), `next` = 0.2.0-rc.2,
  `alpha` = **0.2.1-alpha.2** (published 2026-10-09T08:18Z — today).
- Versions newer than the pin 0.1.5-rc.2 (2026-09-10): 0.1.5-rc.3 (09-22),
  0.1.6-alpha.1 (09-15), 0.1.6-alpha.2 (09-17), 0.1.7-alpha.1/2 (09-22),
  0.1.7-rc.1 (09-23), 0.1.7-rc.2 (09-24), 0.2.0-rc.1 (09-28), **0.2.0-rc.2** (09-29),
  0.2.1-alpha.1 (10-03), 0.2.1-alpha.2 (10-09).
- Monorepo subpackages (`dsh-system-prompt`, `dsh-agent-loop`, `dsh-agent`,
  `dsh-session`, `dsh-llm`) all carry `next`/`alpha` dist-tags matching the
  umbrella 0.2.0-rc.2 / 0.2.1-alpha.2; their stale `latest` tags (0.0.1-rc.1 /
  0.1.0-rc.6, August) are legacy.

**OpenCode (`opencode-ai` + `@opencode-ai/plugin`)** — https://registry.npmjs.org/opencode-ai

- dist-tags: `latest` = **1.18.35** (published 2026-10-06) for BOTH packages
  (SDK tracks the host, same dist-tags).
- Versions newer than the pin 1.18.31 (2026-09-14): **1.18.32** (09-21),
  **1.18.33** (09-28), **1.18.34** (09-30), **1.18.35** (10-06).
- Prior pin note ("npm 'latest' = 0.1.5-rc.2") in the DSH compatibility.json is
  now stale on both counts: latest has moved to 0.2.0-rc.2 and alpha to 0.2.1-alpha.2.

### DSH — hook-point reality at and after the pin [V]

**⚠️ Correction to the pinned conclusion.** The pin ("only agent/session-start
event + systemPrompt sections/contexts; NO per-user-turn hook, NO tool-result
transform") is **wrong for 0.1.5-rc.2 as published**. Verified by downloading
and grepping the actual 0.1.5-rc.2 tarballs (2026-10-09):

- `@deepseek-ai/dsh-agent@0.1.5-rc.2` declares a **per-user-turn pre-LLM waterfall**
  `agent/pre-step` with payload `{ agent, messages: UserMessage[], turn, step, signal }`
  and a `PreStepDecision` that can reject the step or replace the entering messages
  (lib/types/runtime-types.d.ts lines ~302-319). The doc comment states a listener
  "cannot mutate messages" via `agent/request`, but `pre-step`'s decision can
  **replace the messages that enter the step** — i.e. append a context user message.
  The user message text is exposed (`messages: UserMessage[]`, content blocks with
  `.text`). Verified present identically at 0.1.5-rc.2, 0.1.5-rc.3, 0.1.6-alpha.1/2,
  0.1.7-rc.2, 0.2.1-alpha.2 (grep across all downloaded tarballs).
- `@deepseek-ai/dsh-hooks-codex@0.1.5-rc.2` (a dependency of the umbrella `dsh`
  at the pin, dep spec `^0.1.5-rc.2`) is a **reference implementation wiring Codex's
  five hook points onto DSH-native core events** (lib/index.js + README.md):
  - `UserPromptSubmit` → `ctx.on("agent/pre-step")` — fires per user prompt, payload
    exposes the prompt text (`prompt: blocksToText(messages…)`), and its output can
    **append a sourced user message** (`contextFrom(merged)` →
    `messages: [...downstream.messages, ours]`) — exactly the per-turn,
    cache-safe-style injection channel (b) of the task. README line 57: "block the
    prompt, or attach extra context".
  - `PostToolUse` → `ctx.on("tools/post-execute", async (exec, result, next) => …)` —
    receives the tool **result**, can block with model-visible feedback and/or
    prepend `additionalContexts` (user-role message) to the downstream decision —
    i.e. a tool-result interception/transform point (task item b) exists at the pin.
  - `PreToolUse` → `tools/pre-execute` (deny path), `SessionStart` →
    `agent/created`/`agent/session-start`, `Stop` → `agent/turn-stopping` (steer).
  README line 83 maps each Codex event to the underlying harness extension point.
- The same wiring persists unchanged through 0.1.7-rc.2 → 0.2.0-rc.2 →
  0.2.1-alpha.2 (diffed the `lib/` trees: 0.1.7-rc.2 vs 0.2.0-rc.2 are
  **byte-identical**; 0.2.1-alpha.2 only adds `workingDirectory` injection,
  `selectHookGroups`, and `cwd` in payloads).

**What DID change after the pin** (GitHub releases, all cited):
- 0.1.5-rc.3 (2026-09-22), 0.1.6-alpha.1/2 (09-15/09-17), 0.1.7-alpha.1/2 (09-22),
  0.1.7-rc.1/2 (09-23/24), 0.2.0-rc.1/2 (09-28/29), 0.2.1-alpha.1/2 (10-03/10-09):
  release bodies (https://github.com/deepseek-ai/deepseek-harness/releases, tags
  dsh-v0.1.5-rc.3 … dsh-v0.2.1-alpha.2) contain **no new hook points** beyond the
  five already at the pin; changes are UI/scheduling/MCP-resources/SSH/sandbox
  features and fixes. Verified mentions in release bodies (saved excerpt:
  /tmp/dshprobe/release-bodies.md, from the GitHub releases API): 0.2.1-alpha.2
  adds "Session state-record APIs for experimental plugins" and "the
  working_directory tool and TypeScript/Python SDK APIs"; 0.2.1-alpha.1 adds "an
  experimental reasoning translation plugin" — none of them a per-turn
  model-input hook beyond what `agent/pre-step` already provides. No release
  body mentions pre-step/post-execute/hook-point changes (0 occurrences of
  those keywords across all 12 bodies).
- 0.2.1-alpha.1 release notes announce an "experimental Claude Code Mods
  compatibility layer" — a separate experiment; the hooks bridge itself did not
  change materially between 0.1.7-rc.2 and 0.2.1-alpha.2 (verified by diff).

**Net for DSH:** the pinned "NO per-user-turn hook / NO tool-result transform"
conclusion is stale — and not merely because of newer versions: the required
surfaces (`agent/pre-step` exposing user text + message-append; `tools/post-execute`
result interception + `additionalContexts` append) **exist in the pinned
0.1.5-rc.2 itself**. The repo's prior DSH step-0 investigation's 0.2.0-rc.2
cross-check ("contracts identical except `interpolate` on `PromptSection`") is
consistent with this for the systemPrompt package, but the agent/hook surfaces
were not re-examined there. [V]

### OpenCode — 1.18.31 → 1.18.35 [V]

Sources: npm `@opencode-ai/plugin` tarballs 1.18.31 & 1.18.35 (downloaded,
`dist/index.d.ts` diffed — **byte-identical except the version string and the
pinned `@opencode-ai/sdk` dependency version**); GitHub compare API
`https://api.github.com/repos/anomalyco/opencode/compare/v1.18.31...v1.18.35`
(136 commits, 293 files; **zero changes to the hook/plugin-core files** — the only
plugin-dir touches are bundled provider plugins digitalocean/openai-codex/
snowflake-cortex + package.json version bumps).

- The `Hooks` interface already contains, at 1.18.31 **and** 1.18.35:
  `"chat.message"` (per-user-message trigger, exposes `output.message: UserMessage`
  + `parts`), `"chat.params"` / `"chat.headers"` (per-request, exposes
  `message: UserMessage`), `"tool.execute.before"` / `"tool.execute.after"`
  (after exposes `output.output` — the tool-result text — mutable), and
  `experimental.chat.system.transform` + `experimental.chat.messages.transform`
  (mutable `messages: {info, parts}[]` — an append-to-conversation channel).
- **No hook was added, removed, or signature-changed between 1.18.31 and 1.18.35**
  (empty diff of the hook surface; adjacent-pair compares 31→32→33→34→35 show no
  `packages/plugin/src` or hook-system file changes — only
  `packages/plugin/package.json` version bumps).
- Therefore: the pinned conclusion ("only experimental.chat.system.transform +
  event hook; no MCP/tool-result event; no per-user-turn injection path") was
  **incomplete about the same version** — `chat.message`, `chat.params`,
  `chat.headers`, `tool.execute.after`, and `experimental.chat.messages.transform`
  all exist in 1.18.31's own SDK types — but no **newer version** changes the
  picture: nothing new shipped 1.18.32–1.18.35. A per-turn text append remains
  possible only via `experimental.chat.messages.transform` (mutating the message
  list) or `tool.execute.after` (mutating that tool's output text); there is still
  no dedicated append-to-user-message / MCP tool-result event. [V]

## Verdicts

- **DeepSeek Harness (DSH):** new version changes the answer: the pin is stale on
  both axes — (1) the required hook points (`agent/pre-step` per-user-turn with
  user-message text + message replacement/append; `tools/post-execute` result
  interception with `additionalContexts` append; `tools/pre-execute` deny) **already
  exist in the pinned 0.1.5-rc.2** (verified in the published tarballs;
  `@deepseek-ai/dsh-hooks-codex@0.1.5-rc.2` README + lib are the in-repo proof at
  that version, mapping to core events), and (2) versions up to latest
  0.2.0-rc.2 / alpha 0.2.1-alpha.2 add **no new hook points** (bridge lib
  byte-identical 0.1.7-rc.2→0.2.0-rc.2; minor service-injection additions in
  0.2.1-alpha.2). → effectively **"new version changes the answer: not a new
  version — the pinned conclusion mis-read the pinned version; the hooks exist
  at 0.1.5-rc.2 and are unchanged through 0.2.1-alpha.2."**
- **OpenCode:** still structural NO for versions ≥ pin: no version 1.18.32–1.18.35
  (latest = 1.18.35) added a per-user-turn injection hook, tool-result transform
  event, or append-to-user-message channel beyond what 1.18.31 already had
  (`chat.message` / `tool.execute.after` / `experimental.chat.messages.transform`
  were already present at the pin — the *pin note* understated them, but no newer
  version changes the surface).

NOT CHECKED



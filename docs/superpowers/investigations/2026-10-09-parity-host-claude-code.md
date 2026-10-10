# Claude Code harness — CT 'Intuitive Wisdom live delivery' parity investigation

Question: can Claude Code's plugin/hook/MCP surface support the Curated Thoughts Intuitive-Wisdom live-delivery reference architecture (N1–N5) under the INTENT.md constraints (never mutate system prompt after build; fail quietly, short timeouts; exactly-once delivery per fact)?

Method: read Claude Code's official docs (code.claude.com/docs) directly during this investigation (2026-10-09). Evidence tags: **[V]** = read in official docs just now; **[C]** = inferred/reasoned, not explicitly documented.

Sources fetched and read:
- Hooks reference: https://code.claude.com/docs/en/hooks (full 258 KB markdown)
- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Plugin manifest reference: https://code.claude.com/docs/en/plugins/manifest-reference
- Plugin marketplaces: https://code.claude.com/docs/en/plugin-marketplaces
- MCP: https://code.claude.com/docs/en/mcp

---

## 1. Verified hook event inventory [V]

From https://code.claude.com/docs/en/hooks (Hook lifecycle + Hook events tables). Confirmed event names include:

- Per session: `SessionStart`, `SessionEnd`, `Setup`
- Per turn: `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`
- Per tool call: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`
- Compaction: `PreCompact`, `PostCompact`
- Subagents/tasks: `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`
- MCP-specific: `Elicitation`, `ElicitationResult`
- Other: `Notification`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `MessageDisplay`

Handler types [V]: `command` (shell, JSON on stdin), `http` (POST body), `mcp_tool` (calls an MCP tool), `prompt` (LLM eval), `agent`. `timeout` field per handler; defaults 600 s for command/http/mcp_tool but **lowered to 30 s on `UserPromptSubmit`** [V] (hooks reference, Hook handler fields). Supports our "short timeout, fail quietly" constraint: a timed-out hook is canceled and its output (including `additionalContext`) is discarded; **the prompt still reaches Claude without that context** [V] (UserPromptSubmit section). Non-blocking failure modes are default behavior for nonzero exits other than 2 [V].

## 2. Capability mapping (N1–N5)

| Need | Claude Code mechanism | Verdict | Evidence |
|---|---|---|---|
| **N1** — fire once per user turn WITH message text | `UserPromptSubmit` hook | ✅ Full | [V] |
| **N2** — append text to that turn's outgoing request, host-persisted for replay, without touching system prompt | `UserPromptSubmit` → `additionalContext` (or plain-text stdout) | ✅ Full — this is the documented use case | [V] |
| **N3** — rewrite MCP tool results (stub delivered facts + append ct-fact markers) | `PostToolUse` hook with matcher `mcp__<server>__<tool>` → `updatedToolOutput` / `updatedMCPToolOutput` + `additionalContext` | ✅ Full, with caveats | [V] |
| **N4** — stable session identity across compaction + history access | `session_id` common field; `transcript_path` to JSONL transcript; `SessionStart` matcher `compact` fires after compaction | ⚠️ Mostly — one gap, see §6 | [V]/[C] |
| **N5** — know which facts our bootstrap system-prompt block contained | No hook exposes system-prompt content. Workaround: our plugin supplies the bootstrap block itself (plugin SessionStart `additionalContext`) and records what it sent in `${CLAUDE_PLUGIN_DATA}` | ⚠️ Indirect only | [V]/[C] |

### N1 detail — `UserPromptSubmit`
- Fires "when you submit a prompt, before Claude processes it"; also fires on scheduled tasks, background-subagent reports, cross-session messages [V].
- Input includes `prompt` field with the submitted text; pasted-text placeholders arrive expanded [V]. Plus common fields `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` [V].
- `prompt_id` is a per-turn UUID [V] — usable as the CT turn key for exactly-once bookkeeping [C].
- 30 s default timeout on this event; on timeout output is discarded and the prompt proceeds (fail-open) [V].

### N2 detail — append channel
- Two channels, both documented for `UserPromptSubmit`: plain-text stdout on exit 0, or JSON `hookSpecificOutput.additionalContext` [V].
- Delivery: wrapped in a **system reminder** inserted "alongside the submitted prompt"; not a visible chat message; not part of the system prompt [V]. This satisfies the prompt-caching invariant: the already-built system prompt is never mutated; the append lands as a new message-side reminder each turn [V for mechanism, C for cache analysis].
- Persistence/replay: "Claude Code saves the injected text in the session transcript. For mid-session events like `PostToolUse` or `UserPromptSubmit`, when you resume with `--continue` or `--resume`, Claude Code replays the saved text rather than re-running the hook for past turns" [V] — exactly the host-persisted verbatim-replay channel we need.
- Oversize handling: values > 10,000 chars are written to a session file and Claude receives the path + 2,000-char preview [V].
- `UserPromptSubmit` cannot replace/rewrite the prompt itself — it only injects alongside [V].

### N3 detail — MCP tool-result transform
- MCP tools appear as regular tools in `PreToolUse`/`PostToolUse`; matcher pattern `mcp__<server>__<tool>`, regex supported [V] (Match MCP tools).
- `PostToolUse` input includes `tool_input`, `tool_response`, `tool_use_id`, and (for MCP tools) an `mcp_server` object [V] — we can see exactly what the MCP tool returned.
- Decision control includes **`updatedToolOutput` — "Replaces the tool's output with the provided value before it is sent to Claude"** — and `updatedMCPToolOutput` (MCP-only variant; docs prefer `updatedToolOutput`) [V]. So rewriting/stubbing MCP tool results is first-class, not a hack.
- Crucially: "MCP tool output is passed through without schema validation" for replacements [V] — we can reshape `mcp__curated_thoughts__*` results freely [C for our specific usage].
- Can also return `additionalContext` next to the tool result (ct-fact markers) [V].
- Caveats [V]: the tool already ran (side effects are real); replacement only affects what Claude sees, telemetry logs the original; `decision: "block"` does NOT replace output — it appends a reason next to the original.
- Persistence of rewrites across /resume: `additionalContext` near tool results is transcript-persisted and replayed [V]. Whether `updatedToolOutput` replacements are transcript-persisted and replayed verbatim is **NOT CHECKED** (docs explicitly state replay semantics only for `additionalContext`) [C: likely yes since it's what "Claude sees", but unverified].

### N4 detail — session identity + history
- Every hook receives `session_id` [V]. Hooks receive `transcript_path` — the session JSONL on disk, which contains conversation history including hook-injected reminders [V]. Our hook can read history from there [V].
- Compaction: `SessionStart` re-fires with matcher/source `"compact"` after auto or manual compaction [V]; `PreCompact` (matcher `manual`/`auto`) and `PostCompact` (receives `compact_summary`) exist [V]. So we can detect compaction and re-anchor.
- Session-id stability across compaction: docs show `session_id` unchanged across compaction examples and re-fire `SessionStart(source=compact)` in the same session; stable across compaction seems intended [C]. Explicitly stable across `--resume`? The docs treat resumed sessions as the same conversation but do not state whether `session_id` is preserved byte-for-byte — **NOT CHECKED**. Fail-closed design: key CT state by `session_id` but keep a restore path via `transcript_path` content [C].
- `/clear` starts fresh (`SessionStart` source `clear`) [V]; forks create new sessions (source `fork`) [V]. Forks/branches will get a new identity → CT should treat fork as a new delivery context [C].

### N5 detail — knowing our own bootstrap block
- No hook or API in the docs exposes the built system prompt [V — absent from all hook inputs; hooks get `permission_mode`, `cwd`, etc., never the system prompt].
- Viable design [C]: the plugin's `SessionStart` hook *supplies* the bootstrap CT block via `additionalContext` and writes exactly what it sent to `${CLAUDE_PLUGIN_DATA}` (plugin persistent data dir, survives plugin updates [V]). N5 then reduces to reading our own record. Limitations: the user could also have CT content in CLAUDE.md, and if CT content is delivered by something else, we don't see the system prompt. SessionStart re-fires on `resume`/`compact` sources so the record can be refreshed [V].

## 3. Plugin packaging & marketplace [V]

Yes — Claude Code has a full plugin system; our integration installs as a plugin:

- Manifest: `.claude-plugin/plugin.json` — optional; metadata, `userConfig` (Claude prompts the user for values, e.g. an API token, `sensitive: true` supported), and inline/redirected component declarations (`skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`). Source: https://code.claude.com/docs/en/plugins/manifest-reference [V].
- Standard layout puts `hooks/`, `skills/`, `commands/` at the plugin root; plugin hooks live in `hooks/hooks.json` and merge with user/project hooks when the plugin is enabled [V] (hooks reference, Hook locations).
- Plugin-bundled MCP servers: `.mcp.json` at plugin root or inline `mcpServers` in `plugin.json`; tools get namespaced `mcp__<plugin>__...`-style matchers and the server registers as `plugin:<plugin-name>:<server-name>` [V] (MCP docs, Plugin-provided MCP servers).
- Persistent state: `${CLAUDE_PLUGIN_DATA}` path variable (available to hook commands) is the plugin's persistent data directory that survives plugin updates [V].
- Marketplace: plugin marketplaces exist for distribution/install (https://code.claude.com/docs/en/plugin-marketplaces) [V]; `claude plugin validate` validates a plugin dir [V].
- Hook handler `timeout` and `userConfig` substitution are supported for plugin hooks [V].

## 4. Fit against INTENT.md constraints

| Constraint | Fit | Notes |
|---|---|---|
| Never mutate system prompt after initial build | ✅ [V] | Hook context injection is documented as system-reminder insertion in the conversation, not system-prompt edits. |
| Fail quietly, short timeouts | ✅ [V] | `timeout` per handler (30 s default on UserPromptSubmit); timeout/nonzero-exit = output discarded, turn proceeds. |
| Exactly-once delivery per fact | ✅ achievable [C] | `prompt_id` (per-turn UUID) + `session_id` + `tool_use_id` give idempotency keys; our own delivery ledger lives in `${CLAUDE_PLUGIN_DATA}`. Replay-on-resume of `additionalContext` is host-side verbatim, so no double-fire from re-running hooks on past turns [V]. |
| MCP result stubbing | ✅ [V] | `updatedToolOutput` / `updatedMCPToolOutput`, MCP output not schema-validated. |

## 5. Bottom line

**Feasible, and the parity is high.** All five reference capabilities map to documented, first-class mechanisms: `UserPromptSubmit` (N1/N2), `PostToolUse` + `updatedToolOutput` on `mcp__*` matchers (N3), `session_id`/`transcript_path`/`SessionStart(compact)` (N4), and a self-recorded bootstrap ledger in `${CLAUDE_PLUGIN_DATA}` (N5, indirect). Distribution is via the standard plugin format (`plugin.json` + `hooks/hooks.json` + skills + optional bundled MCP server) installable from a marketplace.

Residual risks [C]: (a) `session_id` stability across resume is not explicitly documented; (b) `updatedToolOutput` replay-on-resume persistence is not explicitly documented; (c) N5 has no direct system-prompt introspection — relies on us being the bootstrap supplier; (d) hooks fire inside subagents too (with `agent_id`/`agent_type`) — CT should dedupe or filter subagent deliveries to avoid double-counting a fact delivered in both main thread and subagent [V that hooks run in subagents; C on the dedupe need].

## 6. NOT CHECKED

- Whether `updatedToolOutput` rewrites are persisted to the transcript and replayed verbatim on `--resume` (only `additionalContext` replay is documented).
- Whether `session_id` is preserved byte-for-byte across `--resume` / fork (fork almost certainly new; resume unstated).
- Agent SDK callback hooks (TypeScript in-process alternative) — different surface, not investigated; may offer stronger guarantees but require the SDK host, not plain Claude Code.
- Exact behavior of `InstructionsLoaded` (may be relevant to N5; not read in detail).
- Behavior of multiple plugins returning competing `updatedToolOutput` for the same call (only `classifierContext` interaction is documented).
- Settings precedence for `allowManagedHooksOnly` enterprise restriction (could disable plugin hooks in managed deployments).

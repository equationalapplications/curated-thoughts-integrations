# OpenCode Host Re-Investigation: CT Live Delivery Feasibility (v1.18.31 → v1.18.35)

**Date:** 2026-10-09
**Method:** `npm pack @opencode-ai/plugin@1.18.31` and `@1.18.35`, exhaustive `.d.ts` analysis, cross-checked against `sst/opencode` source at tag `v1.18.31` (sparse clone, `oc-src/`).
**Tarball diff (1.18.31 → 1.18.35):** only `package.json` differs (version + `@opencode-ai/sdk` dep bump). `dist/` is byte-identical — **every finding applies to both versions.** [V]

**Tagging:** [V] = verified from tarball/source; [C] = conclusion from verified facts.

---

## TL;DR

**Full CT live delivery IS feasible on OpenCode.** The prior conclusion ("live delivery structurally impossible on OpenCode") rested on the assumption that `chat.message`, `chat.params`, `chat.headers`, `tool.execute.after`, and `experimental.chat.messages.transform` were absent at 1.18.31. **All five hooks exist at 1.18.31** with the semantics the CT pattern needs. This reverses the prior verdict.

Critical mechanism verified [V]: `plugin.trigger` (`oc-src/packages/opencode/src/plugin/index.ts:284-295`) passes the SAME `output` object to every hook, ignores return values — all mutation is in-place on that object. No cloning at the trigger boundary.

---

## N1: Per-turn trigger with user text

### `chat.message` — [V] — fires once per user turn, sees user text, CAN block/modify

**SDK contract** (`opencode-ai-plugin-1.18.31.tgz` → `package/dist/index.d.ts` lines 173–199):

```ts
"chat.message"?: (input: {
    sessionID: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    messageID?: string;   // branded MessageID
    variant?: string;
}, output: {
    message: UserMessage;
    parts: Part[];
}) => Promise<void>;
```

**Host invocation site** (`oc-src/packages/opencode/src/session/prompt.ts:999-1009`):

```ts
yield* plugin.trigger(
  "chat.message",
  { sessionID: input.sessionID, agent: input.agent, model: input.model,
    messageID: input.messageID, variant: input.variant },
  { message: info, parts: resolvedParts },
)
```

- `output.message` is the fully-populated `UserMessage` for the incoming turn; `output.parts` is the resolved parts array (text/file/agent parts; file parts already converted at lines 940–970).
- **Timing:** fires BEFORE persistence — `sessions.updateMessage(info)` / `sessions.updatePart(part)` run at lines 1046–1047 on these exact objects, AFTER the hook. The LLM call happens later in the same flow. So the hook fires before both persistence and the LLM call. [V]
- **Blocking:** the trigger is awaited (`yield*`, `Effect.promise` over the hook's returned Promise, plugin/index.ts:284–295) — an async hook genuinely blocks the turn pipeline. [V]
- **Mutation:** in-place mutation of `output.parts` is what gets persisted AND sent. The host itself does exactly this pattern at prompt.ts:974–990 (agent parts): it RETURNS an array containing an injected `{messageID, sessionID, type:"text", synthetic:true, text:...}` part, which lands in `resolvedParts`. A plugin can inject an equivalent synthetic text part into `output.parts` in `chat.message` and it becomes part of the stored user message and the LLM-visible request. [V]

### `event` with `message.updated` / `message.part.updated` — [V] read-only

`event` hook (index.d.ts line 175: `event?: (input: { event: Event }) => Promise<void>`) is a global subscriber over the persisted event bus — observation only, fires after persistence, cannot block or modify.

---

## N2: Cache-safe append channel

### `experimental.chat.messages.transform` — [V] — receives FULL array, appends reach the wire, system prompt untouched

**SDK contract** (index.d.ts lines 259–264):

```ts
"experimental.chat.messages.transform"?: (
  input: {},
  output: { messages: { info: Message; parts: Part[] }[] },
) => Promise<void>;
```

**Host invocation site — normal turns** (`oc-src/.../session/prompt.ts:1255`):

```ts
const msgs = structuredClone(selected.head)
yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
// ... then line 1262: toModelMessagesEffect(msgs, model) converts THIS array into the wire messages
```

- Receives the **full conversation history** per LLM call, as a host-side `structuredClone` — safe to mutate freely, host state unaffected. [V]
- **Appending works:** the exact array passed to the hook is what `toModelMessagesEffect` consumes (line 1262). A plugin can append a `{info: <user/system-role message>, parts: [synthetic text part]}` entry or append text to the last user message's text part — all mutations land on the wire. [V]
- **Wire-only / cache-safe:** because the input is a clone, mutations do NOT alter persisted history (persisted at 1046–1047 from the pre-transform array). [V]
- **System prompt is a separate channel:** the system prompt is built at `session/llm/request.ts:56–66` and only `experimental.chat.system.transform` (request.ts:69–78) touches it. `messages.transform` never mutates the built system prompt. [V]
- **Also fired during compaction** (`session/compaction.ts:379`) — see N4.

### `chat.params` / `chat.headers` — [V]

Both fire per LLM call (`session/llm/request.ts:114–146`), input `{sessionID, agent, model, provider, message: UserMessage}`, output `{temperature, topP, topK, maxOutputTokens, options}` / `{headers}`. In-place mutation merges into the request (`...headers` spread at request.ts:203). Metadata channel only — no message-content access. [C] Useful for tagging, not for CT delivery.

---

## N3: Tool-result transform

### `tool.execute.after` — [V] — receives full output, in-place mutation is what the model sees, MCP covered

**SDK contract** (index.d.ts lines 249–258):

```ts
"tool.execute.after"?: (input: {
    tool: string;
    sessionID: string;
    callID: string;
    args: any;
}, output: {
    title: string;
    output: string;
    metadata: any;
}) => Promise<void>;
```

**Host invocation sites — all three classes of tools:**

1. **Built-in tools** (`session/tools.ts:122`): after `item.execute`, the hook receives the result object `{title, output, metadata, attachments?}`; `return output` (line ~128) returns the SAME mutated object, which flows into `completeToolCall` / the persisted tool part and the next LLM request. [V]
2. **MCP tools** (`session/tools.ts:421`): after the MCP `execute()` returns `result`, the hook fires with `input.tool = key` (the MCP tool name) and the result as output. **MCP tools are covered.** [V]
3. **Task tool** (`session/prompt.ts:390`): fires for subagent results too. [V]

**[C] CT N3 satisfied:** a hook can rewrite `output.output` (the string the model sees) in place to append ledger/provenance text. Caveat: because the mutated object is persisted, the mutation is durable in session history, not wire-only — appending provenance every call would accumulate across turns unless keyed off `args`/`callID`.

---

## N4: Session identity + history access

### PluginInput APIs — [V]

`PluginInput` (index.d.ts lines 36–46):

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;  // full typed HTTP API client
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void };
    serverUrl: URL;
    $: BunShell;
};
```

`client` exposes the full typed server API, including `client.session.messages({ sessionID })` → `SessionV1.WithParts[]` — the whole conversation (user prompts + AI responses) is readable for rebuilding a delivered-facts ledger. [V — route defined at `server/routes/instance/httpapi/groups/session.ts:179–190`, handler `handlers/session.ts:278` calls `session.messages({sessionID})`.] `client.session.prompt(...)` also exists (groups/session.ts:316) if a plugin ever needs to initiate a turn.

### /compact behavior — [V]

- Compaction (`session/compaction.ts`) runs a separate LLM call that ALSO passes through `experimental.chat.messages.transform` (line 379, on a `structuredClone(selected.head)` — so a naive append-on-every-call plugin would inject into the compaction summary prompt too; gate on input or detect via the compaction agent).
- Compaction **hides** prior messages from future context (lines 340–368: `hidden` set, replay logic) rather than deleting them; storage keeps them. A ledger persisted as message parts survives in storage but drops out of LLM context.
- **The carry-over mechanism:** `experimental.session.compacting` (index.d.ts:283–288) — output `{ context: string[]; prompt?: string }` — lets a plugin append `context` strings into the compaction prompt itself. This is the sanctioned hook to re-inject a delivered-facts ledger into the post-compact context. [V]

---

## Capability Table

| # | Capability | Status | Mechanism |
|---|---|---|---|
| N1 | Per-turn trigger with user text | ✅ YES | `chat.message` — prompt.ts:999; sees `output.message`+`output.parts` pre-persist; async hook blocks; in-place mutation persisted + sent |
| N2 | Cache-safe append channel, wire-only, system prompt untouched | ✅ YES | `experimental.chat.messages.transform` — prompt.ts:1255; full history as `structuredClone`; mutations reach `toModelMessagesEffect` → wire; persisted history untouched; system prompt is a separate transform |
| N3 | Tool-result transform incl. MCP | ✅ YES | `tool.execute.after` — tools.ts:122 (built-in), tools.ts:421 (MCP, `input.tool` = MCP tool name), prompt.ts:390 (Task); mutate `output.output` in place |
| N4 | Session identity + history + /compact survival | ✅ YES | `PluginInput.client.session.messages()` for full history; `experimental.session.compacting` to carry ledger across compaction |

## Final Verdict

**Full live delivery feasible on OpenCode.**

Partial-tier options (if CT wants stricter guarantees than the hooks give):
- Read-only observation fallback: `event` hook (`message.updated` / `message.part.updated`).
- Metadata-only channel: `chat.params` / `chat.headers` (no content injection).

## Residual risks / caveats

- `chat.message` mutations are **persisted**, not wire-only — CT facts injected there become permanent parts of the user message (replayed on every future LLM call, good for ledger durability; bad if wire-only is desired). For wire-only appends use `messages.transform`.
- `tool.execute.after` mutations are also persisted (mutated object returned by the host) — append-style rewrites accumulate unless keyed off `args`/`callID`.
- `messages.transform` fires on the compaction LLM call too (compaction.ts:379) — a per-turn append plugin must detect/gate that path (e.g. via `experimental.session.compacting` ordering or input inspection).
- Both `messages.transform` input and `chat.message`'s `input` lack an explicit "this is a compaction/subagent call" flag in the 1.18.31/1.18.35 type contract — discrimination must be heuristic. [V on absence; C on consequence]

NOT CHECKED

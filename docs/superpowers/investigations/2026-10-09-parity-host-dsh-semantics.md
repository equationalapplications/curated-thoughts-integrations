# DSH tarball semantics: Q1 (pre-step persistence) & Q2 (post-execute ownership)

Investigated from extracted npm tarballs in /tmp/dshprobe/x/ (0.1.5-rc.2 / 0.2.1-alpha.2 lines;
dsh-tools 0.1.5-rc.2 and 0.2.1-alpha.2 were additionally npm-packed for the check).
Tags: [V] = read in tarball, [C] = inferred.

---

## Q1 — Is `agent/pre-step` decision message mutation PERSISTED or WIRE-ONLY?

**Verdict: PERSISTED.** The decision's `messages` array is committed to the durable session
log as `user/message` events before the model request is built; the outgoing request is then
*derived* from that log (`session.deriveMessages()`), so a later history read sees the
mutation and the provider request prefix is stable across retries.

### Evidence

1. Decision shape [V] — `dsh-agent-0.2.1-alpha.2/package/lib/types/runtime-types.d.ts:92-99`:
   ```ts
   export type PreStepDecision = {
       kind: 'reject';
   } | {
       kind: 'enter';
       messages: UserMessage[];
       startsRequestSeries?: true;
   };
   ```
   (0.1.5-rc.2 line has the identical shape in
   `dsh-agent-0.1.5-rc.2/package/lib/types/runtime-types.d.ts:310` area.)

2. The loop claims inbox messages, then dispatches the waterfall [V] —
   `dsh-agent-loop-0.2.1-alpha.2/package/lib/index.js:902-924` (`preStep`):
   ```js
   const claimed = this.inbox.claim(target, position.turn);
   const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ... }, () => ...)
   ```
   Same code at `dsh-agent-loop-0.1.5-rc.2/package/lib/index.js:887-894` (identical on both
   version lines). The default `next()` just wraps the claimed messages, so whatever the
   listeners' folded decision returns is the authoritative batch.

3. The decision's messages are durably appended [V] —
   `dsh-agent-loop-0.2.1-alpha.2/package/lib/index.js:1067-1073` (inside `step(decision)`):
   ```js
   if (firstAttempt) for (const message of decision.messages) if (message.source.kind === "runtime-context") {
       ... this.session.append("user/message", context, { surfaceOp: "append" }); ...
   } else this.session.append("user/message", message, { surfaceOp: "append" });
   ```
   `this.session.append(...)` is the durable session-log write (the same call that records
   `turn/start`, `assistant/message`, `tool/result` etc.). 0.1.5-rc.2 equivalent:
   `dsh-agent-loop-0.1.5-rc.2/package/lib/index.js:1028`:
   `if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });`

4. The provider request is built FROM the log, not from the in-memory decision [V] —
   `dsh-agent-loop-0.2.1-alpha.2/package/lib/index.js:1286-1294` (`buildRequest`):
   ```js
   const boundaryMessages = session.deriveMessages();
   ...
   return markAgentLoopRequest(Object.freeze({ ...header.config, messages: boundaryMessages, ... }));
   ```
   So the model sees exactly what was persisted. Retry stability: the `while(true)` attempt
   loop in `step()` appends decision messages only when `firstAttempt` (line 1067); on
   `agent/request-error` retries it rebuilds the request from the unchanged durable log —
   no duplicate, no drift [V], with [C] confirmation from the `request/header`
   `reason: "initial" | "resume" | "change" | "series"` event bookkeeping at index.js:1225-1245.

5. Persistence is not merely in-memory: `session` is the durable session store —
   `dsh-session-0.2.1-alpha.2` and `dsh-session-persistence-jsonl` (listed in
   dsh-hooks-codex devDependencies, package.json:51) provide the JSONL persistence layer;
   dsh-agent-loop's inbox itself is a durable projection ("Driver-owned durable agent inbox
   projection", `dsh-agent-loop-0.2.1-alpha.2/package/lib/index.js:16`, folded from
   `agent/inbox/spliced` events, lines 26-58) [V]. Rejected steps: claimed messages are NOT
   re-appended or discarded — "If the proposed step is rejected, the claimed message ends
   here: it is neither discarded nor re-emitted as a user/message" (runtime-types.d.ts,
   `agent/inbox/claimed` doc, ~line 275) [V].

6. Contrast that confirms intent: the sibling `agent/request` waterfall explicitly CANNOT
   mutate messages — "Model-visible content must use logged channels; this waterfall cannot
   mutate messages" (runtime-types.d.ts, `agent/request` doc, ~line 330) [V]. `agent/pre-step`
   has no such restriction precisely because its decision goes through the logged
   `user/message` commit path.

---

## Q2 — Is `tools/post-execute` a CORE plugin event or codex-bridge-internal?

**Verdict: CORE.** `tools/post-execute` is declared in the event map of
**`@deepseek-ai/dsh-tools`** (the tool registry / execution pipeline), in BOTH version
lines. Any DSH-native plugin with a context can register with `ctx.on("tools/post-execute", ...)`.
The codex bridge is merely a consumer; no dependency on `@deepseek-ai/dsh-hooks-codex` is needed.

### Evidence

1. Declaration [V] — `dsh-tools-0.2.1-alpha.2/package/lib/types/index.d.ts:70` (npm-packed;
   package description, package.json:3: "Tool registry and execution pipeline for the
   DeepSeek Harness"):
   ```ts
   'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution,
       result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
   ```
   Also `tools/pre-execute` at line 47 and `tools/execute` at line 61 — the whole
   tools/* event family lives here. Identical declaration in the older line:
   `dsh-tools-0.1.5-rc.2/package/lib/types/index.d.ts:61` [V].

2. `PostToolDecision` shape [V] — `dsh-tools-0.2.1-alpha.2/.../index.d.ts:465-479`:
   ```ts
   export type PostToolDecision = {
       kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[];
   } | {
       kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[];
   } | {
       kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[];
   };
   ```
   `additionalContexts` is a first-class field of the core decision type — not a bridge
   invention.

3. Core enforcement, not bridge plumbing [V] — the agent loop consumes it via the core
   scheduler: `dsh-agent-loop-0.2.1-alpha.2/package/lib/index.js:570`:
   ```js
   const result = slot.needsPost ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result) ...
   ```
   and `index.d.ts` of dsh-tools declares `finalize(exec, result): Promise<ToolExecutionResult>`
   with doc "Run post-execute and definition-owned content finalization..." (line 363-364).
   The loop then feeds `result.additionalContexts` to the next step boundary
   (`dsh-agent-loop-0.2.1-alpha.2/package/lib/index.js:572`:
   `for (const context of result.additionalContexts ?? []) acceptContext(context);`).

4. The codex bridge is just a listener [V] —
   `dsh-hooks-codex-0.2.1-alpha.2/package/lib/index.js:250` (and 245 in 0.1.5-rc.2/0.1.6/0.1.7/0.2.0):
   ```js
   ctx.on("tools/post-execute", async (exec, result, next) => { ... });
   ```
   It registers against the ordinary context API like any plugin; its README (README.md:85)
   describes `tools/post-execute` as "a waterfall that can block with feedback or add context
   to the downstream decision" mapped from codex's PostToolUse — i.e. the bridge adapts
   codex semantics ONTO the core event.

5. Grep across all extracted tarballs [V]: the string `tools/post-execute` appears only in
   dsh-tools (declaration + scheduler), dsh-agent-loop (scheduler invocation), and the
   hooks-codex / hooks-claude-code bridges (listeners) — no bridge-private registration
   surface exists.

### Port implication [C]
A DSH-native integration should register `ctx.on("tools/post-execute", ...)` directly
(event declared by `@deepseek-ai/dsh-tools`), and implement `agent/pre-step` listeners
knowing their enter-decision messages become durable `user/message` history entries on
first attempt and define the provider request prefix on retries.

---

## Summary verdicts
- **Q1: PERSISTED.** `PreStepDecision.enter.messages` → `session.append("user/message", ...)`
  before request build; request derives from `session.deriveMessages()`; retries reuse the
  committed prefix. Wire-only is false.
- **Q2: CORE.** `tools/post-execute` is declared by `@deepseek-ai/dsh-tools` (both 0.1.x and
  0.2.x lines) and dispatchable by any plugin via `ctx.on(...)`; the codex bridge only
  consumes it.

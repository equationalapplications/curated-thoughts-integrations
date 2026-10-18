# Intuitive Wisdom: recall dedup (N3) for CT recalls through OpenClaw's `tool_call` — design

**Date:** 2026-10-17 · **Status:** Approved (user, 2026-10-17) · **Branch:** `docs/openclaw-meta-recall-n3-spec` ·
**Base:** `origin/main` @ `0b7729c`
**Release:** openclaw 0.3.4 → 0.3.5 (host pin `openclaw@2026.10.3`, unchanged)
**Builds on:** [`2026-10-17-openclaw-autonomous-work-wisdom-design.md`](2026-10-17-openclaw-autonomous-work-wisdom-design.md)
(implementation finding 2, review amendment 5, known limitation 9) and the OpenClaw live leg
[`2026-10-16-openclaw-wisdom-parity-leg-design.md`](2026-10-16-openclaw-wisdom-parity-leg-design.md) (facts F1–F15).

Tags: **[V]** verified in this session by reading the cited file in the pinned `openclaw@2026.10.3`
package (installed with `--ignore-scripts` in the session scratchpad, read as data, never imported
into this repo, never committed), by reading this repo, or by a scratchpad prototype; **[V live]**
verified earlier by a live run of the pinned host and cited from the parent spec. **[U]** unverified;
carried as an e2e target. OpenClaw paths are relative to the package's `dist/`; the hashed file
suffixes are those of the pinned tarball.

## Problem

INTENT rule 1 says: "If the agent runs a CT search itself, facts it already has come back as short
'already in context' stubs." The OpenClaw plugin does this (the N3 recall dedup) when the model calls
`curated_recall_context` directly. OpenClaw can also expose MCP tools through its generic `tool_call`
meta tool (deferred tools). A recall made that way reaches the middleware as a `tool_call` result
whose text wraps the recall, so N3 does not recognise it and the agent may see a fact it already has.
The ids already join the run ledger (parent spec, amendment 5), so injection stays exactly-once; only
the recall result repeats. This spec closes that gap.

## Phase 0: pinned host facts (openclaw 2026.10.3)

**M1. The middleware sees the outer `tool_call` result [V live].** With the stub CT sidecar mounted,
the model called `tool_call` with `args.id = "mcp:curated-thoughts:curated-thoughts__curated_recall_context"`;
the tool-result middleware received `toolName: "tool_call"` (parent spec, implementation finding 2).
A middleware-returned result is what OpenClaw persists and replays (parent spec, A3 [V live]).

**M2. The result text is the 2-space JSON of `{tool, result}` [V].** `tool-search-Bw0pvXCm.mjs:1338–1356`:
`tool_call`'s `execute` builds `formatToolSearchControlResult({tool: {id, name, source}, result:
callResult.result}, runtime, {parentToolCallId})` and sets `details: callResult`.
`formatToolSearchControlResult` (`:1158–1165`) calls `serializeToolSearchControlResult(payload,
options.compact)`, which is `JSON.stringify(payload, null, compact ? undefined : 2)`
(`code-mode-json-DLneEPkt.mjs:232–234`). This call site passes no `compact`, so the body is always
2-space JSON. The result is `textResult(text, payload)`: one text part, plus `details`.

**M3. The wrapper is conditional [V].** `renderToolSearchControlText(text, networkContent)`
(`code-mode-json-DLneEPkt.mjs:236–248`) returns the text unchanged when `networkContent` is false.
When true (the nested call touched the network; the MCP call did live, M1), it bounds the text to
20 000 characters (a longer text is cut and gets `"\n[truncated]"`, so it is no longer JSON) and wraps
it with `wrapExternalContent(modelText, {source: "api"})`.

**M4. The wrapper's layout [V].** `external-content-Bkm4w5qo.mjs:210–231`: the text is
`[warning + "\n\n", "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"<16 hex>\">>>", metadata, "---", sanitized,
"<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"<16 hex>\">>>"].join("\n")`. The metadata lines have their
newlines removed (`:214`), so the first `"\n---\n"` ends the header. `sanitized` has had
`replaceMarkers` applied (`:206–207`), so the real end marker is the last one in the text.

**M5. Today's code already reads both shapes [V].** `metaRecallIds`
(`integrations/openclaw/src/wisdom/activity.ts:299–347`) strips an optional wrapper (first
`"\n---\n"`, last end marker) and parses `{tool, result: {content: [...]}}`; a bare-JSON text works
too. It feeds the run ledger or marks the run blind (`meta_unreadable`). N3 runs only when
`isRecallToolName(event.toolName)` (`src/index.ts:395–397`), so it never sees `tool_call`.

**M6. Re-serialising is byte-exact for the verified shape [V prototype].** A scratchpad prototype
split a wrapped fixture into head, body and tail. `JSON.stringify(JSON.parse(body), null, 2)`
returned the body byte for byte, including non-ASCII, U+2028 (line separator) and quotes inside fact text, so the
no-op rewrap was byte-identical. After stubbing one entry and appending a marker, the head and tail
were unchanged and `scanIds` over the outer text found both ids (markers survive JSON string
escaping: `<!-- ct-fact:<id> -->` has no character JSON escapes). A compact body failed the
round-trip check and was refused.

## Design

### Overview

A new pure module `integrations/openclaw/src/wisdom/meta.ts` unwraps a `tool_call` text part into
head, `{tool, result}` and tail, and rewraps it. The middleware gets a second N3 branch: for a
`tool_call` recall it hands the inner `result` to the shared core's unchanged `onToolResult`, then
puts the rewritten inner result back in the same place. Only bytes inside the JSON body change.
Anything this code is not sure about stays exactly as OpenClaw produced it, which is today's
behavior.

### `meta.ts` (pure, never throws; `metaToolResult` writes the ledger cache through the adapter)

- `unwrapMeta(text: string): MetaParts | null`
  - Head: if the text contains `"\n---\n"`, everything up to and including its first occurrence;
    else `""`. Tail: if the text contains `"<<<END_EXTERNAL_UNTRUSTED_CONTENT"` after the head, from
    its last occurrence to the end; else `""`. A head without a tail, or a tail without a head, is
    `null` (not the M4 layout).
  - Body: the rest, minus its leading and trailing whitespace, which are kept as `lead` and `trail`.
  - `null` unless the body parses as JSON, **`JSON.stringify(parsed, null, 2) === body`**, `parsed` is
    an object with an object `tool` and `result.content` an array.
  - Returns `{head, lead, outer: parsed, trail, tail}`.
- `rewrapMeta(parts: MetaParts): string` is `head + lead + JSON.stringify(outer, null, 2) + trail + tail`.
- `metaRecallIds` moves here from `activity.ts` (re-exported there, so imports keep working) and
  uses `unwrapMeta` for the outer layer. Its "unreadable" rule is unchanged. It also accepts an inner
  envelope followed by N3 marker lines (an inner text whose JSON prefix parses once trailing
  `\n<!-- ct-fact:<id> -->` lines are removed), so a rewritten result reads the same ids.

The byte-exact round-trip check is what makes a rewrite safe: a body in any other format (compact,
truncated, a future OpenClaw change) is never rewritten.

### Middleware branch (`src/index.ts`)

Next to the existing N3 branch, before `activity.process`:

- **When:** `event.toolName === 'tool_call'`, `event.isError !== true`, and `event.args.id` is a
  string whose last `:`-segment passes `isRecallToolName` (the test `metaRecallIds` already uses).
- **What:** for each `content` part of `event.result` that is a text part and unwraps, build the stand-in
  result `{content: outer.result.content}` and run `onToolResult(adapter, {id: sessionKey}, stand-in)`.
  If it returns a different object, set `outer.result.content` to its `content` and replace that part's
  text with `rewrapMeta(parts)`. Parts are processed in order; the core's ledger cache makes a second
  part see the first part's ids (as it does for a second direct recall).
- **Untouched:** other parts, other part fields, `details` (the raw call result; the model-context
  projection strips tool-result `details`, parity-leg fact F9 [V], and the direct N3 path leaves
  `details` alone too), and any part that does not
  unwrap.
- **Errors:** the existing `try` around the middleware body still applies; on a throw the original
  `event.result` is returned (rule 4).

Everything else comes unchanged from the core and the adapter: repeats become `{id, in_context: true,
note: "already in context: ct-fact:<id>"}`, new ids get one marker line each after the JSON of the first
recall block, and a blind or unknown view stubs nothing.

### Ledger and fail-closed (unchanged)

`activity.process` still runs after N3, on the rewritten result: `resultIds` scans markers and stub notes,
`metaRecallIds` reads the envelope ids, and an unreadable result still marks the run `meta_unreadable`.
`onToolResult` also caches the ids into the run's N3 cache, which joins the run ledger (`adapter.ts`
`cacheLedger`). The next run's snapshot sees the markers in the persisted text (M6).

### Safety

- Bytes outside the JSON body (OpenClaw's warning, the random marker id, the metadata and the end marker)
  are never changed (M4, M6).
- All this code adds is stub objects and `<!-- ct-fact:<id> -->` lines, and only for ids that pass
  `validId`. Neither can form an `EXTERNAL_UNTRUSTED_CONTENT` marker or an LLM special token. That
  covers only what we add, not what we re-encode (see the review amendment below).
- Boundary guard: the rewrite re-serialises the inner envelope, so a JSON `\uXXXX` or `\/` escape in a
  kept entry, which OpenClaw's sanitiser saw as plain ASCII, would come out as the literal character.
  `metaToolResult` counts marker look-alikes (after OpenClaw's character folding and NFKC) and LLM
  special tokens (the list mirrors openclaw 2026.10.3 `LLM_SPECIAL_TOKEN_PATTERN`) in the original
  part and in the rewritten one. When the rewritten part has more, that part is left unchanged.
- A part is rewritten only when its inner `tool.id` equals the call's `args.id`.

**Review amendment (final review, 2026-10-17).** The earlier Safety claim covered only the stubs and
marker lines this code adds. Re-serialising a kept entry can decode escapes that passed OpenClaw's
sanitiser, which could forge an end marker or a special token after the sanitiser ran. The boundary
guard above closes that hole. It fails quiet: a refused part is delivered as OpenClaw sent it, with no
dedup for that result.
- No new process, file, network call or dependency.
- Size: a stub is usually shorter than the entry it replaces; each new id adds one marker line
  (about 30 characters), as on the direct path. OpenClaw's 20 000-character bound runs before the
  middleware (M3), so a rewritten text may exceed it by those lines.

## Alignment with INTENT.md

- **Rule 1 (at most once):** this is the rule's "already in context" stub for recalls the agent runs
  through `tool_call`, the one route that still skipped it. The ledger handling is unchanged.
- **Rule 2 (never edit the system prompt):** it only rewrites a tool result in the middleware, which
  OpenClaw persists once and replays as is (A3).
- **Rule 4 (fail quietly):** any doubt leaves the result unchanged; the middleware never throws.
- **"Where a host can't, its spec says why":** OpenClaw's known limit 9 (parent spec) is removed.

No departure from INTENT.md.

## Testing

- **Unit (`tests/test_meta.ts`):** `unwrapMeta`/`rewrapMeta` on wrapped and bare texts (byte-identical
  no-op round trip); refusals: compact body, truncated body (`[truncated]`), non-JSON, head without tail,
  wrong shape (`result` missing, `content` not an array); fact text with quotes, non-ASCII and U+2028 (line separator).
  `metaRecallIds` reads the same ids before and after a rewrite.
- **Middleware (`tests/test_review_fixes.ts` §5, extended):** a repeat through `tool_call` comes back
  stubbed inside an unchanged wrapper; a new fact gets a marker; a direct recall then a `tool_call` recall
  of the same fact stubs the second; two `tool_call` recalls in one run stub the second; a blind run
  (after compaction) stubs nothing; a refused shape is returned as the same object; `details` is
  untouched; a second middleware pass over the same result is still a no-op.
- **Exactly-once (`tests/test_exactly_once.test.ts`):** the randomized sessions also route some recalls
  through `tool_call` (wrapped and bare); no fact id appears as a full entry twice in one run's view.
- **Live e2e (`tests/e2e/run_activity.sh`):** add a second `tool_call` recall whose stub-CT reply repeats
  a fact already in context; the check is that the next model request carries the stub inside the
  wrapper, not the full entry [U, target].

## Versioning and docs

- openclaw 0.3.5: `integration.yaml`, `package.json`, `openclaw.plugin.json`, `PLUGIN_VERSION`, README
  table; CHANGELOG entry under a `## 0.3.5 — <date>` heading.
- `integrations/openclaw/README.md`: remove the "Known limit" paragraph about `tool_call`.
- Parent spec: mark known limitation 9 as closed by this spec.

## Out of scope

- Other hosts: none has a meta-tool route.
- `details`: it holds the raw call result for OpenClaw's own use; rewriting it would change what OpenClaw
  stores, not what the model sees.
- Truncated or compact bodies: they are never rewritten (their ids still join the ledger, or the run
  goes blind, as today).
- On this route the inner `result.details` (`mcpServer`, `mcpTool`, and `structuredContent` if any) is
  serialised into the model-visible text. CT returns text only today. If CT ever emits
  `structuredContent`, it would carry full entries unstubbed. That is no worse than before this change.
- The live e2e does not yet assert that the full entry is absent next to the stub. That check will be
  added on the next live run. The property and unit tests cover it.

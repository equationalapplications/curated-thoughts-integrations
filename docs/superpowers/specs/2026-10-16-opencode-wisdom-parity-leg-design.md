# OpenCode leg: cross-harness Intuitive Wisdom parity (opencode 0.1.2 → 0.2.0), design

**Date:** 2026-10-16 · **Status:** Approved under delegated design authority (autonomous
brainstorming; the user delegated design judgment for this leg) ·
**Repo:** equationalapplications/curated-thoughts-integrations ·
**Branch:** `feat/opencode-parity` (resumes WIP `4cf17ff`, merged with `origin/main` @ `b36123b`)
**Parent spec:** `2026-10-09-cross-harness-wisdom-parity-design.md` (decisions 3, 5, 6, 8;
OpenCode row of the adapter-contract table; AC 1–11; annex A). This document refines
the parent for the OpenCode leg only. Where the two disagree, the parent's **decisions**
win and this document's **host facts** win: the parent was written before anyone read
the 1.18.35 binary, and three of its OpenCode assumptions turn out to be wrong (LD2, LD3, LD5).
**Sibling implementation:** the DSH leg (`integrations/deepseek/src/wisdom-live/adapter.ts`,
deepseek 0.4.0).

## Problem

The 2026-10-10 WIP (`4cf17ff`) ported the adapter shape from DSH, but it was never run
against the real host. Reading the pinned 1.18.35 binary (its bundled JS is readable with
`strings`) turned up five defects that unit tests built on the WIP's own assumptions
could not catch:

1. **N3 is dead.** OpenCode names MCP tools `<server>_<tool>` (`Z1(client)+"_"+Z1(tool)`),
   so the WIP's `__curated_recall_context` suffix never matches. Also, for MCP tools the
   `tool.execute.after` output is the raw MCP `CallToolResult` (`{content:[{type:"text",text}],…}`).
   The host builds the persisted `state.output` from `content[].text` *after* the hook
   returns. The WIP rewrote `output.output`, which MCP results do not have.
2. **The payload cannot load.** `lib/src/index.js` imports the bare specifier
   `@equational-applications/ct-wisdom-core`. The installed payload has no
   `node_modules/`, by policy and by test, so the import throws and the whole plugin,
   v0 health block included, fails to load.
3. **The bootstrap never renders.** `renderWisdom({agent})` keys its memo by `agent.id`.
   OpenCode's `chat.message` input `agent` is a string, so `keyOf` returns `''` and
   rendering is skipped. The WIP also re-rendered the bootstrap in every new process
   (`opencode run --continue`), and it never recorded the bootstrap's ids, so live
   delivery could repeat a bootstrap fact on turn 1.
4. **Compaction ran backwards.** `beginCompaction` dropped the memo ids for one rebuild
   ("dropped ids are forgotten"). Parent decision 3 (m3) requires the opposite:
   post-compaction ledger = pre-compaction ledger ∪ deliveries.
5. **The query mixed in synthetic text.** `userMessageText` joined every text part,
   including the bootstrap part pushed earlier in the same invocation and host-synthetic
   parts (`Called the Read tool…`). The self-trigger guard (AC 11) needs the query to come
   from genuine user text only.

## Host facts (verified in the 1.18.35 binary, 2026-10-16)

These were read from `opencode-darwin-x64@1.18.35/bin/opencode` and are pinned here so
they don't need re-deriving:

- **H1 `chat.message` ordering.** `createUserMessage` resolves the parts, gives every one
  an id (`Ge`: `id ? PartID.make(id) : PartID.ascending()`), then
  `trigger("chat.message", {sessionID, agent, model, messageID, variant}, {message, parts})`,
  then validates the message and parts (invalid entries are only **logged**), then
  `updateMessage` and `updatePart` for each part. So: (a) parts pushed by the plugin are
  persisted; (b) they skip `Ge`, so the plugin must supply a well-formed `prt_` id;
  (c) the in-flight message is **not** in the persisted history while the hook runs.
- **H2 Part id format.** `prt_` + 12 hex chars of `ms*4096+counter` (48-bit, big-endian)
  + 14 base62 chars. Ascending ids sort after earlier parts.
- **H3 History.** `GET /session/{id}/message` with no `limit` returns **every** message
  (`Session.messages({sessionID})`). It is not compaction-filtered: `filterCompacted`
  runs only when the prompt loop builds model input. Compaction appends an assistant
  `summary:true` message and leaves earlier rows in place. Pruning sets
  `state.time.compacted` on old tool parts but keeps `state.output`.
- **H4 Compaction hook.** `experimental.session.compacting({sessionID}, {context:[], prompt})`
  fires inside `SessionCompaction.process` before the summary call. Auto-continue
  after compaction writes its user message with `updateMessage`/`updatePart` directly,
  so `chat.message` does **not** fire for it.
- **H5 MCP N3 shape.** `tool.execute.after({tool, sessionID, callID, args}, m)` where `m`
  is the MCP `CallToolResult`. After the hook, `output = content.filter(text).join("\n")`,
  which is persisted as `state.output` and sent to the model. Builtin tools keep
  `{title, output, metadata}`.
- **H6 MCP tool name.** `sanitize(server) + "_" + sanitize(tool)`, with sanitize =
  `/[^a-zA-Z0-9_-]/g → "_"`. The shipped install names the server `curated-thoughts`,
  so the recall tool is `curated-thoughts_curated_recall_context`.
- **H7 Subagents.** The task tool runs `SessionPrompt.prompt` in a child session, which
  fires `chat.message` with the child `sessionID`. `Session.parentID` (SDK `Session` type)
  identifies a child, and `client.session.get({path:{id}})` returns it.
- **H8 Pin.** npm `latest` for both `opencode-ai` and `@opencode-ai/plugin` is 1.18.35
  (verified 2026-10-10; binary `--version` = `1.18.35` 2026-10-16). The SDK hook types
  are byte-identical between 1.18.31 and 1.18.35 (parent decision 2).

## Leg decisions (LD)

**LD1: Channels (unchanged from parent decision 3).** N1 and N2 both use `chat.message`.
The delivery is a `synthetic: true` text part pushed onto `output.parts`, persisted by
the host (H1). N3 uses `tool.execute.after`. `experimental.chat.messages.transform`
is never used for delivery.

**LD2: N3 on the real MCP shape.** The adapter handles a recall result in either of
two shapes:
(a) the OpenCode MCP `CallToolResult`: the rewrite targets the **first** `content[]`
text item whose line 1 parses as a recall envelope;
(b) a plain string, kept for builtin-style outputs and for tests.
A recall envelope is a JSON object with a `wiki_entries` array, or the Hermes wrapper
`{"result":"<that JSON>"}`. Line 1 only, per the ct-fact trailer landmine. Rewriting
**preserves every other key** of the inner object and of the wrapper (DSH and the WIP
dropped them; DSH is out of scope here and is flagged in the PR). The tool-name gate is
`name === "curated_recall_context" || name.endsWith("_curated_recall_context")`, which
covers `curated-thoughts_curated_recall_context` and the Hermes `mcp__…__` form, and
never matches `curated_get_wiki_entry` (m4).

**LD3: Payload resolution.** `pnpm run build` gains a step,
`node scripts/vendor_core.mjs`, that runs after `tsc`. It (1) copies the built core
(`packages/ct-wisdom-core/lib`) into `lib/ct-wisdom-core/`, the same staging
`release.yml` already does, so the two are idempotent; and (2) rewrites the one bare
specifier in `lib/**/*.js` to the relative path of `lib/ct-wisdom-core/index.js`. It
fails loudly if the core has not been built. The shipped payload then has only `node:`
and relative imports, and the existing archive walk proves it. The source-level policy
allows exactly that one specifier and nothing else. No installer change is needed:
`lib/` is already `PAYLOAD_REQUIRED`. A load test imports the unpacked archive's
`lib/src/index.js` with no `node_modules` and asserts `CuratedThoughts` is a function.

**LD4: Greenfield v1 bootstrap.**
- *Where:* a `synthetic: true` part on the session's **first** user message, marked
  `source.kind: curated-thoughts/wisdom-bootstrap`. It is persisted and cache-safe,
  and the system prompt is left alone. The v0 health block stays in the system
  transform, unchanged.
- *What:* `renderWisdom({agent:{id: sessionID}})` (seed query
  `curated thoughts agent memory wisdom procedures`, `ct recall --json --k 3`, 2500-char
  cap, `ct-fact:` markers on titles, sanitizer to a fixpoint). This is the DSH v1 module
  byte-for-byte, keyed by session id.
- *When (first-turn-only):* render only if the persisted history has no user row
  **and** this process has no memo record for the session. A later process
  (`--continue`) never re-renders. The bootstrap ids are already in the persisted
  history.
- *Memo:* `{block, ids: scanIds(block)}` per session. The ids join the **same turn's**
  ledger before the live call, so turn 1 can never live-deliver a bootstrap fact.
  `noteDelivered` does not write into the bootstrap memo; live ids live in their own
  per-process set (LD5).
- *Bootstrap completeness check (definition of done for N5):* each of the following has
  a test: seed query and argv pinned; block carries one marker per entry; memo ids equal
  the block's markers; first-turn-only across processes; same-turn exclusion of
  bootstrap ids; bootstrap ids don't count toward the live budget; forged `ct-fact:`
  text in a fact can't add an id (AC 5); a missing or failed `ct` renders nothing and
  doesn't break the turn.

**LD5: Ledger and compaction carry-forward.** Ledger =
`scan(persisted history)` ∪ `carry[session]` ∪ `memo[session].ids` ∪
`delivered[session]`:
- the history scan covers user, assistant, and tool rows: non-ignored text parts plus
  completed tool `state.output`;
- `carry` is a per-process set. At `experimental.session.compacting` the adapter
  rebuilds from the pre-compaction history and adds every id to `carry`. It is never
  cleared for the life of the process;
- `delivered` holds ids this process delivered live. It covers the gap where a
  delivered part has not been persisted yet when the next trigger reads.
Because H3 keeps pre-compaction rows, carry-forward holds across processes as well, and
`carry` is the belt-and-braces guarantee should a future host start deleting compacted
rows. A user `revert` removes rows, and their ids are forgotten. That is accepted:
persisted history is the record (parent table). Ids are ordered newest first: history
scan order, then the other sources.

**LD6: Live budget (M1).** `liveDeliveredCount` counts distinct ids that appear in
user-row parts carrying the **live** marker (`source.kind: curated-thoughts/wisdom`,
exact line). Bootstrap parts and tool trailers don't count. Ids in `delivered` that are
not yet persisted are counted too.

**LD7: Subagent policy (parent decision 3, made concrete).**
`client.session.get({path:{id}})` is called once per session, and the result is
cached for the process.
- `parentID` set (child session): no bootstrap, no N1/N2 delivery (`deliveryEnabled`
  is false). N3 still runs. Its ledger is the child history ∪ the parent history,
  fetched best-effort. If the parent fetch fails, it uses the child history alone.
  A missing stub is the parent spec's named cross-session risk; a wrong stub is
  impossible.
- `parentID` absent: a parent session, with full behaviour.
- Lookup fails or returns no data: treat as a child (fail-safe, no delivery). If the
  lookup fails, the history fetch would almost surely fail too, and a turn without
  delivery is the safe degradation.

**LD8: Self-trigger guard (AC 11).**
(1) `chat.message` is a hook invoked by `createUserMessage`, not an event. Appending
parts can't re-enter it, and the auto-continue message doesn't pass through it (H4).
(2) Idempotence: if `output.parts` already holds any part of ours (live or bootstrap
marker), the hook returns without spawning anything.
(3) The query is built from **non-synthetic, non-ignored** text parts only. Our own
parts and host-synthetic parts never feed `ct wisdom match`.
(4) A message with no genuine text (all synthetic) is a no-op, so a synthetic append
in history can't trigger delivery on a later turn either.

**LD9: Part ids.** Every plugin part gets a host-format ascending `prt_` id (H2),
generated by a local helper that mirrors the host algorithm.

**LD10: Restore.** `restored()` is false: OpenCode resumes rebuild from the same
persisted history, so there is no separate restore path. `deliveryEnabled` is the
LD7 parent check. The breaker is per session, LRU 256. The capability latch is per
process: `ct wisdom match --help` exiting non-zero latches delivery off for the
process; a spawn failure resets discovery (n3).

**LD11: Host-contract CI job (AC 7).** Pin 1.18.35: `compatibility.json`
(`opencode`, `pluginSdk`, install strings) and `devDependencies.@opencode-ai/plugin`.
The existing `host-contract (opencode)` job gains no new steps, only a new test in
`tests/host/contract.test.ts` that runs the **real built payload** (`lib/` with the
vendored core) through the v0 loader file. It uses the fake provider (scripted: turn 1
calls `curated-thoughts_curated_recall_context`, and every later reply is text), a
stdio fake CT MCP server exposing `curated_recall_context`, and a stub `ct` on `PATH`
that answers `--help`, `recall`, and `wisdom match`. Two processes run (`run`, then
`run --continue`). Assertions:
(a) the turn-1 request carries the bootstrap block and the live block, each once;
(b) the tool result the host sent back to the model carries the stub or `ct-fact`
trailer (N3 on the real shape);
(c) the turn-2 request carries no second copy of any delivered id, though the stub
offers them again (exactly-once across processes through persisted history);
(d) `GET /session/{id}/message` (via `opencode export`) shows our parts persisted with
`synthetic: true` and `prt_` ids.
The CI job already builds the core before install (it auto-detects the dep), and the
build vendors it.

**LD12: Live e2e (AC 10).** This is a new step in `tests/e2e/e2e.sh`, run by `run.sh` in
Docker, on the real opencode 1.18.35, against the live ZAI model (`GLM-5.3-FLASH`,
Anthropic-compatible endpoint, key passed by name only). A test-only stub `ct`
(installed in the container, not shipped) returns one seeded fact ("the e2e fleet tire
pressure is 42 psi", id `e2e-fact-tire`) for `wisdom match`, and nothing for `recall`,
so no embedding backend is needed and none is run.
Turn 1 asks the tire pressure. The checks:
- the model's answer contains 42;
- the exported session holds exactly one live part with the marker and `synthetic: true`.
Turn 2 (`--continue`) asks again. The checks:
- the stub saw `--exclude=e2e-fact-tire`;
- the session still holds exactly one copy.
Without `ZAI_API_KEY` the step SKIPs and the PR records "AC 10 pending".
`run.sh` builds the core first, and the build vendors it. `pnpm -s` is replaced by
`pnpm run --silent` (pnpm ≥ 10 dropped `-s`).

## Acceptance mapping (parent AC → this leg)

| AC | How this leg proves it |
|---|---|
| 1 | core suite green (unchanged core) + opencode adapter unit suite against the core's `HostAdapter` |
| 2 | `test_wisdom_live_exactly_once.test.ts`: 200 seeded random sessions mixing N1 turns, N3 recalls (both shapes), compaction, process restarts (memo/carry loss), child sessions, cross-session recall. Oracle: no id delivered twice per session tree; the parser reads line 1 only |
| 3 | ledger-semantics tests: ledger = history scan ∪ carry ∪ memo ∪ delivered; post-compaction ⊇ pre-compaction ∪ deliveries; the next N1 reads exactly what the host would return |
| 4 | capability absent → no spawn after the latch; breaker opens after 3 fails for 300 s; child or unknown session → no delivery, N3 intact; bootstrap failure → turn proceeds |
| 5 | forged `ct-fact:` in fact text/title can't add an id (live + bootstrap renders); forged markers in user text only suppress |
| 6 | `integration.yaml` 0.2.0 ↔ `package.json` 0.2.0 (version_mirror); pins 1.18.35 |
| 7 | host-contract job (LD11) + the existing matrix |
| 8 | CHANGELOG `## 0.2.0 — 2026-10-16`; opencode README section (the top-level README is revised separately) |
| 10 | LD12 live e2e |
| 11 | LD8 tests (idempotent re-fire, synthetic-only message, our part never in the query) + the host contract's single-delivery assertion |

AC 9 is OpenClaw-only.

## Out of scope

- `packages/ct-wisdom-core`: no changes needed. The rewrite runs through the adapter's
  `rewriteEnvelopeStub`.
- `integrations/deepseek`: the dropped-inner-keys behaviour (LD2) is flagged in the PR
  but not changed.
- The top-level README.
- Tags and releases: tagging is the controller's job after merge.

## Notes folded in from the 2026-10-10 handoffs (handoff files removed from the tree)

- pnpm copies `file:` deps at install time: build the core before the consumer's install.
- GitHub Windows' default shell is pwsh: POSIX `run:` steps need `shell: bash`.
- Release probes stay anchored to `$GITHUB_WORKSPACE`. Same-name tag re-pushes don't
  re-fire the release. Verify releases at the byte level (download, `sha256sum -c`,
  grep the tarball for `lib/ct-wisdom-core/index.js`).
- e2e `out/` must be world-writable before `docker run`.
- On this slow dev box, local timeouts in `test_ct_doctor`/`test_archive` (5 s vitest
  default) and the real sidecar in `test_ct_env` are environment noise, not regressions.

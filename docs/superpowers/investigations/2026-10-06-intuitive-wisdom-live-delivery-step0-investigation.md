# Intuitive Wisdom — relevance-timed mid-session delivery (Hermes) — Step 0 investigation

**Date:** 2026-10-06 · **Status:** investigation (pre-spec) · **Review state:** not yet reviewed
**Feature:** close the v1→v2 gap named in `INTENT.md` ("Intuitive Wisdom"): when a
curated-wisdom fact becomes relevant mid-session, it reaches the agent at that
moment, through cache-safe channels, ledger-deduped. Open decisions carried in
from INTENT: matching trigger, judge involvement, delivery surface, ledger
ownership, scope-b labeling.

Tags: **[V]** = verified this session by re-reading the cited lines, **[A]** =
assumption the spec must close or carry as a Step-0 target in the plan.

Pinned sources:

- Hermes Agent `NousResearch/hermes-agent@ee8dd6c8` (2026-10-07 UTC+0530; a shallow
  clone in the session scratchpad, since this Mac has no `~/.hermes`). Earlier
  investigations pinned the Linux-installed copy at `~/.hermes/hermes-agent/`;
  line numbers below are from `ee8dd6c8` and need re-checking against whatever
  host version the plan pins.
- Curated Thoughts `curated-thoughts@f7d9f56` (2026-10-02).
- This repo @ `43f6330` (Hermes plugin 0.3.3).

---

## Target 1 — Mid-session host extension points

**[V] `VALID_HOOKS`** (`hermes_cli/plugins.py:109-...`) includes `pre_llm_call`,
`post_llm_call`, `pre_tool_call`, `post_tool_call`, `transform_tool_result`,
`transform_llm_output`, and the session lifecycle hooks.

**[V] `pre_llm_call` — once per user turn, context goes into the user message.**
`agent/turn_context.py:780-829` (`_collect_pre_llm_call_context`):

- kwargs: `session_id`, `task_id`, `turn_id`, `user_message`,
  `conversation_history` (a `list(messages)` copy), `is_first_turn`, `model`,
  `platform`, `parent_session_id`, `sender_id`;
- a result of `{"context": str}` or a non-empty `str` is collected; the pieces are
  joined with `"\n\n"`;
- docstring: "their context is injected into the user message (**never the system
  prompt**)";
- each piece goes through `spill_if_oversized` — `DEFAULT_MAX_CHARS = 10_000`
  (`tools/hook_output_spill.py:24`); larger output is moved to disk and replaced
  by a pointer;
- the whole function returns `""` when `agent._persist_disabled` is set (no
  persistence → no injection);
- exceptions are caught and logged at WARNING; the turn proceeds.

**[V] Cache safety of the user-message channel.** `compose_user_api_content`
(`turn_context.py:118-130`): "Single source for the `api_content` sidecar and the
wire bytes so they never drift (**what turn N sends is what turn N+1 replays**)".
`_stamp_api_content_sidecar` (`:919-966`): "persist what you send: injected
context lives only in the API copy, so stamp the exact sent bytes on the live
dict for replay", including the in-place-compaction and early-flush races
(`set_message_api_content` / `set_latest_user_api_content`). Multimodal turns
carry the context as a durable text part (`_append_multimodal_context`,
`:969-1000`). Skipped only for MoA and `codex_app_server` mode (`:1175-1189`) —
**[A]** whether those modes still deliver the context at all must be checked
(if they drop it, the feature is a silent no-op there, which is acceptable).

Conclusion: `pre_llm_call` is a **host-persisted, replay-stable append channel**
with the user's message in hand. That is exactly INTENT's "cache-safe channel
that never rewrites the frozen system-prompt block" — it is not a tool result,
so INTENT's "tool results are the v1-proven channel" wording needs widening.

**[V] `transform_tool_result`** (`model_tools.py:848-865`): runs after
`post_tool_call`, before the result enters context; kwargs `tool_name`, `args`,
`result`, ids (session/turn/tool-call), `duration_ms`, `status`; first `str`
return wins; fail-open. It fires for registry dispatch (`model_tools.py:959`) and
inline executors (`agent/inline_tool_executors.py:63-80`,
`agent/tool_executor.py:1789-1793`).

**[V] MCP sidecar tools pass through it.** MCP tools register into the shared
registry (`tools/mcp_tool_registration.py:353`) under the wire name
`mcp__<server>__<tool>` (`tools/mcp_tool_schema.py:173-175`), so they dispatch via
`handle_function_call` → `_apply_transform_tool_result_hook`.

## Target 2 — What does `conversation_history` contain?

**[V]** The system prompt is **not** in `messages`; it is prepended only at
API assembly (`turn_context.py:1329`: `[{"role": "system", ...}] + api_messages`).
So a `pre_llm_call` hook can see every prior user turn (with persisted
`api_content`), assistant turn and tool result — but **not** the bootstrap wisdom
block.

**[A]** Whether the history copies carry `api_content` (the injected bytes) or
only the clean `content`. The sidecar is popped by `substitute_api_content` at
assembly (`turn_context.py:133-...`); the plan must verify which form a hook
sees on turn N+1, and the ledger reader scans **both** fields regardless.

**[V] Restored prompt access.** The host stores the rendered prompt per session
(`hermes_state.py:511-517`, content-addressed `system_prompts` table) and
`SessionDB.get_session(session_id)` returns it as `_system_prompt_resolved`
(`hermes_state_sessions.py:866-875`). No plugin-facing API exposes it; the hook
kwargs carry no agent or DB handle. **[A]** Reaching it would mean opening
host-internal state — not a sanctioned extension point. Consequence carried to
the spec: a restored session whose bootstrap memo entry is missing **cannot know
its bootstrap fact ids** → mid-session delivery fails closed for that session.

## Target 3 — What does CT give us today?

**[V] `ct recall`** (`tools/src/queries.rs:431-459`): `--k` sizes the chunk leg
only; the wiki leg is `rank_wiki_entries(&conn, query, 5)` — a fixed 5.
**Exit 2 when there are no chunk hits**, even if wiki rows would match.

**[V] The wiki leg is lexical, not semantic** (`queries.rs:166-243`): every
whitespace token of length ≥ 2 is matched with `title LIKE '%t%' OR body LIKE
'%t%'`; rank = number of matching terms, then confidence, then `updated_at`. No
stopwords, no score in the output, no threshold. Fed a conversational message
("can you fix the bug in the login flow"), "the" and "in" match nearly every
entry. INTENT's v1 description ("semantic similarity") is wrong for the wiki
leg; v1 works because its seed query is hand-chosen.

**[V] Output fields per wiki entry:** `id`, `entity_id`, `title`, `text`,
`source_ref`, `confidence` (`queries.rs:217-224`). No provenance class, no
supersession field. The Hermes v1 parser keeps only `title`/`text`
(`integrations/hermes/scripts/ct_wisdom.py`, `recall_wiki`).

**[V] No session ledger in CT.** Nothing in `tools/` or `src-tauri/` keys wiki
delivery by session id. INTENT's "the ledger lives in CT's session context" is
unimplemented.

**[V] Supersession exists only deposit-to-deposit.** `okf/mod.rs:44-46`:
`supersedes: Option<String>` = "vault-relative path of the deposit this one
supersedes". There is no wiki-entry-id → superseded-wiki-entry-id mapping
exposed to recall. CT must resolve that before integrations can emit
`supersedes <id>` markers.

**[V] Sidecar MCP tools that return wiki entries:** `curated_recall_context`
(uses `rank_wiki_entries`, `curated_thoughts_mcp.rs:186-235`) and
`curated_get_wiki_entry` (`:253`).

## Target 4 — Decisions taken in brainstorming (owner, 2026-10-06)

1. **Two-repo spec.** CT ships a prerequisite read-only contract; Hermes
   consumes it behind a capability probe and no-ops on older CT.
2. **Ledger = the transcript.** Delivered facts carry a stable id marker; the
   ledger is rebuilt each turn from what the host already persists. No plugin
   persistence (consistent with the M1 ruling). CT stays read-only and accepts
   exclude ids.
3. **Trigger = each user turn** via `pre_llm_call`; query = the user message.
4. **CT gate = semantic wiki leg** with a CT-owned threshold; System One judge
   is a later CT-internal upgrade behind the same contract.
5. **Agent-initiated CT tool results** that repeat a delivered fact are stubbed
   to a one-line pointer via `transform_tool_result` (option A).

## Open items handed to the spec / plan

| # | Item | Owner |
|---|------|-------|
| O1 | Which history field (`content` vs `api_content`) the hook sees on turn N+1 | plan Step 0 |
| O2 | MoA / `codex_app_server` delivery of `pre_llm_call` context | plan Step 0 |
| O3 | Does in-place compaction keep or summarize injected `api_content`? (either is correct — see spec "Ledger") | plan Step 0, e2e |
| O4 | CT: embedding wiki entries at ingest, threshold calibration | CT spec |
| O5 | CT: deposit-path supersession → wiki-id supersession | CT spec |
| O6 | A sanctioned host API for a restored session's prompt (would lift the fail-closed rule) | upstream ask, not blocking |
| O7 | ~~Exact string envelope of an MCP tool result~~ — **resolved [V]**, see Target 5 | — |

## Target 5 — MCP result envelope seen by `transform_tool_result` (O7)

**[V]** Hermes does NOT hand the hook the raw MCP `content` array.
`_render_call_tool_result` (`tools/mcp_tool_handlers.py:517-552`) flattens first:

- text blocks are joined with `"\n"` after `strip_unicode_tags`
  (`_render_content_blocks`, `:440-473`) and hard-capped by head+tail truncation
  (`_truncate_mcp_text_result`, `mcp_tool_content.py:31-33`);
- the handler string is `json.dumps({"result": <joined text>})`, plus
  `structuredContent` and/or `_meta` keys only when the server sent them and they
  are not a verbatim dual-emit of a text block (`:535-550`);
- an `isError` result becomes `tool_error(...)` instead (`:527-528`).

**[V] CT side:** `curated_recall_context` returns `serde_json::to_string(&response)`
— one JSON string, keys `wiki_entries`, `code_chunks`, `query`
(`curated_thoughts_mcp.rs:242-251`; note `wiki_entries`, not `wiki`). **[A]** rmcp
wraps a `String` return as a single text content block with no
`structuredContent`; the plan's unit fixture pins this shape and the e2e confirms it.

So the hook receives a two-layer string: outer Hermes JSON `{"result": "<CT JSON>"}`
→ `json.loads(outer["result"])` → CT object. Stubbing rewrites the inner object,
re-serializes it into `outer["result"]`, then re-serializes the outer object
(preserving any other outer keys). If the inner string fails to parse (e.g. the
head+tail truncation marker made it invalid JSON) or the outer has no `result`
string, or the result is a `tool_error` → pass through unmodified.

---

## Target 6 — e2e results on the scratch profile (plan Task 9, 2026-10-09)

Host pin: Hermes Agent `da303d1` (v0.21.5+8121, dirty, 2026-10-06 -0400,
`~/.hermes/hermes-agent`). Cited line numbers re-checked: system prompt built
before the hook (`turn_context.py:1122-1124`), `pre_llm_call` collected at
`:1160` via `_collect_pre_llm_call_context` (`:782`),
`_stamp_api_content_sidecar` stamps the user turn (`:1185`, def `:921`);
`_apply_transform_tool_result_hook` and `_render_call_tool_result`
(`mcp_tool_handlers.py:517`) unchanged in substance. Plugin payload under test:
0.4.1 (`992b2ce`) installed into the scratch profile `~/.hermes/profiles/ct-test`;
CT gate `semantic-v1:external:qwen/qwen3-embedding-4b`, scheme `instr1`.

Session: `20261009_035603_7e5bf3` (live `hermes chat` under
`CURATED_BRAIN_DIR=<scratch brain>`, seeded quokka-deploy memories). Facts ingest
into the wiki asynchronously (librarian), so the ledger-proof below uses the
delivered `ids=` debug lines.

- **Delivery + exactly-once (Steps 4):** [V] turn 1 unrelated →
  `class=zero_hits`; turn 2 quokka question → `wisdom-live: deliver ids=fact_511e…,
  fact_620a…` and the wisdom block persisted in the turn-2 user row `api_content`
  (797 bytes, markers `<!-- ct-fact:… -->`); turns 3–4 → new fact ids each time
  (`fact_69fe…, fact_1f29…`, then `fact_a3e2…, fact_e856…`). All 6 delivered ids
  are unique across the session — no fact ever delivered twice; turn-3's
  overlapping-topic question did not re-deliver the ledgered pair.
- **O1 — history field the hook sees:** [V] resolved behaviorally: the turn-3
  hook filtered exactly the facts injected into turn-2's `api_content` sidecar
  (its plain `content` never contained them), and `ct_ledger.history_ids()`
  rebuild over the stored rows recovers all 6 ids from the sidecar field. The
  hook's `conversation_history` therefore sees `api_content`.
- **Byte-stable replay (Step 5):** [V] turn-2 user row `api_content` re-read
  after turns 3–5: sha256 `5469adea…3aa` identical before/after.
- **O3 — in-place compaction (Step 6):** [V — host declined to compact] five
  live `/compress here [N]` attempts on the delivered session; the host logs
  `insufficient_messages` / "no progress — skipping boundary rewrite" every time
  (tiny session on a 1M-context model; protected head+tail covers all messages).
  Outcome: injected bytes trivially survive = the spec's second branch ("if
  compaction keeps the bytes, the markers keep the fact ledgered" — ledger
  re-read post-attempts still returns all 6 ids). The summarize-away branch
  remains covered by the property test (`test_exactly_once.py`, random
  prefix drops); both branches are ruled correct by the spec "Compaction" note.
- **Supersession (Step 7):** [V] no `ct supersede` CLI exists (CT fills
  `corrections` only from engine `supersede`), so per the plan's fallback the
  replacement row was inserted directly in the **scratch brain** and the old
  fact's `superseded_by` pointed at it (`fact_e2e_supersede_0001`). Next turn
  delivered the correction line verbatim: `… — supersedes
  ct-fact:fact_511e9e7516d23affb801ba9d`.
- **Fail-closed (Step 8):** [V] `/quit`, then `hermes -r 20261009_035603_7e5bf3`
  in a fresh process and a new quokka question →
  `wisdom-live: skip class=restored_unknown_bootstrap`, no delivery, no block.
- **O2 — MoA / `codex_app_server`:** not exercised — neither mode is configured
  in the scratch profile, per the plan's sanctioned fallback.
- **Latency (Step 10):** [V] live hook wall-time on 4 turns: 0.44–2.07 s
  (median ≈ 1.0 s); 20× direct `ct wisdom match` probes: min 0.37 s, p50 0.47 s,
  p95 1.22 s, max 1.22 s — well under `plugins.hook_callback_timeout` (30 s).

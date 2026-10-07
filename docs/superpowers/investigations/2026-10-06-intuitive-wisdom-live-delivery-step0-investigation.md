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
| O7 | Exact string envelope of an MCP tool result as `transform_tool_result` receives it (raw JSON vs wrapped content) | plan Step 0 |

# Top-level README: Intuitive Wisdom section + five-integration revision — design

**Date:** 2026-10-16 · **Status:** Approved (autonomous; design judgment delegated, no open questions) ·
**Parent:** `2026-10-09-cross-harness-wisdom-parity-design.md` decision 9, plan Task 6.

## Problem

All five integrations have shipped Intuitive Wisdom live delivery (hermes 0.4.2,
deepseek 0.4.1, opencode 0.2.0, claude-code 0.2.0, openclaw 0.1.0). The top-level
`README.md` still describes only Hermes and DeepSeek. It explains wisdom inside those two
per-integration paragraphs, says Claude Code and OpenClaw come "next", talks about
*planned* rows when none are left, and leaves the OpenClaw Directory cell unlinked
(CodeRabbit nitpick on PR #45).

## Audience

Someone choosing or installing an integration, who needs to know what Intuitive Wisdom does
for them, on their harness, and when it stays quiet. Implementation detail such as annex A,
channel internals and N1 to N5 stays in specs and in the per-integration READMEs, which the
top-level README links to.

## Generated vs hand-written

`tools/ct_ci_readme.py` rewrites only the **Status** and **Version** cells of 4-cell table
rows whose second cell names `integrations/<id>`. The Harness and Directory cells are
hand-written, so the OpenClaw link is a plain README edit. No generator change is needed.
Constraint: no new table may have exactly 4 cells with `integrations/<id>` in cell 2, or
the generator would treat it as an integrations row. The new per-host table uses 5 columns
and keeps links out of column 2.

## Section outline

1. Integrations table: link the OpenClaw directory, and drop the "*planned* rows" sentence
   because no planned rows remain.
2. "What an integration provides": add a fifth layer, **Intuitive Wisdom**, linking to the
   new section.
3. **Intuitive Wisdom** (new, first-class):
   - Plain-language summary: a short bootstrap block at session start; then, once per user
     turn, CT (`ct wisdom match`) decides which curated facts are relevant to the message.
     The not-yet-seen facts are added to that turn, never to the system prompt, and each fact
     is in context at most once (on Hermes, DeepSeek and OpenClaw a fact whose marker was
     compacted out may arrive again; OpenCode and Claude Code never re-deliver). Agent-run `curated_recall_context` results show
     repeats as "already in context" stubs. Needs CT ≥ 3.3.0; older or absent CT is a
     silent no-op.
   - Shared budgets: ≤ 2 facts per turn, ≤ 1200-char block, ≤ 12 per session (corrections
     exempt); 3 s per `ct` call; breaker = 3 consecutive failures pause matching for 5 min.
   - Per-host table (below).
   - Known limits: CT's relevance gate needs a calibrated embedder (`gate: uncalibrated` ⇒
     no entries, corrections still flow); live matching rarely fires on real messages yet
     (curated-thoughts#271); corrections stay empty until the Librarian applies
     supersessions; subagents never get live delivery.
4. "The integrations so far": one short paragraph per integration (all five), each linking to
   its README. Wisdom detail moves to section 3; install/doctor one-liners stay.
5. Memory in a box: drop the stale "Claude Code and OpenClaw next".
6. Versioning: the example tag becomes the current `hermes-v0.4.2`.

## Per-host behavior table

| Host | Trigger | Channel | Resume / restart | Compaction |
|---|---|---|---|---|
| Hermes | `pre_llm_call` | appended to the user turn | restored session (`/branch`, `/resume` after restart): no live delivery | continues; a fact compacted out may arrive again |
| DeepSeek Harness | first `agent/pre-step` of a turn | identified user message, persisted in the session log | `--session-id` / restart continue, no repeats (ledger from the session log) | agent id survives; ledger = what the log carries |
| OpenCode | `chat.message` | `synthetic: true` part on the user message | `--continue` / restart continue, no repeats | delivered ids carried forward, never re-delivered (deliberate) |
| Claude Code | `UserPromptSubmit` | `additionalContext` | `--resume`/`--continue`/`/resume`/fork: live delivery OFF for the session's life; `/clear` = fresh session | continues, no repeats |
| OpenClaw | `before_prompt_build` (user turns) | `prependContext` in the user message | new process: no live delivery until bootstrap is settled | session key survives; a fact compacted out may arrive again |

Per-host notes: Claude Code `allowManagedHooksOnly` disables plugin hooks, and wisdom
with them. OpenClaw needs `hooks.allowConversationAccess: true` and a 20 s
`before_prompt_build` timeout (the installer sets both); it is cache-safe on the embedded
runner at 2026.10.3, CLI runner yes, Codex/Copilot degraded.

Sources: the per-integration READMEs and CHANGELOGs; parent spec decisions 3, 4 and 5 and its
per-host adapter table; the OpenClaw leg spec's restore rule; `deepseek/src/wisdom-live/adapter.ts`.

## Deliberately omitted

- Annex A pseudocode, N1 to N5 vocabulary, ledger-rebuild mechanics, and marker syntax
  beyond one mention (all in specs).
- Install commands per host (in each integration README).
- Hermes v1 bootstrap edge cases (memo eviction, legacy compression id rotation). These are
  in the Hermes CHANGELOG; the top-level README keeps only the user-visible restored-session rule.
- Other integration READMEs, with one exception added on review. The DeepSeek README said
  `agent/session-start` and had no live-delivery section, so it gets the `agent/created`
  fix and a short Intuitive Wisdom section, consistent with the top-level section and the
  deepseek 0.4.0/0.4.1 CHANGELOG. That edit is conditional on the policy gate passing
  without a version bump.
- No version bump: this is a docs-only change outside `integrations/`, confirmed by the
  policy gate.

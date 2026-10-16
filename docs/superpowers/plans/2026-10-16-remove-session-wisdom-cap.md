# Remove the per-session wisdom cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every host keeps asking `ct wisdom match --max 2` for the whole session; the 12-per-session cap and its bookkeeping are gone.

**Architecture:** Delete the `MAX_PER_SESSION`/`LIVE_MAX_PER_SESSION` constant and the branch that drops `--max` to 0, in the Python reference (`ct_wisdom_live.py`, two byte-identical copies), the Claude Code hook, and the shared TS core. Remove `Ledger.liveDeliveredCount` (its only reader was the cap) from the core type and the three TS adapters. Per-turn limits, dedup, breaker, timeouts and `EXCLUDE_MAX` are untouched.

**Tech Stack:** Python 3.9+ stdlib (unittest), TypeScript + vitest (pnpm), `tools/ct_ci.py` gates.

**Spec:** `docs/superpowers/specs/2026-10-16-remove-session-wisdom-cap-design.md`

## Global Constraints

- `MAX_PER_TURN = 2`, `MAX_BLOCK_CHARS = 1200`, `EXCLUDE_MAX = 256`, breaker 3 / 300 s, timeout 3 s: unchanged.
- `integrations/hermes/scripts/ct_wisdom_live.py` and `integrations/claude-code/scripts/ct_wisdom_live.py` stay byte-identical.
- Versions: hermes 0.4.3, claude-code 0.2.1, deepseek 0.4.2, opencode 0.2.1, openclaw 0.1.1; ct-wisdom-core stays 0.1.0. CHANGELOG headings `## <version> — 2026-10-16` under an empty `## Unreleased`.
- Slow machine: run suites sequentially; vitest with `--testTimeout 60000`.

---

### Task 1: Core (`packages/ct-wisdom-core`) — no session cap

**Files:**
- Modify: `packages/ct-wisdom-core/src/constants.ts`, `src/engine.ts`, `src/types.ts`
- Test: `packages/ct-wisdom-core/tests/engine.test.ts`, `tests/exactly-once.test.ts`

**Interfaces:**
- Produces: `Ledger = { idsMostRecentFirst: string[]; has(id): boolean; knownBootstrap: boolean }` (no `liveDeliveredCount`); `MAX_PER_SESSION` is no longer exported.

- [ ] **Step 1: Write the failing tests.** In `engine.test.ts`, replace "budget exhaustion forces corrections-only" with a long-session test: a `FakeHost` whose `wisdomMatch` records `max` and returns 2 fresh ids per call, whose `rebuildLedger` reports every previously delivered id (and, while the field exists, `liveDeliveredCount` = their count). Run 20 turns; expect every `max` to be `MAX_PER_TURN` (2), every turn to deliver exactly 2 new ids, and 40 distinct ids in total. Add a test that `liveCount = 100` still sends `max = 2` and corrections still flow. In `exactly-once.test.ts`, rewrite the "corrections-only turns still dedup" probe: after 12 delivered live ids the next turn asks `--max 2`, delivers fresh ids (non-null block containing none of the first 12) and leaves no duplicates.
- [ ] **Step 2: Run** `pnpm exec vitest run --testTimeout 60000` in `packages/ct-wisdom-core` → the new tests FAIL (`max` is 0 after 12).
- [ ] **Step 3: Implement.** Delete `MAX_PER_SESSION` from `constants.ts`; in `engine.ts` remove the import and the `liveUsed`/`maxN` lines and pass `MAX_PER_TURN` to `host.wisdomMatch`; drop `liveDeliveredCount` from both `cacheLedger` rebuilds; in `types.ts` drop the field from `Ledger` and `EMPTY_LEDGER`, and reword the `Correction` doc ("exempt from the per-session budget" → corrections flow on every turn). Remove `liveDeliveredCount`/`liveCount` from the test fakes.
- [ ] **Step 4: Run** core vitest + `pnpm exec tsc --noEmit` → PASS. Build: `pnpm run build`.
- [ ] **Step 5: Commit** `feat(core): remove the per-session live wisdom cap`.

### Task 2: TS adapters (DeepSeek, OpenCode, OpenClaw)

**Files:**
- Modify: `integrations/deepseek/src/wisdom-live/adapter.ts` (drop private `liveDeliveredCount()`), `integrations/opencode/src/wisdom-live/adapter.ts` (`makeLedger(ids, knownBootstrap)`, drop `live` set and the `Math.max` merge), `integrations/openclaw/src/wisdom/adapter.ts` (drop `SnapshotScan.live` and its use).
- Test: `integrations/deepseek/tests/test_wisdom_live_exactly_once.test.ts`, `tests/test_wisdom_live_adapter.ts`; `integrations/opencode/tests/test_wisdom_hooks.ts`, `tests/test_wisdom_live_adapter.ts`; `integrations/openclaw/tests/test_exactly_once.test.ts`, `tests/test_adapter.ts`.

- [ ] **Step 1: Failing tests (written before Task 1's implementation lands, against the built core).** DeepSeek: rewrite the "saturated live budget" probe as in Task 1 (fake ct records `--max`; expect `2` and fresh ids after 12). OpenCode: rewrite "bootstrap ids do not count toward the live session budget" to "a long session keeps receiving 2 facts per turn past 12": 10 turns against a 40-fact stub → 20 live ids, every match call carries `--max 2`, no id twice. OpenClaw: replace the `MAX_PER_SESSION + 2*MAX_PER_TURN` bound with an assertion that some session's visible live count exceeds 12 (proves no cap) while violations stay `[]`; per-turn: no single `prependContext` carries more than `MAX_PER_TURN` live ids.
- [ ] **Step 2: Run** each suite → new tests FAIL against the capped core.
- [ ] **Step 3: Implement** the adapter removals; drop `liveDeliveredCount` assertions from the adapter tests (keep the ordering/knownBootstrap assertions).
- [ ] **Step 4: Run** each suite + `tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(ts-hosts): drop the live-count bookkeeping with the session cap`.

### Task 3: Hermes + Claude Code (Python)

**Files:**
- Modify: `integrations/hermes/scripts/ct_wisdom_live.py`, copy to `integrations/claude-code/scripts/ct_wisdom_live.py`; `integrations/claude-code/hooks/ct_wisdom_cc.py`.
- Test: `integrations/hermes/tests/test_ct_wisdom_live.py`, `integrations/claude-code/tests/test_wisdom_cc.py`.

- [ ] **Step 1: Failing tests.** Hermes: replace `test_session_budget_switches_to_corrections_only` with `test_no_session_cap_long_session_keeps_two_per_turn` — 20 turns, each reply 2 fresh entries, the delivered block appended to history as a user message; every call `max_n == LIVE_MAX_PER_TURN`, every turn delivers 2 new ids, 40 in total; plus `test_many_live_ids_in_history_still_ask_per_turn_max` (50 user-role ids → `max_n == 2`). Drop the now-meaningless "tool and bootstrap ids do not count toward budget" test. Add `assertFalse(hasattr(ct_wisdom_live, "LIVE_MAX_PER_SESSION"))`. Claude Code: replace `test_session_budget_forces_corrections_only` with a 20-turn long-session test (2 fresh per turn, `max_n == 2` always, store `live_ids` grows to 40) and drop `LIVE_MAX_PER_SESSION` from `test_adapter_uses_the_core_constants` (assert absence instead).
- [ ] **Step 2: Run** `python -m unittest discover -s tests` in each → FAIL.
- [ ] **Step 3: Implement.** Remove `LIVE_MAX_PER_SESSION` and `live_used`; call `match_wisdom(path, query, LIVE_MAX_PER_TURN, …)`. `cp` the Hermes copy over the Claude Code copy. In `ct_wisdom_cc.py`, remove `live_used`/`max_n` and pass `ct_wisdom_live.LIVE_MAX_PER_TURN`.
- [ ] **Step 4: Run** both suites, `tests/tools`, ruff → PASS.
- [ ] **Step 5: Commit** `feat(hermes,claude-code): remove the per-session live wisdom cap`.

### Task 4: Docs, versions, gates

- [ ] INTENT.md §6 rule text ONLY: drop "with at most 12 per session" and state the principle plainly (per-turn limits keep each delivery small; no session-wide cap stops relevant facts arriving later); keep "Never raise a limit to make up for weak matching". No dated note; do not touch any **Status:** line, the status table or any other section (INTENT is product intent; history goes in the spec and CHANGELOGs).
- [ ] README.md Intuitive Wisdom section (budgets bullet, Known limits bullet); integration READMEs (claude-code, deepseek, opencode, openclaw).
- [ ] Amendment notes (not rewrites) at the top of `2026-10-06-intuitive-wisdom-live-delivery-design.md` and `2026-10-09-cross-harness-wisdom-parity-design.md`.
- [ ] Bumps: `integration.yaml` + `version_mirror` file for all five; CHANGELOG sections; `python tools/ct_ci.py readme`.
- [ ] Gates: `tools/ct_ci.py validate`, `policy --base origin/main`, `generate --check`, `readme --check`.
- [ ] Commit `docs+release: session cap removal; bump all five integrations`.

### Task 5: PR

- [ ] Push, open PR, `gh run watch`, address CodeRabbit with replies per thread. Do not merge.

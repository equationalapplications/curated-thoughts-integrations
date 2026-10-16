# Remove the per-session cap on Intuitive Wisdom live delivery — design

**Date:** 2026-10-16 · **Status:** Approved (user decision, 2026-10-16) ·
**Branch:** `feat/remove-session-wisdom-cap` · **Base:** `origin/main` @ `801b6c5`
**Amends:** [`2026-10-06-intuitive-wisdom-live-delivery-design.md`](2026-10-06-intuitive-wisdom-live-delivery-design.md)
(`LIVE_MAX_PER_SESSION`) and [`2026-10-09-cross-harness-wisdom-parity-design.md`](2026-10-09-cross-harness-wisdom-parity-design.md)
(Annex A `MAX_PER_SESSION`, the M1 session budget).

## Decision

Proactive live delivery has no per-session cap on any host. The constant
`MAX_PER_SESSION` / `LIVE_MAX_PER_SESSION = 12` and the branch that drops
`--max` to 0 once a session has received 12 live facts are removed from the
Hermes Python reference, the Claude Code hook, and the shared TypeScript core
(DeepSeek Harness, OpenCode, OpenClaw). Every turn now asks
`ct wisdom match --max 2`.

## Rationale

An autonomous agent is better served by more wisdom than less, and dedup
already prevents repeats.

- The cap stops delivery after about 6 matching turns (2 facts per turn).
  That is the wrong moment to stop: a fact that matches late in a session is
  as valuable as one that matches early.
- Noise is bounded **per turn**: at most 2 facts in a block of at most
  1200 characters, and only facts that clear CT's relevance floor. Those
  limits stay the noise control. (The 2026-10-16 real-gate e2e run showed CT
  admitting a distractor at 0.649 just above its 0.64 floor, which is why the
  per-turn limits are not raised.)
- Context cost is small and cache-safe: live delivery is appended to the user
  turn (never the system prompt), so the cached prefix is untouched.
- Dedup bounds the total: the ledger and `--exclude` make every fact arrive
  at most once, so a session's total is bounded by the number of distinct
  facts that match its turns.

## Alignment with INTENT.md

- **Serves the Intuitive Wisdom goal:** the agent knows the right fact at the
  moment it becomes relevant, including late in a long session, which the
  cap stopped after about 6 matching turns.
- **Rule 6 (Keep it small):** kept through the per-turn limits (2 facts,
  1200 chars), which are unchanged. "Never raise a limit to make up for weak
  matching" still holds.
- **Rule 1 (A fact appears at most once):** kept through the ledger and
  dedup, which are unchanged and also bound a session's total.
- **Rule 8 (Relevance is CT's job):** kept. CT's score gate still decides
  what is relevant; integrations do not score, rank or threshold.
- **Departure, flagged plainly:** rule 6's text changes. "With at most 12
  per session" is dropped. This is an intent change the user approved on
  2026-10-16, not something we drifted into.

## What stays exactly as it is

- `MAX_PER_TURN = 2`, `MAX_BLOCK_CHARS = 1200` (renderer truncation rules
  unchanged).
- CT's score gate — integrations never score, rank or threshold.
- The ledger, `--exclude` (newest first, `EXCLUDE_MAX = 256`), the post-filter,
  exactly-once / same-turn dedup, N3 tool-result stubbing.
- Breaker (3 failures → 5 min), 3 s timeouts, query cap, capability probe,
  restored-session fail-closed, Claude Code's latching OFF switch.
- Corrections keep flowing every turn (they were already exempt).
- INTENT invariant 6's rule "Never raise a limit to make up for weak
  matching" — it now governs the per-turn limits.

## Dead code removed with the cap

- `packages/ct-wisdom-core`: `MAX_PER_SESSION` (constants), the `maxN`
  branch in `onUserTurn`, and `Ledger.liveDeliveredCount` (type,
  `EMPTY_LEDGER`, both `cacheLedger` rebuilds in the engine). The field's only
  reader was the cap.
- Adapters that computed `liveDeliveredCount` stop computing it: DeepSeek's
  private `liveDeliveredCount()` scan, OpenCode's `live` set in
  `buildLedger`/`makeLedger`/`refreshForToolResult`, OpenClaw's
  `scan.live` use in `rebuildLedger` (the `live` set in `snapshotScan` is
  dropped only if nothing else reads it).
- Hermes / Claude Code: `LIVE_MAX_PER_SESSION` and the `live_used` count.
  The Claude Code store's `live_ids` list stays — it is part of the ledger.
- The two `ct_wisdom_live.py` copies stay byte-identical (parity gate
  `tests/tools/test_shared_script_parity.py`).

## Blast radius

| Area | Change |
|------|--------|
| `packages/ct-wisdom-core/src` | constants, engine, types |
| `integrations/deepseek/src/wisdom-live/adapter.ts` | drop the live count |
| `integrations/opencode/src/wisdom-live/adapter.ts` | drop the live count |
| `integrations/openclaw/src/wisdom/adapter.ts` | drop the live count |
| `integrations/{hermes,claude-code}/scripts/ct_wisdom_live.py` | drop constant + branch |
| `integrations/claude-code/hooks/ct_wisdom_cc.py` | drop branch |
| Tests (all five + core) | cap assertions rewritten to assert no cap |
| Docs | INTENT §6 rule text only (drop "with at most 12 per session"; no dated note, no Status lines touched — INTENT is product intent, not a work ledger; the history lives here and in the CHANGELOGs), README, integration READMEs, CHANGELOGs, amendment notes in the two parent specs |

Hosts' vendored core: OpenCode and OpenClaw vendor `packages/ct-wisdom-core/lib`
at build time (`scripts/vendor_core.mjs`, `release.yml`); nothing vendored is
committed, so no generated copy is edited by hand. DeepSeek consumes it as a
`file:` dependency.

## Testing

TDD: first write tests that a long session (more than 12 live facts already
delivered, then further turns) keeps calling `--max 2` and keeps receiving up
to 2 new facts per turn, and that the per-turn limits still hold. Watch them
fail against the current code, then remove the cap. Existing tests that
asserted the cap (`max_n == 0`, `--max 0`, `liveDeliveredCount == 12`,
`LIVE_MAX_PER_SESSION == 12`) are rewritten; exactly-once property tests that
modelled the budget drop that bound and keep the dedup properties. No Docker
or live e2e is needed.

## Release matrix

| Package | From | To | Why |
|---------|------|----|-----|
| hermes | 0.4.2 | 0.4.3 | `scripts/ct_wisdom_live.py` |
| claude-code | 0.2.0 | 0.2.1 | `scripts/ct_wisdom_live.py`, `hooks/ct_wisdom_cc.py` |
| deepseek | 0.4.1 | 0.4.2 | core + adapter |
| opencode | 0.2.0 | 0.2.1 | core (vendored) + adapter |
| openclaw | 0.1.0 | 0.1.1 | core (vendored) + adapter |
| ct-wisdom-core | 0.1.0 | 0.1.0 | private, unpublished, never bumped by repo convention (not policed by the policy gate) |

Each CHANGELOG gets a `## <version> — 2026-10-16` section under an empty
`## Unreleased`; each `version_mirror` file is bumped; the README table is
regenerated with `tools/ct_ci.py readme`.

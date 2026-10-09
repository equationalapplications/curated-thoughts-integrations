# Implementation plan — cross-harness Intuitive Wisdom parity (PR #37)

**Spec:** `docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md` (rev 2)
**Ordering:** DSH → OpenCode → Claude Code → OpenClaw (decision 8); each leg
independently committable. Waves below map to the delivery flow's subagent
concurrency rules (parallel within a wave, serial commits per file).

## Task 1 — `packages/ct-wisdom-core` (TS shared core)

Implements Annex A normatively: ledger model + adapter interface, constants
(2/1200/12/3s/2000/256/3/300s), breaker state machine, capability probe +
discovery-cache reset, `ct wisdom match` subprocess contract, fact-id marker
emit/scan, sanitizer (`ct-fact:` strip to fixpoint before host sanitizers), block
renderer, corrections-only budget rule, exclude ordering (newest-first).
Own vitest suite: shared-core port of the Hermes exactly-once property test.

Commit: `feat(core): ct-wisdom-core — annex A implementation + shared suite`

## Task 2 — DSH leg (pin 0.2.0-rc.2)

1. Bump pin in `tests/host/compatibility.json` (+ note re-verify); fix
   `compatibility.json` stale note (decision 2).
2. Adapter: `agent/pre-step` (firstAttempt) N1; pre-step append N2;
   `tools/post-execute` N3 with session-log-derived view (m2 rule).
3. v1 amendment: markers on bootstrap render + memo ids (Hermes 0.4.0 parity).
4. Unit + exactly-once tests (AC 1–5, 11); stub-host contract update (AC 7).
5. Live `pre-step` e2e via `tests/e2e/run.sh` (AC 10) — controller-run, pre-merge.
6. Supersede the 2026-09-30 DSH step-0 "no per-user-turn hook" claim.

Commit: `feat(deepseek): intuitive wisdom live delivery (0.4.0)`

## Task 3 — OpenCode leg (pin 1.18.35)

1. Pin bump + dist byte-identity note (1.18.31↔1.18.35).
2. Adapter: `chat.message` N1+N2 (`synthetic: true` part; self-trigger guard n2),
   `tool.execute.after` N3.
3. Greenfield v1 bootstrap (N5 table): seed-query recall block, memo, markers.
4. Compaction carry-forward via `experimental.session.compacting` (decision 3
   deviation); subagent policy (parent-only, best-effort parent lookup).
5. Unit + exactly-once incl. compaction carry-forward + cross-session test;
   extends real-binary host contract job.
6. Live `chat.message` e2e (AC 10).

Commits: `feat(opencode): wisdom bootstrap (v1)` then
`feat(opencode): live delivery (0.2.0)`

## Task 4 — Claude Code leg (0.1.1 → 0.2.0)

1. `hooks/wisdom.py` importing `integrations/hermes/scripts/ct_wisdom_live.py`
   (no copy); `UserPromptSubmit` provenance filter (4a), main-thread gate (4b).
2. `PostToolUse` N3: `mcp__curated_recall_context` only; envelope rewrite (m4).
3. Extend `session-start.py`: bootstrap render + `${CLAUDE_PLUGIN_DATA}` store
   seeding (N5); SessionStart source rules — resume ⇒ OFF-for-life, compact ⇒
   continues, clear ⇒ empirical-encode-observed, startup ⇒ fresh (M2).
4. hooks.json registration + manifest tests; CHANGELOG 0.2.0.
5. Unit tests incl. compact-continues and clear/resume-OFF (AC 2); local `claude`
   CLI e2e if available (controller-run).

Commit: `feat(claude-code): intuitive wisdom live delivery (0.2.0)`

## Task 5 — OpenClaw leg (0.0.0 → 0.1.0)

1. New integration scaffold: manifest flip `language: node`, `status: implemented`.
2. Adapter: `before_prompt_build` N1 (`ctx.trigger` gate) + `prependContext` N2;
   `enqueueNextTurnInjection` durable path; three-channel dedupe (m7).
3. Greenfield v1 bootstrap + skills (N5 table).
4. Unit + exactly-once (three channels); `--raw-stream` cache gate capture (AC 9)
   — controller-run; defer-and-accept fallback recorded in CHANGELOG if needed.
5. Stub contract shape-tier in `ci.yml` (decision 10).

Commits: `feat(openclaw): scaffold + wisdom bootstrap` then
`feat(openclaw): live delivery (0.1.0)`

## Task 6 — README + release metadata

Full README revision (decision 9: five integration entries, Intuitive Wisdom
section, support matrix, OpenClaw per-runtime + permission gates, claude-code
`allowManagedHooksOnly` note). Per-integration CHANGELOG entries at the decision-7
versions, `## <version> — <date>` heading format preserved.

Commit: `docs(readme): Intuitive Wisdom section + release metadata for four legs`

## Task 7 — CI wiring + final

`ci.yml` tiers per decision 8/10; all jobs green (checks-to-green loop per SOP);
spec status flip + PR body checkboxes ticked (Step 8) before `gh pr ready`.

## Execution notes

- Rust/TS runs serial where workspace state is shared (pnpm workspace,
  lockfile); Task 1 gates Tasks 2–5's adapter work, but docs (Task 6 prep) can
  start in parallel.
- Controller-run items (not delegable): live e2es (Tasks 2.5, 3.6, 4.5),
  raw-stream capture (5.4), merges, tags.
- After merge: tag `deepseek-v0.4.0`, `opencode-v0.2.0`, `claude-code-v0.2.0`,
  `openclaw-v0.1.0` (never `deepseek-v0.3.1` / `opencode-v0.1.1`).

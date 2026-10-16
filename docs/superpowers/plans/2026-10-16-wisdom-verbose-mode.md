# Intuitive Wisdom verbose mode — implementation plan

**Spec:** [`2026-10-16-wisdom-verbose-mode-design.md`](../specs/2026-10-16-wisdom-verbose-mode-design.md)
**Branch:** `feat/wisdom-verbose-mode` · TDD on every task (red, then green, then refactor).

## Task 1 — Python shared module `ct_wisdom_verbose.py` (Hermes)

- [ ] Tests first, `integrations/hermes/tests/test_ct_wisdom_verbose.py`:
  `enabled()` truth table; `log_path()` per host and the override;
  `record_delivery` writes one v1 event with the allowlisted fields and calls
  the sink; outcome classification (`delivered`, `in_context`, `budget`,
  `not_applicable`) and the `zero_hits` split (`gate_uncalibrated`,
  `no_match`, `deduped`, `budget`); off ⇒ no file and no sink call; a raising
  sink and an unwritable path are swallowed; a planted env secret never
  appears; rotation at the size cap.
- [ ] Implement `scripts/ct_wisdom_verbose.py` (stdlib, Python 3.9).

## Task 2 — Hermes call sites

- [ ] Tests in `tests/test_ct_wisdom_live.py`: off/on byte equality of the
  `pre_llm_call` return across delivery and skip turns; on ⇒ the event carries
  `query`, `gate`, `matched[].score`; a raising recorder leaves the return
  unchanged; `match_wisdom` keeps `gate`/`score` when present (existing
  normalization tests stay green).
- [ ] Edit `ct_wisdom_live.py`: import; `_skip(..., **detail)` + one record
  line; the `zero_hits` call passes detail; one record line before the
  delivery return; additive `gate`/`score`.

## Task 3 — reader `ct_wisdom_log.py`

- [ ] Tests: formats a delivery and a skip; `-n`; skips bad lines; resolves
  the default path per `--host`.
- [ ] Implement (stdlib).

## Task 4 — Claude Code

- [ ] Copy both modules byte-identically to `integrations/claude-code/scripts/`;
  add them to `IDENTICAL` in `tests/tools/test_shared_script_parity.py`.
- [ ] Tests in `tests/test_wisdom_cc.py`: off ⇒ `main()` stdout identical to
  today; on ⇒ the same `additionalContext` plus a top-level `systemMessage`,
  and a log line under `$CLAUDE_PLUGIN_DATA/wisdom/`; a skip on ⇒
  `{"systemMessage": …}` only; failures swallowed; no env.
- [ ] Edit `hooks/ct_wisdom_cc.py`: `_skip` record line, delivery record line,
  and the collecting sink in `main()`.

## Task 5 — TypeScript core `verbose.ts`

- [ ] Tests `packages/ct-wisdom-core/tests/verbose.test.ts`: enabled table;
  event building per exit of `onUserTurn` (each reason, the split, outcomes);
  no recorder ⇒ identical result and no call; a throwing recorder ⇒ identical
  result; JSONL writer + rotation; no env; `formatNotice`/`formatLogLine`.
- [ ] Implement `src/verbose.ts`, `HostAdapter.recordVerbose?`, `gate` in
  `WisdomMatchResult` (parse), engine reporting, `src/cli/ct-wisdom-log.ts`.

## Task 6 — adapters

- [ ] DSH: recorder when on; sink `ctx.logger('curated-thoughts').info`; log
  under `$DSH_HOME/logs`. Test: pre-step decision messages equal off/on; event
  logged; logger called.
- [ ] OpenCode: sink `client.tui.showToast` (fire-and-forget, catch); log under
  `$XDG_DATA_HOME/opencode/log`. Test: pushed parts equal off/on; toast called.
- [ ] OpenClaw: sink `api.logger.info`; log under `$OPENCLAW_STATE_DIR/logs`.
  Test: `before_prompt_build` result equal off/on; logger called.

## Task 7 — release hygiene

- [ ] Minor bumps (hermes, claude-code, deepseek, opencode, openclaw) in
  `integration.yaml` + native manifest; CHANGELOG sections; integration
  READMEs; top-level README "Verbose mode" subsection; `tools/ct_ci.py readme`.

## Task 8 — verification

- [ ] Sequentially: hermes + claude-code unittest, tests/tools, core/deepseek/
  opencode/openclaw vitest (`--testTimeout 60000`), `tsc --noEmit` each, ruff,
  `ct_ci.py validate`, `policy --base origin/main`, `generate --check`,
  `readme --check`.
- [ ] Commit, push, PR, CI + CodeRabbit, address review.

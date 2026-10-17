# Docker Agent integration 0.1.0 — implementation plan

**Spec:** [`2026-10-16-docker-agent-integration-design.md`](../specs/2026-10-16-docker-agent-integration-design.md)
**Branch:** `feat/docker-agent-integration` · **Base:** `origin/main` @ `180693e`

Every task is test-first: write the failing tests, run them red, implement, run green, commit.
Run suites one at a time (the Mac is slow): docker-agent, hermes, claude-code, tests/tools.

## Task 0 — Phase 0 facts (done)

Closed in the spec's "Phase 0" table (P1–P15): pinned source read at `5277e78`; the darwin-amd64
release binary (sha256 checked) driven against `tests/host/mock_openai.py` in an isolated HOME.
Experiments A (two messages + resume), C (run-1 insertion vs run-2 `session_start`), D (sub-agent),
E (`system_message` rendering).

## Task 1 — Skeleton and vendored core

1. `integrations/docker-agent/{integration.yaml, plugin.json, CHANGELOG.md}`; matrix as
   claude-code (ubuntu/macos/windows × 3.9/3.13); `checks.test`, `checks.lint`, `checks.shell`
   (`scripts/install.sh`), `checks.host`.
2. Copy byte-identically from `integrations/hermes/scripts/`: `ct_env.py`, `ct_status.py`,
   `ct_preflight.py`, `ct_ledger.py`, `ct_wisdom.py`, `ct_wisdom_live.py`, `ct_wisdom_verbose.py`,
   `ct_wisdom_log.py`, `ct_wisdom_activity.py`. Copy `ct_doctor.py` and rewrite only the three
   harness regions (spec D12). `python tools/ct_ci.py generate` writes `_compat_generated.py`.
3. Extend `tests/tools/test_shared_script_parity.py`: `COPIES` gains the docker-agent tree;
   per-copy identical lists so `ct_wisdom_activity.py` is checked where it is vendored.
4. `tools/ct_ci_policy.py`: `ct_wisdom_da`, `ct_wisdom_da_activity` in `STDLIB_ALLOWLIST`.
5. Tests: `test_manifest.py` (version mirror, events in the drop-in template).

## Task 2 — Store, lock, breaker, caches (spec D9)

Tests first (`test_store.py`): round trip, invalid → None, key hashing, lock exclusion across
threads, lock timeout, prune, breaker thresholds, ct cache hit/miss/invalidate on mtime change.

## Task 3 — `before_llm_call`: scan, bootstrap, insertion, step (spec D4, D5, D7)

Tests (`test_hook_events.py`): unseen id → scan; markers seeded; unreadable → off; bootstrap
rendered once, `""` never re-rendered; insertion position for: extras present, no extras,
helper-shaped list (history system message after the cache mark); `cache_control` rule;
already-present; `step` increments; sandbox no-op.

## Task 4 — `user_prompt_submit` deferred match + opt-in transient (spec D6)

Tests (`test_deferred.py`): pending created; replaced at the next prompt (`no_tool_call`);
provenance; breaker; transient mode for `on` sessions only; transient ids in the ledger.

## Task 5 — `tool_response_transform`: deferred claim, activity, recall dedup (spec D6–D8)

Tests (`test_deferred.py`, `test_activity.py`): eligibility (CT tool, error, JSON list, near
limit); claim once across parallel threads; marker-first block; activity map and R1–R4 privacy;
Hermes secret-safety port; key fold and LRU; step rule; recall stubs; live + activity in one result.

## Task 6 — Verbose (spec D10)

Tests (`test_verbose_da.py`): off byte-identity; on → `system_message`, JSONL at the default path,
override; secrets never logged.

## Task 7 — Exactly-once, fail-closed, marker hygiene

`test_exactly_once_da.py` (seeded randomized, threads), `test_fail_closed.py`,
`test_marker_hygiene.py`.

## Task 8 — Installer and doctor (spec D11, D12)

Tests (`test_install.py`, `test_ct_doctor.py`) with `HOME` / `DOCKER_AGENT_CONFIG_DIR` overrides:
only the drop-in is written; content; uninstall; refusals; printed snippet; check 7 verdicts.

## Task 9 — Host contract + CI job

`tests/host/test_host_contract.py` + `tests/host/fake_ct.py`; skips without `DOCKER_AGENT_BIN`.
CI job `host-contract-docker-agent`: download linux-amd64 v1.150.0, verify sha256, run
`checks.host` under a throwaway HOME. Add it to `ci-ok`'s needs.

## Task 10 — Docs

README (integration), top-level README row + Intuitive Wisdom rows (`tools/ct_ci.py readme`),
CHANGELOG `## 0.1.0 — 2026-10-16`.

## Task 11 — Live e2e (scratch only)

Pinned darwin binary, isolated HOME, scratch brain with CT's real gate (OpenRouter
`qwen/qwen3-embedding-4b`, `ct wisdom deposit`, `scheme activate instr1`, recipe from
`integrations/hermes/tests/e2e`), ZAI `GLM-5.3-FLASH` through an Anthropic custom provider
(`base_url: https://api.z.ai/api/anthropic`, `token_key: ZAI_API_KEY`). Checks: the Hermes five
(activity block once with marker; no re-query on the same key; write result intact; no query from
CT tools; bare target reaches CT) + deferred per-message delivery + verbose. Grep every output for
key material before anything is reported.

## Task 12 — Verify, commit, PR, review

All suites, ruff, `ct_ci.py validate / policy --base origin/main / generate --check /
readme --check`. Commit, push, PR, CI, CodeRabbit, reply in threads. Re-copy shared files if
`origin/main` moves (PR #55 merged; the Hermes privacy hotfix pending).

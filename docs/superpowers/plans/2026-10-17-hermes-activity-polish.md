# Hermes activity polish (0.7.0) — plan

Spec: `docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md`,
"Amendment 8: approval-gated query". TDD: each task writes its failing tests first.

## Task 1: approval-gated query

- Tests (`integrations/hermes/tests/test_ct_wisdom_activity.py`):
  - `pre_tool_call` alone never calls `ct` (no match, no discovery);
  - a terminal result with `status: blocked` / `pending_approval`, and file-tool
    results with `error: "BLOCKED: …"` / `"Refusing to write …"`, send nothing, record
    no key and free the step (a later call in the same step queries);
  - a call blocked before execution (pre only, no transform) sends nothing;
  - the query uses the transform's args (a plugin `modify`);
  - the existing delivery / fail-closed / parallel tests keep passing with the query
    now started in the transform.
- Code (`integrations/hermes/scripts/ct_wisdom_activity.py`): `ActivityState.claim_step`
  / `release_step` / `start_key` / `release_key`; `_pre_tool_call` claims only;
  `_transform` checks refusal, rebuilds the activity, admits the key, starts the worker
  and waits up to `LIVE_TIMEOUT`.

## Task 2: key release

- Tests: `budget`, `timeout`, `exit`, `parse_error`, `spawn` free the key (the same
  activity re-queries in a later step) and keep the step; `zero_hits` keeps the key.
- Code: release on every post-start non-delivery except `zero_hits`.

## Task 3: budget miss = one breaker failure

- Tests: a budget miss records exactly one failure; a later worker timeout is not
  counted again; a late success does not reset the breaker; a refused call counts zero.
- Code: settle-once per query under a lock.

## Task 4: 0.6.8 review items

- `-mpytest` / `-umpytest` parse (test first); remove the redundant sent-string name
  check; `_project_package` stats first and lists only on a hit (a test that counts
  `os.listdir` calls on a miss); `_resolve` inner homes cached per root (a test that
  `_homes`-derived inner list is computed once per root); behavioral replacement for
  `test_blocked_requires_user_homes` (calling `_blocked` / `_find_root` without `user`
  raises `TypeError`, and a real user home inside a root still blocks it).

## Task 5: golden blocks, copies, docs

- Confirm `tests/fixtures/activity_blocks.json` matches Hermes's renderer (the golden
  test, including the correction case) — no fixture change expected.
- Re-copy `ct_wisdom_activity.py` to claude-code and docker-agent; patch-bump them;
  CHANGELOG notes.
- hermes 0.7.0 (`plugin.yaml`, `integration.yaml`, CHANGELOG with the 0.6.8 correction),
  README Hermes rows, `tools/ct_ci.py readme`.

## Task 6: e2e

- `integrations/hermes/tests/e2e/e2e.sh`: a second scratch plugin that blocks
  `read_file secrets.env`, and `approvals.deny: ["git push*"]`; two more TASK.md steps;
  checks that CT received neither `secrets.env` nor `git push`, and that both calls
  were really refused.
- Run `integrations/hermes/tests/e2e/run.sh` (scratch HOME, brain and HERMES_HOME in the
  container).

## Task 7: suites, gates, PR

- `python -m unittest discover -s tests` in hermes, claude-code, docker-agent;
  `tests/tools`; ruff; the policy gates. Commit, push, PR, wait for CI.

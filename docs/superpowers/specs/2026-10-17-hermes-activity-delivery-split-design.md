# Split the Hermes activity delivery out of the shared builder — design

**Date:** 2026-10-17 · **Status:** Draft for user review · **Branch:** `refactor/hermes-activity-delivery-split`
· **Base:** `main` @ `2466274`
**Release:** hermes 0.7.1 → 0.7.2, claude-code 0.4.2 → 0.4.3, docker-agent 0.1.2 → 0.1.3 (last three-way bump)
**Builds on:** the architecture review in handoff `2026-10-17e-fable-architecture-open-items.md` (item C), and the
user's decisions of 2026-10-17 (below).

Tags: **[V]** verified in this session by reading the repo at `2466274`. Line numbers are in
`integrations/hermes/scripts/ct_wisdom_activity.py` unless another file is named.

## Problem

`ct_wisdom_activity.py` holds two things:

1. **The activity builder and renderer.** This is the privacy boundary for what is sent (targets, roots, names,
   `activity_for`, `query_for`), plus the block renderer and the result splice. Hermes, Claude Code and Docker Agent
   all use it.
2. **The Hermes `transform_tool_result` delivery.** This is the step and key state, the prefetch thread, the
   unusable-ct latch, the breaker and budget handling, `proves_ran`, `_transform` and `_deliver`. Only Hermes uses it.

The file is byte-identical in all three integrations ([V] `tests/tools/test_shared_script_parity.py:64-69`,
`IDENTICAL_EXTRA`). So every Hermes-only fix bumps three integrations (hermes 0.7.1 bumped claude-code 0.4.2 and
docker-agent 0.1.2 with "no behavior change" entries), and Claude Code and Docker Agent ship about 600 lines of code
they never run.

## User decisions (binding, 2026-10-17)

1. Do this item first, as its own spec and PR, before the ct-wisdom-core `cancel` and spawn-binding work.
2. The shared builder keeps the name `ct_wisdom_activity.py`. The Hermes-only half moves to
   `integrations/hermes/scripts/ct_wisdom_activity_delivery.py`.

## Facts at `2466274`

- **[V] The builder** is the constants, `Activity`, the target, root and name helpers, `activity_for`, `query_for`
  (start of file to about line 990), and the renderer and splice: `_one_line`, `render_candidates`,
  `render_activity_block`, `_parse`, `_splice_mode`, `splice` (about lines 1327-1432).
- **[V] The Hermes delivery** is `ActivityState` and `_STATE` (about 998-1084); `_spawn`, the unusable latch, the probe
  slot, `_ct_warm`, `_Prefetch`, `reset_state`, `_record_breaker`, `_finish`, `_run_prefetch`, `_wait`,
  `_budget_ran_out`, `_skip`, `_nonempty`, `_blocked_report`, `_gate_blocked` (about 1086-1326); and the recorders,
  `on_transform_tool_result`, the proof comment, `_is_count`, `proves_ran`, `_transform`, `_deliver` (about 1433-end).
- **[V] Claude Code and Docker Agent hooks** import only builder names: `Activity`, `activity_for`, `is_ct_tool`,
  `query_for`, `render_activity_block`, `render_candidates`, `splice`, `_splice_mode`, `RECENT_KEYS_MAX`,
  `ACTIVITY_MAX_PER_STEP`. Their tests also call `reset_state` (8 uses), `_fs_root` and `_system_identity`.
  `tests/tools/test_activity_target_vectors.py` calls `act.reset_state()` (lines 100, 105, 166-167).
- **[V] `reset_state`** (1182-1191) clears Hermes state (`_STATE`, the unusable latch, the probe slot) **and** builder
  caches (`_root_cache`, `_sln_cache`, `_homes_cache`, `_module_cache`, `_pwd_identity`).
- **[V] The builder imports** `threading` (the `_TTLCache` lock, line 296), `time`, `hashlib`, `ct_ledger` and
  `ct_wisdom`. It never uses `ct_wisdom_live` or `ct_wisdom_verbose`; only the delivery half does.
- **[V] Hermes loads the module lazily:** `integrations/hermes/__init__.py:167-169` imports `ct_wisdom_activity` and calls
  `ct_wisdom_activity.on_transform_tool_result(**kwargs)`.
- **[V] Shipping:** Hermes `install.sh` copies `scripts/.`, the Claude Code hooks add `../scripts` to `sys.path`, and
  each `integration.yaml` packages with `include: ["**"]`. A new file under `integrations/hermes/scripts/` ships
  with no manifest edit.
- **[V] Hermes tests** that import the module are `test_ct_wisdom_activity.py`, `test_ct_wisdom_activity_ran.py` and
  `test_exactly_once.py`. They patch delivery internals (`act._spawn`, `act._wait`, `act._ct_warm`, `act._skip`, …)
  and also use builder functions.

## Design

### Module boundary

- **`ct_wisdom_activity.py` (shared, identical in all three integrations):** the builder and renderer only, exactly
  the code listed above, moved byte for byte. New public `reset_caches()` (test-only) clears the builder caches:
  the cache half of today's `reset_state`. Delivery-only constants (`STEP_IDS_MAX`, `SESSIONS_MAX`) move to the
  delivery module. All other constants stay, because the hooks use `ACTIVITY_MAX_PER_STEP`, `RECENT_KEYS_MAX` and
  the rest. The module docstring is rewritten to describe the builder and point to the delivery module for Hermes.
  The `ct_wisdom_live` and `ct_wisdom_verbose` imports are dropped.
- **`ct_wisdom_activity_delivery.py` (Hermes only, new):** everything in the delivery list, moved byte for byte
  except for name qualification. It does `import ct_wisdom_activity as builder` and calls builder names through it
  (`builder.activity_for`, `builder.query_for`, `builder._parse`, `builder._splice_mode`, `builder.splice`,
  `builder.render_candidates`, `builder.render_activity_block`, `builder.is_ct_tool`, `builder._is_activity_tool`,
  and constants such as `builder.ACTIVITY_RESULT_KEY`). Qualified access (not `from … import`) keeps test patches of
  a builder name visible to the delivery code, and it shows which side owns each name. `reset_state()` stays here:
  it resets the delivery state and calls `builder.reset_caches()`. The current module docstring (the hook's design
  notes and failure-class list) moves here.
- **`integrations/hermes/__init__.py`:** `import ct_wisdom_activity_delivery` and call its
  `on_transform_tool_result`. Comments that name `ct_wisdom_activity` for the delivery are updated.

**No behavior change.** Same queries, same skip classes, same blocks, same splice. Only the location changes.

### Parity gate (`tests/tools/test_shared_script_parity.py`)

- Move `ct_wisdom_activity.py` from `IDENTICAL_EXTRA` into `IDENTICAL`, and delete `IDENTICAL_EXTRA` (now empty).
- Add `HERMES_ONLY = ("ct_tool_dedup.py", "ct_wisdom_activity_delivery.py")`. Assert each exists in
  `integrations/hermes/scripts/` and is absent from the claude-code and docker-agent `scripts/`.
- Add a boundary guard on the shared file: it does not define `on_transform_tool_result`, `ActivityState`,
  `_transform`, `_deliver` or `proves_ran`, and it does not import `ct_wisdom_live` or `ct_wisdom_verbose`. This is
  checked by parsing the file with `ast`, not by grepping, so a docstring mention doesn't trip it. The guard keeps
  Hermes delivery from creeping back into the shared file.

### Tests

- **Hermes:** `test_ct_wisdom_activity.py`, `test_ct_wisdom_activity_ran.py` and `test_exactly_once.py` import the
  delivery module for delivery behavior. Patches of delivery internals target the delivery module, and builder-only
  tests keep using `ct_wisdom_activity`. Every existing test keeps its assertions. Test count changes only by the new
  tests below.
- **New Hermes tests:**
  - `reset_caches` clears the builder caches and leaves delivery state alone;
  - `reset_state` clears both;
  - the delivery module calls the builder through the module object, so patching `ct_wisdom_activity.activity_for`
    changes what delivery builds.
- **Claude Code, Docker Agent and `tests/tools/test_activity_target_vectors.py`:** `reset_state` becomes
  `reset_caches`. `_fs_root` and `_system_identity` stay builder names, so those uses are unchanged.
- **Cross-language goldens** (`tests/tools/test_activity_block_golden.py`, the target vectors) must pass unchanged.
  They prove the builder output is byte-identical.
- **e2e:** re-run the Hermes e2e (scratch profile, isolated HOME and brain) on the final head.

### Release

- hermes 0.7.2, claude-code 0.4.3 and docker-agent 0.1.3. The shipped scripts change in all three, so the version
  gate needs all three bumped this once. CHANGELOG entries say "internal split, no behavior change", and Hermes adds
  "later Hermes-only fixes no longer bump Claude Code and Docker Agent". Update the README rows and the docker-agent
  tests that hardcode the version (as in 0.1.2).
- [V] The `discover_ct` docstring in `ct_wisdom.py:170` names `ct_wisdom_activity.CT_UNUSABLE_PAUSE`, which moves
  to the delivery module. Change it to `ct_wisdom_activity_delivery.CT_UNUSABLE_PAUSE (Hermes)`. `ct_wisdom.py` is a
  shared identical file, so all three copies change together.

## Alignment with INTENT.md

- **Rule 9 (send as little as possible):** the builder is the privacy boundary. It moves byte for byte and stays
  identical in all three hosts. The golden and target-vector suites prove its output is unchanged.
- **Rule 4 (fail quietly):** the Hermes hook keeps its never-raise wrapper (`on_transform_tool_result`), unchanged.
- **Rules 1, 3 and 6:** delivery logic (ledger claim, supersession rendering, limits) is moved, not changed.
- **CONTRIBUTING: no cross-integration imports.** Claude Code and Docker Agent keep their own copy of the builder.
  Nothing imports across integrations.
- **No departure from INTENT.md.**

## Known limitations

- A large mechanical move makes a noisy diff. Reviewers should check it with `git diff --color-moved`. The PR states
  that no logic changed.
- `_parse`, `_splice_mode` and `_is_activity_tool` stay private names in the shared builder while the delivery module
  uses them. Making them public would touch Claude Code and Docker Agent imports, which isn't worth it here.

## Out of scope

- The ct-wisdom-core `cancel` parameter and shared spawn binding (items A and B; the next spec).
- Any behavior change to delivery or to the builder.

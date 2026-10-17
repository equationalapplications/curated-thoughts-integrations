# ct-wisdom-core: one shared spawn binding, and a core-owned `cancel` — design

**Date:** 2026-10-17 · **Status:** Approved (user, 2026-10-17) · **Branch:** `feat/core-spawn-binding-and-cancel`
· **Base:** `main` @ `fb66034`
**Delivery:** one spec and one plan, landed as **two PRs**: B (the spawn binding) first, then A (cancel).
**Releases:** each PR bumps the three TypeScript hosts. PR B: deepseek 0.6.2 → 0.6.3, opencode 0.4.2 → 0.4.3,
openclaw 0.3.1 → 0.3.2. PR A: deepseek 0.6.4, opencode 0.4.4, openclaw 0.3.3.
**Builds on:** the Fable architecture review (handoff `2026-10-17e-fable-architecture-open-items.md`, items A and B);
the DSH spec's 0.6.2 amendments and "Follow-ups" (`2026-10-16-dsh-autonomous-work-wisdom-design.md`, about lines
520-575); the user's decisions of 2026-10-17.

Tags: **[V]** verified in this session by reading the repo at `fb66034`.

## Problem

**B. Three spawn bindings, one of them right.**
- DSH's binding has every fix from the PR #71 reviews ([V] `integrations/deepseek/src/wisdom-live/adapter.ts:86-233`):
  - `spawnOutcomeOf` normalization;
  - one kill path, `killTree`, for timeout, abort and overflow;
  - a child with no pid, or one that already exited, is never signalled;
  - after a kill, once the child has exited, `close` gets a 250 ms grace (only after a kill: a child that exits
    normally while a descendant holds stdout waits out the full timeout; PR B fixes that);
  - an abort after exit keeps the real result;
  - a call whose signal is already aborted starts nothing.
- OpenCode's binding ([V] `integrations/opencode/src/wisdom-live/adapter.ts:181-267`) and OpenClaw's
  ([V] `integrations/openclaw/src/wisdom/spawn.ts`) lack those fixes:
  - they have no grace, so a kill that cannot close the pipes (Windows, or a descendant that left the process
    group) leaves the promise unsettled forever;
  - `child.kill()` runs with no pid guard;
  - OpenCode spawns a child even when the signal is already aborted (`:247`);
  - an abort after exit is marked `aborted`.
- OpenClaw has one thing right that DSH lacks: it keeps raw Buffers and decodes them once
  ([V] `spawn.ts`, the "Raw Buffers, decoded ONCE" block). DSH decodes each chunk with `toString` ([V] `adapter.ts:222`),
  so a multi-byte character split across chunks comes out garbled.

**A. Cancel goes through a side channel.**
- The core passes the host's signal untouched: `startActivity(…, signal?)` → `runActivityMatch` →
  `host.wisdomMatch(…, signal)` ([V] `packages/ct-wisdom-core/src/activity.ts:1240-1251, 1340-1351`). A
  `signal.aborted` result is one breaker charge plus `'budget'`, and any other `aborted` outcome is `'budget'`
  with no charge ([V] `:1256-1262`).
- DSH needs a cancel that never charges (an abandoned plan), so it hands the core a signal nobody ever aborts. It
  keys a WeakMap on that signal (`linkCancel`) and composes `AbortSignal.any([budget, cancel])` for its spawns
  ([V] `adapter.ts:535-559`, `:490`). It charges the miss itself at expiry
  ([V] `integrations/deepseek/src/wisdom-live/activity.ts:445-448`), and it relabels a kill that surfaced as
  `timeout_or_exit` to `aborted` ([V] `adapter.ts:524`).
- This depends on the core never wrapping the signal. The DSH spec names the clean fix: a `cancel` parameter in the
  core.
- **OpenCode and OpenClaw** abort one AbortController on expiry ([V] opencode `activity.ts:314-331`, openclaw
  `activity.ts:247-257`). The core charges the miss only when the match promise settles, and with today's bindings a
  hung child never settles. So **the miss is never charged** and the breaker never opens for a `ct` that keeps
  hanging. B makes the bindings always settle; A moves the charge to the moment of expiry.

## User decisions (binding, 2026-10-17)

1. Order: C first (done, PR #75), then A and B together: one spec and plan, two PRs, B then A.
2. A migrates all three hosts at once. There is **no deprecated `signal` alias** on `startActivity`, because every
   consumer lives in this repo and moves in the same PR.

## Design — PR B: `packages/ct-wisdom-core/src/spawn.ts`

**API** (re-exported from `src/index.ts`, next to the existing `SpawnLike`, `SpawnOutcome` and `SpawnFn` in `match.ts`):

```ts
export interface NodeSpawnOptions {
  /**
   * Two bounds, one value (default 250): after ANY exit, how long to wait for 'close'; and after a kill of a
   * child that has not exited, the hard deadline by which the call settles even if the kill failed.
   */
  killGraceMs?: number;
  /** Byte cap for stdout and for stderr; past it the child is killed and the outcome is spawnError (default 4 MiB). */
  capBytes?: number;
}
export function nodeSpawnFn(
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv),   // default process.env; a getter is read at spawn time
  opts?: NodeSpawnOptions,
): SpawnFn;
export function spawnOutcomeOf(raw: {
  code: number | null; stdout: string; stderr: string;
  spawnError: boolean; overflow: boolean; timedOut: boolean; aborted: boolean;
}): SpawnOutcome;
```

**Behavior.** DSH's binding body, unchanged in substance, plus two things from OpenClaw:
- Spawn options: an argument list (never a shell string), `shell: false`, `windowsHide`, `cwd` = HOME or USERPROFILE
  or `.`, `stdio: ['ignore','pipe','pipe']`, `killSignal: 'SIGKILL'`, and `detached` on POSIX (the child leads its
  process group).
- An already-aborted signal resolves `{aborted: true}` without spawning.
- One `killTree`. On POSIX it kills the process group (`-pid`) and falls back to the direct child. On Windows it kills
  the direct child. A child with no pid is never signalled. A child that already exited is never signalled (its
  group id may have been reused); only the exit-time grace bounds the wait.
- Once the child has exited, for any reason (normal exit or a kill), `close` gets `killGraceMs`. Then the pipes are
  destroyed and the promise settles with the real exit code and the output read so far. The outcome is fixed at exit:
  `timedOut` and `aborted` are set only when the timer or abort lands before exit, so a child that exits normally while
  a descendant holds stdout is never reported as timed out.
- `'error'` is a failed start only when the child never got a pid; on a started child (e.g. a failed kill) it is
  ignored and exit, `close` or the grace settle.
- The binding always settles. The first kill of a child that has not exited (timeout, abort or overflow) arms a hard
  deadline of `killGraceMs`. If neither `close` nor the exit grace has settled the call by then (a kill that failed
  while the child keeps running), the pipes are destroyed and the call settles with code null (or the exit code if it
  has exited), with `timedOut`, `aborted` and overflow as set. Whichever end path comes first wins.
- Past the byte cap, nothing more is collected on either stream and the tree is killed once.
- An abort after exit keeps the real result. An overflow is `spawnError`, never `aborted` (`spawnOutcomeOf`).
- **New, from OpenClaw:** raw Buffers are accumulated and decoded once at settle, and the cap counts real bytes.
- **New, from OpenClaw:** `env` may be a getter, resolved per spawn.

**Host migration.**
- DSH: delete its binding (`adapter.ts:71-233`) and import `nodeSpawnFn` from the core. The DSH tests that exercise
  the binding move to the core.
- OpenCode: delete `adapter.ts:~171-267` and import from the core.
- OpenClaw: delete `src/wisdom/spawn.ts`. `src/index.ts:53` imports from the core, and `tests/test_spawn.ts` moves
  to the core (the multi-byte case).
- Each host keeps injecting `deps.spawnFn` for tests. Only the default changes.

**Tests (in the core).**
- Port DSH's binding tests: the real fake binary, abort of the real process tree, the escaped-descendant grace
  (POSIX), ENOENT is `spawnError` and never signals, abort after exit keeps the result, already-aborted never spawns,
  overflow is `spawnError`.
- Port OpenClaw's multi-byte split-chunk test.
- Add one **platform-neutral** test: a Node child that starts a detached grandchild with inherited stdio, then exits.
  Abort and timeout must both settle within `killGraceMs + slack` on every OS.
- CI ([V] `.github/workflows/ci.yml:78-99`): the core job runs on ubuntu only, while every TypeScript host runs on
  Windows too. **Extend the core job to `ubuntu-latest` and `windows-latest`** (a matrix), so the binding's Windows
  path is tested where it lives. POSIX-only tests stay marked `skipIf(win32)`.

**Release (PR B).** deepseek 0.6.3, opencode 0.4.3, openclaw 0.3.2. The CHANGELOGs say OpenCode and OpenClaw no longer
hang when a killed `ct` never closes its output (Windows, or an escaped descendant), and DSH gets correct multi-byte
output.

## Design — PR A: a core-owned `cancel`

**API** (`src/activity.ts`):

```ts
export type ActivityCancelReason = 'budget' | 'abandoned';
export type ActivityStart =
  | { failure: null; match: Promise<ActivityMatch>; cancel(reason: ActivityCancelReason): void }
  | { failure: string };
export function startActivity(host: HostAdapter, session: SessionRef, activity: Activity, breaker: Breaker): ActivityStart;
```

- `startActivity` creates the AbortController and passes its signal to `runActivityMatch`, and from there to
  `host.wisdomMatch(…, signal)`. `HostAdapter.wisdomMatch` is unchanged.
- **`cancel('budget')`** calls `recordActivityBudgetMiss(breaker)` **synchronously** (so the next step's breaker gate
  sees it even if the child never settles), then aborts.
- **`cancel('abandoned')`** only aborts.
- `cancel` is idempotent: the first reason wins, and it is a no-op once the match has settled.
- `runActivityMatch(host, activity, exclude, breaker, control?)` takes an internal
  `control: { signal: AbortSignal; reason(): ActivityCancelReason | null }` in place of the bare signal. It stays
  exported for tests.

**Classification in `runActivityMatch`**, in this order:
1. A real answer wins: outcome `ok` with a parsed result calls `breaker.recordSuccess()` and returns the result, even
   after a cancel. This keeps DSH's current rule that a late real answer clears the charge. [V] `recordSuccess` resets
   the whole consecutive-failure count and closes the breaker (`breaker.ts:32-35`): `ct` did answer.
   A `spawn` outcome (checked next) always resets the discovery and probe caches, whatever the cancel reason: the
   binding reports `spawnError` only when `ct` truly could not start, so the reason only decides the class and the
   charge. This is a controller ruling made during implementation (the first draft skipped the reset after a cancel).
2. Cancel reason `'budget'` returns `{ failure: 'budget' }`. It was already charged at cancel time, so nothing more is
   charged.
3. Cancel reason `'abandoned'` returns `{ failure: 'cancelled' }`, with no charge, whatever the outcome
   (`aborted` or `timeout_or_exit` from a kill). This absorbs DSH's relabel at `adapter.ts:524`.
4. Otherwise the existing mapping is unchanged: `spawn` returns `'spawn'` (its reset already happened), `timeout_or_exit` is one failure,
   `aborted` from the host's own spawn with no core cancel is `budget` with no charge (as today), and a missing result
   is `parse_error`.

`finishActivityOutcome` already treats every reason except `zero_hits` as `retry: true`, so `'cancelled'` frees the
key.

**Host migration.**
- DSH (`activity.ts`):
  - `plan.cancel` becomes `start.cancel`;
  - the slot replace, eviction and `would_extend_turn` paths (`:283`, `:436`) call `cancel('abandoned')`;
  - expiry (`:445-448`) becomes `settleWithin(…, () => plan.cancel('budget'))`, and the host's own
    `recordActivityBudgetMiss` call is deleted;
  - the adapter's `linkCancel`, the `cancels` WeakMap, `spawnSignal` and the `:524` relabel are deleted, and
    `wisdomMatch` uses the signal it receives.
- OpenCode (`activity.ts:314-331`) and OpenClaw (`activity.ts:247-257`) drop their AbortController and call
  `start.cancel('budget')` on expiry.

**Tests.**
- Core, with a fake host and no timing: every reason (`budget`, `abandoned`, none) against every outcome (`ok` with a
  result, `aborted`, `timeout_or_exit`, `spawn`):
  - `budget` charges exactly once, at cancel time, and a later `ok` clears it;
  - `abandoned` never charges;
  - cancel after settle is a no-op;
  - a second cancel is a no-op;
  - a host whose `wisdomMatch` ignores the signal still gets the charge at expiry.
- DSH: the "a cancel kills the grandchild" test runs through `start.cancel`, and the adapter test for `linkCancel`
  (`tests/test_wisdom_live_adapter.ts:~328`) is deleted.
- OpenCode and OpenClaw: a binding that never settles (a fake `spawnFn` returning a forever-pending promise). After
  expiry the breaker counts one failure, and after three such steps it is open. Today this test would fail.

**Release (PR A).** deepseek 0.6.4, opencode 0.4.4, openclaw 0.3.3. The CHANGELOGs say a `ct` that hangs past the
budget now counts against the breaker on OpenCode and OpenClaw (it pauses after three misses, like DSH and Hermes),
and DSH drops its internal side channel with no behavior change.

## Alignment with INTENT.md

- **Rule 4 (failing quietly; short timeouts; repeated failures pause CT):**
  - B ensures every CT call settles within its timeout plus a short grace on every host, so a hung child can no
    longer stall delivery.
  - A ensures a missed budget counts exactly once, at expiry, so a `ct` that keeps hanging pauses CT on every host.
    Today it pauses on DSH and Hermes only.
  - An abandoned query never counts.
- **Rule 7 (read-only, only through CT's commands):** the binding runs only the discovered `ct` with an argument list,
  never a shell, unchanged.
- **Rule 9 (send as little as possible):** argv construction (`matchArgs`) is unchanged, and nothing beyond the query
  reaches the child.
- **Rule 8 (relevance is CT's job):** cancel semantics only; no scoring or judging.
- **No departure from INTENT.md.**

## Known limitations

- On Windows a kill reaches only the direct child; descendants survive. The grace bounds the wait. `taskkill /T` is a
  possible follow-up, out of scope here.
- The core job's Windows run adds CI time to every core change.

## Out of scope

- The Python hosts (Hermes, Claude Code, Docker Agent). They have their own subprocess handling.
- Changing budgets or timeouts.

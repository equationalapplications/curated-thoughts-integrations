# Core spawn binding and core-owned cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **PR B:** move DeepSeek's hardened Node spawn binding into ct-wisdom-core, shared by deepseek, opencode and openclaw.
- **PR A:** make the core own activity cancellation: `startActivity` returns `cancel('budget' | 'abandoned')`.

**Architecture:**
- **PR B** adds `packages/ct-wisdom-core/src/spawn.ts`, generated from DSH's binding (`integrations/deepseek/src/wisdom-live/adapter.ts`) by a one-off script, plus OpenClaw's byte-correct decoding and env getter. The three hosts drop their bindings.
- **PR A** changes `startActivity` and `runActivityMatch` in `packages/ct-wisdom-core/src/activity.ts` and migrates the three hosts. It deletes DSH's `linkCancel` side channel.

**Tech Stack:** TypeScript (Node 24 locally; CI uses each host's Node), vitest, pnpm. Hosts consume the core through
`file:../../packages/ct-wisdom-core`, which pnpm **copies at install time**. After any core change, run
`(cd packages/ct-wisdom-core && pnpm run build)` and then `pnpm install` in each host before running its tests.

**Spec:** `docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md`

## Global Constraints

- Two PRs. **PR B** is Tasks 1-3 on branch `feat/core-spawn-binding-and-cancel` (already holds the spec and this plan).
  **PR A** is Tasks 4-6 on a new branch `feat/core-activity-cancel`, cut from `main` **after PR B is merged**.
- PR B versions: deepseek `0.6.2 → 0.6.3`, opencode `0.4.2 → 0.4.3`, openclaw `0.3.1 → 0.3.2`.
  PR A versions: deepseek `0.6.4`, opencode `0.4.4`, openclaw `0.3.3`.
- Binding defaults: `killGraceMs` 250, `capBytes` 4 MiB (4 * 1024 * 1024). Spawn options are unchanged from DSH: an
  argument list, `shell: false`, `windowsHide`, `killSignal: 'SIGKILL'`, `detached` on POSIX, `cwd` = HOME,
  USERPROFILE or `.`.
- No deprecated `signal` alias on `startActivity` (user decision).
- Cancel semantics are exactly as in the spec ("Classification in `runActivityMatch`").
- Never run `ct`, `curated-thoughts-mcp` or any Curated Thoughts command on the host. The e2e runs in its container
  with a scratch HOME and brain.
- Commit trailer: `Co-Authored-By: <the model you run as> <noreply@anthropic.com>`.

A throwaway prototype of Task 1 and the core half of Task 4 (scratchpad, 2026-10-17) passed. The core suite had 135
tests before; it had 151 after Task 1 (16 new). `tsc` was clean, and with Task 4 the budget suite passed 17/17.

---

## PR B

### Task 1: `src/spawn.ts` in the core, its tests, and Windows CI for the core

**Files:**
- Create: `packages/ct-wisdom-core/src/spawn.ts`, `packages/ct-wisdom-core/tests/spawn.test.ts`
- Modify: `packages/ct-wisdom-core/src/index.ts` (one export line), `.github/workflows/ci.yml` (the core job, around lines 70-100)

**Interfaces:**
- Produces: `nodeSpawnFn(env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv), opts?: NodeSpawnOptions): SpawnFn`,
  `spawnOutcomeOf(raw): SpawnOutcome`, `interface NodeSpawnOptions { killGraceMs?: number; capBytes?: number }`, and
  `DEFAULT_KILL_GRACE_MS = 250`, `DEFAULT_CAP_BYTES = 4 * 1024 * 1024`. All are re-exported from the package root.

- [ ] **Step 1: Generate the test file (RED)**

Write the script below to the scratchpad as `gen_spawn_test.py` and run it from the repo root:
`python3 gen_spawn_test.py integrations/deepseek/tests/test_wisdom_live_adapter.ts packages/ct-wisdom-core/tests/spawn.test.ts`.
It copies DSH's binding tests into the core: the `nodeSpawnFn (real binding, fake binary)` describe, the
`nodeSpawnFn abort (real process tree)` describe up to but **not** including the `linkCancel` test, and the
`spawnOutcomeOf` describe. It finds them by their titles, not by line numbers, and adds an every-OS describe.

```python
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()

def cut(start_marker, end_marker):
    a = s.index(start_marker)
    b = s.index(end_marker, a)
    return s[a:b].rstrip()

part1 = cut("describe('nodeSpawnFn (real binding, fake binary)'",
            "  it('a host cancel linked to the budget signal kills the child")
part2 = cut("describe('spawnOutcomeOf (one normalization in the binding)'", "\ndescribe('ledger rebuild")
head = '''/**
 * spawn.test.ts — the shared Node spawn binding (spec
 * 2026-10-17-core-spawn-binding-and-cancel-design.md). Ported from the
 * deepseek adapter suite (PR #71 review fixes) and the openclaw spawn suite
 * (multi-byte decoding), plus a platform-neutral settle test.
 */

import { describe, it, expect } from 'vitest';

import { nodeSpawnFn, spawnOutcomeOf } from '../src/spawn.js';

'''
neutral = r'''

describe('nodeSpawnFn (every OS)', { timeout: 30_000 }, () => {
  it('decodes multi-byte output split across chunks intact (openclaw)', async () => {
    // 200k copies of a 3-byte character: far past one pipe chunk.
    const script = "process.stdout.write('\\u20ac'.repeat(200000))";
    const r = await nodeSpawnFn(process.env)({ command: process.execPath, args: ['-e', script], timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(200000);
    expect(r.stdout.includes('�')).toBe(false);
  });

  it('reads the env getter at spawn time (openclaw)', async () => {
    let value = 'first';
    const fn = nodeSpawnFn(() => ({ ...process.env, CT_SPAWN_PROBE: value }));
    value = 'second';
    const r = await fn({ command: process.execPath, args: ['-e', 'process.stdout.write(process.env.CT_SPAWN_PROBE)'], timeoutMs: 10_000 });
    expect(r.stdout).toBe('second');
  });

  it('caps output by bytes: past capBytes the outcome is a spawn error, never aborted', async () => {
    const r = await nodeSpawnFn(process.env, { capBytes: 1024 })({
      command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(100000))"], timeoutMs: 10_000,
    });
    expect(r.spawnError).toBe(true);
    expect(r.aborted).toBeUndefined();
  });

  it('settles after abort and after timeout even when a detached grandchild holds the pipes', async () => {
    // The child starts a detached grandchild that inherits stdout/stderr and
    // outlives it, then idles: a kill reaches the child (on Windows only the
    // child), the grandchild keeps the pipes open, so 'close' may never fire.
    const child = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.stdout.write(String(g.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join('\n');
    for (const mode of ['abort', 'timeout'] as const) {
      const abort = new AbortController();
      const started = Date.now();
      const pending = nodeSpawnFn(process.env, { killGraceMs: 250 })({
        command: process.execPath, args: ['-e', child], timeoutMs: mode === 'timeout' ? 1500 : 30_000, signal: abort.signal,
      });
      if (mode === 'abort') setTimeout(() => abort.abort(), 1000);
      const out = await pending;
      expect(Date.now() - started).toBeLessThan(10_000);
      if (mode === 'abort') expect(out.aborted).toBe(true);
      else expect(out.timedOut).toBe(true);
      const pid = Number(out.stdout.trim().split('\n')[0]);
      try { if (pid > 0) process.kill(pid); } catch { /* gone */ }
    }
  });
});
'''
open(dst, "w").write(head + part1 + "\n});\n\n" + part2 + neutral)
print("ok")
```

Run: `(cd packages/ct-wisdom-core && npx vitest run tests/spawn.test.ts)`
Expected: FAIL, with the import `../src/spawn.js` not found.

- [ ] **Step 2: Generate `src/spawn.ts` from DSH's binding**

Write this to the scratchpad as `gen_spawn.py` and run
`python3 gen_spawn.py integrations/deepseek/src/wisdom-live/adapter.ts packages/ct-wisdom-core/src/spawn.ts`:

```python
import sys
src = open(sys.argv[1]).read()
a = src.index("/**\n * The binding's one outcome normalization")
b = src.index("\n}\n", src.index("export function nodeSpawnFn(")) + 3   # end of nodeSpawnFn
body = src[a:b]

def sub(old, new):
    global body
    assert body.count(old) == 1, old[:60]
    body = body.replace(old, new)

sub("const KILL_GRACE_MS = 250;",
    "export const DEFAULT_KILL_GRACE_MS = 250;\nexport const DEFAULT_CAP_BYTES = 4 * 1024 * 1024;\n\n"
    "export interface NodeSpawnOptions {\n"
    "  /** After a kill, how long to wait for 'close' once the child has exited. */\n  killGraceMs?: number;\n"
    "  /** Byte cap for stdout and for stderr; past it the child is killed (spawnError). */\n  capBytes?: number;\n}")
sub("export function nodeSpawnFn(env: NodeJS.ProcessEnv = process.env): SpawnFn {\n  return (spec) =>\n    new Promise((resolve) => {",
    "export function nodeSpawnFn(\n  envOrGetter: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = process.env,\n"
    "  opts: NodeSpawnOptions = {},\n): SpawnFn {\n  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;\n"
    "  const CAP = opts.capBytes ?? DEFAULT_CAP_BYTES;\n  return (spec) =>\n    new Promise((resolve) => {\n"
    "      // A getter is read per spawn (OpenClaw: the env follows the current registration).\n"
    "      const env = typeof envOrGetter === 'function' ? envOrGetter() : envOrGetter;")
sub("        }, KILL_GRACE_MS);", "        }, killGraceMs);")
sub("""      let stdout = '';
      let stderr = '';
      let overflow = false;
      const CAP = 4 * 1024 * 1024;""", """      // Raw Buffers, decoded ONCE at settle (OpenClaw): per-chunk toString
      // would split a multi-byte character across chunk boundaries, and the
      // cap is a true byte count.
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let overflow = false;""")
sub("resolve(spawnOutcomeOf({ code, stdout, stderr, spawnError, overflow, timedOut, aborted }));",
    "resolve(spawnOutcomeOf({\n          code,\n          stdout: Buffer.concat(out).toString('utf8'),\n"
    "          stderr: Buffer.concat(err).toString('utf8'),\n          spawnError,\n          overflow,\n"
    "          timedOut,\n          aborted,\n        }));")
for stream, buf, n in (("stdout", "out", "outBytes"), ("stderr", "err", "errBytes")):
    sub(f"""      child.{stream}?.on('data', (chunk: Buffer) => {{
        if ({stream}.length + chunk.length > CAP) {{
          overflow = true;
          killTree();
          return;
        }}
        {stream} += chunk.toString('utf8');
      }});""", f"""      child.{stream}?.on('data', (chunk: Buffer) => {{
        if ({n} + chunk.length > CAP) {{
          overflow = true;
          killTree();
          return;
        }}
        {n} += chunk.length;
        {buf}.push(chunk);
      }});""")
header = '''/**
 * spawn.ts — the one Node child_process binding for the core's SpawnFn
 * contract, shared by every TypeScript host (deepseek, opencode, openclaw).
 * Spec: docs/superpowers/specs/2026-10-17-core-spawn-binding-and-cancel-design.md.
 *
 * Argument LIST (never a shell string), no shell, cwd home, windowsHide,
 * SIGKILL, a POSIX process group so a kill takes the tree down, bounded byte
 * accumulation (the async spawn has no maxBuffer). `spec.signal` aborts: on
 * POSIX the child's process group is killed; on Windows only the direct
 * child. Every end path settles: after a kill, 'close' gets a short grace.
 */

import { spawn } from 'node:child_process';

import type { SpawnFn, SpawnOutcome } from './match.js';

'''
open(sys.argv[2], "w").write(header + body.rstrip() + "\n")
print("ok")
```

Then append `export * from './spawn.js';` to `packages/ct-wisdom-core/src/index.ts`.

- [ ] **Step 3: Run the core suite (GREEN)**

```bash
cd packages/ct-wisdom-core && npx tsc --noEmit -p . && npx vitest run
```
Expected: `tsc` clean and 151 tests passing (135 before, plus 16). Open `src/spawn.ts` and check that it has no
`stdout +=` or `stderr +=`, that it uses `killGraceMs` and `CAP` from the options, and that its header is as written.

- [ ] **Step 4: Windows CI for the core job**

In `.github/workflows/ci.yml`, the job named `core (ct-wisdom-core)` (`runs-on: ubuntu-latest`, around line 79):
1. Add `strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest] } }`.
2. Change `runs-on` to `${{ matrix.os }}`.
3. Change the job `name` to `core (ct-wisdom-core, ${{ matrix.os }})`.
4. Make the run step's shell `bash` (`shell: bash`), as the integration job already does for Windows.
5. Keep the rest unchanged.

If another job lists this one in `needs:`, the matrix keeps the same job id, so no edit is needed there. Check
`ci-ok`'s `needs` and confirm. Validate the YAML with
`python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` (or `ruby -ryaml`).

- [ ] **Step 5: Commit**

```bash
git add packages/ct-wisdom-core .github/workflows/ci.yml
git commit -m "feat(core): one shared Node spawn binding (src/spawn.ts); core CI on Windows too"
```

---

### Task 2: Hosts use the core binding; PR B release

**Files:**
- Modify: `integrations/deepseek/src/wisdom-live/adapter.ts` (delete the binding block, from its `// ─────` banner "SpawnFn: async child_process binding" through the end of `nodeSpawnFn`; import `nodeSpawnFn` from the core; drop the now-unused `spawn` import)
- Modify: `integrations/deepseek/tests/test_wisdom_live_adapter.ts` (delete the binding describes that moved; keep the `linkCancel` test and the `DshWisdomAdapter.wisdomMatch passes the signal` test; they move into a small remaining describe, which keeps the `alive`/`waitFor`/`hangingCt` helpers they use)
- Modify: `integrations/opencode/src/wisdom-live/adapter.ts` (delete its binding banner and `nodeSpawnFn`; import from the core)
- Delete: `integrations/opencode/tests/test_spawn_abort.ts` (its cases are covered by the core suite: abort kills the tree, no listener left, spawn error, pre-aborted)
- Delete: `integrations/openclaw/src/wisdom/spawn.ts`, `integrations/openclaw/tests/test_spawn.ts`; modify `integrations/openclaw/src/index.ts:53` to import `nodeSpawnFn` from `@equational-applications/ct-wisdom-core`; and check `integrations/openclaw/tests/test_review_fixes.ts` for imports of `../src/wisdom/spawn.js` (repoint them to the core)
- Release: `integrations/{deepseek,opencode,openclaw}/package.json` and `integration.yaml` versions, `integrations/openclaw/src/index.ts` `PLUGIN_VERSION`, the three CHANGELOGs, and the README rows (lines 14-16)

**Interfaces:**
- Consumes: `nodeSpawnFn`, `spawnOutcomeOf` and `type NodeSpawnOptions` from `@equational-applications/ct-wisdom-core` (Task 1).

- [ ] **Step 1: Rebuild the core and refresh each host's copy**

```bash
(cd packages/ct-wisdom-core && pnpm run build)
for h in deepseek opencode openclaw; do (cd integrations/$h && pnpm install --frozen-lockfile); done
```

- [ ] **Step 2: Repoint the bindings**

In each host, delete the local binding as listed in Files, and import `nodeSpawnFn` from
`@equational-applications/ct-wisdom-core`, either joining the host's existing core import or adding one. If a host
module re-exported `nodeSpawnFn` or `spawnOutcomeOf` for its tests, drop the re-export and point the tests at the
core. In the DSH test file, delete the moved describes:
- `nodeSpawnFn (real binding, fake binary)`;
- the binding cases of `nodeSpawnFn abort (real process tree)` (everything except the `linkCancel` test and the
  `wisdomMatch passes the signal` test);
- `spawnOutcomeOf (one normalization in the binding)`.

Keep the two remaining tests and the helpers they use in a describe named `adapter abort plumbing`.

- [ ] **Step 3: Run each host's checks**

```bash
for h in deepseek opencode openclaw; do (cd integrations/$h && pnpm run build && pnpm test && (pnpm run lint 2>/dev/null || true)); done
```
Expected: every suite passes. Each host's test count drops by exactly the number of moved or deleted binding tests.
List those counts in the report. Run lint through each host's `integration.yaml` `checks.lint` command if it has one
(read the yaml), not the `|| true` fallback.

- [ ] **Step 4: Release files (PR B)**

- deepseek `0.6.3`, opencode `0.4.3`, openclaw `0.3.2`: update `package.json` `version`, `integration.yaml` `version`, `integrations/openclaw/src/index.ts` `PLUGIN_VERSION`, and the README rows `[0.6.2]`→`[0.6.3]`, `[0.4.2]`→`[0.4.3]`, `[0.3.1]`→`[0.3.2]`. Grep each host's tests for the old version literal and update any test that asserts the plugin version.
- CHANGELOG entries directly under `## Unreleased`, keeping that heading and each file's existing heading format (`## <version> — 2026-10-17`):
  - opencode and openclaw: "**Fix: no more hang when a killed `ct` never closes its output** (Windows, or a child process that escaped its process group). The spawn binding now lives in the shared core: one kill path, a 250 ms grace after a kill, no signal to a child that never started or already exited, and a call aborted before it starts spawns nothing."
  - deepseek: "The spawn binding moved into the shared core (no behavior change), and multi-byte output split across pipe chunks is now decoded correctly."

- [ ] **Step 5: Full verification and commit**

```bash
(cd packages/ct-wisdom-core && npx vitest run)
for h in deepseek opencode openclaw; do (cd integrations/$h && pnpm run build && pnpm test); done
python3 -m unittest discover -s tests/tools
```
Expected: all pass (`tests/tools` includes the version and README policy checks).
`git add -A integrations packages README.md && git commit -m "refactor(hosts): use the core spawn binding; deepseek 0.6.3, opencode 0.4.3, openclaw 0.3.2"`.
Before committing, check `git status` for build output: `lib/` is gitignored, and nothing under `node_modules` or
`lib` may be staged.

---

### Task 3: PR B — e2e, PR, review (controller)

- [ ] Run the three TypeScript e2e harnesses in their containers (scratch HOME and brain):
  `integrations/{deepseek,opencode,openclaw}/tests/e2e/run.sh` (read each `run.sh` header for the keys it needs, and
  pass keys by name only). **Record each run.sh's own exit code and RESULT line.** A failure from `ct` latency (budget
  or timeout skips while queries started) is re-run once, and the PR says so.
- [ ] Push, open PR B with the spec and plan links and the e2e results, then run `/code-review <PR> high`. Fix findings
  in the same flow. Merge waits for the user; after the merge and a green main CI, tag `deepseek-v0.6.3`,
  `opencode-v0.4.3` and `openclaw-v0.3.2`.

---

## PR A (branch `feat/core-activity-cancel`, from `main` after PR B is merged)

### Task 4: Core-owned `cancel`

**Files:**
- Modify: `packages/ct-wisdom-core/src/activity.ts` (`runActivityMatch`, the `ActivityStart` type, `startActivity`)
- Modify: `packages/ct-wisdom-core/tests/budget.test.ts`

**Interfaces:**
- Produces:
  - `type ActivityCancelReason = 'budget' | 'abandoned'`;
  - `interface ActivityCancelControl { signal: AbortSignal; reason(): ActivityCancelReason | null }`;
  - `runActivityMatch(host, activity, exclude, breaker, control?: ActivityCancelControl): Promise<ActivityMatch>`;
  - `ActivityStart` success member `{ failure: null; match: Promise<ActivityMatch>; cancel(reason: ActivityCancelReason): void }`;
  - `startActivity(host, session, activity, breaker): ActivityStart`, with **no** signal parameter;
  - the new failure string `'cancelled'`.

- [ ] **Step 1: Replace the signal-based tests with the cancel tests (RED)**

In `tests/budget.test.ts`, delete the two tests that use the old signal API:
`'an aborted activity match is \`budget\` and counts ONE breaker failure (never a success)'` and
`'startActivity forwards the signal to the host'`. Keep `'recordActivityBudgetMiss is the one rule hosts without a
signal call'`. Insert the block below in their place, inside the same describe:

```ts
  // ── core-owned cancel (spec 2026-10-17-core-spawn-binding-and-cancel-design.md) ──

  /** A host whose wisdomMatch waits for the abort, then reports `outcome`. */
  function hangingHost(outcome: 'aborted' | 'timeout_or_exit' | 'spawn' | 'ok') {
    let seen: AbortSignal | undefined;
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        seen = signal;
        await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
        return outcome === 'ok' ? { outcome: 'ok', result: { entries: [], corrections: [] } } : { outcome };
      },
    });
    return { h, signal: () => seen };
  }

  function started(h: HostAdapter, breaker: Breaker) {
    const start = startActivity(h, { id: 's' }, activity, breaker);
    if (start.failure !== null) throw new Error(`refused: ${start.failure}`);
    return start;
  }

  it("cancel('budget') charges ONE failure at once, before the match settles, then aborts", async () => {
    const breaker = new Breaker();
    const { h, signal } = hangingHost('aborted');
    const start = started(h, breaker);
    await Promise.resolve();
    start.cancel('budget');
    expect(signal()?.aborted).toBe(true);
    // Charged synchronously: three budget misses open the breaker even if no match ever settles.
    for (let i = 1; i < BREAKER_FAILS; i++) started(hangingHost('aborted').h, breaker).cancel('budget');
    expect(breaker.isOpen()).toBe(true);
    expect(await start.match).toEqual({ failure: 'budget' });
  });

  it("cancel('budget') charges once whatever the kill surfaced as", async () => {
    for (const outcome of ['aborted', 'timeout_or_exit', 'spawn'] as const) {
      const breaker = new Breaker();
      const start = started(hangingHost(outcome).h, breaker);
      start.cancel('budget');
      expect(await start.match, outcome).toEqual({ failure: 'budget' });
      for (let i = 0; i < BREAKER_FAILS - 2; i++) recordActivityBudgetMiss(breaker);
      expect(breaker.isOpen(), outcome).toBe(false);
      recordActivityBudgetMiss(breaker);
      expect(breaker.isOpen(), outcome).toBe(true);
    }
  });

  it("cancel('abandoned') never charges, even when the kill surfaces as an exit code", async () => {
    for (const outcome of ['aborted', 'timeout_or_exit', 'spawn'] as const) {
      const breaker = new Breaker();
      for (let i = 0; i < BREAKER_FAILS + 1; i++) {
        const start = started(hangingHost(outcome).h, breaker);
        start.cancel('abandoned');
        expect(await start.match, outcome).toEqual({ failure: 'cancelled' });
      }
      expect(breaker.isOpen(), outcome).toBe(false);
    }
  });

  it('a real answer after a cancel wins and clears the budget charge', async () => {
    const breaker = new Breaker();
    for (let i = 0; i < BREAKER_FAILS - 1; i++) recordActivityBudgetMiss(breaker);
    const start = started(hangingHost('ok').h, breaker);
    start.cancel('budget'); // the charge opens the breaker...
    expect(breaker.isOpen()).toBe(true);
    const out = await start.match;
    expect(out.failure).toBeNull(); // ...and ct's real answer closes it again
    expect(breaker.isOpen()).toBe(false);
  });

  it('cancel is idempotent (first reason wins) and a no-op after the match settled', async () => {
    const breaker = new Breaker();
    const start = started(hangingHost('aborted').h, breaker);
    start.cancel('abandoned');
    start.cancel('budget'); // ignored: no charge
    expect(await start.match).toEqual({ failure: 'cancelled' });
    for (let i = 0; i < BREAKER_FAILS - 1; i++) recordActivityBudgetMiss(breaker);
    expect(breaker.isOpen()).toBe(false);

    const b2 = new Breaker();
    const q2 = started(host(), b2);
    expect((await q2.match).failure).toBeNull();
    q2.cancel('budget'); // after settle: no charge
    for (let i = 0; i < BREAKER_FAILS - 1; i++) recordActivityBudgetMiss(b2);
    expect(b2.isOpen()).toBe(false);
  });

  it('a host whose wisdomMatch never settles is still charged at budget expiry', async () => {
    const breaker = new Breaker();
    const never = host({ wisdomMatch: () => new Promise(() => {}) });
    for (let i = 0; i < BREAKER_FAILS; i++) {
      const start = started(never, breaker);
      const match = await settleWithin(start.match, 10, () => start.cancel('budget'));
      expect(match).toBeNull();
    }
    expect(breaker.isOpen()).toBe(true);
  });

  it('startActivity hands wisdomMatch the core signal', async () => {
    let got: AbortSignal | undefined;
    const h = host({
      wisdomMatch: async (_q, _m, _e, signal) => {
        got = signal;
        return { outcome: 'ok', result: { entries: [], corrections: [] } };
      },
    });
    const start = started(h, new Breaker());
    await start.match;
    expect(got).toBeInstanceOf(AbortSignal);
    expect(got?.aborted).toBe(false);
  });
```

Run: `(cd packages/ct-wisdom-core && npx vitest run tests/budget.test.ts)`. Expected: FAIL (`start.cancel` is not a
function, and the type errors are reported by vitest).

- [ ] **Step 2: Implement**

In `src/activity.ts`, replace the whole `export async function runActivityMatch(…) { … }` with:

```ts
/** Why a started activity was cancelled (spec 2026-10-17-core-spawn-binding-and-cancel-design.md). */
export type ActivityCancelReason = 'budget' | 'abandoned';

/** The core's handle on one started match: the signal it passes down, and why it was aborted. */
export interface ActivityCancelControl {
  signal: AbortSignal;
  reason(): ActivityCancelReason | null;
}

export async function runActivityMatch(
  host: HostAdapter,
  activity: Activity,
  exclude: string[],
  breaker: Breaker,
  control?: ActivityCancelControl,
): Promise<ActivityMatch> {
  try {
    if (host.wisdomMatchAbsent()) return { failure: 'capability_missing' };
    const attempt = control
      ? await host.wisdomMatch(activityQuery(activity), ACTIVITY_MAX_PER_STEP, exclude, control.signal)
      : await host.wisdomMatch(activityQuery(activity), ACTIVITY_MAX_PER_STEP, exclude);
    // 1. A real answer wins, even after a cancel: ct did answer (the binding
    //    keeps a result that arrived before the kill). recordSuccess resets
    //    the consecutive-failure count, clearing a budget charge.
    if (attempt.outcome === 'ok' && attempt.result) {
      breaker.recordSuccess();
      return { failure: null, result: attempt.result };
    }
    const reason = control?.reason() ?? null;
    // 2. The budget ran out: already charged ONCE, at cancel time.
    if (reason === 'budget') return { failure: 'budget' };
    // 3. The host abandoned the query: never CT's failure, whatever the kill
    //    surfaced as (aborted, or an exit code).
    if (reason === 'abandoned') return { failure: 'cancelled' };
    // 4. No core cancel: the existing mapping. An abort from the host's own
    //    spawn is not CT's failure and never counts against the breaker.
    if (attempt.outcome === 'aborted') return { failure: 'budget' };
    if (attempt.outcome === 'spawn') {
      host.resetDiscoveryAndProbeCaches();
      return { failure: 'spawn' };
    }
    if (attempt.outcome === 'timeout_or_exit') {
      breaker.recordFailure();
      // The adapter latches a missing subcommand as timeout_or_exit too.
      return { failure: host.wisdomMatchAbsent() ? 'capability_missing' : 'timeout_or_exit' };
    }
    return { failure: 'parse_error' };
  } catch {
    return { failure: 'hook_failed' };
  }
}
```

Change the success member of `ActivityStart` to
`{ failure: null; match: Promise<ActivityMatch>; cancel(reason: ActivityCancelReason): void }`, and replace
`startActivity` with:

```ts
export function startActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  breaker: Breaker,
): ActivityStart {
  try {
    const gate = activityGate(host, session, breaker);
    if (!gate.ok) return { failure: gate.reason };
    const exclude = gate.ledger.idsMostRecentFirst.slice(0, EXCLUDE_MAX);
    const controller = new AbortController();
    let reason: ActivityCancelReason | null = null;
    let settled = false;
    const match = runActivityMatch(host, activity, exclude, breaker, {
      signal: controller.signal,
      reason: () => reason,
    }).finally(() => {
      settled = true;
    });
    /**
     * `budget`: the host's budget ran out. Charges ONE breaker failure now
     * (so the next step's gate sees it even if the child never settles),
     * then kills the query. `abandoned`: the host will not use the answer;
     * kills it, never charges. Idempotent (the first reason wins); a no-op
     * once the match has settled.
     */
    const cancel = (why: ActivityCancelReason): void => {
      if (settled || reason !== null) return;
      reason = why;
      if (why === 'budget') recordActivityBudgetMiss(breaker);
      try {
        controller.abort();
      } catch {
        /* fail quietly */
      }
    };
    return { failure: null, match, cancel };
  } catch {
    return { failure: 'hook_failed' };
  }
}
```

Update the doc comments above `recordActivityBudgetMiss` and `ActivityMatch` (the failure list gains `cancelled`;
`runActivityMatch` no longer "applies it to an aborted match", because `cancel('budget')` does).

- [ ] **Step 3: GREEN.** `(cd packages/ct-wisdom-core && npx tsc --noEmit -p . && npx vitest run)`. Expected: all pass.
  The host packages do not compile yet; Task 5 fixes them.
- [ ] **Step 4: Commit** `feat(core): startActivity returns cancel('budget' | 'abandoned'); the core charges a budget miss at cancel time`.

---

### Task 5: Hosts use `start.cancel`; PR A release

**Files:**
- `integrations/deepseek/src/wisdom-live/activity.ts`:
  - the `Plan.cancel` field becomes `cancel: (reason: ActivityCancelReason) => void`, with its doc updated;
  - `plan()` (around lines 351-363) drops `coreSignal`, `new AbortController()` and `linkCancel`, calls
    `startActivity(this.adapter, session, activity, this.breaker)` and stores `cancel: start.cancel`;
  - `abandon()` (around 283) and the `would_extend_turn` branch (around 436) call `plan.cancel('abandoned')`;
  - the expiry (around 445-448) becomes `settleWithin(plan.promise, …, () => plan.cancel('budget'))`, with the
    `recordActivityBudgetMiss` call and its import removed, and the comment updated.
- `integrations/deepseek/src/wisdom-live/adapter.ts`:
  - delete the `cancels` WeakMap, `linkCancel` and `spawnSignal`, with their doc;
  - in `wisdomMatch`, use the received `budget` signal directly (rename the parameter `signal`);
  - delete the relabel `if (signal?.aborted && res.outcome === 'timeout_or_exit') return { outcome: 'aborted' };` and
    its comment, because the core now classifies by cancel reason. The probe-path abort handling stays.
- `integrations/deepseek/tests/test_wisdom_live_adapter.ts`: delete the `linkCancel` test. Rewrite the "cancel kills
  the grandchild" coverage at the activity level, so that a plan's `cancel('abandoned')` kills a real hanging child
  (the `hangingCt` helper with the real core `nodeSpawnFn`), and keep it POSIX-only.
- `integrations/opencode/src/wisdom-live/activity.ts` (around 314-331) and `integrations/openclaw/src/wisdom/activity.ts`
  (around 247-257): drop `const abort = new AbortController()`, call `startActivity(…)` without it, use
  `settleWithin(start.match, …, () => start.cancel('budget'))`, and update the comments.
- Release: deepseek `0.6.4`, opencode `0.4.4`, openclaw `0.3.3` (package.json, integration.yaml, openclaw
  `PLUGIN_VERSION`, README rows, any test asserting the version) and CHANGELOGs.

**Interfaces:**
- Consumes: `startActivity(host, session, activity, breaker)` returning `cancel`, and `type ActivityCancelReason` (Task 4).

- [ ] **Step 1: Rebuild the core and refresh each host's copy** (the same commands as Task 2 Step 1).
- [ ] **Step 2: Write the hang tests (RED).** In both the OpenCode and the OpenClaw activity test files, add a test
  next to the existing activity-delivery tests. Inject a `spawnFn` (or the host's wisdomMatch seam, whichever the
  file's harness already uses) that returns a promise that never settles. Run the same new activity three times on
  three steps, so each step expires its budget. Assert that the breaker counts one failure per step and is **open
  after three**. Today that breaker stays closed, so the test fails. Use the harness's own breaker accessor or the
  verbose `breaker_open` skip on a fourth step, whichever the file already uses.
  Run each host's test file and confirm it FAILS.
- [ ] **Step 3: Migrate the hosts** as listed under Files.
- [ ] **Step 4: GREEN.** For each host: `pnpm run build && pnpm test`, plus the lint check from its `integration.yaml`.
  Expected: everything passes, including the two new hang tests. `grep -rn "linkCancel\|AbortController" integrations/{deepseek,opencode,openclaw}/src`
  must show no activity-path AbortController left. Anything that remains must be outside the activity flow; list it
  in the report.
- [ ] **Step 5: Release files** for 0.6.4, 0.4.4 and 0.3.3, as in Task 2 Step 4, with these CHANGELOG entries:
  - opencode and openclaw: "**Fix: a `ct` that hangs past the activity budget now counts against the breaker.** The miss is charged when the budget runs out, not when the query settles (which a hung child never did), so three misses pause CT as on DSH and Hermes."
  - deepseek: "Internal: activity cancel goes through the shared core's `cancel` (the adapter's side channel is gone). No behavior change."
- [ ] **Step 6: Full verification and commit** (the same commands as Task 2 Step 5).
  `release: deepseek 0.6.4, opencode 0.4.4, openclaw 0.3.3 (core-owned activity cancel)`.

---

### Task 6: PR A — e2e, PR, review (controller)

The same as Task 3, with tags `deepseek-v0.6.4`, `opencode-v0.4.4` and `openclaw-v0.3.3`.

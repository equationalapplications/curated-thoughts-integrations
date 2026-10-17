# DSH autonomous-work wisdom delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One CT fact (≤ 600 chars) per model step, keyed to the agent's previous tool calls, delivered
as a persisted user-role message at DSH `agent/pre-step` step ≥ 2, with the host-neutral pieces in
`ct-wisdom-core`.

**Architecture:** `ct-wisdom-core/src/activity.ts` ports Hermes's line builder, key tracker, block
renderer and match runner. `integrations/deepseek/src/wisdom-live/activity.ts` maps DSH tool calls to
activity specs, plans one query per step (prefetched at `tools/pre-execute`, keyed by the assistant
message id) and delivers at the next pre-step against a ledger rebuilt from `deriveMessages()`.
`index.ts` wires both listeners.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.19), vitest 4, pnpm, bash e2e in Docker.

**Spec:** `docs/superpowers/specs/2026-10-16-dsh-autonomous-work-wisdom-design.md`

## Global Constraints

- `ACTIVITY_MAX_PER_STEP = 1`, `ACTIVITY_MAX_BLOCK_CHARS = 600`, `ACTIVITY_QUERY_CHARS = 300`,
  `ACTIVITY_TARGET_CHARS = 200`, `ACTIVITY_LABEL_CHARS = 120`, `ACTIVITY_RECENT_KEYS_MAX = 32`,
  `ACTIVITY_STEP_IDS_MAX = 16`, `ACTIVITY_SESSIONS_MAX = 256`.
- `ACTIVITY_HEADING = "## Curated Thoughts — relevant to this step"`.
- Activity message: `{id: randomUUID(), role: 'user', source: {kind: 'curated-thoughts-wisdom-activity'}, content: [{type: 'text', text}]}`.
- Query = bare target; never verb, contents, output, flag values, quoted words, assignments, URLs,
  credential-shaped tokens.
- Verbose records use `channel: 'activity'`; off ⇒ byte-identical behavior.
- Core changes are additive (new exports, two optional `VerboseTurn` fields).
- Local vitest: `--testTimeout 60000`, suites run sequentially.

---

### Task 1: Core activity builder (+ secret safety)

**Files:**
- Create: `packages/ct-wisdom-core/src/activity.ts`
- Modify: `packages/ct-wisdom-core/src/index.ts` (export), `src/constants.ts` (activity constants)
- Test: `packages/ct-wisdom-core/tests/activity.test.ts`

**Interfaces — Produces:**
```ts
export type ActivitySpec =
  | { verb: 'read' | 'write' | 'edit'; path: unknown }
  | { verb: 'search'; pattern: unknown; path?: unknown }
  | { verb: 'run'; command: unknown };
export interface Activity { verb: 'read'|'write'|'edit'|'search'|'run'; target: string; key: string; line: string; query: string }
export function isCtTool(name: unknown): boolean;
export function credentialShaped(token: string): boolean;
export function shellWords(command: string): string[];
export function normalizePath(raw: unknown, cwd?: string | null): string | null;
export function commandTarget(command: unknown): string | null;
export function buildActivity(spec: ActivitySpec, cwd?: string | null): Activity | null;
export function activityQuery(activity: Activity): string;
```

- [ ] Step 1: port Hermes `CASES` (29), `test_no_line`, `test_paths`, `test_ct_tools`,
  `test_secret_args_never_in_line_or_query`, `test_randomized_commands_secret_safety` (500 iterations,
  same pools and assertions, seeded mulberry32), credential search patterns, own-text guard, caps.
- [ ] Step 2: run `pnpm exec vitest run tests/activity.test.ts` → FAIL (module missing).
- [ ] Step 3: implement the builder exactly per spec "Activity builder".
- [ ] Step 4: run → PASS.
- [ ] Step 5: commit `feat(core): activity line builder ported from Hermes`.

### Task 2: Core tracker, render, match runner, verbose fields

**Files:** same module; `src/verbose.ts`; tests in `activity.test.ts` and `verbose.test.ts`.

**Interfaces — Produces:**
```ts
export class ActivityTracker {
  admit(sessionId: string, stepId: string, key: string): null | 'step_used' | 'seen_key';
  peek(sessionId: string, stepId: string, key: string): null | 'step_used' | 'seen_key';
  firstReport(sessionId: string, stepId: string): boolean;
  reset(): void;
}
export interface ActivityCandidate { item: FactEntry | Correction; superseded: string[] }
export function activityCandidates(result: WisdomMatchResult, ledger: Ledger): ActivityCandidate[];
export function renderActivityBlock(item, superseded: string[], activity: Activity): string;
export function selectActivityDelivery(result, ledger, activity): { block: string; id: string } | null;
export interface ActivityMatch { failure: string | null; result?: WisdomMatchResult }
export function runActivityMatch(host: HostAdapter, activity: Activity, exclude: string[], breaker: Breaker): Promise<ActivityMatch>;
// VerboseTurn gains: channel?: string; activity?: string; VerboseRecord gains activity?: string
```

- [ ] Step 1: tests: tracker (one start per step, fold, LRU, sessions, run vs search), block shape
  (≤ 600, ends with `…` when cut, marker < title < text, provenance, one marker), one fact even if
  CT returns more, corrections only when superseding the ledger, ids in ledger skipped, invalid ids
  skipped, runActivityMatch classes (capability_missing, spawn resets caches, timeout feeds the
  breaker, ok resets it, parse_error), verbose channel override and `activity` field order.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS. Step 5: commit.

### Task 3: DSH activity planner and delivery

**Files:**
- Create: `integrations/deepseek/src/wisdom-live/activity.ts`
- Test: `integrations/deepseek/tests/test_wisdom_activity.ts`

**Interfaces — Produces:**
```ts
export const ACTIVITY_SOURCE_KIND = 'curated-thoughts-wisdom-activity';
export function dshActivitySpec(name: unknown, args: unknown): ActivitySpec | null;
export function lastAssistantStep(messages: readonly unknown[]): { messageId: string; calls: Array<{ id: string; name: string; args: unknown }> } | null;
export class DshActivity {
  constructor(deps: { adapter: DshWisdomAdapter; breaker: Breaker; cwd?: () => string | null; now?: () => number;
                      recordVerbose?: (t: VerboseTurn) => void; noteMemo?: (agentId: string) => void });
  prefetch(exec: { callId?: unknown; name?: unknown; parent?: unknown; agent?: AgentHandle }): void;   // never throws
  deliver(agent: AgentHandle, claimed: readonly unknown[], decisionMessages: readonly unknown[]): Promise<string | null>;
}
export function activityMessage(block: string): Readonly<{ id: string; role: 'user'; source: { kind: string }; content: Array<{ type: 'text'; text: string }> }>;
```

- [ ] Step 1: tests: tool map rows from the spec table; a step with two new-key calls makes one CT
  call; same key next step → no call; prefetch + deliver share one call; budget; failure classes;
  `would_extend_turn`; CT tools never trigger; no deriveMessages → no_ledger; N3 cache learns the id;
  delivered message shape.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: commit.

### Task 4: Wire into `index.ts`

**Files:** `integrations/deepseek/src/index.ts`; tests `test_index.ts` (stub host).

- [ ] Step 1: tests through `apply()` with a stub ctx: `tools/pre-execute` registered and passes the
  decision through; pre-step step 1 → user-turn only; step 2 after a `bash pnpm test` call → one
  activity message with the source kind; pre-step on a reject decision → untouched.
- [ ] Step 2: FAIL. Step 3: implement (`DshActivity` built next to the adapter and breaker; pre-step
  runs `deliver` only when the user-turn branch did not run and `step ≥ 2`; register
  `tools/pre-execute`). Step 4: PASS. Step 5: commit.

### Task 5: Exactly-once randomized, marker hygiene, verbose byte identity

**Files:** `integrations/deepseek/tests/test_wisdom_live_exactly_once.test.ts` (new `describe`),
`tests/test_wisdom_activity.ts`.

- [ ] 200 randomized sessions: turns with 1–4 steps, random tool calls (bash/read/write/edit/grep and
  CT recalls), user-turn deliveries, activity deliveries, compaction, and resume into a NEW adapter +
  DshActivity (memory dropped, log kept); assert no fact visible twice after every step.
- [ ] Marker hygiene and verbose on/off byte identity tests. Commit.

### Task 6: Live e2e (real gate)

**Files:** `integrations/deepseek/tests/e2e/e2e.sh`, `run.sh` (forward `CT_WISDOM_VERBOSE`).

- [ ] Add the "autonomous-work delivery" section inside the real-gate branch: deposit `pnpm test` and
  `.env.local` facts, a workspace with `TASK.md` (bash `pnpm test`, bash `pnpm test --silent`, write
  `.env.local`, read `.env.local`, CT recall `pnpm test`), one `dsh --json` run with
  `CT_WISDOM_VERBOSE=1`, then checks 1–5 + verbose, plus `--session-id` resume.
- [ ] Make the existing real-gate tap counts filter on `--max 2` (user-turn calls only).
- [ ] `docker ps` first; run `CT_E2E_REAL_GATE=1 integrations/deepseek/tests/e2e/run.sh`; grep `out/`
  for both keys.

### Task 7: Release hygiene and verification

- [ ] deepseek 0.6.0 (`package.json`, `integration.yaml`), CHANGELOG, README; `python3 tools/ct_ci.py readme`.
- [ ] Sequential suites: core, deepseek, opencode, openclaw (`--testTimeout 60000`), `tsc --noEmit` each.
- [ ] `ct_ci.py validate`, `policy --base origin/main`, `generate --check`, `readme --check`.
- [ ] Commit, push, open the PR, wait for CI and CodeRabbit, address findings.

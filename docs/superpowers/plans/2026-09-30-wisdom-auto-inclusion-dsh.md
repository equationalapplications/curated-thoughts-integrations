# DSH Wisdom-Layer Auto-Inclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Review convention:** Opus review findings are numbered by cycle (B# blocker, M# major, m# minor). A reference like "m8 from cycle 1" points into that register; unqualified mentions refer to the current cycle's batch.

**Goal:** Port the Hermes wisdom auto-inclusion (PR #21) to the DeepSeek Harness integration: a `curated-thoughts-wisdom` system-prompt section that injects semantically relevant wiki entries once per agent, cache-safe, fail-open with a retry budget and circuit breaker.

**Architecture:** One new module `integrations/deepseek/src/wisdom.ts` (discovery + identity probe, recall wrapper, sanitize/render, session memo, retry budget + circuit breaker, orchestrator) registered from `src/index.ts` via `ctx.systemPrompt.section()`. Read-only brain access through the `ct` CLI (`spawnSync`, argv array, never a shell). Node stdlib only.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, Node stdlib (`node:child_process` `spawnSync`, `node:os`, `node:path`, `node:fs`).

**Spec:** `docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-dsh-design.md` (converged APPROVE WITH NITS, cycle 4)
**Reference port (proven in production):** `integrations/hermes/scripts/ct_wisdom.py` — failure classes, sanitize order, render algorithm, and candidate lists port VERBATIM from it unless a DSH delta below says otherwise.

## Global Constraints (verbatim from the spec — every task inherits these)

- Node stdlib only; **no new runtime dependencies** (`node:child_process` only).
- Registration: `ctx.systemPrompt.section({ name: 'curated-thoughts-wisdom', order: 6000, interpolate: false, text: renderWisdom })` — `interpolate: false` is passed for forward compat (pinned 0.1.5-rc.2 has no such option and ignores unknown properties).
- Identity probe: `<ct> --help` combined stdout+stderr must contain `Curated Thoughts`; probe timeout 3 s; same spawnSync contract as recall incl. `killSignal: 'SIGKILL'` (SIGTERM lets a hung child outlive the timeout).
- Recall argv: `[ctPath, 'recall', SEED_QUERY, '--json', '--k', '3']` via `spawnSync` with `{ timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true }`.
- `SEED_QUERY = 'curated thoughts agent memory wisdom procedures'` — seed constant ONLY (no cwd term; `process.cwd()` is the harness cwd, the trap the Hermes design forbids).
- `MAX_BLOCK_CHARS = 2500` enforced on the final STRIPPED length (DSH has no host-side cap — entirely ours); per-entry truncation keeps the title line; zero usable entries → `''`.
- Sanitizer order: (1) remove every `<!-- hermes-plugin-section` substring REPEATEDLY until stable, (2) THEN indent any line-start `## Plugin Context: ` with 4 spaces, (3) neutralize brace-runs with the lookahead form `/\{(?=\{)/g → '{ '` (single pass collapses any run; a plain `replaceAll('{{', '{ {')` is bypassable via `{{{x}}` and is FORBIDDEN). Applied to titles AND text. Unit invariant: rendered block never contains `{{`.
- `keyOf(ctx)` is the ONE key function: `typeof agent?.id === 'string' && agent.id` → use it; else `typeof scope?.id === 'string' && scope.id` → use it; else no key. No key → return `''` with NO memo write and NO spawn (and no budget/breaker interaction — a keyless render is a pure no-op).
- Memo: module-global `Map` LRU N=256 (delete/re-insert for LRU order). No lock — Node is single-threaded and `text()` is synchronous (deliberate divergence from Hermes's lock dance).
- Failure classes — **memoized:** discovery miss, parse error, `maxBuffer` overflow (ENOBUFS, treated like a parse error), zero hits. **Budgeted (NOT memoized, retried):** recall timeout, non-zero exit, spawn failure, probe timeout.
- Retry budget: at most **2 attempts per agent id**, **≥60 s cooldown** between attempts, then memoize `''` for that agent (the budget-SPENT outcome IS memoized — spec L134 + carry-over C; the individual failures are not). Circuit breaker: after **4 consecutive** budgeted failures process-wide, stop spawning for **5 minutes**, then allow one half-open probe attempt; a failed half-open probe re-opens the breaker. Both are per-process module state; the governor's per-agent map is LRU-capped at 256 like the memo (unbounded failed-agent growth otherwise).
- Discovery misses are cached process-wide with a **5-minute TTL**; probe timeouts are NOT cached. Accepted-path cache reset on spawn failure is kept, and the reset's cost is bounded by the per-agent budget (the next attempt's re-walk is that attempt's spend).
- Discovery walk: ONE cumulative 3 s deadline over the whole walk (elapsed time counts against every subsequent probe's timeout; deadline exhaustion ends the walk as budgeted `probe_timeout`). A candidate that exists but FAILS the probe advances the walk; a probe that TIMES OUT ends the walk immediately as `probe_timeout`.
- Windows: skip `.cmd`/`.bat` candidates entirely and skip extensionless files (spawnSync with `shell:false` fails EINVAL on patched Node for `.cmd`/`.bat` — CVE-2024-27980). Discovery must NOT use a single-result `which` + post-filter (a `.cmd` shim earlier on PATH would shadow a valid `ct.exe`); it walks ALL PATH matches in order.
- Platform fallback candidates (verbatim from Hermes `_candidate_paths`): darwin `[$HOME/bin/ct, /usr/local/bin/ct, /opt/homebrew/bin/ct]`; win32 `[%USERPROFILE%\bin\ct.exe, %LOCALAPPDATA%\CuratedThoughts\bin\ct.exe]`; linux `[$HOME/.local/bin/ct, /usr/bin/ct, /usr/local/bin/ct, $HOME/bin/ct]`. POSIX gate = `accessSync(X_OK)`; win32 gate = exists only.
- `renderWisdom` NEVER throws (defensive catch around the whole body); every failure collapses to `''`. Logging: debug one-liners prefixed `wisdom:`, never thrown, never at info/error.
- Zero wiki entries → `''` (host drops empty sections).
- Checks: `cd integrations/deepseek && pnpm build && pnpm test` (vitest; CI also runs `tsc --noEmit`). POSIX-only fixture-script tests are `describe.skipIf(process.platform === 'win32')` per repo precedent; mocked-`spawnSync` tests are the PRIMARY pattern (no real binary needed on any platform).
- e2e in the isolated container ONLY (`integrations/deepseek/tests/e2e/run.sh`); never against a live harness or Kurt's config.
- Version → **0.3.0**, CHANGELOG entry, README paragraph with EXACTLY five limitations (listed in Task 7).

---

### Task 1: Module core — constants, `keyOf`, `sanitize`, `renderBlock`

**Files:**
- Create: `integrations/deepseek/src/wisdom.ts`
- Test: `integrations/deepseek/tests/test_wisdom.ts`

**Interfaces (produces; later tasks rely on these exact names):**
- `export const SEED_QUERY: string`, `PROBE_TIMEOUT_MS = 3000`, `RECALL_TIMEOUT_MS = 5000`, `RECALL_K = 3`, `MAX_BLOCK_CHARS = 2500`, `MEMO_MAX = 256`, `BLOCK_HEADING = '## Curated Thoughts \u2014 relevant memory'`
- `export type WikiEntry = { title: string; text: string }`
- `export function keyOf(ctx: unknown): string`
- `export function sanitize(value: unknown): string`
- `export function renderBlock(entries: WikiEntry[]): string`

- [ ] **Step 1.1 (RED):** create `tests/test_wisdom.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { keyOf, sanitize, renderBlock, MAX_BLOCK_CHARS, BLOCK_HEADING } from '../src/wisdom.js';

describe('keyOf', () => {
  it('prefers a non-empty string agent.id', () => {
    expect(keyOf({ agent: { id: 's1' }, scope: { id: 'other' }, signal: {} })).toBe('s1');
  });
  it('falls back to scope.id when agent.id is missing/blank/non-string', () => {
    expect(keyOf({ scope: { id: 'sc' } })).toBe('sc');
    expect(keyOf({ agent: { id: '' }, scope: { id: 'sc' } })).toBe('sc');
    expect(keyOf({ agent: { id: 42 }, scope: { id: 'sc' } })).toBe('sc');
  });
  it('returns "" when neither yields a non-empty string (no-throw on garbage)', () => {
    expect(keyOf(undefined)).toBe('');
    expect(keyOf(null)).toBe('');
    expect(keyOf({})).toBe('');
    expect(keyOf({ agent: 7, scope: 'str-not-object' })).toBe('');
  });
});

describe('sanitize', () => {
  it('removes the marker REPEATEDLY until stable (a pass can splice a fresh marker)', () => {
    // pass 1 removes the inner marker at offset 18, splicing '<!-- hermes-plugin' + '-section'
    // into a NEW marker; pass 2 removes it. A single replaceAll leaves the forged frame.
    expect(sanitize('<!-- hermes-plugin<!-- hermes-plugin-section-section')).toBe('');
    expect(sanitize('x<!-- hermes-plugin-section<!-- hermes-plugin-section-sectiony')).toBe('xy');
  });
  it('indents a line-start heading only AFTER marker removal (order)', () => {
    expect(sanitize('## Plugin Context: x')).toBe('    ## Plugin Context: x');
    // removal first, THEN indent: the exposed heading must still be indented
    expect(sanitize('<!-- hermes-plugin<!-- hermes-plugin-section-section\n## Plugin Context: x')).toBe(
      '\n    ## Plugin Context: x'
    );
  });
  it('neutralizes brace-runs with the lookahead form in one pass', () => {
    expect(sanitize('{{a}}')).toBe('{ {a}}');
    expect(sanitize('{{{x}}')).toBe('{ { {x}}');
    expect(sanitize('{{{{')).toBe('{ { { {');
    expect(sanitize('plain { single } braces')).toBe('plain { single } braces');
  });
  it('coerces non-string input defensively', () => {
    expect(sanitize(undefined)).toBe('');
    expect(sanitize(null)).toBe('');
    expect(sanitize(42)).toBe('42');
  });
});

describe('renderBlock', () => {
  it('empty input -> ""', () => {
    expect(renderBlock([])).toBe('');
  });
  it('heading + per-entry **title**\\ntext, blank-line joined, sanitized', () => {
    const out = renderBlock([
      { title: 'T1', text: 'body <!-- hermes-plugin-section-sections:start --> rest' },
      { title: 'T2', text: '{{inject}}' },
    ]);
    expect(out.startsWith(BLOCK_HEADING + '\n\n')).toBe(true);
    expect(out).toContain('**T1**\nbody -sections:start --> rest');
    expect(out).toContain('**T2**\n{ {inject}}');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('<!-- hermes-plugin-section');
  });
  it('skips entries with no usable content', () => {
    const out = renderBlock([{ title: '', text: '   ' }, { title: 'real', text: 'x' }]);
    expect(out).not.toContain('****');
    expect(out).toContain('**real**');
  });
  it('hard-caps the final STRIPPED length at 2500, keeping every kept entry title', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      title: `T${i}`,
      text: 'x'.repeat(400),
    }));
    const out = renderBlock(entries);
    expect(out.trim().length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    expect(out).toContain('**T0**');
    expect(out).toContain('\u2026'); // truncated entry keeps title, cut text gets an ellipsis
    for (const m of out.matchAll(/\*\*T(\d+)\*\*/g)) {
      expect(renderBlock([entries[Number(m[1])]]).trim().length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    }
  });
  it('drops entries that cannot even fit their title line; keeps the rest', () => {
    // used = heading(38) + 2 = 40; entry1 title(50) exceeds the remaining 2460 → dropped;
    // entry2 title(4) + text fits → INCLUDED (loop continues past a dropped entry)
    const entries = [
      { title: 'T'.repeat(50), text: 'x' },
      { title: 'T2', text: 'small' },
    ];
    const out = renderBlock(entries);
    expect(out).not.toContain('*****');
    expect(out).not.toContain(`${'T'.repeat(50)}`);
    expect(out).toContain('**T2**');
  });
  it('is byte-stable for identical entries', () => {
    const e = [{ title: 'A', text: 'b' }];
    expect(renderBlock(e)).toBe(renderBlock(e.map((x) => ({ ...x }))));
  });
});
```

- [ ] **Step 1.2:** run `cd integrations/deepseek && pnpm vitest run tests/test_wisdom.ts` — Expected: FAIL (module `../src/wisdom.js` not found).
- [ ] **Step 1.3 (GREEN):** create `src/wisdom.ts` with the constants (exact values in Global Constraints) and:

```ts
// Port of integrations/hermes/scripts/ct_wisdom.py (proven); DSH deltas per
// docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-dsh-design.md.
import { homedir } from 'node:os';

export const SEED_QUERY = 'curated thoughts agent memory wisdom procedures';
export const PROBE_TIMEOUT_MS = 3000;
export const RECALL_TIMEOUT_MS = 5000;
export const RECALL_K = 3;
export const MAX_BLOCK_CHARS = 2500;
export const MEMO_MAX = 256;
export const BLOCK_HEADING = '## Curated Thoughts \u2014 relevant memory';

const FORBIDDEN_MARKER = '<!-- hermes-plugin-section';
const FORBIDDEN_HEADING = '## Plugin Context: ';
const HEADING_INDENT = '    ' + FORBIDDEN_HEADING;
const ELLIPSIS = '\u2026';

export type WikiEntry = { title: string; text: string };

export function keyOf(ctx: unknown): string {
  const c = (ctx ?? {}) as { agent?: unknown; scope?: unknown };
  const pick = (o: unknown): string =>
    typeof o === 'object' && o !== null && typeof (o as { id?: unknown }).id === 'string'
      ? (o as { id: string }).id
      : '';
  return pick(c.agent) || pick(c.scope) || '';
}

export function sanitize(value: unknown): string {
  let v = typeof value === 'string' ? value : value == null ? '' : String(value);
  while (v.includes(FORBIDDEN_MARKER)) v = v.split(FORBIDDEN_MARKER).join('');
  v = v
    .split('\n')
    .map((line) => (line.startsWith(FORBIDDEN_HEADING) ? HEADING_INDENT + line.slice(FORBIDDEN_HEADING.length) : line))
    .join('\n');
  return v.replace(/\{(?=\{)/g, '{ ');
}

export function renderBlock(entries: WikiEntry[]): string {
  if (!entries.length) return '';
  const heading = sanitize(BLOCK_HEADING);
  const parts: string[] = [];
  let used = heading.length + 2;
  for (const { title, text } of entries) {
    const cleanTitle = sanitize(title).trim();
    const cleanText = sanitize(text);
    if (!cleanTitle && !cleanText.trim()) continue;
    const titleLine = `**${cleanTitle}**`;
    let body = titleLine + '\n' + cleanText;
    const sep = parts.length ? 2 : 0;
    const remaining = MAX_BLOCK_CHARS - used - sep;
    if (remaining <= titleLine.length + 1) continue; // title alone cannot fit: skip
    if (body.length <= remaining) {
      parts.push(body);
      used += sep + body.length;
      continue;
    }
    const textBudget = remaining - titleLine.length - 1 - ELLIPSIS.length;
    if (textBudget > 0) {
      body = titleLine + '\n' + cleanText.slice(0, textBudget) + ELLIPSIS;
      parts.push(body);
      used += sep + body.length;
    }
    break; // budget exhausted after a truncated entry
  }
  if (!parts.length) return '';
  return heading + '\n\n' + parts.join('\n\n');
}
```

(`homedir` is genuinely used in Task 2's `candidatePaths`, not here — do not import it in Task 1.)

- [ ] **Step 1.4:** run `pnpm vitest run tests/test_wisdom.ts` — Expected: PASS (all).
- [ ] **Step 1.5:** `pnpm build && pnpm test` green; commit: `feat(dsh): wisdom module core — keyOf, sanitize (brace-run lookahead), renderBlock (TDD)`

---

### Task 2: Discovery — `allPathMatches`, candidate lists, identity probe, bounded walk

**Files:**
- Modify: `integrations/deepseek/scripts/ct_env.ts` (add one export beside `whichOnPath`)
- Modify: `integrations/deepseek/src/wisdom.ts`
- Test: `integrations/deepseek/tests/test_wisdom.ts` (extend), `integrations/deepseek/tests/test_ct_env.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces (ct_env.ts): `export function allPathMatches(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[]` — every existing executable PATH hit in PATH order (win32: bare name + PATHEXT-appended forms per dir; POSIX: bare name per dir).
- Produces (wisdom.ts): `export type ProbeVerdict = 'ok' | 'timeout' | 'reject'`; `export type DiscoveryFailure = 'probe_timeout' | null`; `export function candidatePaths(env: NodeJS.ProcessEnv, platform: string, pathMatches?: string[]): string[]`; `export function probeIdentity(ctPath: string, opts?: { timeoutMs?: number; spawnSync?: SpawnLike }): ProbeVerdict`; `export function discoverCt(env?: NodeJS.ProcessEnv, opts?: { platform?: string; candidates?: string[]; usable?: (p: string) => boolean; probe?: (path: string, budgetMs: number) => ProbeVerdict; now?: () => number }): { path: string | null; failure: DiscoveryFailure }`; `export function resetDiscoveryCachesForTests(): void` (clears accepted-path cache AND the miss cache). **`usable` injection exists so mocked tests skip the real filesystem gate** (Hermes patches `_usable_candidate`/`_candidate_paths` the same way); the real default is `usable = (p) => isWin ? existsSync(p) : accessSync(p, X_OK) succeeds` (POSIX `accessSync` also rejects directories; Hermes gates with `isfile` on win32 — use `statSync(p).isFile()` there).

- [ ] **Step 2.1 (RED, ct_env.ts):** add to `tests/test_ct_env.ts`: `allPathMatches` returns ALL hits in PATH order (fixture tmpdir with two dirs each containing an executable `ct`, PATH `dirA:dirB` → `[dirA/ct, dirB/ct]`); win32 form (fake platform `'win32'`, PATHEXT `.exe;.cmd`): bare + appended forms per dir, missing forms skipped, order preserved; empty PATH → `[]`; nonexistent dirs skipped.
- [ ] **Step 2.2 (GREEN, ct_env.ts):** implement `allPathMatches` by refactoring the split/exts logic out of `whichOnPath` (whichOnPath becomes `allPathMatches(...)[0] ?? null` — behavior unchanged; existing tests must stay green).
- [ ] **Step 2.3 (RED, discovery logic — mocked, cross-platform):** in `test_wisdom.ts`, drive `discoverCt` with injected `usable: () => true` (the mocked tests bypass the real fs gate — without this, nonexistent fixture candidates are skipped BEFORE the probe runs) plus `candidates` + `probe` + `now` (NO real fs/spawn). Add `beforeEach(resetDiscoveryCachesForTests)` — module state (accepted path, miss cache) leaks between tests otherwise:

```ts
const okProbe = (p: string) => (p.endsWith('real') ? 'ok' : 'reject');
const allUsable = () => true;
// candidate that exists but FAILS advances; ordering preserved
it('advances past a rejecting candidate and accepts the first passing one', () => {
  const calls: string[] = [];
  const r = discoverCt(PROCESS_ENV, {
    candidates: ['/x/impostor', '/y/real'],
    usable: allUsable,
    probe: (p) => { calls.push(p); return okProbe(p); },
  });
  expect(r).toEqual({ path: '/y/real', failure: null });
  expect(calls).toEqual(['/x/impostor', '/y/real']);
});
// a timing-out probe ends the walk immediately as probe_timeout
it('ends the walk on a probe timeout (later candidates not probed)', () => {
  const calls: string[] = [];
  const r = discoverCt(PROCESS_ENV, {
    candidates: ['/a/slow', '/b/real'],
    usable: allUsable,
    probe: (p) => { calls.push(p); return 'timeout'; },
  });
  expect(r).toEqual({ path: null, failure: 'probe_timeout' });
  expect(calls).toEqual(['/a/slow']);
});
// cumulative 3 s deadline: elapsed counts against later probes; exhaustion ends the walk
it('exhausting the walk deadline ends it as probe_timeout', () => {
  let t = 0;
  const calls: string[] = [];
  const r = discoverCt(PROCESS_ENV, {
    candidates: ['/a', '/b', '/c'],
    usable: allUsable,
    probe: (p) => { calls.push(p); t += 2800; return 'reject'; },
    now: () => t,
  });
  expect(r.failure).toBe('probe_timeout');
  // /c must never be probed: /a + /b spent the whole 3 s deadline
  expect(calls).toEqual(['/a', '/b']);
});
// deterministic miss is cached 5 min; probe_timeout is NOT cached
it('caches a discovery miss with a 5-min TTL, never a probe_timeout', () => {
  let t = 0;
  const probe = () => 'reject';
  expect(discoverCt(PROCESS_ENV, { candidates: ['/a'], probe, now: () => t }).path).toBeNull();
  expect(discoverCt(PROCESS_ENV, { candidates: ['/a'], probe: () => { throw new Error('must not re-probe'); }, now: () => t }).path).toBeNull();
  t += 5 * 60_000 + 1;
  const calls: string[] = [];
  expect(discoverCt(PROCESS_ENV, { candidates: ['/a'], probe: (p) => { calls.push(p); return 'reject'; }, now: () => t }).path).toBeNull();
  expect(calls).toEqual(['/a']); // TTL expired: walked again
});
it('caches the accepted path process-wide (no re-probe)', () => {
  resetDiscoveryCachesForTests();
  const calls: string[] = [];
  const probe = (p: string) => { calls.push(p); return 'ok'; };
  discoverCt(PROCESS_ENV, { candidates: ['/y/real'], probe });
  const before = calls.length;
  expect(discoverCt(PROCESS_ENV, { candidates: ['/y/real'], probe }).path).toBe('/y/real');
  expect(calls.length).toBe(before);
});
```

Also: win32 candidate filtering (pure logic, no fs): `candidatePaths` with `platform: 'win32'` and a fabricated PATH-match list drops `ct.cmd`, `ct.bat`, and extensionless `ct`, keeps `ct.exe`; POSIX platform keeps everything.
- [ ] **Step 2.4 (GREEN):** implement in `wisdom.ts`:

```ts
import { accessSync, constants as fsConstants, statSync } from 'node:fs';

const MISS_TTL_MS = 5 * 60_000;
let acceptedCtPath: string | null = null;
let missCache: { until: number } | null = null;

export type ProbeVerdict = 'ok' | 'timeout' | 'reject';
export type DiscoveryFailure = 'probe_timeout' | null;

export function candidatePaths(env: NodeJS.ProcessEnv, platform: string, pathMatches?: string[]): string[] {
  const isWin = platform.startsWith('win');
  // the optional third parameter injects a fabricated PATH-match list in tests
  const matches = pathMatches ?? allPathMatches('ct', env, platform as NodeJS.Platform);
  // win32 (spec): skip .cmd/.bat entirely (spawnSync shell:false fails EINVAL —
  // CVE-2024-27980) and extensionless files; any OTHER dotted extension survives.
  const filtered = isWin
    ? matches.filter((p) => {
        const base = p.split(/[\\/]/).pop() ?? '';
        const dot = base.lastIndexOf('.');
        return dot > 0 && !['.cmd', '.bat'].includes(base.slice(dot).toLowerCase());
      })
    : matches;
  const home = homedir();
  if (isWin) {
    // rows built conditionally — a row exists only when its env var is non-empty
    // (Hermes `if profile:` / `if local:` guards; never a length heuristic)
    const out = [...filtered];
    if (env.USERPROFILE) out.push(`${env.USERPROFILE.replace(/[\\/]+$/, '')}\\bin\\ct.exe`);
    if (env.LOCALAPPDATA) out.push(`${env.LOCALAPPDATA.replace(/[\\/]+$/, '')}\\CuratedThoughts\\bin\\ct.exe`);
    return out;
  }
  const fallbacks = platform === 'darwin'
    ? [`${home}/bin/ct`, '/usr/local/bin/ct', '/opt/homebrew/bin/ct']
    : [`${home}/.local/bin/ct`, '/usr/bin/ct', '/usr/local/bin/ct', `${home}/bin/ct`];
  return [...filtered, ...fallbacks];
}
```

function defaultUsable(p: string, isWin: boolean): boolean {
  if (isWin) {
    try { return statSync(p).isFile(); } catch { return false; } // isfile: a directory named ct.exe is not a candidate
  }
  try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; }
}

export function discoverCt(
  env: NodeJS.ProcessEnv = process.env,
  opts: { platform?: string; candidates?: string[]; usable?: (p: string) => boolean; probe?: (path: string, budgetMs: number) => ProbeVerdict; now?: () => number } = {},
): { path: string | null; failure: DiscoveryFailure } {
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? osPlatform();
  const isWin = platform.startsWith('win');
  const usable = opts.usable ?? ((p: string) => defaultUsable(p, isWin));
  const probe = opts.probe ?? ((p, budgetMs) => probeIdentity(p, { timeoutMs: budgetMs }));
  if (acceptedCtPath) return { path: acceptedCtPath, failure: null };
  const t = now();
  if (missCache && t < missCache.until) return { path: null, failure: null };
  missCache = null;
  const walkStart = t;
  for (const cand of opts.candidates ?? candidatePaths(env, platform)) {
    if (!usable(cand, isWin)) continue;
    const budgetMs = PROBE_TIMEOUT_MS - (now() - walkStart);
    if (budgetMs <= 0) return { path: null, failure: 'probe_timeout' };
    const verdict = probe(cand, budgetMs);
    if (verdict === 'ok') { acceptedCtPath = cand; return { path: cand, failure: null }; }
    if (verdict === 'timeout') return { path: null, failure: 'probe_timeout' };
  }
  missCache = { until: now() + MISS_TTL_MS };
  return { path: null, failure: null };
}

export function resetDiscoveryCachesForTests(): void {
  acceptedCtPath = null;
  missCache = null;
}
```

(`allPathMatches` is imported from `../scripts/ct_env.js` — the import direction is proven, not a hedge: `src/status.ts` already imports from `../scripts/ct_env.js` and `tsconfig.json` `rootDir: "."` builds both trees; `pnpm build` verifies.)

- [ ] **Step 2.5 (RED/GREEN, probeIdentity — POSIX-only fixtures + mocked primary):** mocked tests (all platforms): spy-probe wrapping real spawnSync mock — inject `vi.mock('node:child_process')` at file top; cases: stdout contains `Curated Thoughts` → `'ok'`; output without it → `'reject'`; `error.code === 'ETIMEDOUT'` or `signal != null` → `'timeout'`; `error` (ENOENT) → `'reject'`. POSIX-only fixture test (`describe.skipIf(win32)`): write tmp executable shell scripts — real `ct` stub echoing the identity line → `'ok'`; `printf 'chart-testing'` → `'reject'`; `sleep 30` → `'timeout'` (assert wall time < 10 s).
- [ ] **Step 2.6:** `pnpm build && pnpm test` green; commit: `feat(dsh): ct discovery — allPathMatches walk, identity probe, 3 s walk deadline, 5-min miss cache (TDD)`

---

### Task 3: Recall wrapper — `recallWiki(ctPath, query)`

**Files:**
- Modify: `integrations/deepseek/src/wisdom.ts`
- Test: `integrations/deepseek/tests/test_wisdom.ts` (extend)

**Interfaces:**
- Consumes: Task 1 constants; `WikiEntry`.
- Produces: `export type RecallResult = { entries: WikiEntry[] | null; failure: 'timeout' | 'exit' | 'spawn' | null }` — `entries === null && failure === null` is the parse-error case (memoized by Task 5); `entries` non-null (possibly `[]`) is success. `export function recallWiki(ctPath: string, query: string, deps?: { spawnSync?: typeof spawnSync }): RecallResult`.

- [ ] **Step 3.1 (RED, mocked — primary pattern, all platforms):** `vi.mock('node:child_process')` with a controllable `spawnSync` mock; `homedir` mocked to `/tmp/fakehome`. Cases (failure classes verbatim from Hermes `recall_wiki`):
  - spawnSync called EXACTLY once with `[ctPath, 'recall', query, '--json', '--k', '3']` and options `{ timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, cwd: '/tmp/fakehome', stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true }` (assert every option — killSignal included: SIGTERM lets a hung child outlive the timeout).
  - `{ status: 0, stdout: valid wiki JSON }` → `{ entries: [{title, text}...], failure: null }` (non-string/missing title/text coerce to `''`; non-dict items skipped — same coercion as Hermes).
  - `{ status: 0, stdout: '{"results":[...]}' }` (chunks present, NO `wiki` key) → `{ entries: null, failure: null }` (parse-error class; Hermes rule: `data.wiki` must be a list).
  - `{ status: 0, stdout: 'not json' }` → `{ entries: null, failure: null }`.
  - `{ status: 0, stdout: '{"wiki": []}' }` → `{ entries: [], failure: null }` (zero hits).
  - `{ status: 3, stdout: '', stderr: 'boom' }` → `{ entries: null, failure: 'exit' }`.
  - mock returns `{ error: Object.assign(new Error('kill'), { code: 'ETIMEDOUT' }) }` → `{ entries: null, failure: 'timeout' }`.
  - mock returns `{ error: Object.assign(new Error('enoent'), { code: 'ENOENT' }) }` → `{ entries: null, failure: 'spawn' }`.
  - mock returns `{ error: Object.assign(new Error('buf'), { code: 'ENOBUFS' }) }` → `{ entries: null, failure: null }` (parse-error class — memoized, per spec).
  - POSIX-only fixture (`skipIf` win32): real tmp shell script as `ct` printing `{"wiki":[{"title":"T","text":"b"}]}` → real entries; script printing garbage → parse-error class; `sleep 30` → timeout class in < 10 s wall.
- [ ] **Step 3.2 (GREEN):** implement `recallWiki`:

```ts
import { spawnSync } from 'node:child_process';

export type RecallResult = { entries: WikiEntry[] | null; failure: 'timeout' | 'exit' | 'spawn' | null };

export function recallWiki(ctPath: string, query: string, deps: { spawnSync?: typeof spawnSync } = {}): RecallResult {
  const run = deps.spawnSync ?? spawnSync;
  let r: ReturnType<typeof spawnSync>;
  try {
    r = run(ctPath, ['recall', query, '--json', '--k', String(RECALL_K)], {
      timeout: RECALL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
  } catch {
    return { entries: null, failure: 'spawn' }; // spawnSync never throws; defensive only
  }
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOBUFS') return { entries: null, failure: null }; // overflow ≙ parse error (spec)
    if (code === 'ETIMEDOUT' || r.signal != null) return { entries: null, failure: 'timeout' };
    return { entries: null, failure: 'spawn' };
  }
  if (typeof r.status === 'number' && r.status !== 0) return { entries: null, failure: 'exit' };
  let data: unknown;
  try {
    data = JSON.parse((r.stdout ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    return { entries: null, failure: null };
  }
  const wiki = (data as { wiki?: unknown } | null)?.wiki;
  if (!Array.isArray(wiki)) return { entries: null, failure: null };
  const entries: WikiEntry[] = [];
  for (const item of wiki) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { title?: unknown; text?: unknown };
    entries.push({ title: typeof o.title === 'string' ? o.title : '', text: typeof o.text === 'string' ? o.text : '' });
  }
  return { entries, failure: null };
}
```

- [ ] **Step 3.3:** `pnpm build && pnpm test` green; commit: `feat(dsh): recallWiki — pinned argv, failure classes, ENOBUFS-as-parse-error (TDD)`

---

### Task 4: Retry budget + circuit breaker (fake timers)

**Files:**
- Modify: `integrations/deepseek/src/wisdom.ts`
- Test: `integrations/deepseek/tests/test_wisdom.ts` (extend)

**Interfaces:**
- Produces: `export type BudgetVerdict = 'allow' | 'exhausted' | 'breaker_open'`; `export class RetryGovernor { constructor(now?: () => number); gate(agentId: string): BudgetVerdict; recordFailure(agentId: string): void; }` — per spec: ≤2 attempts per agent, ≥60 s cooldown between them, breaker opens after 4 consecutive budgeted failures process-wide for 5 min, half-open allows one probe, failed half-open re-opens. Verdict semantics (pinned): `'exhausted'` covers BOTH cooldown-gated and budget-spent (the caller needs one bit — "do not spawn"); `'breaker_open'` only ever comes from the process-wide breaker. `resetDiscoveryCachesForTests()` also resets the module-level governor instance.

- [ ] **Step 4.1 (RED):** with `vi.useFakeTimers()` and a controllable `now`:
  - first `gate(id)` → `'allow'`; after `recordFailure(id)`, immediate `gate(id)` → `'exhausted'` (cooldown gate: < 60 s since the attempt).
  - `now += 60_001` → `gate(id)` → `'allow'` (2nd attempt); `recordFailure(id)` again → `gate(id)` `'exhausted'` forever (budget spent) — even after `now += 1_000_000`.
  - fresh agent id after 1 failure → `'allow'` (budget is per agent).
  - after 4 consecutive failures across any agents → `gate(anyFreshId)` → `'breaker_open'` immediately (no cooldown wait).
  - `now += 5 * 60_001` after breaker open → `gate(id)` → `'allow'` exactly ONCE (half-open); `recordFailure(id)` there → `gate` `'breaker_open'` for another 5 min.
  - a SUCCESS resets the consecutive counter: 3 failures + success + 3 failures → breaker NOT open.
- [ ] **Step 4.2 (GREEN):** implement `RetryGovernor` (module state: `Map<agentId, {attempts, lastAttemptAt}>`, `consecutive: number`, `breakerOpenAt: number | null`, `halfOpenUsed: boolean`).
- [ ] **Step 4.3:** full checks; commit: `feat(dsh): retry budget + process-wide circuit breaker (TDD, fake timers)`

---

### Task 5: `WisdomMemo` + orchestrator `renderWisdom` (SOLE failure-class mapping)

**Files:**
- Modify: `integrations/deepseek/src/wisdom.ts`
- Test: `integrations/deepseek/tests/test_wisdom.ts` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: `export type RenderOutcome = { called: boolean; failureClass: string | null }`; `export type SpawnLike = (cmd: string, args: readonly string[], opts: object) => { status: number | null; signal: NodeJS.Signals | null; error?: Error }; export type RecallDeps = { spawnSync?: SpawnLike; probe?: (path: string, budgetMs: number) => ProbeVerdict; candidates?: string[]; now?: () => number }; export function renderWisdom(ctx: unknown, deps: RecallDeps = {}): string` — plus `export function _resetWisdomStateForTests(): void` (memo + discovery caches + governor + budget). Deps injection is REQUIRED for every unit test (no real spawns).

- [ ] **Step 5.1 (RED, WisdomMemo — pure, no spawn mocks):**
  - same key → byte-identical (recallFn wrapped in a counter, invoked exactly once); different key → second recall; LRU eviction at 256 (loop 257 keys, key 1 re-recalls, key 2 does not); empty key `''` → `''` with NO recallFn call and NO memo write (counter stays 0); empty-string block memoized (hit on second call); recallFn throwing → `''`, not memoized (counter increments again); `memoize: false` result returned but NOT stored (counter increments every call).
- [ ] **Step 5.2 (GREEN):** implement `class WisdomMemo { constructor(max = MEMO_MAX, now?); renderFor(key: string, recallFn: (k: string) => { block: string; memoize: boolean }): string }` — a `Map`, get→delete→set for LRU touch, `while (size > max) delete oldest`.
- [ ] **Step 5.3 (RED, orchestrator — injected deps, each failure class):** patch `_resetWisdomStateForTests()` in `beforeEach`. Drive `renderWisdom({agent:{id:'a1'}}, deps)` with:
  - success: deps.spawnSync returns wiki JSON; deps.candidates resolved via injected probe `'ok'` → block non-empty, second call `'memo=hit'` (spawnSync call count still 1, probe count still 1), bytes identical.
  - discovery miss (probe `'reject'` on all, fs-gate bypassed via injected candidates that don't exist) → `''`, class `discovery_miss`, memoized (no spawn on second call).
  - probe timeout → `''`, class `probe_timeout`, NOT memoized. **With fake-clock control:** render 1 (failure at t=0, attempt 1); advance clock ≥ 60 s → render 2 (failure, attempt 2); advance ≥ 60 s → render 3 → class `budget_exhausted`, `''`, ZERO spawnSync calls (budget spent for a1). A fresh agent a2 at the same clock → its own 2 attempts.
  - recall timeout / non-zero exit → class `timeout`/`exit`, NOT memoized; same clock discipline as probe_timeout (advance ≥ 60 s between attempts; after the 2nd failure → `budget_exhausted`).
  - spawn failure (ENOENT) → class `spawn`, discovery cache reset verified (next render re-probes; assert probe called again), budgeted.
  - parse error / ENOBUFS → memoized (second render: spawnSync count unchanged).
  - zero hits → `''` memoized.
  - no key (`ctx = {}`) → `''`, no memo write, NO spawnSync call, NO probe call.
  - budget/breaker interplay: agent a1 fails twice → a1 frozen; new agent a2 also fails twice; agents a3+a4 one failure each → breaker open → a5's first render is `breaker_open` with zero spawns.
  - garbage ctx objects (`null`, `42`, `{agent: () => {}}`) → `''` never throws (the render body's defensive catch).
  - debug logging: `vi.spyOn(console, 'debug')` (or the module logger — match how `src/status.ts` logs) asserts the `wisdom: render agent=<id> memo=hit|miss class=<c|ok>` line shape, debug level only.
- [ ] **Step 5.4 (GREEN):** implement `_RecallOutcome`-equivalent + `renderWisdom`; the class→action mapping lives in ONE place (the outcome callable), mirroring Hermes `_RecallOutcome`:

```ts
// failure class -> (block, memoize) mapping — the SOLE such mapping:
//   discovery_miss -> ('', true)   probe_timeout -> ('', false)
//   timeout/exit/spawn -> ('', false)   parse_error/zero_hits -> (''/block, true)
//   budget_exhausted/breaker_open -> ('', false) — no spawn attempted
//   ok -> (renderBlock(entries), true)
// spawn additionally invalidates the accepted-path cache (budgeted next walk).
```

- [ ] **Step 5.5:** full checks; commit: `feat(dsh): WisdomMemo + renderWisdom orchestrator — sole failure-class mapping (TDD)`

---

### Task 6: Wire the section into `src/index.ts` (RED first)

**Files:**
- Modify: `integrations/deepseek/src/index.ts`
- Test: `integrations/deepseek/tests/test_index.ts` (extend)

**Interfaces:**
- Consumes: `renderWisdom` from `./wisdom.js`.
- Produces: `apply()` additionally calls `ctx.systemPrompt.section(...)` with `{ name: 'curated-thoughts-wisdom', order: 6000, interpolate: false, text: fn }`; `inject` and the health context registration are UNCHANGED (existing tests stay green).

- [ ] **Step 6.1 (RED):** extend `tests/test_index.ts`'s `mockCtx` with `systemPrompt.section: vi.fn(...)` collecting `sectionRegistrations`; assert after `apply(...)`: exactly one section registered, `name === 'curated-thoughts-wisdom'`, `order === 6000`, `interpolate === false`, `typeof text === 'function'`; the health `context()` registration still present with `order: 130` unchanged; `text({ agent: { id: 'x' } }, ...arbitrary)` returns a string (not a throw) even with all deps absent.
- [ ] **Step 6.2 (GREEN):** extend `DshContextExtensions.systemPrompt` in `src/index.ts` (house pattern — no ad-hoc casts at call sites) with:

```ts
  systemPrompt: {
    context(c: {
      name: string;
      order: number;
      text: () => string;
    }): unknown;
    section(s: {
      name: string;
      order: number;
      interpolate: boolean;
      text: (assembleCtx: unknown) => string;
    }): unknown;
  };
```

then register in `apply()`:

```ts
  dsh.systemPrompt.section({
    name: 'curated-thoughts-wisdom',
    order: 6000,
    interpolate: false,
    // the host invokes text(assembleCtx) on every model step; renderWisdom
    // reads keyOf from that same {agent, scope, signal} shape
    text: (assembleCtx: unknown) => renderWisdom(assembleCtx),
  });
```

(The existing health `context()` registration and `inject` are untouched. Production uses the real `spawnSync` defaults — deps are for unit tests only.)
- [ ] **Step 6.3:** `pnpm build && pnpm test` green; commit: `feat(dsh): register curated-thoughts-wisdom systemPrompt section (order 6000, interpolate:false)`

---

### Task 7: Version, CHANGELOG, README, skills drift, cold-path measurement

**Files:**
- Modify: `integrations/deepseek/package.json` (0.2.2 → **0.3.0**), `integrations/deepseek/CHANGELOG.md`, `integrations/deepseek/README.md`, `integrations/deepseek/skills/*` (drift only if contradicted)

- [ ] **Step 7.1:** bump version; CHANGELOG entry describing the feature, its no-op behavior (no `ct`, no brain wisdom, backend down), and the EXACTLY-five limitations list from the spec §Versioning (cold restart re-recall + one cache miss; transient-first-failure re-cost; memo eviction >256 agents; per-session dark after two failed attempts; brief bounded stalls under breaker budget).
- [ ] **Step 7.2:** README paragraph: what the section is, where it renders (system node 0), one recall per agent, no-op conditions.
- [ ] **Step 7.3:** skills drift: grep `integrations/deepseek/skills/*/SKILL.md` for descriptions of the plugin context; update only if the new section contradicts them.
- [ ] **Step 7.4:** `pnpm build && pnpm test` green; commit: `chore(dsh): 0.3.0 — wisdom auto-inclusion docs + version`

---

### Task 8: e2e (isolated container ONLY) + convergence

**Files:**
- Modify: `integrations/deepseek/tests/e2e/e2e.sh` (extend assertions)
- Evidence: PR #22 description + a comment

- [ ] **Step 8.1 (cold path FIRST):** inside the container, restart/stop the sidecar (or use the freshly-started cold container) and time the FIRST wisdom recall before freezing `RECALL_TIMEOUT_MS = 5000`; record the number in the PR. If cold > 5 s, bump the constant with the measurement as justification (spec pre-authorizes this).
- [ ] **Step 8.2:** extend `e2e.sh` checks: with the sidecar brain seeded (the container seeds wisdom in the base image setup — verify in `tests/e2e/Dockerfile` + `base.Dockerfile`; if the seed step is missing, add a `ct ingest`/seed step to the e2e setup, NOT to user-visible install), run a real DSH session and assert: exactly one `## Curated Thoughts — relevant memory` block in the system prompt; block length ≤ 2500; a second step's request byte-identical system prefix (memo replay); with the sidecar absent (uninstalled brain), the session proceeds with NO wisdom block and no error.
- [ ] **Step 8.3:** run `tests/e2e/run.sh`. **Toolchain fact (researched 2026-09-30):** the pinned sidecar .deb (2.12.1) does NOT ship the `ct` CLI (`dpkg -c`: only `curated-thoughts` + `curated-thoughts-mcp`); `ct` ships standalone from v2.22.0+ (`ct_2.22.0_linux_amd64.tar.gz` on GH releases). The e2e image therefore ALSO installs the `ct` tarball (curl + tar -C /usr/local/bin) in the e2e setup step — a test-only provisioning change in the e2e layer, not in user-visible install or the base image contract; if CT_VERSION is later bumped past the tarball's introduction this stays compatible. Live-model step requires `ZAI_API_KEY` — ask Kurt if absent; the non-model checks run without it. Record all evidence in the PR.
- [ ] **Step 8.4:** push; CI green on the full matrix; triage CodeRabbit + bot reviews per dual-review-cycle; sor shadow per implementation wave (ledger-only).
- [ ] **Step 8.5:** flip the spec's Status line to `Implemented 2026-09-30 (PR #22)` ONLY after every review converged AND e2e evidence is recorded; any open question → park, never merge past one. Squash-merge per repo convention, then verify the merge on the remote and delete the branch.


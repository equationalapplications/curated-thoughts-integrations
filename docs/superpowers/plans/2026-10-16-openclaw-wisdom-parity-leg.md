# OpenClaw Wisdom Parity Leg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `integrations/openclaw` 0.1.0 — a native OpenClaw plugin with the CT MCP sidecar, three skills, the v1 bootstrap block and Intuitive Wisdom live delivery on `ct-wisdom-core`.

**Architecture:** A thin plugin entry (`src/index.ts`) registers `agent_turn_prepare`, `before_prompt_build` and a tool-result middleware; `src/wisdom/adapter.ts` binds the shared core's `HostAdapter` to the prompt-hook `messages` snapshot (ledger), `prependContext` (N2), the salvage `enqueueNextTurnInjection` and the middleware (N3); `src/wisdom/bootstrap.ts` renders the memoized v1 block into `prependSystemContext`.

**Tech Stack:** TypeScript (NodeNext ESM), vitest 4, pnpm 9.15.9, Node 24 (OpenClaw's engine floor is 24.16), `@equational-applications/ct-wisdom-core` (file: dep).

**Spec:** `docs/superpowers/specs/2026-10-16-openclaw-wisdom-parity-leg-design.md` (parent: `2026-10-09-cross-harness-wisdom-parity-design.md`).

## Global Constraints

- Host pin `openclaw@2026.10.3`; `package.json#openclaw.compat.pluginApi: ">=2026.10.3"`; no runtime import of `openclaw`.
- Plugin id `curated-thoughts`; MCP server name `curated-thoughts` → `curated-thoughts-mcp --mcp`.
- Annex A constants come from ct-wisdom-core only (2 / 1200 / 12 / 3 s / 2000 / 256 / 3 / 300 s). No ct-wisdom-core edits.
- Bootstrap constants are Hermes v1: seed query `curated thoughts agent memory wisdom procedures`, `--k 3`, block cap 2500, heading `## Curated Thoughts — relevant memory`, recall timeout 5 s, probe timeout 3 s.
- `before_prompt_build` registered with `timeoutMs: 20000`.
- Manifest: `language: node`, `status: implemented`, `version: 0.1.0`, `version_mirror: package.json#version`; CHANGELOG heading `## 0.1.0 — 2026-10-16`.
- Usage and sidecar SKILL.md byte-identical to Hermes; ops differs only in the three sanctioned harness-specific regions.
- Do not touch `integrations/{hermes,claude-code,deepseek,opencode}`; top-level README only via the generated table row (`ct_ci.py readme`).
- CI edits additive only.

---

### Task 1: Scaffold + scripts + skills + manifest

**Files:**
- Create: `integrations/openclaw/{package.json,tsconfig.json,vitest.config.ts,.gitignore,openclaw.plugin.json}`
- Create: `integrations/openclaw/scripts/{ct_env.ts,ct_preflight.ts,_lazy_loader.ts,ct_doctor.ts,install.sh}` (ct_env/ct_preflight/_lazy_loader copied from deepseek; doctor's check 7 replaced by `openclaw-registration`)
- Create: `integrations/openclaw/skills/curated-thoughts-{usage,ops,sidecar}/SKILL.md`
- Modify: `integrations/openclaw/integration.yaml`
- Generate: `integrations/openclaw/scripts/_compat_generated.ts` (`python tools/ct_ci.py generate`)
- Test: `tests/test_skills_content.ts`, `tests/test_ct_env.ts`, `tests/test_ct_preflight.ts`, `tests/test_ct_doctor.ts`, `tests/test_manifest.ts`

**Interfaces:**
- Produces: `expandHome`, `allPathMatches` from `scripts/ct_env.ts` (deepseek signatures); doctor check name `openclaw-registration` reading `$OPENCLAW_CONFIG_PATH` or `~/.openclaw/openclaw.json` (JSON5-tolerant: comments stripped) for `plugins.entries["curated-thoughts"]` with `enabled !== false` and `hooks.allowConversationAccess === true`.

- [ ] Step 1: copy skills, write `tests/test_skills_content.ts` (deepseek normalizer, roots `../skills` vs `../../hermes/skills`); run → FAIL until skills exist; add skills → PASS.
- [ ] Step 2: write `tests/test_manifest.ts`: parse `openclaw.plugin.json`; assert `id === 'curated-thoughts'`, `skills` dirs each contain the three SKILL.md, `contracts.agentToolResultMiddleware` deep-equals `['openclaw']`, `mcpServers['curated-thoughts']` = `{transport:'stdio',command:'curated-thoughts-mcp',args:['--mcp']}`, `activation.onStartup === true`; package.json `openclaw.extensions` = `['./lib/src/index.js']`, `version` equals manifest `version` and integration.yaml version. Run → FAIL; write files → PASS.
- [ ] Step 3: copy ct_env/ct_preflight/_lazy_loader and their deepseek tests (adjust imports); port ct_doctor with the openclaw registration check and adapt test_ct_doctor to it. Run → PASS.
- [ ] Step 4: `pnpm install` (lockfile), `python tools/ct_ci.py generate`, `validate`, `policy`.
- [ ] Step 5: commit `feat(openclaw): scaffold + skills + doctor`.

### Task 2: Async spawn, discovery and v1 bootstrap (N5)

**Files:**
- Create: `src/wisdom/spawn.ts` (`nodeSpawnFn(env): SpawnFn` — deepseek adapter's async binding), `src/wisdom/discover.ts`, `src/wisdom/bootstrap.ts`
- Test: `tests/test_bootstrap.ts`

**Interfaces:**
- Produces:
  - `class CtLocator { constructor(deps: { env, spawnFn, candidates?: () => string[], usable?: (p)=>boolean, now?: () => number }); locate(): Promise<string|null>; invalidate(): void }` — identity probe `ct --help` must print `Curated Thoughts`; miss cached 5 min.
  - `renderBootstrapBlock(entries: {id,title,text}[]): string` (markers, sanitizer, 2500 cap, heading).
  - `class BootstrapMemo { constructor(deps: { locate: () => Promise<string|null>, spawnFn, onSpawnFailure: () => void, now? }); get(key): BootstrapRecord | undefined; ensure(key): Promise<BootstrapRecord | undefined> }` where `BootstrapRecord = { block: string; ids: string[] }` (settled outcomes only: ok, zero hits, parse error, discovery miss; timeout/exit/spawn retried, two attempts per key then settles as empty).

- [ ] Step 1: tests — render (markers present, forged `ct-fact:` stripped, entries without valid id dropped, cap respected); memo (ok memoized and not re-spawned; timeout not memoized then second failure settles empty; argv is `['recall', SEED, '--json', '--k', '3']`; discovery miss settles empty).
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS. Step 5: commit.

### Task 3: Adapter + hook wiring (N1/N2/N3, durable salvage)

**Files:**
- Create: `src/host.ts` (narrow types: `OpenClawApiLike`, `PromptBuildEvent`, `AgentCtx`, `ToolResultEvent`, `QueuedInjection`), `src/wisdom/adapter.ts`, `src/index.ts`
- Test: `tests/test_adapter.ts`, `tests/test_index.ts`

**Interfaces:**
- Consumes: Task 2 `CtLocator`, `BootstrapMemo`, `nodeSpawnFn`; core `onUserTurn`, `onToolResult`, `wisdomMatch`, `Breaker`, `marker`, `scanIds`.
- Produces:
  - `snapshotIds(messages: unknown[]): { all: string[]; live: string[] }` (newest first; user content + `__openclaw.modelPromptProjection.text`; toolResult content).
  - `class OpenClawWisdomAdapter implements HostAdapter` with `setTurn(sessionId, { messages, bootstrap?: BootstrapRecord, drained: string[], restored: boolean })`.
  - `isRecallToolName(name)`: `/__curated_recall_context(-\d+)?$/`.
  - `rewriteRecallResult(result, repeats, newIds)` over `{ content, details }`.
  - `register(api)` default entry `{ id:'curated-thoughts', name, description, configSchema, register }`.

- [ ] Step 1: adapter tests — ledger from snapshot incl. projection; live count only user role; tool envelope parse incl. `structuredContent:\n` prefix; stub + trailer; non-recall tool untouched; get_wiki_entry untouched.
- [ ] Step 2: index tests against a recording stub api — gate (trigger cron/heartbeat ⇒ no live; provenance inter_session ⇒ none; subagent key ⇒ none); admission memo (same `currentUserMessageId` twice ⇒ one CT match spawn, identical result); `messages` not array ⇒ no live; missing admission ids ⇒ no live; `assertActive` throwing ⇒ `enqueueNextTurnInjection` called with `idempotencyKey` and `metadata.ctFactIds`, result undefined; drained injection ids (agent_turn_prepare, own pluginId only) excluded from next match and post-filtered; bootstrap in `prependSystemContext`, byte-stable across turns; restored session without settled bootstrap ⇒ no live, bootstrap returned once available.
- [ ] Step 3: run → FAIL. Step 4: implement. Step 5: run → PASS. Step 6: commit `feat(openclaw): live delivery`.

### Task 4: Exactly-once property test + host shape contract

**Files:**
- Create: `tests/test_exactly_once.test.ts`, `tests/host/compatibility.json`, `tests/host/contract.test.ts`

- [ ] Step 1: property test (seeded PRNG, 200 sessions × 12 turns): a simulated host keeps a transcript; each turn it (a) drains our pending injections into the turn prompt and calls `agent_turn_prepare`, (b) calls `before_prompt_build` with a snapshot, (c) randomly times the handler out (assertActive throws) to exercise salvage, (d) randomly runs a recall tool through the middleware, (e) randomly compacts (drops oldest turns) or restarts (fresh plugin instance, same transcript). Fake CT returns random ids from a pool honoring `--exclude`. Oracle: within the model-visible window no fact id is delivered twice; live budget ≤ 12 per visible window.
- [ ] Step 2: shape contract: stub api records registrations; assert hook names ⊆ `compatibility.json.hookNames`, result fields used ⊆ `promptBuildResultFields`, middleware runtimes ⊆ manifest contracts ⊆ `middlewareRuntimes`, timeoutMs ≤ 600000, pin version equals `package.json#openclaw.compat.pluginApi` floor.
- [ ] Step 3: run → PASS (fix as needed). Commit `test(openclaw): exactly-once + shape contract`.

### Task 5: Docs, changelog, CI, release wiring

**Files:**
- Create: `integrations/openclaw/{README.md,CHANGELOG.md}`
- Modify: `README.md` (generated table row only), `.github/workflows/ci.yml` (comment documenting the shape tier; no job changes needed — discovery + core build are already generic), `scripts/install.sh` registered in `checks.shell`.

- [ ] Step 1: README (install, permissions, runtime matrix, budgets, cache-safety status), CHANGELOG `## 0.1.0 — 2026-10-16` with the AC 9 verdict or defer record.
- [ ] Step 2: `python tools/ct_ci.py readme` (row rewrite), `validate`, `policy --base origin/main`, `generate --check`, `readme --check`, `python -m unittest discover -s tests/tools`, openclaw suite, core suite, `ct_ci.py package --tag openclaw-v0.1.0 --out <scratch>` with vendored core staged.
- [ ] Step 3: commit; AC 9 live attempt (Task 6) or defer; push; PR.

### Task 6: AC 9 live capture (conditional)

- [ ] Only if the native install already works (verified: ~3 min) and no heavy jobs run: isolated `OPENCLAW_STATE_DIR` in scratch, ZAI Anthropic-compatible provider (`https://api.z.ai/api/anthropic`, model `GLM-5.3-FLASH`, key from `ZAI_API_KEY`, never printed), stub `ct` on PATH returning fixed wisdom, a throwaway capture plugin logging `llm_input` per turn; two `openclaw agent --local` turns in one session; verdict = turn-1 user message bytes (with our block) replayed identically in turn 2 and system prompt identical. Otherwise defer-and-accept.

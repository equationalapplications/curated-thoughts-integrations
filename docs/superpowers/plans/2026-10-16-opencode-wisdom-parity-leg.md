# OpenCode wisdom parity leg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the OpenCode leg (0.1.2 → 0.2.0): working N1/N2/N3 + v1 bootstrap +
ledger on the REAL 1.18.35 host shapes, with exactly-once, fail-closed, marker-hygiene and
self-trigger tests, a real-binary host contract, and a live `chat.message` e2e.

**Architecture:** Thin `OpenCodeWisdomAdapter` over `@equational-applications/ct-wisdom-core`
(unchanged). `index.ts` wires `chat.message` (bootstrap + live), `tool.execute.after`
(MCP `CallToolResult` rewrite), `experimental.session.compacting` (carry snapshot). The
build vendors the core into `lib/ct-wisdom-core/` and rewrites the bare specifier to a
relative one so the payload needs no `node_modules`.

**Tech Stack:** TypeScript (tsc, ESM), vitest, bun test (host contract), pnpm, Docker e2e.

**Spec:** `docs/superpowers/specs/2026-10-16-opencode-wisdom-parity-leg-design.md`
(refines `2026-10-09-cross-harness-wisdom-parity-design.md`).

## Global Constraints

- Host pin `opencode` + `pluginSdk` = `1.18.35`; bun `1.4.2`.
- Annex A constants frozen (2/turn, 1200 chars, 12/session, 3 s, 2000, 256, 3 fails, 300 s).
- Live marker line `source.kind: curated-thoughts/wisdom`; bootstrap marker line
  `source.kind: curated-thoughts/wisdom-bootstrap`.
- Recall tool gate: `name === 'curated_recall_context' || name.endsWith('_curated_recall_context')`.
- Envelope parse = line 1 only; rewrite preserves all non-`wiki_entries` keys.
- Payload runtime imports: `node:*` and relative only (after vendoring).
- No edits to integrations/{hermes,claude-code,openclaw,deepseek}; no top-level README edit;
  `packages/ct-wisdom-core` untouched.
- CHANGELOG heading exactly `## 0.2.0 — 2026-10-16`.
- Do not weaken existing assertions.

## File map

- Modify `integrations/opencode/src/wisdom-live/adapter.ts` — LD2/LD5/LD6/LD7/LD9 logic.
- Modify `integrations/opencode/src/index.ts` — hook wiring (LD4/LD7/LD8).
- Create `integrations/opencode/scripts/vendor_core.mjs` — LD3.
- Modify `integrations/opencode/package.json` — build step, plugin devDep 1.18.35.
- Modify `integrations/opencode/tests/test_runtime_imports.ts`, `tests/test_index.ts`,
  `tests/test_archive.ts` (add load test).
- Create `integrations/opencode/tests/test_wisdom_live_adapter.ts`,
  `tests/test_wisdom_live_exactly_once.test.ts`, `tests/test_wisdom_hooks.ts`.
- Modify `integrations/opencode/tests/host/compatibility.json`, `tests/host/contract.test.ts`;
  create `tests/host/fixtures/ct-stub.mjs`, `tests/host/fixtures/ct-mcp-server.ts`.
- Modify `integrations/opencode/tests/e2e/{run.sh,e2e.sh,Dockerfile}`; create
  `tests/e2e/ct-stub.mjs`.
- Modify `integrations/opencode/{CHANGELOG.md,README.md}`.
- Delete `docs/superpowers/handoffs/2026-10-10-opencode-parity-leg{,-wip}-handoff.md`.

---

### Task 1: Payload resolution (LD3) + the 4 real failing tests

**Files:** Create `scripts/vendor_core.mjs`; modify `package.json` (`build`),
`tests/test_runtime_imports.ts`, `tests/test_index.ts`, `tests/test_archive.ts`.

**Interfaces:** Produces `lib/ct-wisdom-core/index.js` and relative specifiers in `lib/**/*.js`.

- [ ] Step 1: tests first.
  - `test_runtime_imports.ts`: `isAllowed` in the **src** test accepts exactly
    `'@equational-applications/ct-wisdom-core'` additionally (constant `VENDORED_CORE`);
    the **lib** test stays strict (no bare specifier at all) and additionally asserts every
    relative specifier resolves to an existing file, and that `lib/ct-wisdom-core/index.js`
    exists when any lib file references `ct-wisdom-core`.
  - `test_index.ts`: hooks are exactly
    `['chat.message','dispose','experimental.chat.system.transform','experimental.session.compacting','tool.execute.after']`.
  - `test_archive.ts`: add `'lib/ct-wisdom-core/index.js'` to `ARCHIVE_FILES`; add test
    "the unpacked lib/src/index.js loads with no node_modules" — `node --input-type=module -e
    "const m = await import(process.argv[1]); if (typeof m.CuratedThoughts !== 'function') process.exit(3)" <file-url>`
    exit 0.
- [ ] Step 2: run → src/lib/archive/index tests fail.
- [ ] Step 3: `vendor_core.mjs`: resolve core lib at `../../packages/ct-wisdom-core/lib`
  (exit 1 with a build hint if `index.js` missing), `rmSync`+`cpSync` into `lib/ct-wisdom-core`,
  walk `lib/src` and `lib/scripts` `.js` files, replace `from '@equational-applications/ct-wisdom-core'`
  / double-quoted form with `from '<relative>/ct-wisdom-core/index.js'` (posix relative from the
  file's dir, prefixed `./` when needed). Build script: `tsc && node scripts/vendor_core.mjs && esbuild …`.
- [ ] Step 4: `pnpm run build && pnpm exec vitest run tests/test_runtime_imports.ts tests/test_index.ts tests/test_archive.ts --testTimeout 60000` → PASS.
- [ ] Step 5: commit `fix(opencode): vendor ct-wisdom-core into the payload; hook-shape + import-policy tests`.

### Task 2: Adapter on the real host shapes (LD2, LD5, LD6, LD7, LD9)

**Files:** Modify `src/wisdom-live/adapter.ts`; create `tests/test_wisdom_live_adapter.ts`.

**Interfaces (Produces):**
- `isRecallToolName(name: unknown): boolean`
- `partId(now?: number): string` — `prt_` + 12 hex + 14 base62, strictly ascending in-process.
- `LIVE_MARKER`, `BOOT_MARKER` string constants; `isOurPart(part): boolean`.
- `userQueryText(parts: unknown[]): string` — non-synthetic, non-ignored text parts.
- class `OpenCodeWisdomAdapter` with deps `{env, spawnFn?, discover?, now?, fetchHistory?, fetchSession?}`
  where `fetchSession(id) => Promise<{parentID?: string} | null>`; methods
  `sessionKind(id): Promise<'parent'|'child'>`, `rebuildLedgerAsync(session)`,
  `snapshotForCompaction(sessionId): Promise<void>`, `hasUserHistory(sessionId): boolean`
  (from last rebuild), `bootstrapMemo`, `setBootstrap(sessionId, block)`, plus HostAdapter ops.
- `rewriteEnvelopeStub` accepts a `CallToolResult`-like object or a string and returns the
  same shape.

- [ ] Step 1: failing tests: tool-name gate (both forms, rejects `curated_get_wiki_entry`);
  envelope on `{content:[{type:'text',text}]}` bare-inner and `{result}`-wrapped, trailer
  lines ignored by the parser, other keys preserved after rewrite, non-text content kept;
  ledger = history ∪ carry ∪ memo ∪ delivered; compaction snapshot keeps ids even when the
  post-compaction history (simulated deletion) lacks them; live budget counts only
  live-marker user parts; child session → `deliveryEnabled` false; unknown → child; child N3
  ledger includes parent history; parent fetch failure → child-only; `partId` format/order.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run → PASS; `pnpm exec tsc --noEmit`.
- [ ] Step 5: commit `feat(opencode): adapter on the real 1.18.35 shapes — MCP N3, carry-forward, parent-only`.

### Task 3: Hook wiring — bootstrap (LD4), self-trigger guard (LD8), fail-closed (AC 4)

**Files:** Modify `src/index.ts`; create `tests/test_wisdom_hooks.ts`.

- [ ] Step 1: failing tests driving `CuratedThoughts(input)` with a fake `client`
  (`session.messages`, `session.get`) and injected `ct` via a temp stub script on PATH
  (`CURATED_BRAIN_DIR` temp; HOME temp): first turn pushes bootstrap part then live part,
  both `synthetic:true`, `prt_` ids, `messageID` = message id; bootstrap not re-rendered when
  history already has a user row; a bootstrap fact offered by `wisdom match` on turn 1 is not
  live-delivered; re-fire on the same output adds nothing; all-synthetic message → no `wisdom
  match` spawn; query excludes our parts; `ct wisdom match --help` exit 1 → no delivery and
  no further match spawns; 3 timeouts → breaker open (no spawn); child session → no parts; N3
  rewrites `content[0].text` for `curated-thoughts_curated_recall_context`; compacting then
  next turn → no redelivery.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: PASS. Step 5: commit
  `feat(opencode): wisdom bootstrap (v1) + live delivery wiring (0.2.0)`.

### Task 4: Exactly-once property test (AC 2, AC 3)

**Files:** Create `tests/test_wisdom_live_exactly_once.test.ts`.

- [ ] Sim host: persisted rows store; a session tree (parent + children); `chat.message`
  drives the real hooks object; a seeded PRNG chooses per step among user turn, recall tool
  call (random ids incl. repeats, both N3 shapes), compaction, process restart (fresh plugin
  instance = memo/carry/delivered lost, rows kept), child turn, child recall. Stub `wisdom
  match` returns random ids (ignoring `--exclude` half the time to stress the post-filter).
  Oracle (line-1 parse): per session tree, each id appears in at most one delivered user
  part (bootstrap or live) and no full (non-stub) recall entry repeats an id already in
  context. 200 sessions. Commit `test(opencode): exactly-once randomized multi-channel`.

### Task 5: Host pin + host-contract extension (LD11, AC 7)

**Files:** `tests/host/compatibility.json`, `package.json` devDep, `pnpm-lock.yaml`,
`tests/host/contract.test.ts`, fixtures `ct-stub.mjs`, `ct-mcp-server.ts`; `integration.yaml`
comment if it names a version.

- [ ] Bump pins → 1.18.35 (+ install strings). `pnpm install` (lockfile).
- [ ] New contract test per LD11; run locally with
  `OPENCODE_BIN=<scratch>/node_modules/opencode-darwin-x64/bin/opencode <bun> test tests/host/contract.test.ts`.
- [ ] Commit `test(opencode): host contract — wisdom live delivery on the pinned 1.18.35 binary`.

### Task 6: Docs + version metadata (AC 6, AC 8)

- [ ] CHANGELOG `## 0.2.0 — 2026-10-16` entry; opencode README wisdom section; verify
  `python3 tools/ct_ci.py` manifest checks (version_mirror) pass. Remove both handoff files.
  Commit `docs(opencode): 0.2.0 changelog + README; drop committed handoffs`.

### Task 7: Live e2e (AC 10) — LAST

- [ ] `docker ps` until no other e2e container; extend `e2e.sh`/`run.sh`/`Dockerfile` per
  LD12; run `tests/e2e/run.sh` with `ZAI_API_KEY` inherited (never echoed). Record output
  evidence in the PR. Commit `test(opencode): live chat.message e2e step`.

### Task 8: Verify, push, PR

- [ ] Full opencode vitest (`--testTimeout 60000` locally), core suite, deepseek suite
  (sanity), tsc. Push `feat/opencode-parity`; `gh pr create` (body ends with the attribution).

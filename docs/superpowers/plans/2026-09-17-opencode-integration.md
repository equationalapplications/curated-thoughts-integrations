# OpenCode Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `integrations/opencode/`, a sibling to `integrations/hermes/` and `integrations/deepseek/` that wires the Curated Thoughts memory sidecar into OpenCode via a TypeScript plugin, with a doctor / status / preview-first installer that mirrors the sibling integrations' discipline.

**Architecture:** A new TypeScript integration delivered as a **GitHub release tarball**, matching this repo's existing per-integration convention (`@equational-applications/opencode-curated-thoughts` names the payload; npm publishing is deferred until the integration is proven). Its **named** plugin export takes `(input: PluginInput, options?: PluginOptions)` and returns a `Hooks` object; `experimental.chat.system.transform` appends a cached health block to `output.system` (lazy refresh, 30s freshness window, 2s deadline, never awaited on the prompt path). OpenCode alone owns the sidecar lifecycle; the plugin never spawns `curated-thoughts-mcp`. **Skills cannot be registered programmatically** — OpenCode discovers `SKILL.md` from the filesystem, so the installer copies the three skill directories into `~/.config/opencode/skills/`. A 9-check `ct_doctor.ts` mirrors the siblings' deep verifier (and *does* handshake the sidecar, as Hermes does); `src/status.ts` mirrors their fast session-start probe. Because OpenCode's `plugin` config array installs from npm and cannot load a tarball, the install path is the host's local plugin directory: the installer unpacks the payload to `${XDG_DATA_HOME:-~/.local/share}/curated-thoughts/opencode/` and writes one loader file into `~/.config/opencode/plugins/curated-thoughts.js`. The installer is preview-first: it proposes the payload unpack, the loader file, the skill copy plan, and the `mcp` entry in `~/.config/opencode/opencode.json[c]`, and only mutates under explicit opt-in (`CT_INSTALL_EDIT=1`), preserving any explicit `"enabled": false` and preserving JSONC comments.

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, `@opencode-ai/plugin` (pinned; SDK version tracks the host version — both 1.18.31 at writing), `jsonc-parser` for comment-preserving config edits (bundled), esbuild for self-contained entry-point bundles, Bun for the host-validation contract test, execa, pnpm. Sidecar binary `curated-thoughts-mcp --mcp`. Skills are kebab-case `SKILL.md` Markdown. No npm publishing step in v0.

**Spec:** [`docs/superpowers/specs/2026-09-17-opencode-integration-design.md`](../specs/2026-09-17-opencode-integration-design.md) — the plan argues from the spec; executors read both.

**Sibling references (read before each task):**
- `integrations/hermes/` — every layer in this integration mirrors a Hermes one.
- `integrations/deepseek/` — closest architectural analog (TypeScript, plugin module, sidecar via MCP).
- Specifically:
  - `hermes/scripts/ct_doctor.py` → `opencode/scripts/ct_doctor.ts` (9 checks, identical semantics; check 7 is OpenCode-specific)
  - `hermes/scripts/ct_status.py` → `opencode/src/status.ts` (fast probe, same shape)
  - `hermes/scripts/ct_env.py` → `opencode/scripts/ct_env.ts` (brain / vault / sidecar discovery)
  - `hermes/scripts/ct_preflight.py` → `opencode/scripts/ct_preflight.ts` (PR #188 census, **logically identical**)
  - `hermes/scripts/install.sh` (and `deepseek/scripts/install.sh`) → `opencode/scripts/install.sh` (preview-first, `CT_INSTALL_EDIT=1` opt-in, **plus payload unpack, loader file, and skill file copy** — Hermes already copies a payload into the harness's plugin tree and installs skills as files; DeepSeek does neither, because dsh registers skills at runtime and OpenCode cannot)
  - `hermes/skills/{usage,ops,sidecar}/SKILL.md` → `opencode/skills/{usage,ops,sidecar}/SKILL.md` (verbatim)
  - `deepseek/integration.yaml` → `opencode/integration.yaml` (CI contract; `language: node`, `pnpm run build && pnpm run test`, `lib/` ships)

## Global Constraints

- **Sidecar:** `curated-thoughts-mcp --mcp`. Same binary name as Hermes and DeepSeek; no second binary. `requires_sidecar: ">=2.5"`, `compat_tier: v2.5-full`.
- **Environment contract** (per repo's [`README.md`](../../../README.md)): `CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`. No other `CURATED_*` variables.
- **Brain vs vault:** brain dir holds `brain.db` + `config.json`; vault is `vault_path` inside that `config.json` — machine-specific, the first thing that breaks on import. (Do not confuse the brain's `config.json` with OpenCode's `opencode.json`.)
- **Three rules:** one sidecar only; never touch the vault out-of-band; fail open, diagnose early.
- **dpkg assumption:** forbidden — OpenCode ships on macOS / Linux / Windows.
- **Sidecar lifecycle ownership — scoped:** the *plugin* never spawns `curated-thoughts-mcp`, never reconnects at runtime, never opens a second diagnostic process. The *doctor*, which the user invokes, does handshake the sidecar for check 3, exactly as `hermes/scripts/ct_doctor.py` does. Do not delete check 3.
- **The doctor never boots OpenCode.** It reads configuration files; it does not start a server to inspect effective state.
- **Honesty in unknown:** when no MCP connection-status event reaches the `event` hook, the snapshot reports `connection: 'unknown'` and `preflight: 'not-checked'`. When registration is absent from the one config file the doctor reads, the result is `UNKNOWN` with the scope stated — OpenCode merges remote / project / `.opencode/` / env-var / managed config the doctor cannot see. We do not invent evidence to look healthy, and we do not claim knowledge of the merged config.
- **Installer is preview-first:** always returns a structured proposal first; mutation only under explicit `CT_INSTALL_EDIT=1`. Existing `"enabled": false` on `curated-thoughts` remains disabled. JSONC comments are preserved through a comment-aware editor, not stripped, and a competing `.json` file is never written beside a `.jsonc`.
- **Delivery is a GitHub release tarball** (`release.yml`, tag `opencode-v<version>`), not an npm publish. Do not add a publish step, and do not touch the `plugin` config array — that array resolves npm specs and is reserved for the deferred npm release.
- **No `npm install -g` anywhere in the install path.** The doctor is run from the unpacked payload (`node <payload>/lib/scripts/ct_doctor.js`).
- **The build must be self-contained.** The tarball carries no `node_modules/`, and OpenCode bun-installs dependencies only for npm plugins. Therefore: the plugin runtime path (`lib/src/index.js`) has **zero** third-party runtime dependencies — adding one is a review-blocking change; `jsonc-parser` is bundled into the installer at build time; `better-sqlite3` stays external and is lazily `require`d by the pre-flight check alone.
- **Configuration is environment-only in v0.** The loader-file install path cannot pass per-plugin options (that is the npm tuple form), so `src/index.ts` must work correctly with `options === undefined`, falling back to `CURATED_BRAIN_DIR` then `~/.brain`.
- **CI matrix:** `ubuntu-latest`, `macos-latest`, `windows-latest` × Node `22.x`, `24.x`. The Bun host contract runs in a **separate `ci.yml` job**, not as a matrix axis — `tools/ct_ci_discover.py` expands only the `python`/`node` axes, so a `bun:` axis would validate (after a schema change) and then silently vanish from CI.
- **Manifest schema change is required and in scope:** `shared/integration.schema.json` sets `additionalProperties: false` on both `checks` and `matrix`. `checks.host` must be added there or `python tools/ct_ci.py validate` rejects the manifest. `shared/` is in `SHARED_PREFIXES`, so this edit re-runs every integration's CI — land it as its own commit.
- **Status field gates the tooling:** `tools/ct_ci_discover.py` and `tools/ct_ci_generate.py` both filter to `status == "implemented"`. While the manifest says `planned`, `ct_ci.py discover` will not list the integration and `ct_ci.py generate` will not emit `scripts/_compat_generated.ts`. Flip to `implemented` in the task that lands the source (Task 7), not before.
- **Idempotence discipline:** install.sh prints by default; only writes when `CT_INSTALL_EDIT=1` is set. Never overwrites an existing entry or a user-modified SKILL.md.
- **Process matching** ([`docs/process-matching.md`](../../process-matching.md)): path-anchored full-command-line only, never name-based, never bare `-f`.
- **License:** MIT. Matches the repo and Hermes.
- **Pre-flight parity:** `ct_preflight.ts` must stay **logically identical** to `ct_preflight.py` (same SQL, same classification, same recovery hints). Drift between the three is a CI gate, not a doc rule.
- **Naming:** integration `id` is `opencode` (matches `shared/integration.schema.json` pattern `^[a-z][a-z0-9-]*$`).
- **Node module resolution:** NodeNext ESM; relative imports use `.js` extension even from `.ts` sources (TypeScript convention under NodeNext).
- **Attribution:** every commit ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>` (matches existing repo history).
- **Permission gates:** commit, push, publication, and installation into the user's `~/.config/opencode/` all require separate, explicit user authorization.

---

## Task 1: Establish the released OpenCode contract

Everything downstream is written against the hook names and shapes this task
confirms. The spec's §3/§10 claims are pinned to `@opencode-ai/plugin` 1.18.31
and the OpenCode docs; this task re-verifies them against a real binary.

**Files:**
- Create: `integrations/opencode/tests/host/compatibility.json`
- Create: `integrations/opencode/tests/host/fixtures/probe-plugin.ts`
- Create: `integrations/opencode/tests/host/contract.test.ts`
- Create: `integrations/opencode/package.json`
- Create: `integrations/opencode/vitest.config.ts`
- Create: `integrations/opencode/tsconfig.json`

**Step-by-step:**

- [ ] **Step 1.1: Pick exact host versions and record them** — do not infer from the supplied checkout. `@opencode-ai/plugin` tracks the OpenCode release version, so pin both to the same release (`npm view opencode-ai version`, `npm view @opencode-ai/plugin version`). Write `tests/host/compatibility.json`:

```json
{
  "opencode": "1.18.<exact>",
  "pluginSdk": "1.18.<exact>",
  "bun": "1.<exact>",
  "nodeFallback": "22.<exact>"
}
```

- [ ] **Step 1.2: Install OpenCode at the pinned version** into a host test fixture location (NOT the user's `~/.config/opencode`). Record the install path and the binary location used by the test runner.

- [ ] **Step 1.3: Write a probe plugin** — `tests/host/fixtures/probe-plugin.ts` exporting a **named** plugin function (and, separately, a default export and a `{ server }` module form in sibling fixtures) that records to a temp JSON file:
  - Which of the exported forms the host actually invoked.
  - Whether `experimental.chat.system.transform` fired, and whether `input.sessionID` was present.
  - The `output.system` array contents before and after mutation.
  - Whether the second argument (`options`) carried the values from the `["<spec>", { … }]` tuple form in config.
  - Whether `dispose` was called on shutdown.
  - Every `event` payload type seen, so MCP-status events (if any) can be identified by name.

- [ ] **Step 1.4: Write the host contract test** — `tests/host/contract.test.ts` runs OpenCode with the probe plugin in a child process and asserts:

```ts
expect(probe.namedExportInvoked).toBe(true);
expect(probe.systemTransformFired).toBe(true);
expect(probe.sessionIdPresentOnChatCall).toBe(true);
expect(probe.priorSystemEntriesPreserved).toBe(true);   // pre-existing output.system entries verbatim
expect(countOccurrences(probe.finalSystem.join('\n'), '## Curated Thoughts')).toBe(1);
expect(probe.optionsPropagated).toBe(true);
expect(probe.disposeCalled).toBe(true);
// Recorded, not asserted — drives the unknown fallback:
record('defaultExportInvoked', probe.defaultExportInvoked);
record('mcpStatusEventTypes', probe.eventTypes.filter(isMcpStatus));
```

- [ ] **Step 1.5: Verify skill discovery from the filesystem** — write the three `SKILL.md` files into `$HOME/.config/opencode/skills/<name>/SKILL.md` under the temporary HOME and assert OpenCode surfaces them in the `skill` tool description. This is the *only* delivery path for skills; confirm it before Task 6 builds on it. Also confirm plural `skills/` is the current directory name.

- [ ] **Step 1.6: Verify plugin loading through the v0 install path** — pack the integration, unpack the payload into a temporary data dir, write `~/.config/opencode/plugins/curated-thoughts.js` re-exporting the payload's `lib/src/index.js` by `file://` URL, and assert the host loads it. This is the tarball delivery path and it is the one that must work. Record, without depending on it: whether a bare `plugin` npm spec also loads (for the deferred npm release), and whether the loader file may live in a subdirectory of `plugins/` (v0 assumes top-level files only).

- [ ] **Step 1.7: Run under temporary HOME / XDG / `OPENCODE_CONFIG` locations** so no production MCP registration or managed config is read. The probe must not require real model credentials — use a fixture provider if the host invokes hooks only during a session-bearing call.

- [ ] **Step 1.8: Record the findings** into `tests/host/compatibility.json` alongside the versions: which export form works, whether MCP status events exist, whether file-URL plugins load. Tasks 3, 5 and 6 read this file rather than re-deriving.

- [ ] **Step 1.9: Stop for design revision** if (a) OpenCode does not load the plugin from an npm spec, (b) `experimental.chat.system.transform` is absent or does not fire, (c) pre-existing `output.system` entries are not preserved, or (d) skills are not discovered from `~/.config/opencode/skills/`. The spec must be revised before implementation continues.

**Validation:** Tests must run against a real OpenCode binary, not only a mocked hooks object. Record any assertion that could not be executed.

---

## Task 2: Port environment resolution and local readiness

**Files (all paths relative to `integrations/opencode/`):**
- Create: `scripts/ct_env.ts`
- Create: `src/status.ts`
- Create: `tests/test_ct_env.ts`
- Create: `tests/test_status.ts`

**Step-by-step:**

- [ ] **Step 2.1: Define `LocalSnapshot` interface** in `src/status.ts`:

```ts
export type LocalReadiness = 'ready' | 'degraded' | 'unknown';

export interface LocalSnapshot {
  readiness: LocalReadiness;
  reasons: string[];
}

export function probeLocal(
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
): Promise<LocalSnapshot>;
```

- [ ] **Step 2.2: Write failing tests for environment resolution** in `tests/test_ct_env.ts` covering:
  - All three brain overrides (`CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`).
  - Split-brain layout (`brain.db` separate from `config.json`).
  - Explicit `CURATED_*` server environment variables.
  - Relative paths, paths with spaces, Windows paths.
  - Unreadable configuration (chmod 000 in POSIX test; error-path branch).
  - `brain` resolves to the first existing path; never to a guessed default.

- [ ] **Step 2.3: Write failing tests for `probeLocal`** in `tests/test_status.ts`:
  - Returns `unknown` (not `degraded`) when the brain is unresolved — never inspects a guessed brain.
  - Bounded reason codes only (no raw config content, no exception messages).
  - Respects `AbortSignal` for cooperative cancellation.
  - Does not invoke the sidecar (mock `which`/`fs.access` and assert no subprocess spawn).
  - Asynchronous filesystem probing — no synchronous doctor checks on the prompt path.

- [ ] **Step 2.4: Implement `scripts/ct_env.ts`** — ports the brain / vault / sidecar-discovery contract from `hermes/scripts/ct_env.py` and `deepseek/scripts/ct_env.ts`. The full docstring from the Python source applies: *"never spawns the sidecar — that costs an MCP handshake — and never opens the brain database"*.

- [ ] **Step 2.5: Implement `probeLocal`** in `src/status.ts` using `ct_env.ts`. The function is the only call site on the prompt path that inspects the filesystem; doctor scripts use the same underlying helpers in their own async path.

- [ ] **Step 2.6: Verify Node-targeted tests pass.** Matrix coverage for Windows / macOS / Linux is supplied by the repo's CI runner; record any platform not actually executed.

---

## Task 3: Bounded refresh, prompt formatting, and the hooks object

**Files (relative to `integrations/opencode/`):**
- Create: `src/refresh.ts`
- Create: `src/format.ts`
- Create: `src/index.ts`
- Create: `tests/test_refresh.ts`
- Create: `tests/test_format.ts`
- Create: `tests/test_index.ts`

**Prerequisite:** read `tests/host/compatibility.json` from Task 1 for the export form and whether MCP status events exist.

**Step-by-step:**

- [ ] **Step 3.1: Define `HealthSnapshot` and `HealthCache` interfaces** in `src/refresh.ts`:

```ts
export interface HealthSnapshot {
  local: 'ready' | 'degraded' | 'unknown';
  connection: 'connected' | 'disabled' | 'failed' | 'unknown';
  preflight: 'not-checked';
  stale: boolean;
}

export interface HealthCache {
  current(): HealthSnapshot;
  requestRefresh(): void;
  dispose(): void;
}
```

- [ ] **Step 3.2: Write failing tests with fake clocks** in `tests/test_refresh.ts`:
  - Initial state is `{ local: 'unknown', connection: 'unknown', preflight: 'not-checked', stale: true }`.
  - After a successful refresh under 2s, the snapshot is no longer stale.
  - The freshness window is 30s — `requestRefresh()` within that window does not re-probe.
  - Concurrent `requestRefresh()` calls share one in-flight refresh.
  - A refresh that exceeds 2s is abandoned; the previous value is retained.
  - `requestRefresh()` never blocks the caller and never throws into it.
  - `dispose()` invalidates any pending result without waiting indefinitely.

- [ ] **Step 3.3: Write failing tests for `src/format.ts`** in `tests/test_format.ts`:
  - Secrets (API keys, full vault paths under `~/…`, raw error messages, exception text) **never** appear in the output.
  - The routing reminder appears in the block.
  - The output matches the sibling shape: `## Curated Thoughts\nMemory sidecar ready (brain: …)` / `… DEGRADED — CT tool calls may fail. Run ct_doctor for details.`
  - The block always begins with the exact `BLOCK_HEADING` constant used for idempotence matching.

- [ ] **Step 3.4: Write failing tests for `src/index.ts`** in `tests/test_index.ts`, driving the returned hooks object directly:
  - The module's plugin export returns an object whose keys are exactly `experimental.chat.system.transform`, `event`, `dispose`.
  - Calling the system hook with `sessionID: undefined` neither refreshes nor mutates `output.system`.
  - Pre-existing `output.system` entries are unchanged and still in order after injection.
  - The block appears exactly once after repeated invocation.
  - The hook does not await the probe (assert it resolves while the probe promise is still pending).
  - Options from the second argument override env defaults; a missing second argument falls back to `CURATED_BRAIN_DIR` then `~/.brain`.
  - `dispose()` tears down the cache.

```ts
expect(snapshot.preflight).toBe('not-checked');
expect(output.system.slice(0, prior.length)).toEqual(prior);
expect(countOccurrences(output.system.join('\n'), '## Curated Thoughts')).toBe(1);
```

- [ ] **Step 3.5: Implement `HealthCache`** in `src/refresh.ts`:
  - One in-flight refresh per plugin instance.
  - `AbortController` per refresh; the 2s deadline honored via `AbortSignal.timeout`.
  - `dispose()` invalidates the cache and abandons the in-flight promise.
  - Fail-open: probe errors keep the previous cached value or empty.

- [ ] **Step 3.6: Implement `formatStatusBlock`** in `src/format.ts` — secrets-aware formatter. Reuse the formatting rules from `integrations/deepseek/src/format.ts`.

- [ ] **Step 3.7: Implement `src/index.ts`** — the named plugin export, per spec §3:
  - Signature `(input: PluginInput, options?: PluginOptions) => Promise<Hooks>`; brain dir resolves from `options`, then env, then default. The v0 loader-file install supplies no options, so the `options === undefined` path is the *primary* case and must be tested as such.
  - **Zero third-party runtime imports** in this module and everything it pulls in — the tarball ships no `node_modules/`. Node builtins only.
  - `experimental.chat.system.transform`: skip session-less calls; `cache.requestRefresh()` without await; push one string onto `output.system`; skip if a `BLOCK_HEADING` entry is already present.
  - `event`: update `connection` only if Task 1 recorded an MCP status event type; otherwise the field stays `'unknown'` and the hook is omitted entirely rather than left as dead code.
  - `dispose`: `cache.dispose()`.
  - **No skill registration** — there is no such hook. Skills are Task 4/6.

- [ ] **Step 3.8: Verify the package entry point** — `package.json` `exports` expose the plugin export and `./doctor` (`lib/scripts/ct_doctor.js`), and nothing else. No internal types leak.

---

## Task 4: Preview-first registration — payload, loader file, config, skills

**Files (relative to `integrations/opencode/`):**
- Create: `scripts/registration.ts`
- Create: `scripts/install.ts`
- Create: `scripts/install.sh`
- Create: `scripts/loader.js.tmpl`
- Create: `tests/test_registration.ts`
- Create: `tests/test_install.ts`

**Step-by-step:**

- [ ] **Step 4.1: Write failing tests for `propose()`** in `tests/test_registration.ts`. The destination is `~/.config/opencode/opencode.json` or `opencode.jsonc` (whichever exists; prefer the existing one, default to `.json` when neither does), honoring `XDG_CONFIG_HOME` and `OPENCODE_CONFIG`:
  - A missing entry yields a proposal adding `mcp["curated-thoughts"]` with **the real shape** — `type: 'local'`, `command: ['curated-thoughts-mcp', '--mcp']`, `enabled: true`, `environment: { CURATED_BRAIN_DIR }` — while preserving unrelated keys.

```ts
expect(proposal.mcp['curated-thoughts']).toEqual({
  type: 'local',
  command: ['curated-thoughts-mcp', '--mcp'],
  enabled: true,
  environment: { CURATED_BRAIN_DIR: '/tmp/brain' },
});
```

  - The proposal includes a `payloadDir` (`${XDG_DATA_HOME:-~/.local/share}/curated-thoughts/opencode`) and a `loader` (`~/.config/opencode/plugins/curated-thoughts.js`) whose contents re-export the payload's `lib/src/index.js` by absolute `file://` URL.
  - The `plugin` config array is **not** modified — assert it is byte-identical in the proposal. It is the npm path, reserved for the deferred npm release.
  - An existing loader file pointing at a *different* payload directory is reported as a conflict, not silently repointed. An existing loader pointing at the same payload is a no-op.
  - An existing disabled entry remains disabled:

```ts
expect(proposal.mcp['curated-thoughts'].enabled).toBe(false);
```

  - An existing entry with a different `command` is preserved and reported as a conflict, not silently overwritten.
  - A duplicate alias (a second MCP entry pointing at the same binary) is reported as a conflict.
  - The proposal includes a `skills` copy plan with three `{ from, to }` pairs targeting `~/.config/opencode/skills/<name>/SKILL.md`; a destination that exists with different content is a conflict, an identical one is a no-op.
  - `propose()` performs no filesystem mutation.

- [ ] **Step 4.2: Write failing tests for `apply()`** in `tests/test_install.ts`:
  - In preview mode (no `CT_INSTALL_EDIT=1`), nothing is written — no payload, no loader, no skills, no config.
  - With `CT_INSTALL_EDIT=1`, the payload is unpacked, the loader is written, and the config destination is updated with a `.bak` backup written first.
  - Re-running with a newer payload replaces the payload in place and leaves the loader untouched when its target is unchanged.
  - The loader file is never written into a `plugins/` path that is a symlink out of the config dir.
  - **Comments and formatting survive**: a JSONC config with comments and trailing commas keeps them after the edit, and the two new keys are present. This is the normal case, not an edge case.
  - A config that cannot be parsed at all prints manual merge instructions and writes nothing; a competing `.json` is never created beside a `.jsonc`.
  - The installer refuses to follow symlinks into the destination.
  - Concurrent external edits abort the apply (mtime mismatch).
  - Repeated no-op installation (already configured, skills identical) prints and exits cleanly.
  - Partial-failure recovery: if writing fails partway, the original file is restored from the backup.
  - Skill copy is atomic per file (temp file + rename) and never clobbers a user-modified SKILL.md without an explicit conflict report.

- [ ] **Step 4.3: Implement `scripts/registration.ts`** — pure `propose(input) → RegistrationProposal` per spec §4. No filesystem mutation. `apply()` is a closure on the proposal; it is the only path that touches disk, and only when explicitly invoked.

- [ ] **Step 4.4: Implement `scripts/install.ts`** — orchestrates:
  - Resolves the destination and reads it with a JSONC-tolerant parser.
  - Calls `propose()`, prints the structured diff: payload dir, loader path and contents, skill copy plan, config merge.
  - Under `CT_INSTALL_EDIT=1`, calls `apply()` with backup + mtime check, using `jsonc-parser` `modify`/`applyEdits` so comments survive.
  - Invokes the doctor (`<payload>/lib/scripts/ct_doctor.js check`) at the end as the verification step.
  - Does **not** run `npm install -g` and does **not** edit the `plugin` array.

- [ ] **Step 4.5: Implement `scripts/install.sh`** — POSIX bash wrapper:
  - Forwards arguments and exit codes from `install.ts`.
  - Prints the preview banner and the `CT_INSTALL_EDIT=1` hint.
  - Shellcheck-clean; no Node-specific shell features; no bashisms beyond the sibling scripts' baseline.

- [ ] **Step 4.6: Add an opt-in "config-only" mode** (`--skip-config`) for users who manage `opencode.json` themselves: the payload, loader and skills are still installed, the `mcp` block is printed for manual merge, and the doctor reports the MCP entry as `UNKNOWN` with the scope statement rather than FAIL.

- [ ] **Step 4.7: Render the loader from `scripts/loader.js.tmpl`**, not from an inline string, so its contents are reviewable and testable on their own. It carries a "generated — do not edit" banner and the payload path in a comment. Test that a payload path containing spaces or non-ASCII characters produces a loader that still parses as an ES module.

---

## Task 5: Doctor and provenance pre-flight

**Files (relative to `integrations/opencode/`):**
- Create: `scripts/ct_doctor.ts`
- Create: `scripts/ct_preflight.ts`
- Create: `tests/test_ct_doctor.ts`
- Create: `tests/test_ct_preflight.ts`

(`scripts/_compat_generated.ts` is *generated*, not hand-written — see Task 7.2.)

**Step-by-step:**

- [ ] **Step 5.1: Port the 9-check categories and result/exit-code contract** from `hermes/scripts/ct_doctor.py` and `deepseek/scripts/ct_doctor.ts`. Keep check 3 (sidecar reachable via `tools/list` over MCP stdio) — the doctor is user-invoked and *is* allowed to spawn the sidecar; only the plugin path is forbidden from doing so.

- [ ] **Step 5.2: Implement the OpenCode-specific check 7** with three independent pieces of evidence, none implying another:
  - `mcp["curated-thoughts"]` present in the global `opencode.json[c]` (JSONC-tolerant read), with the expected `type`/`command` shape.
  - The loader file present at `~/.config/opencode/plugins/curated-thoughts.js` **and** the payload it names present and readable. A loader pointing at a missing payload is FAIL with a reinstall hint — that is local, unambiguous evidence, not a merged-config guess, so the §5.3 scope caveat does not apply to it.
  - The three skill directories present under `~/.config/opencode/skills/`.

- [ ] **Step 5.3: Print the scope statement with check 7's result.** The doctor reads the global config only; OpenCode merges remote, project, `.opencode/`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT` and managed sources it cannot see. A missing entry is `UNKNOWN — not found in <path>; OpenCode also merges project and managed config`, with a recovery hint. An unreadable or unparseable file is FAIL. Never report a confident FAIL for something that may be registered elsewhere, and never boot OpenCode to find out.

- [ ] **Step 5.4: Report incomplete evidence honestly elsewhere too** — a check whose input cannot be read reports FAIL with a recovery hint, not WARN-with-default.

- [ ] **Step 5.5: Lazy-load the SQLite-dependent census** in `ct_preflight.ts` so a missing `better-sqlite3` build only degrades that single check.

- [ ] **Step 5.6: Port synthetic fixtures** for the pre-flight tests:
  - Live rows vs deleted rows.
  - Legacy columns.
  - Null `source_ref` references.
  - Evidence gaps.
  - Missing anchors (engine mismatch).
  - All from `hermes/scripts/ct_preflight.py` — the three pre-flight ports must be **logically identical**.

- [ ] **Step 5.7: Verify the pre-flight opens the brain read-only**, issues only SELECT, and closes the connection deterministically. The architectural gate (`policy.allow_sqlite_readonly`) still applies.

- [ ] **Step 5.8: Verify clean-room JSON output** — `ct_doctor.ts --json` returns diagnostic results as JSON even when the brain DB is unreachable or missing, and never crashes with an unhandled error.

**Validation:** Exit 0 means all PASS; 1 means any FAIL; 2 means warnings without failures (CI-usable).

---

## Task 6: Skills, archive usability, and integration README

**Files (relative to `integrations/opencode/`):**
- Create: `skills/curated-thoughts-usage/SKILL.md`
- Create: `skills/curated-thoughts-ops/SKILL.md`
- Create: `skills/curated-thoughts-sidecar/SKILL.md`
- Create: `tests/test_skills_content.ts`
- Create: `tests/test_build_output.ts`
- Create: `tests/test_archive.ts`
- Create: `README.md`

**Step-by-step:**

- [ ] **Step 6.1: Port the three SKILL.md files verbatim** from `integrations/hermes/skills/`. Their frontmatter already satisfies OpenCode's contract (`name` required and matching the directory, `^[a-z0-9]+(-[a-z0-9]+)*$`, `description` 1–1024 chars, only `name`/`description`/`license`/`compatibility`/`metadata` recognized). Change body text only where a command is genuinely Hermes-specific (e.g. `ct_status`/`plugin.yaml` references → the OpenCode doctor invocation).

- [ ] **Step 6.2: Preserve routing, sidecar-mediated writes, provenance cautions, OKF guidance** verbatim — those are harness-agnostic.

- [ ] **Step 6.3: Add `tests/test_skills_content.ts`** asserting, per skill: frontmatter parses, `name` equals the directory name and matches the regex, `description` length is 1–1024, no unrecognized frontmatter keys, and the routing-reminder key terms are present.

- [ ] **Step 6.4: Verify skill discovery end to end** by extending the Task 1 host test: copy the packaged `skills/` tree into the temporary `~/.config/opencode/skills/` exactly as `install.ts` would, and assert OpenCode lists all three in the `skill` tool description.

- [ ] **Step 6.5: Build and unpack the *release* archive into a temporary directory** outside the checkout. The shipped artifact is the one `release.yml` builds via `tools/ct_ci.py package`, driven by `integration.yaml`'s `package.include`/`exclude` — not `pnpm pack`, whose contents come from `package.json#files`. Verify both, and that they agree:

```sh
python tools/ct_ci.py package --tag "opencode-v<version>" --out <tmp>     # the release artifact
tar -xf <tmp>/opencode-v<version>.tar.gz -C <tmp>/unpacked
pnpm --dir integrations/opencode pack --pack-destination <tmp>            # the future npm artifact
```

- [ ] **Step 6.6: Verify the unpacked release archive contains `lib/` and `skills/`** — `lib/src/index.js`, `lib/scripts/ct_doctor.js`, `lib/scripts/install.js`, `scripts/install.sh`, and the three `skills/*/SKILL.md`. `test_build_output.ts` asserts the manifest-driven archive carries them (`package.exclude` must not drop `lib/`) and that `package.json#files` does not disagree with it.

- [ ] **Step 6.7: Verify the plugin loads from the unpacked archive** with **no `node_modules/` present at all** — this is the real user's situation, since the tarball ships none and OpenCode bun-installs only for npm plugins. Assert: `lib/src/index.js` imports nothing third-party, `node ./lib/scripts/ct_doctor.js check` runs (degrading only the pre-flight check when `better-sqlite3` is absent), and `node ./lib/scripts/install.js` runs its preview with `jsonc-parser` bundled in.

- [ ] **Step 6.8: Document in `README.md`:**
  - Install = download the `opencode-v<version>` release tarball, unpack, run `scripts/install.sh` (preview), then `CT_INSTALL_EDIT=1 scripts/install.sh`. No npm install; the package is not published yet.
  - What the installer touches: payload dir, `~/.config/opencode/plugins/curated-thoughts.js`, `~/.config/opencode/skills/curated-thoughts-*`, and the `mcp` entry in `opencode.json`.
  - That skills are installed as files — nothing registers them at runtime.
  - Uninstall = remove the loader file, the payload dir, the `mcp` entry, and `~/.config/opencode/skills/curated-thoughts-*`.
  - Optional `better-sqlite3` for `ct_preflight`.
  - The exact tested host versions from `tests/host/compatibility.json`.
  - The OpenCode non-affiliation notice, also referenced from the package `LICENSE` notice.

---

## Task 7: Manifest schema, repository CI, and release gates

**Files:**
- Modify: `shared/integration.schema.json` (add `checks.host`) — **own commit**
- Create: `integrations/opencode/integration.yaml`
- Create: `integrations/opencode/CHANGELOG.md`
- Modify: `README.md` (root — integration row)
- Modify: `.github/workflows/ci.yml` (Bun host contract job)
- Modify: `.github/workflows/release.yml` (release validation includes the host contract)
- Possibly modify: `tests/tools/*` where a fixed integration set is assumed

**Step-by-step:**

- [ ] **Step 7.1: Add `checks.host` to `shared/integration.schema.json`** (`{"type": "string"}` inside `checks.properties`). Do not add a `bun` matrix axis: `matrix` is `additionalProperties: false` *and* `tools/ct_ci_discover.py` expands only `python`/`node`, so the axis would be silently dropped. Commit this alone — `shared/` is in `SHARED_PREFIXES`, so it re-runs every integration's CI.

- [ ] **Step 7.2: Declare the integration manifest** — `integrations/opencode/integration.yaml` per spec §9: `language: node`, `requires_sidecar: ">=2.5"`, `compat_tier: v2.5-full`, `version_mirror: package.json#version`, OS matrix `ubuntu-latest`/`macos-latest`/`windows-latest` × Node `22.x`/`24.x`, `test: pnpm run build && pnpm run test`, `host:` check, `policy.allow_sqlite_readonly: scripts/ct_preflight.ts`, and `package.exclude` that **keeps `lib/` and `skills/`** (exclude only `**/dist/**` and `**/node_modules/**`). The release tarball this produces is the user-facing artifact — verify by installing from it, not from the checkout.

- [ ] **Step 7.3: Flip `status` to `implemented`** once the source from Tasks 2–6 is in place, then run `python tools/ct_ci.py generate` to emit `integrations/opencode/scripts/_compat_generated.ts` and commit it. Both `generate` and `discover` skip `status: planned`, so this ordering is load-bearing: a planned manifest produces no generated constants and no CI matrix entries. Verify with `python tools/ct_ci.py generate --check` and `python tools/ct_ci.py discover --all`.

- [ ] **Step 7.4: Sync the root README table** with `python tools/ct_ci.py readme`, then verify with `python tools/ct_ci.py readme --check`. Do not hand-edit the table — commits `fdb491f` and `cf28c4c` made it generated, and a manual rewrite that misses the synchronizer is flagged.

- [ ] **Step 7.5: Add the Bun host validation job to `ci.yml`** as a **standalone job**, not a matrix axis:
  - Install Bun and OpenCode at the versions in `tests/host/compatibility.json`.
  - `pnpm pack` the integration, then run the manifest's `checks.host` command against a fresh fixture location with temporary HOME / XDG.
  - Make `ci-ok` depend on this job.
  - Gate the job on the integration's files changing, consistent with how `discover` filters PRs.

- [ ] **Step 7.6: Update release validation** in `release.yml` to enforce the same host contract on tagged releases.

- [ ] **Step 7.7: Add tooling regression tests** in `tests/tools/` where existing assumptions exclude a new integration or the new schema key:
  - `ct_ci.py validate` accepts a manifest carrying `checks.host` and still rejects unknown keys.
  - `ct_ci_discover.select(..., all_=True)` includes `opencode` once its status is `implemented`.
  - `ct_ci_generate` emits the `.ts` constants for it.
  - `ct_ci.py package --tag opencode-v<version>` produces an archive matching the manifest, `lib/` included.

---

## Task 8: Final verification and review

**Step-by-step:**

- [ ] **Step 8.1: Run integration build, type checking, unit tests, and host tests:**
  ```sh
  cd integrations/opencode
  pnpm install
  pnpm run build
  pnpm exec tsc --noEmit
  pnpm run test
  bun test tests/host/contract.test.ts
  ```

- [ ] **Step 8.2: Run repository tooling tests** (the path CI uses):
  ```sh
  cd ../..
  python -m unittest discover -s tests/tools -v
  ```

- [ ] **Step 8.3: Run the manifest, generated-constant, README, and policy gates** — these are the actual `ct_ci.py` subcommands (`validate`, `generate`, `discover`, `policy`, `package`, `readme`); there is no `verify-integration`, `verify-readme`, or `release`:
  ```sh
  python tools/ct_ci.py validate
  python tools/ct_ci.py generate --check
  python tools/ct_ci.py readme --check
  python tools/ct_ci.py discover --all
  python tools/ct_ci.py policy
  ```

- [ ] **Step 8.4: Run release packaging, then install from the packaged artifact** — the tarball is the shipped thing, so verification runs against it, not the checkout:
  ```sh
  python tools/ct_ci.py package --tag "opencode-v$(node -p "require('./integrations/opencode/package.json').version")" --out dist
  pnpm --dir integrations/opencode pack
  ```

- [ ] **Step 8.5: Review the diff for:**
  - Unauthorized configuration mutation (no writes without `CT_INSTALL_EDIT=1`; comments preserved; no competing JSON file).
  - Sidecar spawning from the plugin path (forbidden — doctor check 3 is the only legitimate spawn).
  - Any residual invented host API (`ctx.system`, `ctx.skill`, `ctx.onMcpStatusChange`, `mcpServers`, `config.json`) — all wrong, and must not survive anywhere, including comments and docs.
  - Any npm-publish step, `npm install -g`, or edit to the `plugin` config array — all out of scope for v0's tarball delivery.
  - Any third-party import reachable from `lib/src/index.js`.
  - Cross-integration imports (forbidden).
  - Sensitive output (secrets, private paths, raw errors).
  - Host-version pinning completeness (every host test references `tests/host/compatibility.json`).

- [ ] **Step 8.6: Record exact tested host versions** in `CHANGELOG.md` and the integration `README.md`. Record any platform coverage that was not actually executed.

- [ ] **Step 8.7: Present results for review.** Do not claim unexecuted tests passed.

- [ ] **Step 8.8: Commit or open an implementation PR** only when:
  - All prior tasks are complete.
  - The spec-review gate is satisfied.
  - The user has explicitly authorized the commit / push / PR.

**Current status:** Documentation draft only. No implementation code, no commits. Host-API claims verified against `@opencode-ai/plugin` 1.18.31 and the OpenCode docs on 2026-09-17; Task 1 re-verifies against a real binary before implementation.

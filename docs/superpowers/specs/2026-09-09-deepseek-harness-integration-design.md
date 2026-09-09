# curated-thoughts-integrations — DeepSeek Harness/CT Plugin Design

Status: DESIGN — Owner: maintainer · Author: CT integrations team · Date: 2026-09-09

Siblings: [`spec-hermes-plugin-v0.md`](../spec-hermes-plugin-v0.md) (implemented reference),
[`2026-09-06-monorepo-ci-and-independent-versioning-design.md`](2026-09-06-monorepo-ci-and-independent-versioning-design.md)
(CI contract that this integration must conform to).

## 0. Summary

A new sibling integration that connects Curated Thoughts to the **DeepSeek
Harness** (`dsh`, `https://github.com/deepseek-ai/deepseek-harness`). Ships
the same four layers every integration provides — registration, health
checks, import pre-flight, skills — adapted to dsh's plugin-everything
architecture (Cordis). Axon currently does not shell out to `pnpm dsh`
(see [§10 Future use](#10-future-use--axon-adoption)); this spec is
written so that adoption is a downstream, low-risk swap when Axon is ready.

## 1. Purpose

Give a dsh session the same Curated Thoughts memory surface a Hermes session
already has: an MCP sidecar reachable through dsh's MCP client, a cached
health snapshot in the system prompt, a doctor for install verification,
import pre-flight that catches the curated-thoughts PR #188 hazard, and
three skills (`usage`, `ops`, `sidecar`) ported verbatim from Hermes.

Non-goals (v0):
- No CT core changes. No new MCP tools. No dsh upstream changes.
- No Axon adapter swap in this PR (see §10).
- No new public docs surface beyond this spec and the integration's own `README.md`.

## 2. Layout under `integrations/deepseek/`

```
integrations/deepseek/
├── integration.yaml              # CI contract: language=node, matrix, checks, policy
├── package.json                  # npm package metadata, exports, peerDependencies
├── README.md                     # install, doctor, release — mirror hermes/README.md
├── CHANGELOG.md                  # one ## <version> section per release
├── tsconfig.json                 # extends repo base; emits lib/ + dist/
├── src/
│   ├── index.ts                  # apply(ctx, config): wires MCP, prompt context, skills
│   ├── status.ts                 # fast probe (no MCP handshake, no DB open) — for the prompt context
│   └── format.ts                 # snapshot → compact text block (matches Hermes's context_section shape)
├── scripts/
│   ├── ct_doctor.ts              # 9-check deep verifier (compile target = lib/ct_doctor.js)
│   ├── ct_status.ts              # entrypoint shim → src/status.ts, invoked by the plugin
│   ├── ct_env.ts                 # brain dir / vault path / sidecar discovery (shared by status + doctor)
│   ├── ct_preflight.ts           # import pre-flight census — port of Hermes ct_preflight.py
│   ├── _compat_generated.ts      # generated from shared/compat.yaml by tools/ct_ci.py generate
│   └── install.sh                # POSIX bash, idempotent, prints unless CT_INSTALL_EDIT=1
├── skills/
│   ├── curated-thoughts-usage/SKILL.md
│   ├── curated-thoughts-ops/SKILL.md
│   └── curated-thoughts-sidecar/SKILL.md
├── hooks/
│   └── (empty — dsh has no shell-hook fallback path; the plugin is the only entry)
└── tests/
    ├── test_ct_doctor.ts         # mock-sidecar fixture suite (no live sidecar)
    ├── test_ct_status.ts
    └── test_install.sh           # bats-style or pure-shell test for install.sh idempotence
```

`src/`, `scripts/`, and `tests/` all import from `lib/` after compilation;
the npm `exports` map points `./doctor` at `lib/ct_doctor.js` so the plugin
module can spawn the doctor via `node` without depending on a build-time
`./scripts/ct_doctor.ts` path.

## 3. Plugin shape — what dsh loads

dsh's plugin model is **Cordis**: every contribution is a JS/TS module that
exports an `apply(ctx, config)` function, mounted via a list entry in
`cordis.yml` ([tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cordis-tutorial/01-first-plugin.md)).
This is the dsh analog of Hermes's `plugin.yaml` + `register(ctx)`.

`src/index.ts`:

```ts
import { Context, Schema } from 'cordis';

export interface Config {
  /** Brain directory. Defaults to ~/.brain, matching Curated Thoughts' own default. */
  brainDir?: string;
  /** Override the sidecar binary name (defaults to curated-thoughts-mcp). */
  sidecarCommand?: string;
}

export const Config: Schema<Config> = Schema.object({
  brainDir: Schema.string().default(process.env.CURATED_BRAIN_DIR ?? '~/.brain'),
  sidecarCommand: Schema.string().default('curated-thoughts-mcp'),
});

export function apply(ctx: Context, config: Config) {
  // (1) Mount the MCP client. dsh-mcp-client is a separate dsh plugin; mounting
  // it from inside our apply() is the cordis-native way to register a child
  // plugin with config. Same pattern as the documented mcp-memory overlays
  // (docs/user/guide/mcp-memory.md), but expressed in TS instead of YAML.
  ctx.plugin('@deepseek-ai/dsh-mcp-client', {
    serverName: 'curated-thoughts',
    transport: 'stdio',
    command: config.sidecarCommand,
    args: ['--mcp'],
    env: { CURATED_BRAIN_DIR: config.brainDir },
    cwd: process.cwd(),
  });

  // (2) Cached health snapshot. Empty until the first agent/session-start
  // handler resolves. Concurrent prompts observe the empty default; subsequent
  // prompts see the cached value until a new session starts.
  let cached: { text: string; since: number } | null = null;

  // (3) Dynamic prompt context (cache-safe per dsh docs/subsystems/system-prompt.md).
  // Empty first-call text means dsh logs nothing for the prompt; the
  // session-start handler fills the cache asynchronously.
  ctx.systemPrompt.context({
    order: ctx.systemPrompt.getContextOrder('curated-thoughts-health'),
    text: () => cached?.text ?? '',
  });

  // (4) Session-start refresh. agent/session-start fires after session/created,
  // agent/created, and the agent's setup (verified in
  // packages/core/agent-loop/README.md). MCP discovery may still be in flight
  // here — that's fine; the snapshot only describes the machine, not the
  // active MCP session, and ct_status never spawns the sidecar.
  ctx.on('agent/session-start', async () => {
    try {
      const { text } = await import('./format.js').then(m =>
        m.formatStatusBlock(await import('./status.js').then(s => s.probe()))
      );
      cached = { text, since: Date.now() };
    } catch {
      // Fail-open: a probe failure keeps the previous cached value or empty.
    }
  });

  // (5) Skills. dsh skills are kebab-case Markdown with frontmatter; the
  // three SKILL.md files are ported verbatim from Hermes — the content is
  // agent-generic and dsh reads the same Markdown. Each is registered via the
  // runtime skills provider, so dsh surfaces them in <available_skills>.
  // SKILL_DESCRIPTIONS maps each kebab-case name to its catalog summary;
  // extracted to a sibling const so the catalog message stays in one place
  // (the dsh catalog renders name + description only — bodies are not in
  // the catalog).
  for (const skill of SKILLS) {
    const path = new URL(`../skills/${skill}/SKILL.md`, import.meta.url);
    ctx.skills.register({
      name: skill,
      description: SKILL_DESCRIPTIONS[skill],
      content: await readFile(path, 'utf8'),
      invocation: { modelInvocable: true, userInvocable: true },
    });
  }
}
```

The two DSH-specific corrections vs an initial draft:

1. **`ctx.skills.register` takes a single object** (`SkillRegistration`),
   not positional arguments. Signature verified in
   `docs/subsystems/skills.md`.
2. **`agent/session-start` is the event name** — verified in
   `packages/core/agent-loop/README.md` and tests. A bare `session-start`
   does not exist in dsh.

## 4. `cordis.yml` integration (install path)

dsh's `cordis.yml` is a **list of entries** (no `plugins:` config block — that
syntax does not exist). The install.sh appends a single entry, scoped to
the user's $DSH_HOME:

```yaml
# Curated Thoughts integration (idempotent — install.sh detects + skips duplicates)
- name: '@equational-applications/dsh-curated-thoughts'
  config:
    brainDir: ~/.brain
```

`$DSH_HOME` resolves to `~/.dsh/` by default (per dsh `docs/subsystems/skills.md`,
"user-dsh" rank 400). For users who already have a per-profile
`$DSH_HOME/profiles/<name>/cordis.patch.yml`, install.sh prefers the profile
patch when one is named (`--profile <name>` flag) and falls back to the
global patch otherwise.

## 5. `ct_status.ts` — fast probe for the prompt context

Mirrors Hermes's `scripts/ct_status.py` (read its docstring — *"It never
spawns the sidecar — that costs an MCP handshake — and never opens the
brain database"*). This is what `apply(ctx)` calls inside the
`agent/session-start` handler.

Target latency: <200ms, same as Hermes.

Checks (each contributes one PASS/WARN/FAIL/UNKNOWN entry to the snapshot):
1. **Sidecar binary present** — `which curated-thoughts-mcp` or platform
   install location (matches Hermes's check 1, no dpkg assumption).
2. **Brain directory exists and readable** — resolves via `CURATED_BRAIN_DIR`
   / `CURATED_BRAIN_DB` / `CURATED_BRAIN_CONFIG` (the documented
   three-variable contract), default `~/.brain`.
3. **Config.json parses + `vault_path` resolves** — the same machine-specific
   import-time break that makes Hermes check 5 fail.

No MCP handshake. No `brain.db` open. Returns:

```ts
interface Snapshot {
  status: 'ok' | 'degraded' | 'unknown';
  sidecar: string | null;
  brainDir: string | null;
  vault: string | null;
  notes: string[];
}
```

`src/format.ts` converts this into the same compact block shape Hermes
injects (`## Curated Thoughts\nMemory sidecar ready (brain: …)`,
`… DEGRADED — CT tool calls may fail. Run ct_doctor.ts check for details.`,
plus the routing reminder). One source of truth, two harnesses.

## 6. `ct_doctor.ts` — 9-check deep verifier

Same nine checks as `integrations/hermes/scripts/ct_doctor.py`, ported
1:1 to TypeScript. Read-only; the architecture gate (`policy.allow_sqlite_readonly`)
still applies — `ct_preflight.ts` opens `brain.db` via `mode=ro` and issues
nothing but SELECT.

1. Sidecar binary (PATH + platform install locations).
2. Sidecar identity (installed vs dev-build; two servers on one brain is a bug).
3. Sidecar reachable (`tools/list` over MCP stdio; tool count → tier: 8 = v2.4-read, 14 = v2.5-full).
4. Brain directory (resolved as Curated Thoughts resolves it).
5. Vault (`vault_path` from `config.json` — the import-time break).
6. Embedding backend (env keys present, or OLLAMA_HOST responds).
7. **dsh registration** — checks that the `curated-thoughts` MCP server is mounted in the live dsh composition AND that `cordis.yml` lists `@equational-applications/dsh-curated-thoughts`. Two distinct checks because the MCP client may be mounted independently of the plugin (e.g., by an overlay patch).
8. Import pre-flight — engine version + source_ref census, mirroring `ct_preflight.py`.
9. Version compat — sidecar version vs `shared/compat.yaml`, with tool-count as the authoritative signal (mirroring the Hermes heuristic).

Exit code: 0 = all PASS, 1 = any FAIL, 2 = WARN-only (CI-usable, same
convention as Hermes).

`scripts/ct_preflight.ts` is a port of `hermes/scripts/ct_preflight.py` —
the curated-thoughts PR #188 logic (engine-proof source_ref tokens,
evidence table census, partial-export detection) is harness-agnostic
and the two ports must stay **logically identical**: same SQL, same
classification, same recovery hints. Drift between the two is a CI
gate, not a doc rule.

## 7. `install.sh` — idempotent, no sudo

Mirrors `integrations/hermes/scripts/install.sh` discipline:

- **`npm install -g @equational-applications/dsh-curated-thoughts`** (or
  local path during dogfood).
- **Append one entry to `$DSH_HOME/cordis.yml`** only if absent.
  Scope-aware — the entry must be a list item at top level, not nested
  inside another section. Refuses to write multi-document YAML or
  YAML containing tabs (block-scalar risk).
- **`CT_INSTALL_EDIT=1`** opt-in: print by default, append only when
  the user consents. Never overwrites an existing entry.
- **Prune build junk** in the install destination (`__pycache__` analog
  is `dist/` artifacts; `tools/ct_ci.py` owns this).
- **Run `ct_doctor.ts` at the end** as the verification step.

POSIX bash, no Node-specific shell features. Shellcheck-clean.
Process-matching uses the same path-anchored full-command-line pattern as
the Hermes install.sh ([`docs/process-matching.md`](../../process-matching.md)):

```bash
pgrep -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'
```

## 8. Skills (verbatim port)

The three `SKILL.md` files are ported **verbatim** from
`integrations/hermes/skills/curated-thoughts-{usage,ops,sidecar}/SKILL.md`:

- The Markdown body is harness-agnostic — model-facing guidance on tool
  routing, write paths, OKF frontmatter, sidecar lifecycle.
- dsh's skill frontmatter accepts the same `name:` / `description:` keys
  Hermes uses. Optional dsh-specific keys (`disable-model-invocation`,
  `user-invocable`) default to `true` when omitted — same effective
  behavior as Hermes's plugin namespace.

Single source of truth across integrations. If the routing reminder
changes, the change is in three files, all reviewed in one PR (or a
scripted sync if divergence ever becomes a problem — not yet warranted).

## 9. CI matrix

`integration.yaml`:

```yaml
id: deepseek
name: Curated Thoughts for DeepSeek Harness
version: 0.1.0
language: node
status: planned
requires_sidecar: ">=2.5"
compat_tier: v2.5-full
version_mirror: package.json#version

matrix:
  # dsh requires Node 22.19+ or >=24 (per dsh AGENTS.md). Match the
  # oldest-supported + current pair, mirroring how Hermes pins python 3.9/3.13.
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: ["22.19", "24.x"]

checks:
  test: pnpm run test
  lint: pnpm exec tsc --noEmit && pnpm exec eslint src scripts tests
  shell:
    - scripts/install.sh   # verify-only path: prints the appended block

policy:
  allow_sqlite_readonly:
    - scripts/ct_preflight.ts

package:
  include: ["**"]
  exclude:
    - "**/dist/**"
    - "**/lib/**"
    - "**/node_modules/**"
```

`language: node` is already in the schema's enum
([`shared/integration.schema.json`](../../../shared/integration.schema.json)).
`pnpm` because dsh is a pnpm workspace and the npm package mirrors its
peer-dependency shape.

## 10. Future use — Axon adoption

Axon's `runtime/src/harness/adapter.ts` currently POSTs to
`/chat/completions` on an OpenAI-compatible endpoint directly. `HARNESS_VERSION
= 'deepseek-harness-0.1'` is a label, not a binding; the worker never shells
out to `pnpm dsh`. Axon's principle D3 (*"DeepSeek Harness is the runtime on
every node"*) is aspirational.

Adoption in Axon is therefore a **separate downstream task** that this spec
does not block. The shape that will work when it happens:

- The worker spawns `pnpm dsh --profile headless "<job goal>"` with
  `DEEPSEEK_API_KEY` and `CURATED_BRAIN_DIR` in the allowlisted env
  (Axon's `harness/child-env.ts` already scrubs and merges).
- `cordis.yml` lists `@equational-applications/dsh-curated-thoughts`
  with `brainDir` pointing at the worker's own `~/.brain` (one worker
  has its own).
- The skill catalog survives — dsh resolves `curated-thoughts-usage`
  from the plugin regardless of profile.

If Axon's adoption surfaces integration issues — e.g., the MCP client
inside a headless profile behaves differently from inside `web` — those
become follow-ups on this integration's `CHANGELOG.md`, not rework.

## 11. Decisions (locked)

- **Delivery shape**: Cordis plugin npm package
  (`@equational-applications/dsh-curated-thoughts`). Plugin module exports
  `apply(ctx, config)`, mounts `@deepseek-ai/dsh-mcp-client` for the MCP
  surface, registers a dynamic `PromptContext` for the cached health
  snapshot, registers three skills, subscribes `agent/session-start`.
- **Doctor language**: TypeScript. DSH already requires Node, so paying
  the runtime cost buys type-sharing with the plugin module and a single
  toolchain (`pnpm exec tsc` → `node lib/ct_doctor.js`).
- **Snapshot strategy**: lazy — `text: () => cached?.text ?? ''`,
  refreshed by an async `agent/session-start` handler. The MCP discovery
  race (per `docs/user/guide/mcp-memory.md`) is irrelevant because
  `ct_status.ts` does not spawn the sidecar.
- **Sidecar binary name**: `curated-thoughts-mcp` with `--mcp` flag.
  Same name Hermes registers. No second binary.
- **Skill shape**: same three as Hermes, ported verbatim.
- **Axon**: future consumer only. This spec is compatible with the
  adoption path but does not include it.

## 12. Open items (deferred to writing-plans)

- Exact `cordis.yml` install.sh append block format (mirror Hermes's
  `config_is_appendable` checks; tabs and multi-document YAML rejection).
- Test harness for `ct_doctor.ts` — vitest? the existing repo uses
  `python -m unittest` for Hermes; this is the first node integration.
- Whether to publish the npm package to a public registry on release or
  keep it GitHub-tarball-only (matches the repo's current per-integration
  tarball release).
- License: MIT (matches the repo and Hermes). To be re-confirmed at PR time.

## 13. Implementation checklist (follow-up PRs)

- [ ] Repo scaffolding: `integrations/deepseek/` skeleton,
      `integration.yaml` (status: planned), `README.md`, `CHANGELOG.md`.
- [ ] `src/index.ts` (apply + dynamic prompt context + skill registration).
- [ ] `scripts/ct_status.ts` + `src/status.ts` + `src/format.ts`.
- [ ] `scripts/ct_doctor.ts` + `scripts/ct_env.ts` + `scripts/ct_preflight.ts`.
- [ ] `scripts/install.sh` (idempotent, opt-in edit).
- [ ] Three SKILL.md files ported from Hermes.
- [ ] `tests/test_ct_doctor.ts` (mock-sidecar fixture suite) +
      `tests/test_install.sh` (idempotence).
- [ ] CI matrix wired through `tools/ct_ci.py discover`.
- [ ] Dogfood: install on the maintainer machine, retire bespoke bits,
      record findings.
- [ ] Tag `deepseek-v0.1.0` → release tarball via `release.yml`.
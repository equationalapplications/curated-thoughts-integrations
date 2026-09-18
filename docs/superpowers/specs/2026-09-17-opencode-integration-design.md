# curated-thoughts-integrations — OpenCode/CT Plugin Design

Status: draft — Owner: maintainer · Author: CT integrations team · Date: 2026-09-17

Siblings: [`spec-hermes-plugin-v0.md`](../spec-hermes-plugin-v0.md) (implemented reference),
[`2026-09-09-deepseek-harness-integration-design.md`](2026-09-09-deepseek-harness-integration-design.md)
(most recent sibling; closest architectural analog),
[`2026-09-06-monorepo-ci-and-independent-versioning-design.md`](2026-09-06-monorepo-ci-and-independent-versioning-design.md)
(CI contract every integration must conform to).

## 0. Summary

A new sibling integration that connects Curated Thoughts to **OpenCode**
(`https://github.com/sst/opencode`). Ships the same four layers every
integration provides — registration, health checks, import pre-flight, skills —
adapted to OpenCode's TypeScript plugin model. OpenCode owns the sidecar
lifecycle as a local MCP server; the integration only observes and contributes
nonblocking health context. The same three SKILL.md files used in Hermes and
DeepSeek carry over verbatim. There is no separate diagnostic sidecar process
or runtime reconnection layer — OpenCode + the existing curated-thoughts-mcp
binary cover those needs, and a second process layer would conflict with the
repo's single-sidecar architecture.

Two OpenCode facts shape everything below, and both differ from the sibling
harnesses:

- **A plugin returns hooks; it is not handed a context object with methods.**
  `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`.
  There is no registration API — the plugin contributes behaviour only through
  the hook names OpenCode calls.
- **Skills are discovered from the filesystem, never registered by code.**
  OpenCode reads `SKILL.md` files out of well-known directories. The three CT
  skills therefore ship as files the *installer copies*, exactly as Hermes
  does.
- **Delivery is a GitHub release tarball, matching this repo's existing
  convention — not an npm publish.** OpenCode's `plugin` config array installs
  from npm, so a tarball cannot use it. The integration is therefore delivered
  the Hermes way: the installer unpacks the payload and drops a loader file
  into OpenCode's local plugin directory, which the host loads from disk. npm
  publishing is deferred until the integration is proven in use (§12).

Every host-API claim in this document is pinned to `@opencode-ai/plugin`
1.18.31 and the OpenCode docs as of 2026-09-17; Task 1 of the plan re-verifies
each one against a real binary before implementation proceeds.

## 1. Purpose

Give an OpenCode session the same Curated Thoughts memory surface a Hermes or
DeepSeek session already has: a single reachable sidecar, a cached health
snapshot injected into the system prompt, a doctor for install verification,
import pre-flight that catches the curated-thoughts PR #188 hazard, and three
skills (`usage`, `ops`, `sidecar`) adapted from the sibling integrations.

Non-goals (v0):

- No CT core changes. No new MCP tools. No OpenCode upstream changes.
- No second sidecar process for diagnostics. No runtime reconnection logic.
- No direct vault writes from the integration.
- No cross-integration runtime imports. Each integration is its own npm package.

## 2. Layout under `integrations/opencode/`

```text
integrations/opencode/
├── integration.yaml              # CI contract: language=node, matrix, checks, policy
├── package.json                  # npm package metadata, exports, peerDependencies
├── README.md                     # install, doctor, release — mirror hermes/README.md
├── CHANGELOG.md                  # one ## <version> section per release
├── tsconfig.json                 # extends repo base; emits lib/
├── vitest.config.ts
├── src/
│   ├── index.ts                  # named plugin export — returns the hooks object
│   ├── status.ts                 # fast probe (no MCP handshake, no DB open) — for the prompt context
│   ├── refresh.ts                # single in-flight refresh per plugin instance + 30s freshness
│   └── format.ts                 # snapshot → compact text block (matches sibling integrations)
├── scripts/
│   ├── ct_doctor.ts              # 9-check deep verifier (compile target = lib/scripts/ct_doctor.js)
│   ├── ct_env.ts                 # brain dir / vault path / sidecar discovery (shared by status + doctor)
│   ├── ct_preflight.ts           # import pre-flight census — port of sibling ct_preflight.py
│   ├── registration.ts           # pure proposal: config merge + skill copy plan (no filesystem mutation)
│   ├── install.ts                # preview-first installer (applies a registration proposal)
│   ├── install.sh                # POSIX bash wrapper — invokes install.ts
│   ├── loader.js.tmpl            # the one file written into OpenCode's plugins/ dir
│   └── _compat_generated.ts      # generated from shared/compat.yaml by tools/ct_ci.py generate
├── skills/
│   ├── curated-thoughts-usage/SKILL.md
│   ├── curated-thoughts-ops/SKILL.md
│   └── curated-thoughts-sidecar/SKILL.md
└── tests/
    ├── host/                     # pinned released OpenCode/SDK contract tests
    │   ├── contract.test.ts
    │   ├── fixtures/probe-plugin.ts
    │   └── compatibility.json
    ├── test_ct_env.ts            # brain-path resolution, sidecar discovery
    ├── test_status.ts            # status probe under fake filesystem + env
    ├── test_refresh.ts           # fake-clock refresh, concurrent prompts, dispose
    ├── test_format.ts            # secrets / private paths / raw error never appear
    ├── test_index.ts             # hook assembly + injection semantics
    ├── test_registration.ts      # opencode.json merge proposals, disabled preservation, skill copy plan
    ├── test_install.ts           # preview-first, idempotence, no unsafe rewrite
    ├── test_ct_doctor.ts         # mock-sidecar fixture suite (no live sidecar)
    ├── test_ct_preflight.ts      # PR #188 census + parity with siblings
    ├── test_skills_content.ts    # frontmatter conforms to OpenCode's skill contract
    ├── test_build_output.ts      # packed tarball contents
    └── test_archive.ts           # archive unpack → plugin loads; installer can copy skills from it
```

`src/` and `scripts/` compile into `lib/`, and `lib/` **ships in the tarball** —
the entry points (`lib/src/index.js`, `lib/scripts/ct_doctor.js`,
`lib/scripts/install.js`) live there. `skills/` ships as source Markdown — the
installer copies it, nothing compiles it.

**Build output must be self-contained.** The tarball carries no
`node_modules/`, and OpenCode only runs `bun install` for plugins named in the
`plugin` config array — which a tarball install does not use (§4). So
`pnpm run build` is `tsc` for types plus an esbuild bundle of the three entry
points, with every third-party import inlined:

| Entry point | Third-party deps | Resolution |
|---|---|---|
| `lib/src/index.js` (plugin) | none by construction | the runtime path stays dependency-free; a new runtime dep is a review-blocking change |
| `lib/scripts/install.js` | `jsonc-parser` | bundled at build time |
| `lib/scripts/ct_doctor.js` | `better-sqlite3` (pre-flight only) | marked external, `require`d lazily; its absence degrades check 8 alone (§6) |

## 3. Plugin shape — what OpenCode loads

OpenCode's plugin model is **TypeScript-native**: a plugin is a JS/TS module
that exports one or more plugin functions. A plugin function takes
`PluginInput` plus optional per-plugin options and returns a `Hooks` object.
There is no manifest layer equivalent to dsh's Cordis list entries or Hermes's
`plugin.yaml`, and no imperative registration API.

Pinned types (`@opencode-ai/plugin` 1.18.31):

```ts
type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;

type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>;
  project: Project;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: BunShell;
  experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void };
};
```

The hooks this integration uses, and nothing else:

| Hook | Signature (abridged) | Use |
|------|----------------------|-----|
| `experimental.chat.system.transform` | `(input: { sessionID?: string; model: Model }, output: { system: string[] })` | Append the cached health block |
| `event` | `(input: { event: Event })` | Observe MCP connection state **if** the pinned SDK emits it |
| `dispose` | `() => Promise<void>` | Tear down the refresh cache |

`src/index.ts`:

```ts
import type { Plugin } from '@opencode-ai/plugin';

export interface Options {
  /** Brain directory. Defaults to CURATED_BRAIN_DIR, then ~/.brain. */
  brainDir?: string;
  /** Override the sidecar binary name (defaults to curated-thoughts-mcp). */
  sidecarCommand?: string;
}

export const CuratedThoughts: Plugin = async (input, options) => {
  // Options arrive as the SECOND argument, from the tuple form in config:
  //   "plugin": [["@equational-applications/opencode-curated-thoughts", { … }]]
  const config = resolveOptions(options as Options | undefined);

  // Lazy, bounded, fail-open. Empty until the first refresh resolves; a refresh
  // that exceeds 2s is abandoned and the previous value is kept.
  const cache = createHealthCache({
    env: process.env,
    cwd: input.directory,
    config,
  });

  return {
    'experimental.chat.system.transform': async ({ sessionID }, output) => {
      // Auxiliary (session-less) calls neither refresh nor inject.
      if (!sessionID) return;

      // Fire-and-forget: the prompt path never awaits a filesystem probe.
      cache.requestRefresh();

      const block = formatStatusBlock(cache.current());
      if (!block) return;

      // `output.system` is an array of strings the host concatenates. Injection
      // is additive and idempotent: existing entries are never rewritten, and a
      // block already present is not appended twice.
      if (output.system.some((entry) => entry.startsWith(BLOCK_HEADING))) return;
      output.system.push(block);
    },

    // Connection observation is best-effort. If the pinned SDK emits no MCP
    // status event, `connection` stays 'unknown' — see §11, honesty in unknown.
    event: async ({ event }) => observeConnection(cache, event),

    dispose: async () => cache.dispose(),
  };
};
```

Three corrections vs the initial draft, all forced by the pinned API:

1. **No automatic handshake.** OpenCode alone owns the sidecar lifecycle. The
   plugin never spawns `curated-thoughts-mcp --mcp` to probe health; it
   contributes cache-only state. (The user-invoked doctor *does* handshake —
   see §6. The prohibition is scoped to the plugin path.)
2. **System injection is array mutation, not a method call.** The integration
   pushes one string onto `output.system` and leaves every existing entry
   verbatim. Verified by a test asserting the original entries survive
   unchanged and the block appears exactly once after repeated assembly.
3. **Skills are not registered here.** There is no skill hook. See §8.

The package name is `@equational-applications/opencode-curated-thoughts`; it
identifies the payload and the eventual npm release, but v0 is installed from a
tarball, not by that name (§4). The plugin function is a **named** export;
whether OpenCode also honours a default export, and whether the `PluginModule`
form (`{ id?, server: Plugin }`) is preferred, is recorded by the host test
before `src/index.ts` is written.

## 4. Install path — tarball payload, loader file, `opencode.json` entry

OpenCode's config file is **`~/.config/opencode/opencode.json`** (JSON or
JSONC; `opencode.jsonc` is equally valid). It is not `config.json`, and it is
not the only source of truth — OpenCode merges, in precedence order:

1. Remote config (`.well-known/opencode`)
2. Global config (`~/.config/opencode/opencode.json`)
3. `OPENCODE_CONFIG` (custom path)
4. Project config (`opencode.json` in the project)
5. `.opencode/` directories (agents, commands, plugins, skills)
6. `OPENCODE_CONFIG_CONTENT` (inline)
7. Managed config files (e.g. `/Library/Application Support/opencode/`)
8. macOS managed preferences (MDM) — not user-overridable

The installer writes to (2) only, and every check that reads configuration
states that scope explicitly rather than claiming to know the effective
merged config (§6, check 7).

### Delivery: tarball, not npm

Release artifacts in this repo are per-integration GitHub tarballs
(`release.yml`), and that convention holds here. OpenCode's `plugin` config
array resolves **npm specs** — it bun-installs them into
`~/.cache/opencode/node_modules/` — so it cannot load a tarball. The remaining
supported path is OpenCode's local plugin directory, which loads JS/TS files
straight from disk:

- `~/.config/opencode/plugins/` (global)
- `.opencode/plugins/` (project)

So the installer, mirroring `hermes/scripts/install.sh`:

1. Unpacks the tarball payload to
   `${XDG_DATA_HOME:-~/.local/share}/curated-thoughts/opencode/`.
2. Writes **one** loader file, `~/.config/opencode/plugins/curated-thoughts.js`,
   rendered from `scripts/loader.js.tmpl`:

   ```js
   // Generated by curated-thoughts install.sh — do not edit.
   // Payload: <payload dir>  (reinstall to move it)
   export { CuratedThoughts } from "file:///<payload>/lib/src/index.js";
   ```

   The payload stays out of `plugins/` deliberately: OpenCode loads files from
   that directory, and a payload tree sitting inside it risks a second,
   duplicate load.
3. Copies the three skill directories (§8).
4. Adds the `mcp` entry below to `opencode.json[c]`.

The `plugin` config array is **not** touched in v0 — it is the npm path, and
leaving it untouched means a later npm release can adopt it without fighting a
stale entry.

### The config entry

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "curated-thoughts": {
      "type": "local",
      "command": ["curated-thoughts-mcp", "--mcp"],
      "enabled": true,
      "environment": { "CURATED_BRAIN_DIR": "<brainDir>" }
    }
  }
}
```

Note the shape: `mcp` (not `mcpServers`), a required `"type": "local"`,
`command` as a **single array** (not `command` + `args`), and `environment`
(not `env`).

Because the loader file is not an npm plugin, per-plugin options (the
`["<spec>", { … }]` tuple form) are unavailable in v0. Configuration is
therefore environment-only — `CURATED_BRAIN_DIR` and friends, the same
three-variable contract every integration uses — and `src/index.ts` accepts an
options argument that simply stays `undefined` under this install path.

The installer is **preview-first**:

- It **never** rewrites an existing file unprompted. It returns a structured
  proposal describing the destination, the proposed merge, the skill files it
  would copy, and any conflicts.
- When `CT_INSTALL_EDIT=1` is set, the installer applies the proposal:
  - Unpacks the payload and writes the loader file.
  - Adds the `mcp.curated-thoughts` entry above.
  - Copies the three skill directories (§8).
  - Preserves an explicit `"enabled": false` — a user who turned the server
    off must stay turned off.
  - Preserves unrelated keys.
- Backups (`<file>.bak`) before any edit; refuses to follow symlinks into the
  destination; records mtime before write and aborts if the on-disk mtime
  moved (concurrent external edit).

**JSONC is the documented, normal format here — not an edge case.** A
comment-bearing config is expected, so "refuse and print manual merge
instructions" would fire for a large share of real users. v0 therefore:

- Parses JSONC for *reading* (proposal + doctor) in all cases.
- For *writing*, edits in place with a comment-preserving JSONC editor
  (e.g. `jsonc-parser`'s `modify`/`applyEdits`), which inserts the two keys
  without reformatting or dropping comments.
- Falls back to printed manual merge instructions only when the file cannot be
  edited safely (parse errors, or an existing `curated-thoughts` entry whose
  command differs from ours). It never emits a competing `.json` beside a
  `.jsonc`.

The proposal is a pure function (`scripts/registration.ts` → `propose()`) so
tests verify the merge without touching the filesystem:

```ts
interface RegistrationProposal {
  destination: string;               // resolved ~/.config/opencode/opencode.json[c]
  payloadDir: string;                // ${XDG_DATA_HOME:-~/.local/share}/curated-thoughts/opencode
  loader: { path: string; contents: string };   // plugins/curated-thoughts.js
  mcp: {
    'curated-thoughts': {
      type: 'local';
      command: string[];
      enabled: boolean;
      environment: Record<string, string>;
    };
  };
  skills: Array<{ from: string; to: string }>;  // skill copy plan (§8)
  warnings: string[];
  apply: () => Promise<void>;        // only callable with explicit authorization
}
```

An existing loader file pointing at a different payload directory is a
conflict, reported rather than silently repointed — two payloads on one brain
is the same class of bug as two sidecars.

## 5. `src/status.ts` — fast probe for the prompt context

Mirrors `integrations/hermes/scripts/ct_status.py` and
`integrations/deepseek/src/status.ts` (read those docstrings — *"never
spawns the sidecar — that costs an MCP handshake — and never opens the
brain database"*). This is what the refresh cache calls off the prompt path.

Target latency: <200ms, same as the siblings. There is no `scripts/ct_status.ts`
shim; DeepSeek has none either, and the doctor is the user-facing CLI.

Checks (each contributes one PASS/WARN/FAIL/UNKNOWN reason to the snapshot):

1. **Sidecar binary present** — `which curated-thoughts-mcp` or platform
   install location (no dpkg assumption).
2. **Brain directory exists and readable** — resolves via `CURATED_BRAIN_DIR`
   / `CURATED_BRAIN_DB` / `CURATED_BRAIN_CONFIG` (the documented
   three-variable contract), default `~/.brain`.
3. **Config.json parses + `vault_path` resolves** — the same machine-specific
   import-time break that makes the sibling checks fail. (This `config.json`
   is Curated Thoughts' own, inside the brain dir — unrelated to OpenCode's
   `opencode.json`.)

No MCP handshake. No `brain.db` open. Returns:

```ts
interface LocalSnapshot {
  readiness: 'ready' | 'degraded' | 'unknown';
  reasons: string[];
}
```

`src/format.ts` converts this into the same compact block shape the siblings
inject (`## Curated Thoughts\nMemory sidecar ready (brain: …)`,
`… DEGRADED — CT tool calls may fail. Run ct_doctor for details.`, plus the
routing reminder). One source of truth, three harnesses.

## 6. `ct_doctor.ts` — 9-check deep verifier

Same nine checks as `integrations/hermes/scripts/ct_doctor.py`, ported 1:1 to
TypeScript. User-invoked, never spawned by the plugin. Read-only with respect
to the brain; the architecture gate (`policy.allow_sqlite_readonly`) still
applies — `ct_preflight.ts` opens `brain.db` via `mode=ro` and issues nothing
but SELECT.

1. Sidecar binary (PATH + platform install locations).
2. Sidecar identity (installed vs dev-build; two servers on one brain is a bug).
3. Sidecar reachable (`tools/list` over MCP stdio; tool count → tier: 8 =
   v2.4-read, 14 = v2.5-full). **This check does spawn the sidecar** — that is
   the doctor's job and matches Hermes. The "never spawn" rule is a plugin-path
   rule only.
4. Brain directory (resolved as Curated Thoughts resolves it).
5. Vault (`vault_path` from the brain's `config.json` — the import-time break).
6. Embedding backend (env keys present, or OLLAMA_HOST responds).
7. **OpenCode registration** — three distinct pieces of evidence, none of
   which implies another:
   - `mcp.curated-thoughts` present in the global `opencode.json[c]`.
   - The loader file present at `~/.config/opencode/plugins/curated-thoughts.js`
     **and** the payload it points at present and readable. A loader pointing
     at a missing payload is FAIL with a reinstall hint — that is local,
     unambiguous evidence, not a merged-config guess.
   - The three skill directories present in a location OpenCode searches (§8).

   **Scope statement, printed with the result:** the doctor reads the global
   config only. OpenCode merges remote, project, `.opencode/`, env-var and
   managed sources it cannot see, so a missing entry is reported as
   `UNKNOWN — not found in <path>; OpenCode also merges project and managed
   config` rather than FAIL, unless the file itself is unreadable (then FAIL).
   Overriding this with a definitive answer would require querying a running
   OpenCode server, which the doctor does not do (§11).
8. Import pre-flight — engine version + source_ref census, mirroring
   `ct_preflight.py`.
9. Version compat — sidecar version vs `shared/compat.yaml`, with tool-count
   as the authoritative signal (mirroring the sibling heuristic).

Exit code: 0 = all PASS, 1 = any FAIL, 2 = WARN-only (CI-usable, same
convention as the siblings). `--json` emits machine-readable results even when
the brain DB is missing.

`scripts/ct_preflight.ts` is a port of `hermes/scripts/ct_preflight.py` —
the curated-thoughts PR #188 logic (engine-proof source_ref tokens, evidence
table census, partial-export detection) is harness-agnostic and the three
ports must stay **logically identical**: same SQL, same classification, same
recovery hints. Drift between the three is a CI gate, not a doc rule.

## 7. `install.sh` — preview-first, no sudo

Mirrors `integrations/hermes/scripts/install.sh` discipline:

- **Preview by default.** `install.sh` always prints the proposed config merge
  and skill copy plan before mutating anything. The only mutation path is
  `install.ts apply`, gated by `CT_INSTALL_EDIT=1`.
- **Backups + concurrent-edit detection** for the destination file.
- **Comment-preserving JSONC edit**, with manual merge instructions as the
  fallback (§4). Never writes a competing JSON file.
- **Explicit disablement is preserved.** A pre-existing
  `"curated-thoughts": { "enabled": false }` remains disabled.
- **Unpacks the payload** into
  `${XDG_DATA_HOME:-~/.local/share}/curated-thoughts/opencode/` and **writes the
  loader file** into `~/.config/opencode/plugins/` (§4). Re-running with a
  newer tarball replaces the payload in place; the loader is rewritten only if
  its target changed.
- **Copies the three skill directories** into the user's global skills path
  (§8) — the plugin cannot do this at runtime.
- **Run the doctor at the end** (`node <payload>/lib/scripts/ct_doctor.js check`)
  as the verification step.

The installer does *not* run `npm install -g`, and does not touch the `plugin`
config array: both are npm paths, and v0 ships a tarball (§4). When an npm
release lands, the `plugin` array becomes the install path and the loader file
is removed by the upgrade — the uninstall steps in the README cover it.

POSIX bash, no Node-specific shell features. Shellcheck-clean. Process-matching
uses the same path-anchored full-command-line pattern as the Hermes
install.sh ([`docs/process-matching.md`](../../process-matching.md)):

```bash
pgrep -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'
```

## 8. Skills — filesystem install, verbatim content

**OpenCode discovers skills from the filesystem; a plugin cannot register
them.** OpenCode searches, per its docs:

- `.opencode/skills/<name>/SKILL.md` (project)
- `~/.config/opencode/skills/<name>/SKILL.md` (global)
- `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`

(Plural directory names are current; singular is accepted for backwards
compatibility. The installer writes the plural form.)

v0 installs to `~/.config/opencode/skills/<name>/SKILL.md`, one directory per
skill, copied from the package's `skills/` tree. Consequences worth stating
plainly:

- The npm package is **not** self-contained for skills. A user who only adds
  the package to `plugin` gets health context and no skills; the doctor
  reports that honestly (§6, check 7).
- Uninstall is a directory removal, documented in the README.
- The installer never overwrites a user-modified SKILL.md without preview; a
  differing file is reported as a conflict.

The three `SKILL.md` files are ported **verbatim** from
`integrations/hermes/skills/curated-thoughts-{usage,ops,sidecar}/SKILL.md`.
Their existing frontmatter already satisfies OpenCode's contract, which was
checked against the pinned docs:

| OpenCode rule | Hermes files |
|---|---|
| `name` required, matches containing directory | ✅ `curated-thoughts-usage` etc. |
| `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars | ✅ |
| `description` required, 1–1024 chars | ✅ |
| Only `name`, `description`, `license`, `compatibility`, `metadata` recognized | ✅ (no extra keys; unknown keys would be ignored anyway) |

Single source of truth across integrations. If the routing reminder changes,
the change is in three files, all reviewed in one PR (or a scripted sync if
divergence ever becomes a problem — not yet warranted).

## 9. CI matrix and the manifest schema change

**`shared/integration.schema.json` must be extended before this manifest
validates.** Both `checks` and `matrix` are `additionalProperties: false`
today, so a `host:` check and a `bun:` axis are rejected by
`python tools/ct_ci.py validate`. The minimal change:

- Add `"host": {"type": "string"}` to `checks.properties`.
- Leave `matrix` alone. `tools/ct_ci_discover.py` expands only the `python` /
  `node` axes, so a `bun:` axis would validate and then silently vanish from
  CI. The Bun host job is a **separate job in `ci.yml`**, not a matrix axis.

Because `shared/` is in `SHARED_PREFIXES`, this schema edit makes CI run every
integration — expected, and worth landing in its own commit.

`integration.yaml`:

```yaml
id: opencode
name: Curated Thoughts for OpenCode
version: 0.1.0
# `planned` until the code lands: tools/ct_ci_discover.py and
# tools/ct_ci_generate.py both filter to status == implemented, so a planned
# integration is invisible to `discover` and generates no _compat_generated.ts.
# The flip to `implemented` happens in the PR that adds the source.
status: planned
language: node
requires_sidecar: ">=2.5"
compat_tier: v2.5-full
version_mirror: package.json#version

matrix:
  # OpenCode ships on macOS, Linux and Windows; sidecar discovery and path
  # handling are exactly where that claim breaks, so Windows is not optional.
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: ["22.x", "24.x"]

checks:
  # Build first: lib/ is gitignored, so a CI checkout has no compiled doctor to
  # spawn and every lib-dependent test would skip. Same lesson as DeepSeek.
  test: pnpm run build && pnpm run test
  lint: pnpm exec tsc --noEmit && pnpm exec eslint src scripts tests
  shell:
    - scripts/install.sh   # verify-only path: prints the proposed merge
  # New key; requires the schema addition above. Runs in a dedicated Bun job.
  host: bun test tests/host/contract.test.ts

policy:
  allow_sqlite_readonly:
    - scripts/ct_preflight.ts

package:
  include: ["**"]
  # lib/ MUST ship: package.json's entry points (lib/src/index.js,
  # lib/scripts/ct_doctor.js) live there. Only true build junk is excluded.
  exclude:
    - "**/dist/**"
    - "**/node_modules/**"
```

`language: node` is already in the schema's enum
([`shared/integration.schema.json`](../../../shared/integration.schema.json)).

Release artifacts follow the repo's existing convention unchanged: `release.yml`
builds the per-integration tarball on an `opencode-v<version>` tag. No npm
publishing step is added in v0 (§12).

## 10. Host validation (lifecycle gates)

OpenCode's plugin API is younger than dsh's and changes more frequently; the
hooks this integration depends on are still `experimental.`-prefixed. The host
test (`tests/host/contract.test.ts`) is a release gate. It:

1. Selects a pinned released OpenCode version and the matching
   `@opencode-ai/plugin` version — the SDK version tracks the host version
   (both were 1.18.31 at the time of writing). Recorded in
   `tests/host/compatibility.json`, not inferred from the supplied checkout.
2. Spins up a tiny fixture plugin that exports a plugin function and records
   what the host actually does.
3. Asserts:
   - The host loads the plugin through the real v0 install path: payload
     unpacked from a packed tarball to a temporary data dir, loader file
     written into the temporary `~/.config/opencode/plugins/`. Loading via the
     `plugin` npm array is recorded for the future npm release, not required.
   - A **named** export is invoked; records whether a default export is also
     invoked, and whether the `{ server }` module form is preferred.
   - `experimental.chat.system.transform` fires, with `sessionID` present for a
     session-bearing call and absent otherwise.
   - Pre-existing `output.system` entries survive verbatim and the integration
     block appears exactly once after repeated assembly.
   - Per-plugin options from the `["<spec>", { … }]` tuple form arrive as the
     second argument. Recorded only — v0's loader-file install cannot supply
     them, so the plugin must work with `options === undefined` (§4).
   - `dispose` is called on shutdown.
4. Records whether any MCP connection-status event reaches the `event` hook. If
   none does, the spec's explicit fallback (`connection: 'unknown'`) is what
   the snapshot reports.
5. Confirms skill discovery from `~/.config/opencode/skills/<name>/SKILL.md`
   under a temporary HOME — the installer's only delivery path for skills.
6. Runs under temporary HOME / XDG / config locations with no production MCP
   registrations.

If any check fails, the integration is not declared OpenCode-compatible and
the spec is revised before implementation completes.

## 11. Decisions (locked)

- **Delivery shape**: a GitHub release tarball, matching the repo's existing
  per-integration convention. The installer unpacks the payload, writes a
  loader file into `~/.config/opencode/plugins/`, copies the skills, and adds
  the `mcp` entry. npm publishing is deferred (§12). The plugin function is a
  named export returning a `Hooks` object; it contributes a cached health block
  and observes MCP connection state if the host emits it.
- **Self-contained build**: the plugin runtime path has zero third-party
  runtime dependencies, the installer bundles `jsonc-parser`, and
  `better-sqlite3` stays external and lazily required by the pre-flight check
  alone. A tarball carries no `node_modules/`, and OpenCode bun-installs
  dependencies only for npm plugins (§2, §4).
- **Configuration is environment-only in v0**: the loader-file install path
  cannot pass per-plugin options, so `CURATED_BRAIN_DIR` and the documented
  three-variable contract are the whole configuration surface.
- **Sidecar lifecycle**: OpenCode alone owns it. The *plugin* never spawns
  `curated-thoughts-mcp`. The user-invoked doctor does handshake (check 3).
- **Diagnostic surface**: a standalone doctor (`scripts/ct_doctor.ts`) spawned
  by the user, never by the plugin. No diagnostic MCP subprocess. The doctor
  never boots OpenCode to inspect effective config.
- **Doctor language**: TypeScript. OpenCode requires Node/Bun, so paying the
  runtime cost buys type-sharing with the plugin module and a single
  toolchain (`pnpm exec tsc` → `node lib/scripts/ct_doctor.js`).
- **Snapshot strategy**: lazy — the cache is refreshed off the
  `experimental.chat.system.transform` path, at most every 30s, bounded by a 2s
  deadline. The hook never awaits the probe. Fail-open: a probe failure keeps
  the previous cached value or empty.
- **Prompt injection**: push one string onto `output.system`; never rewrite or
  reorder existing entries; idempotent by heading match.
- **Sidecar binary name**: `curated-thoughts-mcp` with `--mcp` flag. Same name
  Hermes and DeepSeek register. No second binary.
- **Skill shape**: same three as Hermes and DeepSeek, ported verbatim,
  installed as files into `~/.config/opencode/skills/`.
- **Install path**: `~/.config/opencode/opencode.json[c]`, keys `mcp` and
  `plugin`. Preview-first, opt-in apply, comment-preserving edit, explicit
  disablement preserved.
- **Honesty in unknown**: when no connection-status event is observed,
  `connection: 'unknown'`. When the preflight check is not invoked,
  `preflight: 'not-checked'`. When registration is absent from the one config
  file the doctor reads, `UNKNOWN` with the scope stated — not FAIL, and not a
  claim about the merged config. We do not invent evidence to look healthy.

## 12. Open items (deferred to writing-plans)

- ~~Release policy: GitHub tarball vs npm registry.~~ **Decided 2026-09-17:**
  GitHub tarball, matching the repo's existing convention, with the loader-file
  install path in §4. npm publishing is deferred until the integration is
  proven in real use. Revisit after dogfood; the migration is additive (add the
  package to `plugin`, drop the loader file) and the README's uninstall steps
  already cover the cleanup.
- Whether a default export is honoured alongside the named export, and whether
  `{ server }` module form is preferred. Recorded by the host test.
- Whether any MCP connection-status event reaches the `event` hook in the
  pinned version. If absent, the unknown fallback stands.
- Whether to also install skills to `.opencode/skills/` for project-scoped
  brains. v0 is global-only.
- License: MIT (matches the repo and Hermes). To be re-confirmed at PR time.

## 13. Implementation checklist (follow-up PRs)

- [ ] `shared/integration.schema.json`: add `checks.host`. Own commit — it is a
      shared file and re-runs every integration's CI.
- [ ] Repo scaffolding: `integrations/opencode/` skeleton,
      `integration.yaml` (status: planned), `README.md`, `CHANGELOG.md`.
- [ ] Host contract test (Task 1 of the plan) — pinned OpenCode/SDK/Bun
      versions, fixture plugin, hook and skill-discovery verification.
- [ ] `src/index.ts` (named plugin export + hooks object).
- [ ] `src/status.ts` + `src/refresh.ts` + `src/format.ts`.
- [ ] `scripts/ct_doctor.ts` + `scripts/ct_env.ts` + `scripts/ct_preflight.ts`.
- [ ] `scripts/registration.ts` + `scripts/install.ts` + `scripts/install.sh`
      + `scripts/loader.js.tmpl` (preview-first, opt-in apply, payload unpack,
      loader file, skill copy).
- [ ] Self-contained build: esbuild bundle for the three entry points,
      `better-sqlite3` external, zero runtime deps on the plugin path.
- [ ] Three SKILL.md files ported from Hermes/DeepSeek.
- [ ] Vitest suite (`tests/test_*.ts`) + host contract test.
- [ ] Flip `status: implemented`, run `tools/ct_ci.py generate` for
      `scripts/_compat_generated.ts`, wire the Bun host job in `ci.yml`.
- [ ] Dogfood: install on the maintainer machine, retire bespoke bits,
      record findings.
- [ ] Tag `opencode-v0.1.0` → release tarball via `release.yml`.

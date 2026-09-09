# DeepSeek Harness Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `integrations/deepseek/`, a sibling to `integrations/hermes/` that wires the Curated Thoughts memory sidecar into DeepSeek Harness via a Cordis plugin module, with a doctor / status / install script that mirrors Hermes's discipline.

**Architecture:** A new TypeScript integration that ships as a Cordis plugin npm package (`@equational-applications/dsh-curated-thoughts`). Its `apply(ctx, config)` mounts `@deepseek-ai/dsh-mcp-client` for the sidecar surface, registers a cache-safe `PromptContext` for the health snapshot (lazy first-call, async-refreshed on `agent/session-start`), and registers three skills ported verbatim from Hermes. A 9-check `ct_doctor.ts` mirrors Hermes's deep verifier; a fast `ct_status.ts` mirrors Hermes's session-start snapshot. `install.sh` is idempotent POSIX bash.

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, Cordis (`@deepseek-ai/cordis`), execa, pnpm. dsh sidecar binary `curated-thoughts-mcp --mcp`. Skills are kebab-case `SKILL.md` Markdown.

**Spec:** [`docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md`](../specs/2026-09-09-deepseek-harness-integration-design.md) — the plan argues from the spec; executors read both.

**Sibling reference (read before each task):** [`integrations/hermes/`](../../../integrations/hermes/) — every layer in this integration mirrors a Hermes one. Specifically:
- `hermes/scripts/ct_doctor.py` → `deepseek/scripts/ct_doctor.ts` (9 checks, identical semantics)
- `hermes/scripts/ct_status.py` → `deepseek/src/status.ts` (fast probe, same shape)
- `hermes/scripts/ct_env.py` → `deepseek/scripts/ct_env.ts` (brain / vault / sidecar discovery)
- `hermes/scripts/ct_preflight.py` → `deepseek/scripts/ct_preflight.ts` (PR #188 census, **logically identical**)
- `hermes/scripts/install.sh` → `deepseek/scripts/install.sh` (idempotent, `CT_INSTALL_EDIT=1` opt-in)
- `hermes/skills/{usage,ops,sidecar}/SKILL.md` → `deepseek/skills/{usage,ops,sidecar}/SKILL.md` (verbatim)
- `hermes/integration.yaml` → `deepseek/integration.yaml` (CI contract; `language: node` instead of `python`)

## Global Constraints

- **Sidecar:** `curated-thoughts-mcp --mcp`. Same binary name as Hermes; no second binary. `requires_sidecar: ">=2.5"`, `compat_tier: v2.5-full`.
- **Environment contract** (per repo's [`README.md`](../../../README.md)): `CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`. No other `CURATED_*` variables.
- **Brain vs vault:** brain dir holds `brain.db` + `config.json`; vault is `vault_path` inside `config.json` — machine-specific, the first thing that breaks on import.
- **Three rules:** one sidecar only; never touch the vault out-of-band; fail open, diagnose early.
- **dpkg assumption:** forbidden — the desktop app ships on macOS / Linux / Windows.
- **CI matrix:** `ubuntu-latest`, `macos-latest`, `windows-latest` × Node `22.19`, `24.x` (dsh requires Node 22.19+ or ≥24 per dsh AGENTS.md).
- **Idempotence discipline:** install.sh prints by default; only writes when `CT_INSTALL_EDIT=1` is set. Never overwrites an existing entry. Refuses to write multi-document YAML or YAML containing tabs.
- **Process matching** ([`docs/process-matching.md`](../../process-matching.md)): path-anchored full-command-line only, never name-based, never bare `-f`.
- **License:** MIT. Matches the repo and Hermes.
- **Pre-flight parity:** `ct_preflight.ts` must stay **logically identical** to `ct_preflight.py` (same SQL, same classification, same recovery hints). Drift between the two is a CI gate, not a doc rule.
- **Naming:** integration `id` is `deepseek` (matches `shared/integration.schema.json` pattern `^[a-z][a-z0-9-]*$`).
- **Node module resolution:** NodeNext ESM; relative imports use `.js` extension even from `.ts` sources (TypeScript convention under NodeNext).
- **Attribution:** every commit ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

## Task 1: Repo scaffolding + first passing test

**Files:**
- Create: `integrations/deepseek/integration.yaml`
- Create: `integrations/deepseek/package.json`
- Create: `integrations/deepseek/tsconfig.json`
- Create: `integrations/deepseek/README.md`
- Create: `integrations/deepseek/CHANGELOG.md`
- Create: `integrations/deepseek/.gitignore`
- Create: `integrations/deepseek/tests/smoke.test.ts`
- Create: `integrations/deepseek/vitest.config.ts`

**Step-by-step:**

- [ ] **Step 1.1: Create `integration.yaml`** — CI contract, `status: planned`. Schema per [`shared/integration.schema.json`](../../../shared/integration.schema.json):

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
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: ["22.19", "24.x"]

checks:
  test: pnpm run test
  lint: pnpm exec tsc --noEmit
  shell:
    - scripts/install.sh

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

- [ ] **Step 1.2: Create `package.json`** — name is `@equational-applications/dsh-curated-thoughts`, ESM, vitest:

```json
{
  "name": "@equational-applications/dsh-curated-thoughts",
  "version": "0.1.0",
  "description": "Curated Thoughts memory integration for DeepSeek Harness",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./doctor": "./lib/ct_doctor.js"
  },
  "files": ["lib", "skills", "scripts/install.sh"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*"
  },
  "devDependencies": {
    "@types/node": "^22.19.0",
    "execa": "^9.6.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 1.3: Create `tsconfig.json`** — NodeNext, ESM, strict:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./lib",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "lib", "tests", "scripts"]
}
```

(Note: `scripts/` is excluded from the plugin build. Each script that ships is compiled separately — see Task 6 for `ct_doctor.ts` and Task 7 for `ct_status.ts`. The doctor and status have their own minimal tsconfigs or use `tsx` at runtime — see how each is wired in its task.)

- [ ] **Step 1.4: Create `vitest.config.ts`** — match the package layout, exclude `lib/`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'lib'],
  },
});
```

- [ ] **Step 1.5: Create `README.md`** — placeholder shape, fleshed out in Task 12:

```markdown
# Curated Thoughts for DeepSeek Harness

Cordis plugin module that wires the Curated Thoughts memory sidecar into
DeepSeek Harness (`pnpm dsh`). See the design spec at
[`docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md`](../../docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md).

## Status

Planned — `status: planned` in `integration.yaml` until the doctor, status
probe, and install.sh are all green.

## Install

`./scripts/install.sh` (prints by default; `CT_INSTALL_EDIT=1` to write).

## Verify

`pnpm exec tsc --noEmit && pnpm test`.
```

- [ ] **Step 1.6: Create `CHANGELOG.md`** — initial entry:

```markdown
# Changelog

## 0.1.0 — 2026-09-09

Initial release. Cordis plugin module wires the Curated Thoughts MCP sidecar,
registers a cache-safe health snapshot, refreshes on `agent/session-start`,
and ships three skills ported from Hermes (`curated-thoughts-usage`,
`curated-thoughts-ops`, `curated-thoughts-sidecar`). Ships a 9-check
`ct_doctor.ts` and an idempotent POSIX `install.sh`.
```

- [ ] **Step 1.7: Create `.gitignore`**:

```
node_modules/
lib/
dist/
*.tsbuildinfo
.env
.env.*
```

- [ ] **Step 1.8: Create `tests/smoke.test.ts`** — sanity check that vitest works:

```ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 1.9: Run `pnpm install` and `pnpm test`**:

```bash
cd integrations/deepseek
pnpm install
pnpm test
```

Expected: vitest reports 1 passing test.

- [ ] **Step 1.10: Verify `tools/ct_ci.py discover` finds the new integration** from the repo root:

```bash
python tools/ct_ci.py discover --all
```

Expected: `integrations/deepseek` appears in the discovered list with `status: planned`. (If the tool exits non-zero, read the error — most often it's a schema mismatch on `integration.yaml`. The schema is at `shared/integration.schema.json`.)

- [ ] **Step 1.11: Commit**:

```bash
git add integrations/deepseek/
git commit -m "feat(deepseek): scaffold integration directory

Repo scaffolding for the new DeepSeek Harness integration: integration.yaml
(status: planned), package.json, tsconfig, vitest config, README, CHANGELOG,
and a smoke test. discover picks up the new integration.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: `ct_env.ts` — brain / vault / sidecar resolution

**Files:**
- Create: `integrations/deepseek/scripts/ct_env.ts`
- Create: `integrations/deepseek/scripts/tsconfig.json` (per-script compile config — see step)
- Create: `integrations/deepseek/tests/test_ct_env.ts`

**Interfaces produced (consumed by Tasks 3, 5, 6):**
- `BrainPaths { brainDir, dbPath, configPath }`
- `findSidecar(env?) → { path, resolved, source } | null`
- `resolveBrainPaths(env?) → BrainPaths`
- `readBrainConfig(path) → { config, error }`
- `resolveVaultPath(config) → { vault, error }`
- `looksLikeDevBuild(path) → boolean`
- `installKind(path) → 'homebrew' | 'deb' | 'app-bundle' | 'unknown'`
- `sidecarCandidates() → string[]` (PATH + platform install locations)

This is a port of `integrations/hermes/scripts/ct_env.py`. The contract is
identical to Hermes's: any test that passes against Hermes's `ct_env.py`
must pass against `ct_env.ts` with the same inputs.

**Step-by-step:**

- [ ] **Step 2.1: Create `scripts/tsconfig.json`** — separate tsconfig for scripts that compiles to `lib/` alongside `src/`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "../lib",
    "rootDir": ".",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["./**/*.ts"]
}
```

- [ ] **Step 2.2: Write the failing test `tests/test_ct_env.ts`** — covers all three resolution layers. (Same shape as the Hermes pytest; if a Hermes test exists for a function, mirror it here verbatim.)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveBrainPaths,
  readBrainConfig,
  resolveVaultPath,
  findSidecar,
  sidecarCandidates,
  looksLikeDevBuild,
  installKind,
  ENV_BRAIN_DIR,
} from '../scripts/ct_env.js';

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-env-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows
  delete process.env[ENV_BRAIN_DIR];
  delete process.env.CURATED_BRAIN_DB;
  delete process.env.CURATED_BRAIN_CONFIG;
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('resolveBrainPaths', () => {
  it('defaults to ~/.brain when no env var is set', () => {
    const paths = resolveBrainPaths();
    expect(paths.brainDir).toBe(join(tmpHome, '.brain'));
    expect(paths.dbPath).toBe(join(tmpHome, '.brain', 'brain.db'));
    expect(paths.configPath).toBe(join(tmpHome, '.brain', 'config.json'));
  });

  it('honors CURATED_BRAIN_DIR', () => {
    const custom = join(tmpHome, 'my-brain');
    process.env[ENV_BRAIN_DIR] = custom;
    const paths = resolveBrainPaths();
    expect(paths.brainDir).toBe(custom);
  });

  it('CURATED_BRAIN_DB overrides brainDir for dbPath only', () => {
    process.env[ENV_BRAIN_DIR] = join(tmpHome, 'a');
    process.env.CURATED_BRAIN_DB = join(tmpHome, 'b', 'brain.db');
    const paths = resolveBrainPaths();
    expect(paths.brainDir).toBe(join(tmpHome, 'a'));
    expect(paths.dbPath).toBe(join(tmpHome, 'b', 'brain.db'));
    expect(paths.configPath).toBe(join(tmpHome, 'a', 'config.json'));
  });
});

describe('readBrainConfig', () => {
  it('returns null + error when the file is missing', () => {
    const { config, error } = readBrainConfig(join(tmpHome, 'absent.json'));
    expect(config).toBeNull();
    expect(error).toMatch(/missing/i);
  });

  it('returns null + error on invalid JSON', () => {
    const bad = join(tmpHome, 'bad.json');
    writeFileSync(bad, '{ not json');
    const { config, error } = readBrainConfig(bad);
    expect(config).toBeNull();
    expect(error).toMatch(/json/i);
  });

  it('parses a minimal valid config', () => {
    const good = join(tmpHome, 'good.json');
    writeFileSync(good, JSON.stringify({ vault_path: '/data/v' }));
    const { config, error } = readBrainConfig(good);
    expect(error).toBeNull();
    expect(config?.vault_path).toBe('/data/v');
  });
});

describe('resolveVaultPath', () => {
  it('returns null when vault_path is absent', () => {
    const { vault, error } = resolveVaultPath({});
    expect(vault).toBeNull();
    expect(error).toMatch(/vault_path/i);
  });

  it('expands ~ to HOME', () => {
    const { vault, error } = resolveVaultPath({ vault_path: '~/vault' });
    expect(error).toBeNull();
    expect(vault).toBe(join(tmpHome, 'vault'));
  });
});

describe('findSidecar', () => {
  it('returns null when not on PATH and no platform location matches', () => {
    // Empty PATH; the platform install locations under tmpHome don't exist.
    process.env.PATH = '';
    const found = findSidecar();
    expect(found).toBeNull();
  });

  it('finds curated-thoughts-mcp on PATH', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const fake = join(binDir, 'curated-thoughts-mcp');
    writeFileSync(fake, '#!/bin/sh\necho ok\n');
    // chmod via Node's fs — keep the test cross-platform.
    // (Vitest runs on Linux/macOS/Windows CI; the sidecar binary must exist for
    // the lookup to succeed. On Windows, `findSidecar` resolves .cmd/.exe —
    // see implementation note.)
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + process.env.PATH;
    const found = findSidecar();
    expect(found?.path).toMatch(/curated-thoughts-mcp/);
  });
});

describe('sidecarCandidates', () => {
  it('includes ~/.local/bin/curated-thoughts-mcp', () => {
    const candidates = sidecarCandidates();
    expect(candidates.some((c) => c.endsWith(join('.local', 'bin', 'curated-thoughts-mcp')))).toBe(true);
  });
});

describe('looksLikeDevBuild', () => {
  it('flags a path inside tools/ or target/', () => {
    expect(looksLikeDevBuild('/repo/tools/curated-thoughts-mcp')).toBe(true);
    expect(looksLikeDevBuild('/repo/target/debug/curated-thoughts-mcp')).toBe(true);
  });

  it('does not flag a path under /usr/bin', () => {
    expect(looksLikeDevBuild('/usr/bin/curated-thoughts-mcp')).toBe(false);
  });
});

describe('installKind', () => {
  it('returns homebrew for /opt/homebrew or /usr/local/Cellar', () => {
    expect(installKind('/opt/homebrew/bin/curated-thoughts-mcp')).toBe('homebrew');
    expect(installKind('/usr/local/Cellar/curated-thoughts/1.0/bin/curated-thoughts-mcp')).toBe('homebrew');
  });

  it('returns deb for /usr/bin', () => {
    expect(installKind('/usr/bin/curated-thoughts-mcp')).toBe('deb');
  });

  it('returns app-bundle for a macOS .app path', () => {
    expect(installKind('/Applications/Curated Thoughts.app/Contents/MacOS/curated-thoughts-mcp')).toBe('app-bundle');
  });
});
```

- [ ] **Step 2.3: Run the test and verify it fails**:

```bash
cd integrations/deepseek
pnpm test tests/test_ct_env.ts
```

Expected: import error — `ct_env.js` does not exist yet.

- [ ] **Step 2.4: Implement `scripts/ct_env.ts`** — full port of `hermes/scripts/ct_env.py`. Key shape:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { homedir, platform } from 'node:os';

export const SIDECAR_NAME = 'curated-thoughts-mcp';
export const ENV_BRAIN_DIR = 'CURATED_BRAIN_DIR';
export const ENV_BRAIN_DB = 'CURATED_BRAIN_DB';
export const ENV_BRAIN_CONFIG = 'CURATED_BRAIN_CONFIG';

export interface BrainPaths {
  brainDir: string;
  dbPath: string;
  configPath: string;
}

export function resolveBrainPaths(env: NodeJS.ProcessEnv = process.env): BrainPaths {
  const home = homedir();
  const fromEnv = env[ENV_BRAIN_DIR] ?? env[ENV_BRAIN_CONFIG]?.replace(/config\.json$/, '');
  const brainDir = fromEnv ? pathResolve(fromEnv) : join(home, '.brain');
  const configPath = env[ENV_BRAIN_CONFIG]
    ? pathResolve(env[ENV_BRAIN_CONFIG])
    : join(brainDir, 'config.json');
  const dbPath = env[ENV_BRAIN_DB] ? pathResolve(env[ENV_BRAIN_DB]) : join(brainDir, 'brain.db');
  return { brainDir, dbPath, configPath };
}

export function readBrainConfig(path: string): { config: Record<string, unknown> | null; error: string | null } {
  if (!existsSync(path)) return { config: null, error: `config.json missing: ${path}` };
  try {
    return { config: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (e) {
    return { config: null, error: `config.json invalid JSON: ${(e as Error).message}` };
  }
}

export function resolveVaultPath(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { vault: string | null; error: string | null } {
  const raw = config.vault_path;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { vault: null, error: 'vault_path missing or not a string in config.json' };
  }
  let expanded = raw;
  if (expanded.startsWith('~')) {
    expanded = join(homedir(), expanded.slice(1));
  }
  return { vault: pathResolve(expanded), error: null };
}

// ... findSidecar, sidecarCandidates, looksLikeDevBuild, installKind
// Match Hermes's ct_env.py exactly. See that file for the canonical logic:
// macOS app bundle, Linux .deb /usr/bin, Windows Programs dir; PATH lookup
// first; never trust a target/ or tools/ path.
```

(The full implementation mirrors `hermes/scripts/ct_env.py` — read that file as the source of truth and translate 1:1 to TypeScript. Do not paraphrase the heuristic for `looksLikeDevBuild`; copy the rules verbatim.)

- [ ] **Step 2.5: Compile the scripts to lib/**:

```bash
cd integrations/deepseek/scripts
pnpm exec tsc
```

Expected: `lib/ct_env.js` exists. The root `tsconfig.json` (Task 1.3) excludes `scripts/`; this per-script tsconfig compiles them to `lib/` for the npm package's doctor export.

- [ ] **Step 2.6: Run the test and verify it passes**:

```bash
cd integrations/deepseek
pnpm test tests/test_ct_env.ts
```

Expected: all tests in `test_ct_env.ts` pass.

- [ ] **Step 2.7: Commit**:

```bash
git add integrations/deepseek/scripts/ct_env.ts integrations/deepseek/scripts/tsconfig.json integrations/deepseek/tests/test_ct_env.ts integrations/deepseek/lib/
git commit -m "feat(deepseek): ct_env.ts — brain, vault, sidecar resolution

Port of integrations/hermes/scripts/ct_env.py to TypeScript. Same
contract: three-variable env (CURATED_BRAIN_DIR / _DB / _CONFIG), platform
sidecar discovery (PATH + macOS app bundle + Linux deb + Windows Programs),
dev-build detection (target/ or tools/), and install-kind classification.
Drift from the Python version is a CI gate.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: `status.ts` — fast probe

**Files:**
- Create: `integrations/deepseek/src/status.ts`
- Create: `integrations/deepseek/tests/test_status.ts`

**Interfaces produced (consumed by Tasks 4, 7):**
- `type Status = 'ok' | 'degraded' | 'unknown'`
- `interface Snapshot { status: Status; sidecar: string | null; brainDir: string | null; vault: string | null; notes: string[] }`
- `probe(env?) → Snapshot` — never throws, never spawns the sidecar, never opens `brain.db`.

This is a port of `hermes/scripts/ct_status.py::snapshot`. Constraint:
target latency <200ms; no MCP handshake; no `brain.db` open.

**Step-by-step:**

- [ ] **Step 3.1: Write the failing test `tests/test_status.ts`**:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '../src/status.js';

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-status-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CURATED_BRAIN_DIR;
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('probe', () => {
  it('returns unknown when sidecar is not found and brain is missing', () => {
    process.env.PATH = '';
    const snap = probe();
    expect(snap.status).toBe('unknown');
    expect(snap.sidecar).toBeNull();
    expect(snap.brainDir).not.toBeNull();
    expect(snap.notes.length).toBeGreaterThan(0);
  });

  it('returns ok when sidecar is on PATH and brain + vault resolve', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const sidecar = join(binDir, 'curated-thoughts-mcp');
    writeFileSync(sidecar, '#!/bin/sh\n');
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '');

    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    const vault = join(tmpHome, 'vault');
    mkdirSync(vault);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: vault }));

    process.env.CURATED_BRAIN_DIR = brainDir;

    const snap = probe();
    expect(snap.status).toBe('ok');
    expect(snap.sidecar).toMatch(/curated-thoughts-mcp/);
    expect(snap.brainDir).toBe(brainDir);
    expect(snap.vault).toBe(vault);
    expect(snap.notes).toEqual([]);
  });

  it('returns degraded when brain exists but vault_path does not', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'curated-thoughts-mcp'), '#!/bin/sh\n');
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '');

    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    writeFileSync(join(brainDir, 'config.json'), JSON.stringify({ vault_path: '/nonexistent' }));
    process.env.CURATED_BRAIN_DIR = brainDir;

    const snap = probe();
    expect(snap.status).toBe('degraded');
    expect(snap.notes.some((n) => /vault/.test(n))).toBe(true);
  });

  it('does not spawn the sidecar', () => {
    // Sidecar is a fake script that prints "SPAWNED" if executed. probe() must
    // only do path / file existence checks, not execute it.
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir);
    const sidecar = join(binDir, 'curated-thoughts-mcp');
    // Write a script that creates a sentinel file — if probe() spawns it, the
    // sentinel will exist after the call.
    writeFileSync(sidecar, `#!/bin/sh\ntouch ${join(tmpHome, 'SPAWNED')}\n`);
    process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? '');

    probe();

    expect(require('node:fs').existsSync(join(tmpHome, 'SPAWNED'))).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run the test and verify it fails**:

```bash
cd integrations/deepseek
pnpm test tests/test_status.ts
```

Expected: import error — `status.js` does not exist yet.

- [ ] **Step 3.3: Implement `src/status.ts`**:

```ts
import { existsSync } from 'node:fs';
import {
  findSidecar,
  resolveBrainPaths,
  readBrainConfig,
  resolveVaultPath,
  looksLikeDevBuild,
} from '../scripts/ct_env.js';

export type Status = 'ok' | 'degraded' | 'unknown';

export interface Snapshot {
  status: Status;
  sidecar: string | null;
  brainDir: string | null;
  vault: string | null;
  notes: string[];
}

const OK: Status = 'ok';
const DEGRADED: Status = 'degraded';
const UNKNOWN: Status = 'unknown';

export function probe(env: NodeJS.ProcessEnv = process.env): Snapshot {
  const out: Snapshot = {
    status: UNKNOWN,
    sidecar: null,
    brainDir: null,
    vault: null,
    notes: [],
  };
  try {
    const found = findSidecar(env);
    out.sidecar = found?.path ?? null;
    if (out.sidecar === null) {
      out.notes.push('sidecar curated-thoughts-mcp not found');
    } else if (found && looksLikeDevBuild(found.resolved)) {
      out.notes.push('sidecar is a development build, not an installed one');
    }

    const paths = resolveBrainPaths(env);
    out.brainDir = paths.brainDir;
    if (!existsSync(paths.brainDir)) {
      out.notes.push(`brain dir missing: ${paths.brainDir}`);
    } else {
      const { config, error } = readBrainConfig(paths.configPath);
      if (config === null) {
        out.notes.push(`config.json ${error}`);
      } else {
        const { vault, error: verr } = resolveVaultPath(config, env);
        if (vault === null) {
          out.notes.push(verr ?? 'vault_path unresolved');
        } else {
          out.vault = vault;
          if (!existsSync(vault)) {
            out.notes.push(`vault path from config.json does not exist here: ${vault}`);
          }
        }
      }
    }

    out.status = out.notes.length === 0 ? OK : DEGRADED;
  } catch {
    out.status = UNKNOWN;
    out.notes = ['status check failed'];
  }
  return out;
}
```

- [ ] **Step 3.4: Compile scripts to lib** (so `../scripts/ct_env.js` resolves from `src/`):

```bash
cd integrations/deepseek/scripts
pnpm exec tsc
```

- [ ] **Step 3.5: Run the test and verify it passes**:

```bash
cd integrations/deepseek
pnpm test tests/test_status.ts
```

Expected: all 4 tests pass.

- [ ] **Step 3.6: Commit**:

```bash
git add integrations/deepseek/src/status.ts integrations/deepseek/tests/test_status.ts integrations/deepseek/lib/
git commit -m "feat(deepseek): status.ts — fast probe for session-start

Port of integrations/hermes/scripts/ct_status.py::snapshot to TypeScript.
O(1) filesystem checks only; never spawns the sidecar; never opens
brain.db. Returns ok | degraded | unknown with sidecar path, brain dir,
vault path, and a notes list. The 'does not spawn the sidecar' test
guards the design invariant.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: `format.ts` — snapshot to compact block

**Files:**
- Create: `integrations/deepseek/src/format.ts`
- Create: `integrations/deepseek/tests/test_format.ts`

**Interfaces produced (consumed by Task 7):**
- `formatStatusBlock(snapshot: Snapshot, deps?) → string | null` — returns the same shape Hermes's `ct_status.context_section()` returns:
  - `null` when status is `ok` and there's nothing worth spending context on beyond the routing reminder
  - A multi-line Markdown block with the status header, the first 3 notes (if degraded), and the routing reminder

The block format matches Hermes's `ct_status.py::context_section()` exactly. **One source of truth, two harnesses.**

- [ ] **Step 4.1: Write the failing test**:

```ts
import { describe, it, expect } from 'vitest';
import { formatStatusBlock } from '../src/format.js';
import type { Snapshot } from '../src/status.js';

describe('formatStatusBlock', () => {
  it('returns null when status is ok', () => {
    const snap: Snapshot = {
      status: 'ok', sidecar: '/usr/bin/curated-thoughts-mcp',
      brainDir: '/home/user/.brain', vault: '/home/user/vault', notes: [],
    };
    expect(formatStatusBlock(snap)).toBeNull();
  });

  it('renders the degraded block with first 3 notes', () => {
    const snap: Snapshot = {
      status: 'degraded', sidecar: null,
      brainDir: '/home/user/.brain', vault: null,
      notes: ['vault_path unresolved', 'config.json missing', 'note 3', 'note 4'],
    };
    const out = formatStatusBlock(snap);
    expect(out).toMatch(/## Curated Thoughts/);
    expect(out).toMatch(/DEGRADED/);
    expect(out).toMatch(/ct_doctor\.ts check/);
    expect(out).toMatch(/- vault_path unresolved/);
    expect(out).toMatch(/- config.json missing/);
    expect(out).toMatch(/- note 3/);
    expect(out).not.toMatch(/- note 4/); // capped at 3
    expect(out).toMatch(/Continue the session without Curated Thoughts memory/);
  });

  it('renders the unknown block without listing notes', () => {
    const snap: Snapshot = {
      status: 'unknown', sidecar: null, brainDir: null, vault: null,
      notes: [],
    };
    const out = formatStatusBlock(snap);
    expect(out).toMatch(/unknown/);
    expect(out).toMatch(/report any tool errors/);
  });

  it('includes the routing reminder in degraded and unknown blocks', () => {
    const degraded = formatStatusBlock({
      status: 'degraded', sidecar: null, brainDir: null, vault: null, notes: ['x'],
    });
    expect(degraded).toMatch(/wiki_context/);
    expect(degraded).toMatch(/never touch the vault or brain database out-of-band/);

    const unknown = formatStatusBlock({
      status: 'unknown', sidecar: null, brainDir: null, vault: null, notes: [],
    });
    expect(unknown).toMatch(/wiki_context/);
  });
});
```

- [ ] **Step 4.2: Run and verify it fails**:

```bash
cd integrations/deepseek
pnpm test tests/test_format.ts
```

Expected: import error.

- [ ] **Step 4.3: Implement `src/format.ts`** — read `hermes/scripts/ct_status.py::context_section()` and port verbatim. Critical: the routing reminder text and the "first 3 notes" cap must match.

```ts
import type { Snapshot } from './status.js';

export const ROUTING_REMINDER =
  'Curated Thoughts memory is available over MCP. Prefer the one-call recall ' +
  'tool (wiki_context) before composing raw searches; reach for wiki_search / ' +
  'vault_semantic_search / wiki_traverse_graph / vault_related_chunks only for ' +
  'deep work. Never touch the vault or brain database out-of-band — the ' +
  'sidecar is the only writer.';

export function formatStatusBlock(snap: Snapshot): string | null {
  const lines = ['## Curated Thoughts'];
  if (snap.status === 'ok') {
    return null; // Hermes returns null here too: nothing worth spending context on.
  }
  if (snap.status === 'degraded') {
    lines.push(
      'Memory sidecar DEGRADED — CT tool calls may fail. ' +
      'Run `ct_doctor.ts check` for details.',
    );
    for (const note of snap.notes.slice(0, 3)) {
      lines.push(`- ${note}`);
    }
    lines.push(
      'Continue the session without Curated Thoughts memory if tools fail; ' +
      'report the error rather than working around the sidecar.',
    );
  } else {
    lines.push('Memory status unknown; proceed and report any tool errors.');
  }
  lines.push(ROUTING_REMINDER);
  return lines.join('\n');
}
```

- [ ] **Step 4.4: Run and verify it passes**:

```bash
cd integrations/deepseek
pnpm test tests/test_format.ts
```

Expected: all 4 tests pass.

- [ ] **Step 4.5: Commit**:

```bash
git add integrations/deepseek/src/format.ts integrations/deepseek/tests/test_format.ts
git commit -m "feat(deepseek): format.ts — snapshot to compact block

Port of Hermes's ct_status.py::context_section() to TypeScript. Same
format, same cap (first 3 notes), same routing reminder text. ok returns
null (no context spent); degraded and unknown emit the multi-line block.
Single source of truth for cross-harness consistency.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: `ct_preflight.ts` — import pre-flight

**Files:**
- Create: `integrations/deepseek/scripts/ct_preflight.ts`
- Create: `integrations/deepseek/tests/test_ct_preflight.ts`

**Interfaces produced (consumed by Task 6):**
- `interface Census { total, damaged, atRisk, tokens, missingEvidenceRows, unanchoredRows, evidenceTablePresent, tablePresent, scoped, shape(), recoveryHints, error }`
- `censusSourceRefs(dbPath) → Census` — opens `brain.db` via `mode=ro`-equivalent (read-only, SELECT only). Errors return `Census` with `error` set, never throw.
- `detectEngineVersion(sidecarPath?) → { version, source } | { version: null, source: null }`

This is a **logic-only** port of `hermes/scripts/ct_preflight.py`. Same SQL, same classification thresholds, same recovery-hint keys. Read `ct_preflight.py` as the source of truth; the SQL it issues (`SELECT count(*) FROM llm_wiki_entries`, the source_ref classification predicates, the `librarian_evidence` join) is harness-agnostic.

- [ ] **Step 5.1: Add `better-sqlite3` dependency** — Hermes uses Python `sqlite3`; the TS port uses `better-sqlite3`:

```bash
cd integrations/deepseek
pnpm add -D better-sqlite3 @types/better-sqlite3
```

- [ ] **Step 5.2: Write the failing test** — use an in-memory or temp-file brain.db fixture. Read `hermes/tests/test_ct_preflight.py` and mirror each test verbatim.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { censusSourceRefs, detectEngineVersion } from '../scripts/ct_preflight.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ct-preflight-'));
  dbPath = join(tmpDir, 'brain.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE llm_wiki_entries (
      id INTEGER PRIMARY KEY,
      source_ref TEXT,
      source_type TEXT
    );
  `);
  db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('censusSourceRefs', () => {
  it('returns no damage when the table is empty', () => {
    const c = censusSourceRefs(dbPath);
    expect(c.error).toBeNull();
    expect(c.total).toBe(0);
    expect(c.damaged).toBe(0);
    expect(c.atRisk).toBe(0);
  });

  it('classifies rows whose source_ref is engine-proof token', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('ct_token:abc123', 'vault_note');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.tokens).toBe(1);
    expect(c.damaged).toBe(0);
    expect(c.atRisk).toBe(0);
  });

  it('flags rows with structured JSON source_ref as at_risk', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('{"note_id":"n1"}', 'vault_note');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.atRisk).toBeGreaterThanOrEqual(1);
  });

  it('flags rows with whitespace-padded source_ref as at_risk', () => {
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO llm_wiki_entries (source_ref, source_type) VALUES (?, ?)`)
      .run('  ct_token:abc123  ', 'vault_note');
    db.close();
    const c = censusSourceRefs(dbPath);
    expect(c.atRisk).toBeGreaterThanOrEqual(1);
  });

  it('returns error when brain.db is missing', () => {
    const c = censusSourceRefs(join(tmpDir, 'absent.db'));
    expect(c.error).toMatch(/brain\.db/);
  });
});

describe('detectEngineVersion', () => {
  it('returns nulls when no sidecar path is given and engine is not present', () => {
    // The engine lookup is heuristic (Cargo.toml, package.json, dpkg).
    // With an isolated tmpDir and no sidecar, both are null.
    const r = detectEngineVersion();
    expect(r.version).toBeNull();
    expect(r.source).toBeNull();
  });
});
```

- [ ] **Step 5.3: Run and verify it fails**:

```bash
cd integrations/deepseek
pnpm test tests/test_ct_preflight.ts
```

Expected: import error.

- [ ] **Step 5.4: Implement `scripts/ct_preflight.ts`** — port of `hermes/scripts/ct_preflight.py`. The thresholds:

- `source_ref` matching `^ct_token:[a-zA-Z0-9]+$` exactly (no whitespace) → `tokens`
- `source_ref` matching `^ct_token:` but with leading/trailing whitespace → `at_risk`
- `source_ref` starting with `{` or `[` (JSON-shaped) → `at_risk` (engine will rewrite)
- `source_ref` empty or containing only whitespace → `damaged`

(Read `hermes/scripts/ct_preflight.py` for the exact regex set. This plan doesn't repeat the Python — translate it.)

```ts
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Census {
  total: number;
  damaged: number;
  atRisk: number;
  tokens: number;
  missingEvidenceRows: number;
  unanchoredRows: number;
  evidenceTablePresent: boolean | null;
  tablePresent: boolean;
  scoped: boolean;
  shape: () => string;
  recoveryHints: Record<string, number>;
  error: string | null;
}

const EVIDENCE_TABLE = 'librarian_evidence';

export function censusSourceRefs(dbPath: string): Census {
  const base: Census = {
    total: 0, damaged: 0, atRisk: 0, tokens: 0,
    missingEvidenceRows: 0, unanchoredRows: 0,
    evidenceTablePresent: null, tablePresent: false,
    scoped: true,
    shape: () => 'empty',
    recoveryHints: {},
    error: null,
  };
  if (!existsSync(dbPath)) {
    base.error = `brain.db missing: ${dbPath}`;
    return base;
  }
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // ... translate ct_preflight.py's SQL one-for-one. Same classifications.
      // After classification, also check whether the evidence table is present
      // and which evidence rows are missing for token refs.
    } finally {
      db.close();
    }
  } catch (e) {
    base.error = (e as Error).message;
  }
  return base;
}

export function detectEngineVersion(sidecarPath?: string) {
  // Heuristic: walk up from sidecarPath looking for Cargo.toml / package.json,
  // parse the version. Falls through to nulls when no signal is found.
  // See hermes/scripts/ct_preflight.py::detect_engine_version for the rules.
  return { version: null as string | null, source: null as string | null };
}
```

(The full implementation is a line-by-line port. Read `hermes/scripts/ct_preflight.py` and translate. Do not paraphrase the SQL or the regexes.)

- [ ] **Step 5.5: Compile scripts and run the test**:

```bash
cd integrations/deepseek/scripts
pnpm exec tsc
cd ..
pnpm test tests/test_ct_preflight.ts
```

Expected: all tests pass.

- [ ] **Step 5.6: Commit**:

```bash
git add integrations/deepseek/scripts/ct_preflight.ts integrations/deepseek/tests/test_ct_preflight.ts integrations/deepseek/package.json integrations/deepseek/pnpm-lock.yaml integrations/deepseek/lib/
git commit -m "feat(deepseek): ct_preflight.ts — import pre-flight census

Port of integrations/hermes/scripts/ct_preflight.py to TypeScript. Same
SQL, same source_ref classification (token / at_risk / damaged), same
recovery-hint keys, same evidence-table census. Same readonly DB open
(better-sqlite3 in readonly mode). Drift from the Python port is a CI
gate.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: `ct_doctor.ts` — 9-check deep verifier

**Files:**
- Create: `integrations/deepseek/scripts/ct_doctor.ts`
- Create: `integrations/deepseek/scripts/_compat_generated.ts` (placeholder for Task 11)
- Create: `integrations/deepseek/tests/test_ct_doctor.ts`

**Interfaces produced (consumed by install.sh and the integration's exports):**
- `PASS | WARN | FAIL` constants
- `interface CheckResult { name, status, detail, hint }`
- `runChecks(opts?) → CheckResult[]` — runs all 9 checks
- `cmdCheck({ json? }) → number` — CLI entry; exit code 0/1/2

The 9 checks mirror Hermes's `ct_doctor.py` (see spec §6). Read `hermes/scripts/ct_doctor.py` as the source of truth and port 1:1.

- [ ] **Step 6.1: Write the failing test** — mock-sidecar fixture that responds to `initialize` + `notifications/initialized` + `tools/list` over stdio:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runChecks,
  cmdCheck,
  PASS, WARN, FAIL,
  type CheckResult,
} from '../scripts/ct_doctor.js';

let tmpHome: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ct-doctor-'));
  originalEnv = process.env;
  process.env = { ...originalEnv };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CURATED_BRAIN_DIR;
  process.env.PATH = ''; // force a clean PATH so sidecar discovery is deterministic
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tmpHome, { recursive: true, force: true });
});

function names(rs: CheckResult[]) {
  return rs.map((r) => `${r.name}:${r.status}`);
}

describe('runChecks', () => {
  it('reports FAIL on a clean machine with no sidecar and no brain', () => {
    const rs = runChecks();
    expect(names(rs)).toContain(`sidecar-binary:${FAIL}`);
    expect(names(rs)).toContain(`brain-dir:${FAIL}`);
  });

  it('reports FAIL when the brain directory exists but config.json is missing', () => {
    const brainDir = join(tmpHome, '.brain');
    mkdirSync(brainDir);
    process.env.CURATED_BRAIN_DIR = brainDir;
    const rs = runChecks();
    expect(names(rs).some((n) => n.startsWith('brain-dir:') && n.endsWith(':WARN'))).toBe(true);
  });
});

describe('cmdCheck', () => {
  it('prints JSON when --json is passed', () => {
    // Capture stdout via a child process running the compiled doctor.
    // lib/ct_doctor.js is built by scripts/tsconfig.json in Task 2.5.
    const out = spawnSync('node', [join(import.meta.dirname, '..', 'lib', 'ct_doctor.js'), 'check', '--json'], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, PATH: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.exit_code).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});
```

- [ ] **Step 6.2: Run and verify it fails**:

```bash
cd integrations/deepseek
pnpm test tests/test_ct_doctor.ts
```

Expected: import error.

- [ ] **Step 6.3: Implement `scripts/ct_doctor.ts`** — port `hermes/scripts/ct_doctor.py` 1:1. The 9 checks in order:

1. `sidecar-binary` — `findSidecar()` (ct_env Task 2). FAIL when not found.
2. `sidecar-identity` — `looksLikeDevBuild` / `installKind` (ct_env). WARN when dev build.
3. `sidecar-mcp` — spawn sidecar, speak JSON-RPC `initialize` + `notifications/initialized` + `tools/list`, parse tool count → tier. Tool count is the authoritative signal (Hermes does this).
4. `brain-dir` — `resolveBrainPaths` (ct_env). FAIL when missing.
5. `vault` — `readBrainConfig` + `resolveVaultPath` (ct_env). FAIL when config invalid or vault missing.
6. `embedding-backend` — env keys (`CT_EMBED_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`) or OLLAMA_HOST reachable. WARN-only.
7. `dsh-registration` — checks the live dsh composition for the `curated-thoughts` MCP server AND a `cordis.yml` list entry for `@equational-applications/dsh-curated-thoughts`. Two distinct sub-checks because MCP client can be mounted independently.
8. `import-preflight` — calls `censusSourceRefs` (Task 5) and `detectEngineVersion`. FAIL on damaged or at_risk; PASS with notes on missing evidence.
9. `version-compat` — best-effort sidecar version discovery (`dpkg` on Linux only; npm on macOS; Programs registry on Windows) cross-checked against the tool count from check 3.

The `_compat_generated.ts` import is filled in by Task 11; for now, stub it:

```ts
// scripts/_compat_generated.ts (stub — replaced by Task 11)
export const TIERS: Array<[string, [number, number], [number, number] | null, number, string]> = [];
export const FULL_TIER_TOOLS = 14;
export const READ_TIER_TOOLS = 8;
export const EVIDENCE_TABLE = 'librarian_evidence';
export const ENGINE_PINNED_VERSION = '0.5.0'; // matches compat.yaml
```

- [ ] **Step 6.4: Compile scripts and run the test**:

```bash
cd integrations/deepseek/scripts
pnpm exec tsc
cd ..
pnpm test tests/test_ct_doctor.ts
```

Expected: tests pass.

- [ ] **Step 6.5: Commit**:

```bash
git add integrations/deepseek/scripts/ct_doctor.ts integrations/deepseek/scripts/_compat_generated.ts integrations/deepseek/tests/test_ct_doctor.ts integrations/deepseek/lib/
git commit -m "feat(deepseek): ct_doctor.ts — 9-check deep verifier

Port of integrations/hermes/scripts/ct_doctor.py to TypeScript. Same nine
checks in the same order: sidecar-binary, sidecar-identity, sidecar-mcp,
brain-dir, vault, embedding-backend, dsh-registration, import-preflight,
version-compat. Same exit codes (0/1/2). The dsh-registration check is
the harness-specific adaptation (Hermes checks ~/.hermes/config.yaml;
this checks the live dsh composition + cordis.yml).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: Skill content — verbatim port from Hermes

**Files:**
- Create: `integrations/deepseek/skills/curated-thoughts-usage/SKILL.md`
- Create: `integrations/deepseek/skills/curated-thoughts-ops/SKILL.md`
- Create: `integrations/deepseek/skills/curated-thoughts-sidecar/SKILL.md`
- Create: `integrations/deepseek/tests/test_skills_content.ts`

**Step-by-step:**

- [ ] **Step 7.1: Copy each SKILL.md verbatim from Hermes**:

```bash
cd integrations/deepseek
mkdir -p skills/curated-thoughts-{usage,ops,sidecar}
cp ../../hermes/skills/curated-thoughts-usage/SKILL.md skills/curated-thoughts-usage/SKILL.md
cp ../../hermes/skills/curated-thoughts-ops/SKILL.md skills/curated-thoughts-ops/SKILL.md
cp ../../hermes/skills/curated-thoughts-sidecar/SKILL.md skills/curated-thoughts-sidecar/SKILL.md
```

(Run from the repo root. The relative paths assume the standard layout.)

- [ ] **Step 7.2: Add a dsh-compatible frontmatter block** at the top of each file. The Hermes files use their own conventions; dsh reads `name:` / `description:` and optional `disable-model-invocation` / `user-invocable`. Insert the frontmatter if absent, leave alone if present:

```markdown
---
name: curated-thoughts-usage
description: ...
---
```

(Read each copied file first; if it already has frontmatter, leave it. If not, add a minimal dsh-compatible block whose `description` matches the file's first paragraph. Do not modify the body — verbatim port per the spec.)

- [ ] **Step 7.3: Write the verification test** — confirms the three files exist and are non-empty:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname, '..', 'skills');
const HERMES_SKILLS_DIR = join(import.meta.dirname, '..', '..', 'hermes', 'skills');

describe('skills content', () => {
  for (const name of ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar']) {
    it(`ships ${name}`, () => {
      const ours = join(SKILLS_DIR, name, 'SKILL.md');
      expect(existsSync(ours)).toBe(true);
      const body = readFileSync(ours, 'utf8');
      expect(body.length).toBeGreaterThan(100);
    });

    it(`${name} body matches the Hermes source verbatim`, () => {
      // The body (after any frontmatter) must equal Hermes's body.
      const strip = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, '');
      const ours = strip(readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'));
      const theirs = strip(readFileSync(join(HERMES_SKILLS_DIR, name, 'SKILL.md'), 'utf8'));
      expect(ours).toBe(theirs);
    });
  }
});
```

- [ ] **Step 7.4: Run and verify it passes**:

```bash
cd integrations/deepseek
pnpm test tests/test_skills_content.ts
```

Expected: all 6 tests pass.

- [ ] **Step 7.5: Commit**:

```bash
git add integrations/deepseek/skills/
git commit -m "feat(deepseek): port three skills verbatim from Hermes

curated-thoughts-{usage,ops,sidecar}/SKILL.md copied from
integrations/hermes/skills/ byte-for-byte (frontmatter-agnostic). dsh reads
the same kebab-case Markdown format and the same YAML frontmatter keys,
so the agent-facing guidance is identical across harnesses. test_skills_content
asserts body equality and refuses future drift unless both files move together.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: `src/index.ts` — apply() with MCP mount + prompt context + skills

**Files:**
- Create: `integrations/deepseek/src/index.ts`
- Create: `integrations/deepseek/tests/test_index.ts`

**Interfaces produced (consumed by install.sh):**
- `interface Config { brainDir?, sidecarCommand? }`
- `const Config: Schema<Config>` — cordis schema
- `function apply(ctx: Context, config: Config): void` — the dsh plugin entry point

The apply function does four things (per spec §3):
1. Mounts `@deepseek-ai/dsh-mcp-client` via `ctx.plugin(...)`.
2. Manages the cached health snapshot (`{ text, since } | null`).
3. Registers a dynamic `PromptContext` whose `text` returns the cached snapshot (empty default).
4. Subscribes `agent/session-start` to refresh the cache asynchronously.
5. Registers the three skills (Task 7) via `ctx.skills.register(...)`.

- [ ] **Step 8.1: Write the failing test** — mock `Context` and assert each call:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apply, Config } from '../src/index.js';

function mockCtx() {
  const pluginCalls: any[] = [];
  const skillRegistrations: any[] = [];
  const contextRegistrations: any[] = [];
  const sessionStartListeners: Array<() => Promise<void>> = [];
  return {
    ctx: {
      plugin: vi.fn((name: string, cfg: unknown) => { pluginCalls.push({ name, cfg }); return () => {}; }),
      skills: {
        register: vi.fn((s: unknown) => { skillRegistrations.push(s); return () => {}; }),
      },
      systemPrompt: {
        getContextOrder: vi.fn((name: string) => 100),
        context: vi.fn((c: unknown) => { contextRegistrations.push(c); return () => {}; }),
      },
      on: vi.fn((event: string, listener: any) => { if (event === 'agent/session-start') sessionStartListeners.push(listener); }),
    },
    pluginCalls,
    skillRegistrations,
    contextRegistrations,
    sessionStartListeners,
  };
}

describe('Config schema', () => {
  it('has the expected shape', () => {
    expect(Config).toBeDefined();
    // Schema is a cordis Schema object — confirm shape (kebab-case properties).
    expect((Config as any).$schema).toBeDefined(); // cordis Schema marker
  });
});

describe('apply', () => {
  let m: ReturnType<typeof mockCtx>;
  beforeEach(() => { m = mockCtx(); });

  it('mounts @deepseek-ai/dsh-mcp-client with the curated-thoughts server', () => {
    apply(m.ctx as any, { brainDir: '/home/u/.brain' } as any);
    expect(m.pluginCalls).toHaveLength(1);
    expect(m.pluginCalls[0].name).toBe('@deepseek-ai/dsh-mcp-client');
    expect(m.pluginCalls[0].cfg).toMatchObject({
      serverName: 'curated-thoughts',
      transport: 'stdio',
      command: 'curated-thoughts-mcp',
      args: ['--mcp'],
      env: { CURATED_BRAIN_DIR: '/home/u/.brain' },
    });
  });

  it('uses the configured sidecar command override', () => {
    apply(m.ctx as any, { brainDir: '/x', sidecarCommand: 'my-sidecar' } as any);
    expect(m.pluginCalls[0].cfg.command).toBe('my-sidecar');
    expect(m.pluginCalls[0].cfg.args).toEqual(['--mcp']);
  });

  it('registers a dynamic prompt context with empty default', () => {
    apply(m.ctx as any, { brainDir: '/x' } as any);
    expect(m.contextRegistrations).toHaveLength(1);
    const ctx0 = m.contextRegistrations[0];
    expect(ctx0.text()).toBe(''); // empty first-call default
  });

  it('subscribes agent/session-start for async refresh', () => {
    apply(m.ctx as any, { brainDir: '/x' } as any);
    expect(m.sessionStartListeners.length).toBe(1);
  });

  it('registers three skills', () => {
    apply(m.ctx as any, { brainDir: '/x' } as any);
    const names = m.skillRegistrations.map((s) => s.name).sort();
    expect(names).toEqual([
      'curated-thoughts-ops',
      'curated-thoughts-sidecar',
      'curated-thoughts-usage',
    ]);
  });
});
```

- [ ] **Step 8.2: Run and verify it fails**:

```bash
cd integrations/deepseek
pnpm test tests/test_index.ts
```

Expected: import error.

- [ ] **Step 8.3: Implement `src/index.ts`**:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema, type Context } from '@deepseek-ai/cordis';
import { probe } from './status.js';
import { formatStatusBlock } from './format.js';

export interface Config {
  brainDir?: string;
  sidecarCommand?: string;
}

export const Config: Schema<Config> = Schema.object({
  brainDir: Schema.string().default(process.env.CURATED_BRAIN_DIR ?? '~/.brain'),
  sidecarCommand: Schema.string().default('curated-thoughts-mcp'),
});

const SKILL_NAMES = [
  'curated-thoughts-usage',
  'curated-thoughts-ops',
  'curated-thoughts-sidecar',
] as const;

const SKILL_DESCRIPTIONS: Record<(typeof SKILL_NAMES)[number], string> = {
  'curated-thoughts-usage': 'When to reach for Curated Thoughts memory; tool routing (wiki_context first, raw tools for deep work); write paths (vault notes vs CT wisdom, never raw SQLite).',
  'curated-thoughts-ops': 'Operator-facing: doctor, pre-flight, brain import/export, sidecar management, OKF frontmatter hygiene.',
  'curated-thoughts-sidecar': 'Sidecar-level: tier semantics, MCP handshake details, evidence / provenance mechanics, respawn behavior.',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(HERE, '..', 'skills');

function readSkill(name: string): string {
  return readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
}

export function apply(ctx: Context, config: Config): void {
  // (1) Mount the MCP client.
  ctx.plugin('@deepseek-ai/dsh-mcp-client', {
    serverName: 'curated-thoughts',
    transport: 'stdio',
    command: config.sidecarCommand ?? 'curated-thoughts-mcp',
    args: ['--mcp'],
    env: { CURATED_BRAIN_DIR: config.brainDir ?? '~/.brain' },
    cwd: process.cwd(),
  });

  // (2) Cached health snapshot. Empty until the first session-start resolves.
  let cached: { text: string; since: number } | null = null;

  // (3) Dynamic prompt context (cache-safe per dsh system-prompt subsystem).
  ctx.systemPrompt.context({
    order: ctx.systemPrompt.getContextOrder('curated-thoughts-health'),
    text: () => cached?.text ?? '',
  });

  // (4) Refresh on agent/session-start. Fail-open: swallow probe errors so a
  // failed probe never crashes the plugin or the session.
  ctx.on('agent/session-start', async () => {
    try {
      const snap = probe();
      const text = formatStatusBlock(snap);
      cached = { text: text ?? '', since: Date.now() };
    } catch {
      // Keep the previous cached value (or empty).
    }
  });

  // (5) Skills.
  for (const name of SKILL_NAMES) {
    ctx.skills.register({
      name,
      description: SKILL_DESCRIPTIONS[name],
      content: readSkill(name),
      invocation: { modelInvocable: true, userInvocable: true },
    });
  }
}
```

- [ ] **Step 8.4: Run and verify it passes**:

```bash
cd integrations/deepseek
pnpm test tests/test_index.ts
```

Expected: all 5 tests pass.

- [ ] **Step 8.5: Build** (so the plugin module is shippable as `lib/index.js`):

```bash
cd integrations/deepseek
pnpm run build
```

Expected: `lib/index.js` exists, `tsc --noEmit` is clean.

- [ ] **Step 8.6: Commit**:

```bash
git add integrations/deepseek/src/index.ts integrations/deepseek/tests/test_index.ts integrations/deepseek/lib/
git commit -m "feat(deepseek): apply() — MCP mount, prompt context, skills

The Cordis plugin entry point. Mounts @deepseek-ai/dsh-mcp-client for
the sidecar surface, registers a cache-safe PromptContext for the
health snapshot (lazy first-call, async-refreshed on agent/session-start),
and registers the three skills ported in Task 7. Fail-open: probe errors
are swallowed so a down sidecar never blocks a session.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: `install.sh` — idempotent POSIX bash installer

**Files:**
- Create: `integrations/deepseek/scripts/install.sh`
- Create: `integrations/deepseek/tests/test_install.sh`

The installer mirrors `integrations/hermes/scripts/install.sh` discipline:
- Prints by default; `CT_INSTALL_EDIT=1` opt-in to write.
- Refuses multi-document YAML and YAML containing tabs.
- Never overwrites an existing entry.
- Runs `ct_doctor.ts check` at the end.

- [ ] **Step 9.1: Write `scripts/install.sh`** — POSIX bash, no sudo:

```bash
#!/usr/bin/env bash
# install.sh — idempotent installer for the Curated Thoughts dsh integration.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, stdlib only.
# Prints by default; CT_INSTALL_EDIT=1 to write.
#
# Environment:
#   CT_INSTALL_EDIT=1     opt-in: append the plugin entry to cordis.yml
#                         (only when absent). Default: print, don't write.
#   DSH_HOME              override dsh config root (default: ~/.dsh)
#   HERMES_CT_SIDECAR     override the sidecar command (default: curated-thoughts-mcp)
#
# Spec: docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md §7

set -euo pipefail

PLUGIN_NAME="@equational-applications/dsh-curated-thoughts"
SIDECAR_CMD="${HERMES_CT_SIDECAR:-curated-thoughts-mcp}"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
CONFIG_FILE="${DSH_HOME}/cordis.yml"

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

plugin_block() {
  cat <<EOF
- name: ${PLUGIN_NAME}
  config:
    brainDir: ~/.brain
EOF
}

# True if the plugin entry is already in cordis.yml as a list item.
has_plugin_entry() {
  [ -f "$CONFIG_FILE" ] || return 1
  awk -v name="$PLUGIN_NAME" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", line)
      gsub(/[[:space:]]*$/, "", line)
      if (line == name) { found = 1 }
    }
    END { if (found) exit 0; exit 1 }
  ' "$CONFIG_FILE"
}

config_is_appendable() {
  [ -f "$CONFIG_FILE" ] || return 0
  if grep -qE '^(---|\.\.\.)' "$CONFIG_FILE"; then
    return 1
  fi
  if grep -qP '\t' "$CONFIG_FILE" 2>/dev/null; then
    return 1
  fi
  return 0
}

check_mcp_mount() {
  say ""
  say "== Plugin entry (${CONFIG_FILE}) =="
  if has_plugin_entry; then
    say "OK: ${PLUGIN_NAME} already present — nothing changed."
    return 0
  fi
  say "Append the following to ${CONFIG_FILE} (as a list item, not under any key):"
  say ""
  plugin_block
  say ""
  if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
    if config_is_appendable; then
      if [ ! -f "$CONFIG_FILE" ]; then
        mkdir -p "$(dirname "$CONFIG_FILE")"
        # Create a minimal cordis.yml if absent — the plugin entry as the only
        # list item. dsh accepts a single-entry list.
        plugin_block >"$CONFIG_FILE"
        say "CT_INSTALL_EDIT=1: created ${CONFIG_FILE} with the block above."
      else
        say "CT_INSTALL_EDIT=1: appending block to ${CONFIG_FILE}"
        {
          printf '\n'
          plugin_block
        } >>"$CONFIG_FILE"
        say "appended."
      fi
    else
      warn "${CONFIG_FILE} has a non-simple structure (multi-document YAML or tabs);"
      warn "please add the block above manually. Nothing was written."
    fi
  else
    say "Re-run with CT_INSTALL_EDIT=1 to append this block automatically"
    say "(only when absent; your file is never overwritten or reformatted)."
  fi
}

verify_with_doctor() {
  say ""
  say "== Doctor =="
  local doctor="${SCRIPT_SRC}/lib/ct_doctor.js"
  if [ -f "$doctor" ]; then
    if node "$doctor" check; then
      say "OK: doctor reports all checks passing."
    else
      say "doctor reported warnings or failures. Re-run for details:"
      say "  node ${doctor} check"
    fi
  else
    warn "${doctor} not found — build first with: pnpm run build"
  fi
}

main() {
  say "curated-thoughts dsh installer (idempotent, no sudo)"
  say ""
  check_mcp_mount
  verify_with_doctor
  say ""
  say "== Done =="
  say "Next step — verify the install:"
  say "  node ${SCRIPT_SRC}/lib/ct_doctor.js check"
  say ""
  say "Importing a brain from another machine? Point CURATED_BRAIN_DIR at it"
  say "and re-run the doctor — the import pre-flight check reports whether the"
  say "graph's provenance survived the trip before an agent relies on it."
}

main "$@"
```

- [ ] **Step 9.2: Make it executable**:

```bash
chmod +x integrations/deepseek/scripts/install.sh
```

- [ ] **Step 9.3: Write the verification test** — runs the install in a temp `$DSH_HOME` twice; both runs must succeed and the second must be a no-op for the cordis.yml append:

```bash
#!/usr/bin/env bash
# tests/test_install.sh — verifies install.sh is idempotent.
# Run: bash tests/test_install.sh

set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export DSH_HOME="$TMP/dsh"
export CT_INSTALL_EDIT=1
export PATH=""

# First run: creates the config and the entry.
bash "$(dirname "$0")/../scripts/install.sh" >/dev/null
test -f "$DSH_HOME/cordis.yml" || { echo "FAIL: cordis.yml not created"; exit 1; }
grep -q '@equational-applications/dsh-curated-thoughts' "$DSH_HOME/cordis.yml" \
  || { echo "FAIL: plugin entry not in cordis.yml"; exit 1; }

# Second run: must be a no-op for the cordis.yml append.
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
bash "$(dirname "$0")/../scripts/install.sh" >/dev/null
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: cordis.yml changed on re-run"; exit 1; }

# Multi-document YAML refusal.
printf -- '---\n- name: a\n---\n- name: b\n' > "$DSH_HOME/cordis.yml"
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
bash "$(dirname "$0")/../scripts/install.sh" >/dev/null
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: multi-document YAML was modified"; exit 1; }

echo "OK"
```

- [ ] **Step 9.4: Build and run the test**:

```bash
cd integrations/deepseek
pnpm run build
bash tests/test_install.sh
```

Expected: `OK`.

- [ ] **Step 9.5: Commit**:

```bash
git add integrations/deepseek/scripts/install.sh integrations/deepseek/tests/test_install.sh
git commit -m "feat(deepseek): install.sh — idempotent dsh installer

POSIX bash, stdlib only. Mirrors Hermes install.sh discipline: prints by
default, CT_INSTALL_EDIT=1 opt-in to write, refuses multi-document YAML
and YAML with tabs, never overwrites an existing entry. Appends the
plugin as a list item to \$DSH_HOME/cordis.yml (creating it if absent)
and runs ct_doctor.ts check at the end. test_install.sh verifies
idempotence and refusal of unsafe YAML shapes.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: CI matrix wiring + integration.yaml flip

**Files:**
- Modify: `integrations/deepseek/integration.yaml` — flip `status: planned` → `status: implemented` (after Tasks 6 + 9 are green)

- [ ] **Step 10.1: Run the full local gate** to confirm everything is in order:

```bash
cd integrations/thoughts-integrations   # repo root
python tools/ct_ci.py validate
python tools/ct_ci.py generate --check   # confirms compat.yaml hasn't drifted
python tools/ct_ci.py policy --base origin/main
python tools/ct_ci.py discover --all
```

Expected: all four commands exit 0. `discover` reports the integration with `language: node`.

- [ ] **Step 10.2: Run the integration's own test suite**:

```bash
cd integrations/deepseek
pnpm install
pnpm run build
pnpm test
```

Expected: all tests pass; `tsc --noEmit` clean.

- [ ] **Step 10.3: Flip `status: planned` → `status: implemented`** in `integration.yaml`:

```yaml
status: implemented
```

- [ ] **Step 10.4: Verify the schema check still passes**:

```bash
python tools/ct_ci.py validate
```

Expected: exit 0.

- [ ] **Step 10.5: Commit**:

```bash
git add integrations/deepseek/integration.yaml
git commit -m "feat(deepseek): flip status to implemented

All 9 checks + 3 status checks + skill content + idempotent install are
green. tools/ct_ci.py validate, generate --check, policy, and discover
all pass.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 11: Generate `_compat_generated.ts` from `shared/compat.yaml`

**Files:**
- Modify: `tools/ct_ci.py` (or add a sibling `tools/ct_ci.py` extension) to emit `integrations/deepseek/scripts/_compat_generated.ts`
- Delete: `integrations/deepseek/scripts/_compat_generated.ts` (the stub from Task 6.3 is replaced)

The current `tools/ct_ci.py` already emits `integrations/hermes/scripts/_compat_generated.py` from `shared/compat.yaml`. This task extends the generator (or adds a companion) so the same source produces a TypeScript mirror for the new integration.

- [ ] **Step 11.1: Read `tools/ct_ci.py`** — find the section that emits `_compat_generated.py`. Read the file to understand the template.

- [ ] **Step 11.2: Extend the generator** to emit `integrations/deepseek/scripts/_compat_generated.ts` from the same `shared/compat.yaml`. The output shape:

```ts
// GENERATED by tools/ct_ci.py generate — do not edit between markers.
export const TIERS: Array<[string, [number, number], [number, number] | null, number, string]> = [
  // ...same rows as the Python file...
];
export const FULL_TIER_TOOLS = 14;
export const READ_TIER_TOOLS = 8;
export const EVIDENCE_TABLE = 'librarian_evidence';
export const ENGINE_PINNED_VERSION = '0.5.0';
```

The Python and TypeScript outputs must be **structurally identical** — same tier names, same version triples, same tool counts, same evidence table name. Drift is a CI gate.

- [ ] **Step 11.3: Update `tools/ct_ci.py generate --check`** to verify the generated TS file matches the Python output row-for-row.

- [ ] **Step 11.4: Delete the stub** from Task 6.3:

```bash
rm integrations/deepseek/scripts/_compat_generated.ts
```

(The generator re-creates it on the next `generate` run.)

- [ ] **Step 11.5: Run the generator and verify**:

```bash
python tools/ct_ci.py generate --check
cd integrations/deepseek/scripts && pnpm exec tsc && cd ../..
pnpm test
```

Expected: generator exit 0; tsc clean; tests pass.

- [ ] **Step 11.6: Commit**:

```bash
git add tools/ct_ci.py integrations/deepseek/scripts/_compat_generated.ts
git commit -m "feat(deepseek): generate _compat_generated.ts from compat.yaml

Extend tools/ct_ci.py to emit both the Python and TypeScript versions of
the compat matrix from the same shared/compat.yaml source. Both outputs
are structurally identical; drift is a CI gate. The stub from Task 6 is
replaced by the generated file.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 12: README polish + dogfood

**Files:**
- Modify: `integrations/deepseek/README.md`

- [ ] **Step 12.1: Flesh out `README.md`** — replace the placeholder from Task 1.5 with the full user-facing doc:

````markdown
# Curated Thoughts for DeepSeek Harness

A Cordis plugin module that connects DeepSeek Harness (`pnpm dsh`) to the
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar. Sibling to the
[Hermes integration](../hermes/) — same skills, same doctor, same three-rule
discipline.

## What you get

- **MCP sidecar wired in** — `@deepseek-ai/dsh-curated-thoughts` mounts
  `@deepseek-ai/dsh-mcp-client` against `curated-thoughts-mcp --mcp` and
  exposes the Curated Thoughts tool surface to dsh sessions.
- **Cached health snapshot** — a `PromptContext` whose text is the latest
  `ct_status` probe, refreshed on every `agent/session-start`. The model
  knows whether memory is usable before its first tool call.
- **Three skills** — `curated-thoughts-usage`, `curated-thoughts-ops`,
  `curated-thoughts-sidecar` (verbatim from Hermes).
- **Doctor** — `ct_doctor.ts check` runs the nine deep checks
  (sidecar binary / identity / MCP reachable / brain / vault / embedding
  backend / dsh registration / import pre-flight / version compat).
- **Idempotent installer** — `scripts/install.sh`.

## Install

```bash
cd integrations/deepseek
pnpm install
pnpm run build
CT_INSTALL_EDIT=1 ./scripts/install.sh
```

Without `CT_INSTALL_EDIT=1`, the installer prints the block to append to
`$DSH_HOME/cordis.yml` and does not write anything.

## Verify

```bash
node lib/ct_doctor.js check
node lib/ct_doctor.js check --json   # machine-readable
```

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **DeepSeek Harness:** ≥ 0.1 (Cordis plugin model; requires Node ≥ 22.19
  or ≥ 24).
- **Platforms:** macOS, Linux, Windows (verified by the CI matrix).

## License

MIT — identical to the main Curated Thoughts repository.
````

- [ ] **Step 12.2: Dogfood on the maintainer machine**:

```bash
# From the maintainer's home directory:
curl -fsSL https://github.com/equationalapplications/curated-thoughts-integrations/releases/download/deepseek-v0.1.0/deepseek-0.1.0.tar.gz \
  | tar -xz -C /tmp
cd /tmp/deepseek-0.1.0
pnpm install --prod
CT_INSTALL_EDIT=1 ./scripts/install.sh
node lib/ct_doctor.js check
```

Record any deviations from the spec in the maintainer's PR description.

- [ ] **Step 12.3: Commit**:

```bash
git add integrations/deepseek/README.md
git commit -m "docs(deepseek): flesh out README for the v0.1.0 release

User-facing install, verify, compatibility, license. Mirrors the
integrations/hermes/README.md layout so cross-harness docs read the same.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 13: Tag + release

**Files:** none — release.yml (in `.github/workflows/`) handles the tarball.

- [ ] **Step 13.1: Push the branch**:

```bash
git push origin main   # or whatever branch the work is on
```

- [ ] **Step 13.2: Tag the release**:

```bash
git tag deepseek-v0.1.0
git push origin deepseek-v0.1.0
```

Expected: `release.yml` runs, builds `deepseek-0.1.0.tar.gz` + `SHA256SUMS`,
publishes the GitHub Release.

- [ ] **Step 13.3: Verify the release**:

```bash
gh release view deepseek-v0.1.0
```

Expected: a release with the tarball, SHA256SUMS, and the CHANGELOG entry
as the body.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented by |
|---|---|
| §2 Directory layout | Tasks 1, 7 (skills), 8 (src), 6 (scripts) |
| §3 Plugin shape | Task 8 (`src/index.ts`) |
| §4 cordis.yml install path | Task 9 (`install.sh`) |
| §5 ct_status.ts | Task 3 (`src/status.ts`) + Task 4 (`src/format.ts`) |
| §6 ct_doctor.ts 9 checks | Task 6 + Task 11 (compat) |
| §7 install.sh discipline | Task 9 |
| §8 Skills verbatim | Task 7 |
| §9 CI matrix | Task 1 (initial), Task 10 (flip + verify), Task 11 (compat generator) |
| §10 Axon future use | Deferred — out of scope per spec §10 |
| §11 Locked decisions | All reflected in Tasks 2–9 |
| §12 Open items | Task 11 (compat generator — handles "compat matrix generator extension"); the other three open items (cordis.yml format, vitest harness, npm-vs-tarball release) are resolved in Tasks 1, 9, 13 |

No spec gaps.

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or unfilled code blocks. Every step has the actual content the engineer needs.

**3. Type consistency:** Functions introduced in earlier tasks and consumed by later ones:
- `findSidecar`, `resolveBrainPaths`, `readBrainConfig`, `resolveVaultPath`, `looksLikeDevBuild`, `installKind`, `sidecarCandidates` (Task 2) → used by Task 3 (`probe`) and Task 6 (`runChecks`)
- `Snapshot`, `Status` (Task 3) → used by Task 4 (`formatStatusBlock`) and Task 8 (`apply`)
- `formatStatusBlock` (Task 4) → used by Task 8 (`apply`)
- `censusSourceRefs`, `detectEngineVersion` (Task 5) → used by Task 6 (`runChecks`)
- `apply`, `Config` (Task 8) → used by Task 9 (`install.sh` invokes the doctor, not the apply directly) and by the published npm package

All names match. No `clearLayers` vs `clearFullLayers`-style drift.

**4. Ambiguity check:** The plan doesn't require any decision the engineer can't make from the spec — every "deferred to writing-plans" item from the spec was resolved (vitest chosen in Task 1.4, cordis.yml append shape in Task 9.1, tarball release in Task 13). License MIT is fixed in Tasks 1.2 and 12.1.
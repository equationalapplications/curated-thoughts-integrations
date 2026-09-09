/**
 * ct_env.ts — Curated Thoughts environment resolution, shared by the doctor,
 * the session-start hook, and the DeepSeek Harness integration entry point.
 *
 * Single source of truth for three things the integration kept getting wrong:
 *
 * 1. **The brain directory** is resolved exactly the way Curated Thoughts
 *    resolves it (`src-tauri/src/retrieval/mod.rs::resolve_brain_paths`):
 *    `CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`, defaulting
 *    to `~/.brain`. There is no `CT_VAULT_DIR` — that variable never existed in
 *    Curated Thoughts and nothing reads it.
 *
 * 2. **The brain directory is not the vault.** The brain dir holds `brain.db`
 *    and `config.json`; the *vault* is the documents tree, whose path lives in
 *    `config.json` under `vault_path` and is machine-specific (which is why it
 *    is always wrong immediately after importing a brain from another machine).
 *
 * 3. **Sidecar discovery is platform-shaped.** Curated Thoughts ships on macOS,
 *    Linux and Windows. The sidecar is a Tauri `externalBin`, so it lives inside
 *    the app bundle on macOS and next to the app executable on Windows — not
 *    only in `/usr/bin`.
 *
 * Stdlib only. Every function is read-only and non-raising.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';

export const SIDECAR_NAME = 'curated-thoughts-mcp';

// Env vars Curated Thoughts actually reads (README "Environment Variables"
// table + retrieval/mod.rs). Kept here so every caller uses the same names.
export const ENV_BRAIN_DIR = 'CURATED_BRAIN_DIR';
export const ENV_BRAIN_DB = 'CURATED_BRAIN_DB';
export const ENV_BRAIN_CONFIG = 'CURATED_BRAIN_CONFIG';


function expandHome(p: string, env: NodeJS.ProcessEnv = process.env): string {
  /** Expand a leading ~ the way CT's doctor does, then return a string. */
  if (p.startsWith('~')) {
    const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
    return join(home, p.slice(1));
  }
  return p;
}


export interface BrainPaths {
  /** Resolved brain layout. Mirrors CT's `BrainPaths` struct. */
  brainDir: string;
  dbPath: string;
  configPath: string;
}


export function resolveBrainPaths(env: NodeJS.ProcessEnv = process.env): BrainPaths {
  /** Resolve the brain layout from the environment.
   *
   * Port of `resolve_brain_paths()` in curated-thoughts
   * (src-tauri/src/retrieval/mod.rs), including the rule that
   * `CURATED_BRAIN_CONFIG` wins, else config.json sits beside an explicitly
   * configured `CURATED_BRAIN_DB`, else beside the brain dir.
   */
  const brainDir = env[ENV_BRAIN_DIR]
    ? expandHome(env[ENV_BRAIN_DIR]!, env)
    : expandHome('~/.brain', env);

  let dbPath: string;
  if (env[ENV_BRAIN_DB]) {
    dbPath = expandHome(env[ENV_BRAIN_DB]!, env);
  } else {
    dbPath = join(brainDir, 'brain.db');
  }

  let configPath: string;
  if (env[ENV_BRAIN_CONFIG]) {
    configPath = expandHome(env[ENV_BRAIN_CONFIG]!, env);
  } else if (env[ENV_BRAIN_DB]) {
    // Hermes parity (ct_env.py): config.json sits BESIDE an explicit
    // CURATED_BRAIN_DB, not in brainDir — split layouts (db on one path,
    // config next to it) otherwise probe the wrong directory and report a
    // false degraded/FAIL.
    configPath = join(dirname(dbPath), 'config.json');
  } else {
    configPath = join(brainDir, 'config.json');
  }

  return { brainDir, dbPath, configPath };
}


export function readBrainConfig(
  configPath: string,
): { config: Record<string, unknown> | null; error: string | null } {
  /** Read config.json. Returns (config_dict|None, error|None). Never raises. */
  if (!existsSync(configPath)) {
    return { config: null, error: `config.json missing: ${configPath}` };
  }
  let text: string;
  try {
    text = readFileSync(configPath, { encoding: 'utf8' });
  } catch (e) {
    return { config: null, error: `unreadable: ${(e as Error).message}` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { config: null, error: `malformed JSON: ${(e as Error).message}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { config: null, error: 'root is not a JSON object' };
  }
  return { config: data as Record<string, unknown>, error: null };
}


export function resolveVaultPath(
  config: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): { vault: string | null; error: string | null } {
  /** Extract the vault path from a parsed config.json.
   *
   * Returns (Path|None, error|None). CT treats a non-string `vault_path` as a
   * hard config error (config/mod.rs), so we report that shape rather than
   * coercing it.
   */
  if (config === null) {
    return { vault: null, error: 'no config' };
  }
  if (!('vault_path' in config)) {
    return { vault: null, error: 'vault_path not set in config.json' };
  }
  const raw = config['vault_path'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { vault: null, error: 'vault_path is present but not a non-empty string' };
  }
  return { vault: expandHome(raw, env), error: null };
}


// --------------------------------------------------------------------------
// platform-aware sidecar discovery
// --------------------------------------------------------------------------

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const exe = SIDECAR_NAME + '.exe';
  const roots = [
    env['LOCALAPPDATA'] ?? '',
    env['PROGRAMFILES'] ?? '',
    env['ProgramFiles(x86)'] ?? '',
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    out.push(join(root, 'Programs', 'Curated Thoughts', exe));
    out.push(join(root, 'Curated Thoughts', exe));
  }
  return out;
}


function macosCandidates(env: NodeJS.ProcessEnv): string[] {
  // Tauri externalBin sidecars are staged next to the app executable inside
  // the bundle; both the system and per-user Applications dirs are valid.
  const rel = ['Curated Thoughts.app', 'Contents', 'MacOS', SIDECAR_NAME];
  return [
    ['/Applications', ...rel].join(sep),
    [expandHome('~/Applications', env), ...rel].join(sep),
  ];
}


function linuxCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    join('/usr', 'bin', SIDECAR_NAME),
    join('/usr', 'local', 'bin', SIDECAR_NAME),
    join(expandHome('~/.local/bin', env), SIDECAR_NAME),
    join('/opt', 'curated-thoughts', SIDECAR_NAME),
  ];
}


export function sidecarCandidates(
  platform: NodeJS.Platform = osPlatform(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  /** Ordered, platform-appropriate fallback locations for the sidecar. */
  // ~/.local/bin is the user-level cargo install path, present on every
  // platform. Including it everywhere means downstream tools can install
  // there on macOS or Windows too, and the doctor will still find the sidecar.
  const userLocalBin = join(expandHome('~/.local/bin', env), SIDECAR_NAME);
  let platformSpecific: string[];
  if (platform === 'darwin') {
    platformSpecific = macosCandidates(env);
  } else if (platform === 'win32' || platform.startsWith('win')) {
    platformSpecific = windowsCandidates(env);
  } else {
    platformSpecific = linuxCandidates(env);
  }
  return [userLocalBin, ...platformSpecific];
}


/** True iff `p` is executable by this user, mirroring Hermes's platform
 * behavior: POSIX files need the X_OK bit (shutil.which / os.access X_OK);
 * on win32 every file is executable (there is no executable bit). */
function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32' || platform.startsWith('win')) return true;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}


function whichOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = osPlatform(),
): string | null {
  /** Minimal POSIX/Windows equivalent of Python's `shutil.which`.
   *
   * Splits `env.PATH` on the platform separator and returns the first entry
   * naming an existing file. On Windows the bare name alone can never
   * resolve — CreateProcess-style lookup also probes PATHEXT-appended
   * candidates (`.exe`, `.cmd`, `.bat`, ...), so those are tried in order.
   */
  // The separator follows the platform, not the PATH string: a single-entry
  // Windows PATH ("C:\...\bin") contains no ';' but does contain the drive
  // colon, so sniffing split on ':' and broke the probe. shutil.which uses
  // os.pathsep; this mirrors that.
  const pathSep = platform === 'win32' || platform.startsWith('win') ? ';' : ':';
  const dirs = (env.PATH ?? '').split(pathSep).filter((d) => d.length > 0);
  const exts =
    platform === 'win32' || platform.startsWith('win')
      ? [
          '',
          ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter((e) => e.length > 0)
            .map((e) => e.toLowerCase()),
        ]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      // shutil.which filters by X_OK — mirror that (no-op on win32).
      if (existsSync(candidate) && isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}


export function findSidecar(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = osPlatform(),
): { path: string; resolved: string; source: string } | null {
  /** Locate the sidecar. Returns (path|None, realpath|None, source).
   *
   * `source` is "PATH" or "bundled" so callers can explain where it came from
   * without re-deriving the search order.
   */
  const found = whichOnPath(SIDECAR_NAME, env, platform);
  if (found) {
    let resolved = found;
    try {
      resolved = realpathSync(found);
    } catch {
      resolved = found;
    }
    return { path: found, resolved, source: 'PATH' };
  }
  for (const cand of sidecarCandidates(platform, env)) {
    try {
      // Hermes parity (ct_env.py): bundled candidates require os.access
      // X_OK too (no-op on win32, where every file is executable).
      if (existsSync(cand) && isExecutable(cand, platform)) {
        let resolved = cand;
        try {
          resolved = realpathSync(cand);
        } catch {
          resolved = cand;
        }
        return { path: cand, resolved, source: 'bundled' };
      }
    } catch {
      continue;
    }
  }
  return null;
}


// Path segments that mark a development build rather than an installed one.
// This is the OS-agnostic replacement for the old dpkg-prefix test: what
// actually matters is "is this a stray build output shadowing the installed
// sidecar", which looks the same on every platform.
const DEV_BUILD_MARKERS: readonly string[] = [
  'target/debug',
  'target/release',
  'target\\debug',
  'target\\release',
  '/tools/',
  '\\tools\\',
];


export function looksLikeDevBuild(resolvedPath: string | null | undefined): boolean {
  /** True if a resolved sidecar path looks like a source-checkout build. */
  if (!resolvedPath) return false;
  const lowered = resolvedPath.replace(/\\/g, '/').toLowerCase();
  for (const marker of DEV_BUILD_MARKERS) {
    if (lowered.includes(marker.replace(/\\/g, '/').toLowerCase())) {
      return true;
    }
  }
  return false;
}


export function installKind(
  resolvedPath: string | null | undefined,
  _platform: NodeJS.Platform = osPlatform(),
): 'homebrew' | 'deb' | 'app-bundle' | 'system-package' | 'windows-install' | 'dev-build' | 'other' | 'unknown' {
  /** Classify an installed sidecar location for human-readable output. */
  if (!resolvedPath) return 'unknown';
  const p = String(resolvedPath).replace(/\\/g, '/');
  if (looksLikeDevBuild(p)) return 'dev-build';
  if (p.includes('.app/Contents/MacOS')) return 'app-bundle';
  if (p.includes('/homebrew/') || p.includes('/Cellar/')) return 'homebrew';
  if (p.startsWith('/usr/bin/') || p.startsWith('/usr/local/bin/')) return 'deb';
  if (p.startsWith('/usr/') || p.startsWith('/opt/')) return 'system-package';
  if (p.includes('/Programs/') || p.includes('/Program Files')) return 'windows-install';
  return 'other';
}
/**
 * ct_doctor.ts — install/health doctor for the Curated Thoughts OpenClaw
 * plugin.
 *
 * 1:1 port of integrations/hermes/scripts/ct_doctor.py. The 10 checks run in
 * the same order and the exit codes (0/1/2) match. Differences from Hermes:
 *
 *   - sidecar-env inspects the user mcp.servers["curated-thoughts"] row
 *     (OpenClaw gives a plugin-declared stdio server only the MCP SDK's
 *     default env), where Hermes inspects mcp_servers.curated-thoughts.env.
 *
 *   - Sidecar identity uses the shared ct_env.ts helpers (Task 2).
 *   - openclaw-registration reads OpenClaw's JSON5 config
 *     (`$OPENCLAW_CONFIG_PATH`, else `$OPENCLAW_STATE_DIR/openclaw.json`,
 *     default ~/.openclaw/openclaw.json) for the plugin entry and its
 *     `hooks.allowConversationAccess` grant. Hermes checks
 *     ~/.hermes/config.yaml's `mcp_servers:` block + `plugins.enabled`.
 *
 *   - Engine version + source-ref census come from ct_preflight.ts (Task 5).
 *
 * Read-only diagnostic. NEVER writes to the vault, the brain, or any config
 * file. Every check resolves to PASS / WARN / FAIL with an actionable fix
 * hint.
 *
 * Exit codes: 0 = all PASS, 1 = any FAIL, 2 = no FAIL but at least one WARN.
 *
 * Spec: docs/superpowers/specs/2026-10-16-openclaw-wisdom-parity-leg-design.md
 * (ported from the deepseek doctor, 2026-09-09 deepseek design §6).
 * Tier matrix: shared/compat.yaml (consumed via _compat_generated.ts, which
 * `tools/ct_ci.py generate` emits and CI byte-compares).
 * Environment contract: scripts/ct_env.ts.
 * Import pre-flight: scripts/ct_preflight.ts.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ENV_BRAIN_DIR,
  SIDECAR_NAME,
  expandHome,
  findSidecar as ctEnvFindSidecar,
  installKind as ctEnvInstallKind,
  looksLikeDevBuild as ctEnvLooksLikeDevBuild,
  readBrainConfig as ctEnvReadBrainConfig,
  resolveBrainPaths as ctEnvResolveBrainPaths,
  resolveVaultPath as ctEnvResolveVaultPath,
  sidecarCandidates as ctEnvSidecarCandidates,
  type BrainPaths,
} from './ct_env.js';
import * as ctPreflight from './ct_preflight.js';
import {
  TIERS,
  FULL_TIER_TOOLS,
  READ_TIER_TOOLS,
  EVIDENCE_TABLE,
  ENGINE_PINNED_VERSION,
} from './_compat_generated.js';

// --------------------------------------------------------------------------
// constants
// --------------------------------------------------------------------------

export const PASS = 'PASS';
export const WARN = 'WARN';
export const FAIL = 'FAIL';

export type Status = typeof PASS | typeof WARN | typeof FAIL;

export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}


// Embedding backends: cloud keys OR a local Ollama. WARN-only check.
const EMBED_ENV_KEYS: readonly string[] = [
  'CT_EMBED_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'VOYAGE_API_KEY',
  'GEMINI_API_KEY',
];
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

// MCP handshake timeout (seconds) — the sidecar must never hang the doctor.
const MCP_TIMEOUT = 10.0;

// Tier matrix + counters. _compat_generated.ts is the binding source of truth:
// it is generated from shared/compat.yaml and verified in CI, so these values
// must never be restated as literals here or in ct_preflight.ts.
type CompatTier = readonly [string, readonly [number, number], readonly [number, number] | null, number, string];
// Defensive filter: tierFor compares against the lower bound unconditionally,
// so a future compat.yaml tier without one would crash it at runtime. Drop
// such tiers here instead (the generated TIERS type allows a null lower bound).
const COMPAT_TIERS: ReadonlyArray<CompatTier> =
  (TIERS as unknown as ReadonlyArray<CompatTier>).filter(
    (t): t is CompatTier => t[1] !== null,
  );

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const VERSION_RE = /\b(\d+)\.(\d+)(?:\.(\d+))?\b/;

export function parseVersion(text: string): [number, number, number] | null {
  /** Extract a leading dotted version like '2.4.3' from free text. */
  const m = text ? VERSION_RE.exec(text) : null;
  if (!m) return null;
  return [Number(m[1]!), Number(m[2]!), Number(m[3] ? Number(m[3]) : 0)];
}

export function tierFor(version: [number, number, number]): CompatTier | null {
  /** Return the compat tier tuple for a sidecar version triple, or null.
   *
   * Tuple comparison: `v >= lo` is `(v[0], v[1]) >= (lo[0], lo[1])`; `v < hi`
   * is the same lexicographic order.
   */
  const v: [number, number] = [version[0], version[1]];
  for (const tier of COMPAT_TIERS) {
    const [, lo, hi] = tier;
    if (compareVersionPair(v, lo) >= 0 &&
        (hi === null || compareVersionPair(v, hi) < 0)) {
      return tier;
    }
  }
  return null;
}

function compareVersionPair(a: readonly [number, number], b: readonly [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

export function tierForToolCount(count: number): string | null {
  /** Tier implied by an observed tool count — the authoritative signal. */
  if (count >= FULL_TIER_TOOLS) return 'v2.5-full';
  if (count >= READ_TIER_TOOLS) return 'v2.4-read';
  return null;
}

function _pass(name: string, detail: string): CheckResult {
  return { name, status: PASS, detail };
}

function _warn(name: string, detail: string, hint?: string): CheckResult {
  return { name, status: WARN, detail, hint };
}

function _fail(name: string, detail: string, hint?: string): CheckResult {
  return { name, status: FAIL, detail, hint };
}

function _isReadableDir(path: string): 'ok' | 'missing' | 'not-dir' | 'unreadable' {
  if (!existsSync(path)) return 'missing';
  let s;
  try {
    s = statSync(path);
  } catch {
    return 'unreadable';
  }
  if (!s.isDirectory()) return 'not-dir';
  try {
    accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return 'unreadable';
  }
  return 'ok';
}

// --------------------------------------------------------------------------
// checks
// --------------------------------------------------------------------------

export interface SidecarFound {
  path: string;
  resolved: string;
  source: string;
}

export function findSidecar(
  env: NodeJS.ProcessEnv = process.env,
): SidecarFound | null {
  /** Locate the sidecar. Mirrors `ct_env.findSidecar`'s return shape. */
  return ctEnvFindSidecar(env);
}

export function checkSidecarBinary(
  found?: SidecarFound | null,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  /** (1) sidecar binary present (PATH, then platform install locations). */
  const f = found ?? findSidecar(env);
  if (f) {
    return _pass(
      'sidecar-binary',
      `found ${SIDECAR_NAME} at ${f.path} (via ${f.source})`,
    );
  }
  const searched = ctEnvSidecarCandidates().join(', ');
  return _fail(
    'sidecar-binary',
    `${SIDECAR_NAME} not found on PATH or in any known install location`,
    `Install Curated Thoughts from the project's releases page for your `
      + `platform, or add the sidecar's directory to PATH. Searched: ${searched}`,
  );
}

export function checkSidecarIdentity(
  path: string | null,
  resolved: string | null,
): CheckResult {
  /** (2) sidecar identity — WARN if a source-checkout build shadows the
   * installed one. */
  if (!path) {
    return _warn(
      'sidecar-identity',
      'skipped: no sidecar binary found',
      'Resolve check 1 first; identity cannot be verified without a binary.',
    );
  }
  const r = resolved ?? path;
  if (ctEnvLooksLikeDevBuild(r)) {
    return _warn(
      'sidecar-identity',
      `${path} resolves to a development build (${r})`,
      `'${path}' looks like a build output from a source checkout `
        + `(a target/ or tools/ directory), not an installed Curated `
        + `Thoughts. A same-named dev build shadowing the installed sidecar `
        + `gives two servers on one brain. Remove the stray build, or `
        + `reorder PATH so the installed sidecar wins.`,
    );
  }
  const kind = ctEnvInstallKind(r);
  return _pass(
    'sidecar-identity',
    `${path} resolves to an installed sidecar (${r}, ${kind})`,
  );
}

// --------------------------------------------------------------------------
// JSON-RPC over stdio
// --------------------------------------------------------------------------

export interface McpProbeResult {
  /** Tool names from tools/list, or null when the handshake failed. */
  toolNames: string[] | null;
  /** Server version from initialize response, or null. */
  serverVersion: string | null;
  /** Error string if any, or null. */
  error: string | null;
}

export function mcpToolsList(
  path: string,
  timeout: number = MCP_TIMEOUT,
  env?: NodeJS.ProcessEnv,
): McpProbeResult {
  /** Speak minimal JSON-RPC over stdio: initialize → initialized → tools/list.
   *
   * Synchronous (matches the Python port which uses subprocess.run with
   * timeout). Returns `{ toolNames | null, serverVersion | null, error | null }`.
   * Never throws; every failure mode becomes a result with an error field.
   */
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ct_doctor', version: '0.2.1' },
    },
  });
  const notifMsg = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const toolsMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  const request = `${initMsg}\n${notifMsg}\n${toolsMsg}\n`;

  const runEnv: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };

  let proc: ReturnType<typeof spawnSync>;
  try {
    proc = spawnSync(path, ['--mcp'], {
      input: request,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: runEnv,
      encoding: 'utf8',
      timeout: timeout * 1000,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const msg = err.code === 'ENOENT'
      ? 'binary disappeared'
      : err.code === 'EACCES'
      ? 'binary not executable'
      : `spawn failed: ${err.message}`;
    return { toolNames: null, serverVersion: null, error: msg };
  }

  // Translate spawnSync's failure modes into the (toolNames|null) shape.
  if (proc.error) {
    const err = proc.error as NodeJS.ErrnoException;
    // spawnSync reports a timeout via proc.error (code ETIMEDOUT), before the
    // killSignal fallback below can see SIGKILL — check it first.
    const msg = err.code === 'ETIMEDOUT'
      ? `timed out after ${timeout.toFixed(0)}s`
      : err.code === 'ENOENT'
      ? 'binary disappeared'
      : err.code === 'EACCES'
      ? 'binary not executable'
      : `spawn failed: ${err.message}`;
    return { toolNames: null, serverVersion: null, error: msg };
  }
  if (proc.signal === 'SIGKILL' && proc.status === null) {
    return {
      toolNames: null,
      serverVersion: null,
      error: `timed out after ${timeout.toFixed(0)}s`,
    };
  }

  let serverVersion: string | null = null;
  let toolNames: string[] | null = null;
  let error: string | null = null;
  const stdout = typeof proc.stdout === 'string' ? proc.stdout : (proc.stdout?.toString('utf8') ?? '');
  const stderr = typeof proc.stderr === 'string' ? proc.stderr : (proc.stderr?.toString('utf8') ?? '');
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let msg: {
      id?: number;
      result?: {
        serverInfo?: { version?: string };
        tools?: Array<{ name?: string }>;
      };
      error?: unknown;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1 && msg.result) {
      serverVersion = msg.result.serverInfo?.version ?? null;
    } else if (msg.id === 2) {
      if (msg.result) {
        // `??` only screens null/undefined: a server answering with a
        // non-array `tools` (object, string) would throw TypeError out of
        // .map(), past probeSidecar and runChecks, and break this function's
        // "Never throws" contract with a raw stack trace. Shape-check it, and
        // tolerate a malformed element while we're here.
        toolNames = (Array.isArray(msg.result.tools) ? msg.result.tools : []).map(
          (t) => t?.name ?? '?',
        );
      } else if (msg.error !== undefined) {
        error = `tools/list error: ${JSON.stringify(msg.error).slice(0, 120)}`;
      }
    }
  }
  if (toolNames === null && error === null) {
    const stderrTail = stderr.trim().split('\n').pop()?.slice(0, 120) ?? '';
    error = stderrTail
      ? `no tools/list response on stdout (stderr: ${stderrTail})`
      : 'no tools/list response on stdout';
  }
  return { toolNames, serverVersion, error };
}

export interface SidecarProbe {
  result: CheckResult;
  toolCount: number | null;
}

/** Probe the sidecar once; return (CheckResult, tool_count). */
export function probeSidecar(
  path: string | null,
  timeout: number = MCP_TIMEOUT,
  env?: NodeJS.ProcessEnv,
  brainPaths?: BrainPaths,
): SidecarProbe {
  if (!path) {
    return {
      result: _fail(
        'sidecar-mcp',
        'skipped: no sidecar binary found',
        'Install Curated Thoughts so the MCP surface exists; without it the '
          + 'agent has no CT tools at all.',
      ),
      toolCount: null,
    };
  }
  const probe = mcpToolsList(path, timeout, env);
  if (probe.toolNames === null) {
    const paths = brainPaths ?? ctEnvResolveBrainPaths(env);
    return {
      result: _fail(
        'sidecar-mcp',
        `${SIDECAR_NAME} --mcp did not answer tools/list: ${probe.error}`,
        'If it timed out, an old sidecar process may be wedged: kill '
          + `all ${SIDECAR_NAME} processes and retry; if spawn failed, `
          + `reinstall Curated Thoughts. Check ${paths.configPath} is valid JSON.`,
      ),
      toolCount: null,
    };
  }
  const count = probe.toolNames.length;
  if (count >= FULL_TIER_TOOLS) {
    return {
      result: _pass(
        'sidecar-mcp',
        `${count} tools listed (v2.5-full tier; write path active)`,
      ),
      toolCount: count,
    };
  }
  if (count >= READ_TIER_TOOLS) {
    const writeToolsPresent = probe.toolNames.includes('curated_add_wisdom');
    const extra = writeToolsPresent
      ? ' (write tools present — unexpected at this count)'
      : '';
    return {
      result: _warn(
        'sidecar-mcp',
        `${count} tools listed — v2.4-read tier; write path dormant${extra}`,
        `Only ${count} tools exposed, so curated_add_wisdom and friends are `
          + 'absent and the write path is dormant. This matches the v2.4-read '
          + `tier: upgrade Curated Thoughts to >=2.5 for the full `
          + `${FULL_TIER_TOOLS}-tool surface. Read-only routing still works.`,
      ),
      toolCount: count,
    };
  }
  if (count === 0) {
    return {
      result: _fail(
        'sidecar-mcp',
        'sidecar answered tools/list with 0 tools — broken install',
        'The MCP handshake succeeded but the sidecar exposed no tools at '
          + 'all. This is a broken install, not an older tier: reinstall '
          + 'Curated Thoughts and re-run ct_doctor.',
      ),
      toolCount: count,
    };
  }
  return {
    result: _warn(
      'sidecar-mcp',
      `${count} tools listed — below every known tier`,
      `Only ${count} tools, fewer than even the v2.4-read tier `
        + `(${READ_TIER_TOOLS}). The sidecar may be partially broken: `
        + 'reinstall Curated Thoughts and compare its version with '
        + 'shared/compat.yaml.',
    ),
    toolCount: count,
  };
}

export function checkSidecarReachable(
  path: string | null,
  timeout: number = MCP_TIMEOUT,
  env?: NodeJS.ProcessEnv,
  brainPaths?: BrainPaths,
): CheckResult {
  /** (3) MCP tools/list reachable + tool count → tier classification. */
  return probeSidecar(path, timeout, env, brainPaths).result;
}

// --------------------------------------------------------------------------
// brain / vault / embedding
// --------------------------------------------------------------------------

export function checkBrainDir(
  brainPaths?: BrainPaths,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  /** (4) brain directory exists and is readable. */
  const paths = brainPaths ?? ctEnvResolveBrainPaths(env);
  const brain = paths.brainDir;
  const envNote = env[ENV_BRAIN_DIR] || '<unset, default ~/.brain>';
  const r = _isReadableDir(brain);
  if (r === 'missing') {
    return _fail(
      'brain-dir',
      `brain directory ${brain} does not exist (${ENV_BRAIN_DIR}=${envNote})`,
      `Point ${ENV_BRAIN_DIR} at the real brain directory, or run the `
        + 'Curated Thoughts app once to initialize it. When importing a brain '
        + `from another machine, set ${ENV_BRAIN_DIR} to the imported directory.`,
    );
  }
  if (r === 'not-dir') {
    return _fail(
      'brain-dir',
      `brain path ${brain} exists but is not a directory`,
      `Move or remove the file at ${brain}; the sidecar expects a directory `
        + 'containing brain.db and config.json.',
    );
  }
  if (r === 'unreadable') {
    return _fail(
      'brain-dir',
      `brain directory ${brain} is not readable by this user`,
      `Fix permissions: chmod u+rx ${brain} (check ownership with ls -ld).`,
    );
  }
  const missing: string[] = [];
  if (!existsSync(paths.dbPath)) missing.push('brain.db');
  if (!existsSync(paths.configPath)) missing.push('config.json');
  if (missing.length > 0) {
    return _warn(
      'brain-dir',
      `brain directory ${brain} exists but is missing ${missing.join(', ')}`,
      'Run the Curated Thoughts app once to initialize the brain, or run '
        + '`curated-thoughts --onboard` to create config.json. An imported '
        + 'brain must carry brain.db and config.json together.',
    );
  }
  return _pass(
    'brain-dir',
    `brain at ${brain} (db + config present)`,
  );
}

export function checkVault(
  brainPaths?: BrainPaths,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  /** (5) the vault the brain actually points at. */
  const paths = brainPaths ?? ctEnvResolveBrainPaths(env);
  const { config, error: configErr } = ctEnvReadBrainConfig(paths.configPath);
  if (config === null) {
    return _fail(
      'vault',
      `cannot read vault_path: ${paths.configPath} ${configErr}`,
      'Run `curated-thoughts --onboard` to create a valid config.json, or '
        + 'repair it by hand. `curated-thoughts --doctor` reports the config '
        + 'problem in more detail.',
    );
  }
  const { vault, error: vaultErr } = ctEnvResolveVaultPath(config, env);
  if (vault === null) {
    return _fail(
      'vault',
      `${vaultErr} (${paths.configPath})`,
      'Set vault_path in config.json to the documents directory this brain '
        + 'indexes, or run `curated-thoughts --onboard --vault <dir>`.',
    );
  }
  const r = _isReadableDir(vault);
  if (r === 'missing') {
    return _fail(
      'vault',
      `vault ${vault} (from ${paths.configPath}) does not exist`,
      'This is the usual symptom of a brain imported from another machine: '
        + 'vault_path is an absolute path that only existed on the source '
        + "machine. Re-point it at this machine's documents directory "
        + '(`curated-thoughts --onboard --vault <dir>`).',
    );
  }
  if (r === 'not-dir') {
    return _fail(
      'vault',
      `vault path ${vault} exists but is not a directory`,
      `vault_path in ${paths.configPath} must name a directory.`,
    );
  }
  if (r === 'unreadable') {
    return _fail(
      'vault',
      `vault ${vault} is not readable by this user`,
      `Fix permissions: chmod u+rx ${vault}.`,
    );
  }
  return _pass('vault', `vault at ${vault} exists and is readable`);
}

export function checkEmbedding(env: NodeJS.ProcessEnv = process.env): CheckResult {
  /** (6) embedding backend hint — env keys present or Ollama reachable.
   * WARN-only: never fails, since local fastembed works without either.
   *
   * Synchronous: matches the Python port (which uses urlopen sync). The
   * Ollama probe is run as a `node -e` subprocess so the whole doctor
   * stays blocking. */
  const present = EMBED_ENV_KEYS.filter((k) => env[k]);
  if (present.length > 0) {
    return _pass(
      'embedding-backend',
      `embedding API key present via ${present[0]}`,
    );
  }
  const host = env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
  // Minimal OLLAMA_HOST probe: GET /api/version. Run as a child node process
  // so the doctor stays synchronous.
  let parsed: URL | null = null;
  try {
    let h = host;
    if (!h.includes('//')) h = `http://${h}`;
    parsed = new URL(h);
  } catch {
    // fall through to WARN
  }
  if (parsed) {
    const probeScript =
      `const u=${JSON.stringify(`${parsed.protocol}//${parsed.host}/api/version`)};` +
      `const c=new AbortController();` +
      `const t=setTimeout(()=>c.abort(),1500);` +
      `fetch(u,{signal:c.signal}).then(r=>{clearTimeout(t);process.exit(r.ok?0:1)}).catch(()=>{clearTimeout(t);process.exit(2)});`;
    const res = spawnSync(
      process.execPath,
      ['-e', probeScript],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 2000 },
    );
    if (res.status === 0) {
      return _pass('embedding-backend', `local Ollama reachable at ${parsed.host}`);
    }
  }
  return _warn(
    'embedding-backend',
    `no embedding API key in env and Ollama not reachable at ${host}`,
    "Semantic search will fall back to the sidecar's local fastembed "
      + '(slower, first-run model download). For better retrieval set an '
      + 'embedding API key in the environment or start Ollama '
      + '(systemctl --user start ollama, or set OLLAMA_HOST).',
  );
}

// --------------------------------------------------------------------------
// openclaw registration
// --------------------------------------------------------------------------

// OpenClaw reads JSON5 config from ~/.openclaw/openclaw.json; operators who
// keep it elsewhere point OPENCLAW_CONFIG_PATH at the real file, and
// OPENCLAW_STATE_DIR relocates the whole state directory (OpenClaw docs,
// gateway/configuration.md at the 2026.10.3 pin).
const DEFAULT_OPENCLAW_STATE_DIR = '~/.openclaw';
const OPENCLAW_CONFIG_FILE = 'openclaw.json';

/** The openclaw.json path the gateway would read for this env. */
export function openclawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_CONFIG_PATH) return expandHome(env.OPENCLAW_CONFIG_PATH, env);
  const stateDir = env.OPENCLAW_STATE_DIR || DEFAULT_OPENCLAW_STATE_DIR;
  return join(expandHome(stateDir, env), OPENCLAW_CONFIG_FILE);
}

/**
 * Lenient JSON5 subset: strips // and /* *\/ comments (outside strings) and
 * trailing commas, then JSON.parse. Unquoted keys are not supported; such a
 * file degrades the check to WARN rather than a false FAIL.
 */
export function parseJson5Lenient(text: string): unknown {
  let out = '';
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString !== null) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += '"';
      if (ch === "'") {
        // single-quoted JSON5 string: re-quote as a JSON string
        let j = i + 1;
        let body = '';
        while (j < text.length && text[j] !== "'") {
          if (text[j] === '\\') {
            body += text[j] + (text[j + 1] ?? '');
            j += 2;
            continue;
          }
          body += text[j] === '"' ? '\\"' : text[j];
          j++;
        }
        out += body + '"';
        i = j;
        inString = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export const OPENCLAW_PLUGIN_ID = 'curated-thoughts';

export function checkOpenclawRegistration(
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  /** (7) openclaw registration: `plugins.entries["curated-thoughts"]` is
   * present, not disabled, and grants
   * `hooks.allowConversationAccess: true` — without that grant OpenClaw
   * refuses the non-bundled `before_prompt_build` / `agent_turn_prepare`
   * hooks, so live delivery and the bootstrap block never run.
   * `hooks.allowPromptInjection: false` blocks them too.
   *
   * The plugin's own manifest mounts the `curated-thoughts` MCP server while
   * the plugin is enabled, so no `mcp.servers` row is required; a user row
   * with `enabled: false` silently removes the tools and is reported.
   */
  const name = 'openclaw-registration';
  const path = openclawConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return _fail(
      name,
      `no OpenClaw config at ${path}`,
      'Install with: CT_INSTALL_EDIT=1 ./scripts/install.sh '
        + '(it stages a self-contained copy and grants '
        + `plugins.entries.${OPENCLAW_PLUGIN_ID}.hooks.allowConversationAccess=true). `
        + 'Set OPENCLAW_CONFIG_PATH if the config lives elsewhere.',
    );
  }
  let cfg: unknown;
  try {
    cfg = parseJson5Lenient(text);
  } catch {
    return _warn(
      name,
      `could not parse ${path} (JSON5 features beyond comments/trailing commas)`,
      `Verify with: openclaw plugins inspect ${OPENCLAW_PLUGIN_ID} --runtime --json`,
    );
  }
  const root = (cfg ?? {}) as Record<string, unknown>;
  const plugins = (root.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const entry = entries[OPENCLAW_PLUGIN_ID] as Record<string, unknown> | undefined;
  if (entry === undefined || entry === null || typeof entry !== 'object') {
    return _fail(
      name,
      `plugins.entries["${OPENCLAW_PLUGIN_ID}"] missing from ${path}`,
      'Install with: CT_INSTALL_EDIT=1 ./scripts/install.sh',
    );
  }
  if (entry.enabled === false || plugins.enabled === false) {
    return _fail(
      name,
      `the ${OPENCLAW_PLUGIN_ID} plugin is disabled in ${path}`,
      `Enable with: openclaw plugins enable ${OPENCLAW_PLUGIN_ID}`,
    );
  }
  const hooks = (entry.hooks ?? {}) as Record<string, unknown>;
  if (hooks.allowConversationAccess !== true) {
    return _fail(
      name,
      `plugins.entries.${OPENCLAW_PLUGIN_ID}.hooks.allowConversationAccess is not true`,
      'OpenClaw blocks non-bundled prompt hooks without this grant. Set it with: '
        + `openclaw config set plugins.entries.${OPENCLAW_PLUGIN_ID}.hooks.allowConversationAccess true`,
    );
  }
  if (hooks.allowPromptInjection === false) {
    return _fail(
      name,
      `plugins.entries.${OPENCLAW_PLUGIN_ID}.hooks.allowPromptInjection is false`,
      'Prompt injection is required for the wisdom block; remove the override.',
    );
  }
  const mcp = (root.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcp.servers ?? {}) as Record<string, unknown>;
  const row = servers[OPENCLAW_PLUGIN_ID] as Record<string, unknown> | undefined;
  if (row && typeof row === 'object' && row.enabled === false) {
    return _warn(
      name,
      `mcp.servers["${OPENCLAW_PLUGIN_ID}"].enabled is false — the CT tools are hidden`,
      'Remove the enabled: false override from mcp.servers in openclaw.json.',
    );
  }
  return _pass(
    name,
    `${OPENCLAW_PLUGIN_ID} enabled with conversation access in ${path}`,
  );
}

// --------------------------------------------------------------------------
// sidecar launch environment
// --------------------------------------------------------------------------

/** One env var the sidecar needs. `alternatives` lists every name that
 * satisfies it (`name` first); `value` is set only for a brain path. */
export interface SidecarEnvNeed {
  name: string;
  kind: 'ref' | 'path';
  reason: string;
  value?: string;
  alternatives: string[];
}

const DEFAULT_EXTERNAL_BASE_URL = 'https://openrouter.ai/api/v1';

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '';
}

/** The brain's embed_profile type ("local" when absent, CT's default). */
export function embedProfileKind(config: Record<string, unknown> | null): string {
  const p = config?.embed_profile;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return 'local';
  const t = (p as Record<string, unknown>).type;
  return typeof t === 'string' && t !== '' ? t : 'local';
}

/** Env var the sidecar reads an external embedder's key from (CT
 * embedder/mod.rs resolved_api_key: profile api_key, else EMBED_API_KEY,
 * else OPENROUTER_API_KEY for an openrouter base_url, else OPENAI_API_KEY;
 * blank counts as unset). Null when not external or the key is inline. */
export function externalEmbedKeyVar(
  config: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (embedProfileKind(config) !== 'external') return null;
  const p = config!.embed_profile as Record<string, unknown>;
  if (typeof p.api_key === 'string' && p.api_key.trim() !== '') return null;
  if (isSet(env, 'EMBED_API_KEY')) return 'EMBED_API_KEY';
  const base = typeof p.base_url === 'string' && p.base_url !== '' ? p.base_url : DEFAULT_EXTERNAL_BASE_URL;
  return base.includes('openrouter') ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
}

function isDefaultOllamaHost(value: string): boolean {
  const h = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return h === 'localhost:11434' || h === '127.0.0.1:11434';
}

/** Env vars the sidecar needs from the host that launches it. */
export function sidecarEnvNeeds(
  config: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
): SidecarEnvNeed[] {
  const needs: SidecarEnvNeed[] = [];
  const here = ctEnvResolveBrainPaths(env);
  const dflt = ctEnvResolveBrainPaths({ HOME: env.HOME, USERPROFILE: env.USERPROFILE });
  const custom = here.brainDir !== dflt.brainDir || here.dbPath !== dflt.dbPath
    || here.configPath !== dflt.configPath;
  for (const name of ['CURATED_BRAIN_DIR', 'CURATED_BRAIN_DB', 'CURATED_BRAIN_CONFIG']) {
    if (custom && isSet(env, name)) {
      needs.push({
        name, kind: 'path', alternatives: [name],
        value: resolvePath(expandHome(env[name]!.trim(), env)),
        reason: 'this brain location is set in the environment; without it the sidecar opens the default ~/.brain',
      });
    }
  }
  const key = externalEmbedKeyVar(config, env);
  if (key) {
    const fallback = externalEmbedKeyVar(config, {})!;
    needs.push({
      name: key, kind: 'ref', alternatives: [...new Set([key, 'EMBED_API_KEY', fallback])],
      reason: "the brain's external embedder reads its API key from it; without it recall and wisdom matching cannot embed",
    });
  }
  if (embedProfileKind(config) === 'local' && isSet(env, 'OLLAMA_HOST')
      && !isDefaultOllamaHost(env.OLLAMA_HOST!)) {
    needs.push({
      name: 'OLLAMA_HOST', kind: 'ref', alternatives: ['OLLAMA_HOST'],
      reason: "the brain's local embedder uses Ollama at this host; without it the sidecar tries http://localhost:11434",
    });
  }
  return needs;
}

/** (6b) sidecar-env. OpenClaw (2026.10.3, mcp-client-lifecycle) starts a
 * plugin-declared stdio MCP server from the MCP SDK's default env (HOME,
 * LOGNAME, PATH, SHELL, TERM, USER; a short list on Windows) plus the
 * server's own `env`, and the plugin manifest cannot reference the user's
 * env. A user `mcp.servers.curated-thoughts` row replaces the manifest row
 * by name, and OpenClaw substitutes `${VAR}` in config strings, so that row
 * is where a key is forwarded. Read-only; prints names, never values. */
export function checkSidecarEnv(
  brainPaths?: BrainPaths,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  const name = 'sidecar-env';
  const paths = brainPaths ?? ctEnvResolveBrainPaths(env);
  const { config } = ctEnvReadBrainConfig(paths.configPath);
  const profile = embedProfileKind(config);
  const needs = sidecarEnvNeeds(config, env);
  if (needs.length === 0) {
    return _pass(name, `the sidecar needs nothing from OpenClaw's environment beyond the defaults (embed_profile: ${profile})`);
  }
  const cfgPath = openclawConfigPath(env);
  let row: Record<string, unknown> | undefined;
  try {
    const root = (parseJson5Lenient(readFileSync(cfgPath, 'utf8')) ?? {}) as Record<string, unknown>;
    const servers = ((root.mcp ?? {}) as Record<string, unknown>).servers as Record<string, unknown> | undefined;
    const r = servers?.[OPENCLAW_PLUGIN_ID];
    if (r && typeof r === 'object') row = r as Record<string, unknown>;
  } catch {
    // no config, or unparseable: treat as "no user row" (the manifest row)
  }
  const rowEnv = row?.env;
  const forwarded = new Set(
    rowEnv && typeof rowEnv === 'object' && !Array.isArray(rowEnv) ? Object.keys(rowEnv) : [],
  );
  const missing = needs.filter((n) => !n.alternatives.some((a) => forwarded.has(a)));
  if (missing.length > 0) {
    const envRows = missing.map((n) =>
      `        ${JSON.stringify(n.name)}: ${JSON.stringify(n.kind === 'path' ? n.value : '${' + n.name + '}')}`);
    const where = row
      ? `the mcp.servers["${OPENCLAW_PLUGIN_ID}"] row in ${cfgPath}`
      : `the plugin's manifest row (no mcp.servers["${OPENCLAW_PLUGIN_ID}"] override in ${cfgPath})`;
    return _warn(
      name,
      `OpenClaw does not pass its environment to the sidecar, and ${where} does not forward `
        + `${missing.map((n) => n.name).join(', ')} (embed_profile: ${profile})`,
      missing.map((n) => `${n.name}: ${n.reason}.`).join(' ')
        + ` Add (or merge into) this row in ${cfgPath}; it replaces the plugin's manifest row, so keep command and args:\n`
        + '  mcp: {\n    servers: {\n'
        + `      "${OPENCLAW_PLUGIN_ID}": {\n        command: "${SIDECAR_NAME}",\n        args: ["--mcp"],\n        env: {\n`
        + envRows.map((r) => '  ' + r).join(',\n') + '\n'
        + '        },\n      },\n    },\n  },\n'
        + 'then restart the gateway. OpenClaw substitutes ${NAME} from its environment, so only the name is written.',
    );
  }
  const unresolved = needs.filter((n) => n.kind === 'ref'
    && !n.alternatives.some((a) => forwarded.has(a) && isSet(env, a)));
  if (unresolved.length > 0) {
    const names = unresolved.map((n) => n.name).join(', ');
    return _warn(
      name,
      `${names} forwarded by name in ${cfgPath}, but not set in this environment`,
      'OpenClaw leaves an unset ${NAME} unresolved, so the sidecar gets no usable key. '
        + `Set ${names} in the gateway's environment (or OpenClaw's env config), then restart the gateway.`,
    );
  }
  return _pass(name, `${needs.map((n) => n.name).join(', ')} forwarded to the sidecar via ${cfgPath}`);
}

// --------------------------------------------------------------------------
// import pre-flight
// --------------------------------------------------------------------------

export interface ImportPreflightOpts {
  sidecarPath?: string | null;
  brainPaths?: BrainPaths;
  env?: NodeJS.ProcessEnv;
}

export function checkImportPreflight(opts: ImportPreflightOpts = {}): CheckResult {
  /** (8) import pre-flight: is this brain safe for an agent to trust?
   *
   * Read-only by construction: censusSourceRefs opens the DB through a
   * read-only connection and never writes.
   */
  const env = opts.env ?? process.env;
  const paths = opts.brainPaths ?? ctEnvResolveBrainPaths(env);
  const { version: engineVersion } =
    ctPreflight.detectEngineVersion(opts.sidecarPath ?? undefined, env);
  const engineNote = engineVersion
    ? `engine core-llm-wiki ${engineVersion}`
    : 'engine version unknown';

  const census = ctPreflight.censusSourceRefs(paths.dbPath);
  if (census.error) {
    return _warn(
      'import-preflight',
      `could not census source_ref rows: ${census.error} (${engineNote})`,
      'The brain database could not be read for the pre-flight census. If '
        + 'the brain is on another volume or still being imported, re-run '
        + `once ${paths.dbPath} is in place.`,
    );
  }
  if (!census.tablePresent) {
    return _pass(
      'import-preflight',
      `no llm_wiki_entries table yet — nothing to verify (${engineNote})`,
    );
  }

  const damaged = census.damaged;
  const atRisk = census.atRisk;
  const tokens = census.tokens;
  const hasEvidence = census.evidenceTablePresent;
  let shape = census.shape();
  if (!census.scoped) shape += '; UNSCOPED (no source_type column)';
  const hints = Object.entries(census.recoveryHints)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ×${v}`)
    .join('; ');
  // Corpse accumulation is expected engine behavior (soft-delete with no
  // purge), so it is reported, never warned about — a permanent WARN would be
  // the same crying-wolf problem as the FAIL this change removes.
  const deadNote = census.deadRows > 0
    ? `; ${census.deadRows} soft-deleted rows excluded from this census `
      + `(${census.deadMangled} with mangled source_refs)`
    : '';

  if (damaged > 0) {
    return _fail(
      'import-preflight',
      `${damaged} of ${census.total} librarian_inferred entries have a `
        + `mangled source_ref (${shape}; ${engineNote})`
        + (hints ? ` [recovery: ${hints}]` : ''),
      "These rows lost their evidence JSON to the engine's setup() "
        + 'back-rewrite (curated-thoughts issue #186): provenance display is '
        + 'empty and proposal-based retraction cannot match them. Do not '
        + "treat this graph's provenance as trustworthy. The V18 repair "
        + 'migration in curated-thoughts PR #188 re-derives the evidence '
        + '(outbox-first, then proposal lookup) and exports before it '
        + 'mutates; run it before relying on this brain.',
    );
  }
  if (atRisk > 0) {
    return _fail(
      'import-preflight',
      `${atRisk} of ${census.total} librarian_inferred entries carry a `
        + `source_ref the engine will rewrite on next launch `
        + `(${shape}; ${engineNote})`,
      "These rows still hold structured (JSON) source_ref values, or a "
        + 'whitespace-padded ref. core-llm-wiki\'s setup() selects them via '
        + 'its five-predicate migration selector and strips them through '
        + 'normalizeSourceRef on every app launch, destroying the evidence. '
        + 'Do not open this brain with the desktop app until Curated '
        + 'Thoughts carries the PR #188 structural fix (source_ref becomes '
        + `an engine-proof token and evidence moves to ${EVIDENCE_TABLE}). `
        + `The current engine pin, ${ENGINE_PINNED_VERSION}, still mangles.`,
    );
  }
  if (tokens > 0 && hasEvidence === false) {
    return _fail(
      'import-preflight',
      `${tokens} engine-proof token refs but no ${EVIDENCE_TABLE} `
        + `table (${shape}; ${engineNote})`,
      'This brain was written by a post-fix Curated Thoughts, but the '
        + `CT-owned ${EVIDENCE_TABLE} table did not travel with it. The wiki `
        + 'entries survived; their provenance did not. PR #188 §2.5.5 '
        + 'defines a supported export as brain-complete — entries, '
        + `evidence, chunks and proposals together. Re-export including `
        + `${EVIDENCE_TABLE}; an export copying only llm_wiki_entries `
        + 'silently drops every evidence link.',
    );
  }
  if (census.missingEvidenceRows > 0) {
    return _warn(
      'import-preflight',
      `${census.missingEvidenceRows} of ${tokens} token entries have no `
        + `${EVIDENCE_TABLE} row (${shape}; ${engineNote})` + deadNote,
      'Per PR #188 §2.3 these entries are treated as still-grounded and '
        + 'are never auto-purged, so nothing is being deleted — but their '
        + 'provenance cannot be displayed and retraction cannot resolve '
        + 'them. Most often a partial export or an interrupted import. '
        + 'Re-export brain-complete (§2.5.5) to restore the links.',
    );
  }
  let detail = `${census.total} librarian_inferred entries, all source_refs `
    + `engine-proof (${shape}; ${engineNote})`;
  if (census.unanchoredRows > 0) {
    detail += `; ${census.unanchoredRows} unanchored evidence rows `
      + '(expected under PR #188 §2.4 Phase 1 write-with-flag)';
  }
  detail += deadNote;
  return _pass('import-preflight', detail);
}

// --------------------------------------------------------------------------
// version compat
// --------------------------------------------------------------------------

export interface VersionCompatOpts {
  toolCount?: number | null;
  env?: NodeJS.ProcessEnv;
}

/** Best-effort platform-specific sidecar version discovery. Synchronous. */
function _discoverSidecarVersion(
  path: string | null,
  env: NodeJS.ProcessEnv,
): { version: [number, number, number] | null; source: string | null } {
  // dpkg is a Linux-only convenience; its absence is not a problem.
  let dpkgRes: ReturnType<typeof spawnSync>;
  try {
    dpkgRes = spawnSync(
      'dpkg-query',
      ['-W', '-f=${Version}', 'curated-thoughts'],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 5000 },
    );
  } catch {
    dpkgRes = undefined as unknown as ReturnType<typeof spawnSync>;
  }
  if (dpkgRes && dpkgRes.status === 0 && typeof dpkgRes.stdout === 'string' && dpkgRes.stdout.trim()) {
    const version = parseVersion(dpkgRes.stdout);
    if (version) {
      return {
        version,
        source: `dpkg curated-thoughts ${dpkgRes.stdout.trim()}`,
      };
    }
  }

  // Fallback: ask the binary itself, if it's executable. Some sidecar builds
  // expose a `--version` flag; others print nothing. Best-effort.
  if (path && existsSync(path)) {
    let res: ReturnType<typeof spawnSync>;
    try {
      res = spawnSync(path, ['--version'], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 5000,
      });
    } catch {
      res = undefined as unknown as ReturnType<typeof spawnSync>;
    }
    if (res && res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim()) {
      const version = parseVersion(res.stdout);
      if (version) {
        return {
          version,
          source: `${path} --version: ${res.stdout.trim()}`,
        };
      }
    }
  }

  return { version: null, source: null };
}

export function checkVersionCompat(
  path: string | null,
  opts: VersionCompatOpts = {},
): CheckResult {
  /** (9) sidecar version — corroborating metadata, not the tier authority. */
  const observed = opts.toolCount !== undefined && opts.toolCount !== null;
  const observedTier = observed ? tierForToolCount(opts.toolCount!) : null;
  const observedDesc: string | undefined = observedTier
    ? observedTier
    : (observed
      ? `below-tier (${opts.toolCount} tools)`
      : undefined);

  const env = opts.env ?? process.env;
  const { version, source } = _discoverSidecarVersion(path, env);

  if (version === null && observedTier) {
    return _pass(
      'version-compat',
      `sidecar release version not discoverable on this platform; tier `
        + `${observedTier} determined from the live tool count`,
    );
  }
  if (version === null && observed) {
    return _pass(
      'version-compat',
      `sidecar release version not discoverable on this platform; the live `
        + `surface exposed ${opts.toolCount} tools — see the sidecar-mcp check `
        + 'for that verdict',
    );
  }
  if (version === null) {
    return _pass(
      'version-compat',
      'sidecar release version not discoverable and no tool count available; '
        + 'see the sidecar-mcp check for the capability tier',
    );
  }

  const tier = tierFor(version);
  const vtxt = `${version[0]}.${version[1]}.${version[2]}`;
  if (tier === null) {
    return _warn(
      'version-compat',
      `sidecar version ${vtxt} (${source}) is outside every tier in `
        + 'shared/compat.yaml',
      'The installed Curated Thoughts predates 2.4 (or is a pre-release). '
        + 'Upgrade to the latest release; tiers are v2.4-read (>=2.4,<2.5, '
        + `${READ_TIER_TOOLS} tools) and v2.5-full (>=2.5, `
        + `${FULL_TIER_TOOLS} tools).`,
    );
  }
  const [name, lo, hi, tools, wp] = tier;
  const rng = `>=${lo[0]}.${lo[1]}` + (hi ? `,<${hi[0]}.${hi[1]}` : '');
  if (observed && observedTier !== name) {
    return _warn(
      'version-compat',
      `version ${vtxt} (${source}) implies tier ${name}, but the live `
        + `sidecar exposed a ${observedDesc ?? 'unknown'} tool surface`,
      'The installed package and the running sidecar disagree. A stale '
        + 'sidecar process may still be serving an older binary: kill all '
        + `${SIDECAR_NAME} processes so the next MCP call respawns the `
        + 'upgraded one, then re-run this doctor.',
    );
  }
  return _pass(
    'version-compat',
    `sidecar ${vtxt} (${source}) → tier ${name} (${rng}, ${tools} tools, `
      + `write path ${wp})`,
  );
}

// --------------------------------------------------------------------------
// runner
// --------------------------------------------------------------------------

export interface RunChecksOpts {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run all 10 checks in order. Returns a list of CheckResult. */
export function runChecks(
  opts: RunChecksOpts = {},
): CheckResult[] {
  const env = opts.env ?? process.env;
  const found = findSidecar(env);
  const sidecarPath = found?.path ?? null;
  const brainPaths = ctEnvResolveBrainPaths(env);

  const probe = probeSidecar(sidecarPath, opts.timeout, env, brainPaths);

  const results: CheckResult[] = [
    checkSidecarBinary(found, env),
    checkSidecarIdentity(sidecarPath, found?.resolved ?? null),
    probe.result,
    checkBrainDir(brainPaths, env),
    checkVault(brainPaths, env),
    checkEmbedding(env),
    checkSidecarEnv(brainPaths, env),
    checkOpenclawRegistration(env),
    checkImportPreflight({ sidecarPath, brainPaths, env }),
    checkVersionCompat(sidecarPath, { toolCount: probe.toolCount, env }),
  ];
  return results;
}

export function exitCodeFor(results: CheckResult[]): number {
  /** 0 = all PASS, 1 = any FAIL, 2 = no FAIL but at least one WARN. */
  if (results.some((r) => r.status === FAIL)) return 1;
  if (results.some((r) => r.status === WARN)) return 2;
  return 0;
}

export function formatText(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`[${r.status}] ${r.name}: ${r.detail}`);
    if (r.hint) lines.push(`       fix: ${r.hint}`);
  }
  const nFail = results.filter((r) => r.status === FAIL).length;
  const nWarn = results.filter((r) => r.status === WARN).length;
  const nPass = results.length - nFail - nWarn;
  lines.push(
    `\n${nFail} FAIL, ${nWarn} WARN, ${nPass} PASS — exit ${exitCodeFor(results)}`,
  );
  return lines.join('\n');
}

export interface CmdCheckOpts {
  json?: boolean;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export function cmdCheck(opts: CmdCheckOpts = {}): number {
  /** CLI entry: `ct_doctor.js check [--json]`. Exit code 0/1/2. */
  const results = runChecks({ timeout: opts.timeout, env: opts.env });
  if (opts.json) {
    const summary = {
      exit_code: exitCodeFor(results),
      checks: results.map((r) => ({
        name: r.name,
        status: r.status,
        detail: r.detail,
        hint: r.hint ?? '',
      })),
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(formatText(results) + '\n');
  }
  return exitCodeFor(results);
}

// --------------------------------------------------------------------------
// CLI main
// --------------------------------------------------------------------------

function _printHelp(): void {
  process.stdout.write(
    `ct_doctor.ts — Curated Thoughts OpenClaw plugin doctor (read-only).\n`
      + '\nUsage:\n'
      + '  ct_doctor.ts check [--json]   Run all checks; machine-readable with --json.\n',
  );
}

function main(argv: string[] = process.argv.slice(2)): number {
  const json = argv.includes('--json');
  const command = argv.find((a) => !a.startsWith('--')) ?? '';
  if (command === 'check') {
    return cmdCheck({ json });
  }
  if (command === '' || argv.includes('--help') || argv.includes('-h')) {
    _printHelp();
    return 0;
  }
  _printHelp();
  return 0;
}

// Detect direct execution. `pathToFileURL` is the canonical "is this me?"
// check under NodeNext ESM.
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`ct_doctor: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

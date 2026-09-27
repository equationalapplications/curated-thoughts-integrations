/**
 * status.ts — local readiness probe for the OpenCode plugin's prompt path.
 *
 * `probeLocal` is the ONLY call site on the prompt path that inspects the
 * filesystem. It never spawns the sidecar (no MCP handshake) and never opens
 * the brain database — it only checks that the brain / vault paths that
 * `ct_env.ts` resolves actually exist and that config.json is readable JSON.
 *
 * Doctor scripts perform the same checks (and more) through their own async
 * path using the shared helpers in `scripts/ct_env.ts`; they do not call
 * `probeLocal`.
 *
 * This module (and everything it imports) has ZERO third-party runtime
 * imports — it ships on the plugin runtime path, which runs without
 * node_modules. Node builtins only.
 */

import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolveBrainPaths, resolveVaultPath } from '../scripts/ct_env.js';

export type LocalReadiness = 'ready' | 'degraded' | 'unknown';

export interface LocalSnapshot {
  readiness: LocalReadiness;
  /** Bounded reason codes only — never raw config content or exception messages. */
  reasons: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Probe local readiness for the Curated Thoughts brain/vault, without ever
 * spawning the sidecar or opening the brain database.
 *
 * Returns `unknown` (never `degraded`) when the brain directory cannot be
 * resolved to an existing path — a guessed default (e.g. `~/.brain` when
 * nothing is set) is never inspected further once it's confirmed missing.
 */
export async function probeLocal(
  env: NodeJS.ProcessEnv,
  _cwd: string,
  signal: AbortSignal,
): Promise<LocalSnapshot> {
  throwIfAborted(signal);

  const paths = resolveBrainPaths(env);

  // Split-brain layout (CURATED_BRAIN_DB outside the brain dir): the config
  // sits beside the database, so gate existence on either path.
  const [brainDirExists, dbExists] = await Promise.all([
    pathExists(paths.brainDir),
    pathExists(paths.dbPath),
  ]);
  throwIfAborted(signal);

  if (!brainDirExists && !dbExists) {
    return { readiness: 'unknown', reasons: ['brain-dir-not-found'] };
  }

  let configText: string;
  try {
    configText = await readFile(paths.configPath, { encoding: 'utf8' });
  } catch {
    return { readiness: 'degraded', reasons: ['config-unreadable'] };
  }
  throwIfAborted(signal);

  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    return { readiness: 'degraded', reasons: ['config-malformed'] };
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { readiness: 'degraded', reasons: ['config-invalid'] };
  }

  const { vault, error } = resolveVaultPath(config as Record<string, unknown>, env);
  if (vault === null || error !== null) {
    return { readiness: 'degraded', reasons: ['vault-path-unresolved'] };
  }
  throwIfAborted(signal);

  const vaultExists = await pathExists(vault);
  if (!vaultExists) {
    return { readiness: 'degraded', reasons: ['vault-path-missing'] };
  }

  return { readiness: 'ready', reasons: [] };
}

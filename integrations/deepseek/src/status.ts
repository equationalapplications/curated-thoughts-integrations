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
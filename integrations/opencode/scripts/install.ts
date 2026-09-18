/**
 * install.ts — preview-first installer for the OpenCode integration (spec §4, §7).
 *
 * Usage: node lib/scripts/install.js [--skip-config]
 *        (normally via scripts/install.sh)
 *
 * Default is PREVIEW: it prints the payload dir, the loader path and
 * contents, the skill copy plan and the config merge, and writes nothing.
 * CT_INSTALL_EDIT=1 applies the proposal (registration.ts → apply()), then
 * runs the doctor (`<payload>/lib/scripts/ct_doctor.js check`) as the
 * verification step.
 *
 * --skip-config: for users who manage opencode.json themselves. The payload,
 * loader and skills are installed; the `mcp` block is printed for manual
 * merge and the config file is never touched.
 *
 * Never runs `npm install -g` and never edits the `plugin` config array.
 *
 * Exit codes: 0 = ok (or preview with nothing in the way), 1 = error / apply
 * aborted, 2 = usage error, 3 = conflicts reported (safe parts still applied
 * under CT_INSTALL_EDIT=1; conflicting parts left untouched).
 *
 * Shipped as a single esbuild bundle (lib/scripts/install.js) with
 * jsonc-parser inlined, so it runs from the payload without node_modules.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { propose, type RegistrationProposal } from './registration.js';

export const PACKAGE_NAME = '@equational-applications/opencode-curated-thoughts';

export interface InstallDeps {
  env?: NodeJS.ProcessEnv;
  /** Package root the payload is copied from (default: the one this file belongs to). */
  packageRoot?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Runs the doctor; resolves to its exit code. */
  runDoctor?: (script: string, args: string[]) => Promise<number>;
}

const USAGE = `usage: install.sh [--skip-config]

Preview by default; set CT_INSTALL_EDIT=1 to apply.
  --skip-config   install payload, loader and skills; print the mcp block
                  for manual merge instead of editing opencode.json
`;

/** Walk up from this module to the package.json that names this package. */
export function findPackageRoot(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name === PACKAGE_NAME) return dir;
      } catch {
        // keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function defaultRunDoctor(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function indent(text: string, pad = '    '): string {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

const PAYLOAD_LABEL: Record<RegistrationProposal['payload']['action'], string> = {
  create: 'create',
  replace: 'replace in place',
  unchanged: 'unchanged — already installed',
  'in-place': 'unchanged — the installer is running from the payload',
  conflict: 'CONFLICT — not installed',
};

export function formatProposal(p: RegistrationProposal, edit: boolean): string {
  const out: string[] = [];
  const say = (s = ''): void => {
    out.push(s);
  };

  say('== Payload ==');
  say(`  source:      ${p.payload.source}`);
  say(`  destination: ${p.payloadDir}`);
  say(`  files:       ${p.payload.entries.join(', ')}`);
  say(`  action:      ${PAYLOAD_LABEL[p.payload.action]}`);

  say('');
  say(`== Loader (${p.loader.path}) ==`);
  say(
    `  action: ${
      p.loader.action === 'create'
        ? 'create'
        : p.loader.action === 'unchanged'
          ? 'unchanged — already points at this payload'
          : 'CONFLICT — left untouched'
    }`,
  );
  say('  contents:');
  say(indent(p.loader.contents));

  say('');
  say('== Skills ==');
  for (const s of p.skills) {
    const tag = { create: 'create', unchanged: 'unchanged', conflict: 'CONFLICT', 'missing-source': 'MISSING' }[s.action];
    say(`  ${tag.padEnd(9)} ${s.name}: ${s.from} -> ${s.to}`);
  }

  say('');
  say(`== Config (${p.destination}) ==`);
  const c = p.config;
  switch (c.action) {
    case 'create':
      say(`  create ${p.destination}:`);
      say(indent(c.after!));
      break;
    case 'edit':
      say(`  edit ${p.destination} in place (comments and formatting kept; backup: ${p.destination}.bak)`);
      say('  inserting:');
      for (const frag of c.inserted.length > 0 ? c.inserted : [c.after!]) say(indent(frag.trim(), '  + '));
      break;
    case 'unchanged': {
      const disabled = p.mcp['curated-thoughts'].enabled ? '' : ' (explicitly disabled — left disabled)';
      say(`  OK: mcp.curated-thoughts already configured${disabled} — nothing changed.`);
      break;
    }
    case 'skipped':
      say(`  --skip-config: ${p.destination} is not touched. Merge this into it yourself:`);
      say(indent(c.block));
      break;
    case 'manual':
      say(`  Not edited automatically. Merge the following into ${p.destination} manually:`);
      say(indent(c.block));
      break;
  }
  say('  (The installer writes the global config only; OpenCode also merges remote, project,');
  say('  .opencode/, OPENCODE_CONFIG[_CONTENT] and managed config it does not read.)');
  say('  The `plugin` array is never modified.');

  if (p.warnings.length > 0) {
    say('');
    say('== Warnings ==');
    for (const w of p.warnings) say(`  WARN: ${w}`);
  }
  if (p.conflicts.length > 0) {
    say('');
    say('== Conflicts (never overwritten) ==');
    for (const x of p.conflicts) say(`  CONFLICT: ${x}`);
  }
  if (!edit) {
    say('');
    say('PREVIEW only — nothing was written.');
    say('Re-run with CT_INSTALL_EDIT=1 to apply.');
  }
  return out.join('\n') + '\n';
}

export async function main(argv: string[], deps: InstallDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const runDoctor = deps.runDoctor ?? defaultRunDoctor;

  let skipConfig = false;
  for (const arg of argv) {
    if (arg === '--skip-config') skipConfig = true;
    else if (arg === '-h' || arg === '--help') {
      stdout(USAGE);
      return 0;
    } else {
      stderr(`install: unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }

  const packageRoot = deps.packageRoot ?? findPackageRoot();
  if (!packageRoot) {
    stderr(`install: cannot locate the ${PACKAGE_NAME} package root\n`);
    return 1;
  }

  const edit = env['CT_INSTALL_EDIT'] === '1';
  stdout(
    `curated-thoughts OpenCode installer — ${edit ? 'APPLY (CT_INSTALL_EDIT=1)' : 'PREVIEW (nothing will be written)'}\n\n`,
  );

  let proposal: RegistrationProposal;
  try {
    proposal = propose({ env, packageRoot, skipConfig });
  } catch (e) {
    stderr(`install: ${(e as Error).message}\n`);
    return 1;
  }
  stdout(formatProposal(proposal, edit));
  const status = proposal.conflicts.length > 0 ? 3 : 0;
  const doctor = join(proposal.payloadDir, 'lib', 'scripts', 'ct_doctor.js');

  if (!edit) {
    stdout(`After applying, verify with: node ${doctor} check\n`);
    return status;
  }

  stdout('\n== Apply ==\n');
  if (proposal.noop) {
    stdout('Nothing to do — already configured.\n');
  } else {
    try {
      const result = await proposal.apply();
      for (const w of result.written) stdout(`  wrote   ${w}\n`);
      for (const s of result.skipped) stdout(`  skipped ${s} (conflict — left untouched)\n`);
    } catch (e) {
      stderr(`install: apply aborted: ${(e as Error).message}\n`);
      return 1;
    }
  }

  stdout('\n== Doctor ==\n');
  if (existsSync(doctor)) {
    const code = await runDoctor(doctor, ['check']);
    stdout(
      code === 0
        ? 'OK: doctor reports all checks passing.\n'
        : `doctor reported warnings or failures (exit ${code}). Re-run for details:\n  node ${doctor} check\n`,
    );
  } else {
    stdout(`WARN: ${doctor} not found — skipping the verification step.\n`);
  }
  if (status !== 0) stdout('\nConflicts were reported above; the conflicting pieces were left untouched.\n');
  return status;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`install: ${(e as Error).stack ?? String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

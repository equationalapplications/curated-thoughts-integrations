#!/usr/bin/env node
/**
 * ct-wisdom-log — read the Intuitive Wisdom verbose log (spec
 * 2026-10-16-wisdom-verbose-mode-design.md, D7). Ships inside the core, so
 * every TypeScript payload carries it:
 *
 *   node <core>/cli/ct-wisdom-log.js [--host deepseek|opencode|openclaw]
 *                                    [--path FILE] [-n N] [-f] [--block] [--json]
 *
 * Prints the last N events (default 20), one readable entry per turn. `-f`
 * follows the file. Read-only; Node built-ins only. Same layout as the Python
 * ct_wisdom_log.py.
 */

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  defaultVerboseLogPath,
  formatLogLine,
  resolveVerboseLogPath,
  type VerboseHost,
  type VerboseRecord,
} from '../verbose.js';

const HOSTS: VerboseHost[] = ['deepseek', 'opencode', 'openclaw'];
const USAGE =
  'usage: ct-wisdom-log [--host deepseek|opencode|openclaw] [--path FILE] [-n N] [-f] [--block] [--json]';

interface Args {
  host: VerboseHost;
  path: string | null;
  n: number;
  follow: boolean;
  block: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { host: 'opencode', path: null, n: 20, follow: false, block: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') {
      const h = argv[++i] as VerboseHost;
      if (!HOSTS.includes(h)) return `unknown --host ${String(h)}`;
      args.host = h;
    } else if (a === '--path') {
      const p = argv[++i];
      if (!p) return '--path needs a file';
      args.path = p;
    } else if (a === '-n') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n)) return '-n needs an integer';
      args.n = n;
    } else if (a === '-f' || a === '--follow') args.follow = true;
    else if (a === '--block') args.block = true;
    else if (a === '--json') args.json = true;
    else return `unknown argument ${a}`;
  }
  return args;
}

function parse(line: string): VerboseRecord | null {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as VerboseRecord) : null;
  } catch {
    return null;
  }
}

function render(record: VerboseRecord, args: Args): string {
  return args.json ? JSON.stringify(record) : formatLogLine(record, args.block);
}

/** Returns the exit code; `write` receives each rendered entry. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  write: (text: string) => void = (t) => process.stdout.write(`${t}\n`),
): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return 2;
  }
  const path = args.path ?? resolveVerboseLogPath(env, defaultVerboseLogPath(args.host, env));
  if (path === null) return 2;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    process.stderr.write(`cannot read ${path} (is CT_WISDOM_VERBOSE=1 set?)\n`);
    return 1;
  }
  const records = text.split('\n').map(parse).filter((r): r is VerboseRecord => r !== null);
  for (const r of args.n > 0 ? records.slice(-args.n) : []) write(render(r, args));
  if (!args.follow) return 0;

  let offset = Buffer.byteLength(text, 'utf8');
  let pending = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0; // rotated
    if (size === offset) continue;
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    const lines = (pending + buf.toString('utf8')).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const r = parse(line);
      if (r) write(render(r, args));
    }
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}

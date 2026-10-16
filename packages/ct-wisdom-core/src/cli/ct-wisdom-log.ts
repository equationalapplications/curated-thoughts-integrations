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

  const bytes = Buffer.from(text, 'utf8');
  const follower = new Follower(path, bytes.length, statIno(path));
  follower.pending = bytes.subarray(bytes.lastIndexOf(0x0a) + 1);
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    for (const line of follower.poll()) {
      const r = parse(line);
      if (r) write(render(r, args));
    }
  }
}

function statIno(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

/**
 * New complete lines appended to `path` since `offset`. Reopens the file on
 * every poll and starts over when it was rotated or replaced (a new inode) or
 * truncated (smaller than what was already read), dropping any stale partial
 * line. Same rule as the Python reader's Follower.
 */
export class Follower {
  /** Bytes after the last newline (kept as bytes: a chunk may split a UTF-8 character). */
  pending: Buffer = Buffer.alloc(0);

  constructor(
    private readonly path: string,
    private offset = 0,
    private ino: number | null = null,
  ) {}

  poll(): string[] {
    let size: number;
    let ino: number;
    try {
      const st = statSync(this.path);
      size = st.size;
      ino = st.ino;
    } catch {
      return [];
    }
    if ((this.ino !== null && ino !== this.ino) || size < this.offset) {
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    this.ino = ino;
    if (size === this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    try {
      const fd = openSync(this.path, 'r');
      try {
        readSync(fd, buf, 0, buf.length, this.offset);
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }
    this.offset = size;
    const data = Buffer.concat([this.pending, buf]);
    const cut = data.lastIndexOf(0x0a);
    this.pending = data.subarray(cut + 1);
    if (cut < 0) return [];
    return data.subarray(0, cut).toString('utf8').split('\n');
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
  // exitCode, not exit(): let pending stdout writes drain first.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}

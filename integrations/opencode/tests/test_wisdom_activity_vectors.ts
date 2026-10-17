/**
 * test_wisdom_activity_vectors.ts — the shared activity-target vectors
 * (tests/fixtures/activity_targets.json) and golden blocks
 * (tests/fixtures/activity_blocks.json) through the OPENCODE binding (spec
 * 2026-10-17-opencode-autonomous-work-wisdom-design.md, decision 2): each
 * Hermes vector is mapped to the OpenCode tool call that carries the same
 * target (read_file → read{filePath}, write_file → write{filePath,content},
 * patch → edit{filePath,oldString,newString}, search_files →
 * grep{pattern,path}, terminal → bash{command}) and must give the same query
 * and label via opencodeActivitySpec + the shared core builder. Each case
 * runs in its own temp-dir world exactly like the core runner (virtual
 * absolute paths mapped under a dir that models `/`, process identity from
 * system_user / system_home); nothing outside the temp dir is written.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_LABEL_CHARS,
  activityQuery,
  activitySeams,
  buildActivity,
  renderActivityBlock,
  resetActivityCaches,
  type Activity,
} from '@equational-applications/ct-wisdom-core';
import { opencodeActivitySpec } from '../src/wisdom-live/activity.js';

const VECTORS = fileURLToPath(new URL('../../../tests/fixtures/activity_targets.json', import.meta.url));
const BLOCKS = fileURLToPath(new URL('../../../tests/fixtures/activity_blocks.json', import.meta.url));

interface Vector {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
  fs: Array<string | { symlink: string; to: string }>;
  expected_query: string | null;
  expected_line: string | null;
  key_distinct_from?: string;
  system_user?: string;
  system_home?: string;
}

const load = (): Vector[] => JSON.parse(readFileSync(VECTORS, 'utf8')) as Vector[];

/** The OpenCode call (tool, args) that carries a Hermes vector's target. */
function opencodeCall(tool: string, args: Record<string, unknown>): [string, Record<string, unknown>] {
  switch (tool) {
    case 'read_file':
      return ['read', { filePath: args.path, offset: 1 }];
    case 'write_file':
      return ['write', { filePath: args.path, content: args.content ?? 'SECRET-CONTENT' }];
    case 'patch':
      return ['edit', { filePath: args.path, oldString: args.old_string ?? 'o', newString: args.new_string ?? 'n' }];
    case 'search_files':
      return ['grep', { pattern: args.pattern, ...(args.path !== undefined ? { path: args.path } : {}), include: '*.ts' }];
    case 'terminal':
      return ['bash', { command: args.command, workdir: '/somewhere/else', timeout: 1000 }];
    default:
      return [tool, args];
  }
}

const savedSeams = { ...activitySeams };

class World {
  readonly tmp: string;
  symlinksOk = true;

  constructor(c: Vector, tmp: string) {
    mkdirSync(tmp, { recursive: true });
    this.tmp = realpathSync(tmp);
    for (const entry of c.fs) this.create(entry);
  }

  map(value: unknown): unknown {
    if (typeof value === 'string' && value.startsWith('/')) {
      return nodePath.join(this.tmp, ...value.split('/').filter((p) => p !== ''));
    }
    return value;
  }

  create(entry: string | { symlink: string; to: string }): void {
    if (typeof entry === 'object') {
      const target = this.map(entry.to) as string;
      mkdirSync(target, { recursive: true });
      const link = this.map(entry.symlink) as string;
      mkdirSync(nodePath.dirname(link), { recursive: true });
      let exists = true;
      try {
        lstatSync(link);
      } catch {
        exists = false;
      }
      if (!exists) {
        try {
          symlinkSync(target, link, 'dir');
        } catch {
          this.symlinksOk = false;
        }
      }
    } else if (entry.endsWith('/')) {
      mkdirSync(this.map(entry) as string, { recursive: true });
    } else {
      const p = this.map(entry) as string;
      mkdirSync(nodePath.dirname(p), { recursive: true });
      writeFileSync(p, '');
    }
  }

  build(c: Vector): Activity | null {
    const cwd = this.map(c.cwd) as string;
    if (cwd.startsWith(this.tmp)) mkdirSync(cwd, { recursive: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env)) env[k] = (k === 'HOME' || k === 'USERPROFILE' ? this.map(v) : v) as string;
    const args = { ...c.args };
    if (typeof args.path === 'string') args.path = this.map(args.path);
    const tmp = this.tmp;
    const home = c.system_home ? [this.map(c.system_home) as string] : [];
    const identity: [string[], string[], string[]] = [c.system_user ? [c.system_user] : [], home, home];
    activitySeams.fsRoot = (d: string) => d === tmp || !d.startsWith(tmp + nodePath.sep);
    activitySeams.systemIdentity = () => identity;
    resetActivityCaches();
    try {
      const [tool, ocArgs] = opencodeCall(c.tool, args);
      const spec = opencodeActivitySpec(tool, ocArgs);
      return spec === null ? null : buildActivity(spec, cwd, env);
    } finally {
      Object.assign(activitySeams, savedSeams);
      resetActivityCaches();
    }
  }

  close(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

function buildIn(...cases: Vector[]): { tmp: string; built: Array<Activity | null> | null } {
  const parent = mkdtempSync(nodePath.join(tmpdir(), 'ct-oc-activity-'));
  const built: Array<Activity | null> = [];
  let tmp = '';
  try {
    for (const c of cases) {
      const world = new World(c, nodePath.join(parent, 'w'));
      tmp = world.tmp;
      if (!world.symlinksOk) return { tmp, built: null };
      built.push(world.build(c));
      world.close();
    }
    return { tmp, built };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

afterEach(() => {
  Object.assign(activitySeams, savedSeams);
  resetActivityCaches();
});

// The vectors model POSIX roots (`/Users/…`, `/home/…`) mapped under a temp
// dir; like the core runner (packages/ct-wisdom-core, Linux CI job), they run
// on POSIX only. Windows path rules (drive letters, `\\`) are vectors too,
// exercised there as strings.
describe.skipIf(process.platform === 'win32')('shared activity-target vectors through the OpenCode binding', () => {
  it('covers all 290 vectors', () => {
    expect(load().length).toBeGreaterThanOrEqual(290);
  });

  it('every vector: same query and label as the Hermes reference', () => {
    let skipped = 0;
    let checked = 0;
    for (const c of load()) {
      const { tmp, built } = buildIn(c);
      if (built === null) {
        skipped++;
        continue;
      }
      const a = built[0];
      checked++;
      if (c.expected_query === null) {
        expect(a === null || activityQuery(a) === '', `${c.name}: expected no query, got ${a?.line}`).toBe(true);
        continue;
      }
      expect(a, c.name).not.toBeNull();
      expect(activityQuery(a!), c.name).toBe(c.expected_query);
      expect(a!.line, c.name).toBe(c.expected_line);
      expect(JSON.stringify(a), c.name).not.toContain(tmp);
      for (const secret of ['SECRET-CONTENT', '/somewhere/else']) expect(JSON.stringify(a), c.name).not.toContain(secret);
      const block = renderActivityBlock({ id: 'f1', title: 'T', text: 'x', provenance: 'p' }, [], a!);
      let label = c.expected_line!;
      if (label.length > ACTIVITY_LABEL_CHARS) label = `${label.slice(0, ACTIVITY_LABEL_CHARS - 1)}…`;
      expect(block, c.name).toContain(`_for: ${label}_`);
    }
    expect(skipped).toBe(0);
    expect(checked).toBeGreaterThanOrEqual(290);
  }, 120_000);

  it('key_distinct_from: equal queries, distinct keys', () => {
    const cases = new Map(load().map((c) => [c.name, c]));
    let checked = 0;
    for (const c of cases.values()) {
      if (!c.key_distinct_from) continue;
      const { built } = buildIn(c, cases.get(c.key_distinct_from)!, c);
      expect(built, c.name).not.toBeNull();
      const [a, b, again] = built!;
      expect(a!.key, c.name).toBe(again!.key);
      expect(activityQuery(a!), c.name).toBe(activityQuery(b!));
      expect(a!.key, c.name).not.toBe(b!.key);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('golden activity blocks (Hermes renderer) for an OpenCode activity', () => {
  it('renders every shared case byte for byte', () => {
    const cases = JSON.parse(readFileSync(BLOCKS, 'utf8')) as Array<{
      name: string;
      item: { id: string; title: string; text: string; provenance: string | null };
      superseded: string[];
      line: string;
      expected: string;
    }>;
    expect(cases.some((c) => c.superseded.length > 0)).toBe(true);
    for (const c of cases) {
      const activity: Activity = { verb: 'read', target: 'x', key: 'k', line: c.line, query: 'x' };
      expect(renderActivityBlock(c.item, c.superseded, activity), c.name).toBe(c.expected);
    }
  });
});

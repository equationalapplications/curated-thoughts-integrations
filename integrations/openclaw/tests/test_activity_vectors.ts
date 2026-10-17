/**
 * The OpenClaw binding against the SHARED fixtures (user decision 2: the
 * bare-target query comes only from the core builder, and the binding must
 * pass the same vectors):
 *
 *   - tests/fixtures/activity_targets.json (290 vectors, Hermes parity): each
 *     Hermes tool call is re-expressed as the OpenClaw tool at the pin
 *     (read_file → read, write_file → write, patch → edit, search_files →
 *     grep, terminal → exec) and built through `openclawActivitySpec` →
 *     `buildActivity`, in the same temp-dir worlds as the core runner;
 *   - tests/fixtures/activity_blocks.json (golden blocks from Hermes's
 *     renderer): the block the middleware appends is byte-identical.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_HEADING,
  activityQuery,
  activitySeams,
  buildActivity,
  resetActivityCaches,
  type Activity,
} from '@equational-applications/ct-wisdom-core';
import { openclawActivitySpec } from '../src/wisdom/activity.js';
import { FakeCt, boot } from './fake_host.js';

const ROOT = fileURLToPath(new URL('../../../tests/fixtures/', import.meta.url));

interface Vector {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
  fs: Array<string | { symlink: string; to: string }>;
  expected_query: string | null;
  expected_line: string | null;
  system_user?: string;
  system_home?: string;
}

/** Hermes tool call → the OpenClaw tool call with the same target. */
function openclawCall(tool: string, args: Record<string, unknown>): [string, Record<string, unknown>] | null {
  switch (tool) {
    case 'read_file':
      return ['read', { path: args.path }];
    case 'write_file':
      return ['write', { path: args.path, content: 'never sent' }];
    case 'patch':
      return ['edit', { path: args.path, edits: [{ oldText: 'never', newText: 'sent' }] }];
    case 'search_files':
      return ['grep', { pattern: args.pattern, path: args.path, glob: '*.never' }];
    case 'terminal':
      return ['exec', { command: args.command, workdir: '/never/sent' }];
    default:
      return null;
  }
}

const savedSeams = { ...activitySeams };
afterEach(() => {
  Object.assign(activitySeams, savedSeams);
  resetActivityCaches();
});

/** One case in its own fake filesystem under a temp directory that models `/` (core runner). */
function buildInWorld(c: Vector): { tmp: string; activity: Activity | null; symlinksOk: boolean } {
  const parent = mkdtempSync(nodePath.join(tmpdir(), 'ocl-vec-'));
  const tmp = realpathSync(parent);
  let symlinksOk = true;
  const map = (v: unknown): unknown =>
    typeof v === 'string' && v.startsWith('/') ? nodePath.join(tmp, ...v.split('/').filter((p) => p !== '')) : v;
  try {
    for (const entry of c.fs) {
      if (typeof entry === 'object') {
        const target = map(entry.to) as string;
        mkdirSync(target, { recursive: true });
        const link = map(entry.symlink) as string;
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
            symlinksOk = false;
          }
        }
      } else if (entry.endsWith('/')) {
        mkdirSync(map(entry) as string, { recursive: true });
      } else {
        const p = map(entry) as string;
        mkdirSync(nodePath.dirname(p), { recursive: true });
        writeFileSync(p, '');
      }
    }
    const cwd = map(c.cwd) as string;
    if (cwd.startsWith(tmp)) mkdirSync(cwd, { recursive: true });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env)) env[k] = (k === 'HOME' || k === 'USERPROFILE' ? map(v) : v) as string;
    const args = { ...c.args };
    if (typeof args.path === 'string') args.path = map(args.path);
    const home = c.system_home ? [map(c.system_home) as string] : [];
    const identity: [string[], string[], string[]] = [c.system_user ? [c.system_user] : [], home, home];
    activitySeams.fsRoot = (d: string) => d === tmp || !d.startsWith(tmp + nodePath.sep);
    activitySeams.systemIdentity = () => identity;
    resetActivityCaches();
    const call = openclawCall(c.tool, args);
    const spec = call === null ? null : openclawActivitySpec(call[0], call[1]);
    return { tmp, activity: spec === null ? null : buildActivity(spec, cwd, env), symlinksOk };
  } finally {
    Object.assign(activitySeams, savedSeams);
    resetActivityCaches();
    rmSync(parent, { recursive: true, force: true });
  }
}

// The vectors model POSIX paths (`/Users/alice/...`, symlinks, `/mnt` rules);
// like the core runner that owns them (CI: ubuntu only), they run on POSIX.
describe.skipIf(process.platform === 'win32')('OpenClaw binding × shared activity-target vectors', () => {
  it('every vector gives the expected bare-target query and label', () => {
    const cases = JSON.parse(readFileSync(nodePath.join(ROOT, 'activity_targets.json'), 'utf8')) as Vector[];
    expect(cases.length).toBeGreaterThanOrEqual(290);
    let checked = 0;
    for (const c of cases) {
      const { tmp, activity, symlinksOk } = buildInWorld(c);
      expect(symlinksOk, c.name).toBe(true);
      if (c.expected_query === null) {
        expect(activity === null || activityQuery(activity) === '', `${c.name}: got ${activity?.line}`).toBe(true);
      } else {
        expect(activity, c.name).not.toBeNull();
        expect(activityQuery(activity!), c.name).toBe(c.expected_query);
        expect(activity!.line, c.name).toBe(c.expected_line);
        const json = JSON.stringify(activity);
        expect(json, c.name).not.toContain(tmp);
        for (const never of ['never sent', '/never/sent', '*.never']) expect(json, c.name).not.toContain(never);
      }
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});

interface BlockCase {
  name: string;
  item: { id: string; title: string; text: string; provenance: string | null };
  superseded: string[];
  line: string;
  expected: string;
}

describe('OpenClaw middleware × golden activity blocks', () => {
  it('the appended block is byte-identical to the Hermes renderer, a correction included', async () => {
    const cases = JSON.parse(readFileSync(nodePath.join(ROOT, 'activity_blocks.json'), 'utf8')) as BlockCase[];
    const project = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'ocl-gold-')));
    mkdirSync(nodePath.join(project, '.git'));
    for (const c of cases) {
      const [verb, ...rest] = c.line.split(' ');
      const target = rest.join(' ');
      const [toolName, args] = verb === 'run' ? ['exec', { command: target }] : [verb, { path: target }];
      const ct = new FakeCt();
      ct.poolFor = (_q, max) => (max === 1 && c.superseded.length === 0 ? [c.item as never] : []);
      if (c.superseded.length > 0) ct.corrections = [{ ...(c.item as never), supersedes: c.superseded }];
      const api = boot(ct);
      const messages = c.superseded.map((id) => ({ role: 'toolResult', content: [{ type: 'text', text: `<!-- ct-fact:${id} -->` }] }));
      await api.hook('before_prompt_build')({ prompt: 'p', messages }, { sessionKey: 's', runId: 'r', trigger: 'cron' });
      api.hook('model_call_started')({ runId: 'r', callId: 'r:model:1' }, { runId: 'r', sessionKey: 's' });
      const ret = (await api.middleware[0].handler(
        { toolCallId: 't', toolName, args, cwd: project, isError: false, result: { content: [{ type: 'text', text: 'out' }] } },
        { runtime: 'openclaw', sessionKey: 's', runId: 'r' },
      )) as { result: { content: Array<{ text: string }> } } | undefined;
      expect(ret, c.name).toBeDefined();
      const appended = ret!.result.content[1].text;
      expect(appended.startsWith(ACTIVITY_HEADING), c.name).toBe(true);
      expect(appended, c.name).toBe(c.expected);
    }
    rmSync(project, { recursive: true, force: true });
  });
});

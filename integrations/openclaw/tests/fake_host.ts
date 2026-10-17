/**
 * fake_host.ts — a recording stub of the OpenClaw plugin API surface the
 * plugin touches (shapes from the 2026.10.3 pin, tests/host/compatibility.json)
 * plus a scriptable fake `ct` behind the SpawnFn seam.
 */

import type { SpawnFn, SpawnLike, SpawnOutcome } from '@equational-applications/ct-wisdom-core';
import { createPlugin, type PluginDeps } from '../src/index.js';

export const ok = (stdout: string, code = 0): SpawnOutcome => ({ code, stdout, stderr: '', spawnError: false, timedOut: false });
export const TIMEOUT: SpawnOutcome = { code: null, stdout: '', stderr: '', spawnError: false, timedOut: true };

export interface Fact { id: string; title: string; text: string }

/** Fake `ct`: identity probe, capability probe, seed recall, wisdom match. */
export class FakeCt {
  calls: SpawnLike[] = [];
  bootstrap: Fact[] = [];
  /** Returns the facts `ct wisdom match` would offer (before --exclude). */
  pool: () => Fact[] = () => [];
  /**
   * Per-query pool (query = the argv element after `--`, max = `--max`);
   * when set it wins over `pool`. Lets a test answer user-turn queries
   * (`--max 2`) and activity queries (`--max 1`) differently.
   */
  poolFor: ((query: string, max: number) => Fact[]) | null = null;
  /** Corrections to add to every match answer (after --exclude filtering of entries only). */
  corrections: Array<{ id: string; supersedes: string[]; title: string; text: string }> = [];
  /** Ignore --exclude (a CT that disagrees with the ledger). */
  ignoreExclude = false;
  /** Override a match response (e.g. a timeout). */
  matchOutcome: (() => SpawnOutcome | Promise<SpawnOutcome>) | null = null;
  capable = true;

  spawnFn: SpawnFn = async (spec) => {
    this.calls.push(spec);
    const a = spec.args;
    if (a.length === 1 && a[0] === '--help') return ok('Curated Thoughts CLI');
    if (a[0] === 'recall') return ok(JSON.stringify({ wiki: this.bootstrap }));
    if (a[0] === 'wisdom' && a.includes('--help')) return this.capable ? ok('usage') : ok('', 2);
    if (a[0] === 'wisdom') {
      if (this.matchOutcome) return this.matchOutcome();
      const max = Number(a[a.indexOf('--max') + 1]);
      const query = a[a.indexOf('--') + 1] ?? '';
      const exclude = new Set(a.filter((x) => x.startsWith('--exclude=')).map((x) => x.slice('--exclude='.length)));
      const pool = this.poolFor ? this.poolFor(query, max) : this.pool();
      const entries = pool.filter((f) => this.ignoreExclude || !exclude.has(f.id)).slice(0, max);
      return ok(JSON.stringify({ entries, corrections: this.corrections }));
    }
    return ok('', 1);
  };

  matchCalls(): SpawnLike[] {
    return this.calls.filter((c) => c.args[0] === 'wisdom' && c.args[1] === 'match' && !c.args.includes('--help'));
  }

  /** Activity queries (`--max 1`), as the bare query strings CT received. */
  activityQueries(): string[] {
    return this.matchCalls().filter((c) => c.args[c.args.indexOf('--max') + 1] === '1').map((c) => c.args[c.args.indexOf('--') + 1]);
  }
}

export interface Registration { name: string; handler: (event: unknown, ctx: unknown) => unknown; opts?: Record<string, unknown> }

export class FakeApi {
  id = 'curated-thoughts';
  pluginConfig: Record<string, unknown> = {};
  hooks: Registration[] = [];
  middleware: Array<{ handler: (event: unknown, ctx: unknown) => unknown; opts?: Record<string, unknown> }> = [];
  enqueued: Array<Record<string, unknown>> = [];
  warnings: string[] = [];
  debugs: string[] = [];
  logger = { warn: (m: string) => this.warnings.push(m), info: (_m: string) => {}, debug: (m: string) => this.debugs.push(m) };
  session = {
    workflow: {
      enqueueNextTurnInjection: async (inj: Record<string, unknown>) => {
        this.enqueued.push(inj);
        return { enqueued: true, id: `inj-${this.enqueued.length}`, sessionKey: String(inj.sessionKey) };
      },
    },
  };
  on(name: string, handler: Registration['handler'], opts?: Record<string, unknown>): void {
    this.hooks.push({ name, handler, opts });
  }
  registerAgentToolResultMiddleware(handler: (e: unknown, c: unknown) => unknown, opts?: Record<string, unknown>): void {
    this.middleware.push({ handler, opts });
  }
  hook(name: string): Registration['handler'] {
    const h = this.hooks.find((r) => r.name === name);
    if (!h) throw new Error(`no ${name} hook`);
    return h.handler;
  }
}

export function boot(ct: FakeCt, extra: Partial<PluginDeps> = {}): FakeApi {
  const api = new FakeApi();
  const plugin = createPlugin({
    spawnFn: ct.spawnFn,
    env: {},
    candidates: () => ['/fake/bin/ct'],
    usable: () => true,
    ...extra,
  });
  plugin.register(api as never);
  return api;
}

export function userCtx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionKey: 'agent:main:main', sessionId: 'sid-1', runId: 'run-1', agentId: 'main', trigger: 'user', ...over };
}

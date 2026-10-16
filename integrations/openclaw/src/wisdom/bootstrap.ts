/**
 * bootstrap.ts — the greenfield v1 bootstrap block for OpenClaw (N5).
 *
 * Hermes v1 constants (seed query, k, block cap, heading), the v1 amendment
 * (`<!-- ct-fact:<id> -->` markers, id-less entries dropped, fact-id token
 * stripped to a fixpoint) and the deepseek renderer's budget rule. Delivered
 * through `prependSystemContext` — OpenClaw's provider-cacheable system space —
 * with bytes memoized per session so the prefix stays stable.
 *
 * Outcomes that are a property of the brain (ok, zero hits, parse error, no
 * `ct` binary) settle the key; transient failures (timeout, non-zero exit,
 * spawn error) do not, and a key whose second attempt fails settles empty
 * (Hermes: two attempts per session).
 */

import { Breaker, scanIds, type SpawnFn } from '@equational-applications/ct-wisdom-core';

export const SEED_QUERY = 'curated thoughts agent memory wisdom procedures';
export const RECALL_K = 3;
export const RECALL_TIMEOUT_MS = 5000;
export const BOOTSTRAP_MAX_CHARS = 2500;
export const BLOCK_HEADING = '## Curated Thoughts — relevant memory';
export const MEMO_MAX = 256;
const MAX_ATTEMPTS = 2;

const FACT_TOKEN = 'ct-fact:';
const FACT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const FORBIDDEN_MARKER = '<!-- hermes-plugin-section';
const FORBIDDEN_HEADING = '## Plugin Context: ';
const ELLIPSIS = '…';

export interface WikiEntry {
  id: string;
  title: string;
  text: string;
}

export interface BootstrapRecord {
  block: string;
  ids: string[];
}

const EMPTY: BootstrapRecord = Object.freeze({ block: '', ids: [] }) as BootstrapRecord;

function validId(v: unknown): v is string {
  return typeof v === 'string' && FACT_ID_RE.test(v);
}

/** Same order as the v1 renderer: fact token first (to a fixpoint), then frames. */
export function sanitize(value: unknown): string {
  let v = typeof value === 'string' ? value : value == null ? '' : String(value);
  while (v.includes(FACT_TOKEN)) v = v.split(FACT_TOKEN).join('');
  while (v.includes(FORBIDDEN_MARKER)) v = v.split(FORBIDDEN_MARKER).join('');
  v = v
    .split('\n')
    .map((line) => (line.startsWith(FORBIDDEN_HEADING) ? `    ${line}` : line))
    .join('\n');
  return v.replace(/\{(?=\{)/g, '{ ');
}

export function renderBootstrapBlock(entries: WikiEntry[]): string {
  if (!entries.length) return '';
  const parts: string[] = [];
  let used = BLOCK_HEADING.length + 2;
  for (const { title, text, id } of entries) {
    const cleanTitle = sanitize(title).trim();
    const cleanText = sanitize(text);
    if (!cleanTitle && !cleanText.trim()) continue;
    const titleLine = `**${cleanTitle}**${validId(id) ? ` <!-- ct-fact:${id} -->` : ''}`;
    const sep = parts.length ? 2 : 0;
    const remaining = BOOTSTRAP_MAX_CHARS - used - sep;
    if (remaining <= titleLine.length + 1) continue;
    const body = `${titleLine}\n${cleanText}`;
    if (body.length <= remaining) {
      parts.push(body);
      used += sep + body.length;
      continue;
    }
    const textBudget = remaining - titleLine.length - 1 - ELLIPSIS.length;
    if (textBudget > 0) {
      parts.push(`${titleLine}\n${cleanText.slice(0, textBudget)}${ELLIPSIS}`);
    }
    break;
  }
  if (!parts.length) return '';
  return `${BLOCK_HEADING}\n\n${parts.join('\n\n')}`;
}

/** `ct recall --json` stdout → entries with valid ids; null when malformed. */
export function parseRecall(stdout: string): WikiEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const wiki = (data as { wiki?: unknown } | null)?.wiki;
  if (!Array.isArray(wiki)) return null;
  const out: WikiEntry[] = [];
  for (const item of wiki) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as { id?: unknown; title?: unknown; text?: unknown };
    if (!validId(o.id)) continue;
    out.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      text: typeof o.text === 'string' ? o.text : '',
    });
  }
  return out;
}

export interface BootstrapDeps {
  locate: () => Promise<string | null>;
  spawnFn: SpawnFn;
  /** Called on a spawn-class failure so discovery is retried next time. */
  onSpawnFailure?: () => void;
  breaker?: Breaker;
}

export class BootstrapMemo {
  private readonly settled = new Map<string, BootstrapRecord>();
  private readonly attempts = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<BootstrapRecord | undefined>>();
  private readonly breaker: Breaker;

  constructor(private readonly deps: BootstrapDeps) {
    this.breaker = deps.breaker ?? new Breaker();
  }

  /** The settled record for a key, if any (never triggers a render). */
  get(key: string): BootstrapRecord | undefined {
    return this.settled.get(key);
  }

  /** Settle the key if possible; undefined while it is still unsettled. */
  ensure(key: string): Promise<BootstrapRecord | undefined> {
    if (key === '') return Promise.resolve(undefined);
    const hit = this.settled.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.render(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private settle(key: string, rec: BootstrapRecord): BootstrapRecord {
    this.settled.set(key, rec);
    this.attempts.delete(key);
    while (this.settled.size > MEMO_MAX) {
      const oldest = this.settled.keys().next();
      if (oldest.done) break;
      this.settled.delete(oldest.value);
    }
    return rec;
  }

  private fail(key: string): BootstrapRecord | undefined {
    this.breaker.recordFailure();
    const n = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, n);
    while (this.attempts.size > MEMO_MAX) {
      const oldest = this.attempts.keys().next();
      if (oldest.done) break;
      this.attempts.delete(oldest.value);
    }
    return n >= MAX_ATTEMPTS ? this.settle(key, EMPTY) : undefined;
  }

  private async render(key: string): Promise<BootstrapRecord | undefined> {
    if (this.breaker.isOpen()) return undefined;
    let path: string | null;
    try {
      path = await this.deps.locate();
    } catch {
      return this.fail(key);
    }
    if (path === null) return this.settle(key, EMPTY); // discovery miss: a property of the machine
    const r = await this.deps.spawnFn({
      command: path,
      args: ['recall', SEED_QUERY, '--json', '--k', String(RECALL_K)],
      timeoutMs: RECALL_TIMEOUT_MS,
    });
    if (r.spawnError) {
      this.deps.onSpawnFailure?.();
      return this.fail(key);
    }
    if (r.timedOut || r.code !== 0) return this.fail(key);
    this.breaker.recordSuccess();
    const entries = parseRecall(r.stdout);
    if (entries === null || entries.length === 0) return this.settle(key, EMPTY);
    const block = renderBootstrapBlock(entries);
    return this.settle(key, { block, ids: scanIds(block) });
  }
}

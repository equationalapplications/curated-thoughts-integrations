/**
 * wisdom-live/activity.ts — autonomous-work wisdom delivery for DeepSeek
 * Harness (spec docs/superpowers/specs/2026-10-16-dsh-autonomous-work-
 * wisdom-design.md; host facts verified against @deepseek-ai/*@0.2.0-rc.2).
 *
 *   tools/pre-execute  — prefetch: the first call of a step with a NEW
 *                        activity key starts `ct wisdom match --max 1` on the
 *                        bare target (one CT call per model step at most).
 *   agent/pre-step ≥ 2 — deliver: await the step's match within the 3 s
 *                        budget, post-filter against the ledger rebuilt from
 *                        `deriveMessages()`, and hand back ONE marker-first
 *                        block; index.ts appends it as an identified
 *                        user-role message (source kind
 *                        `curated-thoughts-wisdom-activity`).
 *
 * The step id is the assistant message id that carries the step's tool
 * calls: pre-execute and the next pre-step both read it from the session
 * log, so they agree without any turn/step bookkeeping. Subagents are
 * separate agents (own id, own log): nothing here checks for them
 * (decision 3), nor for scheduled or background runs (decision 4).
 *
 * Fail closed and quiet (INTENT rule 4): every entry point catches
 * everything; prefetch never changes the tool decision.
 */

import { randomUUID } from 'node:crypto';

import {
  ActivityTracker,
  EXCLUDE_MAX,
  TIMEOUT_MS,
  activityQuery,
  buildActivity,
  isCtTool,
  runActivityMatch,
  selectActivityDelivery,
  type Activity,
  type ActivityMatch,
  type ActivitySpec,
  type Breaker,
  type Ledger,
  type VerboseTurn,
} from '@equational-applications/ct-wisdom-core';

import type { DshWisdomAdapter } from './adapter.js';

/** `source.kind` of an activity delivery (distinct from `curated-thoughts-wisdom`). */
export const ACTIVITY_SOURCE_KIND = 'curated-thoughts-wisdom-activity';

/** Plans kept (agent × step); a stale one is never consulted again. */
const PLANS_MAX = 64;
/** Derived-log snapshots kept for the N3 fallback (mirrors index.ts). */
const SNAPSHOTS_MAX = 128;

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The DSH tool call → activity spec map (spec table; tool names and
 * argument names at the 0.2.0-rc.2 pin). Only the TARGET argument is read,
 * never content, replacement text, descriptions or options.
 */
export function dshActivitySpec(name: unknown, args: unknown): ActivitySpec | null {
  const a = obj(args);
  if (a === null || typeof name !== 'string') return null;
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return { verb: name, path: a.file_path };
    case 'str_replace_editor': {
      const verb = ({ view: 'read', create: 'write', str_replace: 'edit', insert: 'edit' } as const)[
        a.command as 'view' | 'create' | 'str_replace' | 'insert'
      ];
      return verb === undefined ? null : { verb, path: a.path };
    }
    case 'grep':
    case 'glob':
      return { verb: 'search', pattern: a.pattern, path: a.path };
    case 'bash':
    case 'pwsh':
      return { verb: 'run', command: a.command };
    default:
      return null;
  }
}

export interface StepCall {
  id: string;
  name: string;
  /** Parsed JSON arguments; the raw string when they do not parse. */
  args: unknown;
}

export interface StepCalls {
  /** The assistant message id: the step id of the rate rule. */
  messageId: string;
  calls: StepCall[];
}

/**
 * The LAST assistant message of a derived log and its tool calls, or null
 * when it has none (a text-only step triggers nothing).
 */
export function lastAssistantStep(messages: readonly unknown[]): StepCalls | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = obj(messages[i]);
    if (m === null || m.role !== 'assistant') continue;
    if (typeof m.id !== 'string' || m.id === '' || !Array.isArray(m.content)) return null;
    const calls: StepCall[] = [];
    for (const raw of m.content) {
      const b = obj(raw);
      if (b === null || b.type !== 'tool-call' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
      let args: unknown = b.arguments;
      if (typeof args === 'string') {
        try {
          args = args === '' ? {} : JSON.parse(args);
        } catch {
          /* keep the raw string: it gives no activity */
        }
      }
      calls.push({ id: b.id, name: b.name, args });
    }
    return calls.length > 0 ? { messageId: m.id, calls } : null;
  }
  return null;
}

/**
 * The persisted message: an identified user-role message (the 0.4.1
 * lesson — without a non-empty `id` and role "user" the stored session can
 * no longer be resumed).
 */
export function activityMessage(block: string): Readonly<{
  id: string;
  role: 'user';
  source: { kind: string };
  content: Array<{ type: 'text'; text: string }>;
}> {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    source: { kind: ACTIVITY_SOURCE_KIND },
    content: [{ type: 'text' as const, text: block }],
  });
}

interface AgentLike {
  id?: unknown;
  session?: { deriveMessages?: () => unknown[] };
}

interface Plan {
  activity: Activity;
  query: string;
  deadline: number;
  promise: Promise<ActivityMatch>;
  consumed: boolean;
}

export interface DshActivityDeps {
  adapter: DshWisdomAdapter;
  /** The SAME breaker the user-turn path uses (rule 4). */
  breaker: Breaker;
  /** Workspace root for path normalization (default: process.cwd()). */
  cwd?: () => string | null;
  now?: () => number;
  /** Runs before each ledger rebuild (index.ts: refresh the bootstrap memo record). */
  beforeLedger?: (agentId: string) => void;
  /** One debug line per skip (index.ts: the plugin's named logger, debug level). */
  log?: (line: string) => void;
}

export class DshActivity {
  private readonly tracker = new ActivityTracker();
  private readonly plans = new Map<string, Plan | null>();
  private readonly adapter: DshWisdomAdapter;
  private readonly breaker: Breaker;
  private readonly cwd: () => string | null;
  private readonly now: () => number;
  private readonly beforeLedger?: (agentId: string) => void;
  private readonly log?: (line: string) => void;

  constructor(deps: DshActivityDeps) {
    if (deps.log) this.log = deps.log;
    this.adapter = deps.adapter;
    this.breaker = deps.breaker;
    this.cwd = deps.cwd ?? (() => {
      try {
        return process.cwd();
      } catch {
        return null;
      }
    });
    this.now = deps.now ?? (() => Date.now());
    if (deps.beforeLedger) this.beforeLedger = deps.beforeLedger;
  }

  /** TEST-ONLY: forget keys, steps and plans. */
  _resetForTests(): void {
    this.tracker.reset();
    this.plans.clear();
  }

  private debug(agentId: string, cls: string): void {
    try {
      this.log?.(`wisdom-activity: skip agent=${agentId || '<empty>'} class=${cls}`);
    } catch {
      /* fail quietly */
    }
  }

  /** Verbose record (channel `activity`); never feeds back into delivery. */
  private record(turn: Omit<VerboseTurn, 'channel'>): void {
    const rec = this.adapter.recordVerbose;
    if (typeof rec !== 'function') return;
    try {
      rec({ ...turn, channel: 'activity' });
    } catch {
      /* fail quietly */
    }
  }

  private skip(agentId: string, cls: string, plan?: Plan | null, extra: Partial<VerboseTurn> = {}): null {
    this.debug(agentId, cls);
    if (plan) {
      this.record({ kind: 'skip', sessionId: agentId, reason: cls, query: plan.query, activity: plan.activity.line, ...extra });
    }
    return null;
  }

  private static derive(agent: AgentLike | null | undefined): unknown[] | null {
    const fn = agent?.session?.deriveMessages;
    if (typeof fn !== 'function') return null;
    const out = fn.call(agent!.session);
    return Array.isArray(out) ? out : null;
  }

  /** The ledger from the log the model sees right now (+ bootstrap memo ids). */
  private ledgerFor(agentId: string, messages: unknown[]): Ledger {
    this.beforeLedger?.(agentId);
    const snaps = this.adapter.sessionMessages;
    snaps.delete(agentId);
    snaps.set(agentId, messages);
    while (snaps.size > SNAPSHOTS_MAX) {
      const oldest = snaps.keys().next();
      if (oldest.done) break;
      snaps.delete(oldest.value);
    }
    return this.adapter.rebuildLedger({ id: agentId });
  }

  /**
   * The step's plan, made once per (agent, step) and then reused. Walks the
   * step's calls in model order: CT tools and calls without a safe activity
   * are skipped, a seen key moves on, and the first admitted call starts the
   * step's one CT query.
   */
  private plan(agentId: string, messages: unknown[], step: StepCalls): Plan | null {
    const planKey = `${agentId}#${step.messageId}`;
    if (this.plans.has(planKey)) return this.plans.get(planKey) ?? null;
    let plan: Plan | null = null;
    this.plans.set(planKey, null);
    while (this.plans.size > PLANS_MAX) {
      const oldest = this.plans.keys().next();
      if (oldest.done) break;
      this.plans.delete(oldest.value);
    }
    for (const call of step.calls) {
      if (isCtTool(call.name)) {
        this.debug(agentId, 'ct_tool');
        continue;
      }
      const activity = buildActivity(dshActivitySpec(call.name, call.args), this.cwd());
      if (activity === null || activityQuery(activity) === '') {
        this.debug(agentId, 'no_activity');
        continue;
      }
      if (this.breaker.isOpen()) {
        // A would-be trigger that cannot run: verbose hears of it once per step.
        if (this.tracker.peek(agentId, step.messageId, activity.key) === null) {
          if (this.tracker.firstReport(agentId, step.messageId)) {
            this.record({ kind: 'skip', sessionId: agentId, reason: 'breaker_open', query: activityQuery(activity), activity: activity.line });
          }
          this.debug(agentId, 'breaker_open');
          break;
        }
        continue;
      }
      const refused = this.tracker.admit(agentId, step.messageId, activity.key);
      if (refused === 'seen_key') {
        this.debug(agentId, refused);
        continue;
      }
      if (refused === 'step_used') {
        this.debug(agentId, refused);
        break;
      }
      const ledger = this.ledgerFor(agentId, messages);
      const exclude = ledger.idsMostRecentFirst.slice(0, EXCLUDE_MAX);
      plan = {
        activity,
        query: activityQuery(activity),
        deadline: this.now() + TIMEOUT_MS,
        promise: runActivityMatch(this.adapter, activity, exclude, this.breaker),
        consumed: false,
      };
      this.plans.set(planKey, plan);
      break;
    }
    return plan;
  }

  /**
   * `tools/pre-execute` prefetch for a model-direct call of the newest step.
   * Never throws and returns nothing: the caller passes `next()` through.
   */
  prefetch(exec: { callId?: unknown; name?: unknown; arguments?: unknown; parent?: unknown; agent?: AgentLike } | null | undefined): void {
    try {
      if (exec === null || typeof exec !== 'object' || exec.parent !== undefined) return;
      const agentId = typeof exec.agent?.id === 'string' ? exec.agent.id : '';
      if (agentId === '' || typeof exec.callId !== 'string') return;
      const messages = DshActivity.derive(exec.agent);
      if (messages === null) return this.debug(agentId, 'no_ledger');
      const step = lastAssistantStep(messages);
      if (step === null || !step.calls.some((c) => c.id === exec.callId)) return;
      this.plan(agentId, messages, step);
    } catch {
      /* fail quietly: the tool decision is never touched */
    }
  }

  /**
   * `agent/pre-step` (step ≥ 2): the block for the previous step's activity,
   * or null. `claimed` is the inbox batch, `decisionMessages` what the
   * waterfall decided; when a listener stripped claimed input to nothing,
   * appending would turn a concluded turn into an extra model call, so
   * nothing is delivered.
   */
  async deliver(agent: AgentLike, claimed: readonly unknown[], decisionMessages: readonly unknown[]): Promise<string | null> {
    const agentId = typeof agent?.id === 'string' ? agent.id : '';
    try {
      if (agentId === '') return this.skip(agentId, 'empty_id');
      const messages = DshActivity.derive(agent);
      if (messages === null) return this.skip(agentId, 'no_ledger');
      const step = lastAssistantStep(messages);
      if (step === null) return null;
      const plan = this.plan(agentId, messages, step);
      if (plan === null || plan.consumed) return null;
      plan.consumed = true;
      if ((claimed?.length ?? 0) > 0 && (decisionMessages?.length ?? 0) === 0) {
        return this.skip(agentId, 'would_extend_turn', plan);
      }
      const match = await settleWithin(plan.promise, Math.max(0, plan.deadline - this.now()));
      if (match === null) return this.skip(agentId, 'budget', plan);
      if (match.failure !== null || !match.result) return this.skip(agentId, match.failure ?? 'parse_error', plan);
      const ledger = this.ledgerFor(agentId, messages);
      const ledgerIds = [...ledger.idsMostRecentFirst];
      const sel = selectActivityDelivery(match.result, ledger, plan.activity);
      if (sel === null) return this.skip(agentId, 'zero_hits', plan, { result: match.result, ledgerIds });
      // N3: a CT recall later in this turn must stub the fact we deliver now
      // (the message enters the log only when the step starts).
      const cached = this.adapter.cachedLedger({ id: agentId });
      const merged = [sel.id];
      for (const id of [...ledgerIds, ...(cached?.idsMostRecentFirst ?? [])]) {
        if (!merged.includes(id)) merged.push(id);
      }
      const set = new Set(merged);
      this.adapter.cacheLedger({ id: agentId }, {
        idsMostRecentFirst: merged,
        has: (id) => set.has(id),
        knownBootstrap: ledger.knownBootstrap || (cached?.knownBootstrap ?? false),
      });
      this.record({
        kind: 'delivery',
        sessionId: agentId,
        reason: null,
        query: plan.query,
        activity: plan.activity.line,
        result: match.result,
        ledgerIds,
        deliveredIds: [sel.id],
        block: sel.block,
      });
      return sel.block;
    } catch {
      return this.skip(agentId, 'hook_failed');
    }
  }
}

/** The promise's value if it settles within `ms` (or already has), else null. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

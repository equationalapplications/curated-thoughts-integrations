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
  ACTIVITY_SESSIONS_MAX,
  ActivityTracker,
  TIMEOUT_MS,
  activityGate,
  activityQuery,
  buildActivity,
  finishActivity,
  isCtTool,
  reportActivity,
  startActivity,
  type Activity,
  type ActivityMatch,
  type ActivitySpec,
  type Breaker,
} from '@equational-applications/ct-wisdom-core';

import type { DshWisdomAdapter } from './adapter.js';

/** `source.kind` of a user-turn delivery. */
export const LIVE_SOURCE_KIND = 'curated-thoughts-wisdom';
/** `source.kind` of an activity delivery (distinct from the user-turn kind). */
export const ACTIVITY_SOURCE_KIND = 'curated-thoughts-wisdom-activity';

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
 * A persisted wisdom message: an identified user-role message (the 0.4.1
 * lesson — without a non-empty `id` and role "user" the stored session can
 * no longer be resumed). One builder for both channels.
 */
export function wisdomMessage(block: string, kind: string): Readonly<{
  id: string;
  role: 'user';
  source: { kind: string };
  content: Array<{ type: 'text'; text: string }>;
}> {
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    source: { kind },
    content: [{ type: 'text' as const, text: block }],
  });
}

/** The activity delivery message (source kind `curated-thoughts-wisdom-activity`). */
export function activityMessage(block: string): ReturnType<typeof wisdomMessage> {
  return wisdomMessage(block, ACTIVITY_SOURCE_KIND);
}

interface AgentLike {
  id?: unknown;
  session?: { deriveMessages?: () => unknown[]; header?: { cwd?: unknown } };
}

/**
 * The agent's working directory as DSH resolves its tools' relative paths:
 * the session header's validated absolute `cwd` (dsh-session SessionHeader;
 * dsh-tool-fs `session-cwd` and dsh-tool-bash `resolveWorkdir` read
 * `exec.agent.session.header.cwd`, 0.2.0-rc.2). Missing → null, which the
 * builder treats as "no cwd": no project root, so no path is sent.
 * Never process.cwd(): the harness process may run anywhere.
 */
export function sessionCwd(agent: AgentLike | null | undefined): string | null {
  try {
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null;
  } catch {
    return null;
  }
}

interface Plan {
  activity: Activity;
  deadline: number;
  promise: Promise<ActivityMatch>;
  consumed: boolean;
}

/**
 * Per agent: ONLY the newest step matters (pre-step N+1 reads step N's
 * calls), so one slot per agent, never a shared LRU that a busy sibling
 * could evict before the pre-step (review of PR #56). `callIds` lets
 * prefetch skip the log read for every later call of a planned step.
 */
interface AgentSlot {
  messageId: string;
  plan: Plan | null;
  callIds: Set<string>;
}

export interface DshActivityDeps {
  adapter: DshWisdomAdapter;
  /** The SAME breaker the user-turn path uses (rule 4). */
  breaker: Breaker;
  /** The agent's working directory (default: `sessionCwd`, the session header's cwd). */
  cwd?: (agent: AgentLike) => string | null;
  now?: () => number;
  /** Runs before each ledger rebuild (index.ts: refresh the bootstrap memo record). */
  beforeLedger?: (agentId: string) => void;
  /** One debug line per skip (index.ts: the plugin's named logger, debug level). */
  log?: (line: string) => void;
  /** Environment the builder reads for R2 (user names, HOME for `~`); default process.env. */
  env?: Record<string, string | undefined>;
}

export class DshActivity {
  private readonly tracker = new ActivityTracker();
  private readonly slots = new Map<string, AgentSlot>();
  private readonly adapter: DshWisdomAdapter;
  private readonly breaker: Breaker;
  private readonly cwd: (agent: AgentLike) => string | null;
  private readonly now: () => number;
  private readonly beforeLedger?: (agentId: string) => void;
  private readonly log?: (line: string) => void;
  private readonly env?: Record<string, string | undefined>;

  constructor(deps: DshActivityDeps) {
    if (deps.log) this.log = deps.log;
    if (deps.env) this.env = deps.env;
    this.adapter = deps.adapter;
    this.breaker = deps.breaker;
    this.cwd = deps.cwd ?? sessionCwd;
    this.now = deps.now ?? (() => Date.now());
    if (deps.beforeLedger) this.beforeLedger = deps.beforeLedger;
  }

  /** TEST-ONLY: forget keys, steps and plans. */
  _resetForTests(): void {
    this.tracker.reset();
    this.slots.clear();
  }

  private debug(agentId: string, cls: string): void {
    try {
      this.log?.(`wisdom-activity: skip agent=${agentId || '<empty>'} class=${cls}`);
    } catch {
      /* fail quietly */
    }
  }

  private static derive(agent: AgentLike | null | undefined): unknown[] | null {
    const fn = agent?.session?.deriveMessages;
    if (typeof fn !== 'function') return null;
    const out = fn.call(agent!.session);
    return Array.isArray(out) ? out : null;
  }

  /** Publish the log the model sees now, so the core gates rebuild from it. */
  private publish(agentId: string, messages: unknown[]): void {
    this.beforeLedger?.(agentId);
    this.adapter.snapshotMessages(agentId, messages);
  }

  private slotFor(agentId: string, messageId: string): AgentSlot | null {
    const slot = this.slots.get(agentId);
    if (slot === undefined || slot.messageId !== messageId) return null;
    this.slots.delete(agentId);
    this.slots.set(agentId, slot);
    return slot;
  }

  /**
   * The step's plan, made once per (agent, step) and then reused. Walks the
   * step's calls in model order: CT tools and calls without a safe activity
   * are skipped, a seen key moves on, and the first new key is the step's
   * would-be trigger. The core gates (delivery latch, restored-session rule,
   * capability, breaker) decide whether it may run; a refusal is reported
   * once (this runs once per step) and records no key.
   */
  private plan(agent: AgentLike, agentId: string, messages: unknown[], step: StepCalls): Plan | null {
    const existing = this.slotFor(agentId, step.messageId);
    if (existing !== null) return existing.plan;
    const slot: AgentSlot = { messageId: step.messageId, plan: null, callIds: new Set(step.calls.map((c) => c.id)) };
    this.slots.delete(agentId);
    this.slots.set(agentId, slot);
    while (this.slots.size > ACTIVITY_SESSIONS_MAX) {
      const oldest = this.slots.keys().next();
      if (oldest.done) break;
      this.slots.delete(oldest.value);
    }
    const session = { id: agentId };
    let cwd: string | null = null;
    try {
      cwd = this.cwd(agent);
    } catch {
      cwd = null; // fail closed: no cwd, so no path is sent
    }
    for (const call of step.calls) {
      if (isCtTool(call.name)) {
        this.debug(agentId, 'ct_tool');
        continue;
      }
      const activity = buildActivity(dshActivitySpec(call.name, call.args), cwd, this.env ?? process.env);
      if (activity === null || activityQuery(activity) === '') {
        this.debug(agentId, 'no_activity');
        continue;
      }
      const seen = this.tracker.peek(agentId, step.messageId, activity.key);
      if (seen === 'seen_key') {
        this.debug(agentId, seen);
        continue;
      }
      if (seen === 'step_used') break;
      this.publish(agentId, messages);
      const gate = activityGate(this.adapter, session, this.breaker);
      if (!gate.ok) {
        this.debug(agentId, gate.reason);
        reportActivity(this.adapter, session, activity, { kind: 'skip', reason: gate.reason });
        break;
      }
      this.tracker.admit(agentId, step.messageId, activity.key);
      const start = startActivity(this.adapter, session, activity, this.breaker);
      if (start.failure !== null) {
        this.debug(agentId, start.failure);
        reportActivity(this.adapter, session, activity, { kind: 'skip', reason: start.failure });
        break;
      }
      slot.plan = { activity, deadline: this.now() + TIMEOUT_MS, promise: start.match, consumed: false };
      break;
    }
    return slot.plan;
  }

  /**
   * `tools/pre-execute` prefetch for a model-direct call of the newest step.
   * Never throws and returns nothing: the caller passes `next()` through.
   * Once a step is planned, its other calls return without reading the log.
   */
  prefetch(exec: { callId?: unknown; name?: unknown; arguments?: unknown; parent?: unknown; agent?: AgentLike } | null | undefined): void {
    try {
      if (exec === null || typeof exec !== 'object' || exec.parent !== undefined) return;
      const agentId = typeof exec.agent?.id === 'string' ? exec.agent.id : '';
      if (agentId === '' || typeof exec.callId !== 'string') return;
      if (this.slots.get(agentId)?.callIds.has(exec.callId)) return;
      const messages = DshActivity.derive(exec.agent);
      if (messages === null) return this.debug(agentId, 'no_ledger');
      const step = lastAssistantStep(messages);
      if (step === null || !step.calls.some((c) => c.id === exec.callId)) return;
      this.plan(exec.agent!, agentId, messages, step);
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
      if (agentId === '') return null;
      const messages = DshActivity.derive(agent);
      if (messages === null) {
        this.debug(agentId, 'no_ledger');
        return null;
      }
      const step = lastAssistantStep(messages);
      if (step === null) return null;
      const plan = this.plan(agent, agentId, messages, step);
      if (plan === null || plan.consumed) return null;
      plan.consumed = true;
      const session = { id: agentId };
      if ((claimed?.length ?? 0) > 0 && (decisionMessages?.length ?? 0) === 0) {
        reportActivity(this.adapter, session, plan.activity, { kind: 'skip', reason: 'would_extend_turn' });
        return null;
      }
      const match = await settleWithin(plan.promise, Math.max(0, plan.deadline - this.now()));
      // The core re-checks every gate against the log the model sees now,
      // records the delivered id and reports the outcome.
      this.publish(agentId, messages);
      return finishActivity(this.adapter, session, plan.activity, match);
    } catch {
      this.debug(agentId, 'hook_failed');
      return null;
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

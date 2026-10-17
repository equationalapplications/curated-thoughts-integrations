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
  activityQuery,
  buildActivity,
  finishActivityOutcome,
  isCtTool,
  lruSet,
  recordActivityBudgetMiss,
  reportActivity,
  settleWithin,
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
/** `str_replace_editor` commands → verbs (a Map: no prototype keys such as `constructor`). */
const EDITOR_VERBS: ReadonlyMap<string, 'read' | 'write' | 'edit'> = new Map([
  ['view', 'read'],
  ['create', 'write'],
  ['str_replace', 'edit'],
  ['insert', 'edit'],
]);

export function dshActivitySpec(name: unknown, args: unknown): ActivitySpec | null {
  const a = obj(args);
  if (a === null || typeof name !== 'string') return null;
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return { verb: name, path: a.file_path };
    case 'str_replace_editor': {
      const verb = typeof a.command === 'string' ? EDITOR_VERBS.get(a.command) : undefined;
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
  /**
   * Kills the `ct` child (adapter `linkCancel`): on budget expiry, and when
   * the plan is abandoned (slot replaced or evicted, a turn the host would
   * not extend). The core never sees it aborted, so a cancel is no breaker
   * failure by itself; an expiry that really killed the query counts once
   * (deliver, recordActivityBudgetMiss).
   */
  cancel: AbortController;
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

  /**
   * Abandon a plan that will never be delivered: kill its `ct` child and
   * free its key so a later step can retry it. A consumed plan was already
   * settled (or released) by its pre-step.
   */
  private abandon(agentId: string, slot: AgentSlot | undefined): void {
    const plan = slot?.plan;
    if (plan == null || plan.consumed) return;
    plan.consumed = true;
    plan.cancel.abort();
    this.release(agentId, plan);
  }

  /** Store a slot; a replaced slot or the LRU-evicted one is abandoned. */
  private storeSlot(agentId: string, slot: AgentSlot): void {
    this.abandon(agentId, this.slots.get(agentId));
    lruSet(this.slots, agentId, slot, ACTIVITY_SESSIONS_MAX, (id, evicted) => this.abandon(id, evicted));
  }

  private slotFor(agentId: string, messageId: string): AgentSlot | null {
    const slot = this.slots.get(agentId);
    if (slot === undefined || slot.messageId !== messageId) return null;
    lruSet(this.slots, agentId, slot, ACTIVITY_SESSIONS_MAX);
    return slot;
  }

  /**
   * The step's would-be trigger: the first call in model order that is not
   * a CT tool, has a safe activity, and whose key is new. Pure: records
   * nothing.
   */
  private firstNewActivity(agent: AgentLike, agentId: string, step: StepCalls): Activity | null {
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
      return seen === 'step_used' ? null : activity;
    }
    return null;
  }

  /**
   * The step's plan, made once per (agent, step), ONLY from an approved
   * `tools/pre-execute`. The core gates (delivery latch, restored-session
   * rule, capability, breaker) decide whether it may start; the key is
   * admitted only when the start succeeded, so a refusal records nothing.
   */
  private plan(agent: AgentLike, agentId: string, messages: unknown[], step: StepCalls): Plan | null {
    const existing = this.slotFor(agentId, step.messageId);
    if (existing !== null) return existing.plan;
    const slot: AgentSlot = { messageId: step.messageId, plan: null, callIds: new Set(step.calls.map((c) => c.id)) };
    // Only the newest step matters: an older plan still running is
    // abandoned (child killed, key freed) before this step looks for keys.
    this.storeSlot(agentId, slot);
    const activity = this.firstNewActivity(agent, agentId, step);
    if (activity === null) return null;
    const session = { id: agentId };
    this.publish(agentId, messages);
    // The core gets a signal it never sees aborted: it is only the key the
    // adapter finds `cancel` by (linkCancel), so the host decides what a
    // kill costs the breaker.
    const coreSignal = new AbortController().signal;
    const cancel = new AbortController();
    this.adapter.linkCancel(coreSignal, cancel.signal);
    const start = startActivity(this.adapter, session, activity, this.breaker, coreSignal);
    if (start.failure !== null) {
      this.debug(agentId, start.failure);
      reportActivity(this.adapter, session, activity, { kind: 'skip', reason: start.failure });
      return null;
    }
    this.tracker.admit(agentId, step.messageId, activity.key);
    slot.plan = { activity, deadline: this.now() + TIMEOUT_MS, promise: start.match, cancel, consumed: false };
    return slot.plan;
  }

  /**
   * Free a key whose started query never got a genuine answer, so a LATER
   * step can retry it. The step stays used: it already had its one query.
   */
  private release(agentId: string, plan: Plan): void {
    this.tracker.releaseKey(agentId, plan.activity.key);
  }

  /**
   * `tools/pre-execute` prefetch for a model-direct call of the newest step.
   * index.ts calls it only after the waterfall APPROVED the call
   * (`kind: 'allow'`): a denied, cancelled or pending (`ask`) call sends
   * nothing to CT. Never throws. Once a step is planned, its other calls
   * return before reading the log.
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
   * `agent/pre-step` (step ≥ 2): the block for the previous step's planned
   * activity, or null. It NEVER plans: without a plan from an approved
   * pre-execute there is no CT call and no wait (a would-be trigger is
   * reported as `no_plan`). `claimed` is the inbox batch, `decisionMessages`
   * what the waterfall decided; when a listener stripped claimed input to
   * nothing, appending would turn a concluded turn into an extra model
   * call, so nothing is delivered. A started query that got no genuine
   * answer releases its key.
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
      const session = { id: agentId };
      const slot = this.slotFor(agentId, step.messageId);
      if (slot === null) {
        const wouldBe = this.firstNewActivity(agent, agentId, step);
        if (wouldBe !== null) {
          this.debug(agentId, 'no_plan');
          reportActivity(this.adapter, session, wouldBe, { kind: 'skip', reason: 'no_plan' });
        }
        return null;
      }
      const plan = slot.plan;
      if (plan === null || plan.consumed) return null;
      plan.consumed = true;
      if ((claimed?.length ?? 0) > 0 && (decisionMessages?.length ?? 0) === 0) {
        reportActivity(this.adapter, session, plan.activity, { kind: 'skip', reason: 'would_extend_turn' });
        // Nothing will use the answer: kill the query (a cancel, not a
        // budget miss, so no breaker failure) and free the key.
        plan.cancel.abort();
        this.release(agentId, plan);
        return null;
      }
      // On expiry: kill the abandoned `ct` child. If the kill really stopped
      // the query (outcome `budget`), the miss counts as ONE breaker failure
      // (recordActivityBudgetMiss, the shared rule). A child that had
      // already answered keeps its result (the binding reports it, not
      // `aborted`), so a query that made it in time is never charged.
      const match = await settleWithin(plan.promise, Math.max(0, plan.deadline - this.now()), () => {
        plan.cancel.abort();
        void plan.promise.then((late) => {
          if (late.failure === 'budget') recordActivityBudgetMiss(this.breaker);
        });
      });
      // The core re-checks every gate against the log the model sees now
      // (tool results of the step included), selects and reports.
      this.publish(agentId, messages);
      const outcome = finishActivityOutcome(this.adapter, session, plan.activity, match);
      if (outcome.retry) this.release(agentId, plan);
      return outcome.block;
    } catch {
      this.debug(agentId, 'hook_failed');
      return null;
    }
  }
}

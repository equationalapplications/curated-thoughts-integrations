/**
 * wisdom-live/activity.ts — autonomous-work wisdom delivery for OpenCode
 * (spec docs/superpowers/specs/2026-10-17-opencode-autonomous-work-wisdom-
 * design.md; host facts verified against the opencode 1.18.35 binary).
 *
 *   tool.execute.before — PLAN: the shared core builder renders the call's
 *                         target (never contents, output or other args).
 *                         Nothing is sent: OpenCode asks permission AFTER
 *                         this hook and exposes no approval result.
 *   tool.execute.after  — START + DELIVER: a refused call never reaches this
 *                         hook (the ask aborts execute), so the call is
 *                         approved here. Only a call with a plan from
 *                         `before` starts (delivery never plans). One CT
 *                         query per model step (the step id is the assistant
 *                         message id of the call's persisted tool part), only
 *                         on a new key, at most one in flight per session;
 *                         awaited within 3 s; one marker-first block appended
 *                         to this call's own output.
 *
 * Subagents get activity delivery like any session whose kind is known
 * (decision 4), from their OWN ledger; nothing checks how a session started
 * (decision 5). CT's own tools never trigger (decision 6). Every entry point
 * catches everything and leaves the output untouched on any skip (rule 4).
 */

import {
  ActivityTracker,
  EMPTY_LEDGER,
  TIMEOUT_MS,
  activityQuery,
  buildActivity,
  finishActivityOutcome,
  isCtTool,
  lruSet,
  reportActivity,
  scanIds,
  settleWithin,
  startActivity,
  type Activity,
  type ActivitySpec,
  type Breaker,
  type HostAdapter,
  type Ledger,
} from '@equational-applications/ct-wisdom-core';

import type { OpenCodeWisdomAdapter } from './adapter.js';
import { isObj } from '../obj.js';

// ─────────────────────────────────────────────────────────────────────────
// binding (the only code that looks at tool arguments)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The OpenCode tool call → activity spec map (builtin tool schemas at the
 * 1.18.35 pin). Only the TARGET argument is read: never `content`,
 * `oldString`/`newString`, `include`, `workdir` or `timeout`. Every other
 * tool (apply_patch, task, webfetch, MCP tools, …) gives no activity.
 */
export function opencodeActivitySpec(tool: unknown, args: unknown): ActivitySpec | null {
  if (typeof tool !== 'string' || !isObj(args)) return null;
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return { verb: tool, path: args.filePath };
    case 'grep':
    case 'glob':
      return { verb: 'search', pattern: args.pattern, path: args.path };
    case 'bash':
      return { verb: 'run', command: args.command };
    default:
      return null;
  }
}

/**
 * CT's own tools (decision 6). OpenCode names MCP tools `<server>_<tool>`
 * (one `_`), so a CT server registered under another name
 * (`ct_curated_recall_context`) is caught too; over-matching only drops a
 * trigger, it never sends anything.
 */
export function isOpenCodeCtTool(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const lowered = name.toLowerCase();
  return isCtTool(lowered) || lowered.includes('_curated_') || lowered.startsWith('curated_');
}

/** Experimental code mode's child MCP calls (`<parent callID>/<n>`) feed a script, not the model. */
export function isCodeModeCall(callID: unknown): boolean {
  return typeof callID === 'string' && callID.includes('/');
}

// ─────────────────────────────────────────────────────────────────────────
// placement
// ─────────────────────────────────────────────────────────────────────────

/**
 * Whether this output can carry a block: a builtin `{output: string}` only.
 * Only builtin tools are planned (`opencodeActivitySpec`), so an MCP
 * CallToolResult never reaches placement; it gets no branch until MCP tools
 * are planned (0.4.1: the dead branches were dropped). Builtin output is
 * truncated inside the tool, before the after hook, so the block is never cut.
 */
export function canCarry(output: unknown): boolean {
  return isObj(output) && typeof output.output === 'string';
}

/** Append the block after a blank line to the builtin `output`. */
export function placeBlock(output: Record<string, unknown>, block: string): void {
  const text = output.output as string;
  output.output = text === '' ? block : `${text}\n\n${block}`;
}

// ─────────────────────────────────────────────────────────────────────────
// the gate-facing host: the core gates read the activity view
// ─────────────────────────────────────────────────────────────────────────

/** The host the core activity gates see, plus the view setter. */
export type ActivityHost = HostAdapter & { setView(sessionId: string, ledger: Ledger): void };

/**
 * An explicit delegating object (0.4.1; replaces `Object.create(adapter)`):
 * every HostAdapter method calls the adapter itself, so nothing can write a
 * shadowing field, and only these differ for activity delivery:
 *   - `rebuildLedger` is the session's OWN view set just before the gate;
 *   - `deliveryEnabled` is "session kind known" (subagents included, a failed
 *     lookup is not);
 *   - `restored` is false (LD10);
 *   - `deliver` / `noteDelivered` do nothing (the channel is the tool output;
 *     an activity id never enters the user-turn record, DSH review).
 */
export function activityHost(adapter: OpenCodeWisdomAdapter): ActivityHost {
  const views = new Map<string, Ledger>();
  const host: ActivityHost = {
    setView: (sessionId, ledger) => lruSet(views, sessionId, ledger, 256),
    deliveryEnabled: (session) => adapter.sessionKnown(session.id),
    restored: () => false,
    rebuildLedger: (session) => views.get(session.id) ?? EMPTY_LEDGER,
    cacheLedger: (session, ledger) => adapter.cacheLedger(session, ledger),
    cachedLedger: (session) => adapter.cachedLedger(session),
    wisdomMatch: (query, max, exclude, signal) => adapter.wisdomMatch(query, max, exclude, signal),
    isCtRecallResult: (result) => adapter.isCtRecallResult(result),
    envelopeFactIds: (result) => adapter.envelopeFactIds(result),
    rewriteEnvelopeStub: (result, repeats, newIds) => adapter.rewriteEnvelopeStub(result, repeats, newIds),
    resetDiscoveryAndProbeCaches: () => adapter.resetDiscoveryAndProbeCaches(),
    wisdomMatchAbsent: () => adapter.wisdomMatchAbsent(),
    deliver: () => {},
    noteDelivered: () => {},
  };
  const rec = adapter.recordVerbose;
  if (rec) host.recordVerbose = (turn) => rec.call(adapter, turn);
  return host;
}

// ─────────────────────────────────────────────────────────────────────────
// the activity path
// ─────────────────────────────────────────────────────────────────────────

export interface ToolHookInput {
  tool?: unknown;
  sessionID?: unknown;
  callID?: unknown;
}

export interface OpenCodeActivityDeps {
  adapter: OpenCodeWisdomAdapter;
  /** The SAME per-session breaker the user-turn path uses (rule 4). */
  breakerFor: (sessionId: string) => Breaker;
  /** Environment the builder reads (user names, HOME); default process.env. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** The whole after-hook budget, fetches included (default TIMEOUT_MS). */
  budgetMs?: number;
  /** The plan-time session lookup's cap (default PLAN_LOOKUP_MS). */
  planLookupMs?: number;
  /** One debug line per skip; unwired in index.ts (the plugin has no local logger). */
  log?: (line: string) => void;
}

const PLANS_MAX = 256;
/**
 * The plan-time `session.get` wait (0.4.1): a slow or failing host must not
 * stall every tool call by the full budget. The answer is cached, so later
 * calls of the session do not wait at all.
 */
export const PLAN_LOOKUP_MS = 300;
/** Below this much budget left, the query is not started (0.4.1): it could not answer in time. */
export const START_MARGIN_MS = 200;

export class OpenCodeActivity {
  private readonly tracker = new ActivityTracker();
  private readonly plans = new Map<string, Activity>();
  private readonly inflight = new Set<string>();
  private readonly host: ActivityHost;
  private readonly adapter: OpenCodeWisdomAdapter;
  private readonly breakerFor: (sessionId: string) => Breaker;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly planLookupMs: number;
  private readonly log?: (line: string) => void;

  constructor(deps: OpenCodeActivityDeps) {
    this.adapter = deps.adapter;
    this.host = activityHost(deps.adapter);
    this.breakerFor = deps.breakerFor;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => Date.now());
    this.budgetMs = deps.budgetMs ?? TIMEOUT_MS;
    this.planLookupMs = deps.planLookupMs ?? PLAN_LOOKUP_MS;
    if (deps.log) this.log = deps.log;
  }

  private debug(sessionId: string, cls: string): void {
    try {
      this.log?.(`wisdom-activity: skip session=${sessionId || '<empty>'} class=${cls}`);
    } catch {
      /* fail quietly */
    }
  }

  /** `tool.execute.before`: plan only. Never throws, never sends, never touches args. */
  async plan(input: ToolHookInput, args: unknown): Promise<void> {
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    try {
      const callID = typeof input?.callID === 'string' ? input.callID : '';
      if (sessionID === '' || callID === '') return this.debug(sessionID, 'empty_id');
      if (isCodeModeCall(callID)) return this.debug(sessionID, 'code_mode');
      if (isOpenCodeCtTool(input.tool)) return this.debug(sessionID, 'ct_tool');
      const spec = opencodeActivitySpec(input.tool, args);
      if (spec === null) return this.debug(sessionID, 'no_activity');
      // Caches the kind and directory for `deliver`; capped (a hung lookup plans nothing).
      const kind = await settleWithin(this.adapter.sessionKind(sessionID), this.planLookupMs);
      if (kind === null) return this.debug(sessionID, 'budget');
      const activity = buildActivity(spec, this.adapter.sessionDirectory(sessionID), this.env);
      if (activity === null || activityQuery(activity) === '') return this.debug(sessionID, 'no_activity');
      lruSet(this.plans, `${sessionID}\u0000${callID}`, activity, PLANS_MAX);
    } catch {
      this.debug(sessionID, 'hook_failed');
    }
  }

  /**
   * `tool.execute.after`: start (the call is approved), deliver into
   * `output`. ONE deadline covers everything, the session lookups included
   * (review of PR #66); on expiry nothing is placed.
   */
  async deliver(input: ToolHookInput, output: unknown): Promise<void> {
    const sessionID = typeof input?.sessionID === 'string' ? input.sessionID : '';
    try {
      const callID = typeof input?.callID === 'string' ? input.callID : '';
      if (sessionID === '' || callID === '') return;
      const planKey = `${sessionID}\u0000${callID}`;
      const activity = this.plans.get(planKey);
      if (activity === undefined) return this.debug(sessionID, 'no_plan');
      this.plans.delete(planKey);
      if (this.inflight.has(sessionID)) return this.debug(sessionID, 'in_flight');
      if (this.tracker.peek(sessionID, '\u0000', activity.key) === 'seen_key') return this.debug(sessionID, 'seen_key');
      if (!canCarry(output)) return this.debug(sessionID, 'unsupported_result');
      this.inflight.add(sessionID);
      // The marker stays until the ct child has exited or been killed, so no
      // second query of this session can overlap a dying one.
      let child: Promise<unknown> | null = null;
      try {
        await this.run(sessionID, callID, activity, output as Record<string, unknown>, (p) => (child = p));
      } finally {
        const release = () => this.inflight.delete(sessionID);
        const held = child as Promise<unknown> | null;
        if (held === null) release();
        else held.then(release, release);
      }
    } catch {
      this.debug(sessionID, 'hook_failed');
    }
  }

  private async run(
    sessionID: string,
    callID: string,
    activity: Activity,
    output: Record<string, unknown>,
    hold: (child: Promise<unknown>) => void,
  ): Promise<void> {
    const deadline = this.now() + this.budgetMs;
    const left = () => Math.max(0, deadline - this.now());
    const session = { id: sessionID };
    // Cheap gates first (0.4.1): a closed gate costs no history fetch. The
    // session kind comes from the plan-time lookup (cached), never a new one.
    const closed = !this.host.deliveryEnabled(session)
      ? 'delivery_off'
      : this.adapter.wisdomMatchAbsent()
        ? 'capability_missing'
        : this.breakerFor(sessionID).isOpen()
          ? 'breaker_open'
          : null;
    if (closed !== null) {
      this.debug(sessionID, closed);
      // No step id without the fetch: report once per activity key.
      if (this.tracker.firstReport(sessionID, `gate\u0000${activity.key}`)) {
        reportActivity(this.host, session, activity, { kind: 'skip', reason: closed });
      }
      return;
    }
    // ONE history fetch per triggering call (review of PR #66).
    const view = await settleWithin(this.adapter.activityView(sessionID), left());
    if (view === null) return this.debug(sessionID, 'budget');
    const step = view.stepOf(callID);
    if (step === null) return this.debug(sessionID, 'no_step');
    const refused = this.tracker.peek(sessionID, step, activity.key);
    if (refused !== null) return this.debug(sessionID, refused);
    // Too little budget left to answer (0.4.1): no spawn, nothing admitted.
    if (left() <= START_MARGIN_MS) return this.debug(sessionID, 'budget');
    this.host.setView(sessionID, view.ledger);
    const start = startActivity(this.host, session, activity, this.breakerFor(sessionID));
    if (start.failure !== null) {
      this.debug(sessionID, start.failure);
      if (this.tracker.firstReport(sessionID, step)) {
        reportActivity(this.host, session, activity, { kind: 'skip', reason: start.failure });
      }
      return;
    }
    this.tracker.admit(sessionID, step, activity.key);
    hold(start.match);
    // On expiry `start.cancel('budget')` kills the ct child and the core
    // charges the miss as ONE breaker failure right then (a child that never
    // closes still counts); the query reports `budget`. An `aborted` outcome
    // from anywhere else never counts.
    const match = await settleWithin(start.match, left(), () => start.cancel('budget'));
    // No second fetch: ids that can join the context during the query are
    // recorded in memory (adapter `refresh`).
    this.host.setView(sessionID, view.refresh());
    const outcome = finishActivityOutcome(this.host, session, activity, match);
    // Retry the KEY in a later step; this step stays used (no second query).
    if (outcome.retry) this.tracker.releaseKey(sessionID, activity.key);
    if (outcome.block === null) return;
    // Recorded BEFORE placement: lost on a crash, never shown twice.
    this.adapter.noteUnpersisted(sessionID, scanIds(outcome.block), callID);
    placeBlock(output, outcome.block);
  }

  /** TEST-ONLY. */
  _resetForTests(): void {
    this.tracker.reset();
    this.plans.clear();
    this.inflight.clear();
  }
}

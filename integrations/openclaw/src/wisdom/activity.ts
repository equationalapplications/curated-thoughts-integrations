/**
 * wisdom/activity.ts — autonomous-work ("activity") wisdom delivery for
 * OpenClaw (spec docs/superpowers/specs/2026-10-17-openclaw-autonomous-work-
 * wisdom-design.md; host facts verified against openclaw@2026.10.3).
 *
 *   model_call_started     — the step id: `event.callId` = `<runId>:model:<n>`.
 *   tool-result middleware — the trigger AND the channel: for a call the host
 *                            actually ran (decision 8: OpenClaw's
 *                            before_tool_call precedes every approval, so no
 *                            query starts there), the first result of a step
 *                            with a NEW activity key starts
 *                            `ct wisdom match --max 1 -- <bare target>`,
 *                            awaits it within 3 s, and appends ONE
 *                            marker-first block as its own text block. The
 *                            host persists and replays that content (A3,
 *                            verified live).
 *
 * The ledger is the run's prompt-hook snapshot plus the adapter's run ledger
 * (every id that entered context during the run). No snapshot for the run
 * means no delivery (fail closed). Subagents, cron and heartbeat runs are
 * ordinary sessions here: nothing checks for them (decision 4).
 *
 * Fail closed and quiet (INTENT rule 4): `process` never throws — a throwing
 * middleware makes OpenClaw replace the tool output with an error text.
 */

import {
  ACTIVITY_SESSIONS_MAX,
  ActivityTracker,
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
  type ActivityEnv,
  type ActivitySpec,
  type Breaker,
} from '@equational-applications/ct-wisdom-core';

import { partTexts, type OpenClawWisdomAdapter } from './adapter.js';
import { metaRecallIds, obj } from './meta.js';

export { metaRecallIds };

/** The host's per-result block limit (tool-result-middleware MAX_MIDDLEWARE_CONTENT_BLOCKS). */
export const MIDDLEWARE_MAX_BLOCKS = 200;

const firstString = (...values: unknown[]): unknown => values.find((v) => typeof v === 'string') ?? values[0];

/**
 * The OpenClaw tool → activity map (spec table; names and args at the
 * 2026.10.3 pin). Only the TARGET argument is read, never content, edits,
 * options, workdir or env. Every other tool gives no activity.
 */
export function openclawActivitySpec(name: unknown, args: unknown): ActivitySpec | null {
  const a = obj(args);
  if (a === null || typeof name !== 'string') return null;
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return { verb: name, path: firstString(a.path, a.file_path) };
    case 'grep':
    case 'find':
      return { verb: 'search', pattern: a.pattern, path: a.path };
    case 'exec':
    case 'bash':
      return { verb: 'run', command: a.command };
    default:
      return null;
  }
}

/** `details.status` values of a call that did not run (or not yet). */
const NOT_RUN = new Set(['approval-pending', 'approval-unavailable', 'denied', 'blocked', 'cancelled', 'canceled', 'aborted']);

/**
 * True when the result shows the host ran the call (decision 8). The
 * middleware only sees started executions, but `exec` starts and then
 * returns approval-pending or denied results without running the command.
 * An error counts only when it carries a finite exit code (the command ran
 * and failed).
 */
export function executedResult(event: unknown): boolean {
  const e = obj(event);
  if (e === null) return false;
  const details = obj(obj(e.result)?.details);
  const status = typeof details?.status === 'string' ? details.status : '';
  if (NOT_RUN.has(status)) return false;
  if (e.isError !== true) {
    // A denied gateway exec is `failed` with exitCode null even when the flag is unset.
    return !(status === 'failed' && details !== null && details.exitCode === null);
  }
  const code = details?.exitCode;
  return typeof code === 'number' && Number.isFinite(code);
}

interface Step {
  runId: string;
  callId: string;
}

export interface OpenClawActivityDeps {
  adapter: OpenClawWisdomAdapter;
  /** The SAME breaker the user-turn path uses (rule 4). */
  breaker: Breaker;
  /** Environment the builder reads (user names, HOME for `~`). */
  env: ActivityEnv;
  /** Wall budget for one match (default TIMEOUT_MS; a test seam). Locate and probe are outside it. */
  budgetMs?: number;
  /** Bound on the separate locate + probe wait (default READY_WAIT_MS; a test seam). */
  readyMs?: number;
  /** One debug line per skip (index.ts: api.logger.debug). */
  log?: (line: string) => void;
}

export class OpenClawActivity {
  private readonly tracker = new ActivityTracker();
  private readonly steps = new Map<string, Step>();
  private readonly adapter: OpenClawWisdomAdapter;
  private readonly breaker: Breaker;
  private readonly env: ActivityEnv;
  private readonly budgetMs: number;
  private readonly readyMs: number;
  private readonly log?: (line: string) => void;

  constructor(deps: OpenClawActivityDeps) {
    this.adapter = deps.adapter;
    this.breaker = deps.breaker;
    this.env = deps.env;
    this.budgetMs = deps.budgetMs ?? TIMEOUT_MS;
    this.readyMs = deps.readyMs ?? READY_WAIT_MS;
    if (deps.log) this.log = deps.log;
  }

  private debug(sessionKey: string, cls: string): void {
    try {
      this.log?.(`wisdom-activity: skip session=${sessionKey || '<empty>'} class=${cls}`);
    } catch {
      /* fail quietly */
    }
  }

  /** `model_call_started`: remember the session's current model step. Never throws. */
  noteModelCall(event: unknown, ctx: unknown): void {
    try {
      const sessionKey = obj(ctx)?.sessionKey;
      const runId = obj(event)?.runId ?? obj(ctx)?.runId;
      const callId = obj(event)?.callId;
      if (typeof sessionKey !== 'string' || sessionKey === '') return;
      if (typeof runId !== 'string' || runId === '' || typeof callId !== 'string' || callId === '') return;
      lruSet(this.steps, sessionKey, { runId, callId }, ACTIVITY_SESSIONS_MAX);
    } catch {
      /* fail quietly */
    }
  }

  /** The step id for a tool result of `runId`: the latest model call, else one slot for the run. */
  private stepId(sessionKey: string, runId: string): string {
    const step = this.steps.get(sessionKey);
    return step !== undefined && step.runId === runId ? step.callId : `${runId}:model:?`;
  }

  /**
   * The middleware body for one tool result. `result` is the result after
   * the N3 recall dedup. Resolves to the result to hand back: the same
   * object when nothing changed. Never throws.
   */
  async process(event: unknown, ctx: unknown, result: unknown): Promise<unknown> {
    const e = obj(event);
    const c = obj(ctx);
    const sessionKey = typeof c?.sessionKey === 'string' ? c.sessionKey : '';
    const runId = typeof c?.runId === 'string' ? c.runId : '';
    let claimed: { stepId: string; key: string } | null = null;
    try {
      if (e === null || sessionKey === '' || runId === '') return result;
      // Every id this result shows is now in context (forged markers can only suppress).
      this.adapter.noteRunIds(sessionKey, runId, resultIds(result));

      const toolName = e.toolName;
      if (toolName === META_TOOL) {
        // A CT recall through the `tool_call` meta tool (N3 already ran on it in
        // index.ts): its facts are in context now. Unreadable → fail closed.
        const ids = metaRecallIds(e.args, result);
        if (ids === 'unreadable') this.adapter.markBlind(sessionKey, 'meta_unreadable', runId);
        else if (ids !== null) this.adapter.noteRunIds(sessionKey, runId, ids);
        return result; // never a trigger (decision 5; not in the map either)
      }
      if (isCtTool(toolName)) return result; // decision 5
      const spec = openclawActivitySpec(toolName, e.args);
      if (spec === null) return result;
      if (!executedResult({ isError: e.isError, result })) {
        this.debug(sessionKey, 'not_executed');
        return result;
      }
      const cwd = typeof e.cwd === 'string' && e.cwd.trim() !== '' ? e.cwd : null;
      const activity = buildActivity(spec, cwd, this.env);
      if (activity === null || activityQuery(activity) === '') {
        this.debug(sessionKey, 'no_activity');
        return result;
      }
      const stepId = this.stepId(sessionKey, runId);
      const seen = this.tracker.peek(sessionKey, stepId, activity.key);
      if (seen !== null) {
        this.debug(sessionKey, seen);
        return result;
      }
      const session = { id: sessionKey };
      const skipOncePerStep = (reason: string): unknown => {
        this.debug(sessionKey, reason);
        if (this.tracker.firstReport(sessionKey, stepId)) reportActivity(this.adapter, session, activity, { kind: 'skip', reason });
        return result;
      };
      const content = obj(result)?.content;
      if (!Array.isArray(content) || content.length >= MIDDLEWARE_MAX_BLOCKS) return skipOncePerStep('no_channel');
      if (!this.adapter.hasRun(sessionKey, runId)) return skipOncePerStep('no_ledger');
      const blind = this.adapter.blindReason(sessionKey, runId);
      if (blind !== null) return skipOncePerStep(blind);

      // Locate + capability probe: cached and warmed at prompt time; a
      // first-use wait is bounded (READY_WAIT_MS) and separate from the match
      // budget. Still unknown after it → skip WITHOUT claiming the step, so a
      // later result of this step can try once the probe is done.
      if (!this.adapter.capabilityKnown()) {
        const probeAbort = new AbortController();
        await settleWithin(this.adapter.ready(probeAbort.signal), this.readyMs, () => probeAbort.abort());
        if (!this.adapter.capabilityKnown()) return skipOncePerStep('probe_pending');
        const again = this.tracker.peek(sessionKey, stepId, activity.key); // a sibling may have claimed meanwhile
        if (again !== null) {
          this.debug(sessionKey, again);
          return result;
        }
      }
      // Claim synchronously: parallel results of one step race here and
      // nowhere else. A refused start frees the key (the step stays used).
      claimed = { stepId, key: activity.key };
      this.tracker.admit(sessionKey, stepId, activity.key);
      const start = startActivity(this.adapter, session, activity, this.breaker);
      if (start.failure !== null) {
        this.tracker.releaseKey(sessionKey, activity.key);
        claimed = null;
        return skipOncePerStep(start.failure);
      }
      // On expiry `start.cancel('budget')` kills the abandoned ct child and
      // the core charges the miss as one breaker failure right then (a child
      // that never closes still counts), the same on every host. The query
      // then reports `budget`, never a success.
      const match = await settleWithin(start.match, this.budgetMs, () => start.cancel('budget'));
      // The core re-gates on a FRESH ledger (results that arrived while we
      // waited included), selects one fact, updates the N3 cache and reports.
      const outcome = finishActivityOutcome(this.adapter, session, activity, match);
      claimed = null; // settled: from here on the outcome decides
      if (outcome.block === null) {
        // Free the key for a LATER step; this step keeps its one query.
        if (outcome.retry) this.tracker.releaseKey(sessionKey, activity.key);
        return result;
      }
      this.adapter.noteRunIds(sessionKey, runId, scanIds(outcome.block));
      return { ...(obj(result) as Record<string, unknown>), content: [...content, { type: 'text', text: outcome.block }] };
    } catch {
      // An unexpected throw after the claim must not burn the step or key.
      if (claimed !== null) this.tracker.release(sessionKey, claimed.stepId, claimed.key);
      this.debug(sessionKey, 'hook_failed');
      return result;
    }
  }

  /** TEST-ONLY: forget keys and steps. */
  _resetForTests(): void {
    this.tracker.reset();
    this.steps.clear();
  }
}

/** Marker ids in every text part of a tool result. */
function resultIds(result: unknown): string[] {
  const ids = new Set<string>();
  for (const text of partTexts(obj(result)?.content)) for (const id of scanIds(text)) ids.add(id);
  return [...ids];
}

/** OpenClaw's deferred-tool meta tool (`args.id = "mcp:<server>:<tool>"`, live-verified). */
export const META_TOOL = 'tool_call';
/** Bound on waiting for a first-use locate + probe (separate from the match budget). */
export const READY_WAIT_MS = 2_000;


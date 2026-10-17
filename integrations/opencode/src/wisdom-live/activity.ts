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
  ACTIVITY_MAX_BLOCK_CHARS,
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
  startActivity,
  type Activity,
  type ActivitySpec,
  type Breaker,
  type HostAdapter,
  type Ledger,
  type MatchOutcome,
  type SessionRef,
  type VerboseTurn,
  type WisdomMatchResult,
} from '@equational-applications/ct-wisdom-core';

import type { OpenCodeWisdomAdapter } from './adapter.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

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
  return isCtTool(name) || name.includes('_curated_') || name.startsWith('curated_');
}

/** Experimental code mode's child MCP calls (`<parent callID>/<n>`) feed a script, not the model. */
export function isCodeModeCall(callID: unknown): boolean {
  return typeof callID === 'string' && callID.includes('/');
}

// ─────────────────────────────────────────────────────────────────────────
// placement
// ─────────────────────────────────────────────────────────────────────────

/** The host's default MCP output truncation (Truncate MAX_LINES / MAX_BYTES, head direction). */
export const MCP_MAX_LINES = 2000;
export const MCP_MAX_BYTES = 51200;

function mcpJoined(content: unknown[]): string {
  const out: string[] = [];
  for (const item of content) {
    if (!isObj(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') out.push(item.text);
    else if (item.type === 'resource' && isObj(item.resource) && typeof item.resource.text === 'string') out.push(item.resource.text);
  }
  return out.join('\n');
}

/**
 * Whether this output can carry a block: a builtin `{output: string}`, or
 * an MCP result whose joined text plus a worst-case block stays under the
 * host's head-direction truncation (so the block, the tail, is never cut).
 */
export function canCarry(output: unknown): boolean {
  if (!isObj(output)) return false;
  if (Array.isArray(output.content)) {
    const joined = mcpJoined(output.content);
    const lines = joined.split('\n').length;
    const bytes = Buffer.byteLength(joined, 'utf8');
    return lines + 2 + ACTIVITY_MAX_BLOCK_CHARS <= MCP_MAX_LINES && bytes + 2 + 4 * ACTIVITY_MAX_BLOCK_CHARS <= MCP_MAX_BYTES;
  }
  return typeof output.output === 'string';
}

/** Append the block after a blank line: builtin `output`, or the LAST MCP text item. */
export function placeBlock(output: Record<string, unknown>, block: string): void {
  const join = (text: string) => (text === '' ? block : `${text}\n\n${block}`);
  if (Array.isArray(output.content)) {
    const content = output.content as unknown[];
    for (let i = content.length - 1; i >= 0; i--) {
      const item = content[i];
      if (isObj(item) && item.type === 'text' && typeof item.text === 'string') {
        content[i] = { ...item, text: join(item.text) };
        return;
      }
    }
    content.push({ type: 'text', text: block });
    return;
  }
  output.output = join(output.output as string);
}

// ─────────────────────────────────────────────────────────────────────────
// the gate-facing host: the core gates read the activity view
// ─────────────────────────────────────────────────────────────────────────

/**
 * A HostAdapter for the core's activity gates: CT calls, the N3 turn cache
 * and verbose output go to the OpenCode adapter; `rebuildLedger` is the
 * session's OWN view fetched just before the gate; `deliveryEnabled` is
 * "session kind known" (subagents included, a failed lookup is not).
 */
export class ActivityHost implements HostAdapter {
  private readonly views = new Map<string, Ledger>();
  declare readonly recordVerbose?: (turn: VerboseTurn) => void;

  constructor(private readonly a: OpenCodeWisdomAdapter) {
    const rec = a.recordVerbose;
    if (rec) this.recordVerbose = (turn) => rec.call(a, turn);
  }

  setView(sessionId: string, ledger: Ledger): void {
    lruSet(this.views, sessionId, ledger, 256);
  }

  deliveryEnabled(session: SessionRef): boolean {
    return this.a.sessionKnown(session.id);
  }

  restored(): boolean {
    return false; // LD10: resume rebuilds from the same persisted history
  }

  rebuildLedger(session: SessionRef): Ledger {
    return this.views.get(session.id) ?? EMPTY_LEDGER;
  }

  cacheLedger(session: SessionRef, ledger: Ledger): void {
    this.a.cacheLedger(session, ledger);
  }

  cachedLedger(session: SessionRef): Ledger | null {
    return this.a.cachedLedger(session);
  }

  wisdomMatch(query: string, max: number, exclude: string[]): Promise<{ outcome: MatchOutcome; result?: WisdomMatchResult }> {
    return this.a.wisdomMatch(query, max, exclude);
  }

  isCtRecallResult(result: unknown): boolean {
    return this.a.isCtRecallResult(result);
  }

  envelopeFactIds(result: unknown): string[] {
    return this.a.envelopeFactIds(result);
  }

  rewriteEnvelopeStub(result: unknown, repeats: string[], newIds: string[]): unknown {
    return this.a.rewriteEnvelopeStub(result, repeats, newIds);
  }

  resetDiscoveryAndProbeCaches(): void {
    this.a.resetDiscoveryAndProbeCaches();
  }

  wisdomMatchAbsent(): boolean {
    return this.a.wisdomMatchAbsent();
  }

  deliver(): void {
    /* the channel is the tool output (placeBlock) */
  }

  noteDelivered(): void {
    /* never for activity (DSH review): the ledger is what the agent sees */
  }
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
  /** One debug line per skip; unwired in index.ts (the plugin has no local logger). */
  log?: (line: string) => void;
}

const PLANS_MAX = 256;

export class OpenCodeActivity {
  private readonly tracker = new ActivityTracker();
  private readonly plans = new Map<string, Activity>();
  private readonly inflight = new Set<string>();
  private readonly host: ActivityHost;
  private readonly adapter: OpenCodeWisdomAdapter;
  private readonly breakerFor: (sessionId: string) => Breaker;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly log?: (line: string) => void;

  constructor(deps: OpenCodeActivityDeps) {
    this.adapter = deps.adapter;
    this.host = new ActivityHost(deps.adapter);
    this.breakerFor = deps.breakerFor;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => Date.now());
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
      await this.adapter.sessionKind(sessionID); // caches the session directory
      const activity = buildActivity(spec, this.adapter.sessionDirectory(sessionID), this.env);
      if (activity === null || activityQuery(activity) === '') return this.debug(sessionID, 'no_activity');
      lruSet(this.plans, `${sessionID}\u0000${callID}`, activity, PLANS_MAX);
    } catch {
      this.debug(sessionID, 'hook_failed');
    }
  }

  /** `tool.execute.after`: start (the call is approved), await ≤ 3 s, deliver into `output`. */
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
      try {
        await this.run(sessionID, callID, activity, output as Record<string, unknown>);
      } finally {
        this.inflight.delete(sessionID);
      }
    } catch {
      this.debug(sessionID, 'hook_failed');
    }
  }

  private async run(sessionID: string, callID: string, activity: Activity, output: Record<string, unknown>): Promise<void> {
    await this.adapter.sessionKind(sessionID);
    const view = await this.adapter.activityView(sessionID);
    const step = view.stepOf(callID);
    if (step === null) return this.debug(sessionID, 'no_step');
    const refused = this.tracker.peek(sessionID, step, activity.key);
    if (refused !== null) return this.debug(sessionID, refused);
    const session = { id: sessionID };
    this.host.setView(sessionID, view.ledger);
    const deadline = this.now() + TIMEOUT_MS;
    const start = startActivity(this.host, session, activity, this.breakerFor(sessionID));
    if (start.failure !== null) {
      this.debug(sessionID, start.failure);
      if (this.tracker.firstReport(sessionID, step)) {
        reportActivity(this.host, session, activity, { kind: 'skip', reason: start.failure });
      }
      return;
    }
    this.tracker.admit(sessionID, step, activity.key);
    const match = await settleWithin(start.match, Math.max(0, deadline - this.now()));
    // Fresh again: results of the same step (CT recall markers among them)
    // may have landed while the query ran.
    const fresh = await this.adapter.activityView(sessionID);
    this.host.setView(sessionID, fresh.ledger);
    const outcome = finishActivityOutcome(this.host, session, activity, match);
    if (outcome.retry) this.tracker.release(sessionID, step, activity.key);
    if (outcome.block === null) return;
    // Recorded BEFORE placement: lost on a crash, never shown twice.
    this.adapter.noteUnpersisted(sessionID, scanIds(outcome.block));
    placeBlock(output, outcome.block);
  }

  /** TEST-ONLY. */
  _resetForTests(): void {
    this.tracker.reset();
    this.plans.clear();
    this.inflight.clear();
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

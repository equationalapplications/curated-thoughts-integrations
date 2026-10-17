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
  settleWithin,
  startActivity,
  type Activity,
  type ActivitySpec,
  type Breaker,
  type Ledger,
  type SessionRef,
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

/** The host's default MCP output truncation (Truncate MAX_LINES / MAX_BYTES, head direction). */
export const MCP_MAX_LINES = 2000;
export const MCP_MAX_BYTES = 51200;
/**
 * Lines a block adds to the joined output, worst case for the guard: the
 * separator, heading, label, blank and title lines, and a few text lines.
 * A fact text with more newlines can only push its own tail past the cut;
 * the marker comes first, so the fact is never visible without it.
 */
export const BLOCK_LINES_WORST = 8;

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
    return lines + BLOCK_LINES_WORST <= MCP_MAX_LINES && bytes + 2 + 4 * ACTIVITY_MAX_BLOCK_CHARS <= MCP_MAX_BYTES;
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

/** The adapter seen by the core activity gates, plus the view setter. */
export type ActivityHost = OpenCodeWisdomAdapter & { setView(sessionId: string, ledger: Ledger): void };

/**
 * The adapter itself (`Object.create(adapter)`, review of PR #66) with only
 * what differs for activity delivery:
 *   - `rebuildLedger` is the session's OWN view fetched just before the gate;
 *   - `deliveryEnabled` is "session kind known" (subagents included, a failed
 *     lookup is not);
 *   - `restored` is false (LD10);
 *   - `deliver` / `noteDelivered` do nothing (the channel is the tool output;
 *     an activity id never enters the user-turn record, DSH review).
 * The methods that ASSIGN adapter fields (the capability latch and probe
 * cache) are bound to the adapter: called on the derived object they would
 * write a shadowing property there, and the latch would never reach the
 * user-turn path.
 */
export function activityHost(adapter: OpenCodeWisdomAdapter): ActivityHost {
  const views = new Map<string, Ledger>();
  const host = Object.create(adapter) as ActivityHost;
  Object.assign(host, {
    setView(sessionId: string, ledger: Ledger): void {
      lruSet(views, sessionId, ledger, 256);
    },
    deliveryEnabled: (session: SessionRef): boolean => adapter.sessionKnown(session.id),
    restored: (): boolean => false,
    rebuildLedger: (session: SessionRef): Ledger => views.get(session.id) ?? EMPTY_LEDGER,
    deliver: (): void => {},
    noteDelivered: (): void => {},
    wisdomMatch: adapter.wisdomMatch.bind(adapter),
    resetDiscoveryAndProbeCaches: adapter.resetDiscoveryAndProbeCaches.bind(adapter),
  });
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
  private readonly budgetMs: number;
  private readonly log?: (line: string) => void;

  constructor(deps: OpenCodeActivityDeps) {
    this.adapter = deps.adapter;
    this.host = activityHost(deps.adapter);
    this.breakerFor = deps.breakerFor;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => Date.now());
    this.budgetMs = deps.budgetMs ?? TIMEOUT_MS;
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
      // Caches the session directory; bounded (a hung lookup plans nothing).
      const kind = await settleWithin(this.adapter.sessionKind(sessionID), this.budgetMs);
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
    const kind = await settleWithin(this.adapter.sessionKind(sessionID), left());
    if (kind === null) return this.debug(sessionID, 'budget');
    // ONE history fetch per triggering call (review of PR #66).
    const view = await settleWithin(this.adapter.activityView(sessionID), left());
    if (view === null) return this.debug(sessionID, 'budget');
    const step = view.stepOf(callID);
    if (step === null) return this.debug(sessionID, 'no_step');
    const refused = this.tracker.peek(sessionID, step, activity.key);
    if (refused !== null) return this.debug(sessionID, refused);
    const session = { id: sessionID };
    this.host.setView(sessionID, view.ledger);
    const abort = new AbortController();
    const start = startActivity(this.host, session, activity, this.breakerFor(sessionID), abort.signal);
    if (start.failure !== null) {
      this.debug(sessionID, start.failure);
      if (this.tracker.firstReport(sessionID, step)) {
        reportActivity(this.host, session, activity, { kind: 'skip', reason: start.failure });
      }
      return;
    }
    this.tracker.admit(sessionID, step, activity.key);
    hold(start.match);
    // On expiry the ct child is killed (abort), and the query counts as
    // `budget`: never a breaker failure.
    const match = await settleWithin(start.match, left(), () => abort.abort());
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

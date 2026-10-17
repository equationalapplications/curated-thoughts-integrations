/**
 * Curated Thoughts for OpenClaw — native plugin entry (host pin
 * openclaw@2026.10.3; spec docs/superpowers/specs/2026-10-16-openclaw-wisdom-parity-leg-design.md).
 *
 * The manifest (openclaw.plugin.json) owns the static surfaces: the
 * `curated-thoughts` MCP server and the three skill directories. This module
 * owns the runtime surfaces:
 *
 *   agent_turn_prepare   — observe OUR drained next-turn injections so their
 *                          ids join this turn's ledger (three-channel dedupe).
 *   before_prompt_build  — N5 bootstrap → prependSystemContext (memoized per
 *                          session), N1+N2 live wisdom → prependContext; a
 *                          result the host no longer accepts is salvaged
 *                          through api.session.workflow.enqueueNextTurnInjection.
 *   model_call_started   — observe-only: the model step id for the activity
 *                          rate rule (one CT call per step).
 *   tool-result middleware (runtime "openclaw") — N3 dedup stub on CT recall,
 *                          then autonomous-work ("activity") delivery: one
 *                          marker-first block appended to the result of an
 *                          executed call whose activity is new (spec
 *                          2026-10-17-openclaw-autonomous-work-wisdom-design.md).
 *
 * Every handler is fail-open for the host: an exception is logged and the
 * handler returns nothing, so the turn proceeds without our contribution.
 */

import { createHash } from 'node:crypto';
import {
  Breaker,
  onToolResult,
  onUserTurn,
  scanIds,
  validId,
  type SpawnFn,
} from '@equational-applications/ct-wisdom-core';
import { expandHome } from '../scripts/ct_env.js';
import {
  str,
  type AgentCtx,
  type ModelCallCtx,
  type ModelCallEvent,
  type OpenClawApiLike,
  type PromptBuildEvent,
  type PromptBuildResult,
  type ToolResultCtx,
  type ToolResultEvent,
  type TurnPrepareEvent,
} from './host.js';
import { OpenClawActivity } from './wisdom/activity.js';
import { OpenClawWisdomAdapter, isRecallToolName } from './wisdom/adapter.js';
import { BootstrapMemo } from './wisdom/bootstrap.js';
import { CtLocator } from './wisdom/discover.js';
import { nodeSpawnFn } from './wisdom/spawn.js';
import { openclawVerboseRecorder } from './wisdom/verbose.js';

export const PLUGIN_ID = 'curated-thoughts';
/** First-turn worst case is ~14 s (spec "Budgets"); the default is 15 s. */
export const PROMPT_HOOK_TIMEOUT_MS = 20_000;
/** Salvaged blocks expire if the session never takes another turn. */
export const SALVAGE_TTL_MS = 30 * 60_000;
const LRU_MAX = 512;
const SUBAGENT_KEY_RE = /(^|:)subagent:/i;

export interface PluginDeps {
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  candidates?: () => string[];
  usable?: (path: string) => boolean;
  now?: () => number;
  /** TEST-ONLY: the activity query budget (default the core's 3 s). */
  activityBudgetMs?: number;
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > LRU_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** N1 gate: a genuine user turn in a parent (non-subagent) session. */
export function isLiveEligible(ctx: AgentCtx, sessionKey: string): boolean {
  if (ctx.trigger !== 'user') return false;
  const prov = ctx.inputProvenance;
  if (prov && typeof prov === 'object') {
    if (prov.kind !== undefined && prov.kind !== 'external_user') return false;
    if (prov.sourceRole === 'subagent') return false;
  }
  return !SUBAGENT_KEY_RE.test(sessionKey);
}

function brainEnv(base: NodeJS.ProcessEnv, configured: unknown): NodeJS.ProcessEnv {
  // An ambient CURATED_BRAIN_DIR wins over the plugin config; `ct` does not
  // expand a leading `~`, so whichever wins is expanded here.
  const raw = base.CURATED_BRAIN_DIR || (typeof configured === 'string' ? configured : '');
  return raw ? { ...base, CURATED_BRAIN_DIR: expandHome(raw, base) } : base;
}

/** Everything the hooks and the middleware must share within one process. */
interface PluginState {
  current: OpenClawApiLike;
  adapter: OpenClawWisdomAdapter;
  breaker: Breaker;
  activity: OpenClawActivity;
  bootstrap: BootstrapMemo;
  /** sessionKey → restored? (decided at this process's first sighting). */
  sightings: Map<string, boolean>;
  /** `${sessionKey}#${runId}` → ids drained into that run from our injections. */
  drained: Map<string, string[]>;
  /** `${sessionKey}#${admission}` → the one result for that admitted request. */
  admissions: Map<string, Promise<PromptBuildResult | undefined>>;
}

/** Where a plugin object keeps its state; the default export uses a process-wide one. */
export interface StateHolder {
  state?: PluginState;
}

/** Bump when PluginState changes shape (a reload of new code never reuses old state). */
const STATE_KEY = Symbol.for('curated-thoughts.openclaw.plugin-state.v1');

/** The process-wide holder shared by every module instance of this plugin. */
export function processStateHolder(): StateHolder {
  const g = globalThis as unknown as Record<symbol, StateHolder | undefined>;
  return (g[STATE_KEY] ??= {});
}

function makeState(api: OpenClawApiLike, deps: PluginDeps): PluginState {
  const env = brainEnv(deps.env ?? process.env, api.pluginConfig?.brainDir);
  const spawnFn = deps.spawnFn ?? nodeSpawnFn(env);
  const locator = new CtLocator({
    env: deps.env ?? process.env, // discovery reads the host PATH as-is
    spawnFn,
    candidates: deps.candidates,
    usable: deps.usable,
    now: deps.now,
  });
  // `logger` resolves to the newest registration's logger at call time.
  const logger = { get logger() { return state.current.logger; } };
  const adapter = new OpenClawWisdomAdapter({
    spawnFn,
    locator,
    recordVerbose: openclawVerboseRecorder(logger, deps.env ?? process.env),
  });
  const breaker = new Breaker(undefined, undefined, deps.now);
  const state: PluginState = {
    current: api,
    adapter,
    breaker,
    activity: new OpenClawActivity({
      adapter,
      breaker, // shared with the user-turn path (rule 4)
      env: deps.env ?? process.env,
      ...(deps.activityBudgetMs !== undefined ? { budgetMs: deps.activityBudgetMs } : {}),
      log: (line) => state.current.logger?.debug?.(`curated-thoughts: ${line}`),
    }),
    bootstrap: new BootstrapMemo({
      locate: () => locator.locate(),
      spawnFn,
      onSpawnFailure: () => locator.invalidate(),
    }),
    sightings: new Map(),
    drained: new Map(),
    admissions: new Map(),
  };
  return state;
}

export function createPlugin(deps: PluginDeps = {}, holder: StateHolder = {}) {
  return {
    id: PLUGIN_ID,
    name: 'Curated Thoughts',
    description:
      'Curated Thoughts memory for OpenClaw: bootstrap memory block and Intuitive Wisdom live delivery.',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { brainDir: { type: 'string' } },
    },
    register(api: OpenClawApiLike): void {
      // One state per process, whichever registration a hook came from: the
      // host loads the plugin module several times (live-verified: 3 module
      // instances per process; the prompt hooks and the tool-result
      // middleware are served by DIFFERENT instances), so per-registration
      // state would leave the middleware without the prompt hook's ledger.
      const state = (holder.state ??= makeState(api, deps));
      state.current = api; // the logger the shared parts report through
      const { adapter, breaker, activity, bootstrap, sightings, drained, admissions } = state;
      const warn = (what: string, error: unknown): void => {
        try {
          api.logger?.warn?.(`curated-thoughts: ${what}: ${String(error)}`);
        } catch {
          /* a throwing logger must not escalate */
        }
      };

      // ── agent_turn_prepare: observe our own drained injections ──────────
      api.on('agent_turn_prepare', ((event: TurnPrepareEvent, ctx: AgentCtx) => {
        try {
          const sessionKey = str(ctx?.sessionKey);
          const records = event?.queuedInjections;
          if (sessionKey === '' || !Array.isArray(records)) return undefined;
          const ids: string[] = [];
          for (const rec of records) {
            if (rec === null || typeof rec !== 'object') continue;
            const r = rec as { pluginId?: unknown; text?: unknown; metadata?: unknown };
            if (r.pluginId !== api.id) continue;
            const meta = r.metadata as { ctFactIds?: unknown } | null | undefined;
            const metaIds = Array.isArray(meta?.ctFactIds) ? meta.ctFactIds : [];
            for (const id of [...metaIds, ...scanIds(r.text)]) {
              if (validId(id) && !ids.includes(id)) ids.push(id);
            }
          }
          if (ids.length) lruSet(drained, `${sessionKey}#${str(ctx.runId)}`, ids);
        } catch (error) {
          warn('agent_turn_prepare failed', error);
        }
        return undefined;
      }) as never);

      // ── salvage: a result the host will not accept goes to the durable queue
      const salvage = async (ctx: AgentCtx, sessionKey: string, block: string): Promise<void> => {
        const enqueue = api.session?.workflow?.enqueueNextTurnInjection;
        if (typeof enqueue !== 'function') return;
        const ids = scanIds(block);
        const digest = createHash('sha256').update(block).digest('hex').slice(0, 16);
        await enqueue.call(api.session?.workflow, {
          sessionKey,
          ...(str(ctx.agentId) ? { agentId: str(ctx.agentId) } : {}),
          text: block,
          idempotencyKey: `ct-wisdom:${ids.length ? ids.join(',') : digest}`,
          placement: 'prepend_context',
          ttlMs: SALVAGE_TTL_MS,
          metadata: { ctFactIds: ids },
        });
      };

      const compute = async (event: PromptBuildEvent, ctx: AgentCtx, sessionKey: string, admissionKey: string | null): Promise<PromptBuildResult | undefined> => {
        const bootKey = `${sessionKey}|${str(ctx.sessionId)}`;
        const boot = await bootstrap.ensure(bootKey);
        const result: PromptBuildResult = {};
        if (boot?.block) result.prependSystemContext = boot.block;

        const messages = event?.messages;
        if (Array.isArray(messages)) {
          let restored = sightings.get(sessionKey);
          if (restored === undefined) {
            // The session predates this process when its snapshot already
            // holds assistant turns (gateway restart / resumed session).
            restored = messages.some((m) => (m as { role?: unknown } | null)?.role === 'assistant');
            lruSet(sightings, sessionKey, restored);
          }
          // Every run's snapshot is stored (any trigger, subagents too): it is
          // the ledger source for this run's activity deliveries.
          adapter.setTurn(sessionKey, {
            runId: str(ctx.runId),
            messages,
            drained: drained.get(`${sessionKey}#${str(ctx.runId)}`) ?? [],
            bootstrapIds: boot ? boot.ids : null,
            restored,
          });
        }
        if (admissionKey !== null && Array.isArray(messages) && isLiveEligible(ctx, sessionKey)) {
          const query = typeof event.currentUserMessage === 'string'
            ? event.currentUserMessage
            : str(event.prompt); // legacy hosts: prompt may carry history (degraded)
          const block = await onUserTurn(adapter, { id: sessionKey }, query, breaker);
          if (block !== null) {
            let accepted = true;
            try {
              ctx.hookInvocation?.assertActive();
            } catch {
              accepted = false;
            }
            if (accepted) result.prependContext = block;
            else await salvage(ctx, sessionKey, block);
          }
        }
        return Object.keys(result).length ? result : undefined;
      };

      // ── before_prompt_build: bootstrap (N5) + live delivery (N1/N2) ──────
      api.on('before_prompt_build', (async (event: PromptBuildEvent, ctx: AgentCtx) => {
        try {
          const sessionKey = str(ctx?.sessionKey);
          if (sessionKey === '') return undefined; // invariant 3
          const admission = str(event?.currentUserMessageId) || str(ctx.runId);
          const admissionKey = admission ? `${sessionKey}#${admission}` : null;
          if (admissionKey !== null) {
            const prior = admissions.get(admissionKey);
            if (prior) return await prior; // rebuild/retry: same bytes, no new CT call
          }
          // Only a SUCCESSFUL result is memoized for the admission: a failure
          // (e.g. a rejected salvage enqueue) drops the entry so a host retry
          // of the same request gets a fresh attempt instead of a cached nothing.
          const run = compute(event, ctx, sessionKey, admissionKey).catch((error) => {
            warn('before_prompt_build failed', error);
            if (admissionKey !== null) admissions.delete(admissionKey);
            return undefined;
          });
          if (admissionKey !== null) lruSet(admissions, admissionKey, run);
          return await run;
        } catch (error) {
          warn('before_prompt_build failed', error);
          return undefined;
        }
      }) as never, { timeoutMs: PROMPT_HOOK_TIMEOUT_MS });

      // ── model_call_started: the step id of the activity rate rule ───────
      api.on('model_call_started', ((event: ModelCallEvent, ctx: ModelCallCtx) => {
        activity.noteModelCall(event, ctx);
        return undefined;
      }) as never);

      // ── tool-result middleware: N3 recall dedup, then activity delivery ──
      // Never throws: a throwing middleware makes OpenClaw replace the tool
      // output with an error text.
      if (typeof api.registerAgentToolResultMiddleware === 'function') {
        api.registerAgentToolResultMiddleware((async (event: ToolResultEvent, ctx: ToolResultCtx) => {
          try {
            const sessionKey = str(ctx?.sessionKey);
            if (sessionKey === '' || event === null || typeof event !== 'object') return undefined;
            let result = event.result;
            if (isRecallToolName(event.toolName) && event.isError !== true) {
              result = onToolResult(adapter, { id: sessionKey }, result);
            }
            result = await activity.process(event, ctx, result);
            return result === event.result ? undefined : { result };
          } catch (error) {
            warn('tool-result middleware failed', error);
            return undefined;
          }
        }) as never, { runtimes: ['openclaw'] });
      }
    },
  };
}

// The process-wide holder: every module instance the host loads shares one state.
const plugin = createPlugin({}, processStateHolder());
export default plugin;

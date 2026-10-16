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
 *   tool-result middleware (runtime "openclaw") — N3 dedup stub on CT recall.
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
  type OpenClawApiLike,
  type PromptBuildEvent,
  type PromptBuildResult,
  type ToolResultCtx,
  type ToolResultEvent,
  type TurnPrepareEvent,
} from './host.js';
import { OpenClawWisdomAdapter, isRecallToolName } from './wisdom/adapter.js';
import { BootstrapMemo } from './wisdom/bootstrap.js';
import { CtLocator } from './wisdom/discover.js';
import { nodeSpawnFn } from './wisdom/spawn.js';

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

export function createPlugin(deps: PluginDeps = {}) {
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
      const env = brainEnv(deps.env ?? process.env, api.pluginConfig?.brainDir);
      const spawnFn = deps.spawnFn ?? nodeSpawnFn(env);
      const locator = new CtLocator({
        env: deps.env ?? process.env, // discovery reads the host PATH as-is
        spawnFn,
        candidates: deps.candidates,
        usable: deps.usable,
        now: deps.now,
      });
      const adapter = new OpenClawWisdomAdapter({ spawnFn, locator });
      const breaker = new Breaker(undefined, undefined, deps.now);
      const bootstrap = new BootstrapMemo({
        locate: () => locator.locate(),
        spawnFn,
        onSpawnFailure: () => locator.invalidate(),
      });
      const warn = (what: string, error: unknown): void => {
        try {
          api.logger?.warn?.(`curated-thoughts: ${what}: ${String(error)}`);
        } catch {
          /* a throwing logger must not escalate */
        }
      };

      /** sessionKey → restored? (decided at this process's first sighting). */
      const sightings = new Map<string, boolean>();
      /** `${sessionKey}#${runId}` → ids drained into that run from our injections. */
      const drained = new Map<string, string[]>();
      /** `${sessionKey}#${admission}` → the one result for that admitted request. */
      const admissions = new Map<string, Promise<PromptBuildResult | undefined>>();

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
        if (admissionKey !== null && Array.isArray(messages) && isLiveEligible(ctx, sessionKey)) {
          let restored = sightings.get(sessionKey);
          if (restored === undefined) {
            // The session predates this process when its snapshot already
            // holds assistant turns (gateway restart / resumed session).
            restored = messages.some((m) => (m as { role?: unknown } | null)?.role === 'assistant');
            lruSet(sightings, sessionKey, restored);
          }
          adapter.setTurn(sessionKey, {
            messages,
            drained: drained.get(`${sessionKey}#${str(ctx.runId)}`) ?? [],
            bootstrapIds: boot ? boot.ids : null,
            restored,
          });
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

      // ── N3: tool-result middleware on CT recall results only ─────────────
      if (typeof api.registerAgentToolResultMiddleware === 'function') {
        api.registerAgentToolResultMiddleware(((event: ToolResultEvent, ctx: ToolResultCtx) => {
          try {
            if (!isRecallToolName(event?.toolName) || event.isError === true) return undefined;
            const sessionKey = str(ctx?.sessionKey);
            if (sessionKey === '') return undefined;
            const rewritten = onToolResult(adapter, { id: sessionKey }, event.result);
            return rewritten === event.result ? undefined : { result: rewritten };
          } catch (error) {
            warn('tool-result middleware failed', error);
            return undefined;
          }
        }) as never, { runtimes: ['openclaw'] });
      }
    },
  };
}

const plugin = createPlugin();
export default plugin;

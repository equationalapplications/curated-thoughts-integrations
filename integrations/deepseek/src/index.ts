import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { probe } from './status.js';
import { formatStatusBlock } from './format.js';
import { renderWisdom, WisdomMemo, keyOf, scanIds } from './wisdom.js';
import {
  DshWisdomAdapter,
  userMessageText,
  isRecallToolName,
  runUserTurn,
  runToolResult,
} from './wisdom-live/adapter.js';
import { Breaker } from '@equational-applications/ct-wisdom-core';
import type { MemoRecord } from './wisdom-live/adapter.js';
import { expandHome } from '../scripts/ct_env.js';

export interface Config {
  brainDir?: string;
}

/**
 * The sidecar command is not configurable here: the MCP client row lives in
 * cordis.patch.yml, so override `command` on that row from a profile patch.
 * The brainDir default is a plain literal — Schema.default() takes a value,
 * so an env lookup here would be frozen at module load. An ambient
 * CURATED_BRAIN_DIR is honored in apply() instead (and by the bundle patch).
 */
export const Config: Schema<Config> = Schema.object({
  brainDir: Schema.string().default('~/.brain'),
});

/**
 * The DSH services this plugin's `apply` touches. Without this export the
 * host never injects them and apply() crashes with `cannot get property
 * "systemPrompt" without inject`.
 */
export const inject = ['systemPrompt', 'skills'] as const;

/**
 * The MCP client is NOT mounted from here: cordis rejects
 * `ctx.plugin('@deepseek-ai/dsh-mcp-client', ...)` — a plugin must be a
 * function or an object with an `apply` method, never a string. The mount is
 * declarative instead: `cordis.patch.yml` ships in the package (declared via
 * package.json `dsh.bundle.patch`) and carries both this plugin's row and
 * the `@deepseek-ai/dsh-mcp-client` stdio row, so `dsh plugin add` activates
 * the whole set. This module is therefore only the prompt context, the
 * session-start refresh, and the skills.
 */

/**
 * Prompt-context position. dsh's getContextOrder() only knows its built-in
 * sections (SANDBOX_POLICY 110, APPROVAL_POLICY 115, SUBAGENT_DELEGATION
 * 120) and returns undefined for anything else, which fails the finite-order
 * validation — so the order is stated here rather than looked up. 130 puts
 * the health block after all built-ins, closest to the conversation.
 */
const CURATED_CONTEXT_ORDER = 130;

/**
 * Wisdom section position (spec L54 names the section). 6000 sits behind the
 * health block and every built-in: memory is the least urgent system-prompt
 * content and must never crowd out policy sections. Named constant like
 * CURATED_CONTEXT_ORDER above (cycle-8 m4).
 */
export const CURATED_WISDOM_SECTION_ORDER = 6000;

const SKILL_NAMES = [
  'curated-thoughts-usage',
  'curated-thoughts-ops',
  'curated-thoughts-sidecar',
] as const;

type SkillName = (typeof SKILL_NAMES)[number];

const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  'curated-thoughts-usage':
    'When to reach for Curated Thoughts memory; tool routing (wiki_context first, raw tools for deep work); write paths (vault notes vs CT wisdom, never raw SQLite).',
  'curated-thoughts-ops':
    'Operator-facing: doctor, pre-flight, brain import/export, sidecar management, OKF frontmatter hygiene.',
  'curated-thoughts-sidecar':
    'Sidecar-level: tier semantics, MCP handshake details, evidence / provenance mechanics, respawn behavior.',
};

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the package's `skills/` directory starting from this module's
 * compiled location. Works both installed (lib/src/index.js → <pkg>/skills)
 * and from source (src/index.ts → <pkg>/skills) by walking up until a
 * directory that actually contains the shipped skills is found.
 */
function findSkillsRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'skills');
    if (
      existsSync(join(candidate, 'curated-thoughts-usage', 'SKILL.md')) &&
      existsSync(join(candidate, 'curated-thoughts-ops', 'SKILL.md')) &&
      existsSync(join(candidate, 'curated-thoughts-sidecar', 'SKILL.md'))
    ) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback mirrors the compiled layout: lib/src → package root.
  return join(HERE, '..', '..', 'skills');
}

export const SKILLS_ROOT = findSkillsRoot(HERE);

function readSkill(name: SkillName): string {
  return readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
}

/**
 * DSH augments `ctx` with `ctx.systemPrompt.*`, `ctx.skills.register(...)`,
 * and `ctx.on('agent/session-start', ...)` via TypeScript module augmentation
 * from `@deepseek-ai/dsh-*` plugins that ship with the dsh consumer runtime.
 * `@deepseek-ai/cordis` alone doesn't expose these — that's expected per
 * dsh's plugin model.
 *
 * We narrow the `Context` shape we actually use to keep the call sites
 * readable without `as any` at every line.
 */
interface DshContextExtensions {
  on(event: 'agent/session-start', listener: () => Promise<void>): unknown;
  on(event: 'agent/created', listener: (payload: AgentCreatedPayload) => Promise<void>): unknown;
  on(event: 'agent/pre-step', listener: PreStepListener): unknown;
  on(event: 'tools/post-execute', listener: PostExecuteListener): unknown;
  systemPrompt: {
    context(c: {
      name: string;
      order: number;
      text: () => string;
    }): unknown;
    section(s: {
      name: string;
      order: number;
      interpolate: boolean;
      text: (assembleCtx: unknown) => string;
    }): unknown;
  };
  skills: {
    register(s: {
      name: string;
      description: string;
      content: string;
      invocation: { modelInvocable: boolean; userInvocable: boolean };
    }): unknown;
  };
}

type DshContext = Context & DshContextExtensions;

/**
 * Host shapes used by the live hooks (DSH 0.2.0-rc.2, verified from the
 * published tarballs — tests/host/compatibility.json pins the version).
 */
interface AgentHandle {
  id: string;
  session?: {
    deriveMessages?: () => unknown[];
  };
}

/** `agent/created` payload: { agent, source: 'startup'|'resume'|'clear'|'compact' }. */
interface AgentCreatedPayload {
  agent: AgentHandle;
}

/** `agent/pre-step` waterfall payload (PreStepDecision carries the messages). */
interface PreStepPayload {
  agent: AgentHandle;
  messages: unknown[];
  turn: number;
  step: number;
}

interface PreStepDecision {
  kind: 'enter' | 'reject';
  messages?: unknown[];
}

type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>;

/** `tools/post-execute` waterfall shapes (dsh-tools types/index.d.ts). */
interface ToolExecutionLike {
  name: string;
  agent?: AgentHandle;
}

interface ToolExecutionResultLike {
  isError: boolean;
  value?: unknown;
  content: Array<{ type: string; text?: string }>;
}

interface PostToolDecision {
  kind: 'accept';
  content?: Array<{ type: string; text?: string }>;
  value?: unknown;
}

type PostExecuteListener = (
  exec: ToolExecutionLike,
  result: ToolExecutionResultLike,
  next: () => Promise<PostToolDecision>,
) => Promise<PostToolDecision>;

export function apply(ctx: Context, config: Config): void {
  const dsh = ctx as DshContext;

  // (0) probe() resolves the brain from the environment it is handed, while
  // the declarative row config is what a user edits — give probe a copy of
  // the env carrying config.brainDir (an explicit CURATED_BRAIN_DIR still
  // wins). A copy, not process.env itself: the row config is this plugin's
  // own state and must not leak into the host process. resolveBrainPaths
  // expands a leading `~`. The sidecar's own copy comes from the bundle
  // patch's MCP row env.
  const probeEnv: NodeJS.ProcessEnv =
    config.brainDir && !process.env.CURATED_BRAIN_DIR
      ? { ...process.env, CURATED_BRAIN_DIR: config.brainDir }
      : process.env;

  // (1) Cached health snapshot. Empty until the first session-start resolves.
  let cached: { text: string; since: number } | null = null;

  // (2) Dynamic prompt context (cache-safe per dsh system-prompt subsystem).
  // text is a function reference so dsh reads the latest cached value lazily
  // at prompt-assembly time, not at registration time. The entry must carry
  // a name and a finite order — see CURATED_CONTEXT_ORDER above.
  dsh.systemPrompt.context({
    name: 'curated-thoughts-health',
    order: CURATED_CONTEXT_ORDER,
    text: () => cached?.text ?? '',
  });

  // (2b) Wisdom section. Opus cycle-6 M1: same precedence as the health
  // probeEnv — an AMBIENT CURATED_BRAIN_DIR wins over the row default
  // ('~/.brain'); expandHome whichever wins (the row default is a literal
  // '~/.brain' and ct's Rust resolver does NOT expand tildes — cycle-5 M2).
  // SNAPSHOT NOTE (m13 cycle 6): wisdomEnv copies process.env at apply() time;
  // later PATH/env changes in the harness process are not seen — accepted for
  // v1. Opus cycle-8 M1: on Windows a spread copy of process.env keeps the
  // ORIGINAL key spelling (`Path`), so wisdomEnv.PATH would be undefined and
  // allPathMatches would find nothing. DISCOVERY candidates are built from
  // process.env (case-insensitive PATH lookup); wisdomEnv is used ONLY as the
  // spawn `env` option.
  const brainDirRaw = process.env.CURATED_BRAIN_DIR || config.brainDir;
  const wisdomEnv: NodeJS.ProcessEnv = brainDirRaw
    ? { ...process.env, CURATED_BRAIN_DIR: expandHome(brainDirRaw) }
    : process.env;
  try {
    dsh.systemPrompt.section({
      name: 'curated-thoughts-wisdom',
      order: CURATED_WISDOM_SECTION_ORDER, // 6000 — named per spec L54 / house CURATED_CONTEXT_ORDER pattern (cycle-8 m4)
      interpolate: false,
      // the host invokes text(assembleCtx) on every model step; renderWisdom
      // reads keyOf from that same {agent, scope, signal} shape; wisdomEnv
      // carries the EXPANDED CURATED_BRAIN_DIR (probe + recall use it).
      // N5 v1 amendment: the rendered bytes are mirrored into
      // bootstrapBlockCache so the live hook (registered below) can record
      // the block's fact ids per agent — "the memo records the block's id
      // list next to its bytes".
      text: (assembleCtx: unknown) => {
        const block = renderWisdom(assembleCtx, { env: wisdomEnv });
        const agentId = keyOf(assembleCtx);
        if (agentId !== '') bootstrapBlockCache.set(agentId, block);
        return block;
      },
    });
  } catch (error) {
    // Host API variance: a throw from section() must not take down what is
    // already registered (mirrors the skills-loop guards).
    console.warn('curated-thoughts: could not register wisdom section:', error);
  }

  // (3) Refresh the health snapshot when an agent enters the registry.
  // MIGRATION (0.2.0-rc.2): the lifecycle event is `agent/created` — payload
  // { agent, source: 'startup'|'resume'|'clear'|'compact' }. The pre-0.2
  // `agent/session-start` event has NO dispatcher at this pin (verified: the
  // runtime-types dispatch table declares agent/created, never
  // agent/session-start), so the old listener never fired and the health
  // block stayed empty. `agent/created` runs for fresh creation AND resumed
  // sessions (source='resume'), which is exactly the refresh surface the old
  // name intended. Fail-open: swallow probe errors so a failed probe never
  // crashes the plugin or the session.
  dsh.on('agent/created', async (payload: AgentCreatedPayload) => {
    try {
      const snap = probe(probeEnv);
      const text = formatStatusBlock(snap);
      cached = { text: text ?? '', since: Date.now() };
    } catch {
      // Keep the previous cached value (or empty).
    }
  });

  // (3b) Intuitive Wisdom live delivery (spec: 2026-10-09 cross-harness
  // parity, DSH leg). One adapter + one breaker per apply() scope.
  //
  // N1 trigger — `agent/pre-step` (waterfall). We call next() FIRST (host
  // ordering + default decision), then append our user message to the
  // decision's messages. The loop persists every decision message of the
  // turn's FIRST attempt verbatim via session.append("user/message"), so the
  // block lands in the session log and the next turn's ledger sees it.
  // Gating: the algorithm runs only on a turn's firstAttempt step — i.e.
  // the first pre-step call whose claimed `messages` batch carries new user
  // input for this turn. We track (agent.id, turn) pairs: multi-step turns
  // and model-retry re-entries of the SAME step must not deliver twice.
  const adapter = new DshWisdomAdapter({ env: wisdomEnv });
  const breaker = new Breaker();
  // Memo-record parity (N5): the live ledger needs the v1 bootstrap ids. The
  // section's memo is module state; mirror it here by recording ids whenever
  // a NEW block is rendered for an agent id (see renderWisdomDeps below).
  const memoRecords: Record<string, MemoRecord> = adapter.bootstrapMemo;
  const liveMemo = new WisdomMemo();
  const memoIdSnapshot = new Map<string, string>();

  /**
   * Record bootstrap ids for an agent id. Hermes parity: "the memo records
   * the block's id list next to its bytes" — the ids come from scanning the
   * rendered block's markers (ct_wisdom_live.bootstrap_ids). A '' result
   * clears the record (a delivered-then-evicted id must not linger).
   */
  const noteMemoBlock = (agentId: string, block: string): void => {
    if (agentId === '') return;
    const prev = memoIdSnapshot.get(agentId);
    if (block === prev) return; // memo hit or unchanged: keep existing record
    memoIdSnapshot.set(agentId, block);
    if (block === '') {
      delete memoRecords[agentId];
      return;
    }
    memoRecords[agentId] = { block, ids: scanIds(block) };
  };

  dsh.on(
    'agent/pre-step',
    async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
      const decision = await next().catch(() => ({ kind: 'reject' }) as PreStepDecision);
      if (decision.kind !== 'enter') return decision;
      try {
        const agentId = typeof payload.agent?.id === 'string' ? payload.agent.id : '';
        // Re-entry guard per turn: exactly one delivery attempt per (agent,
        // turn). The claimed batch may be empty on later steps; the turn
        // number is the gate.
        const turnKey = `${agentId}#${payload.turn}`;
        const claimedUserText = payload.messages
          .map((m) => userMessageText(m))
          .join('\n');
        if (!liveTurns.has(turnKey)) {
          liveTurns.add(turnKey);
          while (liveTurns.size > 512) {
            const oldest = liveTurns.values().next();
            if (oldest.done) break;
            liveTurns.delete(oldest.value);
          }
          // Snapshot the derived session log BEFORE the engine runs: the m5
          // ledger rule rebuilds from what the NEXT trigger reads — the
          // persisted log — never from the pre-step decision itself (its
          // messages are not yet persisted when this waterfall runs).
          const derived =
            typeof payload.agent?.session?.deriveMessages === 'function'
              ? payload.agent.session.deriveMessages()
              : [];
          adapter.sessionMessages.set(agentId, derived);
          // Keep the session log bounded: 128 agents × their latest snapshot.
          while (adapter.sessionMessages.size > 128) {
            const oldest = adapter.sessionMessages.keys().next();
            if (oldest.done) break;
            adapter.sessionMessages.delete(oldest.value);
          }
          noteMemoBlock(agentId, liveMemoBlockFor(agentId));
          const block = await runUserTurn(
            adapter,
            { id: agentId },
            claimedUserText,
            breaker,
          );
          if (block !== null && decision.messages !== undefined) {
            decision.messages = [
              ...decision.messages,
              {
                content: [{ type: 'text', text: block }],
                source: { kind: 'curated-thoughts-wisdom' },
              },
            ];
          }
        }
      } catch (error) {
        // Fail-open: a live-delivery failure must never block the step.
        console.warn('curated-thoughts: wisdom pre-step hook failed:', error);
      }
      return decision;
    },
  );

  /**
   * The v1 bootstrap block as the section memo holds it for this agent,
   * read through the SAME module memo the section renders into. The section
   * may not have assembled yet when the first pre-step fires; reading the
   * module memo (rather than duplicating recall state) keeps the two in
   * sync — a later section render with the same bytes is a no-op for the
   * record, and the next turn's N1 picks the ids up.
   */
  const liveMemoBlockFor = (agentId: string): string => {
    // _last-parity: the module memo's rendered bytes. WisdomMemo stores only
    // memoized blocks; the section's moduleMemo is private, so mirror the
    // render here with a once-per-agent probe. The probe may re-run this
    // cheap closure while the section has not rendered yet (an empty block
    // is never memoized — a memoized '' would hide the bootstrap ids for the
    // whole session); it still never re-recalls anything expensive.
    const block = bootstrapBlockCache.get(agentId) ?? '';
    return liveMemo.renderFor(agentId, () => ({
      block,
      memoize: block !== '',
    }));
  };
  /** Written by the section's text() below on every render (memo hit or miss). */
  const bootstrapBlockCache = new Map<string, string>();

  // N3 transform — `tools/post-execute` (waterfall). MCP tools route through
  // the harness ToolRuntime, so the CT recall surface arrives here. We call
  // next() first, then rewrite the result when the engine asks for it.
  dsh.on(
    'tools/post-execute',
    async (
      exec: ToolExecutionLike,
      result: ToolExecutionResultLike,
      next: () => Promise<PostToolDecision>,
    ) => {
      const decided = await next().catch(
        () => ({ kind: 'accept' }) as PostToolDecision,
      );
      try {
        if (!isRecallToolName(exec?.name) || result?.isError) return decided;
        const agentId =
          typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
        const rewritten = runToolResult(adapter, { id: agentId }, result.value);
        if (rewritten === result.value) return decided;
        return { kind: 'accept', value: rewritten };
      } catch (error) {
        // Fail-open: never break the tool result on a dedup failure.
        console.warn('curated-thoughts: wisdom post-execute hook failed:', error);
        return decided;
      }
    },
  );
  const liveTurns = new Set<string>();

  // (4) Skills. dsh skills are kebab-case Markdown; the three SKILL.md files
  // are ported verbatim from Hermes — the content is agent-generic and dsh
  // reads the same Markdown. Each is registered via the runtime skills
  // provider so dsh surfaces them in <available_skills>.
  // A truncated install, a bad permission, or a broken symlink must cost us
  // the one skill it affects — not the whole plugin. This loop runs last, so
  // an escaping throw would abort apply() after (2)-(3) already registered on
  // this scope, leaving the prompt context to be torn down with it. Hermes'
  // register() (plugin/__init__.py) guards both steps the same way: warn on
  // a missing file, warn on a failed registration, keep going.
  for (const name of SKILL_NAMES) {
    let content: string;
    try {
      content = readSkill(name);
    } catch (error) {
      console.warn(`curated-thoughts: skill file unreadable, skipping ${name}:`, error);
      continue;
    }
    try {
      dsh.skills.register({
        name,
        description: SKILL_DESCRIPTIONS[name],
        content,
        invocation: { modelInvocable: true, userInvocable: true },
      });
    } catch (error) {
      // Host API variance: a register() that rejects one skill must not take
      // the other two down with it.
      console.warn(`curated-thoughts: could not register skill ${name}:`, error);
    }
  }
}

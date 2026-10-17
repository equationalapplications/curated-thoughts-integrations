/**
 * host.ts — the narrow slice of the OpenClaw plugin API this plugin touches,
 * typed locally so the plugin never imports `openclaw` at runtime (the
 * published `definePluginEntry` is an identity-shaped helper, spec F1).
 * Field names are verified against openclaw@2026.10.3's shipped declarations
 * (`dist/hook-runner-global-*.d.ts`, `dist/agent-harness-runtime-*.d.ts`);
 * tests/host/compatibility.json records them and the shape contract checks
 * every name used here against that record. All fields are optional on the
 * host side, so every reader here tolerates their absence.
 */

/** `PluginHookAgentContext` subset (prompt + turn-prepare hooks). */
export interface AgentCtx {
  sessionKey?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  agentId?: unknown;
  /** Run trigger: "user" | "heartbeat" | "cron". */
  trigger?: unknown;
  inputProvenance?: { kind?: unknown; sourceRole?: unknown } | null;
  hookInvocation?: { assertActive(): void } | null;
}

/** `PluginHookBeforePromptBuildEvent`. */
export interface PromptBuildEvent {
  prompt?: unknown;
  currentUserMessage?: unknown;
  currentUserMessageId?: unknown;
  messages?: unknown;
}

/** The two `PluginHookBeforePromptBuildResult` fields this plugin returns. */
export interface PromptBuildResult {
  prependContext?: string;
  prependSystemContext?: string;
}

/** `PluginAgentTurnPrepareEvent` subset. */
export interface TurnPrepareEvent {
  queuedInjections?: unknown;
}

/** `AgentToolResultMiddlewareEvent` subset. */
export interface ToolResultEvent {
  toolCallId?: unknown;
  toolName?: unknown;
  /** Validated (or hook-adjusted) tool parameters; only the target is read. */
  args?: unknown;
  /** The agent workspace dir the file tools resolve against (live-verified). */
  cwd?: unknown;
  isError?: unknown;
  result?: unknown;
}

/** `model_call_started` event subset (observe-only; no prompt content). */
export interface ModelCallEvent {
  runId?: unknown;
  /** `<runId>:model:<n>` — one per model call (the activity step id). */
  callId?: unknown;
}

/** `model_call_started` hook ctx subset. */
export interface ModelCallCtx {
  runId?: unknown;
  sessionKey?: unknown;
}

/** `AgentToolResultMiddlewareContext` subset. */
export interface ToolResultCtx {
  runtime?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
  runId?: unknown;
}

/** `PluginNextTurnInjection`. */
export interface NextTurnInjection {
  sessionKey: string;
  agentId?: string;
  text: string;
  idempotencyKey?: string;
  placement?: 'prepend_context' | 'append_context';
  ttlMs?: number;
  metadata?: unknown;
}

export type HookHandler = (event: never, ctx: never) => unknown;

/** `OpenClawPluginApi` subset. */
export interface OpenClawApiLike {
  id: string;
  pluginConfig?: Record<string, unknown>;
  logger?: { warn?(message: string): void; info?(message: string): void; debug?(message: string): void };
  on(hookName: string, handler: HookHandler, opts?: { timeoutMs?: number; priority?: number }): void;
  registerAgentToolResultMiddleware?(
    handler: (event: never, ctx: never) => unknown,
    opts?: { runtimes?: string[] },
  ): void;
  session?: {
    workflow?: {
      enqueueNextTurnInjection?(injection: NextTurnInjection): Promise<unknown>;
    };
  };
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

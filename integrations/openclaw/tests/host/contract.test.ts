/**
 * Shape-level host contract (parent spec decision 10).
 *
 * WEAKER than the opencode real-binary contract by design: no OpenClaw
 * gateway runs here. It loads the BUILT entry exactly as OpenClaw does
 * (package.json#openclaw.extensions), registers it against a recording stub
 * of the plugin API, and checks every hook name, option, result field and
 * manifest contract the plugin uses against the facts recorded from the
 * pinned host in compatibility.json. A host API rename at a new pin shows up
 * here once compatibility.json is re-verified; live behavior does not.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compat = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'compatibility.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8'));
const ENTRY = join(ROOT, pkg.openclaw.extensions[0]);
const built = existsSync(ENTRY);

interface Recorded { hooks: Array<{ name: string; opts?: Record<string, unknown> }>; middleware: Array<{ opts?: Record<string, unknown> }> }

async function loadAndRegister(): Promise<{ recorded: Recorded; plugin: Record<string, unknown> }> {
  const mod = await import(pathToFileURL(ENTRY).href);
  const plugin = mod.default as { id: string; register(api: unknown): void } & Record<string, unknown>;
  const recorded: Recorded = { hooks: [], middleware: [] };
  plugin.register({
    id: manifest.id,
    pluginConfig: {},
    logger: { warn() {}, debug() {} },
    on: (name: string, _h: unknown, opts?: Record<string, unknown>) => recorded.hooks.push({ name, opts }),
    registerAgentToolResultMiddleware: (_h: unknown, opts?: Record<string, unknown>) => recorded.middleware.push({ opts }),
    session: { workflow: { enqueueNextTurnInjection: async () => ({ enqueued: true, id: 'x', sessionKey: 's' }) } },
  });
  return { recorded, plugin };
}

describe.skipIf(!built)('OpenClaw shape contract (pin %s)'.replace('%s', compat.openclaw), () => {
  it('the pin, the plugin API floor and the install floor agree', () => {
    expect(pkg.openclaw.compat.pluginApi).toBe(`>=${compat.openclaw}`);
    expect(pkg.openclaw.install.minHostVersion).toBe(`>=${compat.openclaw}`);
  });

  it('the built entry default-exports a plugin definition whose id matches the manifest', async () => {
    const { plugin } = await loadAndRegister();
    expect(plugin.id).toBe(manifest.id);
    expect(typeof plugin.register).toBe('function');
    expect(typeof plugin.configSchema).toBe('object');
  });

  it('every registered hook exists at the pin; every option is a known registration option', async () => {
    const { recorded } = await loadAndRegister();
    expect(recorded.hooks.length).toBeGreaterThan(0);
    for (const h of recorded.hooks) {
      expect(compat.hookNames).toContain(h.name);
      for (const key of Object.keys(h.opts ?? {})) expect(compat.hookRegistrationOptions).toContain(key);
      if (h.opts?.timeoutMs !== undefined) {
        expect(h.opts.timeoutMs as number).toBeGreaterThan(compat.defaultPromptHookTimeoutMs);
        expect(h.opts.timeoutMs as number).toBeLessThanOrEqual(compat.hookTimeoutMaxMs);
      }
    }
  });

  it('conversation-access hooks are exactly the ones the installer grants for', async () => {
    const { recorded } = await loadAndRegister();
    const gated = recorded.hooks.map((h) => h.name).filter((n) => compat.conversationAccessHooks.includes(n));
    expect(gated.sort()).toEqual(['agent_turn_prepare', 'before_prompt_build']);
    const installer = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
    expect(installer).toContain('hooks.allowConversationAccess" true');
  });

  it('middleware runtimes are declared in the manifest contracts and known at the pin', async () => {
    const { recorded } = await loadAndRegister();
    for (const m of recorded.middleware) {
      const runtimes = (m.opts?.runtimes as string[]) ?? manifest.contracts.agentToolResultMiddleware;
      for (const r of runtimes) {
        expect(manifest.contracts.agentToolResultMiddleware).toContain(r);
        expect(compat.middlewareRuntimes).toContain(r);
      }
    }
  });

  it('the manifest uses only verified fields', () => {
    for (const key of Object.keys(manifest)) expect(compat.manifestFields).toContain(key);
  });

  it('the plugin returns only verified before_prompt_build result fields and reads only verified event/ctx fields', () => {
    const src = readFileSync(join(ROOT, 'src', 'host.ts'), 'utf8');
    const block = (name: string) => src.slice(src.indexOf(`export interface ${name}`), src.indexOf('}', src.indexOf(`export interface ${name}`)));
    const fields = (name: string) => [...block(name).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    for (const f of fields('PromptBuildResult')) expect(compat.beforePromptBuildResultFields).toContain(f);
    for (const f of fields('PromptBuildEvent')) expect(compat.beforePromptBuildEventFields).toContain(f);
    for (const f of fields('AgentCtx')) expect(compat.agentContextFields).toContain(f);
    for (const f of fields('TurnPrepareEvent')) expect(compat.agentTurnPrepareEventFields).toContain(f);
    for (const f of fields('ToolResultEvent')) expect(compat.middlewareEventFields).toContain(f);
    for (const f of fields('ToolResultCtx')) expect(compat.middlewareContextFields).toContain(f);
    for (const f of fields('NextTurnInjection')) expect(compat.nextTurnInjectionFields).toContain(f);
    for (const f of fields('ModelCallEvent')) expect(compat.modelCallStartedEventFields).toContain(f);
    for (const f of fields('ModelCallCtx')) expect(compat.modelCallContextFields).toContain(f);
  });

  it('autonomous work: model_call_started is registered (observe-only, no grant needed); before_tool_call is not', async () => {
    const { recorded } = await loadAndRegister();
    const names = recorded.hooks.map((h) => h.name);
    expect(names).toContain('model_call_started');
    expect(compat.conversationAccessHooks).not.toContain('model_call_started');
    // before_tool_call runs before every approval and a throwing one blocks the tool
    expect(names).not.toContain('before_tool_call');
    expect(compat.beforeToolCallPrecedesApproval).toBeTruthy();
    expect(compat.middlewareRewritePersisted).toBeTruthy();
  });

  it('the activity channel stays within the recorded middleware result limits', async () => {
    const { MIDDLEWARE_MAX_BLOCKS } = await import(pathToFileURL(join(ROOT, 'lib', 'src', 'wisdom', 'activity.js')).href);
    const core = await import(pathToFileURL(join(ROOT, 'lib', 'ct-wisdom-core', 'index.js')).href);
    expect(MIDDLEWARE_MAX_BLOCKS).toBe(compat.middlewareMaxContentBlocks);
    expect(core.ACTIVITY_MAX_BLOCK_CHARS).toBeLessThan(compat.middlewareMaxTextChars);
  });

  it('the recall matcher accepts names the pin projects for the manifest MCP server', async () => {
    const { isRecallToolName } = await import(pathToFileURL(join(ROOT, 'lib', 'src', 'wisdom', 'adapter.js')).href);
    const server = Object.keys(manifest.mcpServers)[0].replace(/[^A-Za-z0-9_-]/g, '-');
    expect(isRecallToolName(`${server}__curated_recall_context`)).toBe(true);
    expect(isRecallToolName(`${server}__curated_get_wiki_entry`)).toBe(false);
  });
});

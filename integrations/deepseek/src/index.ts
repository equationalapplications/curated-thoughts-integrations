import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { probe } from './status.js';
import { formatStatusBlock } from './format.js';

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
  systemPrompt: {
    context(c: {
      name: string;
      order: number;
      text: () => string;
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

  // (3) Refresh on agent/session-start. Fail-open: swallow probe errors so a
  // failed probe never crashes the plugin or the session.
  dsh.on('agent/session-start', async () => {
    try {
      const snap = probe(probeEnv);
      const text = formatStatusBlock(snap);
      cached = { text: text ?? '', since: Date.now() };
    } catch {
      // Keep the previous cached value (or empty).
    }
  });

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

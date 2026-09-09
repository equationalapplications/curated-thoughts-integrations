import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { probe } from './status.js';
import { formatStatusBlock } from './format.js';

export interface Config {
  brainDir?: string;
  sidecarCommand?: string;
}

export const Config: Schema<Config> = Schema.object({
  brainDir: Schema.string().default(process.env.CURATED_BRAIN_DIR ?? '~/.brain'),
  sidecarCommand: Schema.string().default('curated-thoughts-mcp'),
});

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
 * DSH augments `ctx` with `ctx.plugin(string, ...)`, `ctx.systemPrompt.*`,
 * `ctx.skills.register(...)`, and `ctx.on('agent/session-start', ...)` via
 * TypeScript module augmentation from `@deepseek-ai/dsh-*` plugins that ship
 * with the dsh consumer runtime. `@deepseek-ai/cordis` alone doesn't expose
 * these — that's expected per dsh's plugin model.
 *
 * We narrow the `Context` shape we actually use to keep the call sites
 * readable without `as any` at every line.
 */
interface DshContextExtensions {
  plugin(name: string, config: unknown): unknown;
  on(event: 'agent/session-start', listener: () => Promise<void>): unknown;
  systemPrompt: {
    context(c: { order: unknown; text: () => string }): unknown;
    getContextOrder(name: string): unknown;
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

  // (1) Mount the MCP client. dsh-mcp-client is a separate dsh plugin; mounting
  // it from inside our apply() is the cordis-native way to register a child
  // plugin with config. Same pattern as the documented mcp-memory overlays,
  // but expressed in TS instead of YAML.
  dsh.plugin('@deepseek-ai/dsh-mcp-client', {
    serverName: 'curated-thoughts',
    transport: 'stdio',
    command: config.sidecarCommand ?? 'curated-thoughts-mcp',
    args: ['--mcp'],
    env: { CURATED_BRAIN_DIR: config.brainDir ?? '~/.brain' },
    cwd: process.cwd(),
  });

  // (2) Cached health snapshot. Empty until the first session-start resolves.
  let cached: { text: string; since: number } | null = null;

  // (3) Dynamic prompt context (cache-safe per dsh system-prompt subsystem).
  // text is a function reference so dsh reads the latest cached value lazily
  // at prompt-assembly time, not at registration time.
  dsh.systemPrompt.context({
    order: dsh.systemPrompt.getContextOrder('curated-thoughts-health'),
    text: () => cached?.text ?? '',
  });

  // (4) Refresh on agent/session-start. Fail-open: swallow probe errors so a
  // failed probe never crashes the plugin or the session.
  dsh.on('agent/session-start', async () => {
    try {
      const snap = probe();
      const text = formatStatusBlock(snap);
      cached = { text: text ?? '', since: Date.now() };
    } catch {
      // Keep the previous cached value (or empty).
    }
  });

  // (5) Skills. dsh skills are kebab-case Markdown; the three SKILL.md files
  // are ported verbatim from Hermes — the content is agent-generic and dsh
  // reads the same Markdown. Each is registered via the runtime skills
  // provider so dsh surfaces them in <available_skills>.
  // A truncated install, a bad permission, or a broken symlink must cost us
  // the one skill it affects — not the whole plugin. This loop runs last, so
  // an escaping throw would abort apply() after (1)-(4) already registered on
  // this scope, leaving the mount and the prompt context to be torn down with
  // it. Hermes' register() (plugin/__init__.py) guards both steps the same
  // way: warn on a missing file, warn on a failed registration, keep going.
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

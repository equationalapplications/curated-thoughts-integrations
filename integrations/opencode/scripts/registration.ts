/**
 * registration.ts — the preview-first registration proposal (spec §4, §7).
 *
 * `propose()` reads the current state (global OpenCode config, loader file,
 * installed skills, installed payload) and returns a structured proposal:
 * where the payload goes, the loader file and its contents, the skill copy
 * plan, the comment-preserving config merge, and every conflict and warning.
 * It never mutates the filesystem.
 *
 * `proposal.apply()` is the only path that writes, and it refuses to run
 * unless the proposal was built from an environment with CT_INSTALL_EDIT=1.
 * Conflicts are scoped to the piece they concern and are never overwritten:
 * a conflicting loader, SKILL.md or config entry is skipped while the other
 * pieces still install.
 *
 * Invariants:
 * - Writes go to the GLOBAL config only (`<XDG_CONFIG_HOME>/opencode/`);
 *   OPENCODE_CONFIG is never written, only warned about.
 * - The `plugin` array is never touched (it is the npm path, §4).
 * - Config edits are pure insertions computed from jsonc-parser's parse tree
 *   and scanner and applied with `applyEdits`, so comments, trailing commas
 *   and formatting survive byte-for-byte. (jsonc-parser's `modify()` is not
 *   used: with formatting options it re-formats the preceding property's
 *   lines, which rewrote a trailing-comma `plugin` array.) A config that cannot be edited
 *   safely falls back to printed manual-merge instructions; a competing
 *   `.json` is never created beside a `.jsonc`.
 * - Never follows a symlink into the config file, the loader file or a
 *   SKILL.md, and never writes through a `plugins/` or `skills/` directory
 *   that symlinks out of the config dir.
 * - Backup (`<file>.bak`) before a config edit; the on-disk config must be
 *   exactly what the proposal read (mtime, size, bytes) or apply aborts.
 */

import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  parse,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
  type Edit,
  type FormattingOptions,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';
import { loaderTarget, resolveBrainPaths, SIDECAR_NAME, xdgDir } from './ct_env.js';

export { loaderTarget };

export const MCP_NAME = 'curated-thoughts';
export const SIDECAR_COMMAND: readonly string[] = [SIDECAR_NAME, '--mcp'];
export const SKILL_NAMES = ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar'] as const;
export const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json';
export const LOADER_FILENAME = 'curated-thoughts.js';

/** What the payload is made of, relative to the package root. The first two are required. */
export const PAYLOAD_REQUIRED = ['lib', 'package.json'] as const;
export const PAYLOAD_OPTIONAL = ['skills', 'scripts/install.sh', 'scripts/loader.js.tmpl', 'README.md', 'LICENSE'] as const;

// --------------------------------------------------------------------------
// paths
// --------------------------------------------------------------------------

export interface RegistrationPaths {
  /** <config>/opencode */
  configDir: string;
  /** opencode.json or opencode.jsonc inside configDir */
  destination: string;
  pluginsDir: string;
  loaderPath: string;
  skillsDir: string;
  payloadDir: string;
  /** <payloadDir>/lib/src/index.js — what the loader re-exports */
  payloadEntry: string;
  warnings: string[];
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export function resolvePaths(env: NodeJS.ProcessEnv): RegistrationPaths {
  const home = env['HOME'] || env['USERPROFILE'] || homedir();
  const configHome = xdgDir(env['XDG_CONFIG_HOME'], join(home, '.config'));
  const dataHome = xdgDir(env['XDG_DATA_HOME'], join(home, '.local', 'share'));
  const configDir = join(configHome, 'opencode');
  const warnings: string[] = [];

  const json = join(configDir, 'opencode.json');
  const jsonc = join(configDir, 'opencode.jsonc');
  const hasJson = lstatOrNull(json) !== null;
  const hasJsonc = lstatOrNull(jsonc) !== null;
  let destination = json;
  if (hasJsonc) destination = jsonc;
  if (hasJson && hasJsonc) {
    // OpenCode loads the global files in order (config.json, opencode.json,
    // opencode.jsonc) and merges later over earlier, so .jsonc wins.
    warnings.push(
      `both ${json} and ${jsonc} exist; OpenCode merges opencode.jsonc last, so the entry goes there. ` +
        'Consider consolidating them.',
    );
  }

  const opencodeConfig = env['OPENCODE_CONFIG'];
  if (opencodeConfig) {
    warnings.push(
      `OPENCODE_CONFIG=${opencodeConfig} is set. The installer writes the global config (${destination}) only; ` +
        'OpenCode merges OPENCODE_CONFIG on top of it, so an mcp["curated-thoughts"] entry there overrides this one.',
    );
  }

  const pluginsDir = join(configDir, 'plugins');
  const payloadDir = join(dataHome, 'curated-thoughts', 'opencode');
  return {
    configDir,
    destination,
    pluginsDir,
    loaderPath: join(pluginsDir, LOADER_FILENAME),
    skillsDir: join(configDir, 'skills'),
    payloadDir,
    payloadEntry: join(payloadDir, 'lib', 'src', 'index.js'),
    warnings,
  };
}

// --------------------------------------------------------------------------
// loader file
// --------------------------------------------------------------------------

/** Escape line terminators so a path can never end the `//` comment it sits in. */
function commentSafe(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]/g, (c) => {
    switch (c) {
      case '\r':
        return '\\r';
      case '\n':
        return '\\n';
      case '\u2028':
        return '\\u2028';
      default:
        return '\\u2029';
    }
  });
}

/** Render scripts/loader.js.tmpl for a payload directory. */
export function renderLoader(template: string, payloadDir: string): string {
  const entry = join(payloadDir, 'lib', 'src', 'index.js');
  // pathToFileURL percent-encodes spaces, quotes, `#`, `%` and newlines;
  // JSON.stringify then yields a valid double-quoted JS string literal.
  const specifier = JSON.stringify(pathToFileURL(entry).href);
  return template.split('{{PAYLOAD_DIR}}').join(commentSafe(payloadDir)).split('{{PAYLOAD_ENTRY_URL}}').join(specifier);
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk from `root` down to `target`; return the first existing component that
 * is a symlink resolving outside `root` (or dangling), else null. `root`
 * itself may be a symlink (a dotfiles-managed ~/.config/opencode is normal).
 */
function symlinkEscape(root: string, target: string): string | null {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null; // root absent → nothing below it exists yet
  }
  let cur = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (!st) return null;
    if (st.isSymbolicLink()) {
      try {
        if (!isInside(realpathSync(cur), rootReal)) return cur;
      } catch {
        return cur;
      }
    }
  }
  return null;
}

function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameCommand(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** True if an MCP entry's command runs the Curated Thoughts sidecar binary. */
function runsSidecar(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const cmd = entry['command'];
  const exe = Array.isArray(cmd) ? cmd[0] : cmd;
  if (typeof exe !== 'string') return false;
  const name = exe.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  return name === SIDECAR_NAME;
}

function tmpName(dir: string, base: string): string {
  return join(dir, `.${base}.ct-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
}

/** Every regular file under `root/entry` (entry may be a file), keyed by path relative to root. */
function listPayloadFiles(root: string, entries: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  const walk = (rel: string): boolean => {
    const abs = join(root, rel);
    const st = lstatOrNull(abs);
    if (!st) return true;
    if (st.isSymbolicLink()) return false;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) if (!walk(join(rel, name))) return false;
      return true;
    }
    out.set(rel, abs);
    return true;
  };
  for (const e of entries) if (!walk(e)) return null;
  return out;
}

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, abs] of a) {
    const other = b.get(rel);
    if (other === undefined) return false;
    if (!readFileSync(abs).equals(readFileSync(other))) return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// proposal
// --------------------------------------------------------------------------

export interface McpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
}

export type PayloadAction = 'create' | 'replace' | 'unchanged' | 'in-place' | 'conflict';
export type LoaderAction = 'create' | 'unchanged' | 'conflict';
export type SkillAction = 'create' | 'unchanged' | 'conflict' | 'missing-source';
export type ConfigAction = 'create' | 'edit' | 'unchanged' | 'skipped' | 'manual';

export interface SkillCopy {
  name: string;
  from: string;
  to: string;
  action: SkillAction;
}

export interface Io {
  rename: (from: string, to: string) => void;
  /** Writes the config backup (`<file>.bak`). */
  copyFile: (from: string, to: string) => void;
}

export interface ApplyOptions {
  /** Test seam for fault injection. */
  io?: Partial<Io>;
}

export interface ApplyResult {
  written: string[];
  skipped: string[];
}

export interface RegistrationProposal {
  destination: string;
  payloadDir: string;
  payload: { source: string; entries: string[]; action: PayloadAction };
  loader: { path: string; contents: string; action: LoaderAction };
  mcp: { 'curated-thoughts': McpEntry };
  config: {
    action: ConfigAction;
    /** Current file text (null if absent/unreadable). */
    before: string | null;
    /** Proposed file text for create/edit, else null. */
    after: string | null;
    /** The `mcp` block for manual merge. */
    block: string;
    /** Text fragments the edit inserts (for display). */
    inserted: string[];
  };
  skills: SkillCopy[];
  conflicts: string[];
  warnings: string[];
  /** True when every piece is already in place. */
  noop: boolean;
  apply: (opts?: ApplyOptions) => Promise<ApplyResult>;
}

export interface ProposeInput {
  env: NodeJS.ProcessEnv;
  /** The package root the running installer belongs to (payload source). */
  packageRoot: string;
  /** --skip-config: install payload, loader, skills; print the mcp block. */
  skipConfig?: boolean;
  /** Override the loader template text (default: <packageRoot>/scripts/loader.js.tmpl). */
  loaderTemplate?: string;
}

interface ConfigSnapshot {
  exists: boolean;
  text: string | null;
  mtimeMs: number | null;
  size: number | null;
  mode: number | null;
}

function detectFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /^([ \t]+)["/]/m.exec(text);
  if (m && m[1]!.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: m ? m[1]!.length : 2, eol };
}

/** The exact source text of the top-level `plugin` value (null if absent). */
function pluginSlice(text: string): string | null {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const node = tree && findNodeAtLocation(tree, ['plugin']);
  return node ? text.slice(node.offset, node.offset + node.length) : null;
}

function lineStartOf(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && text[i - 1] !== '\n' && text[i - 1] !== '\r') i--;
  return i;
}

/** Offset of the line break at/after `offset` (or text.length). */
function lineEndOf(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
  return i;
}

function indentOfLine(text: string, offset: number): string {
  const start = lineStartOf(text, offset);
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** True if only spaces/tabs precede `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStartOf(text, offset), offset));
}

const TRIVIA = new Set<SyntaxKind>([
  SyntaxKind.Trivia,
  SyntaxKind.LineBreakTrivia,
  SyntaxKind.LineCommentTrivia,
  SyntaxKind.BlockCommentTrivia,
]);

/**
 * Edits that insert `"key": value` as the last property of `obj`, touching
 * no existing byte except to add the separating comma. Returns null when the
 * layout is too unusual to insert into safely (the caller then falls back to
 * manual merge instructions).
 */
function insertPropertyEdits(
  text: string,
  obj: JsonNode,
  key: string,
  value: unknown,
  fmt: FormattingOptions,
): Edit[] | null {
  const eol = fmt.eol ?? '\n';
  const unit = fmt.insertSpaces ? ' '.repeat(fmt.tabSize ?? 2) : '\t';
  const close = obj.offset + obj.length - 1;
  if (text[close] !== '}') return null;
  const keyText = JSON.stringify(key);
  const pretty = (indent: string): string => JSON.stringify(value, null, unit).split('\n').join(eol + indent);
  const compact = JSON.stringify(value);
  const props = obj.children ?? [];

  if (props.length === 0) {
    const child = indentOfLine(text, obj.offset) + unit;
    if (startsLine(text, close)) {
      // `{` ... newline ... `}` — add a line just above the closing brace.
      const at = lineStartOf(text, close);
      return [{ offset: at, length: 0, content: `${child}${keyText}: ${pretty(child)}${eol}` }];
    }
    const closeIndent = indentOfLine(text, obj.offset);
    return [{ offset: close, length: 0, content: `${eol}${child}${keyText}: ${pretty(child)}${eol}${closeIndent}` }];
  }

  const last = props[props.length - 1]!;
  const lastEnd = last.offset + last.length;
  // Find a trailing comma after the last property (comments may sit between).
  const scanner = createScanner(text, false);
  scanner.setPosition(lastEnd);
  let commaAt: number | null = null;
  for (;;) {
    const kind = scanner.scan();
    if (TRIVIA.has(kind)) continue;
    if (kind === SyntaxKind.CommaToken) commaAt = scanner.getTokenOffset();
    else if (kind !== SyntaxKind.CloseBraceToken) return null;
    break;
  }
  const anchor = commaAt === null ? lastEnd : commaAt + 1;

  const eolAt = lineEndOf(text, anchor);
  if (startsLine(text, last.offset) && eolAt < close) {
    // Multi-line object: add a new line after the anchor's line, as long as
    // the rest of that line is only whitespace/comments ending on it.
    scanner.setPosition(anchor);
    for (;;) {
      const kind = scanner.scan();
      const tokEnd = scanner.getTokenOffset() + scanner.getTokenLength();
      if (kind === SyntaxKind.LineBreakTrivia || kind === SyntaxKind.EOF) break;
      if (!TRIVIA.has(kind) || tokEnd > eolAt) return null;
    }
    const indent = indentOfLine(text, last.offset);
    const prop = `${eol}${indent}${keyText}: ${pretty(indent)}${commaAt === null ? '' : ','}`;
    if (commaAt === null) {
      return [{ offset: lastEnd, length: eolAt - lastEnd, content: ',' + text.slice(lastEnd, eolAt) + prop }];
    }
    return [{ offset: eolAt, length: 0, content: prop }];
  }

  // Single-line object (`{ "a": 1 }`): stay on the line.
  if (commaAt === null) return [{ offset: lastEnd, length: 0, content: `, ${keyText}: ${compact}` }];
  return [{ offset: anchor, length: 0, content: ` ${keyText}: ${compact},` }];
}

interface ConfigPlan {
  action: ConfigAction;
  after: string | null;
  inserted: string[];
  entry: McpEntry;
}

function normalizeEntry(existing: Record<string, unknown>, desired: McpEntry): McpEntry {
  const env = existing['environment'];
  return {
    type: 'local',
    command: Array.isArray(existing['command'])
      ? (existing['command'] as unknown[]).map(String)
      : [...desired.command],
    enabled: existing['enabled'] !== false,
    environment: isPlainObject(env)
      ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
      : { ...desired.environment },
  };
}

function planConfig(
  destination: string,
  snap: ConfigSnapshot,
  desired: McpEntry,
  skipConfig: boolean,
  conflicts: string[],
  warnings: string[],
): ConfigPlan {
  const manual = (why: string, entry: McpEntry = desired): ConfigPlan => {
    conflicts.push(why);
    return { action: 'manual', after: null, inserted: [], entry };
  };
  const fresh = (): string =>
    JSON.stringify({ $schema: CONFIG_SCHEMA_URL, mcp: { [MCP_NAME]: desired } }, null, 2) + '\n';

  if (skipConfig) return { action: 'skipped', after: null, inserted: [], entry: desired };
  if (!snap.exists) return { action: 'create', after: fresh(), inserted: [], entry: desired };
  if (snap.text === null) return manual(`${destination}: cannot be read as a regular file (symlink, directory or unreadable) — refusing to edit it`);
  if (snap.text.trim() === '') return { action: 'edit', after: fresh(), inserted: [], entry: desired };

  const errors: ParseError[] = [];
  const root: unknown = parse(snap.text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const e = errors[0]!;
    return manual(`${destination}: could not parse (${printParseErrorCode(e.error)} at offset ${e.offset}) — merge the block manually`);
  }
  if (!isPlainObject(root)) return manual(`${destination}: top level is not a JSON object`);
  const mcp = root['mcp'];
  if (mcp !== undefined && !isPlainObject(mcp)) return manual(`${destination}: "mcp" is not an object`);

  const aliasConflicts = Object.entries(mcp ?? {})
    .filter(([name, entry]) => name !== MCP_NAME && runsSidecar(entry))
    .map(
      ([name]) =>
        `${destination}: mcp.${name} already runs ${SIDECAR_NAME} — a second entry would start two sidecars on one brain; remove one`,
    );

  const existing = mcp?.[MCP_NAME];
  const fmt = detectFormatting(snap.text);
  let text = snap.text;
  let insertFailed = false;
  const inserted: string[] = [];
  /** Insert `key: value` into the existing object at `path.slice(0, -1)`. */
  const set = (path: string[], value: unknown): void => {
    if (insertFailed) return;
    const objectPath = path.slice(0, -1);
    const key = path[path.length - 1]!;
    const tree = parseTree(text, [], { allowTrailingComma: true });
    const node = tree && (objectPath.length === 0 ? tree : findNodeAtLocation(tree, objectPath));
    const edits = node && node.type === 'object' ? insertPropertyEdits(text, node, key, value, fmt) : null;
    if (!edits) {
      insertFailed = true;
      return;
    }
    for (const e of edits) inserted.push(e.content);
    text = applyEdits(text, edits);
  };

  let entry = desired;
  if (existing === undefined) {
    if (mcp === undefined) set(['mcp'], { [MCP_NAME]: desired });
    else set(['mcp', MCP_NAME], desired);
  } else if (!isPlainObject(existing)) {
    return manual(`${destination}: mcp.${MCP_NAME} is not an object — fix it manually`);
  } else {
    entry = normalizeEntry(existing, desired);
    if (existing['command'] !== undefined && !sameCommand(existing['command'], SIDECAR_COMMAND)) {
      return manual(
        `${destination}: mcp.${MCP_NAME} has a different command (${JSON.stringify(existing['command'])}); ` +
          `expected ${JSON.stringify(SIDECAR_COMMAND)}. Left as is — reconcile it manually`,
        entry,
      );
    }
    if (existing['type'] !== undefined && existing['type'] !== 'local') {
      return manual(`${destination}: mcp.${MCP_NAME} has type ${JSON.stringify(existing['type'])}, expected "local"`, entry);
    }
    // Complete a partial entry (e.g. a bare { "enabled": false } stub) without
    // touching what the user set — `enabled` in particular is never written.
    for (const key of ['type', 'command', 'environment'] as const) {
      if (existing[key] === undefined) set(['mcp', MCP_NAME, key], desired[key]);
    }
    const brain = entry.environment['CURATED_BRAIN_DIR'];
    if (brain !== undefined && brain !== desired.environment['CURATED_BRAIN_DIR']) {
      warnings.push(
        `mcp.${MCP_NAME} sets CURATED_BRAIN_DIR=${brain}, but this environment resolves ` +
          `${desired.environment['CURATED_BRAIN_DIR']}; left as is.`,
      );
    }
  }

  if (aliasConflicts.length > 0) {
    conflicts.push(...aliasConflicts);
    return { action: 'manual', after: null, inserted: [], entry };
  }
  const unsafe = (): ConfigPlan =>
    manual(`${destination}: could not produce a safe in-place edit — merge the block manually`, entry);
  // Checked before "unchanged": a refused insertion also leaves text as it was.
  if (insertFailed) return unsafe();
  if (text === snap.text) return { action: 'unchanged', after: null, inserted: [], entry };

  // Belt and braces: the edited text must parse, carry exactly the entry we
  // meant, and leave the plugin array byte-identical.
  const checkErrors: ParseError[] = [];
  const edited: unknown = parse(text, checkErrors, { allowTrailingComma: true });
  const ok =
    checkErrors.length === 0 &&
    isPlainObject(edited) &&
    pluginSlice(text) === pluginSlice(snap.text) &&
    isPlainObject(edited['mcp']) &&
    sameCommand((edited['mcp'][MCP_NAME] as Record<string, unknown> | undefined)?.['command'], SIDECAR_COMMAND);
  if (!ok) return unsafe();
  return { action: 'edit', after: text, inserted, entry };
}

function readConfigSnapshot(destination: string): ConfigSnapshot {
  const st = lstatOrNull(destination);
  if (!st) return { exists: false, text: null, mtimeMs: null, size: null, mode: null };
  if (!st.isFile()) return { exists: true, text: null, mtimeMs: st.mtimeMs, size: st.size, mode: null };
  return { exists: true, text: readTextOrNull(destination), mtimeMs: st.mtimeMs, size: st.size, mode: st.mode & 0o777 };
}

export function propose(input: ProposeInput): RegistrationProposal {
  const { env, packageRoot } = input;
  const paths = resolvePaths(env);
  const warnings = [...paths.warnings];
  const conflicts: string[] = [];

  // --- desired entry ------------------------------------------------------
  const { brainDir } = resolveBrainPaths(env);
  const desired: McpEntry = {
    type: 'local',
    command: [...SIDECAR_COMMAND],
    enabled: true,
    // Absolute, so OpenCode's working directory cannot change its meaning.
    environment: { CURATED_BRAIN_DIR: isAbsolute(brainDir) ? brainDir : resolve(brainDir) },
  };

  // --- payload ------------------------------------------------------------
  const entries = [...PAYLOAD_REQUIRED, ...PAYLOAD_OPTIONAL].filter((e) => existsSync(join(packageRoot, e)));
  let payloadAction: PayloadAction;
  const missing = PAYLOAD_REQUIRED.filter((e) => !entries.includes(e));
  const payloadSt = lstatOrNull(paths.payloadDir);
  let sameDir = false;
  try {
    sameDir = realpathSync(packageRoot) === realpathSync(paths.payloadDir);
  } catch {
    sameDir = false;
  }
  if (missing.length > 0 || !existsSync(join(packageRoot, 'lib', 'src', 'index.js'))) {
    payloadAction = 'conflict';
    conflicts.push(
      `payload source ${packageRoot} is incomplete (needs ${[...PAYLOAD_REQUIRED].join(', ')} and lib/src/index.js) — run \`pnpm run build\``,
    );
  } else if (sameDir) {
    payloadAction = 'in-place';
  } else if (payloadSt?.isSymbolicLink()) {
    payloadAction = 'conflict';
    conflicts.push(`${paths.payloadDir} is a symlink — refusing to replace it; remove it and re-run`);
  } else if (!payloadSt) {
    payloadAction = 'create';
  } else {
    const src = listPayloadFiles(packageRoot, entries);
    const dst = listPayloadFiles(paths.payloadDir, [...PAYLOAD_REQUIRED, ...PAYLOAD_OPTIONAL]);
    payloadAction = src && dst && sameTree(src, dst) ? 'unchanged' : 'replace';
  }

  // --- loader -------------------------------------------------------------
  const templatePath = join(packageRoot, 'scripts', 'loader.js.tmpl');
  const template = input.loaderTemplate ?? readTextOrNull(templatePath);
  if (template === null) throw new Error(`loader template not found: ${templatePath}`);
  const loaderContents = renderLoader(template, paths.payloadDir);
  let loaderAction: LoaderAction = 'create';
  const pluginsEscape = symlinkEscape(paths.configDir, paths.pluginsDir);
  const loaderSt = lstatOrNull(paths.loaderPath);
  if (pluginsEscape) {
    loaderAction = 'conflict';
    conflicts.push(`${pluginsEscape} is a symlink out of ${paths.configDir} — refusing to write the loader through it`);
  } else if (loaderSt?.isSymbolicLink()) {
    loaderAction = 'conflict';
    conflicts.push(`${paths.loaderPath} is a symlink — refusing to follow it`);
  } else if (loaderSt) {
    const current = readTextOrNull(paths.loaderPath);
    const target = current === null ? null : loaderTarget(current);
    if (target !== null && resolve(target) === resolve(paths.payloadEntry)) {
      loaderAction = 'unchanged';
    } else {
      loaderAction = 'conflict';
      conflicts.push(
        target === null
          ? `${paths.loaderPath} exists but is not a curated-thoughts loader — left untouched`
          : `${paths.loaderPath} points at a different payload (${target}); expected ${paths.payloadEntry}. ` +
              'Two payloads on one brain is the same bug as two sidecars — remove the old loader and re-run',
      );
    }
  }

  // --- skills -------------------------------------------------------------
  const skills: SkillCopy[] = SKILL_NAMES.map((name) => {
    const from = join(packageRoot, 'skills', name, 'SKILL.md');
    const to = join(paths.skillsDir, name, 'SKILL.md');
    const src = readTextOrNull(from);
    if (src === null) {
      warnings.push(`skill ${name}: source ${from} not found in the package — skipped`);
      return { name, from, to, action: 'missing-source' as const };
    }
    const escape = symlinkEscape(paths.configDir, dirname(to));
    if (escape) {
      conflicts.push(`skill ${name}: ${escape} is a symlink out of ${paths.configDir} — refusing to write through it`);
      return { name, from, to, action: 'conflict' as const };
    }
    const st = lstatOrNull(to);
    if (!st) return { name, from, to, action: 'create' as const };
    if (!st.isFile()) {
      conflicts.push(`skill ${name}: ${to} is not a regular file (symlink?) — left untouched`);
      return { name, from, to, action: 'conflict' as const };
    }
    if (readTextOrNull(to) === src) return { name, from, to, action: 'unchanged' as const };
    conflicts.push(`skill ${name}: ${to} differs from the packaged copy (user-modified?) — left untouched`);
    return { name, from, to, action: 'conflict' as const };
  });

  // --- config -------------------------------------------------------------
  const snap = readConfigSnapshot(paths.destination);
  const plan = planConfig(paths.destination, snap, desired, input.skipConfig === true, conflicts, warnings);
  const block = JSON.stringify({ mcp: { [MCP_NAME]: desired } }, null, 2);

  const noop =
    conflicts.length === 0 &&
    ['unchanged', 'in-place'].includes(payloadAction) &&
    loaderAction === 'unchanged' &&
    skills.every((s) => s.action === 'unchanged' || s.action === 'missing-source') &&
    (plan.action === 'unchanged' || plan.action === 'skipped');

  const proposal: RegistrationProposal = {
    destination: paths.destination,
    payloadDir: paths.payloadDir,
    payload: { source: packageRoot, entries, action: payloadAction },
    loader: { path: paths.loaderPath, contents: loaderContents, action: loaderAction },
    mcp: { 'curated-thoughts': plan.entry },
    config: { action: plan.action, before: snap.text, after: plan.after, block, inserted: plan.inserted },
    skills,
    conflicts,
    warnings,
    noop,
    apply: async (opts: ApplyOptions = {}) => {
      if (env['CT_INSTALL_EDIT'] !== '1') {
        throw new Error('apply() refused: set CT_INSTALL_EDIT=1 to authorize writing');
      }
      return applyProposal(proposal, paths, snap, { rename: renameSync, copyFile: copyFileSync, ...opts.io });
    },
  };
  return proposal;
}

// --------------------------------------------------------------------------
// apply
// --------------------------------------------------------------------------

class ConcurrentEditError extends Error {}

function assertConfigUnchanged(destination: string, snap: ConfigSnapshot): void {
  const st = lstatOrNull(destination);
  const moved = (): never => {
    throw new ConcurrentEditError(
      `${destination} changed on disk since the preview (concurrent edit?) — nothing written; re-run the installer`,
    );
  };
  if (!snap.exists) {
    if (st) moved();
    return;
  }
  if (!st || st.isSymbolicLink() || !st.isFile()) moved();
  if (st!.mtimeMs !== snap.mtimeMs || st!.size !== snap.size) moved();
  if (readTextOrNull(destination) !== snap.text) moved();
}

/** Write `text` to `dest` atomically: temp file in the same directory, then rename. */
function atomicWrite(dest: string, text: string, io: Io, mode?: number | null): void {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = tmpName(dir, basename(dest));
  writeFileSync(tmp, text, { flag: 'wx' });
  try {
    if (mode !== undefined && mode !== null) chmodSync(tmp, mode);
    io.rename(tmp, dest);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function installPayload(p: RegistrationProposal, io: Io): void {
  const dir = p.payloadDir;
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const staging = join(parent, `.${basename(dir)}.staging-${tag}`);
  mkdirSync(staging);
  try {
    for (const e of p.payload.entries) {
      cpSync(join(p.payload.source, e), join(staging, e), { recursive: true });
    }
    if (lstatOrNull(dir)) {
      if (lstatOrNull(dir)!.isSymbolicLink()) throw new Error(`${dir} is a symlink — refusing to replace it`);
      const old = join(parent, `.${basename(dir)}.old-${tag}`);
      io.rename(dir, old);
      try {
        io.rename(staging, dir);
      } catch (e) {
        io.rename(old, dir);
        throw e;
      }
      rmSync(old, { recursive: true, force: true });
    } else {
      io.rename(staging, dir);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function applyProposal(
  p: RegistrationProposal,
  paths: RegistrationPaths,
  snap: ConfigSnapshot,
  io: Io,
): Promise<ApplyResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  const writesConfig = p.config.action === 'create' || p.config.action === 'edit';

  // Pre-flight: abort before ANY mutation if the config moved under us.
  if (writesConfig) assertConfigUnchanged(paths.destination, snap);

  // 1. Payload — replaced in place (staging dir + rename swap).
  if (p.payload.action === 'create' || p.payload.action === 'replace') {
    installPayload(p, io);
    written.push(p.payloadDir);
  } else if (p.payload.action === 'conflict') {
    skipped.push(p.payloadDir);
  }

  // 2. Loader — only when absent; re-checked at write time.
  if (p.loader.action === 'create' && p.payload.action === 'conflict') {
    skipped.push(p.loader.path); // never point a loader at a payload that did not install
  } else if (p.loader.action === 'create') {
    if (symlinkEscape(paths.configDir, paths.pluginsDir) || lstatOrNull(paths.loaderPath)) {
      skipped.push(p.loader.path);
    } else {
      atomicWrite(p.loader.path, p.loader.contents, io);
      written.push(p.loader.path);
    }
  } else if (p.loader.action === 'conflict') {
    skipped.push(p.loader.path);
  }

  // 3. Skills — atomic per file; never clobbers a file that appeared since.
  for (const s of p.skills) {
    if (s.action !== 'create') {
      if (s.action === 'conflict') skipped.push(s.to);
      continue;
    }
    if (symlinkEscape(paths.configDir, dirname(s.to)) || lstatOrNull(s.to)) {
      skipped.push(s.to);
      continue;
    }
    atomicWrite(s.to, readFileSync(s.from, 'utf8'), io);
    written.push(s.to);
  }

  // 4. Config — backup, re-check, atomic rename, restore on failure.
  if (writesConfig) {
    const dest = paths.destination;
    const bak = `${dest}.bak`;
    assertConfigUnchanged(dest, snap);
    // What `.bak` held before this run (null = absent), so a concurrent-edit
    // abort can put it back instead of leaving this run's backup behind.
    let priorBak: Buffer | null = null;
    if (snap.exists) {
      const bakSt = lstatOrNull(bak);
      if (bakSt?.isSymbolicLink()) throw new Error(`${bak} is a symlink — refusing to write the backup`);
      if (bakSt?.isFile()) priorBak = readFileSync(bak);
      io.copyFile(dest, bak);
    }
    const dir = dirname(dest);
    mkdirSync(dir, { recursive: true });
    const tmp = tmpName(dir, basename(dest));
    try {
      writeFileSync(tmp, p.config.after!, { flag: 'wx' });
      if (snap.mode !== null) chmodSync(tmp, snap.mode);
      assertConfigUnchanged(dest, snap);
      io.rename(tmp, dest);
    } catch (e) {
      if (e instanceof ConcurrentEditError) {
        // The config was never touched: undo the backup this run wrote.
        if (snap.exists) {
          if (priorBak !== null) writeFileSync(bak, priorBak);
          else rmSync(bak, { force: true });
        }
      } else {
        // Restore the original: from the backup if there was one, else remove
        // whatever a torn write left behind.
        if (snap.exists) {
          if (readTextOrNull(dest) !== snap.text) copyFileSync(bak, dest);
        } else if (lstatOrNull(dest)?.isFile()) {
          unlinkSync(dest);
        }
      }
      throw e;
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    }
    written.push(dest);
  }

  return { written, skipped };
}

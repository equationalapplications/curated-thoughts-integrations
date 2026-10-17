/**
 * activity.ts — autonomous-work ("activity") wisdom delivery, the
 * host-neutral half (spec docs/superpowers/specs/2026-10-16-dsh-autonomous-
 * work-wisdom-design.md). A behavioral port of the Hermes reference
 * `integrations/hermes/scripts/ct_wisdom_activity.py`:
 *
 *   - the activity line builder: a deterministic rendering of ONE tool
 *     call's target from its ARGS only — never contents, output, diffs,
 *     reasoning, flag values, quoted words, assignments, URLs or
 *     credential-shaped tokens (user decision 2; INTENT rule 8: no scoring,
 *     no expansion);
 *   - the query: the bare target (A6 real-gate results), never the verb;
 *   - the key tracker: one CT call per step, only on a new key (decision 1);
 *   - the marker-first block renderer (1 fact, ≤ 600 chars, decision 5);
 *   - the match runner (shared breaker, capability latch, cache reset).
 *
 * Hosts map their own tool calls to an ActivitySpec and choose the step id
 * (DSH: the assistant message id). Every function tolerates malformed input
 * without throwing.
 */

import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import nodePath from 'node:path';
import { performance } from 'node:perf_hooks';

import { Breaker } from './breaker.js';
import {
  ACTIVITY_HEADING,
  ACTIVITY_LABEL_CHARS,
  ACTIVITY_MAX_BLOCK_CHARS,
  ACTIVITY_MAX_PER_STEP,
  ACTIVITY_QUERY_CHARS,
  ACTIVITY_RECENT_KEYS_MAX,
  ACTIVITY_SESSIONS_MAX,
  ACTIVITY_STEP_IDS_MAX,
  ACTIVITY_TARGET_CHARS,
  EXCLUDE_MAX,
} from './constants.js';
import { marker, stripForged, validId } from './ledger.js';
import { lruGet, lruSet } from './lru.js';
import { cpLen, cpSlice } from './text.js';
import type {
  Correction,
  FactEntry,
  HostAdapter,
  Ledger,
  SessionRef,
  WisdomMatchResult,
} from './types.js';
import type { VerboseTurn } from './verbose.js';

export type ActivityVerb = 'read' | 'write' | 'edit' | 'search' | 'run';

/** A host's tool call, reduced to what the builder may look at. */
export type ActivitySpec =
  | { verb: 'read' | 'write' | 'edit'; path: unknown }
  | { verb: 'search'; pattern: unknown; path?: unknown }
  | { verb: 'run'; command: unknown };

/** One activity (Hermes `Activity` namedtuple). */
export interface Activity {
  verb: ActivityVerb;
  /** What the agent works on: path, `pattern[ in path]`, or `program[ word]`. */
  target: string;
  /** Rate-rule key: verb class (read/write/edit fold into `file`) + target. */
  key: string;
  /** Visible label, e.g. `read src/x.ts`. Never sent to CT. */
  line: string;
  /** The bare target CT receives (before stripForged and the cap). */
  query: string;
}

const VERB_CLASS: Record<ActivityVerb, string> = {
  read: 'file',
  write: 'file',
  edit: 'file',
  search: 'search',
  run: 'run',
};

const ELLIPSIS = '…';
/** Never used as a target: our own block text (self-trigger guard). */
const OWN_TEXT = ['ct-fact:', '## Curated Thoughts —'];
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEY_PREFIXES = ['sk-', 'sk_', 'pk_', 'rk_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_',
  'xox', 'akia', 'asia', 'aiza', 'glpat-', 'eyj'];
const OPERATOR_CHARS = new Set([';', '|', '&', '<', '>', '(', ')', '`']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const PYTHON_RE = /^python[0-9.]*$/;
const DRIVE_RE = /^[A-Za-z]:$/;

/** True for Curated Thoughts' own tools (decision 6: never a trigger). */
export function isCtTool(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const lowered = name.toLowerCase();
  if (lowered.includes('curated-thoughts') || lowered.includes('curated_thoughts')) return true;
  const parts = lowered.split(/__|\./);
  return (parts[parts.length - 1] ?? '').startsWith('curated_');
}

/** A known key prefix, or 16+ chars with 3+ digits. */
export function credentialShaped(token: string): boolean {
  const lowered = token.toLowerCase();
  if (KEY_PREFIXES.some((p) => lowered.startsWith(p))) return true;
  let digits = 0;
  for (const ch of token) if (ch >= '0' && ch <= '9') digits++;
  return [...token].length >= 16 && digits >= 3;
}

function cleanTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '' || CONTROL_RE.test(v)) return null;
  if (OWN_TEXT.some((own) => v.includes(own))) return null;
  return v;
}

/** Python posixpath.normpath. */
function normpath(path: string): string {
  if (path === '') return '.';
  let initial = path.startsWith('/') ? 1 : 0;
  if (initial && path.startsWith('//') && !path.startsWith('///')) initial = 2;
  const out: string[] = [];
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initial && out.length === 0) || (out.length > 0 && out[out.length - 1] === '..')) {
      out.push(comp);
    } else if (out.length > 0) {
      out.pop();
    }
  }
  const joined = '/'.repeat(initial) + out.join('/');
  return joined || '.';
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// ─────────────────────────────────────────────────────────────────────────
// Privacy rules — a behavioral port of the Hermes builder at hermes 0.6.5
// (ct_wisdom_activity.py; spec 2026-10-16-hermes-autonomous-work-wisdom-
// design.md, "Privacy amendment 4: project-root allowlist"). Safe by
// construction: a path is sent only relative to a project root it resolves
// inside of, and nothing that names the user is ever sent. The shared
// vectors in tests/fixtures/activity_targets.json run against both builders.
// ─────────────────────────────────────────────────────────────────────────

/** The environment view the builder reads (user names, HOME for `~`). */
export type ActivityEnv = Record<string, string | undefined>;

/** Service accounts are never private names even when USER says so. */
const SERVICE_ACCOUNTS = new Set(['root', 'node', 'app', 'user', 'admin', 'test', 'ubuntu', 'runner',
  'docker', 'www-data', 'nobody', 'daemon', 'ec2-user', 'vscode', 'codespace']);
/** A name part this long hits any token CONTAINING it; a shorter one only an equal token. */
const SUBSTRING_NAME_CHARS = 3;
const SEARCH_MAX_CHARS = 80;
const SEARCH_MAX_WORDS = 6;
const SEARCH_ASCII = /^[A-Za-z0-9_ .-]$/;
const LETTER_RE = /^\p{L}$/u;
/** A search pattern naming any of these (case-insensitive, anywhere) is never sent. */
const AUTH_WORDS = ['bearer', 'token', 'password', 'passwd', 'secret', 'apikey', 'api_key',
  'api-key', 'api key', 'auth'];
/** A directory holding any of these (or a `*.sln` file) is a project root. */
export const ROOT_MARKERS = ['.git', '.hg', 'pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', '.curated-thoughts-project'] as const;
const ROOT_CACHE_TTL_MS = 30_000;
/** "No root" is cached only briefly, so `touch .curated-thoughts-project` takes effect almost at once. */
const ROOT_NEGATIVE_TTL_MS = 2_000;
const SLN_CACHE_TTL_MS = 30_000;
const SLN_CACHE_MAX = 256;
const ROOT_CACHE_MAX = 64;
const DARWIN = process.platform === 'darwin';
const WINDOWS = nodePath.sep === '\\';
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
/** A directory whose parent has one of these names is someone's home. */
const HOMES_PARENTS = new Set(['users', 'home', 'profiles']);
/** `/<host>/home` homes locations (Fedora Silverblue, NFS, Solaris, NAS). */
const HOMES_HOSTS = new Set(['var', 'nfs', 'export', 'data']);
/** P3 command allowlist. */
/** A program is a bare command name: no path separator, no dot (`python3.11` is the one dotted form). */
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,40}$/;
const SUBCOMMAND_RE = /^[a-z][a-z0-9-]{0,30}$/;
const MODULE_RE = /^[a-z_][a-z0-9_.]{0,60}$/;
const verbs = (...words: string[]): ReadonlySet<string> => new Set(words);
const MAKE_TARGETS = verbs('build', 'test', 'lint', 'fmt', 'format', 'check', 'clean', 'install', 'dev',
  'run', 'deploy', 'release', 'docs', 'all');
const JS_VERBS = verbs('install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'run', 'run-script', 'test',
  't', 'start', 'build', 'dev', 'lint', 'exec', 'dlx', 'x', 'create', 'init', 'publish', 'pack', 'update',
  'upgrade', 'up', 'outdated', 'audit', 'ls', 'list', 'link', 'why', 'version', 'info', 'workspace', 'workspaces');
const DOCKER_VERBS = verbs('build', 'run', 'ps', 'images', 'pull', 'push', 'exec', 'logs', 'compose', 'stop',
  'start', 'restart', 'rm', 'rmi', 'inspect', 'tag', 'login', 'logout', 'network', 'volume', 'system', 'buildx',
  'container', 'image', 'cp', 'kill', 'top', 'stats', 'version', 'info');
const APT_VERBS = verbs('install', 'remove', 'purge', 'update', 'upgrade', 'search', 'list', 'show', 'info',
  'autoremove', 'reinstall', 'check', 'makecache');
/** P3b: tools with subcommands, each with its known verbs (Hermes `_SUBCOMMAND_TOOLS`). */
const SUBCOMMAND_TOOLS: Record<string, ReadonlySet<string>> = {
  git: verbs('add', 'am', 'apply', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone',
    'commit', 'config', 'describe', 'diff', 'fetch', 'grep', 'init', 'log', 'merge', 'mv', 'pull', 'push',
    'rebase', 'reflog', 'remote', 'reset', 'restore', 'revert', 'rm', 'show', 'stash', 'status', 'submodule',
    'switch', 'tag', 'worktree', 'lfs', 'gc', 'shortlog', 'notes', 'range-diff', 'sparse-checkout'),
  npm: JS_VERBS, pnpm: JS_VERBS, yarn: JS_VERBS, bun: JS_VERBS,
  cargo: verbs('build', 'b', 'check', 'c', 'test', 't', 'run', 'r', 'bench', 'doc', 'fmt', 'clippy', 'add',
    'remove', 'update', 'publish', 'install', 'new', 'init', 'clean', 'tree', 'fix', 'metadata', 'search',
    'nextest'),
  go: verbs('build', 'test', 'run', 'mod', 'get', 'install', 'vet', 'fmt', 'generate', 'env', 'list', 'work',
    'tool', 'clean', 'doc', 'version'),
  docker: DOCKER_VERBS, podman: DOCKER_VERBS,
  kubectl: verbs('get', 'describe', 'apply', 'delete', 'logs', 'exec', 'rollout', 'scale', 'port-forward',
    'config', 'create', 'edit', 'top', 'diff', 'explain', 'label', 'annotate', 'patch', 'cp', 'auth', 'version',
    'cluster-info'),
  helm: verbs('install', 'upgrade', 'uninstall', 'list', 'repo', 'template', 'lint', 'package', 'dependency',
    'status', 'rollback', 'pull', 'push', 'show', 'search', 'test', 'history', 'version'),
  gh: verbs('pr', 'issue', 'repo', 'run', 'workflow', 'release', 'api', 'auth', 'browse', 'search', 'status',
    'gist', 'label', 'secret', 'variable', 'cache', 'codespace', 'extension', 'project', 'ruleset'),
  pip: verbs('install', 'uninstall', 'list', 'freeze', 'show', 'download', 'wheel', 'check', 'config', 'cache',
    'index', 'inspect', 'hash', 'search'),
  pipx: verbs('install', 'uninstall', 'run', 'list', 'upgrade', 'upgrade-all', 'inject', 'reinstall', 'ensurepath'),
  uv: verbs('run', 'sync', 'add', 'remove', 'lock', 'pip', 'venv', 'tool', 'init', 'build', 'publish', 'python',
    'tree', 'export', 'cache', 'self'),
  poetry: verbs('install', 'add', 'remove', 'update', 'lock', 'run', 'build', 'publish', 'shell', 'show', 'init',
    'new', 'check', 'env', 'export', 'version', 'config'),
  conda: verbs('install', 'create', 'activate', 'deactivate', 'list', 'update', 'remove', 'env', 'run', 'info',
    'search', 'clean', 'config'),
  brew: verbs('install', 'uninstall', 'reinstall', 'upgrade', 'update', 'list', 'search', 'info', 'services',
    'tap', 'untap', 'doctor', 'cleanup', 'outdated', 'bundle', 'link', 'unlink', 'pin', 'unpin', 'deps'),
  apt: APT_VERBS, 'apt-get': APT_VERBS, dnf: APT_VERBS, yum: APT_VERBS,
  terraform: verbs('init', 'plan', 'apply', 'destroy', 'validate', 'fmt', 'output', 'state', 'import',
    'workspace', 'show', 'providers', 'refresh', 'taint', 'untaint', 'graph', 'console', 'login', 'version'),
  dotnet: verbs('build', 'test', 'run', 'restore', 'publish', 'new', 'add', 'pack', 'clean', 'format', 'watch',
    'tool', 'sln', 'list', 'remove', 'nuget', 'ef'),
  mvn: verbs('clean', 'compile', 'test', 'package', 'install', 'verify', 'deploy', 'site', 'validate', 'dependency'),
  gradle: verbs('build', 'test', 'clean', 'assemble', 'check', 'run', 'tasks', 'dependencies', 'publish',
    'bootrun', 'jar', 'lint'),
  make: MAKE_TARGETS, just: MAKE_TARGETS, rake: MAKE_TARGETS,
  bundle: verbs('install', 'exec', 'update', 'add', 'remove', 'list', 'show', 'outdated', 'check', 'init',
    'config', 'lock'),
  rails: verbs('server', 's', 'console', 'c', 'generate', 'g', 'destroy', 'd', 'db', 'test', 'new', 'routes',
    'runner', 'credentials', 'assets'),
  mix: verbs('test', 'compile', 'run', 'format', 'deps', 'new', 'release', 'clean', 'credo', 'dialyzer', 'ecto'),
  dart: verbs('run', 'test', 'compile', 'pub', 'analyze', 'format', 'create', 'fix', 'doc', 'info'),
  flutter: verbs('run', 'test', 'build', 'pub', 'analyze', 'format', 'create', 'doctor', 'clean', 'upgrade',
    'devices', 'install', 'attach'),
  swift: verbs('build', 'test', 'run', 'package', 'format'),
  deno: verbs('run', 'test', 'fmt', 'lint', 'task', 'compile', 'bench', 'check', 'install', 'info', 'doc',
    'serve', 'add', 'remove', 'upgrade'),
  nx: verbs('run', 'build', 'test', 'lint', 'serve', 'affected', 'graph', 'run-many', 'generate', 'g', 'show',
    'release', 'format', 'migrate'),
  turbo: verbs('run', 'build', 'test', 'lint', 'dev', 'prune', 'ls', 'daemon', 'login', 'link', 'gen'),
};
/** P3c: `python -m` modules always sent (else only a module inside the project). */
const PYTHON_MODULES = verbs('pytest', 'pip', 'venv', 'http.server', 'unittest', 'black', 'ruff', 'mypy',
  'build', 'twine');
/** Path components are case-folded only where filesystems usually ignore case. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
const GIT_BASH_RE = /^\/([A-Za-z])(?:\/(.*))?$/s;
/** Runs of letters and digits (Python `[^\W_]+`, i.e. `str.isalnum`). */
const NAME_TOKEN_RE = /[\p{L}\p{N}]+/gu;

const sln = new Map<string, { at: number; found: boolean }>();
const roots = new Map<string, { at: number; root: string | null }>();
const HOMES_CACHE_TTL_MS = 30_000;
const HOMES_CACHE_MAX = 16;
interface Homes {
  /** Every home, normalized and canonical: each is never a root. */
  all: string[];
  /** Canonical homes only. */
  real: string[];
  /** Real user homes, which also block every ancestor. */
  blocking: string[];
}
const homesCache = new Map<string, { at: number; homes: Homes }>();
let pwdIdentityCache: { name: string | null; dir: string | null } | null = null;

/** Python-style casefold approximation (lower → upper → lower maps ß to ss). */
function casefold(text: string): string {
  return text.toLowerCase().toUpperCase().toLowerCase();
}

/** Name comparison form: NFC (macOS paths are often NFD) and case-folded. */
function fold(text: string): string {
  return casefold(text.normalize('NFC'));
}

/** Path comparison form: NFC everywhere, case-folded only on darwin/win32. */
function foldPath(text: string): string {
  const nfc = text.normalize('NFC');
  return CASE_INSENSITIVE ? casefold(nfc) : nfc;
}

function envStr(env: ActivityEnv, name: string): string | null {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Git Bash's `/c/Users/x` as `C:\Users\x` (on Windows only). */
function gitBash(path: string, windows: boolean = WINDOWS): string {
  if (!windows) return path;
  const m = GIT_BASH_RE.exec(path.replace(/\\/g, '/'));
  if (!m) return path;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
}

/**
 * (pw_name, pw_dir) of the process user, looked up once (`os.userInfo()`, the
 * Node equivalent of `pwd.getpwuid`); nulls where it is unavailable.
 */
function pwdIdentity(): { name: string | null; dir: string | null } {
  if (pwdIdentityCache === null) {
    try {
      const info = userInfo();
      pwdIdentityCache = { name: info.username || null, dir: info.homedir || null };
    } catch {
      pwdIdentityCache = { name: null, dir: null };
    }
  }
  return pwdIdentityCache;
}

/**
 * Host seams (Hermes `_fs_root` / `_system_identity`): tests patch them to
 * model `/` with a temp directory and to supply the process identity.
 */
export const activitySeams = {
  /** True for a filesystem root (`/`, `C:\`). */
  fsRoot(directory: string): boolean {
    return nodePath.dirname(directory) === directory;
  },
  /**
   * (names, homes, pw_dirs) of the process: the user name; the homes
   * `homedir()` and the passwd home; and the passwd home alone (a real user
   * home). Never throws.
   */
  systemIdentity(): [string[], string[], string[]] {
    const { name, dir } = pwdIdentity();
    let home: string | null = null;
    try {
      home = homedir() || null;
    } catch {
      home = null;
    }
    return [name ? [name] : [], [home, dir].filter((h): h is string => !!h), dir ? [dir] : []];
  },
};

/** TEST-ONLY: forget project roots, the `*.sln` cache and the user lookup. */
export function resetActivityCaches(): void {
  roots.clear();
  sln.clear();
  homesCache.clear();
  pwdIdentityCache = null;
}

/** HOME (or USERPROFILE) for `~` expansion. */
function homeOf(env: ActivityEnv): string | null {
  const v = envStr(env, 'HOME') ?? envStr(env, 'USERPROFILE');
  return v ? gitBash(v) : null;
}

/** Every home directory string: HOME, USERPROFILE and the process's. */
function homeValues(env: ActivityEnv, identity: [string[], string[], string[]]): string[] {
  const values = [envStr(env, 'HOME'), envStr(env, 'USERPROFILE'), ...identity[1]];
  return values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => gitBash(v.trim()));
}

/** Runs of letters and digits; every other char splits. */
function tokensOf(folded: string): string[] {
  return folded.match(NAME_TOKEN_RE) ?? [];
}

/**
 * Folded private names: USER, LOGNAME, USERNAME and the process's user name,
 * plus the basename of HOME, USERPROFILE or the process's home only when its
 * parent is named `Users`, `home` or `Profiles`. Service accounts are never
 * private.
 */
export function userNames(env: ActivityEnv = process.env): Set<string> {
  const identity = activitySeams.systemIdentity();
  const names = new Set<string>();
  for (const value of [envStr(env, 'USER'), envStr(env, 'LOGNAME'), envStr(env, 'USERNAME'), ...identity[0]]) {
    if (typeof value === 'string' && value.trim() !== '') names.add(fold(value.trim()));
  }
  for (const value of homeValues(env, identity)) {
    const comps = value.replace(/\\/g, '/').split('/').filter((c) => c !== '');
    if (comps.length >= 2 && HOMES_PARENTS.has(fold(comps[comps.length - 2]))) names.add(fold(comps[comps.length - 1]));
  }
  return new Set([...names].filter((n) => n !== '' && !n.includes(':') && !SERVICE_ACCOUNTS.has(n) && tokensOf(n).length > 0));
}

/**
 * True when `text` names the user (P2). Tokenized on non-alphanumerics (case
 * and NFC folded): a name part of ≥ 3 chars hits any token containing it, a
 * shorter part only an equal token; a multi-part name also hits when the
 * folded text contains it whole.
 */
export function nameHit(text: string, names: Set<string>): boolean {
  const folded = fold(text);
  const tokens = tokensOf(folded);
  for (const name of names) {
    const parts = tokensOf(name);
    if (!(parts.length === 1 && parts[0] === name) && folded.includes(name)) return true;
    for (const part of parts) {
      if (cpLen(part) >= SUBSTRING_NAME_CHARS) {
        if (tokens.some((t) => t.includes(part))) return true;
      } else if (tokens.includes(part)) {
        return true;
      }
    }
  }
  return false;
}

function comps(path: string): string[] {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
}

/** Components of `child` strictly below `parent` (fold-compared), original case kept; null otherwise. */
function below(child: string, parent: string): string[] | null {
  const cp = comps(child);
  const pp = comps(parent);
  if (cp.length <= pp.length) return null;
  for (let i = 0; i < pp.length; i++) if (foldPath(pp[i]) !== foldPath(cp[i])) return null;
  return cp.slice(pp.length);
}

/**
 * Python `os.path.realpath` (non-strict): symlinks resolved component by
 * component, `..` applied to the resolved prefix, missing components kept.
 */
function realpathPosix(path: string): string {
  const seen = new Map<string, string | null>();
  const joinReal = (base: string, rest: string): [string, boolean] => {
    let p = base;
    let r = rest;
    if (r.startsWith('/')) {
      r = r.slice(1);
      p = '/';
    }
    while (r) {
      const i = r.indexOf('/');
      const name = i < 0 ? r : r.slice(0, i);
      r = i < 0 ? '' : r.slice(i + 1);
      if (name === '' || name === '.') continue;
      if (name === '..') {
        if (p) {
          const parent = nodePath.posix.dirname(p);
          const last = nodePath.posix.basename(p);
          p = last === '..' ? nodePath.posix.join(parent, '..', '..') : parent;
        } else {
          p = '..';
        }
        continue;
      }
      const next = p === '' ? name : nodePath.posix.join(p, name);
      let isLink = false;
      try {
        isLink = lstatSync(next).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (!isLink) {
        p = next;
        continue;
      }
      if (seen.has(next)) {
        const known = seen.get(next);
        if (known !== null && known !== undefined) {
          p = known;
          continue;
        }
        return [nodePath.posix.join(next, r), false];
      }
      seen.set(next, null);
      const [resolved, ok] = joinReal(p, readlinkSync(next));
      if (!ok) return [nodePath.posix.join(resolved, r), false];
      p = resolved;
      seen.set(next, p);
    }
    return [p, true];
  };
  const [out] = joinReal('', path);
  return normpath(out.startsWith('/') ? out : `${process.cwd()}/${out}`);
}

/**
 * Python `ntpath.realpath` (non-strict): normalize, then resolve the longest
 * existing prefix (`GetFinalPathNameByHandle` ≈ `realpathSync.native`, which
 * also expands 8.3 short names such as `RUNNER~1`) and append the rest.
 */
function realpathWindows(path: string): string {
  const norm = nodePath.win32.normalize(nodePath.win32.resolve(path));
  const parts = norm.split('\\');
  for (let i = parts.length; i > 0; i--) {
    const head = parts.slice(0, i).join('\\');
    try {
      const resolved = realpathSync.native(i === 1 ? `${head}\\` : head);
      const rest = parts.slice(i);
      return rest.length === 0 ? resolved : nodePath.win32.join(resolved, ...rest);
    } catch {
      /* try a shorter prefix */
    }
  }
  return norm;
}

function real(path: string): string | null {
  try {
    return WINDOWS ? realpathWindows(path) : realpathPosix(path);
  } catch {
    return null;
  }
}

/** `path` with a leading `~` or `~/` expanded from HOME; null for `~user` or no HOME. */
function expand(path: string, env: ActivityEnv): string | null {
  if (!path.startsWith('~')) return path;
  const rest = path.slice(1);
  if (rest && rest[0] !== '/' && rest[0] !== '\\') return null;
  const home = homeOf(env);
  if (home === null) return null;
  return rest ? home.replace(/[/\\]+$/, '') + rest : home;
}

function absCwd(cwd: unknown, env: ActivityEnv): string | null {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  const expanded = expand(gitBash(cwd.trim()), env);
  return expanded && nodePath.isAbsolute(expanded) ? expanded : null;
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One of ROOT_MARKERS exists in `directory` (never cached). */
function fixedMarker(directory: string): boolean {
  return ROOT_MARKERS.some((m) => lexists(nodePath.join(directory, m)));
}

/** `directory` holds a `*.sln` (one scan, early return), cached per directory. */
function slnMarker(directory: string): boolean {
  const now = performance.now();
  const hit = lruGet(sln, directory);
  if (hit !== undefined && now - hit.at < SLN_CACHE_TTL_MS) return hit.found;
  let found = false;
  try {
    const dir = opendirSync(directory);
    try {
      for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
        if (e.name.toLowerCase().endsWith('.sln')) {
          found = true;
          break;
        }
      }
    } finally {
      dir.closeSync();
    }
  } catch {
    /* unreadable: no marker */
  }
  lruSet(sln, directory, { at: now, found }, SLN_CACHE_MAX);
  return found;
}

/** `/mnt/<letter>` (a WSL drive). */
function wslDrive(directory: string): boolean {
  const up = nodePath.dirname(directory);
  const name = nodePath.basename(directory);
  return cpLen(name) === 1 && /^\p{L}$/u.test(name) && fold(nodePath.basename(up)) === 'mnt'
    && activitySeams.fsRoot(nodePath.dirname(up));
}

/** A known place holding users' homes. */
function homesLocation(directory: string): boolean {
  const name = fold(nodePath.basename(directory));
  const parent = nodePath.dirname(directory);
  if (HOMES_PARENTS.has(name) && activitySeams.fsRoot(parent)) return true;
  if (name === 'home' && HOMES_HOSTS.has(fold(nodePath.basename(parent))) && activitySeams.fsRoot(nodePath.dirname(parent))) {
    return true;
  }
  return name === 'users' && wslDrive(parent);
}

/** Never a root, and the walk stops here. */
function stopDir(directory: string): boolean {
  if (activitySeams.fsRoot(directory)) return true;
  const parent = nodePath.dirname(directory);
  if (homesLocation(directory) || homesLocation(parent) || wslDrive(directory)) return true;
  return fold(nodePath.basename(directory)) === 'mnt' && activitySeams.fsRoot(parent);
}

function same(a: string, b: string): boolean {
  return foldPath(a) === foldPath(b);
}

/**
 * The home directories, cached per (HOME, USERPROFILE, process homes): `all`
 * (normalized and canonical; each is never a root), `real` (canonical) and
 * `blocking`, the real user homes that also block every ancestor: a home
 * inside a known homes location, or the passwd home. A HOME elsewhere (a
 * sandbox or Nix HOME inside a project) blocks only itself.
 */
function homesOf(env: ActivityEnv): Homes {
  const identity = activitySeams.systemIdentity();
  const key = JSON.stringify([envStr(env, 'HOME'), envStr(env, 'USERPROFILE'), identity[1], identity[2]]);
  const now = performance.now();
  const hit = lruGet(homesCache, key);
  if (hit !== undefined && now - hit.at < HOMES_CACHE_TTL_MS) return hit.homes;
  const values = homeValues(env, identity).filter((v) => nodePath.isAbsolute(v));
  const pwDirs = identity[2].filter((v) => nodePath.isAbsolute(v)).map((v) => canon(v)).filter((c): c is string => !!c);
  const realHomes: string[] = [];
  const blocking: string[] = [];
  for (const v of values) {
    const logical = normp(v);
    const c = canon(v);
    if (c) realHomes.push(c);
    const isUserHome = homesLocation(nodePath.dirname(logical))
      || (!!c && (homesLocation(nodePath.dirname(c)) || pwDirs.some((p) => same(c, p))));
    if (isUserHome) blocking.push(...[logical, c].filter((f): f is string => !!f));
  }
  const homes: Homes = { all: [...realHomes, ...values.map((v) => normp(v))], real: realHomes, blocking };
  lruSet(homesCache, key, { at: now, homes }, HOMES_CACHE_MAX);
  return homes;
}

/** A stop directory, any home in `homes`, or any ancestor of a home in `blocking`. */
function blocked(directory: string, homes: string[], blocking: string[]): boolean {
  if (stopDir(directory)) return true;
  if (homes.some((h) => same(directory, h))) return true;
  return blocking.some((h) => below(h, directory) !== null);
}

/** Nearest ancestor-or-self of `start` holding a marker, stopping at the first blocked directory. */
function findRoot(start: string, homes: string[], blockingHomes: string[]): string | null {
  const chain: string[] = [];
  let directory = start;
  while (!blocked(directory, homes, blockingHomes)) {
    chain.push(directory);
    const parent = nodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const fixed = chain.findIndex((d) => fixedMarker(d));
  for (const d of chain.slice(0, fixed < 0 ? chain.length : fixed)) {
    if (slnMarker(d)) return d;
  }
  return fixed < 0 ? null : chain[fixed];
}

/** realpath, plus macOS's firmlink alias: `/System/Volumes/Data/x` is `/x`. */
function canon(path: string): string | null {
  let r = real(path);
  if (r && DARWIN) {
    const prefix = '/System/Volumes/Data/';
    if (r.startsWith(prefix)) r = `/${r.slice(prefix.length)}`;
  }
  return r;
}

/**
 * P1: the real path of the project root for `cwd`, or null. Cached (LRU;
 * 30 s, or 2 s for "no root") on the raw cwd and HOME / USERPROFILE strings;
 * filesystem metadata checks only, never a subprocess.
 */
export function projectRoot(cwd: unknown, env: ActivityEnv = process.env, start0?: string | null): string | null {
  const key = JSON.stringify([cwd ?? null, envStr(env, 'HOME'), envStr(env, 'USERPROFILE')]);
  const now = performance.now();
  const hit = lruGet(roots, key);
  if (hit !== undefined && now - hit.at < (hit.root ? ROOT_CACHE_TTL_MS : ROOT_NEGATIVE_TTL_MS)) return hit.root;
  let root: string | null = null;
  const start = start0 === undefined || start0 === null ? absCwd(cwd, env) : start0;
  if (start !== null) {
    const homes = homesOf(env);
    // Walk the logical path (symlinks NOT resolved); then every stop rule
    // applies again to the real root, against the real homes.
    const found = findRoot(normp(start), homes.all, homes.blocking);
    root = found ? canon(found) : null;
    if (root !== null && blocked(root, homes.real, homes.blocking)) root = null;
  }
  lruSet(roots, key, { at: now, root }, ROOT_CACHE_MAX);
  return root;
}

/** Python `os.path.normpath` (posixpath on POSIX). */
function normp(path: string): string {
  return WINDOWS ? nodePath.normalize(path) : normpath(path);
}

/** Python `os.path.join` for two parts: an absolute second part wins; nothing is normalized. */
function pyJoin(a: string, b: string): string {
  if (nodePath.isAbsolute(b)) return b;
  return a.endsWith(nodePath.sep) || (WINDOWS && a.endsWith('/')) ? a + b : a + nodePath.sep + b;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
}

/**
 * P1 + P2 for one path argument: [target, hit, local]. `target` is the path
 * relative to the project root, or null (also over ACTIVITY_TARGET_CHARS:
 * never cut); `hit` is true when it names the user; `local` is a digest of
 * the full path, for de-duplication only, never sent.
 */
function resolvePath(raw0: string, cwd: unknown, env: ActivityEnv, names: Set<string>): [string | null, boolean, string] {
  const base = absCwd(cwd, env);
  const raw = gitBash(raw0);
  let path: string | null = null;
  if (!raw.includes(':') || (WINDOWS && WIN_ABS_RE.test(raw) && !raw.slice(2).includes(':'))) {
    path = expand(WINDOWS ? raw : raw.replace(/\\/g, '/'), env);
  }
  if (path === null || (base === null && !nodePath.isAbsolute(path))) return [null, false, digest(raw)];
  const joinedPy = base ? pyJoin(base, path) : path;
  const root = base ? projectRoot(cwd, env, base) : null;
  if (root === null) return [null, false, digest(normp(joinedPy))];
  const full = canon(joinedPy);
  const local = digest(full ?? joinedPy);
  const rel = full ? below(full, root) : null;
  if (!rel || rel.length === 0) return [null, false, local];
  const target = rel.join('/');
  if (cpLen(target) > ACTIVITY_TARGET_CHARS) return [null, false, local];
  if (nameHit(target, names)) return [null, true, local];
  return [target, false, local];
}

/**
 * The path to send for a tool's path argument, or null: relative to the
 * project root of `cwd` (P1), never naming the user (P2).
 */
export function normalizePath(raw: unknown, cwd?: string | null, env: ActivityEnv = process.env): string | null {
  const cleaned = cleanTarget(raw);
  if (cleaned === null) return null;
  return resolvePath(cleaned, cwd, env, userNames(env))[0];
}

/** P3: a subcommand may be sent (a plain verb, in `verbs` when given, not credential-shaped, no name). */
export function wordCheck(word: string, names: Set<string>, verbsOf?: ReadonlySet<string>): boolean {
  return SUBCOMMAND_RE.test(word) && (verbsOf === undefined || verbsOf.has(word))
    && !credentialShaped(word) && !nameHit(word, names);
}

/** `module`'s top package resolves inside the project root (a package dir or `.py` at the root or under `src/`). */
function projectModule(module: string, root: string | null): boolean {
  if (!root) return false;
  const top = module.split('.', 1)[0];
  for (const base of [root, nodePath.join(root, 'src')]) {
    try {
      if (statSync(nodePath.join(base, top)).isDirectory()) return true;
    } catch {
      /* absent */
    }
    try {
      if (statSync(nodePath.join(base, `${top}.py`)).isFile()) return true;
    } catch {
      /* absent */
    }
  }
  return false;
}

/**
 * R3 (allowlist) + P2: the search pattern to send, or null. At most 80
 * chars of ASCII letters, digits, `_`, `.`, `-`, spaces and non-ASCII
 * letters; at most 6 words, none starting with `-`, none credential-shaped;
 * no auth word; no user name.
 */
export function searchTarget(pattern: unknown, env: ActivityEnv = process.env, names?: Set<string>): string | null {
  const cleaned = cleanTarget(pattern);
  if (cleaned === null || cpLen(cleaned) > SEARCH_MAX_CHARS) return null;
  for (const ch of cleaned.normalize('NFC')) {
    if (SEARCH_ASCII.test(ch)) continue;
    if (ch.charCodeAt(0) < 128 || !LETTER_RE.test(ch)) return null;
  }
  const folded = casefold(cleaned);
  if (AUTH_WORDS.some((w) => folded.includes(w))) return null;
  const words = cleaned.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0 || words.length > SEARCH_MAX_WORDS) return null;
  if (words.some((w) => w.startsWith('-') || credentialShaped(w))) return null;
  if (nameHit(cleaned, names ?? userNames(env))) return null;
  return cleaned;
}


/**
 * Shell words with their quotes KEPT, exactly like Python
 * `shlex.split(command, posix=False)`: whitespace splits, a quoted word that
 * starts a token ends at its closing quote. Throws on an unterminated quote.
 * A quoted value (`grep "Secret"`) therefore fails the word shape and is
 * never sent.
 */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) throw new Error('No closing quotation');
      out.push(command.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < command.length && !isSpace(command[j])) j++;
    out.push(command.slice(i, j));
    i = j;
  }
  return out;
}

function tokens(command: string): string[] {
  try {
    return shellWords(command);
  } catch {
    return command.split(/[ \t\r\n]+/).filter((t) => t !== '');
  }
}

/**
 * P3 (hermes 0.6.6, Privacy amendment 5): the program, plus a known
 * subcommand for a known subcommand tool, or null.
 *
 * - The first word must be a bare command: no path separator, `~` or `:`,
 *   and no dot (scripts are never sent; `python3.11` is the one dotted
 *   form); it matches `^[A-Za-z0-9][A-Za-z0-9_+-]{0,40}$`, is not
 *   credential-shaped and does not name the user. Otherwise no query.
 * - For a program in SUBCOMMAND_TOOLS, the next word is sent when it is in
 *   that tool's verb list (for make/just/rake, a common target) and passes
 *   `wordCheck`. Every other program is sent alone (`rm`, `cat`, `cd`, ...).
 * - `python -m <module>` sends the module when it is a known module or one
 *   whose top package is inside the project root (`root()`, looked up only
 *   then), and passes the name check.
 * A name in a subcommand or module sends the program alone.
 */
export function commandTarget(
  command: unknown,
  env: ActivityEnv = process.env,
  names?: Set<string>,
  root?: () => string | null,
): string | null {
  const cleaned = cleanTarget(command);
  if (cleaned === null) return null;
  const nm = names ?? userNames(env);
  let words: string[] = [];
  for (const token of tokens(cleaned)) {
    if (token === '' || [...token].some((ch) => OPERATOR_CHARS.has(ch))) break;
    words.push(token);
  }
  while (words.length > 0 && ASSIGN_RE.test(words[0])) words = words.slice(1);
  if (words.length === 0) return null;
  const program = words[0];
  if ([...'/\\:~'].some((ch) => program.includes(ch))) return null;
  if (!(PROGRAM_RE.test(program) || PYTHON_RE.test(program))) return null;
  if (credentialShaped(program) || nameHit(program, nm)) return null;
  const rest = words.slice(1);
  if (PYTHON_RE.test(program)) {
    if (rest[0] === '-m' && rest.length > 1) {
      const module = rest[1];
      if (MODULE_RE.test(module) && !credentialShaped(module) && !nameHit(module, nm)
        && (PYTHON_MODULES.has(module) || projectModule(module, root ? root() : null))) {
        return `${program} ${module}`;
      }
    }
    return program;
  }
  const known = Object.prototype.hasOwnProperty.call(SUBCOMMAND_TOOLS, program.toLowerCase())
    ? SUBCOMMAND_TOOLS[program.toLowerCase()]
    : undefined;
  if (known !== undefined && rest.length > 0 && wordCheck(rest[0], nm, known)) return `${program} ${rest[0]}`;
  return program;
}

/**
 * The activity for one tool call, built from its args only, or null.
 * R4: `line` (the visible `_for:` label and the verbose `activity` field)
 * and `query` come from the same sanitized target, never a raw argument.
 * The `key` (local de-duplication only, never sent or logged) uses a digest
 * of the full path. `cwd` is the session's working directory, given by the
 * host (DSH: the session header's cwd); without one, no path is sent.
 */
export function buildActivity(
  spec: ActivitySpec | null | undefined,
  cwd?: string | null,
  env: ActivityEnv = process.env,
): Activity | null {
  if (spec === null || typeof spec !== 'object') return null;
  if (!['read', 'write', 'edit', 'search', 'run'].includes(spec.verb)) return null;
  const names = userNames(env);
  if (spec.verb === 'run') {
    const target = commandTarget(spec.command, env, names, () => projectRoot(cwd, env));
    return target === null ? null : { verb: 'run', target, key: `run\u0000${target}`, line: `run ${target}`, query: target };
  }
  const pathOf = (value: unknown): [string | null, boolean, string | null] => {
    const cleaned = cleanTarget(value);
    if (cleaned === null) return [null, false, null];
    return resolvePath(cleaned, cwd, env, names);
  };
  if (spec.verb === 'search') {
    const pattern = searchTarget(spec.pattern, env, names);
    if (pattern === null) return null;
    const [where, hit, local] = spec.path ? pathOf(spec.path) : [null, false, null];
    if (hit) return null;
    const target = pattern + (where ? ` in ${where}` : '');
    return { verb: 'search', target, key: `search\u0000${pattern}\u0000${local ?? ''}`, line: `search ${target}`, query: pattern };
  }
  const [target, , local] = pathOf(spec.path);
  if (target === null) return null;
  return { verb: spec.verb, target, key: `${VERB_CLASS[spec.verb]}\u0000${local}`, line: `${spec.verb} ${target}`, query: target };
}


/** The text sent to CT: the bare target (A6), never the verb. */
export function activityQuery(activity: Activity): string {
  return cpSlice(stripForged(activity.query).trim(), 0, ACTIVITY_QUERY_CHARS);
}

// ─────────────────────────────────────────────────────────────────────────
// key tracker and per-step rate rule
// ─────────────────────────────────────────────────────────────────────────

export type ActivityRefusal = 'step_used' | 'seen_key';

interface TrackerSession {
  keys: Map<string, true>;
  steps: Map<string, true>;
  reported: Map<string, true>;
}

function bump(map: Map<string, true>, key: string, max: number): void {
  lruSet(map, key, true, max);
}

/**
 * Per session: recent activity keys (LRU) and steps that already started a
 * query. `admit` is the whole rate rule (Hermes ActivityState).
 */
export class ActivityTracker {
  private readonly sessions = new Map<string, TrackerSession>();

  private state(sessionId: string): TrackerSession {
    const s = this.sessions.get(sessionId) ?? { keys: new Map(), steps: new Map(), reported: new Map() };
    lruSet(this.sessions, sessionId, s, ACTIVITY_SESSIONS_MAX);
    return s;
  }

  /** null when this call may start the step's query (and records it); a rejected call changes nothing. */
  admit(sessionId: string, stepId: string, key: string): ActivityRefusal | null {
    const s = this.state(sessionId);
    if (s.steps.has(stepId)) return 'step_used';
    if (s.keys.has(key)) {
      bump(s.keys, key, ACTIVITY_RECENT_KEYS_MAX);
      return 'seen_key';
    }
    bump(s.keys, key, ACTIVITY_RECENT_KEYS_MAX);
    bump(s.steps, stepId, ACTIVITY_STEP_IDS_MAX);
    return null;
  }

  /** What admit() would answer, without recording anything. */
  peek(sessionId: string, stepId: string, key: string): ActivityRefusal | null {
    const s = this.state(sessionId);
    if (s.steps.has(stepId)) return 'step_used';
    return s.keys.has(key) ? 'seen_key' : null;
  }

  /**
   * True once per step: bounds verbose skip records (a blocked would-be
   * trigger) to one per step. Needed by per-TOOL hosts (Hermes
   * `pre_tool_call`, OpenCode `tool.execute.before`, OpenClaw
   * `before_tool_call`), where every call of one step reaches the gate.
   * DSH plans a whole step once, so it does not need it.
   */
  firstReport(sessionId: string, stepId: string): boolean {
    const s = this.state(sessionId);
    if (s.reported.has(stepId)) return false;
    bump(s.reported, stepId, ACTIVITY_STEP_IDS_MAX);
    return true;
  }

  reset(): void {
    this.sessions.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// render
// ─────────────────────────────────────────────────────────────────────────

function oneLine(value: unknown): string {
  return stripForged(typeof value === 'string' ? value : '').trim().replace(/[\n\r]/g, ' ');
}

export interface ActivityCandidate {
  item: FactEntry | Correction;
  /** Ledger ids a correction supersedes (empty for an entry). */
  superseded: string[];
}

/**
 * Delivery order: corrections that supersede an id in context first, then
 * entries not already in context. Invalid ids never render (the ledger could
 * not track them).
 */
export function activityCandidates(result: WisdomMatchResult, ledger: Ledger): ActivityCandidate[] {
  const out: ActivityCandidate[] = [];
  const seen = new Set<string>();
  const inLedger = (id: string) => seen.has(id) || ledger.has(id);
  for (const it of Array.isArray(result?.corrections) ? result.corrections : []) {
    if (it === null || typeof it !== 'object' || !validId(it.id)) continue;
    const sup = (Array.isArray(it.supersedes) ? it.supersedes : []).filter(
      (s): s is string => validId(s) && ledger.has(s),
    );
    if (inLedger(it.id) || sup.length === 0) continue;
    seen.add(it.id);
    out.push({ item: it, superseded: sup });
  }
  for (const it of Array.isArray(result?.entries) ? result.entries : []) {
    if (it === null || typeof it !== 'object' || !validId(it.id)) continue;
    if (inLedger(it.id)) continue;
    seen.add(it.id);
    out.push({ item: it, superseded: [] });
  }
  return out;
}

/**
 * One fact, marker FIRST (so truncation can never show the fact without its
 * marker), at most ACTIVITY_MAX_BLOCK_CHARS; '' when it cannot fit.
 */
export function renderActivityBlock(
  item: FactEntry | Correction,
  superseded: string[],
  activity: Activity,
): string {
  if (item === null || typeof item !== 'object' || !validId(item.id)) return '';
  // Every length and cut is by code point (Python `len` / slicing): a cut
  // never splits a surrogate pair, and the caps match the Python hosts.
  let label = oneLine(activity?.line);
  if (cpLen(label) > ACTIVITY_LABEL_CHARS) label = cpSlice(label, 0, ACTIVITY_LABEL_CHARS - 1) + ELLIPSIS;
  const head = `${ACTIVITY_HEADING}\n_for: ${label}_\n\n`;
  const title = oneLine(item.title);
  const text = stripForged(typeof item.text === 'string' ? item.text : '');
  if (!title && !text.trim()) return '';
  const provenance = oneLine(typeof item.provenance === 'string' && item.provenance ? item.provenance : 'unlabeled');
  let titleLine = `${marker(item.id)} **${title}** (provenance: ${provenance})`;
  const sup = superseded.filter(validId);
  if (sup.length > 0) titleLine += ` — supersedes ${sup.map((s) => `ct-fact:${s}`).join(', ')}`;
  const remaining = ACTIVITY_MAX_BLOCK_CHARS - cpLen(head);
  const titleLen = cpLen(titleLine);
  if (remaining <= titleLen + 1) return '';
  let body = `${titleLine}\n${text}`;
  if (cpLen(body) > remaining) {
    body = `${titleLine}\n${cpSlice(text, 0, remaining - titleLen - 1 - cpLen(ELLIPSIS))}${ELLIPSIS}`;
  }
  return head + body;
}

/** The first candidate that renders (ACTIVITY_MAX_PER_STEP = 1), or null. */
export function selectActivityDelivery(
  result: WisdomMatchResult,
  ledger: Ledger,
  activity: Activity,
): { block: string; id: string } | null {
  for (const { item, superseded } of activityCandidates(result, ledger)) {
    const block = renderActivityBlock(item, superseded, activity);
    if (block !== '') return { block, id: item.id };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// match
// ─────────────────────────────────────────────────────────────────────────

export interface ActivityMatch {
  /** null on success; else capability_missing | spawn | timeout_or_exit | parse_error | hook_failed. */
  failure: string | null;
  result?: WisdomMatchResult;
}

/**
 * `ct wisdom match --max 1 -- <bare target>` through the host adapter, with
 * the same breaker bookkeeping as the user-turn path (the breaker is SHARED:
 * three failures pause both paths). Never throws.
 */
export async function runActivityMatch(
  host: HostAdapter,
  activity: Activity,
  exclude: string[],
  breaker: Breaker,
): Promise<ActivityMatch> {
  try {
    if (host.wisdomMatchAbsent()) return { failure: 'capability_missing' };
    const attempt = await host.wisdomMatch(activityQuery(activity), ACTIVITY_MAX_PER_STEP, exclude);
    if (attempt.outcome === 'spawn') {
      host.resetDiscoveryAndProbeCaches();
      return { failure: 'spawn' };
    }
    if (attempt.outcome === 'timeout_or_exit') {
      breaker.recordFailure();
      // The adapter latches a missing subcommand as timeout_or_exit too.
      return { failure: host.wisdomMatchAbsent() ? 'capability_missing' : 'timeout_or_exit' };
    }
    if (!attempt.result) return { failure: 'parse_error' };
    breaker.recordSuccess();
    return { failure: null, result: attempt.result };
  } catch {
    return { failure: 'hook_failed' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// host-neutral gates: the SAME preconditions onUserTurn enforces, so no
// host can skip them for activity delivery (a resume-OFF latch such as
// Claude Code's, the restored-session fail-closed rule, the capability
// latch, the shared breaker, delivered-id bookkeeping).
// ─────────────────────────────────────────────────────────────────────────

export type ActivityGate =
  | { ok: true; ledger: Ledger }
  | { ok: false; reason: string; ledger?: Ledger };

/**
 * Whether activity delivery may run for this session now, and the ledger
 * rebuilt from host-persisted context. Reasons: `no_session`,
 * `delivery_off`, `restored_unknown_bootstrap`, `capability_missing`,
 * `breaker_open` (the last two only when `breaker` is given: before a query).
 */
export function activityGate(host: HostAdapter, session: SessionRef, breaker?: Breaker): ActivityGate {
  if (!session || typeof session.id !== 'string' || session.id === '') return { ok: false, reason: 'no_session' };
  if (!host.deliveryEnabled(session)) return { ok: false, reason: 'delivery_off' };
  const ledger = host.rebuildLedger(session);
  if (host.restored(session) && !ledger.knownBootstrap) return { ok: false, reason: 'restored_unknown_bootstrap', ledger };
  if (breaker !== undefined) {
    if (host.wisdomMatchAbsent()) return { ok: false, reason: 'capability_missing', ledger };
    if (breaker.isOpen()) return { ok: false, reason: 'breaker_open', ledger };
  }
  return { ok: true, ledger };
}

/** Verbose record for an activity (channel `activity`); never throws. */
export function reportActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  turn: Omit<VerboseTurn, 'sessionId' | 'channel' | 'activity' | 'query'>,
): void {
  if (typeof host.recordVerbose !== 'function') return;
  try {
    host.recordVerbose({
      ...turn,
      sessionId: typeof session?.id === 'string' ? session.id : '',
      channel: 'activity',
      query: activityQuery(activity),
      activity: oneLine(activity.line),
    });
  } catch {
    /* fail quietly (INTENT rule 4) */
  }
}

export type ActivityStart =
  | { failure: null; match: Promise<ActivityMatch> }
  | { failure: string };

/**
 * Start the activity's one CT query, behind every gate: the gate's ledger
 * gives the `--exclude` bound (newest first, ≤ EXCLUDE_MAX). A refused start
 * makes no CT call; the caller decides whether to report it (hosts report
 * at most once per step, see ActivityTracker.firstReport).
 */
export function startActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  breaker: Breaker,
): ActivityStart {
  try {
    const gate = activityGate(host, session, breaker);
    if (!gate.ok) return { failure: gate.reason };
    const exclude = gate.ledger.idsMostRecentFirst.slice(0, EXCLUDE_MAX);
    return { failure: null, match: runActivityMatch(host, activity, exclude, breaker) };
  } catch {
    return { failure: 'hook_failed' };
  }
}

/**
 * Finish an activity: `match` is the settled query, or null when it ran
 * past the host's budget. Re-checks the gates against a FRESH ledger,
 * selects one fact, records it in the turn-scoped N3 cache only (so a CT
 * recall later in the turn stubs it; never `noteDelivered`, the ledger stays
 * what the agent sees) and reports every outcome to
 * verbose mode. Resolves to the block for the host to place on its channel,
 * or null. Never throws.
 */
export function finishActivity(
  host: HostAdapter,
  session: SessionRef,
  activity: Activity,
  match: ActivityMatch | null,
): string | null {
  const skip = (reason: string, extra: Partial<VerboseTurn> = {}): null => {
    reportActivity(host, session, activity, { kind: 'skip', reason, ...extra });
    return null;
  };
  try {
    if (match === null) return skip('budget');
    if (match.failure !== null || !match.result) return skip(match.failure ?? 'parse_error');
    const gate = activityGate(host, session);
    if (!gate.ok) return skip(gate.reason);
    const ledger = gate.ledger;
    const ledgerIds = [...ledger.idsMostRecentFirst];
    const sel = selectActivityDelivery(match.result, ledger, activity);
    if (sel === null) return skip('zero_hits', { result: match.result, ledgerIds });
    // No `noteDelivered`: that is the user-turn bootstrap record, and an
    // activity id stored there would outlive the message (a rejected
    // decision, a compaction) and block the fact forever. The ledger stays
    // what the agent sees; only the turn-scoped N3 cache learns the id, so a
    // CT recall later in this turn stubs it.
    const cached = host.cachedLedger ? host.cachedLedger(session) : null;
    const merged = [sel.id];
    for (const id of [...ledgerIds, ...(cached?.idsMostRecentFirst ?? [])]) {
      if (!merged.includes(id)) merged.push(id);
    }
    const set = new Set(merged);
    host.cacheLedger(session, {
      idsMostRecentFirst: merged,
      has: (id) => set.has(id),
      knownBootstrap: ledger.knownBootstrap || (cached?.knownBootstrap ?? false),
    });
    reportActivity(host, session, activity, {
      kind: 'delivery',
      reason: null,
      result: match.result,
      ledgerIds,
      deliveredIds: [sel.id],
      block: sel.block,
    });
    return sel.block;
  } catch {
    return skip('hook_failed');
  }
}

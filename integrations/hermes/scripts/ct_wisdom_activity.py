#!/usr/bin/env python3
"""ct_wisdom_activity.py — autonomous-work wisdom delivery (Hermes).

Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md.

While the agent works on its own between user messages, what it is doing
(the file it reads or edits, the command it runs, the pattern it searches)
can trigger one relevant CT fact:

  * `pre_tool_call`: build an activity from the tool's ARGS only (never
    contents, output, diffs, reasoning or full command lines). If its key is
    new for the session and no query has started yet for this model step
    (`api_request_id`), start `ct wisdom match --max 1` on a thread. The query
    is the bare target (A6 real-gate results): a relative path, a search
    pattern, or program plus subcommand.
  * `transform_tool_result` of the same call: join the prefetch within the
    3 s budget, claim one fact atomically in the in-turn ledger, and splice a
    marker-first block into the tool result.

Fail-closed classes (no CT call or no delivery, one debug line):
  empty_id, ct_tool, no_activity, no_ledger, breaker_open, seen_key,
  step_used, discovery_miss, probe_timeout, capability_missing, timeout,
  spawn, exit, parse_error, budget, zero_hits, unsupported_result,
  hook_failed.

Verbose mode (CT_WISDOM_VERBOSE=1, ct_wisdom_verbose) records each delivery
and each query that delivered nothing with channel "activity"; per-call rate
and filter skips are not recorded.

Read-only: `ct` subprocess only (via ct_wisdom_live.match_wisdom). Stdlib
only. Neither hook ever raises; the pre-hook always returns None (Hermes
blocks a tool whose pre_tool_call callback raises).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shlex
import string
import sys
import threading
import time
import unicodedata
from collections import OrderedDict, namedtuple
from functools import lru_cache

import ct_ledger
import ct_wisdom
import ct_wisdom_live
import ct_wisdom_verbose

logger = logging.getLogger(__name__)

# Frozen (spec "Channel", user decision 5; INTENT rule 6). Never raised to
# compensate for weak matching.
ACTIVITY_MAX_PER_STEP = 1
ACTIVITY_MAX_BLOCK_CHARS = 600
ACTIVITY_QUERY_CHARS = 300
TARGET_CHARS = 200
LABEL_CHARS = 120
RECENT_KEYS_MAX = 32
STEP_IDS_MAX = 16
SESSIONS_MAX = 256
PENDING_MAX = 256

ACTIVITY_HEADING = "## Curated Thoughts — relevant to this step"
ACTIVITY_RESULT_KEY = "curated_thoughts_wisdom"
_ELLIPSIS = "…"

# Never used as a target: our own block text (self-trigger guard).
_OWN_TEXT = ("ct-fact:", "## Curated Thoughts —")

Activity = namedtuple("Activity", "verb target key line query")

# ---------------------------------------------------------------------------
# activity line builder (deterministic; no semantics, INTENT rule 8)
# ---------------------------------------------------------------------------

_FILE_TOOLS = {"read_file": "read", "write_file": "write", "patch": "edit"}
_VERB_CLASS = {"read": "file", "write": "file", "edit": "file",
               "search": "search", "run": "run"}

_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_KEY_PREFIXES = ("sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_",
                 "xox", "akia", "asia", "aiza", "glpat-", "eyj")
_OPERATOR_CHARS = set(";|&<>()`")
# Programs whose first argument is free text or a value: keep only the name.
_FREE_TEXT_PROGRAMS = {"echo", "printf", "export", "set", "unset", "alias", "eval",
                       "exec", "env", "sudo", "su", "doas", "ssh", "scp", "curl", "wget",
                       "http", "https", "nc", "telnet", "openssl", "gpg", "pass",
                       "security", "op", "vault"}
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_PYTHON_RE = re.compile(r"^python[0-9.]*$")


def is_ct_tool(name):
    """True for Curated Thoughts' own tools (user decision 7: never a trigger)."""
    if not isinstance(name, str):
        return False
    lowered = name.lower()
    if "curated-thoughts" in lowered or "curated_thoughts" in lowered:
        return True
    last = re.split(r"__|\.", lowered)[-1]
    return last.startswith("curated_")


def _credential_shaped(token):
    lowered = token.lower()
    if lowered.startswith(_KEY_PREFIXES):
        return True
    digits = sum(ch.isdigit() for ch in token)
    return len(token) >= 16 and digits >= 3


def _clean_target(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or _CONTROL_RE.search(value):
        return None
    if any(own in value for own in _OWN_TEXT):
        return None
    return value


# Privacy rules (spec "Privacy amendment 4: project-root allowlist" and
# "Privacy amendment 5"; shared test vectors in
# tests/fixtures/activity_targets.json, which any port MUST run). Safe by
# construction: a path is sent only relative to a project root it resolves
# inside of; a command sends only a bare program name plus, for known
# subcommand tools, a known verb; nothing that names the user is ever sent.

# Service accounts are never private names even when USER says so (CI
# runners, containers, dev boxes): `node server.js` with USER=node is sent.
_SERVICE_ACCOUNTS = frozenset({
    "root", "node", "app", "user", "admin", "test", "ubuntu", "runner", "docker",
    "www-data", "nobody", "daemon", "ec2-user", "vscode", "codespace"})
# A name part of at least this many chars hits any token CONTAINING it; a
# shorter part hits only a token EQUAL to it (`jo` hits `jo.md`, not `join.py`).
_SUBSTRING_NAME_CHARS = 3
_SEARCH_MAX_CHARS = 80
_SEARCH_MAX_WORDS = 6
_SEARCH_ASCII = frozenset(string.ascii_letters + string.digits + "_ .-")
_LETTER_CATEGORIES = frozenset({"Lu", "Ll", "Lt", "Lm", "Lo"})
# A search pattern naming any of these (case-insensitive, anywhere) is never
# sent: what follows such a word is usually its value.
_AUTH_WORDS = ("bearer", "token", "password", "passwd", "secret", "apikey", "api_key",
               "api-key", "api key", "auth")
# A directory holding any of these (or a `*.sln` file) is a project root.
ROOT_MARKERS = (".git", ".hg", "pyproject.toml", "package.json", "Cargo.toml", "go.mod",
                "pom.xml", "build.gradle", "Gemfile", "composer.json",
                ".curated-thoughts-project")
_ROOT_CACHE_TTL = 30.0
# "No root" is cached only briefly, so `touch .curated-thoughts-project`
# takes effect almost at once.
_ROOT_NEGATIVE_TTL = 2.0
_SLN_CACHE_TTL = 30.0
_HOMES_CACHE_TTL = 30.0
_WIN_ABS_RE = re.compile(r"^[A-Za-z]:[\\/]")
# Names of the known homes locations (`/home`, `/Users`, `C:\Users`,
# `D:\Profiles`), and the `/<host>/home` hosts (Silverblue, NFS, Solaris, NAS).
_HOMES_PARENTS = frozenset({"users", "home", "profiles"})
_HOMES_HOSTS = frozenset({"var", "nfs", "export", "data"})
_GIT_BASH_RE = re.compile(r"^/([A-Za-z])(?:/(.*))?$")
_NAME_TOKEN_FIND = re.compile(r"[^\W_]+")

# The one platform table (tests replace fields with _OS._replace).
Platform = namedtuple("Platform", "windows darwin case_insensitive")
_OS = Platform(windows=os.sep == "\\", darwin=sys.platform == "darwin",
               case_insensitive=sys.platform in ("darwin", "win32"))

# ---- P3 commands (Privacy amendment 5) ----
# A program is a bare command name: no path separator, no dot (scripts such
# as `acme_export.sh` are never sent); `python3.11` is the one dotted form.
_PROGRAM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_+-]{0,40}$")
_SUBCOMMAND_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
_MODULE_RE = re.compile(r"^[a-z_][a-z0-9_.]{0,60}$")
_MAKE_TARGETS = frozenset({"build", "test", "lint", "fmt", "format", "check", "clean",
                           "install", "dev", "run", "deploy", "release", "docs", "all"})
_JS_VERBS = frozenset({"install", "i", "ci", "add", "remove", "rm", "uninstall", "run",
                       "run-script", "test", "t", "start", "build", "dev", "lint", "exec",
                       "dlx", "x", "create", "init", "publish", "pack", "update", "upgrade",
                       "up", "outdated", "audit", "ls", "list", "link", "why", "version",
                       "info", "workspace", "workspaces"})
_DOCKER_VERBS = frozenset({"build", "run", "ps", "images", "pull", "push", "exec", "logs",
                           "compose", "stop", "start", "restart", "rm", "rmi", "inspect",
                           "tag", "login", "logout", "network", "volume", "system", "buildx",
                           "container", "image", "cp", "kill", "top", "stats", "version",
                           "info"})
_APT_VERBS = frozenset({"install", "remove", "purge", "update", "upgrade", "search", "list",
                        "show", "info", "autoremove", "reinstall", "check", "makecache"})
_SUBCOMMAND_TOOLS = {
    "git": frozenset({"add", "am", "apply", "bisect", "blame", "branch", "checkout",
                      "cherry-pick", "clean", "clone", "commit", "config", "describe", "diff",
                      "fetch", "grep", "init", "log", "merge", "mv", "pull", "push", "rebase",
                      "reflog", "remote", "reset", "restore", "revert", "rm", "show", "stash",
                      "status", "submodule", "switch", "tag", "worktree", "lfs", "gc",
                      "shortlog", "notes", "range-diff", "sparse-checkout"}),
    "npm": _JS_VERBS, "pnpm": _JS_VERBS, "yarn": _JS_VERBS, "bun": _JS_VERBS,
    "cargo": frozenset({"build", "b", "check", "c", "test", "t", "run", "r", "bench", "doc",
                        "fmt", "clippy", "add", "remove", "update", "publish", "install",
                        "new", "init", "clean", "tree", "fix", "metadata", "search",
                        "nextest"}),
    "go": frozenset({"build", "test", "run", "mod", "get", "install", "vet", "fmt",
                     "generate", "env", "list", "work", "tool", "clean", "doc", "version"}),
    "docker": _DOCKER_VERBS, "podman": _DOCKER_VERBS,
    "kubectl": frozenset({"get", "describe", "apply", "delete", "logs", "exec", "rollout",
                          "scale", "port-forward", "config", "create", "edit", "top", "diff",
                          "explain", "label", "annotate", "patch", "cp", "auth", "version",
                          "cluster-info"}),
    "helm": frozenset({"install", "upgrade", "uninstall", "list", "repo", "template", "lint",
                       "package", "dependency", "status", "rollback", "pull", "push", "show",
                       "search", "test", "history", "version"}),
    "gh": frozenset({"pr", "issue", "repo", "run", "workflow", "release", "api", "auth",
                     "browse", "search", "status", "gist", "label", "secret", "variable",
                     "cache", "codespace", "extension", "project", "ruleset"}),
    "pip": frozenset({"install", "uninstall", "list", "freeze", "show", "download", "wheel",
                      "check", "config", "cache", "index", "inspect", "hash", "search"}),
    "pipx": frozenset({"install", "uninstall", "run", "list", "upgrade", "upgrade-all",
                       "inject", "reinstall", "ensurepath"}),
    "uv": frozenset({"run", "sync", "add", "remove", "lock", "pip", "venv", "tool", "init",
                     "build", "publish", "python", "tree", "export", "cache", "self"}),
    "poetry": frozenset({"install", "add", "remove", "update", "lock", "run", "build",
                         "publish", "shell", "show", "init", "new", "check", "env", "export",
                         "version", "config"}),
    "conda": frozenset({"install", "create", "activate", "deactivate", "list", "update",
                        "remove", "env", "run", "info", "search", "clean", "config"}),
    "brew": frozenset({"install", "uninstall", "reinstall", "upgrade", "update", "list",
                       "search", "info", "services", "tap", "untap", "doctor", "cleanup",
                       "outdated", "bundle", "link", "unlink", "pin", "unpin", "deps"}),
    "apt": _APT_VERBS, "apt-get": _APT_VERBS, "dnf": _APT_VERBS, "yum": _APT_VERBS,
    "terraform": frozenset({"init", "plan", "apply", "destroy", "validate", "fmt", "output",
                            "state", "import", "workspace", "show", "providers", "refresh",
                            "taint", "untaint", "graph", "console", "login", "version"}),
    "dotnet": frozenset({"build", "test", "run", "restore", "publish", "new", "add", "pack",
                         "clean", "format", "watch", "tool", "sln", "list", "remove",
                         "nuget", "ef"}),
    "mvn": frozenset({"clean", "compile", "test", "package", "install", "verify", "deploy",
                      "site", "validate", "dependency"}),
    "gradle": frozenset({"build", "test", "clean", "assemble", "check", "run", "tasks",
                         "dependencies", "publish", "bootrun", "jar", "lint"}),
    "make": _MAKE_TARGETS, "just": _MAKE_TARGETS, "rake": _MAKE_TARGETS,
    "bundle": frozenset({"install", "exec", "update", "add", "remove", "list", "show",
                         "outdated", "check", "init", "config", "lock"}),
    "rails": frozenset({"server", "s", "console", "c", "generate", "g", "destroy", "d", "db",
                        "test", "new", "routes", "runner", "credentials", "assets"}),
    "mix": frozenset({"test", "compile", "run", "format", "deps", "new", "release", "clean",
                      "credo", "dialyzer", "ecto"}),
    "dart": frozenset({"run", "test", "compile", "pub", "analyze", "format", "create", "fix",
                       "doc", "info"}),
    "flutter": frozenset({"run", "test", "build", "pub", "analyze", "format", "create",
                          "doctor", "clean", "upgrade", "devices", "install", "attach"}),
    "swift": frozenset({"build", "test", "run", "package", "format"}),
    "deno": frozenset({"run", "test", "fmt", "lint", "task", "compile", "bench", "check",
                       "install", "info", "doc", "serve", "add", "remove", "upgrade"}),
    "nx": frozenset({"run", "build", "test", "lint", "serve", "affected", "graph",
                     "run-many", "generate", "g", "show", "release", "format", "migrate"}),
    "turbo": frozenset({"run", "build", "test", "lint", "dev", "prune", "ls", "daemon",
                        "login", "link", "gen"}),
}
_PYTHON_MODULES = frozenset({"pytest", "pip", "venv", "http.server", "unittest", "black",
                             "ruff", "mypy", "build", "twine"})


class _TTLCache:
    """A small thread-safe LRU cache whose entries expire (the TTL may depend
    on the value). Used for project roots, *.sln scans and canonical homes."""

    def __init__(self, maxsize):
        self.maxsize = maxsize
        self._data = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key, ttl):
        """(True, value) on a fresh hit (moved to the LRU end), else
        (False, None). `ttl` is seconds or a function of the value."""
        now = _root_clock()
        with self._lock:
            hit = self._data.get(key)
            if hit is not None:
                limit = ttl(hit[1]) if callable(ttl) else ttl
                if now - hit[0] < limit:
                    self._data.move_to_end(key)
                    return True, hit[1]
        return False, None

    def put(self, key, value):
        with self._lock:
            self._data[key] = (_root_clock(), value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def clear(self):
        with self._lock:
            self._data.clear()

    def __iter__(self):
        with self._lock:
            return iter(list(self._data))


_root_clock = time.monotonic
_root_cache = _TTLCache(64)
_sln_cache = _TTLCache(256)
_homes_cache = _TTLCache(16)


def _fold(text):
    """Name comparison form: NFC (macOS paths are often NFD) and casefolded."""
    return unicodedata.normalize("NFC", text).casefold()


def _fold_path(text):
    """Path comparison form: NFC everywhere, casefolded only on darwin/win32."""
    text = unicodedata.normalize("NFC", text)
    return text.casefold() if _OS.case_insensitive else text


def _environ(env):
    return os.environ if env is None else env


def _env_str(env, name):
    value = env.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _git_bash(path, windows=None):
    """Git Bash's `/c/Users/x` as `C:\\Users\\x` (on Windows only)."""
    match = (_OS.windows if windows is None else windows) and _GIT_BASH_RE.match(
        path.replace("\\", "/"))
    if not match:
        return path
    return match.group(1).upper() + ":\\" + (match.group(2) or "").replace("/", "\\")


@lru_cache(maxsize=1)
def _pwd_identity():
    """(pw_name, pw_dir) of the process user, looked up once (an NSS lookup
    can be slow); (None, None) where pwd is unavailable (Windows). Cleared by
    reset_state."""
    try:
        import pwd
        entry = pwd.getpwuid(os.getuid())
        return entry.pw_name, entry.pw_dir
    except (ImportError, KeyError, AttributeError, OSError):
        return None, None


def _system_identity():
    """(names, homes, pw_dirs) of the process: pwd's pw_name; the homes
    `expanduser("~")` and pw_dir; and pw_dir alone (a real user home). Tests
    patch this; it never fails."""
    name, pw_dir = _pwd_identity()
    homes = [h for h in (os.path.expanduser("~"), pw_dir) if h]
    return [name] if name else [], homes, [pw_dir] if pw_dir else []


def _home(env):
    """HOME (or USERPROFILE) for `~` expansion."""
    value = _env_str(env, "HOME") or _env_str(env, "USERPROFILE")
    return _git_bash(value) if value else None


def _home_values(env, identity):
    """Every home directory string: HOME, USERPROFILE and the process's."""
    values = [_env_str(env, "HOME"), _env_str(env, "USERPROFILE")] + list(identity[1])
    return [_git_bash(v.strip()) for v in values if isinstance(v, str) and v.strip()]


def user_names(env=None):
    """Folded private names: USER, LOGNAME, USERNAME and pwd's pw_name, plus
    the basename of HOME, USERPROFILE or pw_dir only when its parent is named
    `Users`, `home` or `Profiles`. Service accounts are never private."""
    env = _environ(env)
    identity = _system_identity()
    names = set()
    for value in [_env_str(env, n) for n in ("USER", "LOGNAME", "USERNAME")] + list(identity[0]):
        if isinstance(value, str) and value.strip():
            names.add(_fold(value.strip()))
    for value in _home_values(env, identity):
        comps = [c for c in value.replace("\\", "/").split("/") if c]
        if len(comps) >= 2 and _fold(comps[-2]) in _HOMES_PARENTS:
            names.add(_fold(comps[-1]))
    return frozenset(n for n in names
                     if n and ":" not in n and n not in _SERVICE_ACCOUNTS
                     and _NAME_TOKEN_FIND.search(n))


def _tokens_of(folded):
    """Runs of letters and digits (str.isalnum): every other char splits,
    including `_`, `-`, en dashes, curly quotes, `×` and `÷`."""
    return _NAME_TOKEN_FIND.findall(folded)


def name_hit(text, names):
    """True when `text` names the user (P2). The text is tokenized on
    non-alphanumerics (case and NFC folded). Each name part of >= 3 chars hits
    any token containing it; a shorter part hits only an equal token. A name
    with spaces or punctuation also hits when the folded text contains it."""
    folded = _fold(text)
    tokens = _tokens_of(folded)
    for name in names:
        parts = _tokens_of(name)
        if parts != [name] and name in folded:
            return True
        for part in parts:
            if len(part) >= _SUBSTRING_NAME_CHARS:
                if any(part in token for token in tokens):
                    return True
            elif part in tokens:
                return True
    return False


def _comps(path):
    return path.replace("\\", "/").rstrip("/").split("/")


def _below(child, parent):
    """Components of `child` strictly below `parent` (compared with
    `_fold_path`), original case kept; None when not strictly below."""
    cp, pp = _comps(child), _comps(parent)
    if len(cp) <= len(pp) or any(_fold_path(a) != _fold_path(b) for a, b in zip(pp, cp)):
        return None
    return cp[len(pp):]


def _same(a, b):
    return _fold_path(a) == _fold_path(b)


def _real(path):
    try:
        return os.path.realpath(path)
    except (OSError, ValueError):
        return None


def _canon(path):
    """realpath, plus macOS's firmlink alias: `/System/Volumes/Data/x` is
    the same directory as `/x`."""
    real = _real(path)
    if real and _OS.darwin:
        prefix = "/System/Volumes/Data/"
        if real.startswith(prefix):
            real = "/" + real[len(prefix):]
    return real


def _expand(path, env):
    """`path` with a leading `~` or `~/` expanded from HOME; None for `~user`
    or when HOME is unset."""
    if not path.startswith("~"):
        return path
    rest = path[1:]
    if rest and rest[0] not in "/\\":
        return None
    home = _home(env)
    return None if home is None else home.rstrip("/\\") + rest if rest else home


def _abs_cwd(cwd, env):
    if not isinstance(cwd, str) or not cwd.strip():
        return None
    cwd = _expand(_git_bash(cwd.strip()), env)
    return cwd if cwd and os.path.isabs(cwd) else None


def _fixed_marker(directory):
    """One of ROOT_MARKERS exists in `directory` (lexists: cheap, never cached,
    so a new `.curated-thoughts-project` counts at once)."""
    return any(os.path.lexists(os.path.join(directory, m)) for m in ROOT_MARKERS)


def _sln_marker(directory):
    """`directory` holds a `*.sln` (one scandir, early return), cached per
    directory, so a re-walk after the short "no root" cache does not rescan."""
    fresh, found = _sln_cache.get(directory, _SLN_CACHE_TTL)
    if fresh:
        return found
    found = False
    try:
        with os.scandir(directory) as entries:
            found = any(e.name.lower().endswith(".sln") for e in entries)
    except OSError:
        pass
    _sln_cache.put(directory, found)
    return found


def _has_marker(directory):
    """Fixed markers first; only then scan the directory for a `*.sln`."""
    return _fixed_marker(directory) or _sln_marker(directory)


def _fs_root(directory):
    """True for a filesystem root (`/`, `C:\\`). Tests patch this to model
    `/` with a temp dir."""
    return os.path.dirname(directory) == directory


def _wsl_drive(directory):
    """`/mnt/<letter>` (a WSL drive)."""
    up = os.path.dirname(directory)
    name = os.path.basename(directory)
    return (len(name) == 1 and name.isalpha() and _fold(os.path.basename(up)) == "mnt"
            and _fs_root(os.path.dirname(up)))


def _homes_location(directory):
    """A known place holding users' homes: `/home`, `/Users`, `/Profiles`
    (`C:\\Users`, `D:\\Profiles`); `/var/home`, `/nfs/home`, `/export/home`,
    `/data/home`; `/mnt/<letter>/Users`."""
    name = _fold(os.path.basename(directory))
    parent = os.path.dirname(directory)
    if name in _HOMES_PARENTS and _fs_root(parent):
        return True
    if (name == "home" and _fold(os.path.basename(parent)) in _HOMES_HOSTS
            and _fs_root(os.path.dirname(parent))):
        return True
    return name == "users" and _wsl_drive(parent)


def _stop_dir(directory):
    """Never a project root, and the walk stops here: a filesystem root; a
    known homes location and anyone's home inside one; `/mnt` and
    `/mnt/<letter>`. Other direct children of `/` (`/app`, `/workspace`,
    `D:\\repo`) can be roots."""
    if _fs_root(directory):
        return True
    parent = os.path.dirname(directory)
    if _homes_location(directory) or _homes_location(parent) or _wsl_drive(directory):
        return True
    return _fold(os.path.basename(directory)) == "mnt" and _fs_root(parent)


Homes = namedtuple("Homes", "all real blocking")


def _homes(env):
    """The home directories, cached per (HOME, USERPROFILE, process homes):
    `all` in normalized and canonical forms (each is never a root), `real`
    canonical only, and `blocking`, the real user homes that also block
    every ancestor: a home inside a known homes location, or pw_dir. A HOME
    elsewhere (a sandbox or Nix HOME inside a project) blocks only itself."""
    identity = _system_identity()
    key = (_env_str(env, "HOME"), _env_str(env, "USERPROFILE"), tuple(identity[1]),
           tuple(identity[2]))
    fresh, value = _homes_cache.get(key, _HOMES_CACHE_TTL)
    if fresh:
        return value
    values = [v for v in _home_values(env, identity) if os.path.isabs(v)]
    pw_dirs = [c for c in (_canon(v) for v in identity[2] if os.path.isabs(v)) if c]
    real, blocking = [], []
    for v in values:
        logical, canon = os.path.normpath(v), _canon(v)
        if canon:
            real.append(canon)
        is_user_home = (_homes_location(os.path.dirname(logical))
                        or (canon and (_homes_location(os.path.dirname(canon))
                                       or any(_same(canon, p) for p in pw_dirs))))
        if is_user_home:
            blocking.extend(f for f in (logical, canon) if f)
    value = Homes(real + [os.path.normpath(v) for v in values], real, blocking)
    _homes_cache.put(key, value)
    return value


def _blocked(directory, homes, blocking):
    """Never a root (the walk stops here): a `_stop_dir`, any home directory
    in `homes`, or any ancestor of a home in `blocking`."""
    if _stop_dir(directory):
        return True
    if any(_same(directory, h) for h in homes):
        return True
    return any(_below(h, directory) is not None for h in blocking)


def _find_root(start, homes, blocking):
    """Nearest ancestor-or-self of `start` holding a marker, stopping (None)
    at the first `_blocked` directory. The fixed markers are checked for the
    whole walk first; `*.sln` is scanned only in directories nearer than the
    nearest fixed-marker hit."""
    chain = []
    directory = start
    while not _blocked(directory, homes, blocking):
        chain.append(directory)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    fixed = next((i for i, d in enumerate(chain) if _fixed_marker(d)), None)
    for d in chain[:len(chain) if fixed is None else fixed]:
        if _sln_marker(d):
            return d
    return None if fixed is None else chain[fixed]


def project_root(cwd, env=None, start=None):
    """P1: the real path of the project root for `cwd`, or None. `start` is
    `_abs_cwd(cwd, env)` when the caller already has it. Cached (LRU; 30 s,
    or 2 s for "no root") on the raw cwd and HOME / USERPROFILE strings, so
    a hit does no filesystem work; os.path checks only, never a subprocess."""
    env = _environ(env)
    key = (cwd, _env_str(env, "HOME"), _env_str(env, "USERPROFILE"))
    fresh, root = _root_cache.get(
        key, lambda r: _ROOT_CACHE_TTL if r else _ROOT_NEGATIVE_TTL)
    if fresh:
        return root
    root = None
    start = _abs_cwd(cwd, env) if start is None else start
    if start is not None:
        homes = _homes(env)
        # Walk the logical path (normalized, symlinks NOT resolved), so the
        # stop rules see `/home/bob` even where it resolves elsewhere (macOS:
        # /System/Volumes/Data/home).
        found = _find_root(os.path.normpath(start), homes.all, homes.blocking)
        root = _canon(found) if found else None
        # A symlinked or aliased cwd can resolve into HOME, an ancestor of a
        # user home or a homes location: every stop rule applies again to the
        # real root, against real homes. Failing any, there is no root.
        if root is not None and _blocked(root, homes.real, homes.blocking):
            root = None
    _root_cache.put(key, root)
    return root


def _digest(text):
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:24]


def _resolve(raw, cwd, env, names):
    """P1 + P2 for one path argument: (target, hit, local). `target` is the
    path relative to the project root, or None (also when it would exceed
    TARGET_CHARS: never cut); `hit` is True when it names the user (the
    caller then gives no activity); `local` is a digest of the full path, for
    de-duplication only, never sent."""
    base = _abs_cwd(cwd, env)
    raw = _git_bash(raw)
    path = None
    if ":" not in raw or (_OS.windows and _WIN_ABS_RE.match(raw) and ":" not in raw[2:]):
        path = _expand(raw if _OS.windows else raw.replace("\\", "/"), env)
    if path is None or (base is None and not os.path.isabs(path)):
        return None, False, _digest(raw)
    joined = os.path.join(base, path) if base else path
    root = project_root(cwd, env, start=base) if base else None
    if root is None:
        # No realpath needed: nothing is sent, the key only has to differ.
        return None, False, _digest(os.path.normpath(joined))
    full = _canon(joined)
    local = _digest(full or joined)
    rel = _below(full, root) if full else None
    if not rel:
        return None, False, local
    target = "/".join(rel)
    if len(target) > TARGET_CHARS:
        return None, False, local
    if name_hit(target, names):
        return None, True, local
    return target, False, local


def normalize_path(raw, cwd=None, env=None, names=None):
    """The path to send for a tool's path argument, or None: relative to the
    project root of `cwd` (P1), never naming the user (P2)."""
    raw = _clean_target(raw)
    if raw is None:
        return None
    env = _environ(env)
    return _resolve(raw, cwd, env, user_names(env) if names is None else names)[0]


def word_check(word, names, verbs=None):
    """P3, the one check for a subcommand: True when it may be sent, a plain
    verb (`^[a-z][a-z0-9-]{0,30}$`), in `verbs` when given, not
    credential-shaped and not naming the user. False: the program alone."""
    return (_SUBCOMMAND_RE.match(word) is not None and (verbs is None or word in verbs)
            and not _credential_shaped(word) and not name_hit(word, names))


def search_target(pattern, env=None, names=None):
    """R3 (allowlist) + P2: the search pattern to send, or None. Sent only
    when it is at most 80 chars of ASCII letters, digits, `_`, `.`, `-`,
    spaces and non-ASCII letters; has at most 6 words, none starting with
    `-`, none credential-shaped; names no auth word; and names no user."""
    pattern = _clean_target(pattern)
    if pattern is None or len(pattern) > _SEARCH_MAX_CHARS:
        return None
    for ch in unicodedata.normalize("NFC", pattern):
        if ch not in _SEARCH_ASCII and (
                ch.isascii() or unicodedata.category(ch) not in _LETTER_CATEGORIES):
            return None
    folded = pattern.casefold()
    if any(word in folded for word in _AUTH_WORDS):
        return None
    words = pattern.split()
    if not words or len(words) > _SEARCH_MAX_WORDS:
        return None
    if any(w.startswith("-") or _credential_shaped(w) for w in words):
        return None
    if name_hit(pattern, user_names(env) if names is None else names):
        return None
    return pattern


def session_cwd(task_id=None):
    """The working directory Hermes resolves this session's file-tool paths
    against (pin ee8dd6c8, tools/file_tools.py::_create_terminal_env_for_file_ops):
    the task's cwd override, else the session's recorded cwd
    (tools.terminal_tool), else TERMINAL_CWD, else the process cwd. Hermes's
    module is only read when Hermes already imported it; never imported here."""
    module = sys.modules.get("tools.terminal_tool")
    if module is not None and _nonempty(task_id):
        for getter in (lambda: (module.resolve_task_overrides(task_id) or {}).get("cwd"),
                       lambda: module.get_session_cwd(task_id)):
            try:
                value = getter()
            except Exception:
                value = None
            if isinstance(value, str) and value.strip():
                return value.strip()
    value = os.environ.get("TERMINAL_CWD")
    if isinstance(value, str) and value.strip():
        return os.path.expanduser(value.strip())
    try:
        return os.getcwd()
    except OSError:
        return None


def _tokens(command):
    """Shell words with their quotes KEPT (non-POSIX shlex), so a quoted
    value (`grep "SecretPassword"`) fails the word shape and is never sent."""
    try:
        return shlex.split(command, posix=False)
    except ValueError:
        return command.split()


def _project_module(module, root):
    """`module`'s top package resolves inside the project root: a package
    directory or a `.py` file at the root or under `src/`."""
    if not root:
        return False
    top = module.split(".", 1)[0]
    for base in (root, os.path.join(root, "src")):
        if (os.path.isdir(os.path.join(base, top))
                or os.path.isfile(os.path.join(base, top + ".py"))):
            return True
    return False


def command_target(command, env=None, names=None, root=None):
    """P3 (Privacy amendment 5): the program, plus a known subcommand for a
    known subcommand tool, or None.

    - The first word must be a bare command: no path separator, `~` or `:`,
      and no dot (scripts are never sent; `python3.11` is the one dotted
      form); it matches `^[A-Za-z0-9][A-Za-z0-9_+-]{0,40}$`, is not
      credential-shaped and does not name the user. Otherwise no query.
    - For a program in `_SUBCOMMAND_TOOLS`, the next word is sent when it is
      in that tool's verb list (for make/just/rake, a common target) and
      passes `word_check`. Every other program is sent alone: `rm`, `cat`,
      `cd`, `less`, `mkdir`, `cp`, `mv`, `vim`, ...
    - `python -m <module>` sends the module when it is a known module or one
      that resolves to a package inside the project root (`root()`, called
      only then), and passes the name check.
    A name in a subcommand or module sends the program alone."""
    command = _clean_target(command) if isinstance(command, str) else None
    if command is None:
        return None
    names = user_names(env) if names is None else names
    words = []
    for token in _tokens(command):
        if not token or any(ch in _OPERATOR_CHARS for ch in token):
            break
        words.append(token)
    while words and _ASSIGN_RE.match(words[0]):
        words = words[1:]
    if not words:
        return None
    program = words[0]
    if any(ch in program for ch in "/\\:~"):
        return None
    if not (_PROGRAM_RE.match(program) or _PYTHON_RE.match(program)):
        return None
    if _credential_shaped(program) or name_hit(program, names):
        return None
    rest = words[1:]
    if _PYTHON_RE.match(program):
        if rest[:1] == ["-m"] and len(rest) > 1:
            module = rest[1]
            if (_MODULE_RE.match(module) and not _credential_shaped(module)
                    and not name_hit(module, names)
                    and (module in _PYTHON_MODULES
                         or _project_module(module, root() if root else None))):
                return program + " " + module
        return program
    verbs = _SUBCOMMAND_TOOLS.get(program.lower())
    if verbs is not None and rest and word_check(rest[0], names, verbs):
        return program + " " + rest[0]
    return program


def activity_for(tool_name, args, cwd=None, env=None, task_id=None):
    """Activity for one tool call, built from its args only, or None.

    R4: `line` (the visible `_for:` label and the verbose `activity` field)
    and `query` are built from the same sanitized target, never a raw arg.
    The `key` (local de-duplication only, never sent) uses a digest of the
    full path. `cwd` defaults to `session_cwd(task_id)`, resolved only when
    a path argument (or a `python -m` project module) is actually used; `env`
    to os.environ."""
    if not isinstance(args, dict) or not isinstance(tool_name, str):
        return None
    verb = _FILE_TOOLS.get(tool_name)
    if verb is None and tool_name not in ("search_files", "terminal"):
        return None
    env = _environ(env)
    names = user_names(env)
    resolved_cwd = []

    def the_cwd():
        if not resolved_cwd:
            resolved_cwd.append(session_cwd(task_id) if cwd is None else cwd)
        return resolved_cwd[0]

    if tool_name == "terminal":
        target = command_target(args.get("command"), env, names,
                                root=lambda: project_root(the_cwd(), env))
        if target is None:
            return None
        return Activity("run", target, ("run", target), "run " + target, target)

    def path_of(value):
        value = _clean_target(value)
        if value is None:
            return None, False, None
        return _resolve(value, the_cwd(), env, names)

    if verb is not None:
        target, _, local = path_of(args.get("path"))
        if target is None:
            return None
        line = "%s %s" % (verb, target)
        return Activity(verb, target, (_VERB_CLASS[verb], local), line, target)
    pattern = search_target(args.get("pattern"), env, names)
    if pattern is None:
        return None
    where, hit, local = path_of(args.get("path")) if args.get("path") else (None, False, None)
    if hit:
        return None
    target = pattern + (" in " + where if where else "")
    return Activity("search", target, ("search", pattern, local), "search " + target, pattern)


def query_for(activity):
    """The text sent to CT: the bare target (A6), never the verb."""
    return ct_ledger.strip_forged(activity.query).strip()[:ACTIVITY_QUERY_CHARS]


# ---------------------------------------------------------------------------
# key tracker and per-step rate rule
# ---------------------------------------------------------------------------


class ActivityState:
    """Per session: recent activity keys (LRU) and model steps that already
    started a query. One lock; admit() is the whole rate rule."""

    def __init__(self):
        self._lock = threading.Lock()
        self._sessions = OrderedDict()

    def _state(self, session_id):
        state = self._sessions.get(session_id)
        if state is None:
            state = (OrderedDict(), OrderedDict(), OrderedDict())
            self._sessions[session_id] = state
            while len(self._sessions) > SESSIONS_MAX:
                self._sessions.popitem(last=False)
        self._sessions.move_to_end(session_id)
        return state

    def admit(self, session_id, api_request_id, key):
        """None when this call may start the step's query (and records it);
        else the failure class. A rejected call changes nothing."""
        with self._lock:
            keys, steps, _ = self._state(session_id)
            if api_request_id in steps:
                return "step_used"
            if key in keys:
                keys.move_to_end(key)
                return "seen_key"
            keys[key] = True
            while len(keys) > RECENT_KEYS_MAX:
                keys.popitem(last=False)
            steps[api_request_id] = True
            while len(steps) > STEP_IDS_MAX:
                steps.popitem(last=False)
            return None

    def peek(self, session_id, api_request_id, key):
        """What admit() would answer, without recording anything."""
        with self._lock:
            keys, steps, _ = self._state(session_id)
            if api_request_id in steps:
                return "step_used"
            return "seen_key" if key in keys else None

    def first_report(self, session_id, api_request_id):
        """True once per step: bounds verbose skip records to one per step."""
        with self._lock:
            _, _, reported = self._state(session_id)
            if api_request_id in reported:
                return False
            reported[api_request_id] = True
            while len(reported) > STEP_IDS_MAX:
                reported.popitem(last=False)
            return True

    def reset(self):
        with self._lock:
            self._sessions.clear()


_STATE = ActivityState()

# ---------------------------------------------------------------------------
# prefetch
# ---------------------------------------------------------------------------

_clock = time.monotonic


def _spawn(target):
    threading.Thread(target=target, name="ct-wisdom-activity", daemon=True).start()


class _Prefetch:
    __slots__ = ("session_id", "api_request_id", "tool_name", "activity", "query",
                 "exclude", "deadline", "done", "result", "failure")

    def __init__(self, session_id, api_request_id, tool_name, activity, exclude):
        self.session_id = session_id
        self.api_request_id = api_request_id
        self.tool_name = tool_name
        self.activity = activity
        self.query = query_for(activity)
        self.exclude = exclude
        self.deadline = _clock() + ct_wisdom_live.LIVE_TIMEOUT
        self.done = threading.Event()
        self.result = None
        self.failure = None


_pending = OrderedDict()
_pending_lock = threading.Lock()


def pending_count():
    with _pending_lock:
        return len(_pending)


def reset_state():
    """TEST-ONLY: forget keys, steps, pending prefetches, the root, *.sln and
    homes caches and the pwd lookup."""
    _STATE.reset()
    for cache in (_root_cache, _sln_cache, _homes_cache):
        cache.clear()
    _pwd_identity.cache_clear()
    with _pending_lock:
        _pending.clear()


def _run_prefetch(p):
    """Discovery, probe and match for one prefetch (worker thread). Records
    the outcome on the shared breaker exactly as the user-turn path does."""
    try:
        path, dclass = ct_wisdom.discover_ct()
        if path is None:
            p.failure = dclass or "discovery_miss"
            return
        capable = ct_wisdom_live.has_match_capability(path)
        if not capable:
            p.failure = "probe_timeout" if capable is None else "capability_missing"
            return
        result, rclass = ct_wisdom_live.match_wisdom(
            path, p.query, ACTIVITY_MAX_PER_STEP, p.exclude)
        if rclass is not None:
            if rclass in ("timeout", "exit"):
                ct_wisdom_live._BREAKER.record_failure()
            elif rclass == "spawn":
                ct_wisdom.reset_discovery_cache()
                ct_wisdom_live.reset_capability_cache()
            p.failure = rclass
            return
        ct_wisdom_live._BREAKER.record_success()
        p.result = result
    except Exception:
        logger.debug("wisdom-activity: prefetch failed", exc_info=True)
        p.failure = "hook_failed"
    finally:
        p.done.set()


def _skip(session_id, failure_class, record=False, **detail):
    """Log one skip. With record=True it is also reported to verbose mode
    (only for decisions about a real would-be query, never for the per-call
    rate and filter checks, which would flood the user's terminal)."""
    logger.debug("wisdom-activity: skip session=%s class=%s",
                 session_id or "<empty>", failure_class)
    if record:
        _record_activity_skip(dict(detail, host="hermes", channel="activity",
                                   session_id=session_id, reason=failure_class))
    return None


def _nonempty(value):
    return isinstance(value, str) and bool(value)


def on_pre_tool_call(**kwargs):
    """Hermes `pre_tool_call` callback. Always returns None (never blocks,
    never modifies args); never raises."""
    try:
        _pre_tool_call(kwargs.get("tool_name"), kwargs.get("args"),
                       kwargs.get("session_id"), kwargs.get("tool_call_id"),
                       kwargs.get("api_request_id"), kwargs.get("task_id"))
    except Exception:
        logger.debug("wisdom-activity: pre hook failed", exc_info=True)
    return None


def _pre_tool_call(tool_name, args, session_id, tool_call_id, api_request_id, task_id=None):
    if not (_nonempty(session_id) and _nonempty(tool_call_id) and _nonempty(api_request_id)):
        return _skip(session_id, "empty_id")
    if is_ct_tool(tool_name):
        return _skip(session_id, "ct_tool")
    activity = activity_for(tool_name, args, task_id=task_id)
    if activity is None or not query_for(activity):
        return _skip(session_id, "no_activity")
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    blocked = "no_ledger" if ledger is None else (
        "breaker_open" if ct_wisdom_live._BREAKER.is_open() else None)
    if blocked is not None:
        # A would-be trigger that cannot run: verbose mode hears of it once
        # per step; nothing is recorded in the key tracker.
        report = (_STATE.peek(session_id, api_request_id, activity.key) is None
                  and _STATE.first_report(session_id, api_request_id))
        return _skip(session_id, blocked, record=report, query=query_for(activity),
                     activity=activity.line)
    refused = _STATE.admit(session_id, api_request_id, activity.key)
    if refused is not None:
        return _skip(session_id, refused)
    p = _Prefetch(session_id, api_request_id, tool_name, activity,
                  sorted(ledger)[:ct_wisdom_live.EXCLUDE_MAX])
    with _pending_lock:
        _pending[tool_call_id] = p
        while len(_pending) > PENDING_MAX:
            _pending.popitem(last=False)
    _spawn(lambda: _run_prefetch(p))
    return None


# ---------------------------------------------------------------------------
# render and splice
# ---------------------------------------------------------------------------


def _one_line(value):
    return ct_wisdom._sanitize(value).strip().replace("\n", " ").replace("\r", " ")


def render_candidates(entries, corrections, ledger):
    """(item, superseded) in delivery order: corrections that supersede an id
    in context first, then entries not already in context."""
    out = []
    seen = set(ledger)
    for it in corrections:
        superseded = [s for s in it["supersedes"] if s in ledger]
        if it["id"] in seen or not superseded:
            continue
        seen.add(it["id"])
        out.append((it, superseded))
    for it in entries:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        out.append((it, []))
    return out


def render_activity_block(item, superseded, activity):
    """One fact, marker FIRST (so truncation can never show the fact without
    its marker), at most ACTIVITY_MAX_BLOCK_CHARS; "" when it cannot fit."""
    label = _one_line(activity.line)
    if len(label) > LABEL_CHARS:
        label = label[:LABEL_CHARS - 1] + _ELLIPSIS
    head = "%s\n_for: %s_\n\n" % (ACTIVITY_HEADING, label)
    title = _one_line(item["title"])
    text = ct_wisdom._sanitize(item["text"])
    if not title and not text.strip():
        return ""
    title_line = "%s **%s** (provenance: %s)" % (
        ct_ledger.marker(item["id"]), title,
        _one_line(item["provenance"] or "unlabeled"))
    if superseded:
        title_line += " — supersedes " + ", ".join("ct-fact:%s" % s for s in superseded)
    remaining = ACTIVITY_MAX_BLOCK_CHARS - len(head)
    if remaining <= len(title_line) + 1:
        return ""
    body = title_line + "\n" + text
    if len(body) > remaining:
        body = title_line + "\n" + text[:remaining - len(title_line) - 1 - len(_ELLIPSIS)] + _ELLIPSIS
    return head + body


def _splice_mode(result):
    """'object' | 'text' | None (unsupported: no delivery)."""
    if not isinstance(result, str):
        return None
    try:
        data = json.loads(result)
    except ValueError:
        return "text"
    if isinstance(data, dict) and ACTIVITY_RESULT_KEY not in data:
        return "object"
    return None


def splice(result, block):
    """The tool result with `block` added, or None. A JSON object gets one
    key spliced in before its closing brace (original bytes kept, so Hermes's
    own parsers, e.g. the write verifier, still work); plain text gets the
    block appended."""
    mode = _splice_mode(result)
    if mode == "text":
        return result + "\n\n" + block
    if mode != "object":
        return None
    stripped = result.rstrip()
    if not stripped.endswith("}"):
        return None
    body = stripped[:-1].rstrip()
    sep = "" if body.endswith("{") else ", "
    out = '%s%s"%s": %s}' % (body, sep, ACTIVITY_RESULT_KEY,
                             json.dumps(block, ensure_ascii=False))
    try:
        if json.loads(out).get(ACTIVITY_RESULT_KEY) != block:
            return None
    except ValueError:
        return None
    return out


# ---------------------------------------------------------------------------
# transform_tool_result hook
# ---------------------------------------------------------------------------


def _record_activity_delivery(event):
    """The one seam every activity delivery goes through: verbose mode
    (ct_wisdom_verbose, a no-op unless CT_WISDOM_VERBOSE is on). Never
    changes the delivered bytes; never raises."""
    try:
        ct_wisdom_verbose.record_delivery(event)
    except Exception:  # pragma: no cover - the recorder never raises
        pass


def _record_activity_skip(event):
    """Verbose record of an activity that queried (or would have) but
    delivered nothing."""
    try:
        ct_wisdom_verbose.record_non_delivery(event)
    except Exception:  # pragma: no cover - the recorder never raises
        pass


def on_transform_tool_result(**kwargs):
    """Hermes `transform_tool_result` callback: str replaces the result,
    None keeps it. Never raises."""
    try:
        return _transform(kwargs.get("result"), kwargs.get("session_id"),
                          kwargs.get("tool_call_id"))
    except Exception:
        logger.debug("wisdom-activity: transform failed", exc_info=True)
        return None


def _transform(result, session_id, tool_call_id):
    if not _nonempty(tool_call_id):
        return None
    with _pending_lock:
        p = _pending.get(tool_call_id)
        if p is None or p.session_id != session_id:
            return None
        del _pending[tool_call_id]
    base = {"query": p.query, "activity": p.activity.line}
    if _splice_mode(result) is None:
        return _skip(session_id, "unsupported_result", record=True, **base)
    if not p.done.wait(max(0.0, p.deadline - _clock())):
        return _skip(session_id, "budget", record=True, **base)
    if p.failure is not None:
        return _skip(session_id, p.failure, record=True, **base)
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return _skip(session_id, "no_ledger", record=True, **base)
    for item, superseded in render_candidates(
            p.result["entries"], p.result["corrections"], ledger):
        block = render_activity_block(item, superseded, p.activity)
        if not block:
            continue
        out = splice(result, block)
        if out is None:
            return _skip(session_id, "unsupported_result", record=True, **base)
        claimed = ct_ledger.LEDGER_CACHE.claim(session_id, [item["id"]])
        if claimed is None:
            return _skip(session_id, "no_ledger", record=True, **base)
        if not claimed:
            continue  # another tool thread delivered it first
        logger.debug("wisdom-activity: deliver session=%s ids=%s", session_id, item["id"])
        _record_activity_delivery({
            "host": "hermes", "channel": "activity", "session_id": session_id,
            "query": p.query, "activity": p.activity.line, "result": p.result,
            "ledger": sorted(ledger), "delivered": [item["id"]], "block": block,
            "tool_name": p.tool_name, "api_request_id": p.api_request_id,
        })
        return out
    # Nothing new survived: report against the ledger as it is now, including
    # anything a concurrent tool thread just claimed.
    after = ct_ledger.LEDGER_CACHE.get(session_id) or ledger
    return _skip(session_id, "zero_hits", record=True, result=p.result,
                 ledger=sorted(after), **base)

#!/usr/bin/env python3
"""ct_wisdom_activity.py — autonomous-work wisdom delivery (Hermes).

Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md.

While the agent works on its own between user messages, what it is doing
(the file it reads or edits, the command it runs, the pattern it searches)
can trigger one relevant CT fact:

  * No `pre_tool_call` hook (amendment 8): Hermes resolves approvals and
    other plugins' blocks only after every pre_tool_call callback has
    returned, and a call it blocks there never reaches the transform.
  * `transform_tool_result` (Hermes let the call run): only when the result
    proves the tool ran (`proves_ran`, per tool; anything else sends
    nothing), build the activity from the tool's ARGS
    that ran (never contents, output, diffs, reasoning or full command
    lines), claim the model step (`api_request_id`) and the activity key in
    one atomic step, start `ct wisdom match --max 1` and wait for it within
    the 3 s budget, claim one fact atomically in the in-turn ledger, and
    splice a marker-first block into the tool result. The query is the bare
    target (A6 real-gate results): a relative path, a search pattern, or
    program plus subcommand.
  * A started query that delivers nothing for any reason but zero_hits
    frees its key for a later step (after a budget miss, only once its
    worker has finished, so one activity never has two queries in flight).
    A budget miss is one breaker failure when discovery and the capability
    probe were already cached (the match had the whole budget); on a cold
    process the worker's own outcome settles the breaker instead.
  * A ct that cannot be used (no Curated Thoughts `ct` found, no `wisdom
    match`, or a `--help` probe that timed out) is remembered for
    CT_UNUSABLE_PAUSE while PATH is unchanged: later steps skip at once
    instead of waiting. A probe timeout is also one breaker failure.

Fail-closed classes (no CT call or no delivery, one debug line):
  empty_id, ct_tool, no_activity, no_ledger, breaker_open, ct_unavailable,
  probing, seen_key, step_used, refused, discovery_miss, probe_timeout,
  capability_missing, timeout, spawn, spawn_failed, exit, parse_error,
  budget, zero_hits, unsupported_result, hook_failed.
  (`refused` means the result did not prove the tool ran.)

Verbose mode (CT_WISDOM_VERBOSE=1, ct_wisdom_verbose) records each delivery
and each query that delivered nothing with channel "activity"; per-call rate
and filter skips are not recorded.

Read-only: `ct` subprocess only (via ct_wisdom_live.match_wisdom). Stdlib
only. The hook never raises.
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
_OTHER_ACTIVITY_TOOLS = ("search_files", "terminal")


def _is_activity_tool(tool_name):
    return tool_name in _FILE_TOOLS or tool_name in _OTHER_ACTIVITY_TOOLS
_VERB_CLASS = {"read": "file", "write": "file", "edit": "file",
               "search": "search", "run": "run"}

_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_KEY_PREFIXES = ("sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_",
                 "xox", "akia", "asia", "aiza", "glpat-", "eyj")
_OPERATOR_CHARS = set(";|&<>()`")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_PYTHON_RE = re.compile(r"^python([0-9]{1,2}(\.[0-9]{1,3})?)?$")
# Interpreter flags (`python [flags] -m module`): single letters, alone or
# combined (`-uB`, `-OO`); X and W take a value, attached (`-Xdev`) or as the
# next word (`-X dev`). Any other flag stops the scan (the program alone).
_PYTHON_FLAG_CHARS = frozenset("bBdEiIOPqRsSuvx")
_PYTHON_VALUE_CHARS = frozenset("XW")


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
_module_cache = _TTLCache(256)


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


Homes = namedtuple("Homes", "all real blocking user")
# A HOME inside a project root counts as a sandbox (and does not block that
# root) only at one of these paths relative to the root, or as any
# dot-directory directly under it.
_SANDBOX_HOMES = frozenset({".cache/home", "tmp/home"})


def _homes(env):
    """The home directories, cached per (HOME, USERPROFILE, process homes).
    `all`: every home in normalized and canonical forms (each is never a
    root); `real`: canonical forms; `blocking`: the homes that block their
    ancestors (HOME, USERPROFILE, `~` and pw_dir, both forms); `user`: the
    real user homes among them (inside a known homes location, pw_dir, or,
    where there is no pwd (Windows), USERPROFILE)."""
    identity = _system_identity()
    key = (_env_str(env, "HOME"), _env_str(env, "USERPROFILE"), tuple(identity[1]),
           tuple(identity[2]))
    fresh, value = _homes_cache.get(key, _HOMES_CACHE_TTL)
    if fresh:
        return value
    values = [v for v in _home_values(env, identity) if os.path.isabs(v)]
    pw_dirs = [c for c in (_canon(v) for v in identity[2] if os.path.isabs(v)) if c]
    profile = _env_str(env, "USERPROFILE")
    if not identity[2] and profile:
        profile = _git_bash(profile)
        pw_dirs += [c for c in (_canon(profile),) if c and os.path.isabs(profile)]
    real, blocking, user = [], [], []
    for v in values:
        logical, canon = os.path.normpath(v), _canon(v)
        forms = [f for f in (logical, canon) if f]
        if canon:
            real.append(canon)
        blocking.extend(forms)
        if (_homes_location(os.path.dirname(logical))
                or (canon and (_homes_location(os.path.dirname(canon))
                               or any(_same(canon, d) for d in pw_dirs)))):
            user.extend(forms)
    value = Homes(real + [os.path.normpath(v) for v in values], real, blocking, user)
    _homes_cache.put(key, value)
    return value


def _sandbox_home(home, root, user):
    """True when `home` (strictly inside `root`) is a sandbox HOME, which
    does not block `root`: not a real user home, and at a dot-directory
    directly under the root or at `.cache/home` / `tmp/home`."""
    if any(_same(home, u) for u in user):
        return False
    rel = _below(home, root)
    if not rel:
        return False
    if len(rel) == 1:
        return rel[0].startswith(".") and rel[0] not in (".", "..")
    return "/".join(_fold_path(c) for c in rel) in _SANDBOX_HOMES


def _blocked(directory, homes, blocking, user):
    """Never a root (the walk stops here): a `_stop_dir`, any home in
    `homes`, or any ancestor of a home in `blocking`, unless that home is a
    sandbox HOME inside it (`_sandbox_home`)."""
    if _stop_dir(directory):
        return True
    if any(_same(directory, h) for h in homes):
        return True
    return any(_below(h, directory) is not None and not _sandbox_home(h, directory, user)
               for h in blocking)


def _find_root(start, homes, blocking, user):
    """Nearest ancestor-or-self of `start` holding a marker, stopping (None)
    at the first `_blocked` directory. The fixed markers are checked for the
    whole walk first; `*.sln` is scanned only in directories nearer than the
    nearest fixed-marker hit."""
    chain = []
    directory = start
    while not _blocked(directory, homes, blocking, user):
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
    return _root_entry(cwd, _environ(env), start)[0]


def _root_entry(cwd, env, start=None):
    """(root, inner): the project root (see project_root) and the homes that
    lie inside it (computed once per root and cached with it, same key and
    TTL; `_resolve` never sends a path inside one)."""
    key = (cwd, _env_str(env, "HOME"), _env_str(env, "USERPROFILE"))
    fresh, entry = _root_cache.get(
        key, lambda e: _ROOT_CACHE_TTL if e[0] else _ROOT_NEGATIVE_TTL)
    if fresh:
        return entry
    root, inner = None, ()
    start = _abs_cwd(cwd, env) if start is None else start
    if start is not None:
        homes = _homes(env)
        # Walk the logical path (normalized, symlinks NOT resolved), so the
        # stop rules see `/home/bob` even where it resolves elsewhere (macOS:
        # /System/Volumes/Data/home).
        found = _find_root(os.path.normpath(start), homes.all, homes.blocking, homes.user)
        root = _canon(found) if found else None
        # A symlinked or aliased cwd can resolve into HOME, an ancestor of a
        # user home or a homes location: every stop rule applies again to the
        # real root, against real homes. Failing any, there is no root.
        if root is not None and _blocked(root, homes.real, homes.blocking, homes.user):
            root = None
        if root is not None:
            inner = tuple(h for h in homes.all if _below(h, root) is not None)
    entry = (root, inner)
    _root_cache.put(key, entry)
    return entry


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
    root, inner = _root_entry(cwd, env, start=base) if base else (None, ())
    if root is None:
        # No realpath needed: nothing is sent, the key only has to differ.
        return None, False, _digest(os.path.normpath(joined))
    full = _canon(joined)
    local = _digest(full or joined)
    rel = _below(full, root) if full else None
    if not rel:
        return None, False, local
    # A path inside ANY home that is itself inside the project root (a
    # sandbox HOME included) is never sent: that is someone's home content.
    if any(_same(x, h) or _below(x, h) is not None
           for h in inner for x in (full, os.path.normpath(joined))):
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


def _listing(directory):
    try:
        return frozenset(os.listdir(directory))
    except OSError:
        return frozenset()


def _project_package(module, root):
    """The top package of `module` when it is a real package inside the
    project root, else None: a `<top>.py` file, or a `<top>/` directory
    holding `__init__.py`, at the root or under `src/`. Each candidate is
    `stat`ed first; only on a hit is the exact name confirmed by directory
    listing (case-SENSITIVE, even on case-insensitive filesystems). (Namespace
    packages, without `__init__.py`, do not count: any folder would qualify
    and nothing marks them.) Only the top package is ever sent, never a
    submodule path. Cached per (root, top); "not found" only briefly."""
    if not root:
        return None
    top = module.split(".", 1)[0]
    fresh, found = _module_cache.get(
        (root, top), lambda f: _ROOT_CACHE_TTL if f else _ROOT_NEGATIVE_TTL)
    if not fresh:
        found = False
        for base in (root, os.path.join(root, "src")):
            found = ((os.path.isfile(os.path.join(base, top + ".py"))
                      and top + ".py" in _listing(base))
                     or (os.path.isfile(os.path.join(base, top, "__init__.py"))
                         and top in _listing(base)
                         and "__init__.py" in _listing(os.path.join(base, top))))
            if found:
                break
        _module_cache.put((root, top), found)
    return top if found else None


def _python_module(rest):
    """The module of `python [flags] -m <module> ...`, or None. Flags are
    parsed alone or combined (`-uB`, `-OO`, `-um`), X/W values attached or
    separate; `m` takes the rest of its word as the module when there is one
    (`-mpytest`, `-umpytest`), else the next word. Any unknown flag, a long
    option or a non-flag word stops the scan."""
    i = 0
    while i < len(rest):
        word = rest[i]
        if not word.startswith("-") or word.startswith("--") or len(word) < 2:
            return None
        chars = word[1:]
        j = 0
        while j < len(chars):
            c = chars[j]
            if c == "m":
                if j != len(chars) - 1:
                    return chars[j + 1:]
                return rest[i + 1] if i + 1 < len(rest) else None
            if c in _PYTHON_VALUE_CHARS:
                if j == len(chars) - 1:  # the value is the next word
                    if i + 1 >= len(rest):
                        return None
                    i += 1
                break  # an attached value ends this word
            if c not in _PYTHON_FLAG_CHARS:
                return None
            j += 1
        i += 1
    return None


def command_target(command, env=None, names=None, root=None):
    """P3 (Privacy amendment 5): the program, plus a known subcommand for a
    known subcommand tool, or None.

    - The first word must be a bare command: no path separator, `~` or `:`,
      and, after a Windows `.exe` suffix is dropped (only that one), no dot
      (scripts are never sent; `python3.11` is the one dotted form); it
      matches `^[A-Za-z0-9][A-Za-z0-9_+-]{0,40}$`, is not credential-shaped
      and does not name the user. Otherwise no query.
    - For a program in `_SUBCOMMAND_TOOLS`, the next word is sent when it is
      in that tool's verb list (for make/just/rake, a common target) and
      passes `word_check`. Every other program is sent alone: `rm`, `cat`,
      `cd`, `less`, `mkdir`, `cp`, `mv`, `vim`, ...
    - `python [flags] -m <module>` (`_python_module` parses the flags) sends
      a known module as listed, or only the TOP package of a real package
      inside the project root (`root()`, called only then). The full module
      must pass the name check, and so must the exact sent string
      (`python <module>`): a multi-word name can show up only once the
      program and the module are joined.
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
    stem, suffix = os.path.splitext(program)
    if suffix.lower() == ".exe":  # only .exe: .bat/.cmd/.com/.ps1 are scripts
        program = stem
    is_python = _PYTHON_RE.match(program) is not None
    if not (is_python or _PROGRAM_RE.match(program)):
        return None
    if _credential_shaped(program) or name_hit(program, names):
        return None
    rest = words[1:]
    if is_python:
        module = _python_module(rest)
        # Name checks: first the full module (the program passed already;
        # `python -m tests.alice_notes` sends `python` alone), and
        # then on the exact joined string that is sent, which also catches a
        # multi-word name spanning the program and the module.
        if (module and _MODULE_RE.match(module) and not _credential_shaped(module)
                and not name_hit(module, names)):
            sent = module if module in _PYTHON_MODULES else _project_package(
                module, root() if root else None)
            if sent and not name_hit(program + " " + sent, names):
                return program + " " + sent
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
    if verb is None and tool_name not in _OTHER_ACTIVITY_TOOLS:
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
    """Per session: recent activity keys (LRU), the model steps that started
    a query and the steps already reported. One lock.

    Amendment 8: everything happens in `transform_tool_result`, after Hermes
    decided the call may run. `start` claims the step and the key together,
    just before the query starts, so a call Hermes blocks earlier never holds
    the step."""

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

    def start(self, session_id, api_request_id, key):
        """None when this call may start the step's query (the step and the
        key are both recorded); else "step_used" or "seen_key". A rejected
        call changes nothing but the key's recency."""
        with self._lock:
            keys, steps, _ = self._state(session_id)
            if api_request_id in steps:
                return "step_used"
            if key in keys:
                keys.move_to_end(key)
                return "seen_key"
            steps[api_request_id] = True
            while len(steps) > STEP_IDS_MAX:
                steps.popitem(last=False)
            keys[key] = True
            while len(keys) > RECENT_KEYS_MAX:
                keys.popitem(last=False)
            return None

    def release(self, session_id, api_request_id, key):
        """Undo start(): free the step and the key (the query never started)."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is not None:
                state[0].pop(key, None)
                state[1].pop(api_request_id, None)

    def release_key(self, session_id, key):
        """Forget a key whose query never got a genuine answer, so a LATER
        step can retry it (the step stays used)."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is not None:
                state[0].pop(key, None)

    def peek(self, session_id, api_request_id, key):
        """What start() would answer. Pure: records nothing, not even the
        session's or the key's recency."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                return None
            keys, steps, _ = state
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
# the query (started and joined in transform_tool_result)
# ---------------------------------------------------------------------------

_clock = time.monotonic


def _spawn(target):
    threading.Thread(target=target, name="ct-wisdom-activity", daemon=True).start()


# A ct that cannot be used is remembered this long (while PATH is unchanged),
# so a broken or absent ct costs at most one wait per pause, then goes quiet.
CT_UNUSABLE_PAUSE = ct_wisdom_live.BREAKER_PAUSE
_UNUSABLE_CLASSES = frozenset({"discovery_miss", "probe_timeout", "capability_missing"})
_unusable = {}
_unusable_lock = threading.Lock()


def _ct_unusable():
    """The remembered reason ct cannot be used, or None (expired, or PATH
    changed: a new ct may be reachable)."""
    with _unusable_lock:
        if not _unusable:
            return None
        moved = _unusable["path"] != os.environ.get("PATH")
        if not moved and _clock() < _unusable["until"]:
            return _unusable["reason"]
        _unusable.clear()
    if moved:
        # discover_ct keeps one accepted path per process and the probe
        # caches per path: without a reset the retry would not re-discover.
        ct_wisdom.reset_discovery_cache()
        ct_wisdom_live.reset_capability_cache()
    return None


def _mark_unusable(reason):
    with _unusable_lock:
        _unusable.update(until=_clock() + CT_UNUSABLE_PAUSE,
                         path=os.environ.get("PATH"), reason=reason)


# At most one cold query (discovery plus capability probe) in flight per
# process: a hung ct must not collect parallel probes, one per new activity.
_probe_busy = []
_probe_lock = threading.Lock()


def _take_probe():
    with _probe_lock:
        if _probe_busy:
            return False
        _probe_busy.append(True)
        return True


def _release_probe():
    with _probe_lock:
        _probe_busy.clear()


def _ct_warm():
    """True when discovery and the capability probe are both cached, so the
    whole budget goes to `ct wisdom match` (finding 1: on a cold process the
    3 s wait also covers `ct --help` and `ct wisdom match --help`). Reads the
    two caches only; runs nothing."""
    path = ct_wisdom._accepted_ct_path
    if path is None:
        return False
    with ct_wisdom_live._capability_lock:
        return ct_wisdom_live._capability.get(path) is True


class _Prefetch:
    __slots__ = ("session_id", "api_request_id", "tool_name", "activity", "query",
                 "exclude", "deadline", "warm", "done", "result", "failure", "lock",
                 "settled", "abandoned")

    def __init__(self, session_id, api_request_id, tool_name, activity, exclude, warm):
        self.session_id = session_id
        self.api_request_id = api_request_id
        self.tool_name = tool_name
        self.activity = activity
        self.query = query_for(activity)
        self.exclude = exclude
        self.deadline = _clock() + ct_wisdom_live.LIVE_TIMEOUT
        self.warm = warm
        self.done = threading.Event()
        self.result = None
        self.failure = None
        self.lock = threading.Lock()
        self.settled = False
        self.abandoned = False


def reset_state():
    """TEST-ONLY: forget keys, steps, the root, *.sln, homes and module
    caches and the pwd lookup."""
    _STATE.reset()
    for cache in (_root_cache, _sln_cache, _homes_cache, _module_cache):
        cache.clear()
    _pwd_identity.cache_clear()
    with _unusable_lock:
        _unusable.clear()
    _release_probe()


def _record_breaker(outcome):
    if outcome == "failure":
        ct_wisdom_live._BREAKER.record_failure()
    elif outcome == "success":
        ct_wisdom_live._BREAKER.record_success()


def _finish(p, result, failure, outcome):
    """The worker's end, under the query lock: publish the result, mark the
    query done and settle the breaker unless the transform already did. The
    shared breaker hears of each query EXACTLY once."""
    with p.lock:
        p.result, p.failure = result, failure
        p.done.set()
        record = None if p.settled else outcome
        p.settled = True
        abandoned = p.abandoned
    _record_breaker(record)
    if not p.warm:
        _release_probe()
    if failure in _UNUSABLE_CLASSES:
        _mark_unusable(failure)
    if abandoned:
        # The transform gave up on this query and delivered nothing: the key
        # is free again only now, so the activity never has two in flight.
        _STATE.release_key(p.session_id, p.activity.key)


def _run_prefetch(p):
    """Discovery, probe and match for one query (worker thread). Outcome for
    the breaker: a probe timeout (`ct --help` or `ct wisdom match --help`)
    or a match timeout/exit is a failure, an answer a success, anything else
    nothing (a spawn error resets the discovery and capability caches)."""
    result, failure, outcome = None, None, None
    try:
        path, dclass = ct_wisdom.discover_ct()
        if path is None:
            failure = dclass or "discovery_miss"
            outcome = "failure" if failure == "probe_timeout" else None
            return
        started = _clock()
        capable = ct_wisdom_live.has_match_capability(path)
        if capable is None and _clock() - started < ct_wisdom.PROBE_TIMEOUT:
            # None before the timeout can fire is an OSError at spawn (ct
            # moved or uninstalled): spawn-class, as on the match path.
            ct_wisdom.reset_discovery_cache()
            ct_wisdom_live.reset_capability_cache()
            failure = "spawn"
            return
        if not capable:
            failure = "probe_timeout" if capable is None else "capability_missing"
            outcome = "failure" if capable is None else None
            return
        answer, rclass = ct_wisdom_live.match_wisdom(
            path, p.query, ACTIVITY_MAX_PER_STEP, p.exclude)
        if rclass is not None:
            if rclass in ("timeout", "exit"):
                outcome = "failure"
            elif rclass == "spawn":
                ct_wisdom.reset_discovery_cache()
                ct_wisdom_live.reset_capability_cache()
            failure = rclass
            return
        result, outcome = answer, "success"
    except Exception:
        logger.debug("wisdom-activity: prefetch failed", exc_info=True)
        result, failure, outcome = None, "hook_failed", None
    finally:
        _finish(p, result, failure, outcome)


def _wait(p):
    """Wait for the query within what is left of its budget; True when done."""
    return p.done.wait(max(0.0, p.deadline - _clock()))


def _budget_ran_out(p):
    """The transform's wait ran out. Under the query lock: False when the
    worker finished meanwhile (its result is used and it settled the
    breaker). Else True; a warm query then records ONE budget failure (the
    core's recordActivityBudgetMiss) and the worker's later outcome is
    ignored. A cold query (discovery or probe ran in this budget) records
    nothing here: the worker's own outcome settles the breaker later. Either
    way the query is marked abandoned: its worker frees the key when it
    finishes."""
    with p.lock:
        if p.done.is_set():
            return False
        p.abandoned = True
        record = None
        if p.warm and not p.settled:
            p.settled = True
            record = "failure"
    _record_breaker(record)
    return True


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


def _blocked_report(session_id, api_request_id, activity, blocked):
    """A would-be trigger that cannot run (no_ledger, breaker_open,
    ct_unavailable, probing): verbose mode hears of it once per step, so
    while ct is remembered as unusable it logs one ct_unavailable record per
    new-activity step (the user sees nothing). Nothing is recorded in the
    key tracker."""
    report = (_STATE.peek(session_id, api_request_id, activity.key) is None
              and _STATE.first_report(session_id, api_request_id))
    return _skip(session_id, blocked, record=report, query=query_for(activity),
                 activity=activity.line)


def _gate_blocked(session_id):
    """"no_ledger" | "breaker_open" | None, and the ledger."""
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return "no_ledger", None
    return ("breaker_open" if ct_wisdom_live._BREAKER.is_open() else None), ledger


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


_NOT_JSON = object()
_UNPARSED = object()


def _parse(result):
    """The tool result parsed once: its JSON value, or _NOT_JSON."""
    if not isinstance(result, str):
        return _NOT_JSON
    try:
        return json.loads(result)
    except ValueError:
        return _NOT_JSON


def _splice_mode(result, data=_UNPARSED):
    """'object' | 'text' | None (unsupported: no delivery). `data` is the
    already parsed result, when the caller has it."""
    if not isinstance(result, str):
        return None
    if data is _UNPARSED:
        data = _parse(result)
    if data is _NOT_JSON:
        return "text"
    if isinstance(data, dict) and ACTIVITY_RESULT_KEY not in data:
        return "object"
    return None


def splice(result, block, mode=None):
    """The tool result with `block` added, or None. A JSON object gets one
    key spliced in before its closing brace (original bytes kept, so Hermes's
    own parsers, e.g. the write verifier, still work); plain text gets the
    block appended. `mode` is _splice_mode(result) when already known."""
    mode = mode or _splice_mode(result)
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
                          kwargs.get("tool_call_id"), kwargs.get("tool_name"),
                          kwargs.get("args"), kwargs.get("task_id"),
                          kwargs.get("api_request_id"))
    except Exception:
        logger.debug("wisdom-activity: transform failed", exc_info=True)
        return None


# Proof that a tool ran (INTENT rule 9, spec 2026-10-17-hermes-fail-closed-
# ran-check-design.md): the success shape of each activity tool's result at
# the Hermes pin (tests/e2e/Dockerfile HERMES_COMMIT). Every result needs to
# be a JSON object whose `error` is absent or null; then, per tool:
#   - terminal: `exit_code` an int >= 0 and no `status` (foreground run,
#     non-zero exit included, or background spawn); or `status`
#     "yielded_to_background" with a `session_id` (terminal_tool.py,
#     terminal_tool_result.py, terminal_tool_background.py);
#   - read_file: `content` a str, no `status` (the dedup stub has one), and
#     `is_binary` not true (ReadResult.to_dict);
#   - write_file: `bytes_written` an int >= 0 (WriteResult.to_dict);
#   - patch: `success` is True (PatchResult.to_dict);
#   - search_files: `total_count` an int >= 0 (SearchResult.to_dict).
# Anything else (plain text, unknown fields, another tool) proves nothing,
# so nothing is sent. Fields are checked for presence and type only; no tool
# output is read. Hermes's status kwarg is not used: it says "error" for any
# non-zero exit, a command that ran (agent/display.py).


def _is_count(value):
    """An int >= 0 that is not a bool."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def proves_ran(tool_name, data):
    """True only when `data` (the parsed tool result) proves the tool ran.
    Fails closed: any shape not listed above is False."""
    if not isinstance(data, dict) or data.get("error") is not None:
        return False
    if tool_name == "terminal":
        if "status" not in data:
            return _is_count(data.get("exit_code"))
        session = data.get("session_id")
        return (data.get("status") == "yielded_to_background"
                and isinstance(session, str) and bool(session))
    if tool_name == "read_file":
        return (isinstance(data.get("content"), str) and "status" not in data
                and data.get("is_binary") is not True)
    if tool_name == "write_file":
        return _is_count(data.get("bytes_written"))
    if tool_name == "patch":
        return data.get("success") is True
    if tool_name == "search_files":
        return _is_count(data.get("total_count"))
    return False


def _transform(result, session_id, tool_call_id, tool_name=None, args=None, task_id=None,
               api_request_id=None):
    if not (_nonempty(session_id) and _nonempty(tool_call_id) and _nonempty(api_request_id)):
        return _skip(session_id, "empty_id")
    if is_ct_tool(tool_name):
        return _skip(session_id, "ct_tool")
    # Cheapest first: most calls of a step pass through here.
    if _STATE.peek(session_id, api_request_id, None) == "step_used":
        return _skip(session_id, "step_used")
    if not _is_activity_tool(tool_name):
        return _skip(session_id, "no_activity")
    data = _parse(result)
    # Hermes decided by now (approvals, other plugins' blocks, guardrails),
    # but a refusal can be worded any way. Send only when the result proves
    # the tool ran (INTENT rule 9): anything else sends nothing. Nothing is
    # recorded, so the step stays free for a later call of the same step.
    if not proves_ran(tool_name, data):
        return _skip(session_id, "refused")
    mode = _splice_mode(result, data)
    if mode is None:
        return _skip(session_id, "unsupported_result")
    # The args that actually ran (after any plugin `modify`).
    activity = activity_for(tool_name, args, task_id=task_id)
    if activity is None or not query_for(activity):
        return _skip(session_id, "no_activity")
    blocked, ledger = _gate_blocked(session_id)
    if blocked is None and _ct_unusable() is not None:
        blocked = "ct_unavailable"
    warm = _ct_warm() if blocked is None else True
    if blocked is None and not warm and not _take_probe():
        blocked = "probing"  # another cold query is discovering / probing
    if blocked is not None:
        return _blocked_report(session_id, api_request_id, activity, blocked)
    refused = _STATE.start(session_id, api_request_id, activity.key)
    if refused is not None:
        if not warm:
            _release_probe()
        return _skip(session_id, refused)
    try:
        p = _Prefetch(session_id, api_request_id, tool_name, activity,
                      sorted(ledger)[:ct_wisdom_live.EXCLUDE_MAX], warm)
        _spawn(lambda: _run_prefetch(p))
    except Exception:
        # No thread, no query: nothing was sent, so free the step, the key
        # and the probe slot.
        logger.debug("wisdom-activity: could not start the query", exc_info=True)
        _STATE.release(session_id, api_request_id, activity.key)
        if not warm:
            _release_probe()
        return _skip(session_id, "spawn_failed")
    try:
        return _deliver(p, result, mode)
    except Exception:
        # The query ran (the step stays used) but nothing was delivered.
        _STATE.release_key(session_id, activity.key)
        raise


def _deliver(p, result, mode=None):
    """Join the started query and deliver one fact, or skip. Any non-delivery
    other than zero_hits releases the key (the step stays used); after a
    budget miss the worker releases it when it finishes."""
    session_id = p.session_id
    base = {"query": p.query, "activity": p.activity.line}

    def miss(failure_class):
        _STATE.release_key(session_id, p.activity.key)
        return _skip(session_id, failure_class, record=True, **base)

    if not _wait(p) and _budget_ran_out(p):
        return _skip(session_id, "budget", record=True, **base)
    if p.failure is not None:
        return miss(p.failure)
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return miss("no_ledger")
    for item, superseded in render_candidates(
            p.result["entries"], p.result["corrections"], ledger):
        block = render_activity_block(item, superseded, p.activity)
        if not block:
            continue
        out = splice(result, block, mode)
        if out is None:
            return miss("unsupported_result")
        claimed = ct_ledger.LEDGER_CACHE.claim(session_id, [item["id"]])
        if claimed is None:
            return miss("no_ledger")
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
    # Nothing new survived (CT answered): the key stays seen. Report against
    # the ledger as it is now, including anything a concurrent tool thread
    # just claimed.
    after = ct_ledger.LEDGER_CACHE.get(session_id) or ledger
    return _skip(session_id, "zero_hits", record=True, result=p.result,
                 ledger=sorted(after), **base)

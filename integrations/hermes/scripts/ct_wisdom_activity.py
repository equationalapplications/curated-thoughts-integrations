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
import posixpath
import re
import shlex
import string
import sys
import threading
import time
import unicodedata
from collections import OrderedDict, namedtuple

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


# Privacy rules (spec "Privacy amendment 4: project-root allowlist"; shared
# test vectors in tests/fixtures/activity_targets.json, which any port MUST
# run). Safe by construction: a path is sent only relative to a project root
# it resolves inside of, and nothing that names the user is ever sent.

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
_ROOT_CACHE_MAX = 64
_root_cache = OrderedDict()
_root_lock = threading.Lock()
_root_clock = time.monotonic
_WINDOWS = os.sep == "\\"
_WIN_ABS_RE = re.compile(r"^[A-Za-z]:[\\/]")
# A directory whose parent has one of these names is someone's home: never a
# project root, and the root walk stops there.
_HOMES_PARENTS = frozenset({"users", "home", "profiles"})
# `/<host>/home` homes locations (Fedora Silverblue, NFS, Solaris, NAS).
_HOMES_HOSTS = frozenset({"var", "nfs", "export", "data"})
# P3 command allowlist.
_PROGRAM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$")
_SUBCOMMAND_RE = re.compile(r"^[a-z][a-z0-9-]{0,30}$")
_MODULE_RE = re.compile(r"^[a-z_][a-z0-9_.]{0,60}$")
# Path components are case-folded only where filesystems usually ignore case.
_CASE_INSENSITIVE = sys.platform in ("darwin", "win32")
_GIT_BASH_RE = re.compile(r"^/([A-Za-z])(?:/(.*))?$")
_NAME_TOKEN_FIND = re.compile(r"[^\W_]+")


def _fold(text):
    """Name comparison form: NFC (macOS paths are often NFD) and casefolded."""
    return unicodedata.normalize("NFC", text).casefold()


def _fold_path(text):
    """Path comparison form: NFC everywhere, casefolded only on darwin/win32."""
    text = unicodedata.normalize("NFC", text)
    return text.casefold() if _CASE_INSENSITIVE else text


def _environ(env):
    return os.environ if env is None else env


def _env_str(env, name):
    value = env.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _git_bash(path, windows=None):
    """Git Bash's `/c/Users/x` as `C:\\Users\\x` (on Windows only)."""
    match = (_WINDOWS if windows is None else windows) and _GIT_BASH_RE.match(
        path.replace("\\", "/"))
    if not match:
        return path
    return match.group(1).upper() + ":\\" + (match.group(2) or "").replace("/", "\\")


_pwd_entry = []


def _pwd_identity():
    """(pw_name, pw_dir) of the process user, looked up once (an NSS lookup
    can be slow); (None, None) where pwd is unavailable (Windows)."""
    if not _pwd_entry:
        try:
            import pwd
            entry = pwd.getpwuid(os.getuid())
            _pwd_entry.append((entry.pw_name, entry.pw_dir))
        except (ImportError, KeyError, AttributeError, OSError):
            _pwd_entry.append((None, None))
    return _pwd_entry[0]


def _system_identity():
    """(names, homes) of the process: pwd's pw_name; expanduser("~") and
    pwd's pw_dir. Tests patch this; it never fails."""
    name, pw_dir = _pwd_identity()
    homes = [os.path.expanduser("~"), pw_dir]
    return [name] if name else [], [h for h in homes if h]


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


def _real(path):
    try:
        return os.path.realpath(path)
    except (OSError, ValueError):
        return None


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


def _has_marker(directory):
    """Fixed markers first; only then scan the directory for a `*.sln`."""
    for marker in ROOT_MARKERS:
        if os.path.lexists(os.path.join(directory, marker)):
            return True
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.lower().endswith(".sln"):
                    return True
    except OSError:
        pass
    return False


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


def _find_root(start, homes):
    """Nearest ancestor-or-self of `start` holding a marker. The walk stops
    (None) at a `_stop_dir`, at any home directory and at any ancestor of
    one: those are never a root."""
    directory = start
    while True:
        if _stop_dir(directory):
            return None
        folded = _fold_path(directory)
        if any(folded == _fold_path(h) or _below(h, directory) is not None for h in homes):
            return None
        if _has_marker(directory):
            return directory
        directory = os.path.dirname(directory)


def project_root(cwd, env=None):
    """P1: the real path of the project root for `cwd`, or None. Cached
    (LRU; 30 s, or 2 s for "no root") on the raw cwd and HOME / USERPROFILE
    strings, so a hit does no filesystem work; os.path checks only, never a
    subprocess."""
    env = _environ(env)
    key = (cwd, _env_str(env, "HOME"), _env_str(env, "USERPROFILE"))
    now = _root_clock()
    with _root_lock:
        hit = _root_cache.get(key)
        if hit is not None and now - hit[0] < (_ROOT_CACHE_TTL if hit[1] else _ROOT_NEGATIVE_TTL):
            _root_cache.move_to_end(key)
            return hit[1]
    root = None
    start = _abs_cwd(cwd, env)
    if start is not None:
        # Walk the logical path (normalized, symlinks NOT resolved), so the
        # stop rules see `/home/bob` even where it resolves elsewhere (macOS:
        # /System/Volumes/Data/home); homes are compared in both forms. The
        # root found is then resolved.
        values = [v for v in _home_values(env, _system_identity()) if os.path.isabs(v)]
        homes = [h for h in (_real(v) for v in values) if h] + [os.path.normpath(v) for v in values]
        found = _find_root(os.path.normpath(start), homes)
        root = _real(found) if found else None
    with _root_lock:
        _root_cache[key] = (now, root)
        _root_cache.move_to_end(key)
        while len(_root_cache) > _ROOT_CACHE_MAX:
            _root_cache.popitem(last=False)
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
    if ":" not in raw or (_WINDOWS and _WIN_ABS_RE.match(raw) and ":" not in raw[2:]):
        path = _expand(raw if _WINDOWS else raw.replace("\\", "/"), env)
    if path is None or (base is None and not os.path.isabs(path)):
        return None, False, _digest(raw)
    joined = os.path.join(base, path) if base else path
    root = project_root(cwd, env) if base else None
    if root is None:
        # No realpath needed: nothing is sent, the key only has to differ.
        return None, False, _digest(os.path.normpath(joined))
    full = _real(joined)
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


def word_check(word, names):
    """P3, the one check for a command word: "name" when it names the user,
    "shape" when it is not a plain verb-like word (`^[a-z][a-z0-9-]{0,30}$`)
    or is credential-shaped, else "ok"."""
    if name_hit(word, names):
        return "name"
    if not _SUBCOMMAND_RE.match(word) or _credential_shaped(word):
        return "shape"
    return "ok"


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


def command_target(command, env=None, names=None):
    """Program plus subcommand of the first simple command (user decision 2,
    P3 allowlist), or None. The program (basename of the first word) must
    match `^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$`, not be credential-shaped and
    not name the user, or there is no query. The subcommand is the word right
    after the program, never a flag's value, and is sent only when it is a
    plain verb-like word (`word_check`); `python -m <module>` sends a module
    matching `^[a-z_][a-z0-9_.]{0,60}$`. Otherwise the program alone: never
    a path, a dot or a file name."""
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
    program = posixpath.basename(words[0].replace("\\", "/"))
    if (not _PROGRAM_RE.match(program) or _credential_shaped(program)
            or name_hit(program, names)):
        return None
    if program.lower() in _FREE_TEXT_PROGRAMS:
        return program
    rest = words[1:]
    if _PYTHON_RE.match(program) and rest[:1] == ["-m"]:
        module = rest[1] if len(rest) > 1 else ""
        if (_MODULE_RE.match(module) and not _credential_shaped(module)
                and not name_hit(module, names)):
            return program + " " + module
        return program
    if rest and word_check(rest[0], names) == "ok":
        return program + " " + rest[0]
    return program


def activity_for(tool_name, args, cwd=None, env=None, task_id=None):
    """Activity for one tool call, built from its args only, or None.

    R4: `line` (the visible `_for:` label and the verbose `activity` field)
    and `query` are built from the same sanitized target, never a raw arg.
    The `key` (local de-duplication only, never sent) uses a digest of the
    full path. `cwd` defaults to `session_cwd(task_id)`, resolved only when
    a path argument is actually used; `env` to os.environ."""
    if not isinstance(args, dict) or not isinstance(tool_name, str):
        return None
    verb = _FILE_TOOLS.get(tool_name)
    if verb is None and tool_name not in ("search_files", "terminal"):
        return None
    env = _environ(env)
    names = user_names(env)
    if tool_name == "terminal":
        target = command_target(args.get("command"), env, names)
        if target is None:
            return None
        return Activity("run", target, ("run", target), "run " + target, target)
    resolved_cwd = []

    def path_of(value):
        value = _clean_target(value)
        if value is None:
            return None, False, None
        if not resolved_cwd:
            resolved_cwd.append(session_cwd(task_id) if cwd is None else cwd)
        return _resolve(value, resolved_cwd[0], env, names)

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
    """TEST-ONLY: forget keys, steps, pending prefetches and project roots."""
    _STATE.reset()
    with _root_lock:
        _root_cache.clear()
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

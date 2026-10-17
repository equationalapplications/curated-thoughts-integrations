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

import json
import logging
import os
import posixpath
import re
import shlex
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

_WORD_RE = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._/-]{0,39}$")
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
_DRIVE_RE = re.compile(r"^[A-Za-z]:(/|$)")
_DRIVE_PART_RE = re.compile(r"^[A-Za-z]:$")
_QUOTE_CHARS = frozenset("\"'`‘’“”")
_HOME_PARENTS = frozenset({"users", "home"})


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


def _safe_word(token):
    return (isinstance(token, str) and _WORD_RE.match(token) is not None
            and not _credential_shaped(token))


def _clean_target(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or _CONTROL_RE.search(value):
        return None
    if any(own in value for own in _OWN_TEXT):
        return None
    return value


# Privacy amendment (spec "Privacy amendment", R1-R4; shared test vectors in
# tests/fixtures/activity_targets.json). A user name never leaves the machine.


def _fold(text):
    """Comparison form: NFC (macOS paths are often NFD) and casefolded."""
    return unicodedata.normalize("NFC", text).casefold()


def _environ(env):
    return os.environ if env is None else env


def _env_str(env, name):
    value = env.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _home(env):
    return _env_str(env, "HOME") or _env_str(env, "USERPROFILE")


def user_names(env=None):
    """Folded names of the current user: USER, LOGNAME, USERNAME and the
    basename of HOME / USERPROFILE."""
    env = _environ(env)
    names = set()
    for name in ("USER", "LOGNAME", "USERNAME"):
        value = _env_str(env, name)
        if value:
            names.add(_fold(value))
    for name in ("HOME", "USERPROFILE"):
        value = _env_str(env, name)
        if value:
            base = posixpath.basename(value.replace("\\", "/").rstrip("/"))
            if base and not base.endswith(":"):
                names.add(_fold(base))
    return frozenset(names - {"", ".", ".."})


def _abs_norm(path, env):
    """Normalized '/' form of an absolute path (drive letter lowercased, a
    leading `~` or `~/` expanded from HOME), or None when it is not one."""
    path = path.replace("\\", "/")
    if path == "~" or path.startswith("~/"):
        home = _home(env)
        if home is None:
            return None
        path = home.replace("\\", "/").rstrip("/") + path[1:]
    if _DRIVE_RE.match(path):
        path = path[0].lower() + path[1:]
    elif not path.startswith("/"):
        return None
    return posixpath.normpath(path)


def _depth(norm):
    parts = [p for p in norm.split("/") if p]
    if parts and _DRIVE_PART_RE.match(parts[0]):
        parts = parts[1:]
    return len(parts)


def valid_cwd(cwd, env=None):
    """R1: the normalized cwd, or None when it does not count: empty, not
    absolute, `/`, a drive root, any cwd of depth < 2 (`/Users`, `/home`,
    `C:/Users`) or the parent of the user's home directory."""
    if not isinstance(cwd, str) or not cwd.strip():
        return None
    env = _environ(env)
    norm = _abs_norm(cwd.strip(), env)
    if norm is None or _depth(norm) < 2:
        return None
    home = _home(env)
    home_norm = _abs_norm(home, env) if home else None
    if home_norm and _fold(posixpath.dirname(home_norm)) == _fold(norm):
        return None
    return norm


def _drop_names(parts, names):
    """R2: drop every user-name component, and `Users`/`home` right before one."""
    out = []
    for i, part in enumerate(parts):
        folded = _fold(part)
        if folded in names:
            continue
        if (folded in _HOME_PARENTS and i + 1 < len(parts)
                and _fold(parts[i + 1]) in names):
            continue
        out.append(part)
    return out


def path_token_ok(token, names):
    """True when R2 would leave `token` (one word of a search pattern or a
    command's subcommand) exactly as it is: relative, no `..`, no user-name
    component. An absolute, `~`, drive or UNC token fails."""
    if token.startswith(("/", "~", "\\\\")) or _DRIVE_RE.match(token.replace("\\", "/")):
        return False
    comps = re.split(r"[/\\]", token)
    if ".." in comps:
        return False
    return not any(_fold(c) in names for c in comps)


def normalize_path(raw, cwd=None, env=None):
    """Relative, machine-neutral form of a tool's path argument, or None.

    R2: an absolute (or `~`) path under a valid cwd (R1, `valid_cwd`) becomes
    relative to it; any other absolute or `~` path is reduced to its basename.
    Relative paths are kept, leading `..` dropped. Then every component equal
    to the user's name (`user_names`), and `Users`/`home` right before one, is
    dropped, so a user name never leaves the machine. None when nothing is left.
    """
    raw = _clean_target(raw)
    if raw is None:
        return None
    env = _environ(env)
    path = raw.replace("\\", "/")
    if path.startswith(("/", "~")) or _DRIVE_RE.match(path):
        norm = _abs_norm(path, env)
        base = valid_cwd(cwd, env)
        if norm is not None and base is not None and norm.startswith(base + "/"):
            parts = norm[len(base) + 1:].split("/")
        else:
            parts = [p for p in posixpath.normpath(path).split("/")
                     if p not in ("", ".", "..") and not _DRIVE_PART_RE.match(p)]
            parts = parts[-1:]
            if parts and parts[0].startswith("~"):
                parts = []
    else:
        parts = posixpath.normpath(path).split("/")
    parts = [p for p in parts if p not in ("", ".", "~")]
    while parts and parts[0] == "..":
        parts = parts[1:]
    parts = _drop_names(parts, user_names(env))
    if not parts:
        return None
    target = "/".join(parts)
    if len(target) > TARGET_CHARS:
        target = target[-TARGET_CHARS:].split("/", 1)[-1]
    return target or None


def search_target(pattern, env=None):
    """R3: the search pattern to send (<= TARGET_CHARS), or None when it has
    an `=`, any quote, a credential-shaped word, or a word R2 would change."""
    pattern = _clean_target(pattern)
    if pattern is None or any(ch == "=" or ch in _QUOTE_CHARS for ch in pattern):
        return None
    names = user_names(env)
    for word in pattern.split():
        if _credential_shaped(word) or not path_token_ok(word, names):
            return None
    return pattern[:TARGET_CHARS]


def _tokens(command):
    """Shell words with their quotes KEPT (non-POSIX shlex), so a quoted
    value (`grep "SecretPassword"`) fails the word shape and is never sent."""
    try:
        return shlex.split(command, posix=False)
    except ValueError:
        return command.split()


def command_target(command, env=None):
    """Program plus subcommand of the first simple command (user decision 2),
    or None. The subcommand is the word right after the program, never a
    flag's value. Everything else is dropped. A program named like the user
    gives None; a subcommand R2 would change is dropped."""
    command = _clean_target(command) if isinstance(command, str) else None
    if command is None:
        return None
    names = user_names(env)
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
    if not _safe_word(program) or _fold(program) in names:
        return None
    if program.lower() in _FREE_TEXT_PROGRAMS:
        return program
    # The subcommand is the word right after the program. A word that follows
    # a flag is the flag's VALUE (`psql -W secretpw`), never a subcommand, so
    # it is never sent. One supported form: `python -m <module>`.
    rest = words[1:]
    if _PYTHON_RE.match(program) and rest[:1] == ["-m"]:
        rest = rest[1:]
    elif rest[:1] and rest[0].startswith("-"):
        return program
    if rest and _safe_word(rest[0]) and path_token_ok(rest[0], names):
        return program + " " + rest[0]
    return program


def activity_for(tool_name, args, cwd=None, env=None):
    """Activity for one tool call, built from its args only, or None.

    R4: `line` (the visible `_for:` label and the verbose `activity` field)
    and `query` are built from the same sanitized target, never a raw arg.
    `env` defaults to os.environ (user names, HOME for `~`)."""
    if not isinstance(args, dict) or not isinstance(tool_name, str):
        return None
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = None
    env = _environ(env)
    verb = _FILE_TOOLS.get(tool_name)
    if verb is not None:
        target = normalize_path(args.get("path"), cwd, env)
        if target is None:
            return None
        line = "%s %s" % (verb, target)
        return Activity(verb, target, (_VERB_CLASS[verb], target), line, target)
    if tool_name == "search_files":
        pattern = search_target(args.get("pattern"), env)
        if pattern is None:
            return None
        where = normalize_path(args.get("path"), cwd, env) if args.get("path") else None
        target = pattern + (" in " + where if where else "")
        return Activity("search", target, ("search", target), "search " + target, pattern)
    if tool_name == "terminal":
        target = command_target(args.get("command"), env)
        if target is None:
            return None
        return Activity("run", target, ("run", target), "run " + target, target)
    return None


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
    """TEST-ONLY: forget keys, steps and pending prefetches."""
    _STATE.reset()
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
                       kwargs.get("api_request_id"))
    except Exception:
        logger.debug("wisdom-activity: pre hook failed", exc_info=True)
    return None


def _pre_tool_call(tool_name, args, session_id, tool_call_id, api_request_id):
    if not (_nonempty(session_id) and _nonempty(tool_call_id) and _nonempty(api_request_id)):
        return _skip(session_id, "empty_id")
    if is_ct_tool(tool_name):
        return _skip(session_id, "ct_tool")
    activity = activity_for(tool_name, args)
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

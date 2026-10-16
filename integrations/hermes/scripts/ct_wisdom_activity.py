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
from collections import OrderedDict, namedtuple

import ct_ledger
import ct_wisdom
import ct_wisdom_live

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


def normalize_path(raw, cwd=None):
    """Relative, machine-neutral form of a tool's path argument, or None.

    Relative paths are kept; absolute (or ~) paths under `cwd` become relative
    to it; any other absolute path is cut to its last two components so a home
    directory or user name never leaves the machine. Leading `..` are dropped.
    """
    raw = _clean_target(raw)
    if raw is None:
        return None
    path = raw.replace("\\", "/")
    absolute = path.startswith(("/", "~")) or re.match(r"^[A-Za-z]:/", path) is not None
    if absolute and cwd:
        base = posixpath.normpath(str(cwd).replace("\\", "/")).rstrip("/") + "/"
        norm = posixpath.normpath(path)
        if norm.startswith(base):
            path, absolute = norm[len(base):], False
    norm = posixpath.normpath(path)
    parts = [p for p in norm.split("/") if p not in ("", ".", "~")]
    if absolute:
        if parts and re.match(r"^[A-Za-z]:$", parts[0]):
            parts = parts[1:]
        parts = parts[-2:]
    while parts and parts[0] == "..":
        parts = parts[1:]
    if not parts:
        return None
    target = "/".join(parts)
    if len(target) > TARGET_CHARS:
        target = target[-TARGET_CHARS:].split("/", 1)[-1]
    return target or None


def _tokens(command):
    """Shell words with their quotes KEPT (non-POSIX shlex), so a quoted
    value (`grep "SecretPassword"`) fails the word shape and is never sent."""
    try:
        return shlex.split(command, posix=False)
    except ValueError:
        return command.split()


def command_target(command):
    """Program plus subcommand of the first simple command (user decision 2),
    or None. The subcommand is the word right after the program, never a
    flag's value. Everything else is dropped."""
    command = _clean_target(command) if isinstance(command, str) else None
    if command is None:
        return None
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
    if not _safe_word(program):
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
    if rest and _safe_word(rest[0]):
        return program + " " + rest[0]
    return program


def activity_for(tool_name, args, cwd=None):
    """Activity for one tool call, built from its args only, or None."""
    if not isinstance(args, dict) or not isinstance(tool_name, str):
        return None
    if cwd is None:
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = None
    verb = _FILE_TOOLS.get(tool_name)
    if verb is not None:
        target = normalize_path(args.get("path"), cwd)
        if target is None:
            return None
        line = "%s %s" % (verb, target)
        return Activity(verb, target, (_VERB_CLASS[verb], target), line, target)
    if tool_name == "search_files":
        pattern = _clean_target(args.get("pattern"))
        if pattern is None or any(_credential_shaped(w) for w in pattern.split()):
            return None
        pattern = pattern[:TARGET_CHARS]
        where = normalize_path(args.get("path"), cwd) if args.get("path") else None
        target = pattern + (" in " + where if where else "")
        return Activity("search", target, ("search", target), "search " + target, pattern)
    if tool_name == "terminal":
        target = command_target(args.get("command"))
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

    def admit(self, session_id, api_request_id, key):
        """None when this call may start the step's query (and records it);
        else the failure class. A rejected call changes nothing."""
        with self._lock:
            state = self._sessions.get(session_id)
            if state is None:
                state = (OrderedDict(), OrderedDict())
                self._sessions[session_id] = state
                while len(self._sessions) > SESSIONS_MAX:
                    self._sessions.popitem(last=False)
            self._sessions.move_to_end(session_id)
            keys, steps = state
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


def _skip(session_id, failure_class):
    logger.debug("wisdom-activity: skip session=%s class=%s",
                 session_id or "<empty>", failure_class)
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
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return _skip(session_id, "no_ledger")
    if ct_wisdom_live._BREAKER.is_open():
        return _skip(session_id, "breaker_open")
    activity = activity_for(tool_name, args)
    if activity is None or not query_for(activity):
        return _skip(session_id, "no_activity")
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
    """Seam for the planned verbose mode: called exactly once per delivered
    activity block. No-op here; wired to ct_wisdom_verbose.record_delivery
    by whichever PR merges second."""
    return None


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
    if _splice_mode(result) is None:
        return _skip(session_id, "unsupported_result")
    if not p.done.wait(max(0.0, p.deadline - _clock())):
        return _skip(session_id, "budget")
    if p.failure is not None:
        return _skip(session_id, p.failure)
    ledger = ct_ledger.LEDGER_CACHE.get(session_id)
    if ledger is None:
        return _skip(session_id, "no_ledger")
    for item, superseded in render_candidates(
            p.result["entries"], p.result["corrections"], ledger):
        block = render_activity_block(item, superseded, p.activity)
        if not block:
            continue
        out = splice(result, block)
        if out is None:
            return _skip(session_id, "unsupported_result")
        claimed = ct_ledger.LEDGER_CACHE.claim(session_id, [item["id"]])
        if claimed is None:
            return _skip(session_id, "no_ledger")
        if not claimed:
            continue  # another tool thread delivered it first
        logger.debug("wisdom-activity: deliver session=%s ids=%s", session_id, item["id"])
        _record_activity_delivery({
            "kind": "activity", "session_id": session_id, "fact_ids": [item["id"]],
            "block": block, "query": p.query, "tool_name": p.tool_name,
            "api_request_id": p.api_request_id, "gate": None,
        })
        return out
    return _skip(session_id, "zero_hits")

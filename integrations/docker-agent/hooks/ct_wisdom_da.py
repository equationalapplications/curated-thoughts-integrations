#!/usr/bin/env python3
"""ct_wisdom_da.py — Intuitive Wisdom for Docker Agent (`docker agent run`).

Spec: docs/superpowers/specs/2026-10-16-docker-agent-integration-design.md.

One command hook, registered by the hooks.d drop-in scripts/install.sh
writes, dispatching on `hook_event_name`:

  * before_llm_call     -> first-call scan of an unseen session (D5), the
                           bootstrap block inserted on every model call at a
                           fixed position (D4), the per-session step counter
                           (D7)
  * user_prompt_submit /
    user_followup_submit -> `ct wisdom match` on the user's message, stored
                           as pending for the turn's first eligible tool
                           result (D6); opt-in transient mode
                           (CT_WISDOM_DA_LIVE=prompt)
  * tool_response_transform -> deferred per-message delivery (D6),
                           autonomous-work delivery (D7) and recall dedup (D8)

The algorithm comes from the byte-identical Hermes core in ../scripts/
(ct_ledger, ct_wisdom, ct_wisdom_live, ct_wisdom_activity, ct_wisdom_verbose;
tests/tools/test_shared_script_parity.py). This module is only the Docker
Agent adapter: the store, the lock, the persisted breaker and ct cache, and
the I/O envelopes.

Every unclear state fails closed (no delivery, never a repeat). Inside a
sandbox VM (SANDBOX_VM_ID) every event is a silent no-op (D2). Read-only
toward the brain: `ct recall` and `ct wisdom match` only; Docker Agent's own
session.db is never opened. Stdlib only; every entry point is non-raising;
the process always exits 0 (exit 2 on user_prompt_submit would refuse the
user's message).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPTS = _HERE.parent / "scripts"
for _p in (str(_SCRIPTS), str(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ct_hook_store  # noqa: E402
import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_activity  # noqa: E402
import ct_wisdom_da_activity as da_activity  # noqa: E402
import ct_wisdom_live  # noqa: E402
import ct_wisdom_verbose  # noqa: E402


logger = logging.getLogger(__name__)

HOST = "docker-agent"
STORE_VERSION = 1
DATA_ENV = "DOCKER_AGENT_DATA_DIR"
SANDBOX_ENV = "SANDBOX_VM_ID"
LIVE_MODE_ENV = "CT_WISDOM_DA_LIVE"
LOCK_WAIT = ct_hook_store.LOCK_WAIT
STORE_MAX_AGE = ct_hook_store.STORE_MAX_AGE
CT_CACHE_MAX_AGE = 86400
RECENT_KEYS_MAX = ct_wisdom_activity.RECENT_KEYS_MAX
CLAIMS_MAX = 64
PROMPT_BUDGET = 8.0  # seconds of ct time per user_prompt_submit (hook timeout 10 s)
_clock = time.monotonic
# The size limiter (limit_large_tool_results) cuts results over 51 200 bytes
# or 2 000 lines AFTER our transform. Stay well under it so it can never cut
# a block (spec D6, P11).
RESULT_MAX_BYTES = 49152
RESULT_MAX_LINES = 1990
PRECHECK_MARGIN_BYTES = 8192
PRECHECK_MARGIN_LINES = 64

LIVE_HEADING = ct_wisdom_live.LIVE_HEADING
_ELLIPSIS = "…"
# The one host envelope Docker Agent v1.150.0 puts at the start of a user
# message (instruction updates, pkg/session/session.go:1113). A prompt that
# merely starts with a tag (`<div> is not centered`) is still the user's.
_ENVELOPE_RE = re.compile(r"^<system-update>")
_ATTACHED_TAG = "<attached_file"
_LIST_FIELDS = ("bootstrap_ids", "seen_ids", "delivered_ids", "tool_ids", "order", "recent_keys")
_STATES = ("pending", "on", "off")


LockTimeout = ct_hook_store.LockTimeout


# ---------------------------------------------------------------------------
# environment, paths
# ---------------------------------------------------------------------------


def env_view(env=None):
    """A copy of the environment the hook sees (os.environ by default)."""
    return dict(os.environ if env is None else env)


def wisdom_dir(view):
    """<data>/curated-thoughts/wisdom, <data> = $DOCKER_AGENT_DATA_DIR or
    ~/.cagent (Docker Agent's own rule, pkg/paths)."""
    data = view.get(DATA_ENV)
    if isinstance(data, str) and data.strip():
        root = os.path.expanduser(data.strip())
    else:
        root = os.path.join(os.path.expanduser("~"), ".cagent")
    return os.path.join(root, "curated-thoughts", "wisdom")


def verbose_env(view):
    """The env view the verbose recorder gets: CT_WISDOM_VERBOSE_LOG defaults
    to the log next to our store (ct_wisdom_verbose knows no docker-agent
    default, and the shared file is not edited)."""
    out = dict(view)
    if not (out.get(ct_wisdom_verbose.LOG_ENV) or "").strip():
        out[ct_wisdom_verbose.LOG_ENV] = os.path.join(
            wisdom_dir(view), ct_wisdom_verbose.LOG_NAME)
    return out


def in_sandbox(view):
    value = view.get(SANDBOX_ENV)
    return isinstance(value, str) and bool(value.strip())


def transient_mode(view):
    value = view.get(LIVE_MODE_ENV)
    return isinstance(value, str) and value.strip().lower() == "prompt"


# ---------------------------------------------------------------------------
# store (spec D9)
# ---------------------------------------------------------------------------


session_key = ct_hook_store.session_key


def _sessions_dir(wdir):
    return os.path.join(wdir, "sessions")


def session_path(wdir, session_id):
    return os.path.join(_sessions_dir(wdir), session_key(session_id) + ".json")


def new_store(session_id, state="pending"):
    return {
        "v": STORE_VERSION,
        "session_id": session_id,
        "state": state,
        "off_reason": None,
        "bootstrap_block": "",
        "bootstrap_ids": [],
        "seen_ids": [],
        "delivered_ids": [],
        "tool_ids": [],
        "order": [],
        "step": 0,
        "activity_step": -1,
        "recent_keys": [],
        "pending_live": None,
        # The bootstrap recall, cached while the session is pending: None
        # until a recall answered (a transient failure is retried, spec D5),
        # then the entries [[title, text, id], ...] the first model call
        # renders and the first message's match excludes.
        "boot_entries": None,
        "boot_attempts": 0,
        # {tool_use_id: block} for the last CLAIMS_MAX deliveries. The shell
        # tool streams each output chunk through tool_response_transform
        # (pkg/tools/builtin/shell/shell.go:68-72 -> callRuntime.EmitOutput)
        # before the final result; every call for one tool_use_id gets the
        # same block, claimed once, so the model-facing final result carries
        # it (spec P16).
        "claims": {},
        "updated": time.time(),
    }


def note_ids(store, field, ids):
    """Append valid, not-yet-listed ids to store[field] and store['order']."""
    for fid in ids:
        if ct_ledger.valid_id(fid) and fid not in store[field]:
            store[field].append(fid)
            store["order"].append(fid)
    return store


def ledger_of(store):
    return (set(store["bootstrap_ids"]) | set(store["seen_ids"])
            | set(store["delivered_ids"]) | set(store["tool_ids"]))


def exclude_of(store):
    """Ledger ids, most recently noted first, capped at EXCLUDE_MAX."""
    out, seen = [], set()
    for fid in reversed(store["order"]):
        if fid not in seen:
            seen.add(fid)
            out.append(fid)
    return out[: ct_wisdom_live.EXCLUDE_MAX]


def _valid_store(data, session_id):
    if not isinstance(data, dict) or data.get("v") != STORE_VERSION:
        return False
    if data.get("session_id") != session_id or data.get("state") not in _STATES:
        return False
    if not isinstance(data.get("bootstrap_block"), str):
        return False
    for field in ("step", "activity_step", "boot_attempts"):
        if not isinstance(data.get(field), int) or isinstance(data.get(field), bool):
            return False
    pending = data.get("pending_live")
    if pending is not None and not isinstance(pending, dict):
        return False
    claims = data.get("claims")
    if not isinstance(claims, dict) or not all(
            isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("block"), str)
            and isinstance(v.get("ids"), list) and all(isinstance(i, str) for i in v["ids"])
            for k, v in claims.items()):
        return False
    entries = data.get("boot_entries")
    if entries is not None and not (isinstance(entries, list) and all(
            isinstance(e, list) and len(e) == 3 and all(isinstance(x, str) for x in e)
            for e in entries)):
        return False
    return all(
        isinstance(data.get(f), list) and all(isinstance(i, str) for i in data[f])
        for f in _LIST_FIELDS
    )


def load_store(wdir, session_id):
    """The session's store, or None when missing, unreadable or invalid."""
    try:
        with open(session_path(wdir, session_id), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if _valid_store(data, session_id) else None


_atomic_write = ct_hook_store.atomic_write


def save_store(wdir, session_id, store):
    store["updated"] = time.time()
    _atomic_write(session_path(wdir, session_id), store)


locked = ct_hook_store.locked


def prune(wdir, now=None, max_age=STORE_MAX_AGE):
    """Remove session stores not touched in max_age (lock files are kept:
    see ct_hook_store)."""
    ct_hook_store.prune(_sessions_dir(wdir), now=now, max_age=max_age)


# ---------------------------------------------------------------------------
# persisted breaker and ct cache (spec D9) — each hook is its own process
# ---------------------------------------------------------------------------


PersistedBreaker = ct_hook_store.PersistedBreaker


def breaker_for(wdir):
    return PersistedBreaker(os.path.join(wdir, "breaker.json"))


def _ct_cache_path(wdir):
    return os.path.join(wdir, "ct.json")


def _file_sig(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return [st.st_size, int(st.st_mtime)]


def discovery_key(view):
    """A digest of what `ct` discovery depends on (PATH, and HOME /
    USERPROFILE / LOCALAPPDATA for the fallback candidates), so a cache
    written under one view is never trusted under another."""
    parts = [view.get(k) or "" for k in ("PATH", "HOME", "USERPROFILE", "LOCALAPPDATA")]
    return hashlib.sha256("\0".join(parts).encode("utf-8", "replace")).hexdigest()


def read_ct_cache(wdir, view, now=None):
    """(path, capable) from a fresh cache written under this discovery view
    whose binary is unchanged, else None."""
    now = time.time() if now is None else now
    try:
        with open(_ct_cache_path(wdir), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    path, sig, capable, at = data.get("path"), data.get("sig"), data.get("capable"), data.get("at")
    if not isinstance(path, str) or not isinstance(capable, bool) or not isinstance(at, (int, float)):
        return None
    if data.get("view") != discovery_key(view):
        return None
    if now - at > CT_CACHE_MAX_AGE or sig != _file_sig(path):
        return None
    return path, capable


def write_ct_cache(wdir, view, path, capable):
    try:
        _atomic_write(_ct_cache_path(wdir), {
            "path": path, "sig": _file_sig(path), "capable": bool(capable), "at": time.time(),
            "view": discovery_key(view)})
    except OSError:
        pass


def drop_ct_cache(wdir):
    try:
        os.remove(_ct_cache_path(wdir))
    except OSError:
        pass


def find_ct(wdir, view, need_match):
    """(path, failure_class). With need_match, `ct wisdom match` must exist."""
    cached = read_ct_cache(wdir, view)
    if cached is not None:
        path, capable = cached
        if not need_match or capable:
            return path, None
        return None, "capability_missing"
    path, dclass = ct_wisdom.discover_ct(env=view)
    if path is None:
        return None, dclass or "discovery_miss"
    capable = ct_wisdom_live.has_match_capability(path)
    if capable is not None:
        write_ct_cache(wdir, view, path, capable)
    if not need_match:
        return path, None
    if not capable:
        return None, "probe_timeout" if capable is None else "capability_missing"
    return path, None


def _after_ct_failure(wdir, rclass, breaker):
    if rclass in ("timeout", "exit"):
        breaker.record_failure()
    elif rclass == "spawn":
        drop_ct_cache(wdir)
        ct_wisdom.reset_discovery_cache()
        ct_wisdom_live.reset_capability_cache()


# ---------------------------------------------------------------------------
# verbose seams
# ---------------------------------------------------------------------------


def _record(kind, view, event):
    try:
        event = dict(event, host=HOST)
        if kind == "delivery":
            ct_wisdom_verbose.record_delivery(event, env=verbose_env(view))
        else:
            ct_wisdom_verbose.record_non_delivery(event, env=verbose_env(view))
    except Exception:  # pragma: no cover - the recorder never raises
        pass


def _skip(view, session_id, failure_class, channel=None, record=False, **detail):
    logger.debug("wisdom-da: skip session=%s class=%s", session_id or "<empty>", failure_class)
    if record:
        _record("skip", view, dict(detail, channel=channel, session_id=session_id,
                                   reason=failure_class))
    return None


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------


def _one_line(value):
    return ct_wisdom._sanitize(value).strip().replace("\n", " ").replace("\r", " ")


def render_deferred_block(entries, corrections, ledger):
    """The per-message block for a tool result: the shared live renderer
    (ct_wisdom_live.render_live_block, one budget rule for every host) with
    the marker FIRST on each fact line, so a cut can never show a fact
    without its marker. Returns (block, delivered_ids)."""
    return ct_wisdom_live.render_live_block(entries, corrections, ledger, marker_first=True)


BOOTSTRAP_TRIES = 3  # model calls a pending session retries a transient recall failure


def recall_bootstrap(view, wdir, cwd):
    """The bootstrap recall: (entries, transient). `entries` is a list of
    [title, text, id] (possibly empty) when CT answered; None with
    transient=True when the failure may clear (ct_wisdom's memo rule: a
    discovery miss, a probe timeout, a recall timeout / exit / spawn and an
    open breaker are NOT final). A parse error is final (entries []).
    Timeouts and exits feed the shared breaker."""
    try:
        breaker = breaker_for(wdir)
        if breaker.is_open():
            return None, True
        path, _dclass = find_ct(wdir, view, need_match=False)
        if path is None:
            return None, True
        entries, rclass = ct_wisdom.recall_wiki(
            path, ct_wisdom.query_for({"cwd": cwd if isinstance(cwd, str) else ""}))
        if rclass is not None:
            _after_ct_failure(wdir, rclass, breaker)
            return None, True
        breaker.record_success()
        return [[e[0], e[1], e[2]] for e in (entries or [])], False
    except Exception:
        logger.debug("wisdom-da: bootstrap recall failed", exc_info=True)
        return None, True


def render_bootstrap(entries, exclude):
    """The v1 bootstrap block (Hermes render_block) from recalled entries,
    dropping the ones already in context; "" when nothing is left."""
    kept = [tuple(e) for e in entries if e[2] not in exclude]
    return ct_wisdom.render_block(kept) if kept else ""


def ensure_boot_entries(view, wdir, sid, cwd):
    """For a pending session: the cached bootstrap recall, recalling (and
    caching) it when none is stored yet. Returns (entries | None, store)."""
    store = load_store(wdir, sid)
    if store is not None and store["boot_entries"] is not None:
        return store["boot_entries"], store
    entries, transient = recall_bootstrap(view, wdir, cwd)
    with locked(session_path(wdir, sid)):
        cur = load_store(wdir, sid) or new_store(sid)
        if cur["state"] == "pending" and cur["boot_entries"] is None:
            if transient:
                cur["boot_attempts"] += 1
                if cur["boot_attempts"] >= BOOTSTRAP_TRIES:
                    cur["boot_entries"] = []  # give up: no block for this session
            else:
                cur["boot_entries"] = entries
            save_store(wdir, sid, cur)
    return cur["boot_entries"], cur


def _line_count(text):
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _fits(text):
    return (len(text.encode("utf-8")) <= RESULT_MAX_BYTES
            and _line_count(text) <= RESULT_MAX_LINES)


def _precheck(text):
    return (len(text.encode("utf-8")) <= RESULT_MAX_BYTES - PRECHECK_MARGIN_BYTES
            and _line_count(text) <= RESULT_MAX_LINES - PRECHECK_MARGIN_LINES)


# ---------------------------------------------------------------------------
# before_llm_call (spec D4, D5, D7)
# ---------------------------------------------------------------------------


def _messages_ok(messages):
    return isinstance(messages, list) and all(isinstance(m, dict) for m in messages)


def scan_messages(messages):
    """Every ct-fact id visible in the request the model is about to get."""
    out = []
    for msg in messages:
        texts = []
        if isinstance(msg.get("content"), str):
            texts.append(msg["content"])
        parts = msg.get("multi_content")
        if isinstance(parts, list):
            texts += [p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str)]
        for text in texts:
            for fid in ct_ledger.scan_ids(text) + recall_ids(text):
                if fid not in out:
                    out.append(fid)
    return out


def recall_ids(text):
    """Ids of a CT recall result the agent can see (a `curated_recall_context`
    result carries entries, not markers). Stubs are already counted by their
    note's marker."""
    if "wiki_entries" not in text or not text.lstrip().startswith("{"):
        return []
    try:
        data = json.loads(text)
    except ValueError:
        return []
    entries = data.get("wiki_entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return []
    return [e["id"] for e in entries
            if isinstance(e, dict) and ct_ledger.valid_id(e.get("id"))]


def insert_block(messages, block):
    """`messages` with the bootstrap inserted at the first extras slot (spec
    D4), or None when it is already present."""
    for msg in messages:
        if msg.get("content") == block:
            return None
    k = 0
    while k < len(messages) and messages[k].get("role") == "system":
        k += 1
    scoped = [i for i in range(k) if messages[i].get("turn_scoped")]
    if scoped:
        pos, mark = scoped[0], False
    else:
        marked = [i for i in range(k) if messages[i].get("cache_control")]
        pos, mark = (marked[-1] + 1 if marked else k), True
    msg = {"role": "system", "content": block, "turn_scoped": True}
    if mark:
        msg["cache_control"] = True
    return messages[:pos] + [msg] + messages[pos:]


def before_llm_call(payload, view):
    sid = payload.get("session_id")
    if not _nonempty(sid):
        return _skip(view, sid, "no_payload")
    wdir = wisdom_dir(view)
    messages = payload.get("messages")
    store = load_store(wdir, sid)
    if store is not None and store["state"] == "off":
        return _skip(view, sid, "delivery_off")
    if store is None or store["state"] == "pending":
        if not _messages_ok(messages):
            with locked(session_path(wdir, sid)):
                cur = load_store(wdir, sid) or new_store(sid)
                cur["state"], cur["off_reason"] = "off", "unreadable"
                save_store(wdir, sid, cur)
            return _skip(view, sid, "unreadable")
        seen = scan_messages(messages)
        prune(wdir)
        try:
            entries, store = ensure_boot_entries(view, wdir, sid, payload.get("cwd"))
            if entries is None:
                # A transient recall failure: stay pending (no block, no
                # deliveries) and retry on the next model call (spec D5).
                return _skip(view, sid, "bootstrap_retry")
            block = render_bootstrap(entries, set(seen))
            with locked(session_path(wdir, sid)):
                cur = load_store(wdir, sid) or new_store(sid)
                if cur["state"] == "off":
                    return _skip(view, sid, "delivery_off")
                if cur["state"] == "pending":
                    cur["state"] = "on"
                    note_ids(cur, "seen_ids", seen)
                    cur["bootstrap_block"] = block
                    note_ids(cur, "bootstrap_ids", ct_ledger.scan_ids(block))
                    cur["boot_entries"] = None
                cur["step"] += 1
                save_store(wdir, sid, cur)
        except LockTimeout:
            return _skip(view, sid, "lock_timeout")
        except Exception:
            # Leave the store as it is (another process may own newer state):
            # fail closed for this call only; the next call retries.
            logger.debug("wisdom-da: confirm failed", exc_info=True)
            return _skip(view, sid, "store_failed")
        store = cur
    else:
        # The stored block never changes once the session is on, so the
        # unlocked read above is enough to insert it: a lock timeout only
        # costs this call's step tick, never the block (cache-safe).
        try:
            with locked(session_path(wdir, sid)):
                cur = load_store(wdir, sid)
                if cur is not None and cur["state"] == "on":
                    cur["step"] += 1
                    save_store(wdir, sid, cur)
        except LockTimeout:
            _skip(view, sid, "lock_timeout")
    block = store["bootstrap_block"]
    if not block or not _messages_ok(messages):
        return None
    updated = insert_block(messages, block)
    if updated is None:
        return None
    return {"hook_specific_output": {"hook_event_name": "before_llm_call",
                                     "updated_messages": updated}}


# ---------------------------------------------------------------------------
# user_prompt_submit / user_followup_submit (spec D6)
# ---------------------------------------------------------------------------


def _expire_pending(view, sid, store):
    pending = store.get("pending_live")
    if isinstance(pending, dict):
        _skip(view, sid, "no_tool_call", channel="deferred", record=True,
              query=pending.get("query"), result=pending.get("result"),
              ledger=sorted(ledger_of(store)))
    store["pending_live"] = None


def prompt_query(prompt):
    """The user's own text. Docker Agent appends pasted or attached content
    as `<attached_file path="…">…</attached_file>` after the typed text
    (pkg/app/app.go:974, pkg/chat/chat.go:335 at v1.150.0). Parsing those
    blocks out is fragile (content can contain the closing tag), so this
    fails closed: only the text BEFORE the first `<attached_file` is kept,
    and "" (no query) when nothing is left."""
    head = prompt.split(_ATTACHED_TAG, 1)[0]
    return ct_wisdom_live.user_text(head)


def user_prompt_submit(payload, view):
    event = payload.get("hook_event_name")
    sid = payload.get("session_id")
    prompt = payload.get("prompt")
    channel = event or "user_prompt_submit"
    if not _nonempty(sid) or not _nonempty(prompt) or _ENVELOPE_RE.match(prompt.lstrip()):
        return _skip(view, sid, "provenance", channel=channel, record=_nonempty(sid))
    wdir = wisdom_dir(view)
    with locked(session_path(wdir, sid)):
        store = load_store(wdir, sid)
        if store is None:
            store = new_store(sid)
        if store["state"] == "off":
            return _skip(view, sid, "delivery_off", channel=channel, record=True)
        _expire_pending(view, sid, store)
        save_store(wdir, sid, store)
    breaker = breaker_for(wdir)
    if breaker.is_open():
        return _skip(view, sid, "breaker_open", channel=channel, record=True)
    query = prompt_query(prompt)
    if not query:
        return _skip(view, sid, "empty_query", channel=channel, record=True)
    # One wall budget for every ct call this hook makes, under the 10 s hook
    # timeout: a step that could not finish inside it is not started.
    deadline = _clock() + PROMPT_BUDGET
    path, fclass = find_ct(wdir, view, need_match=True)
    if path is None:
        return _skip(view, sid, fclass, channel=channel, record=True)
    exclude = exclude_of(store)
    if store["state"] == "pending":
        # The first message of a session runs before its first model call:
        # recall the bootstrap now (cached for that call) and exclude the
        # ids its block will carry, so the message's 2 slots go to new facts.
        entries = store["boot_entries"]
        # Started only when it can end in time; the match below then runs
        # only if its own timeout still fits, so the total stays <= budget.
        if entries is None and deadline - _clock() >= ct_wisdom.RECALL_TIMEOUT:
            entries, store = ensure_boot_entries(view, wdir, sid, payload.get("cwd"))
        boot = ct_ledger.scan_ids(render_bootstrap(entries or [], set(exclude)))
        exclude = (boot + exclude)[: ct_wisdom_live.EXCLUDE_MAX]
    if deadline - _clock() < ct_wisdom_live.LIVE_TIMEOUT:
        breaker.record_failure()
        return _skip(view, sid, "budget", channel=channel, record=True, query=query)
    result, rclass = ct_wisdom_live.match_wisdom(
        path, query, ct_wisdom_live.LIVE_MAX_PER_TURN, exclude)
    if rclass is not None:
        _after_ct_failure(wdir, rclass, breaker)
        return _skip(view, sid, rclass, channel=channel, record=True, query=query)
    breaker.record_success()
    transient = transient_mode(view)
    with locked(session_path(wdir, sid)):
        cur = load_store(wdir, sid)
        if cur is None or cur["state"] == "off":
            return _skip(view, sid, "store_changed", channel=channel, record=True)
        ledger = ledger_of(cur) | {e[2] for e in cur["boot_entries"] or []}
        if transient and cur["state"] == "on":
            block, delivered = ct_wisdom_live.render_live_block(
                result["entries"], result["corrections"], ledger)
            if not block:
                return _skip(view, sid, "zero_hits", channel=channel, record=True,
                             query=query, result=result, ledger=sorted(ledger))
            save_store(wdir, sid, note_ids(cur, "delivered_ids", delivered))
            _record("delivery", view, {
                "channel": channel, "session_id": sid, "query": query, "result": result,
                "ledger": sorted(ledger), "delivered": list(delivered), "block": block})
            return {"hook_specific_output": {"hook_event_name": event,
                                             "additional_context": block}}
        if not ct_wisdom_activity.render_candidates(result["entries"], result["corrections"], ledger):
            return _skip(view, sid, "zero_hits", channel="deferred", record=True,
                         query=query, result=result, ledger=sorted(ledger))
        cur["pending_live"] = {"query": query, "result": result}
        save_store(wdir, sid, cur)
    return None


# ---------------------------------------------------------------------------
# tool_response_transform (spec D6, D7, D8)
# ---------------------------------------------------------------------------


def _stub(fact_id):
    # Same stub as Hermes ct_tool_dedup (the agent still sees the hit).
    return {"id": fact_id, "in_context": True,
            "note": "already in context: ct-fact:%s" % fact_id}


def rewrite_recall(text, ledger):
    """(new_text | None, new_ids) for one CT recall JSON envelope."""
    new_ids = []
    try:
        inner = json.loads(text)
    except (ValueError, TypeError):
        return None, new_ids
    if not isinstance(inner, dict) or not isinstance(inner.get("wiki_entries"), list):
        return None, new_ids
    rewritten, stubbed = [], 0
    for entry in inner["wiki_entries"]:
        fact_id = entry.get("id") if isinstance(entry, dict) else None
        if not ct_ledger.valid_id(fact_id):
            rewritten.append(entry)
        elif fact_id in ledger:
            rewritten.append(_stub(fact_id))
            stubbed += 1
        else:
            rewritten.append(entry)
            if fact_id not in new_ids:
                new_ids.append(fact_id)
    if not stubbed:
        return None, new_ids
    inner["wiki_entries"] = rewritten
    return json.dumps(inner, ensure_ascii=False), new_ids


def _recall_dedup(payload, sid, wdir):
    response = payload.get("tool_response")
    if not isinstance(response, str) or payload.get("tool_error"):
        return None
    with locked(session_path(wdir, sid)):
        store = load_store(wdir, sid)
        if store is None or store["state"] != "on":
            return None
        updated, new_ids = rewrite_recall(response, ledger_of(store))
        if new_ids:
            save_store(wdir, sid, note_ids(store, "tool_ids", new_ids))
    if not updated:
        return None
    return {"hook_specific_output": {"hook_event_name": "tool_response_transform",
                                     "updated_tool_response": updated}}


def release_claim(view, wdir, sid, use_id):
    """The block a tool call claimed did not fit a later call of that call
    (the final result, typically): the model will not see it, so its ids
    leave the ledger again (never shown means never delivered) and the claim
    is dropped. Later calls of this tool call get nothing."""
    try:
        with locked(session_path(wdir, sid)):
            cur = load_store(wdir, sid)
            claim = cur["claims"].pop(use_id, None) if cur is not None else None
            if claim is not None:
                gone = set(claim["ids"])
                cur["delivered_ids"] = [i for i in cur["delivered_ids"] if i not in gone]
                still = ledger_of(cur)
                cur["order"] = [i for i in cur["order"] if i in still]
                save_store(wdir, sid, cur)
    except LockTimeout:
        pass
    return _skip(view, sid, "near_limit")


def tool_response_transform(payload, view):
    sid = payload.get("session_id")
    if not _nonempty(sid):
        return _skip(view, sid, "no_payload")
    wdir = wisdom_dir(view)
    name, category = payload.get("tool_name"), payload.get("tool_category")
    if da_activity.is_ct_tool(name, category):
        if da_activity.is_recall_tool(name, category):
            return _recall_dedup(payload, sid, wdir)
        return _skip(view, sid, "ct_tool")
    response = payload.get("tool_response")
    if payload.get("tool_error"):
        return _skip(view, sid, "tool_error")
    if not isinstance(response, str) or ct_wisdom_activity._splice_mode(response) is None:
        return _skip(view, sid, "unsupported_result")
    store = load_store(wdir, sid)
    if store is None or store["state"] != "on":
        return _skip(view, sid, "no_store" if store is None else store["state"])
    use_id = payload.get("tool_use_id")
    use_id = use_id if _nonempty(use_id) else None
    if use_id is not None and use_id in store["claims"]:
        # A later call for the same tool call (a streamed shell chunk, then
        # the final result): the same block again, no new claim (P16).
        claim = store["claims"][use_id]
        replay = ct_wisdom_activity.splice(response, claim["block"])
        if replay is None or not _fits(replay):
            return release_claim(view, wdir, sid, use_id)
        return {"hook_specific_output": {"hook_event_name": "tool_response_transform",
                                         "updated_tool_response": replay}}
    if not _precheck(response):
        return _skip(view, sid, "near_limit")
    args = payload.get("tool_input")
    activity = da_activity.activity_for(name, args if isinstance(args, dict) else None,
                                        payload.get("cwd"), view)
    if activity is not None and not da_activity.query_for(activity):
        activity = None
    breaker = breaker_for(wdir)

    # Phase A (locked): claim the pending per-message result and this step's
    # activity slot. The lock is never held across a ct call.
    live = None
    run_activity = False
    with locked(session_path(wdir, sid)):
        cur = load_store(wdir, sid)
        if cur is None or cur["state"] != "on":
            return _skip(view, sid, "store_changed")
        changed = False
        if isinstance(cur.get("pending_live"), dict):
            live = cur["pending_live"]
            cur["pending_live"] = None
            changed = True
        if activity is not None:
            key = json.dumps(list(activity.key))
            if cur["activity_step"] == cur["step"]:
                _skip(view, sid, "step_used")
            elif key in cur["recent_keys"]:
                _skip(view, sid, "seen_key")
            elif breaker.is_open():
                _skip(view, sid, "breaker_open", channel="activity", record=True,
                      query=da_activity.query_for(activity), activity=activity.line)
            else:
                cur["activity_step"] = cur["step"]
                cur["recent_keys"] = (cur["recent_keys"] + [key])[-RECENT_KEYS_MAX:]
                run_activity = changed = True
        if changed:
            save_store(wdir, sid, cur)
        exclude = exclude_of(cur)

    # Phase B: the activity's CT call, outside the lock.
    act_result = None
    query = da_activity.query_for(activity) if run_activity else None
    act_base = {"query": query, "activity": activity.line} if run_activity else {}
    if run_activity:
        path, fclass = find_ct(wdir, view, need_match=True)
        if path is None:
            _skip(view, sid, fclass, channel="activity", record=True, **act_base)
        else:
            act_result, rclass = ct_wisdom_live.match_wisdom(
                path, query, ct_wisdom_activity.ACTIVITY_MAX_PER_STEP, exclude)
            if rclass is not None:
                _after_ct_failure(wdir, rclass, breaker)
                _skip(view, sid, rclass, channel="activity", record=True, **act_base)
                act_result = None
            else:
                breaker.record_success()
    if live is None and act_result is None:
        return None

    # Phase C (locked): render against the ledger as it is NOW, record the
    # ids, write, and only then emit (at-most-once).
    with locked(session_path(wdir, sid)):
        cur = load_store(wdir, sid)
        if cur is None or cur["state"] != "on":
            return _skip(view, sid, "store_changed")
        ledger = ledger_of(cur)
        parts, events = [], []  # parts: (ids, block, delivery event); deferred first
        if live is not None:
            result = live.get("result") if isinstance(live.get("result"), dict) else {}
            block, delivered = render_deferred_block(
                result.get("entries") or [], result.get("corrections") or [], ledger)
            if block:
                parts.append((delivered, block, {
                    "channel": "deferred", "session_id": sid, "query": live.get("query"),
                    "result": result, "ledger": sorted(ledger), "delivered": delivered,
                    "block": block, "tool_name": name}))
            else:
                events.append(("skip", {"channel": "deferred", "session_id": sid,
                                        "query": live.get("query"), "result": result,
                                        "ledger": sorted(ledger), "reason": "zero_hits"}))
        if act_result is not None:
            taken = ledger | {i for p in parts for i in p[0]}
            chosen = None
            for item, superseded in ct_wisdom_activity.render_candidates(
                    act_result["entries"], act_result["corrections"], taken):
                block = ct_wisdom_activity.render_activity_block(item, superseded, activity)
                if block:
                    chosen = (item, block)
                    break
            if chosen is not None:
                parts.append(([chosen[0]["id"]], chosen[1], dict(
                    act_base, channel="activity", session_id=sid, result=act_result,
                    ledger=sorted(taken), delivered=[chosen[0]["id"]], block=chosen[1],
                    tool_name=name)))
            else:
                events.append(("skip", dict(act_base, channel="activity", session_id=sid,
                                            result=act_result, ledger=sorted(taken),
                                            reason="zero_hits")))
        # All of it if it fits under the limiter; else the deferred block
        # alone (it has priority); else nothing.
        out, used = None, []
        options = [parts] + ([parts[:1]] if live is not None and len(parts) > 1 else [])
        for option in options if parts else []:
            candidate = ct_wisdom_activity.splice(response, "\n\n".join(p[1] for p in option))
            if candidate is not None and _fits(candidate):
                out, used = candidate, option
                break
        for part in parts:
            if part in used:
                note_ids(cur, "delivered_ids", part[0])
                events.append(("delivery", part[2]))
            else:
                events.append(("skip", dict(part[2], reason="near_limit")))
        # Unused parts are not recorded as delivered, but the claimed pending
        # result and step slot stay spent (at-most-once).
        if out is not None:
            if use_id is not None:
                cur["claims"][use_id] = {
                    "block": "\n\n".join(p[1] for p in used),
                    "ids": [i for p in used for i in p[0]]}
                while len(cur["claims"]) > CLAIMS_MAX:
                    cur["claims"].pop(next(iter(cur["claims"])))
            save_store(wdir, sid, cur)
    for kind, event in events:
        _record(kind, view, event)
    if not out:
        return None
    return {"hook_specific_output": {"hook_event_name": "tool_response_transform",
                                     "updated_tool_response": out}}


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

_HANDLERS = {
    "before_llm_call": before_llm_call,
    "user_prompt_submit": user_prompt_submit,
    "user_followup_submit": user_prompt_submit,
    "tool_response_transform": tool_response_transform,
}


def handle(payload, env=None):
    """Dispatch one hook payload; returns the output dict or None. Never raises."""
    try:
        view = env_view(env)
        if in_sandbox(view) or not isinstance(payload, dict):
            return None
        handler = _HANDLERS.get(payload.get("hook_event_name"))
        if handler is None:
            return None
        return handler(payload, view)
    except Exception:
        logger.debug("wisdom-da: hook failed", exc_info=True)
        return None


def respond(payload, env=None):
    """handle() plus verbose mode: the notices the recorder produced become
    the top-level `system_message`, which Docker Agent shows as a warning and
    never adds to the session (spec D10). `hook_specific_output` is never
    touched. Never raises."""
    notices = []
    previous = ct_wisdom_verbose.set_sink(notices.append)
    try:
        directive = handle(payload, env)
    finally:
        ct_wisdom_verbose.set_sink(previous)
    if not notices:
        return directive
    try:
        return dict(directive or {}, system_message="\n\n".join(notices))
    except Exception:
        return directive


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        return
    try:
        payload = json.loads(raw) if raw.strip() else None
    except Exception:
        return
    directive = respond(payload)
    if directive:
        try:
            sys.stdout.write(json.dumps(directive, ensure_ascii=False))
            sys.stdout.flush()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        pass
    os._exit(0)

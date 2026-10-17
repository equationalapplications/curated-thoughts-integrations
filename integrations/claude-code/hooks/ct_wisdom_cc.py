#!/usr/bin/env python3
"""ct_wisdom_cc.py — Intuitive Wisdom live delivery for Claude Code.

Spec: docs/superpowers/specs/2026-10-16-claude-code-wisdom-parity-leg-design.md
(parent: 2026-10-09-cross-harness-wisdom-parity-design.md, decision 4, annex A).

The algorithm is the Hermes reference, run from the byte-identical copies in
../scripts/ (ct_ledger, ct_wisdom, ct_wisdom_live — kept identical by
tests/tools/test_shared_script_parity.py). This module is only the Claude
Code adapter:

  * SessionStart     -> bootstrap block + per-session store rules (D7)
  * UserPromptSubmit -> one live block per genuine main-thread user turn,
                        as hookSpecificOutput.additionalContext (D5, D6, D8)
  * PostToolUse      -> dedup stubs inside `*__curated_recall_context`
                        results, via hookSpecificOutput.updatedToolOutput (D9);
                        in a subagent the recall ids are recorded, never
                        stubbed. For the activity tools: the executed record
  * PostToolUseFailure -> the executed record (a call that ran and failed)
  * PostToolBatch    -> autonomous-work delivery: one activity fact per model
                        step, as hookSpecificOutput.additionalContext (spec
                        2026-10-17-claude-code-autonomous-work-wisdom-design.md)

The ledger is ONLY the ${CLAUDE_PLUGIN_DATA} store keyed by session_id (D3),
shared by the main thread and its subagents (they carry the parent's
session_id): the session transcript is never opened. Every unclear state
fails closed — no store, a corrupt store, a resumed/forked session, unclear
prompt provenance, a call with no executed record — and costs at most a
missed delivery, never a duplicate. Stdlib only; every public entry point is
non-raising; the hook process always exits 0.

Run by hooks/hooks.json as `python3 ct_wisdom_cc.py` with the hook payload on
stdin; imported by hooks/session-start.py for the bootstrap.
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

# Same self-location rule as session-start.py: never read CLAUDE_PLUGIN_ROOT.
_HOOKS = Path(__file__).resolve().parent
_SCRIPTS = _HOOKS.parent / "scripts"
for _p in (str(_SCRIPTS), str(_HOOKS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ct_hook_store  # noqa: E402
import ct_env  # noqa: E402
import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_activity  # noqa: E402
import ct_wisdom_cc_activity as cc_activity  # noqa: E402
import ct_wisdom_live  # noqa: E402
import ct_wisdom_verbose  # noqa: E402


logger = logging.getLogger(__name__)

HOST = "claude-code"
STORE_VERSION = 1
DATA_ENV = "CLAUDE_PLUGIN_DATA"
LOCK_WAIT = ct_hook_store.LOCK_WAIT
STORE_MAX_AGE = ct_hook_store.STORE_MAX_AGE
RECALL_TOOL_SUFFIX = "__curated_recall_context"

# Autonomous-work delivery (spec 2026-10-17, D3, D5, D10).
ACTIVITY_TOOLS = cc_activity.ACTIVITY_TOOLS
ACTIVITY_CT_BUDGET = 9.0  # seconds of ct time per PostToolBatch (hook timeout 15 s)
EXECUTED_MAX = 256        # executed tool_use_ids kept per session
AGENTS_MAX = 128          # agents (main thread "" + subagents) tracked per session
EVICTED_MAX = 1024        # subagent ids whose tracking was evicted (stub-everything rule)
RECENT_KEYS_MAX = ct_wisdom_activity.RECENT_KEYS_MAX
CT_CACHE_MAX_AGE = 86400
_USE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_clock = time.monotonic

# A harness envelope (`<agent-message from=…>`, `<task-notification>`, …) at
# the very start of the prompt means the text was not typed by the user (D5).
_ENVELOPE_RE = re.compile(r"^<[A-Za-z][A-Za-z0-9_-]*(?=[\s>/])")
_LIST_FIELDS = ("bootstrap_ids", "live_ids", "tool_ids", "order", "activity_ids", "executed",
                "evicted_agents")
# Fields added in 0.4.0; a 0.3.x store (same `v`) loads with these defaults,
# its ledger being exact without them (spec D9).
_NEW_FIELDS = {"activity_ids": list, "executed": list, "agents": dict, "evicted_agents": list}


LockTimeout = ct_hook_store.LockTimeout


# ---------------------------------------------------------------------------
# store (D3)
# ---------------------------------------------------------------------------


def data_dir(view):
    """The plugin data dir from an env view, or None when unset/empty."""
    value = view.get(DATA_ENV) if hasattr(view, "get") else None
    return value if isinstance(value, str) and value.strip() else None


session_key = ct_hook_store.session_key


def _sessions_dir(ddir):
    return os.path.join(ddir, "wisdom", "sessions")


def session_path(ddir, session_id):
    return os.path.join(_sessions_dir(ddir), session_key(session_id) + ".json")


def breaker_path(ddir):
    return os.path.join(ddir, "wisdom", "breaker.json")


def new_store(session_id, state, block, boot_ids, off_reason=None):
    store = {
        "v": STORE_VERSION,
        "session_id": session_id,
        "state": state,
        "off_reason": off_reason,
        "bootstrap_block": block or "",
        "bootstrap_ids": [],
        "live_ids": [],
        "tool_ids": [],
        "order": [],
        # Autonomous-work delivery (spec 2026-10-17): the facts delivered to
        # a step, the tool calls that really ran (D3), and per agent ("" =
        # the main thread) its recent activity keys (D5) and the ids in its
        # own context (D8); subagents whose entry was evicted.
        "activity_ids": [],
        "executed": [],
        "agents": {},
        "evicted_agents": [],
        "updated": time.time(),
    }
    return note_ids(store, "bootstrap_ids", boot_ids)


def note_ids(store, field, ids):
    """Append valid, not-yet-listed ids to store[field] and to store['order']."""
    for fid in ids:
        if ct_ledger.valid_id(fid) and fid not in store[field]:
            store[field].append(fid)
            store["order"].append(fid)
    return store


def ledger_of(store):
    return (set(store["bootstrap_ids"]) | set(store["live_ids"]) | set(store["tool_ids"])
            | set(store["activity_ids"]))


def agent_entry(store, agent):
    """The tracking entry of `agent` ("" = main thread), created on first use
    and moved to the LRU end. An evicted subagent's id is remembered, so its
    later recall results are stubbed against the whole ledger (D8)."""
    entry = store["agents"].pop(agent, None) or {"keys": [], "ids": []}
    store["agents"][agent] = entry
    while len(store["agents"]) > AGENTS_MAX:
        oldest = next(k for k in store["agents"] if k != "")
        store["agents"].pop(oldest)
        store["evicted_agents"] = (store["evicted_agents"] + [oldest])[-EVICTED_MAX:]
    return entry


def note_agent_ids(store, agent, ids):
    entry = agent_entry(store, agent)
    for fid in ids:
        if ct_ledger.valid_id(fid) and fid not in entry["ids"]:
            entry["ids"].append(fid)


def context_ids(store, agent):
    """The ids that can be in `agent`'s OWN context (what its recall results
    are stubbed against). The session ledger is shared by the tree, so a
    delivery is never repeated anywhere in it; but a subagent cannot see the
    main thread's facts, nor the main thread a subagent's, so a stub there
    would hide a fact. Main thread: the ledger minus ids only subagents got.
    A subagent: its own ids; an evicted one: the whole ledger (safe side)."""
    ledger = ledger_of(store)
    if agent == "":
        main = store["agents"].get("")
        own = set(main["ids"]) if main else set()
        own |= set(store["bootstrap_ids"]) | set(store["live_ids"])
        sub_only = set()
        for key, entry in store["agents"].items():
            if key != "":
                sub_only |= set(entry["ids"])
        return ledger - (sub_only - own)
    if agent in store["agents"]:
        return set(store["agents"][agent]["ids"])
    if agent in store["evicted_agents"]:
        return ledger
    return set()


def exclude_of(store):
    """Ledger ids, most recently noted first, capped at EXCLUDE_MAX (annex m8)."""
    out, seen = [], set()
    for fid in reversed(store["order"]):
        if fid not in seen:
            seen.add(fid)
            out.append(fid)
    return out[: ct_wisdom_live.EXCLUDE_MAX]


def _valid_store(data, session_id):
    if not isinstance(data, dict) or data.get("v") != STORE_VERSION:
        return False
    if data.get("session_id") != session_id or data.get("state") not in ("on", "off"):
        return False
    if not isinstance(data.get("bootstrap_block"), str):
        return False
    agents = data.get("agents")
    if not isinstance(agents, dict) or not all(
            isinstance(k, str) and isinstance(v, dict)
            and all(isinstance(v.get(f), list) and all(isinstance(x, str) for x in v[f])
                    for f in ("keys", "ids"))
            for k, v in agents.items()):
        return False
    return all(
        isinstance(data.get(f), list) and all(isinstance(i, str) for i in data[f])
        for f in _LIST_FIELDS
    )


def load_store(ddir, session_id):
    """The session's store, or None when missing, unreadable or invalid."""
    try:
        with open(session_path(ddir, session_id), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if isinstance(data, dict):
        for field, kind in _NEW_FIELDS.items():
            if field not in data:
                data[field] = kind()
    return data if _valid_store(data, session_id) else None


_atomic_write = ct_hook_store.atomic_write


def save_store(ddir, session_id, store):
    store["updated"] = time.time()
    _atomic_write(session_path(ddir, session_id), store)


def _forget(ddir, session_id):
    """Last-resort fail-closed: a store we could not latch OFF is removed."""
    try:
        os.remove(session_path(ddir, session_id))
    except OSError:
        pass


locked = ct_hook_store.locked


def prune(ddir, now=None, max_age=STORE_MAX_AGE):
    """Remove session stores not touched in max_age (lock files are kept:
    see ct_hook_store)."""
    ct_hook_store.prune(_sessions_dir(ddir), now=now, max_age=max_age)


# ---------------------------------------------------------------------------
# persisted breaker (D8) — each hook is its own process
# ---------------------------------------------------------------------------


PersistedBreaker = ct_hook_store.PersistedBreaker


# ---------------------------------------------------------------------------
# provenance (D5) + main thread (D6)
# ---------------------------------------------------------------------------


def _nonempty_str(value):
    return isinstance(value, str) and bool(value.strip())


def _in_subagent(payload):
    return _nonempty_str(payload.get("agent_id"))


def is_genuine_user_turn(payload):
    """True only when the payload proves a main-thread, user-typed prompt."""
    if not isinstance(payload, dict):
        return False
    if payload.get("hook_event_name") != "UserPromptSubmit":
        return False
    if not _nonempty_str(payload.get("session_id")) or not _nonempty_str(payload.get("prompt_id")):
        return False
    if _in_subagent(payload):
        return False
    prompt = payload.get("prompt")
    if not _nonempty_str(prompt):
        return False
    return _ENVELOPE_RE.match(prompt.lstrip()) is None


def _skip(session_id, failure_class, env=None, **detail):
    logger.debug("wisdom-cc: skip session=%s class=%s", session_id or "<empty>", failure_class)
    ct_wisdom_verbose.record_non_delivery(dict(detail, host="claude-code", channel="UserPromptSubmit", session_id=session_id, reason=failure_class), env=ct_env.merged_env(env))
    return None


# ---------------------------------------------------------------------------
# SessionStart (D7)
# ---------------------------------------------------------------------------


def render_bootstrap(view, cwd):
    """The v1 bootstrap block (Hermes render_block, `ct-fact:` markers on
    titles) for this session, or "" on any failure class."""
    try:
        path, _dclass = ct_wisdom.discover_ct(env=view)
        if path is None:
            return ""
        entries, rclass = ct_wisdom.recall_wiki(
            path, ct_wisdom.query_for({"cwd": cwd if isinstance(cwd, str) else ""})
        )
        if rclass == "spawn":
            ct_wisdom.reset_discovery_cache()
        if rclass is not None or not entries:
            return ""
        return ct_wisdom.render_block(entries)
    except Exception:
        logger.debug("wisdom-cc: bootstrap render failed", exc_info=True)
        return ""


def session_start(payload, env=None, render=None):
    """Apply the SessionStart source rules; return the bootstrap text to
    append after the status section ("" for none). Never raises."""
    try:
        return _session_start(payload, env, render)
    except Exception:
        logger.debug("wisdom-cc: session start failed", exc_info=True)
        return ""


def _session_start(payload, env, render):
    if not isinstance(payload, dict):
        return ""
    sid = payload.get("session_id")
    if not _nonempty_str(sid):
        return ""
    view = ct_env.merged_env(env)
    source = payload.get("source")
    rendered = []

    def block():
        if not rendered:
            fn = render or (lambda: render_bootstrap(view, payload.get("cwd")))
            text = fn()
            rendered.append(text if isinstance(text, str) else "")
        return rendered[0]

    ddir = data_dir(view)
    if ddir is None:
        # No store: the block still renders; live delivery stays off because
        # every later trigger finds no store.
        return block()
    store = load_store(ddir, sid)

    if source == "compact":
        # The store survives compaction (D7): delivery continues and the
        # stored block is replayed byte-identically — the original went out
        # with the pre-boundary history. No store: render, record nothing.
        return store["bootstrap_block"] if store is not None else block()

    try:
        if source == "startup" or (source == "clear" and store is None):
            text = block()
            new = new_store(sid, "on", text, ct_ledger.scan_ids(text))
            with locked(session_path(ddir, sid)):
                save_store(ddir, sid, new)
            prune(ddir)
            return text
        if source == "resume" and store is not None:
            # The original block is in the replayed transcript (F7): do not
            # emit it again. OFF for life; there is no re-arm path.
            with locked(session_path(ddir, sid)):
                current = load_store(ddir, sid) or store
                if current["state"] != "off":
                    current["state"] = "off"
                    current["off_reason"] = "resume"
                save_store(ddir, sid, current)
            return ""
        if source == "clear":
            reason = "clear_same_id"
        elif source == "resume":
            reason = "resume"
        elif source == "fork":
            reason = "fork"
        else:
            reason = "unknown_source"
        text = block()
        with locked(session_path(ddir, sid)):
            current = load_store(ddir, sid)
            if current is None:
                current = new_store(sid, "off", text, ct_ledger.scan_ids(text), off_reason=reason)
            else:
                if current["state"] != "off":
                    current["state"] = "off"
                    current["off_reason"] = reason
                current["bootstrap_block"] = text
                note_ids(current, "bootstrap_ids", ct_ledger.scan_ids(text))
            save_store(ddir, sid, current)
        return text
    except Exception:
        # Could not record the rule: remove the store so every later trigger
        # fails closed instead of trusting a stale ON record.
        logger.debug("wisdom-cc: store update failed", exc_info=True)
        _forget(ddir, sid)
        return block()


# ---------------------------------------------------------------------------
# UserPromptSubmit (D8)
# ---------------------------------------------------------------------------


def user_prompt_submit(payload, env=None):
    """Return the UserPromptSubmit directive, or None to inject nothing."""
    try:
        return _user_prompt_submit(payload, env)
    except Exception:
        logger.debug("wisdom-cc: live hook failed", exc_info=True)
        return None


def _user_prompt_submit(payload, env):
    if not is_genuine_user_turn(payload):
        return _skip(payload.get("session_id") if isinstance(payload, dict) else None, "provenance", env)
    sid = payload["session_id"]
    view = ct_env.merged_env(env)
    ddir = data_dir(view)
    if ddir is None:
        return _skip(sid, "no_data_dir", env)
    store = load_store(ddir, sid)
    if store is None:
        return _skip(sid, "no_store", env)
    if store["state"] != "on":  # latching OFF switch, before anything else
        return _skip(sid, "delivery_off", env)
    breaker = PersistedBreaker(breaker_path(ddir))
    if breaker.is_open():
        return _skip(sid, "breaker_open", env)
    query = ct_wisdom_live.user_text(payload["prompt"])
    if not query:
        return _skip(sid, "empty_query", env)
    path, dclass = ct_wisdom.discover_ct(env=view)
    if path is None:
        return _skip(sid, dclass or "discovery_miss", env)
    capable = ct_wisdom_live.has_match_capability(path)
    if not capable:
        return _skip(sid, "probe_timeout" if capable is None else "capability_missing", env)

    result, rclass = ct_wisdom_live.match_wisdom(
        path, query, ct_wisdom_live.LIVE_MAX_PER_TURN, exclude_of(store)
    )
    if rclass is not None:
        if rclass in ("timeout", "exit"):
            breaker.record_failure()
        elif rclass == "spawn":
            ct_wisdom.reset_discovery_cache()
            ct_wisdom_live.reset_capability_cache()
        return _skip(sid, rclass, env)
    breaker.record_success()

    # Re-read under the lock: a parallel PostToolUse may have noted ids while
    # `ct wisdom match` ran; the post-filter must see them. The store is
    # written BEFORE the block is emitted (D4: at-most-once).
    with locked(session_path(ddir, sid)):
        current = load_store(ddir, sid)
        if current is None or current["state"] != "on":
            return _skip(sid, "store_changed", env)
        block, delivered = ct_wisdom_live.render_live_block(
            result["entries"], result["corrections"], ledger_of(current)
        )
        if not block:
            return _skip(sid, "zero_hits", env, query=query, result=result, ledger=ledger_of(current))
        save_store(ddir, sid, note_ids(current, "live_ids", delivered))
    logger.debug("wisdom-cc: deliver session=%s ids=%s", sid, ",".join(delivered))
    ct_wisdom_verbose.record_delivery({"host": "claude-code", "channel": "UserPromptSubmit", "session_id": sid, "query": query, "result": result, "ledger": ledger_of(current) - set(delivered), "delivered": list(delivered), "block": block}, env=view)
    return {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                   "additionalContext": block}}


# ---------------------------------------------------------------------------
# PostToolUse (D9)
# ---------------------------------------------------------------------------


def _stub(fact_id):
    # Same stub as Hermes ct_tool_dedup (option A: the agent still sees the hit).
    return {"id": fact_id, "in_context": True,
            "note": "already in context: ct-fact:%s" % fact_id}


def _rewrite_text(text, ledger, new_ids):
    """Rewrite one CT recall JSON text; returns (new_text | None, stubbed)."""
    try:
        inner = json.loads(text)
    except ValueError:
        return None, 0
    if not isinstance(inner, dict) or not isinstance(inner.get("wiki_entries"), list):
        return None, 0
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
        return None, 0
    inner["wiki_entries"] = rewritten
    return json.dumps(inner, ensure_ascii=False), stubbed


def _rewrite_blocks(blocks, ledger, new_ids):
    out, stubbed = [], 0
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            text, count = _rewrite_text(block["text"], ledger, new_ids)
            if text is not None:
                block = dict(block, text=text)
                stubbed += count
        out.append(block)
    return out, stubbed


def rewrite_response(response, ledger):
    """(updated_response | None, new_ids). The response keeps its shape: the
    MCP content-block list (observed, F8) or a dict with a `content` list."""
    new_ids = []
    if isinstance(response, list):
        blocks, stubbed = _rewrite_blocks(response, ledger, new_ids)
        return (blocks if stubbed else None), new_ids
    if isinstance(response, dict) and isinstance(response.get("content"), list):
        blocks, stubbed = _rewrite_blocks(response["content"], ledger, new_ids)
        return (dict(response, content=blocks) if stubbed else None), new_ids
    return None, new_ids


def is_recall_tool(tool_name):
    return (isinstance(tool_name, str) and tool_name.startswith("mcp__")
            and tool_name.endswith(RECALL_TOOL_SUFFIX))


def post_tool_use(payload, env=None):
    """Return the PostToolUse directive, or None to leave the output as is."""
    try:
        return _post_tool_use(payload, env)
    except Exception:
        logger.debug("wisdom-cc: tool dedup failed", exc_info=True)
        return None


def _post_tool_use(payload, env):
    if not isinstance(payload, dict):
        return None
    if payload.get("tool_name") in ACTIVITY_TOOLS:
        return record_executed(payload, env)
    if not is_recall_tool(payload.get("tool_name")):
        return None
    sid = payload.get("session_id")
    if not _nonempty_str(sid):
        return None
    ddir = data_dir(ct_env.merged_env(env))
    if ddir is None:
        return None
    agent = payload.get("agent_id") if _in_subagent(payload) else ""
    with locked(session_path(ddir, sid)):
        store = load_store(ddir, sid)
        if store is None or store["state"] != "on":
            return None
        # Stub only what is in THIS agent's own context; record every new id
        # in the shared ledger and in the agent's context (spec 2026-10-17 D8).
        updated, new_ids = rewrite_response(payload.get("tool_response"),
                                            context_ids(store, agent))
        if new_ids:
            note_ids(store, "tool_ids", new_ids)
            note_agent_ids(store, agent, new_ids)
            save_store(ddir, sid, store)
    if updated is None:
        return None
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                   "updatedToolOutput": updated}}


# ---------------------------------------------------------------------------
# executed record (spec 2026-10-17 D3)
# ---------------------------------------------------------------------------


def record_executed(payload, env=None):
    """PostToolUse / PostToolUseFailure of an activity tool: remember that
    this tool_use_id really ran (a denied call fires neither event, H3).
    Emits nothing; never raises."""
    try:
        sid, use_id = payload.get("session_id"), payload.get("tool_use_id")
        if not _nonempty_str(sid) or not isinstance(use_id, str) or not _USE_ID_RE.match(use_id):
            return None
        if payload.get("tool_name") not in ACTIVITY_TOOLS:
            return None
        ddir = data_dir(ct_env.merged_env(env))
        if ddir is None:
            return None
        with locked(session_path(ddir, sid)):
            store = load_store(ddir, sid)
            if store is None or store["state"] != "on" or use_id in store["executed"]:
                return None
            store["executed"] = (store["executed"] + [use_id])[-EXECUTED_MAX:]
            save_store(ddir, sid, store)
    except Exception:
        logger.debug("wisdom-cc: executed record failed", exc_info=True)
    return None


# ---------------------------------------------------------------------------
# ct cache (spec 2026-10-17 D10; the Docker Agent rule) — every hook is a
# fresh process, so the accepted ct path and its capability are persisted
# ---------------------------------------------------------------------------


def _ct_cache_path(wdir):
    return os.path.join(wdir, "ct.json")


def _file_sig(path):
    try:
        st = os.stat(path)
    except (OSError, TypeError, ValueError):
        return None
    return [st.st_size, int(st.st_mtime)]


def discovery_key(view):
    """A digest of what `ct` discovery depends on, so a cache written under
    one environment view is never trusted under another."""
    parts = [view.get(k) or "" for k in ("PATH", "HOME", "USERPROFILE", "LOCALAPPDATA")]
    return hashlib.sha256("\0".join(parts).encode("utf-8", "replace")).hexdigest()


def read_ct_cache(wdir, view, now=None):
    """(path, capable) from a fresh cache written under this view whose
    binary still exists unchanged, else None."""
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
    if data.get("view") != discovery_key(view) or now - at > CT_CACHE_MAX_AGE:
        return None
    current = _file_sig(path)
    if current is None or sig != current:
        return None
    return path, capable


def write_ct_cache(wdir, view, path, capable):
    sig = _file_sig(path)
    if sig is None:
        return
    try:
        _atomic_write(_ct_cache_path(wdir), {"path": path, "sig": sig, "capable": bool(capable),
                                             "at": time.time(), "view": discovery_key(view)})
    except OSError:
        pass


def drop_ct_cache(wdir):
    try:
        os.remove(_ct_cache_path(wdir))
    except OSError:
        pass


def find_ct(wdir, view, deadline):
    """(path, failure_class): a `ct` with `wisdom match`, from the cache or
    discovered and probed (each probe started only while it fits before
    `deadline`)."""
    cached = read_ct_cache(wdir, view)
    if cached is not None:
        return (cached[0], None) if cached[1] else (None, "capability_missing")
    if deadline - _clock() < ct_wisdom.PROBE_TIMEOUT:
        return None, "budget"
    path, dclass = ct_wisdom.discover_ct(env=view)
    if path is None:
        return None, dclass or "discovery_miss"
    if deadline - _clock() < ct_wisdom.PROBE_TIMEOUT:
        return None, "budget"
    capable = ct_wisdom_live.has_match_capability(path)
    if capable is not None:
        write_ct_cache(wdir, view, path, capable)
    if not capable:
        return None, "probe_timeout" if capable is None else "capability_missing"
    return path, None


# ---------------------------------------------------------------------------
# PostToolBatch: autonomous-work delivery (spec 2026-10-17)
# ---------------------------------------------------------------------------


def _wdir(ddir):
    return os.path.join(ddir, "wisdom")


def _record(kind, view, event):
    try:
        event = dict(event, host=HOST, channel="activity")
        if kind == "delivery":
            ct_wisdom_verbose.record_delivery(event, env=view)
        else:
            ct_wisdom_verbose.record_non_delivery(event, env=view)
    except Exception:  # pragma: no cover - the recorder never raises
        pass


def _act_skip(view, session_id, failure_class, record=False, **detail):
    logger.debug("wisdom-cc: activity skip session=%s class=%s",
                 session_id or "<empty>", failure_class)
    if record:
        _record("skip", view, dict(detail, session_id=session_id, reason=failure_class))
    return None


def recall_response_ids(response):
    """Valid wiki-entry ids of a CT recall result as the batch carries it
    (the serialized content: a string or MCP content blocks)."""
    texts = []
    if isinstance(response, str):
        texts.append(response)
    elif isinstance(response, list):
        texts += [b["text"] for b in response
                  if isinstance(b, dict) and isinstance(b.get("text"), str)]
    out = []
    for text in texts:
        try:
            inner = json.loads(text)
        except ValueError:
            continue
        entries = inner.get("wiki_entries") if isinstance(inner, dict) else None
        for e in entries if isinstance(entries, list) else []:
            fid = e.get("id") if isinstance(e, dict) else None
            if ct_ledger.valid_id(fid) and fid not in out:
                out.append(fid)
    return out


def _release_key(ddir, sid, agent, key):
    """A started query got no genuine answer: forget its key so a later step
    can try again (DSH final review). Never raises."""
    try:
        with locked(session_path(ddir, sid)):
            cur = load_store(ddir, sid)
            entry = cur["agents"].get(agent) if cur is not None else None
            if entry is not None and key in entry["keys"]:
                entry["keys"].remove(key)
                save_store(ddir, sid, cur)
    except Exception:
        logger.debug("wisdom-cc: key release failed", exc_info=True)


def _after_ct_failure(wdir, rclass, breaker):
    if rclass in ("timeout", "exit"):
        breaker.record_failure()
    elif rclass == "spawn":
        drop_ct_cache(wdir)
        ct_wisdom.reset_discovery_cache()
        ct_wisdom_live.reset_capability_cache()


def post_tool_batch(payload, env=None):
    """Return the PostToolBatch directive, or None to inject nothing."""
    try:
        return _post_tool_batch(payload, env)
    except Exception:
        logger.debug("wisdom-cc: activity hook failed", exc_info=True)
        return None


def _post_tool_batch(payload, env):
    sid, calls = payload.get("session_id"), payload.get("tool_calls")
    view = ct_env.merged_env(env)
    if not _nonempty_str(sid) or not isinstance(calls, list):
        return _act_skip(view, sid, "no_payload")
    ddir = data_dir(view)
    if ddir is None:
        return _act_skip(view, sid, "no_data_dir")
    store = load_store(ddir, sid)
    if store is None:
        return _act_skip(view, sid, "no_store")
    if store["state"] != "on":  # the latch (resume, fork, clear_same_id), before anything
        return _act_skip(view, sid, "delivery_off")
    agent = payload.get("agent_id") if _nonempty_str(payload.get("agent_id")) else ""
    cwd = payload.get("cwd")

    recall_ids, candidates = [], []
    for c in calls:
        if not isinstance(c, dict):
            continue
        name = c.get("tool_name")
        if cc_activity.is_ct_tool(name):  # decision 6: never a trigger
            if cc_activity.is_recall_tool(name):
                recall_ids += recall_response_ids(c.get("tool_response"))
            continue
        if name not in cc_activity.TOOL_MAP or not isinstance(c.get("tool_use_id"), str):
            continue
        args = c.get("tool_input")
        activity = cc_activity.activity_for(name, args if isinstance(args, dict) else None,
                                            cwd, view)
        if activity is not None and cc_activity.query_for(activity):
            candidates.append((c["tool_use_id"], name, activity))
    if not recall_ids and not candidates:
        return _act_skip(view, sid, "no_activity")
    breaker = PersistedBreaker(breaker_path(ddir))

    # Phase A (locked): ledger the batch's recall ids; claim this agent's key
    # for the first executed call with a new one. Never held across a ct call.
    chosen, why = None, "no_activity"
    try:
        with locked(session_path(ddir, sid)):
            cur = load_store(ddir, sid)
            if cur is None or cur["state"] != "on":
                return _act_skip(view, sid, "store_changed")
            changed = bool(recall_ids)
            note_ids(cur, "tool_ids", recall_ids)
            note_agent_ids(cur, agent, recall_ids)
            executed = set(cur["executed"])
            keys = agent_entry(cur, agent)["keys"]
            for use_id, name, activity in candidates:
                if use_id not in executed:
                    why = "not_executed" if why == "no_activity" else why
                    continue  # denied or never ran (D3)
                key = json.dumps(list(activity.key))
                if key in keys:
                    why = "seen_key"
                    continue
                chosen = (name, activity, key)
                break
            if chosen is not None and breaker.is_open():
                why = "breaker_open"
                _act_skip(view, sid, why, record=True,
                          query=cc_activity.query_for(chosen[1]), activity=chosen[1].line)
                chosen = None
            if chosen is not None:
                keys.append(chosen[2])
                del keys[:-RECENT_KEYS_MAX]
                changed = True
            if changed:
                save_store(ddir, sid, cur)
            exclude = exclude_of(cur)
    except LockTimeout:
        return _act_skip(view, sid, "lock_timeout")
    if chosen is None:
        return None if why == "breaker_open" else _act_skip(view, sid, why)
    name, activity, key = chosen
    query = cc_activity.query_for(activity)
    base = {"query": query, "activity": activity.line, "tool_name": name,
            "agent_id": agent or None}

    # Phase B: the CT call, outside the lock, inside one wall budget.
    wdir = _wdir(ddir)
    try:
        deadline = _clock() + ACTIVITY_CT_BUDGET
        path, fclass = find_ct(wdir, view, deadline)
        if path is None:
            _release_key(ddir, sid, agent, key)
            return _act_skip(view, sid, fclass, record=True, **base)
        if deadline - _clock() < ct_wisdom_live.LIVE_TIMEOUT:
            breaker.record_failure()
            _release_key(ddir, sid, agent, key)
            return _act_skip(view, sid, "budget", record=True, **base)
        result, rclass = ct_wisdom_live.match_wisdom(
            path, query, ct_wisdom_activity.ACTIVITY_MAX_PER_STEP, exclude)
        if rclass is not None:
            _after_ct_failure(wdir, rclass, breaker)
            _release_key(ddir, sid, agent, key)
            return _act_skip(view, sid, rclass, record=True, **base)
        breaker.record_success()
    except Exception:
        logger.debug("wisdom-cc: activity ct call failed", exc_info=True)
        _release_key(ddir, sid, agent, key)
        return _act_skip(view, sid, "hook_failed", record=True, **base)

    # Phase C (locked): render against the ledger as it is NOW, record the
    # id, write, and only then emit (at-most-once, leg D4).
    with locked(session_path(ddir, sid)):
        cur = load_store(ddir, sid)
        if cur is None or cur["state"] != "on":
            return _act_skip(view, sid, "store_changed")
        ledger = ledger_of(cur)
        picked = None
        for item, superseded in cc_activity.render_candidates(
                result["entries"], result["corrections"], ledger):
            block = cc_activity.render_activity_block(item, superseded, activity)
            if block:
                picked = (item["id"], block)
                break
        if picked is None:
            # CT answered; nothing new survived: the key stays spent.
            return _act_skip(view, sid, "zero_hits", record=True, result=result,
                             ledger=sorted(ledger), **base)
        note_ids(cur, "activity_ids", [picked[0]])
        note_agent_ids(cur, agent, [picked[0]])
        save_store(ddir, sid, cur)
    logger.debug("wisdom-cc: activity deliver session=%s id=%s", sid, picked[0])
    _record("delivery", view, dict(base, session_id=sid, result=result, ledger=sorted(ledger),
                                   delivered=[picked[0]], block=picked[1]))
    return {"hookSpecificOutput": {"hookEventName": "PostToolBatch",
                                   "additionalContext": picked[1]}}


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def handle(payload, env=None):
    """Dispatch one hook payload; returns the directive dict or None."""
    if not isinstance(payload, dict):
        return None
    event = payload.get("hook_event_name")
    if event == "UserPromptSubmit":
        return user_prompt_submit(payload, env)
    if event == "PostToolUse":
        return post_tool_use(payload, env)
    if event == "PostToolUseFailure":
        return record_executed(payload, env)
    if event == "PostToolBatch":
        return post_tool_batch(payload, env)
    return None


def respond(payload, env=None):
    """handle() plus verbose mode: with CT_WISDOM_VERBOSE on, the notices the
    recorder produced become the top-level `systemMessage`, which Claude Code
    shows to the user and never sends to the model (verbose-mode spec D3).
    The directive's `hookSpecificOutput` is never touched. Never raises."""
    notices = []
    previous = ct_wisdom_verbose.set_sink(notices.append)
    try:
        directive = handle(payload, env)
    finally:
        ct_wisdom_verbose.set_sink(previous)
    if not notices:
        return directive
    try:
        return dict(directive or {}, systemMessage="\n\n".join(notices))
    except Exception:
        return directive


def main():
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        payload = json.loads(raw) if raw.strip() else None
    except Exception:
        return
    directive = respond(payload)
    if directive:
        try:
            sys.stdout.write(json.dumps(directive, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)

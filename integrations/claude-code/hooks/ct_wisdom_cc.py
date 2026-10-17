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
                        results, via hookSpecificOutput.updatedToolOutput (D9)

The ledger is ONLY the ${CLAUDE_PLUGIN_DATA} store keyed by session_id (D3):
the session transcript is never opened. Every unclear state fails closed —
no store, a corrupt store, a resumed/forked session, unclear prompt
provenance, a subagent — and costs at most a missed delivery, never a
duplicate. Stdlib only; every public entry point is non-raising; the hook
process always exits 0.

Run by hooks/hooks.json as `python3 ct_wisdom_cc.py` with the hook payload on
stdin; imported by hooks/session-start.py for the bootstrap.
"""

from __future__ import annotations

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
import ct_wisdom_live  # noqa: E402
import ct_wisdom_verbose  # noqa: E402


logger = logging.getLogger(__name__)

STORE_VERSION = 1
DATA_ENV = "CLAUDE_PLUGIN_DATA"
LOCK_WAIT = ct_hook_store.LOCK_WAIT
STORE_MAX_AGE = ct_hook_store.STORE_MAX_AGE
RECALL_TOOL_SUFFIX = "__curated_recall_context"

# A harness envelope (`<agent-message from=…>`, `<task-notification>`, …) at
# the very start of the prompt means the text was not typed by the user (D5).
_ENVELOPE_RE = re.compile(r"^<[A-Za-z][A-Za-z0-9_-]*(?=[\s>/])")
_LIST_FIELDS = ("bootstrap_ids", "live_ids", "tool_ids", "order")


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
    return set(store["bootstrap_ids"]) | set(store["live_ids"]) | set(store["tool_ids"])


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
    if not isinstance(payload, dict) or not is_recall_tool(payload.get("tool_name")):
        return None
    sid = payload.get("session_id")
    if not _nonempty_str(sid) or _in_subagent(payload):
        return None
    ddir = data_dir(ct_env.merged_env(env))
    if ddir is None:
        return None
    with locked(session_path(ddir, sid)):
        store = load_store(ddir, sid)
        if store is None or store["state"] != "on":
            return None
        updated, new_ids = rewrite_response(payload.get("tool_response"), ledger_of(store))
        if new_ids:
            save_store(ddir, sid, note_ids(store, "tool_ids", new_ids))
    if updated is None:
        return None
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                   "updatedToolOutput": updated}}


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

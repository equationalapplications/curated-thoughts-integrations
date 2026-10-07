#!/usr/bin/env python3
"""ct_tool_dedup.py — exactly-once for agent-initiated CT recall (Hermes).

Spec: docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md
("transform_tool_result hook"). For `curated_recall_context` results only
(`curated_get_wiki_entry` carries no wiki ids): a wiki entry whose id is
already in this session's context is replaced by a one-line stub (option A —
the agent still sees the hit), and every newly seen id gets a trailing
`<!-- ct-fact:<id> -->` marker so the next turn's ledger scan finds it.

Envelope (investigation Target 5 [V]): the hook receives
json.dumps({"result": "<CT JSON>", ...optional keys}). Anything else — tool
errors, head+tail-truncated payloads, other tools — passes through
unmodified (return None). Never raises.
"""

from __future__ import annotations

import json
import logging

import ct_ledger

logger = logging.getLogger(__name__)

RECALL_TOOL_SUFFIX = "__curated_recall_context"


def on_transform_tool_result(**kwargs):
    """Hermes `transform_tool_result` callback: str replaces the result, None keeps it."""
    try:
        return _transform(
            kwargs.get("tool_name"), kwargs.get("result"), kwargs.get("session_id")
        )
    except Exception:
        logger.debug("wisdom-live: tool dedup failed", exc_info=True)
        return None


def _stub(fact_id):
    return {"id": fact_id, "in_context": True,
            "note": "already in context: ct-fact:%s" % fact_id}


def _transform(tool_name, result, session_id):
    if not isinstance(tool_name, str) or not tool_name.endswith(RECALL_TOOL_SUFFIX):
        return None
    if not isinstance(result, str):
        return None
    try:
        outer = json.loads(result)
    except ValueError:
        return None
    if not isinstance(outer, dict) or not isinstance(outer.get("result"), str):
        return None
    try:
        inner = json.loads(outer["result"])
    except ValueError:
        return None
    if not isinstance(inner, dict) or not isinstance(inner.get("wiki_entries"), list):
        return None

    has_sid = isinstance(session_id, str) and bool(session_id)
    ledger = ct_ledger.LEDGER_CACHE.get(session_id) if has_sid else None
    rewritten = []
    new_ids = []
    stubbed = 0
    for entry in inner["wiki_entries"]:
        fact_id = entry.get("id") if isinstance(entry, dict) else None
        if not ct_ledger.valid_id(fact_id):
            rewritten.append(entry)
        elif ledger is not None and fact_id in ledger:
            rewritten.append(_stub(fact_id))
            stubbed += 1
        else:
            rewritten.append(entry)
            if fact_id not in new_ids:
                new_ids.append(fact_id)
    if not stubbed and not new_ids:
        return None

    inner["wiki_entries"] = rewritten
    if ledger is not None:
        ct_ledger.LEDGER_CACHE.add(session_id, new_ids)
    trailer = "".join("\n" + ct_ledger.marker(fact_id) for fact_id in new_ids)
    outer["result"] = json.dumps(inner, ensure_ascii=False) + trailer
    logger.debug("wisdom-live: tool dedup session=%s stubbed=%d new=%d",
                 session_id or "<empty>", stubbed, len(new_ids))
    return json.dumps(outer, ensure_ascii=False)

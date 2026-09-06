#!/usr/bin/env python3
"""ct_status.py — fast, read-only Curated Thoughts health snapshot.

Used by both Hermes session-start paths:

  * the native plugin hook (`__init__.py`, `on_session_start`), and
  * the shell-hook entry point (`hooks/session-start.py`) for users who wire
    it up in `~/.hermes/config.yaml` instead of installing the plugin.

Design constraints (spec §8): fast (<200ms target), read-only, fail-open. It
never spawns the sidecar — that costs an MCP handshake — and never opens the
brain database. It answers only "is this integration wired up, and is the
brain where it is supposed to be", which is what a session start needs. Deep
verification is `ct_doctor.py check`.

Stdlib only. Every entry point swallows exceptions and degrades to "unknown".
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ct_env  # noqa: E402

OK = "ok"
DEGRADED = "degraded"
UNKNOWN = "unknown"


def snapshot(env=None):
    """Return a small status dict. Never raises.

    Keys: status, sidecar, brain_dir, vault, notes (list of short strings).
    """
    env = os.environ if env is None else env
    out = {
        "status": UNKNOWN,
        "sidecar": None,
        "brain_dir": None,
        "vault": None,
        "notes": [],
    }
    try:
        path, resolved, _source = ct_env.find_sidecar(env=env)
        out["sidecar"] = path
        if path is None:
            out["notes"].append("sidecar curated-thoughts-mcp not found")
        elif ct_env.looks_like_dev_build(resolved):
            out["notes"].append("sidecar is a development build, not an installed one")

        paths = ct_env.resolve_brain_paths(env=env)
        out["brain_dir"] = str(paths.brain_dir)
        if not paths.brain_dir.is_dir():
            out["notes"].append(f"brain dir missing: {paths.brain_dir}")
        else:
            config, err = ct_env.read_brain_config(paths.config_path)
            if config is None:
                out["notes"].append(f"config.json {err}")
            else:
                vault, verr = ct_env.resolve_vault_path(config)
                if vault is None:
                    out["notes"].append(verr)
                else:
                    out["vault"] = str(vault)
                    if not vault.is_dir():
                        # The signature symptom of a brain imported from
                        # another machine: vault_path points somewhere that
                        # only existed on the source machine.
                        out["notes"].append(
                            f"vault path from config.json does not exist here: {vault}"
                        )

        out["status"] = DEGRADED if out["notes"] else OK
    except Exception:
        out["status"] = UNKNOWN
        out["notes"] = ["status check failed"]
    return out


ROUTING_REMINDER = (
    "Curated Thoughts memory is available over MCP. Prefer the one-call recall "
    "tool (wiki_context) before composing raw searches; reach for wiki_search / "
    "vault_semantic_search / wiki_traverse_graph / vault_related_chunks only for "
    "deep work. Never touch the vault or brain database out-of-band — the "
    "sidecar is the only writer."
)


def context_section(env=None):
    """One compact block for injection into session context. Never raises.

    Returns None when everything is healthy and there is nothing worth
    spending context on beyond the routing reminder.
    """
    try:
        snap = snapshot(env=env)
    except Exception:
        return None
    lines = ["## Curated Thoughts"]
    if snap["status"] == OK:
        lines.append(f"Memory sidecar ready (brain: {snap['brain_dir']}).")
    elif snap["status"] == DEGRADED:
        lines.append(
            "Memory sidecar DEGRADED — CT tool calls may fail. "
            "Run `ct_doctor.py check` for details."
        )
        for note in snap["notes"][:3]:
            lines.append(f"- {note}")
        lines.append(
            "Continue the session without Curated Thoughts memory if tools fail; "
            "report the error rather than working around the sidecar."
        )
    else:
        lines.append("Memory status unknown; proceed and report any tool errors.")
    lines.append(ROUTING_REMINDER)
    return "\n".join(lines)

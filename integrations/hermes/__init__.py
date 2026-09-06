"""Curated Thoughts plugin for Hermes Agent.

Hermes discovers plugins in ~/.hermes/plugins/<name>/ and calls `register(ctx)`
exactly once at startup. This module is that entry point.

What it wires up:

  * the three Curated Thoughts skills (usage / ops / sidecar), namespaced by
    Hermes as `curated-thoughts:<skill>`;
  * an `on_session_start` hook that refreshes a cached health snapshot;
  * a system-prompt section carrying that snapshot plus the tool-routing
    reminder, so the agent starts every session knowing whether Curated
    Thoughts memory is usable and how to reach for it.

The tool surface itself is NOT registered here — it is served by the
`curated-thoughts-mcp` sidecar over MCP, registered under `mcp_servers` in
~/.hermes/config.yaml by scripts/install.sh.

Fail-open by construction: every callback swallows its own exceptions. A
Curated Thoughts problem must degrade the session, never block it.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent
_SCRIPTS = PLUGIN_ROOT / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

logger = logging.getLogger(__name__)

SKILLS = (
    "curated-thoughts-usage",
    "curated-thoughts-ops",
    "curated-thoughts-sidecar",
)

# Cached snapshot, refreshed at session start so the system-prompt section
# does not re-run filesystem probes on every prompt assembly.
_cached_section = None


def _compute_section():
    """Build the context block, importing lazily so an import error here can
    never take down plugin registration."""
    try:
        import ct_status

        return ct_status.context_section()
    except Exception:  # pragma: no cover - defensive
        logger.debug("curated-thoughts: status snapshot failed", exc_info=True)
        return None


def _on_session_start(**kwargs):
    """Refresh the cached health snapshot at session start.

    Hermes hook callbacks take **kwargs for forward compatibility and must not
    raise; exceptions are logged and skipped by the host, but we swallow them
    here too so nothing lands in the user's log for a purely advisory check.
    """
    global _cached_section
    try:
        _cached_section = _compute_section()
    except Exception:  # pragma: no cover - defensive
        logger.debug("curated-thoughts: session-start hook failed", exc_info=True)


def _system_prompt_section():
    """Return the Curated Thoughts context block, computing it on first use."""
    global _cached_section
    if _cached_section is None:
        _cached_section = _compute_section()
    return _cached_section or ""


def register(ctx):
    """Hermes plugin entry point. Called exactly once at startup."""
    for skill in SKILLS:
        skill_md = PLUGIN_ROOT / "skills" / skill / "SKILL.md"
        if not skill_md.is_file():
            logger.warning("curated-thoughts: skill file missing: %s", skill_md)
            continue
        try:
            ctx.register_skill(skill, str(skill_md))
        except Exception:  # pragma: no cover - host API variance
            logger.warning("curated-thoughts: could not register skill %s", skill, exc_info=True)

    try:
        ctx.register_hook("on_session_start", _on_session_start)
    except Exception:  # pragma: no cover - host API variance
        logger.warning("curated-thoughts: could not register session-start hook", exc_info=True)

    # Optional on some Hermes versions; the plugin is still useful without it.
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if callable(register_section):
        try:
            register_section("curated-thoughts", _system_prompt_section)
        except Exception:  # pragma: no cover - host API variance
            logger.warning(
                "curated-thoughts: could not register system prompt section", exc_info=True
            )

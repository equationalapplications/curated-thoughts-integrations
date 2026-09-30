#!/usr/bin/env python3
"""ct_wisdom.py — wisdom-layer auto-inclusion for the Hermes integration.

Renders the `curated-thoughts-wisdom` system-prompt section: semantically
relevant wisdom-layer (wiki) entries injected at session start, once per
session, cache-safe, fail-open — per the converged design spec
(docs/superpowers/specs/2026-09-30-wisdom-auto-inclusion-design.md).

Design invariants (single source of truth for failure classes):

* `discover_ct()` -> (path | None, failure_class | None). "probe_timeout" is
  NOT memoized (a slow first-run binary must not darken a session); a
  deterministic discovery miss (None, None) IS memoized.
* `recall_wiki()` -> (entries | None, failure_class | None). "timeout" /
  "exit" / "spawn" are NOT memoized (possibly-transient backend state — the
  next render retries); zero hits ([], None) and a parse error (None, None)
  ARE memoized.
* `_render_wisdom()` is the SOLE owner of the failure-class actions: it maps
  every class to memoize-or-not and, on "spawn", invalidates the accepted-path
  discovery cache so a reinstalled/moved `ct` recovers.
* Sanitization order (spec cycle 2): remove every `<!-- hermes-plugin-section`
  substring REPEATEDLY until stable (one pass can splice a new marker
  together), THEN indent any line starting `## Plugin Context: `. Applied to
  titles AND text — a forged frame would break host resume-restore.
* Memo: {session_id -> block}, lock-guarded check, `ct` subprocess OUTSIDE the
  lock, setdefault first-writer-wins, LRU bound N=256, empty session_id -> ""
  with no memo write.

Read-only brain access: `ct recall` subprocess only. No SQLite, no ~/.brain
writes, no sidecar contact. Stdlib only; every entry point is non-raising.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
from collections import OrderedDict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# frozen constants (spec OQ5/OQ6 — tuned at e2e, then hard-frozen)
# ---------------------------------------------------------------------------

SEED_QUERY = "curated thoughts agent memory wisdom procedures"
RECALL_TIMEOUT = 5  # seconds (cold-path measurement recorded at e2e, Task 7.1)
PROBE_TIMEOUT = 3  # seconds, identity probe (`ct --help`)
RECALL_K = 3  # top-k wiki entries
MAX_BLOCK_CHARS = 2500  # registered max_chars; host measures STRIPPED text
MEMO_MAX_SESSIONS = 256

# cwd basenames too generic to help the semantic query (spec §Approach 2).
_CWD_DENYLIST = {"tmp", "home", "users"}

_FORBIDDEN_MARKER = "<!-- hermes-plugin-section"
_FORBIDDEN_HEADING = "## Plugin Context: "
_HEADING_INDENT = "    " + _FORBIDDEN_HEADING  # 4-space indent defeats the frame

_PROBE_IDENTITY = "Curated Thoughts"

# ---------------------------------------------------------------------------
# discovery + identity probe
# ---------------------------------------------------------------------------

_accepted_ct_path = None
_discovery_lock = threading.Lock()


def _candidate_paths(platform=None, env=None):
    """Ordered, platform-appropriate fallback locations for `ct` (spec OQ2).

    `shutil.which("ct")` is tried first by discover_ct; these explicit
    candidates cover installs that are not on PATH.
    """
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    home = os.path.expanduser("~")
    if platform == "darwin":
        return [
            os.path.join(home, "bin", "ct"),
            "/usr/local/bin/ct",
            "/opt/homebrew/bin/ct",
        ]
    if platform.startswith("win"):
        profile = env.get("USERPROFILE", "")
        local = env.get("LOCALAPPDATA", "")
        out = []
        if profile:
            # Literal backslash joins: os.path.join would use the host's
            # separator and this branch can be evaluated on POSIX too.
            out.append(profile.rstrip("\\/") + "\\bin\\ct\\ct.exe")
        if local:
            out.append(local.rstrip("\\/") + "\\CuratedThoughts\\bin\\ct.exe")
        return out
    return [
        os.path.join(home, ".local", "bin", "ct"),
        "/usr/bin/ct",
        "/usr/local/bin/ct",
        os.path.join(home, "bin", "ct"),
    ]


def _usable_candidate(path):
    """Filesystem gate before the identity probe. POSIX requires the exec bit
    (os.access X_OK); Windows candidates only need to exist (os.path.isfile) —
    exec-bit semantics do not translate."""
    if sys.platform.startswith("win"):
        return os.path.isfile(path)
    return os.access(path, os.X_OK)


def _identity_probe(ct_path):
    """Run `<ct> --help` under the single subprocess contract and return
    whether the output names Curated Thoughts (verified 2026-09-30: line 1 of
    the real help text does; chart-testing's unrelated `ct` does not).

    Returns "ok" | "timeout" | "reject".
    """
    try:
        proc = subprocess.run(
            [ct_path, "--help"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=PROBE_TIMEOUT,
            cwd=os.path.expanduser("~"),
        )
    except subprocess.TimeoutExpired:
        return "timeout"
    except OSError:
        # Could not even spawn it ( vanished between the access check and
        # exec, permissions on POSIX gate earlier, PATHEXT variance on
        # Windows). Treat as a rejection and keep searching.
        return "reject"
    blob = (proc.stdout or b"") + (proc.stderr or b"")
    if _PROBE_IDENTITY.encode("utf-8") in blob:
        return "ok"
    return "reject"


def reset_discovery_cache():
    """TEST-ONLY hook: clear the process-wide accepted-path cache."""
    global _accepted_ct_path
    with _discovery_lock:
        _accepted_ct_path = None


def discover_ct(env=None):
    """Locate a `ct` binary that really is Curated Thoughts.

    Returns (path | None, failure_class | None):
      (path, None)          — accepted (cached process-wide after first accept)
      (None, "probe_timeout") — a candidate's identity probe timed out
                                (NOT memoized — next render retries)
      (None, None)          — deterministic discovery miss (memoized)
    """
    global _accepted_ct_path
    # Cache check under the lock; the probe runs outside it so a slow first
    # run never serializes prompt assembly (same shape as the health cache).
    with _discovery_lock:
        cached = _accepted_ct_path
    if cached is not None:
        return cached, None

    env = os.environ if env is None else env
    which_path = shutil.which("ct", path=env.get("PATH"))
    candidates = ([which_path] if which_path else []) + _candidate_paths(
        platform=sys.platform, env=env
    )
    for cand in candidates:
        if not cand or not _usable_candidate(cand):
            continue
        verdict = _identity_probe(cand)
        if verdict == "ok":
            logger.debug("wisdom: ct accepted: %s", cand)
            with _discovery_lock:
                if _accepted_ct_path is None:
                    _accepted_ct_path = cand
            return cand, None
        logger.debug("wisdom: ct candidate rejected (%s): %s", verdict, cand)
        if verdict == "timeout":
            return None, "probe_timeout"
    logger.debug("wisdom: no ct candidate passed the identity probe")
    return None, None


# ---------------------------------------------------------------------------
# query construction
# ---------------------------------------------------------------------------


def query_for(session_info):
    """Build the recall query: frozen seed + cwd basename when non-degenerate.

    Degenerate = cwd absent/empty, basename equals the home directory's
    basename, or basename in the denylist — in those cases the seed alone is
    used (measured: metadata-only queries retrieve zero entries; the seed does
    the semantic work). Byte-stable for a given session_info.
    """
    if not session_info:
        return SEED_QUERY
    cwd = session_info.get("cwd") or ""
    basename = os.path.basename(cwd.rstrip("/\\")) if cwd else ""
    if not basename:
        return SEED_QUERY
    home_basename = os.path.basename(os.path.expanduser("~").rstrip("/\\"))
    if basename == home_basename or basename in _CWD_DENYLIST:
        return SEED_QUERY
    return SEED_QUERY + " " + basename


# ---------------------------------------------------------------------------
# recall wrapper
# ---------------------------------------------------------------------------


def recall_wiki(ct_path, query):
    """Run `ct recall <query> --json --k 3` and return wiki entries.

    Returns (entries | None, failure_class | None):
      ([(title, text), ...], None) — success (possibly empty list)
      ([], None)                   — zero hits (memoized by the orchestrator)
      (None, None)                 — JSON parse error (memoized)
      (None, "timeout")            — subprocess timeout (NOT memoized)
      (None, "exit")               — non-zero exit (NOT memoized)
      (None, "spawn")              — OSError spawning ct (NOT memoized; the
                                     orchestrator invalidates the discovery
                                     cache on this class)
    """
    try:
        proc = subprocess.run(
            [ct_path, "recall", query, "--json", "--k", str(RECALL_K)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=RECALL_TIMEOUT,
            cwd=os.path.expanduser("~"),
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "spawn"
    if proc.returncode != 0:
        logger.debug("wisdom: ct recall exited %s", proc.returncode)
        return None, "exit"
    try:
        data = json.loads(proc.stdout.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return None, None
    if not isinstance(data, dict) or not isinstance(data.get("wiki"), list):
        return None, None
    entries = []
    for item in data["wiki"]:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        text = item.get("text")
        entries.append(
            (
                title if isinstance(title, str) else "",
                text if isinstance(text, str) else "",
            )
        )
    return entries, None


# ---------------------------------------------------------------------------
# sanitize + render
# ---------------------------------------------------------------------------


def _sanitize(value):
    """Defuse a forged Hermes plugin-section frame inside a wisdom field.

    Order matters (spec cycle 2): removing the marker substring REPEATEDLY
    until stable — one pass can splice two fragments into a fresh marker —
    and only THEN indenting any line-start `## Plugin Context: ` the removal
    exposed (indent-first would let removal re-expose a clean heading).
    """
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    while _FORBIDDEN_MARKER in value:
        value = value.replace(_FORBIDDEN_MARKER, "")
    lines = [
        _HEADING_INDENT + line[len(_FORBIDDEN_HEADING):]
        if line.startswith(_FORBIDDEN_HEADING)
        else line
        for line in value.split("\n")
    ]
    return "\n".join(lines)


def render_block(entries):
    """Render sanitized wiki entries into the bounded wisdom block.

    Per entry: `**{title}**\n{text}`, joined with blank lines. The hard cap is
    2500 chars on the accumulated STRIPPED length (the host measures stripped
    text and drops over-length sections): entries are included while they fit
    and the rest are dropped. Zero usable entries -> "".
    """
    if not entries:
        return ""
    parts = []
    total = 0
    for title, text in entries:
        clean_title = _sanitize(title).strip()
        clean_text = _sanitize(text)
        part = "**%s**\n%s" % (clean_title, clean_text)
        candidate_len = len(part) if not parts else len(part) + 2
        if total + candidate_len > MAX_BLOCK_CHARS:
            break
        parts.append(part)
        total += candidate_len
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# session memo
# ---------------------------------------------------------------------------


class WisdomMemo:
    """Session-keyed once-semantics: {session_id -> rendered block bytes}.

    Lock pattern copied from the health section (__init__.py:97-109): memo
    CHECK under the lock, the (possibly slow) recall_fn call OUTSIDE it, and a
    setdefault write so racing renders for one session return identical bytes
    (first writer wins). LRU-bounded at MEMO_MAX_SESSIONS.
    """

    def __init__(self, max_sessions=MEMO_MAX_SESSIONS):
        self._store = OrderedDict()
        self._lock = threading.Lock()
        self._max = max_sessions

    @staticmethod
    def _session_id(session_info):
        if not isinstance(session_info, dict):
            return ""
        sid = session_info.get("session_id")
        return sid if isinstance(sid, str) else ""

    def render_for(self, session_info, recall_fn):
        """Return the block for this session, calling recall_fn on a miss.

        Empty/absent session_id -> "" with NO memo write and NO recall_fn call
        (session_info builds ids via `str(getattr(agent, k, None) or "")` — a
        blank id must never become a shared memo key).

        recall_fn contract: fn(session_info) -> (block_str, memoize: bool).
        When memoize is False the result is returned but not stored, so the
        next render retries (timeout/exit/spawn/probe-timeout classes).
        A raising recall_fn fails open: "" and no memo write.
        """
        sid = self._session_id(session_info)
        if not sid:
            return ""
        with self._lock:
            cached = self._store.get(sid)
        if isinstance(cached, str):
            with self._lock:  # LRU touch
                self._store.move_to_end(sid)
            return cached
        try:
            block, memoize = recall_fn(session_info)
        except Exception:
            logger.debug("wisdom: recall_fn failed for session %s", sid, exc_info=True)
            return ""
        if not isinstance(block, str):
            block = ""
        if memoize:
            with self._lock:
                self._store.setdefault(sid, block)
                self._store.move_to_end(sid)
                while len(self._store) > self._max:
                    self._store.popitem(last=False)
        return block


_MODULE_MEMO = WisdomMemo()


# ---------------------------------------------------------------------------
# orchestrator (SOLE owner of the failure-class -> memoize mapping)
# ---------------------------------------------------------------------------


def _render_wisdom(session_info):
    """Render the wisdom block for a session. Never raises; "" on any failure.

    Failure-class mapping (every class logged at DEBUG, never INFO):
      discovery miss  -> "" memoized
      probe_timeout   -> "" NOT memoized
      recall timeout / exit -> "" NOT memoized
      spawn           -> "" NOT memoized + discovery cache invalidated
      parse error / zero hits -> "" / block, memoized
      success         -> block, memoized
    """
    sid = WisdomMemo._session_id(session_info)
    label = sid if sid else "<empty>"

    memo = _MODULE_MEMO
    with memo._lock:
        cached = memo._store.get(sid) if sid else None
    if sid and isinstance(cached, str):
        with memo._lock:
            memo._store.move_to_end(sid)
        logger.debug("wisdom: render session=%s memo=hit class=ok", label)
        return cached
    if not sid:
        logger.debug("wisdom: render session=%s memo=miss class=empty_id", label)
        return ""

    path, dclass = discover_ct()
    if path is None:
        if dclass == "probe_timeout":
            logger.debug(
                "wisdom: render session=%s memo=miss class=probe_timeout", label
            )
            return ""  # not memoized: next render retries discovery
        logger.debug(
            "wisdom: render session=%s memo=miss class=discovery_miss", label
        )
        memo.render_for(session_info, lambda _si: ("", True))
        return ""  # memoized: deterministic miss for this machine

    entries, rclass = recall_wiki(path, query_for(session_info))
    if rclass is not None:
        if rclass == "spawn":
            reset_discovery_cache()  # cached path is bad; re-discover next render
        logger.debug("wisdom: render session=%s memo=miss class=%s", label, rclass)
        return ""  # timeout/exit/spawn: not memoized, next render retries

    if entries is None:
        logger.debug("wisdom: render session=%s memo=miss class=parse_error", label)
        memo.render_for(session_info, lambda _si: ("", True))
        return ""  # memoized: a parse error is deterministic for these bytes

    if not entries:
        logger.debug("wisdom: render session=%s memo=miss class=zero_hits", label)
        memo.render_for(session_info, lambda _si: ("", True))
        return ""  # memoized: zero hits for this brain are deterministic

    block = render_block(entries)
    memo.render_for(session_info, lambda _si: (block, True))
    logger.debug("wisdom: render session=%s memo=miss class=ok", label)
    return block

#!/usr/bin/env python3
"""ct_env.py — Curated Thoughts environment resolution, shared by the doctor,
the session-start hook, and the Hermes plugin entry point.

Single source of truth for three things the integration kept getting wrong:

1. **The brain directory** is resolved exactly the way Curated Thoughts
   resolves it (`src-tauri/src/retrieval/mod.rs::resolve_brain_paths`):
   `CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`, defaulting
   to `~/.brain`. There is no `CT_VAULT_DIR` — that variable never existed in
   Curated Thoughts and nothing reads it.

2. **The brain directory is not the vault.** The brain dir holds `brain.db`
   and `config.json`; the *vault* is the documents tree, whose path lives in
   `config.json` under `vault_path` and is machine-specific (which is why it
   is always wrong immediately after importing a brain from another machine).

3. **Sidecar discovery is platform-shaped.** Curated Thoughts ships on macOS,
   Linux and Windows. The sidecar is a Tauri `externalBin`, so it lives inside
   the app bundle on macOS and next to the app executable on Windows — not
   only in `/usr/bin`.

Stdlib only. Every function is read-only and non-raising.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

SIDECAR_NAME = "curated-thoughts-mcp"

# Env vars Curated Thoughts actually reads (README "Environment Variables"
# table + retrieval/mod.rs). Kept here so every caller uses the same names.
ENV_BRAIN_DIR = "CURATED_BRAIN_DIR"
ENV_BRAIN_DB = "CURATED_BRAIN_DB"
ENV_BRAIN_CONFIG = "CURATED_BRAIN_CONFIG"


def _expand(p):
    """Expand a leading ~ the way CT's doctor does, then make it a Path."""
    return Path(os.path.expanduser(str(p)))


class BrainPaths:
    """Resolved brain layout. Mirrors CT's `BrainPaths` struct."""

    __slots__ = ("brain_dir", "db_path", "config_path")

    def __init__(self, brain_dir, db_path, config_path):
        self.brain_dir = brain_dir
        self.db_path = db_path
        self.config_path = config_path

    def as_dict(self):
        return {
            "brain_dir": str(self.brain_dir),
            "db_path": str(self.db_path),
            "config_path": str(self.config_path),
        }


def resolve_brain_paths(env=None):
    """Resolve the brain layout from the environment.

    Port of `resolve_brain_paths()` in curated-thoughts
    (src-tauri/src/retrieval/mod.rs), including the rule that
    `CURATED_BRAIN_CONFIG` wins, else config.json sits beside an explicitly
    configured `CURATED_BRAIN_DB`, else beside the brain dir.
    """
    env = os.environ if env is None else env

    brain_dir = _expand(env[ENV_BRAIN_DIR]) if env.get(ENV_BRAIN_DIR) else _expand("~/.brain")

    if env.get(ENV_BRAIN_DB):
        db_path = _expand(env[ENV_BRAIN_DB])
    else:
        db_path = brain_dir / "brain.db"

    if env.get(ENV_BRAIN_CONFIG):
        config_path = _expand(env[ENV_BRAIN_CONFIG])
    elif env.get(ENV_BRAIN_DB):
        config_path = db_path.parent / "config.json"
    else:
        config_path = brain_dir / "config.json"

    return BrainPaths(brain_dir, db_path, config_path)


def read_brain_config(config_path):
    """Read config.json. Returns (config_dict|None, error|None). Never raises."""
    try:
        text = Path(config_path).read_text(errors="replace")
    except FileNotFoundError:
        return None, "not found"
    except OSError as exc:
        return None, f"unreadable: {exc}"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, f"malformed JSON: {exc}"
    if not isinstance(data, dict):
        return None, "root is not a JSON object"
    return data, None


def resolve_vault_path(config):
    """Extract the vault path from a parsed config.json.

    Returns (Path|None, error|None). CT treats a non-string `vault_path` as a
    hard config error (config/mod.rs), so we report that shape rather than
    coercing it.
    """
    if config is None:
        return None, "no config"
    if "vault_path" not in config:
        return None, "vault_path not set in config.json"
    raw = config["vault_path"]
    if not isinstance(raw, str) or not raw.strip():
        return None, "vault_path is present but not a non-empty string"
    return _expand(raw), None


# --------------------------------------------------------------------------
# platform-aware sidecar discovery
# --------------------------------------------------------------------------

def _windows_candidates(env):
    exe = SIDECAR_NAME + ".exe"
    roots = [
        env.get("LOCALAPPDATA", ""),
        env.get("PROGRAMFILES", ""),
        env.get("ProgramFiles(x86)", ""),
    ]
    out = []
    for root in roots:
        if not root:
            continue
        base = Path(root)
        out.append(base / "Programs" / "Curated Thoughts" / exe)
        out.append(base / "Curated Thoughts" / exe)
    return out


def _macos_candidates():
    # Tauri externalBin sidecars are staged next to the app executable inside
    # the bundle; both the system and per-user Applications dirs are valid.
    rel = Path("Curated Thoughts.app") / "Contents" / "MacOS" / SIDECAR_NAME
    return [
        Path("/Applications") / rel,
        _expand("~/Applications") / rel,
    ]


def _linux_candidates():
    return [
        Path("/usr/bin") / SIDECAR_NAME,
        Path("/usr/local/bin") / SIDECAR_NAME,
        _expand("~/.local/bin") / SIDECAR_NAME,
        Path("/opt/curated-thoughts") / SIDECAR_NAME,
    ]


def sidecar_candidates(platform=None, env=None):
    """Ordered, platform-appropriate fallback locations for the sidecar."""
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    if platform == "darwin":
        return _macos_candidates()
    if platform.startswith("win"):
        return _windows_candidates(env)
    return _linux_candidates()


def find_sidecar(platform=None, env=None):
    """Locate the sidecar. Returns (path|None, realpath|None, source).

    `source` is "PATH" or "bundled" so callers can explain where it came from
    without re-deriving the search order.
    """
    env = os.environ if env is None else env
    found = shutil.which(SIDECAR_NAME, path=env.get("PATH"))
    if found:
        return found, os.path.realpath(found), "PATH"
    for cand in sidecar_candidates(platform=platform, env=env):
        try:
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand), os.path.realpath(cand), "bundled"
        except OSError:
            continue
    return None, None, "none"


# Path segments that mark a development build rather than an installed one.
# This is the OS-agnostic replacement for the old dpkg-prefix test: what
# actually matters is "is this a stray build output shadowing the installed
# sidecar", which looks the same on every platform.
DEV_BUILD_MARKERS = (
    "target/debug",
    "target/release",
    "target\\debug",
    "target\\release",
    "/tools/",
    "\\tools\\",
)


def looks_like_dev_build(resolved_path):
    """True if a resolved sidecar path looks like a source-checkout build."""
    if not resolved_path:
        return False
    p = str(resolved_path)
    lowered = p.replace("\\", "/").lower()
    for marker in DEV_BUILD_MARKERS:
        if marker.replace("\\", "/").lower() in lowered:
            return True
    return False


def install_kind(resolved_path, platform=None):
    """Classify an installed sidecar location for human-readable output."""
    platform = sys.platform if platform is None else platform
    if not resolved_path:
        return "unknown"
    p = str(resolved_path).replace("\\", "/")
    if looks_like_dev_build(p):
        return "dev-build"
    if ".app/Contents/MacOS" in p:
        return "macos-app-bundle"
    if p.startswith("/usr/") or p.startswith("/opt/"):
        return "system-package"
    if "/Programs/" in p or "/Program Files" in p:
        return "windows-install"
    return "other"

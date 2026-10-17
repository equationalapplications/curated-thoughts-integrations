#!/usr/bin/env python3
"""ct_env.py — Curated Thoughts environment resolution, shared by the doctor,
the session-start hooks, and the plugin entry points.

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

Shared script: integrations/hermes/scripts and integrations/claude-code/scripts
carry byte-identical copies. Change both together;
tests/tools/test_shared_script_parity.py fails on any drift.
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


def merged_env(env=None):
    """Ambient os.environ with `env` overlaid — the spawn-time env view.

    The single source of truth for "which environment does this call see"
    (issue #32; the #14/#29 bug class was two code paths resolving different
    views). Public entry points (ct_doctor.run_checks and its checks,
    ct_status.snapshot) build the view here ONCE and hand it to the
    primitives below, which consume whatever view they are given AS-IS
    (only env=None means ambient there).

    Per-key semantics of `env`:

      * key missing      -> the ambient value shows through;
      * value None       -> treated exactly like a missing key: "the caller
                            did not specify this key", ambient shows through.
                            Dropped rather than kept, because a None reaching
                            subprocess.run(env=...) raises TypeError and
                            {"PATH": None} would make shutil.which fall back
                            to the AMBIENT PATH (GLM r3, PR #31);
      * value ""         -> kept: the documented SUPPRESSION of the ambient
                            value (reads as unset through a falsy .get());
      * any other string -> wins over the ambient value.

    This OVERLAYS os.environ, unlike subprocess.run(env=...) which replaces
    it — so env={} cannot remove an ambient key; use "" for that.

    Documented trade-off: a caller env WITHOUT a PATH key inherits the
    ambient PATH, so discovery can resolve (and the doctor can spawn) the
    real installed sidecar. That is deliberate — callers that do not pass a
    PATH must stay unaffected. A caller that means to control which binary
    runs must pass PATH; ct_doctor.run_checks refuses to spawn when such an
    override fails to resolve (issue #28).

    Always returns a NEW dict; neither os.environ nor `env` is mutated.
    """
    merged = dict(os.environ)
    if env:
        merged.update({k: v for k, v in env.items() if v is not None})
    return merged


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
# the sidecar's launch environment
# --------------------------------------------------------------------------

# How Curated Thoughts resolves an external embedder's key
# (src-tauri/src/embedder/mod.rs, ExternalEmbedProfile::resolved_api_key):
# the profile's own api_key, else EMBED_API_KEY, else OPENROUTER_API_KEY when
# base_url names openrouter, else OPENAI_API_KEY. A blank value counts as
# unset at every step. The default base_url is OpenRouter's.
ENV_EMBED_API_KEY = "EMBED_API_KEY"
ENV_OPENROUTER_API_KEY = "OPENROUTER_API_KEY"
ENV_OPENAI_API_KEY = "OPENAI_API_KEY"
ENV_OLLAMA_HOST = "OLLAMA_HOST"
DEFAULT_EXTERNAL_BASE_URL = "https://openrouter.ai/api/v1"

# Kinds of sidecar env need. A "ref" is passed by name only (a ${NAME}
# reference in the host config; the value is never written). A "path" is a
# brain location: not a secret, and the sidecar does not expand `~`, so it is
# written as the absolute path.
NEED_REF = "ref"
NEED_PATH = "path"


class EnvNeed:
    """One variable the sidecar needs. `alternatives` lists every name that
    satisfies the need (CT's key resolution falls through EMBED_API_KEY to
    the provider default), `name` first: the one to suggest."""

    __slots__ = ("name", "kind", "reason", "value", "alternatives")

    def __init__(self, name, kind, reason, value=None, alternatives=()):
        self.name = name
        self.kind = kind
        self.reason = reason
        # Only ever set for NEED_PATH. A secret's value is never carried.
        self.value = value if kind == NEED_PATH else None
        self.alternatives = (name,) + tuple(a for a in alternatives if a != name)


def _is_default_ollama_host(value):
    """True for the host the sidecar uses anyway (http://localhost:11434)."""
    host = value.strip().lower()
    for prefix in ("http://", "https://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
    return host.rstrip("/") in ("localhost:11434", "127.0.0.1:11434")


def _set(env, name):
    value = env.get(name)
    return isinstance(value, str) and bool(value.strip())


def embed_profile_kind(config):
    """The brain's embed_profile type: "local" (the CT default), "external",
    "cloud", or the raw unknown string."""
    profile = (config or {}).get("embed_profile")
    if not isinstance(profile, dict):
        return "local"
    kind = profile.get("type")
    return kind if isinstance(kind, str) and kind else "local"


def external_embed_key_var(config, env=None):
    """Env var name the sidecar reads the external embedder's key from, or
    None when the brain is not external or the profile carries its own key.

    EMBED_API_KEY wins when it is set in `env` (CT checks it first);
    otherwise the provider default for the profile's base_url.
    """
    env = os.environ if env is None else env
    if embed_profile_kind(config) != "external":
        return None
    profile = config["embed_profile"]
    inline = profile.get("api_key")
    if isinstance(inline, str) and inline.strip():
        return None
    if _set(env, ENV_EMBED_API_KEY):
        return ENV_EMBED_API_KEY
    base = profile.get("base_url")
    base = base if isinstance(base, str) and base else DEFAULT_EXTERNAL_BASE_URL
    return ENV_OPENROUTER_API_KEY if "openrouter" in base else ENV_OPENAI_API_KEY


def sidecar_env_needs(config, env=None):
    """Env vars the sidecar needs from the host that launches it.

    A host that filters its MCP children's environment (Hermes, OpenClaw,
    DeepSeek Harness) drops these unless its MCP config names them. Returns
    a list of EnvNeed, in a stable order. Read-only; never raises.
    """
    env = os.environ if env is None else env
    needs = []
    # A brain location that resolves to the default layout needs no
    # forwarding: the sidecar finds ~/.brain on its own.
    custom_location = (
        resolve_brain_paths(env).as_dict() != resolve_brain_paths({}).as_dict()
    )
    for name in (ENV_BRAIN_DIR, ENV_BRAIN_DB, ENV_BRAIN_CONFIG):
        if custom_location and _set(env, name):
            needs.append(EnvNeed(
                name, NEED_PATH,
                "this brain location is set in the environment; without it "
                "the sidecar opens the default ~/.brain",
                os.path.abspath(str(_expand(env[name].strip()))),
            ))
    key = external_embed_key_var(config, env)
    if key:
        # Either name works at spawn time: EMBED_API_KEY first, then the
        # provider default (computed with EMBED_API_KEY treated as unset).
        default = external_embed_key_var(config, {})
        needs.append(EnvNeed(
            key, NEED_REF,
            "the brain's external embedder reads its API key from it; "
            "without it recall and wisdom matching cannot embed",
            alternatives=(ENV_EMBED_API_KEY, default),
        ))
    if (embed_profile_kind(config) == "local" and _set(env, ENV_OLLAMA_HOST)
            and not _is_default_ollama_host(env[ENV_OLLAMA_HOST])):
        needs.append(EnvNeed(
            ENV_OLLAMA_HOST, NEED_REF,
            "the brain's local embedder uses Ollama at this host; without "
            "it the sidecar tries http://localhost:11434",
        ))
    return needs


def _sidecar_env_main(argv):
    """`ct_env.py sidecar-env`: the needs for the ambient brain, one per line
    as `<kind>\\t<name>[\\t<absolute path>]`. A secret's value is never
    printed. Exit 3 when the brain config cannot be read (the caller then
    prints generic guidance)."""
    if argv[:1] != ["sidecar-env"]:
        sys.stderr.write("usage: ct_env.py sidecar-env\n")
        return 2
    config, _err = read_brain_config(resolve_brain_paths().config_path)
    needs = sidecar_env_needs(config or {})
    for need in needs:
        fields = [need.kind, need.name] + ([need.value] if need.value else [])
        sys.stdout.write("\t".join(fields) + "\n")
    return 0 if config is not None else 3


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


# Where discovery found the sidecar. Constants, not string literals: callers
# (and the issue #28 guard tests) match on these, so a future rename of
# "bundled" → "installed" is a one-line change (see the #28 resolution doc).
SOURCE_PATH = "PATH"
SOURCE_BUNDLED = "bundled"
SOURCE_NONE = "none"


def find_sidecar(platform=None, env=None):
    """Locate the sidecar. Returns (path|None, realpath|None, source).

    `source` is "PATH" or "bundled" so callers can explain where it came from
    without re-deriving the search order.

    Issue #28: the fallback candidates are ambient install locations, NOT
    env-derived — a caller that passes an env carrying a PATH override (the
    documented way to control which binary runs) must be able to tell when
    discovery ignored that override and resolved an ambient binary instead.
    The `source` return value is that signal; `ct_doctor` uses it to refuse
    spawning an ambient binary under a caller-owned env (see ct_doctor.run_checks).
    """
    env = os.environ if env is None else env
    found = shutil.which(SIDECAR_NAME, path=env.get("PATH"))
    if found:
        return found, os.path.realpath(found), SOURCE_PATH
    for cand in sidecar_candidates(platform=platform, env=env):
        try:
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand), os.path.realpath(cand), SOURCE_BUNDLED
        except OSError:
            continue
    return None, None, SOURCE_NONE


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


if __name__ == "__main__":
    sys.exit(_sidecar_env_main(sys.argv[1:]))

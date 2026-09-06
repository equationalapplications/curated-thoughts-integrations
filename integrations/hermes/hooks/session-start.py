#!/usr/bin/env python3
"""SessionStart hook for the curated-thoughts plugin.

Fast (<200ms target), read-only, fail-open health snapshot for Curated
Thoughts (CT). Emits a single-line JSON status object to stdout ONLY when
something is off. Absolute quietness (no output, exit 0) when healthy.

Checks:
  1. curated-thoughts-mcp sidecar on PATH or /usr/bin
  2. vault directory exists (CT_VAULT_DIR env override, else ~/.brain)

Stdlib only. Never blocks session start: any unexpected error results in
a silent exit 0.
"""

import json
import os
import shutil
import sys

# no network calls; purely local filesystem checks


def _find_sidecar():
    """Return the resolved sidecar path, or None if absent."""
    # Explicit PATH lookup first (shutil.which traverses os.environ["PATH"]).
    found = shutil.which("curated-thoughts-mcp")
    if found:
        return found
    # Fallback: common system install locations (distro .deb / usr-local).
    for candidate in ("/usr/bin/curated-thoughts-mcp",
                      "/usr/local/bin/curated-thoughts-mcp"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _vault_dir():
    """Resolve the CT vault directory (env override wins; never created)."""
    env_dir = os.environ.get("CT_VAULT_DIR")
    if env_dir:
        return os.path.expanduser(env_dir)
    return os.path.expanduser(os.path.join("~", ".brain"))


def _emit(payload):
    """Single-line JSON to stdout, flushed; never raises."""
    try:
        sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def main():
    try:
        sidecar = _find_sidecar()
        vault = _vault_dir()
        vault_ok = os.path.isdir(vault)

        if sidecar is None and not vault_ok:
            _emit({
                "ct_status": "degraded",
                "hint": "curated-thoughts-mcp not found and vault dir missing; run ct_doctor",
            })
            return

        if sidecar is None:
            _emit({
                "ct_status": "degraded",
                "hint": "curated-thoughts-mcp not on PATH or /usr/bin; run ct_doctor",
            })
            return

        if not vault_ok:
            _emit({
                "ct_status": "degraded",
                "hint": "vault dir missing (set CT_VAULT_DIR or create ~/.brain); run ct_doctor",
            })
            return

        # Healthy: absolute quietness.
    except Exception:
        # Fail-open: swallow everything, block nothing.
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)

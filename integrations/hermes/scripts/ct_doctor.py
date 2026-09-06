#!/usr/bin/env python3
"""ct_doctor.py — install/health doctor for the Curated Thoughts Hermes plugin.

Part of curated-thoughts-integrations (MIT). Python 3 standard library only.
Read-only diagnostic: it NEVER writes to the vault, the brain, or any config
file. Runs 8 checks, each resolving to PASS / WARN / FAIL with a specific,
actionable fix hint.

Usage:
    ct_doctor.py check           Run all checks against the live system.
    ct_doctor.py check --json    Same, machine-readable output.
    ct_doctor.py --self-test     Run the embedded mock-sidecar test suite
                                 (no live sidecar or vault needed).

Exit codes: 0 = all PASS (or only WARN-free success), 1 = any FAIL,
2 = no FAIL but at least one WARN.

Spec: docs/spec-hermes-plugin-v0.md §5. Tier matrix: shared/compat.yaml.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

SIDECAR_NAME = "curated-thoughts-mcp"
# Dpkg-installed main sidecar location prefix (spec §5.1: disambiguate by path).
DPKG_BIN_PREFIXES = ("/usr/bin/", "/usr/local/bin/")
# Fallback location when the sidecar is not on PATH.
SYSTEM_FALLBACK = "/usr/bin/" + SIDECAR_NAME

# Where the Hermes plugin registers the MCP server.
HERMES_CONFIG = Path(
    os.environ.get("HERMES_CONFIG", str(Path.home() / ".hermes" / "config.yaml"))
)
MCP_SERVER_KEY = "curated-thoughts"

# Vault location: CT_VAULT_DIR overrides; default is the brain root that the
# sidecar manages (docs/architecture.md: sidecar, vault, OKF).
VAULT_DIR = Path(os.environ.get("CT_VAULT_DIR", str(Path.home() / ".brain")))

# Embedding backends: cloud keys OR a local Ollama. WARN-only check.
EMBED_ENV_KEYS = (
    "CT_EMBED_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "VOYAGE_API_KEY",
    "GEMINI_API_KEY",
)
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

# MCP handshake timeout (seconds) — the sidecar must never hang the doctor.
MCP_TIMEOUT = 10.0

# Tier matrix, mirrored from shared/compat.yaml (keep in sync; file is the
# source of truth):
#   v2.4-read:  sidecar ">=2.4,<2.5"  tools: 8   write_path: dormant
#   v2.5-full:  sidecar ">=2.5"       tools: 14  write_path: full
COMPAT_TIERS = (
    # (name, min_version, max_version_exclusive, tools, write_path)
    ("v2.4-read", (2, 4), (2, 5), 8, "dormant"),
    ("v2.5-full", (2, 5), None, 14, "full"),
)

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"


class CheckResult:
    __slots__ = ("name", "status", "detail", "hint")

    def __init__(self, name, status, detail, hint=""):
        self.name = name
        self.status = status
        self.detail = detail
        self.hint = hint

    def as_dict(self):
        return {
            "name": self.name,
            "status": self.status,
            "detail": self.detail,
            "hint": self.hint,
        }


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _parse_version(text):
    """Extract a leading dotted version like '2.4.3' from free text."""
    m = re.search(r"\b(\d+)\.(\d+)(?:\.(\d+))?\b", text or "")
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def _tier_for(version):
    """Return the compat tier tuple for a sidecar version triple, or None."""
    v = version[:2]
    for name, lo, hi, tools, wp in COMPAT_TIERS:
        if v >= lo and (hi is None or v < hi):
            return (name, lo, hi, tools, wp)
    return None


def _read_text_file(path, limit=256 * 1024):
    try:
        return Path(path).read_text(errors="replace")[:limit]
    except OSError:
        return None


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------

def find_sidecar():
    """Locate the sidecar binary. Returns (path|None, resolved_path|None).

    path is what PATH lookup yields; resolved_path is that entry after
    symlink resolution, which is how we detect a same-named tools/ crate
    build shadowing the dpkg-installed main sidecar.
    """
    found = shutil.which(SIDECAR_NAME)
    if found:
        return found, os.path.realpath(found)
    if os.path.isfile(SYSTEM_FALLBACK):
        return SYSTEM_FALLBACK, os.path.realpath(SYSTEM_FALLBACK)
    return None, None


def check_sidecar_binary():
    """(1) sidecar binary present (PATH then /usr/bin fallback)."""
    path, _resolved = find_sidecar()
    if path:
        return CheckResult(
            "sidecar-binary",
            PASS,
            f"found {SIDECAR_NAME} at {path}",
        )
    return CheckResult(
        "sidecar-binary",
        FAIL,
        f"{SIDECAR_NAME} not found on PATH and {SYSTEM_FALLBACK} missing",
        "Install the curated-thoughts .deb (dpkg -i curated-thoughts_*.deb) "
        "or add the sidecar's directory to PATH.",
    )


def check_sidecar_identity(path, resolved):
    """(2) sidecar identity — warn if a same-named tools/ crate build
    shadows the dpkg one. Disambiguate by path, never by name."""
    if not path:
        return CheckResult(
            "sidecar-identity",
            WARN,
            "skipped: no sidecar binary found",
            "Resolve check 1 first; identity cannot be verified without a "
            "binary.",
        )
    resolved = resolved or os.path.realpath(path)
    if resolved.startswith(DPKG_BIN_PREFIXES):
        return CheckResult(
            "sidecar-identity",
            PASS,
            f"{path} resolves to the dpkg-installed sidecar ({resolved})",
        )
    hint = (
        f"'{path}' does not come from the dpkg install ({resolved}). A same-named "
        "build from a source checkout (e.g. tools/ or target/ dir) shadows the "
        "main sidecar — two servers on one brain is a bug. Remove the shadowing "
        "copy or reorder PATH so the dpkg path wins, e.g. put /usr/bin first "
        "for this binary or delete the stray build artifact."
    )
    return CheckResult("sidecar-identity", WARN, f"non-dpkg sidecar at {path}", hint)


def mcp_tools_list(path, timeout=MCP_TIMEOUT, env=None):
    """Speak minimal JSON-RPC over stdio: initialize → initialized → tools/list.

    Returns (tool_names|None, server_version|None, error|None).
    Never raises; every failure mode becomes (None, None, reason).
    """
    request = (
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "ct_doctor", "version": "0.1.0"},
                },
            }
        )
        + "\n"
        + json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
        + "\n"
        + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        + "\n"
    )
    run_env = dict(os.environ)
    if env:
        run_env.update(env)
    try:
        proc = subprocess.run(
            [path, "--mcp"],
            input=request,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=run_env,
        )
    except FileNotFoundError:
        return None, None, "binary disappeared"
    except PermissionError:
        return None, None, "binary not executable"
    except subprocess.TimeoutExpired:
        return None, None, f"timed out after {timeout:g}s"
    except OSError as exc:
        return None, None, f"spawn failed: {exc}"

    server_version = None
    tool_names = None
    error = None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue  # skip non-JSON log noise on stdout
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == 1 and "result" in msg:
            server_version = (msg["result"].get("serverInfo") or {}).get("version")
        elif msg.get("id") == 2:
            if "result" in msg:
                tool_names = [t.get("name", "?") for t in msg["result"].get("tools", [])]
            elif "error" in msg:
                error = "tools/list error: " + json.dumps(msg["error"])[:120]
    if tool_names is None and error is None:
        error = (
            "no tools/list response on stdout (stderr: "
            + (proc.stderr or "").strip().splitlines()[-1][:120]
            + ")"
            if (proc.stderr or "").strip()
            else "no tools/list response on stdout"
        )
    return tool_names, server_version, error


def check_sidecar_reachable(path, timeout=MCP_TIMEOUT, env=None):
    """(3) MCP tools/list reachable + tool count → tier classification."""
    if not path:
        return CheckResult(
            "sidecar-mcp",
            FAIL,
            "skipped: no sidecar binary found",
            "Install the curated-thoughts .deb so the MCP surface exists; "
            "without it the agent has no CT tools at all.",
        )
    tools, _server_version, error = mcp_tools_list(path, timeout=timeout, env=env)
    if tools is None:
        return CheckResult(
            "sidecar-mcp",
            FAIL,
            f"{SIDECAR_NAME} --mcp did not answer tools/list: {error}",
            "If it timed out, an old sidecar process may be wedged: kill all "
            f"{SIDECAR_NAME} processes and retry; if spawn failed, reinstall "
            "the .deb. Check ~/.brain/config.json is valid JSON.",
        )
    count = len(tools)
    if count >= 14:
        return CheckResult(
            "sidecar-mcp",
            PASS,
            f"{count} tools listed (full tier; write path active)",
        )
    if count >= 8:
        write_tools_present = "curated_add_wisdom" in tools
        extra = (
            "" if not write_tools_present else " (write tools present — unexpected at this count)"
        )
        return CheckResult(
            "sidecar-mcp",
            WARN,
            f"{count} tools listed — read-only tier; write path dormant{extra}",
            f"Only {count} tools exposed, so curated_add_wisdom and friends are "
            "absent and the write path is dormant. This matches the v2.4-read "
            "tier of an older (v2.4.x) sidecar: upgrade the curated-thoughts "
            ".deb to >=2.5 (v2.5-full) for the full 14-tool surface. "
            "Read-only routing still works.",
        )
    return CheckResult(
        "sidecar-mcp",
        WARN,
        f"{count} tools listed — below every known tier",
        f"Only {count} tools, fewer than even the v2.4-read tier (8). The "
        "sidecar may be partially broken: reinstall the curated-thoughts .deb "
        "and compare `curated-thoughts --version` with shared/compat.yaml.",
    )


def check_vault():
    """(4) vault path exists and is readable (CT_VAULT_DIR overrides default)."""
    vault = VAULT_DIR
    if not vault.exists():
        return CheckResult(
            "vault",
            FAIL,
            f"vault path {vault} does not exist (CT_VAULT_DIR={os.environ.get('CT_VAULT_DIR', '<unset>')})",
            "Create/restore the brain directory, or point CT_VAULT_DIR at the "
            "real one. If CT never ran on this machine, run the curated-thoughts "
            "app once to initialize it.",
        )
    if not vault.is_dir():
        return CheckResult(
            "vault",
            FAIL,
            f"vault path {vault} exists but is not a directory",
            f"Move or remove the file at {vault}; the sidecar expects a "
            "directory (brain.db + config.json) there.",
        )
    if not os.access(vault, os.R_OK | os.X_OK):
        return CheckResult(
            "vault",
            FAIL,
            f"vault path {vault} exists but is not readable by this user",
            f"Fix permissions: chmod u+rx {vault} (and check ownership with "
            "ls -ld) so the sidecar — and only the sidecar — can read it.",
        )
    return CheckResult("vault", PASS, f"vault at {vault} exists and is readable")


def check_embedding():
    """(5) embedding backend hint — env keys present or Ollama reachable.
    WARN-only: never fails, since local fastembed works without either."""
    present = [k for k in EMBED_ENV_KEYS if os.environ.get(k)]
    if present:
        return CheckResult(
            "embedding-backend",
            PASS,
            f"embedding API key present via {present[0]}",
        )
    host = os.environ.get("OLLAMA_HOST", OLLAMA_HOST)
    try:
        from urllib.parse import urlparse
        from urllib.request import urlopen

        parsed = urlparse(host if "//" in host else "http://" + host)
        url = f"{parsed.scheme or 'http'}://{parsed.netloc}/api/version"
        with urlopen(url, timeout=2.0) as resp:  # nosec - local service probe
            resp.read(256)
        return CheckResult(
            "embedding-backend",
            PASS,
            f"local Ollama reachable at {parsed.netloc}",
        )
    except Exception:
        return CheckResult(
            "embedding-backend",
            WARN,
            f"no embedding API key in env and Ollama not reachable at {host}",
            "Semantic search will fall back to the sidecar's local fastembed "
            "(slower, first-run model download). For better retrieval set an "
            "embedding API key in the environment or start Ollama "
            "(systemctl --user start ollama, or set OLLAMA_HOST).",
        )


def check_hermes_registration():
    """(6) curated-thoughts key present under mcp_servers in config.yaml.
    String scan — no yaml dependency."""
    text = _read_text_file(HERMES_CONFIG)
    if text is None:
        return CheckResult(
            "hermes-registration",
            FAIL,
            f"Hermes config not found at {HERMES_CONFIG}",
            "Run the Hermes onboarding once (hermes) to create config.yaml, "
            "or re-run install.sh from the plugin directory to write the "
            "mcp_servers block.",
        )
    # Narrow the scan to the mcp_servers section so an unrelated mention of
    # the plugin name elsewhere doesn't count as registration.
    m = re.search(r"^mcp_servers:\s*$", text, re.M)
    if not m:
        return CheckResult(
            "hermes-registration",
            FAIL,
            f"no mcp_servers section in {HERMES_CONFIG}",
            f"Add the block to {HERMES_CONFIG}:\n"
            "mcp_servers:\n"
            "  curated-thoughts:\n"
            "    command: curated-thoughts-mcp\n"
            '    args: ["--mcp"]\n'
            "or re-run install.sh, which appends it when absent.",
        )
    section = text[m.start() + len("mcp_servers:") :]
    nxt = re.search(r"^\S", section, re.M)  # next non-indented key ends the block
    if nxt:
        section = section[: nxt.start()]
    if not re.search(r"^\s{2,}" + re.escape(MCP_SERVER_KEY) + r":\s*$", section, re.M):
        return CheckResult(
            "hermes-registration",
            FAIL,
            f"mcp_servers has no '{MCP_SERVER_KEY}' entry in {HERMES_CONFIG}",
            f"Register the sidecar under mcp_servers in {HERMES_CONFIG}:\n"
            "  curated-thoughts:\n"
            "    command: curated-thoughts-mcp\n"
            '    args: ["--mcp"]\n'
            "or re-run install.sh (it never overwrites an existing entry).",
        )
    if "--mcp" not in section:
        return CheckResult(
            "hermes-registration",
            WARN,
            f"'{MCP_SERVER_KEY}' registered but args do not include --mcp",
            f"The entry in {HERMES_CONFIG} must pass --mcp to start the MCP "
            "server. Edit the args list to ['--mcp'] and restart Hermes.",
        )
    return CheckResult(
        "hermes-registration",
        PASS,
        f"mcp_servers.{MCP_SERVER_KEY} registered with --mcp in {HERMES_CONFIG}",
    )


def check_okf_hygiene():
    """(7) OKF hygiene pointer — static advisory, always PASS with a hint."""
    return CheckResult(
        "okf-hygiene",
        PASS,
        "advisory: OKF v0.1 notes need okf_version / profile / entity_type / "
        "created_at frontmatter; edits must match If-Match updated_at",
        "When writing vault notes use vault_write_note with OKF v0.1 "
        "frontmatter (okf_version, profile, entity_type, created_at) and on "
        "edits pass the exact current updated_at value for If-Match — a "
        "stale value returns a conflict, not silent loss. Never edit the "
        "brain's SQLite directly; route through MCP tools.",
    )


def check_version_compat(path):
    """(8) detected sidecar version vs tier matrix from shared/compat.yaml."""
    if not path:
        return CheckResult(
            "version-compat",
            WARN,
            "skipped: no sidecar binary found",
            "Resolve check 1 first; a missing sidecar has no version to "
            "compare against shared/compat.yaml.",
        )
    # Prefer the dpkg package database: MCP serverInfo.version reports the
    # MCP framework (e.g. rmcp) version, not the sidecar release version.
    version = None
    source = None
    try:
        out = subprocess.run(
            ["dpkg-query", "-W", "-f=${Version}", "curated-thoughts"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            version = _parse_version(out.stdout)
            source = f"dpkg curated-thoughts {out.stdout.strip()}"
    except (OSError, subprocess.SubprocessError):
        pass
    if version is None:
        _tools, server_version, _err = mcp_tools_list(path)
        if server_version:
            candidate = _parse_version(server_version)
            if candidate and candidate >= (1, 0) and candidate <= (30, 0):
                version = candidate
                source = f"serverInfo.version={server_version!r}"
    if version is None:
        return CheckResult(
            "version-compat",
            WARN,
            f"could not determine {SIDECAR_NAME} version",
            "Neither MCP serverInfo nor dpkg-query revealed a version. Run "
            "'dpkg -l curated-thoughts' by hand and compare with "
            "shared/compat.yaml tiers (v2.4-read: >=2.4,<2.5; v2.5-full: >=2.5).",
        )
    tier = _tier_for(version)
    if tier:
        name, lo, hi, tools, wp = tier
        rng = f">={lo[0]}.{lo[1]}" + (f",<{hi[0]}.{hi[1]}" if hi else "")
        return CheckResult(
            "version-compat",
            PASS,
            f"sidecar {version[0]}.{version[1]}.{version[2]} ({source}) → "
            f"tier {name} ({rng}, "
            f"{tools} tools, write path {wp})",
        )
    return CheckResult(
        "version-compat",
        WARN,
        f"sidecar version {version[0]}.{version[1]}.{version[2]} ({source}) "
        "is outside every tier in shared/compat.yaml",
        "The running sidecar predates 2.4 (or is a pre-release). Upgrade to "
        "the latest curated-thoughts .deb; tiers are v2.4-read (>=2.4,<2.5, "
        "8 tools) and v2.5-full (>=2.5, 14 tools).",
    )


# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------

def run_checks(timeout=MCP_TIMEOUT, env=None):
    """Run all 8 checks; returns list of CheckResult."""
    results = []
    path, resolved = find_sidecar()
    results.append(check_sidecar_binary())
    results.append(check_sidecar_identity(path, resolved))
    results.append(check_sidecar_reachable(path, timeout=timeout, env=env))
    results.append(check_vault())
    results.append(check_embedding())
    results.append(check_hermes_registration())
    results.append(check_okf_hygiene())
    results.append(check_version_compat(path))
    return results


def exit_code_for(results):
    if any(r.status == FAIL for r in results):
        return 1
    if any(r.status == WARN for r in results):
        return 2
    return 0


def format_text(results):
    lines = []
    for r in results:
        lines.append(f"[{r.status}] {r.name}: {r.detail}")
        if r.hint:
            lines.append(f"       fix: {r.hint}")
    codes = {FAIL: 1, WARN: 2}
    n_fail = sum(1 for r in results if r.status == FAIL)
    n_warn = sum(1 for r in results if r.status == WARN)
    lines.append(
        f"\n{n_fail} FAIL, {n_warn} WARN, {len(results) - n_fail - n_warn} PASS "
        f"— exit {exit_code_for(results)}"
    )
    return "\n".join(lines)


def cmd_check(json_output=False):
    results = run_checks()
    if json_output:
        summary = {
            "exit_code": exit_code_for(results),
            "checks": [r.as_dict() for r in results],
        }
        print(json.dumps(summary, indent=2))
    else:
        print(format_text(results))
    return exit_code_for(results)


# --------------------------------------------------------------------------
# self-test: mock-sidecar fixture suite (embedded)
# --------------------------------------------------------------------------

def _self_test_suite():
    # tests/ lives at the repo root; this script is
    # integrations/hermes/scripts/ct_doctor.py — resolve relative to __file__
    # so the self-test works from any cwd and any checkout layout.
    tests_dir = Path(__file__).resolve().parents[3] / "tests"
    sys.path.insert(0, str(tests_dir))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import test_ct_doctor
    except ImportError:
        # allow an alternate layout where tests sit next to the script
        import importlib.util

        candidate = tests_dir / "test_ct_doctor.py"
        if not candidate.exists():
            raise
        spec = importlib.util.spec_from_file_location("test_ct_doctor", candidate)
        module = importlib.util.module_from_spec(spec)
        sys.modules["test_ct_doctor"] = module
        spec.loader.exec_module(module)
        test_ct_doctor = module
    return unittest.defaultTestLoader.loadTestsFromModule(test_ct_doctor)


def cmd_self_test():
    suite = _self_test_suite()
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="ct_doctor.py",
        description="Curated Thoughts Hermes plugin doctor (read-only).",
    )
    sub = parser.add_subparsers(dest="command")
    p_check = sub.add_parser("check", help="run all checks against the live system")
    p_check.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--self-test", action="store_true", help="run the embedded mock-sidecar test suite")
    args = parser.parse_args(argv)

    if args.self_test:
        return cmd_self_test()
    if args.command == "check":
        return cmd_check(json_output=args.json)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

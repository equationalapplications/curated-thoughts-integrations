#!/usr/bin/env python3
"""ct_doctor.py — install/health doctor for the Curated Thoughts Hermes plugin.

Part of curated-thoughts-integrations (MIT). Python 3 standard library only.
Read-only diagnostic: it NEVER writes to the vault, the brain, or any config
file. Each check resolves to PASS / WARN / FAIL with a specific, actionable
fix hint.

Usage:
    ct_doctor.py check           Run all checks against the live system.
    ct_doctor.py check --json    Same, machine-readable output.
    ct_doctor.py --self-test     Run the embedded mock-sidecar test suite
                                 (no live sidecar or brain needed).

Exit codes: 0 = all PASS, 1 = any FAIL, 2 = no FAIL but at least one WARN.

Spec: docs/spec-hermes-plugin-v0.md §5. Tier matrix: shared/compat.yaml.
Environment contract and platform discovery: scripts/ct_env.py.
Import pre-flight (curated-thoughts PR #188): scripts/ct_preflight.py.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ct_env  # noqa: E402
import ct_preflight  # noqa: E402

SIDECAR_NAME = ct_env.SIDECAR_NAME

# Where the Hermes plugin registers the MCP server.
HERMES_CONFIG = Path(
    os.environ.get("HERMES_CONFIG", str(Path.home() / ".hermes" / "config.yaml"))
)
MCP_SERVER_KEY = "curated-thoughts"
PLUGIN_NAME = "curated-thoughts"

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

# Tier matrix, mirrored from shared/compat.yaml (that file is the source of
# truth). Both tiers are verified against curated-thoughts' mcp_server.rs:
# v2.4.x registers 8 tools, v2.5.x registers 14.
COMPAT_TIERS = (
    # (name, min_version, max_version_exclusive, tools, write_path)
    ("v2.4-read", (2, 4), (2, 5), 8, "dormant"),
    ("v2.5-full", (2, 5), None, 14, "full"),
)
FULL_TIER_TOOLS = 14
READ_TIER_TOOLS = 8

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


def _tier_for_tool_count(count):
    """Tier implied by an observed tool count — the authoritative signal.

    The sidecar exposes no --version flag, and MCP serverInfo reports the rmcp
    framework version rather than the Curated Thoughts release. Tool count is
    what actually determines the capability surface, so it drives tiering and
    the version check is corroborating metadata only.
    """
    if count >= FULL_TIER_TOOLS:
        return "v2.5-full"
    if count >= READ_TIER_TOOLS:
        return "v2.4-read"
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
    """Locate the sidecar. Returns (path|None, resolved|None, source)."""
    return ct_env.find_sidecar()


def check_sidecar_binary(found=None):
    """(1) sidecar binary present (PATH, then platform install locations)."""
    path, _resolved, source = found if found else find_sidecar()
    if path:
        return CheckResult(
            "sidecar-binary",
            PASS,
            f"found {SIDECAR_NAME} at {path} (via {source})",
        )
    searched = ", ".join(str(p) for p in ct_env.sidecar_candidates())
    return CheckResult(
        "sidecar-binary",
        FAIL,
        f"{SIDECAR_NAME} not found on PATH or in any known install location",
        "Install Curated Thoughts from the project's releases page for your "
        "platform, or add the sidecar's directory to PATH. Searched: "
        f"{searched}",
    )


def check_sidecar_identity(path, resolved):
    """(2) sidecar identity — warn if a source-checkout build shadows the
    installed one. Two servers on one brain is a bug; disambiguate by path."""
    if not path:
        return CheckResult(
            "sidecar-identity",
            WARN,
            "skipped: no sidecar binary found",
            "Resolve check 1 first; identity cannot be verified without a "
            "binary.",
        )
    resolved = resolved or os.path.realpath(path)
    if ct_env.looks_like_dev_build(resolved):
        return CheckResult(
            "sidecar-identity",
            WARN,
            f"{path} resolves to a development build ({resolved})",
            f"'{path}' looks like a build output from a source checkout "
            "(a target/ or tools/ directory), not an installed Curated "
            "Thoughts. A same-named dev build shadowing the installed sidecar "
            "gives two servers on one brain. Remove the stray build, or "
            "reorder PATH so the installed sidecar wins.",
        )
    kind = ct_env.install_kind(resolved)
    return CheckResult(
        "sidecar-identity",
        PASS,
        f"{path} resolves to an installed sidecar ({resolved}, {kind})",
    )


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
                    "clientInfo": {"name": "ct_doctor", "version": "0.2.0"},
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


def check_sidecar_reachable(path, timeout=MCP_TIMEOUT, env=None, brain_paths=None):
    """(3) MCP tools/list reachable + tool count → tier classification."""
    if not path:
        return CheckResult(
            "sidecar-mcp",
            FAIL,
            "skipped: no sidecar binary found",
            "Install Curated Thoughts so the MCP surface exists; without it "
            "the agent has no CT tools at all.",
        )
    tools, _server_version, error = mcp_tools_list(path, timeout=timeout, env=env)
    if tools is None:
        config_path = (brain_paths or ct_env.resolve_brain_paths()).config_path
        return CheckResult(
            "sidecar-mcp",
            FAIL,
            f"{SIDECAR_NAME} --mcp did not answer tools/list: {error}",
            "If it timed out, an old sidecar process may be wedged: kill all "
            f"{SIDECAR_NAME} processes and retry; if spawn failed, reinstall "
            f"Curated Thoughts. Check {config_path} is valid JSON.",
        )
    count = len(tools)
    if count >= FULL_TIER_TOOLS:
        return CheckResult(
            "sidecar-mcp",
            PASS,
            f"{count} tools listed (v2.5-full tier; write path active)",
        )
    if count >= READ_TIER_TOOLS:
        write_tools_present = "curated_add_wisdom" in tools
        extra = (
            "" if not write_tools_present else " (write tools present — unexpected at this count)"
        )
        return CheckResult(
            "sidecar-mcp",
            WARN,
            f"{count} tools listed — v2.4-read tier; write path dormant{extra}",
            f"Only {count} tools exposed, so curated_add_wisdom and friends "
            "are absent and the write path is dormant. This matches the "
            "v2.4-read tier: upgrade Curated Thoughts to >=2.5 for the full "
            f"{FULL_TIER_TOOLS}-tool surface. Read-only routing still works.",
        )
    if count == 0:
        return CheckResult(
            "sidecar-mcp",
            FAIL,
            "sidecar answered tools/list with 0 tools — broken install",
            "The MCP handshake succeeded but the sidecar exposed no tools at "
            "all. This is a broken install, not an older tier: reinstall "
            "Curated Thoughts and re-run ct_doctor.",
        )
    return CheckResult(
        "sidecar-mcp",
        WARN,
        f"{count} tools listed — below every known tier",
        f"Only {count} tools, fewer than even the v2.4-read tier "
        f"({READ_TIER_TOOLS}). The sidecar may be partially broken: reinstall "
        "Curated Thoughts and compare its version with shared/compat.yaml.",
    )


def check_brain_dir(brain_paths=None):
    """(4) brain directory exists and is readable.

    This is the directory holding brain.db and config.json — resolved exactly
    as Curated Thoughts resolves it (CURATED_BRAIN_DIR, default ~/.brain).
    It is NOT the vault; see check_vault.
    """
    paths = brain_paths or ct_env.resolve_brain_paths()
    brain = paths.brain_dir
    env_note = os.environ.get(ct_env.ENV_BRAIN_DIR) or "<unset, default ~/.brain>"
    if not brain.exists():
        return CheckResult(
            "brain-dir",
            FAIL,
            f"brain directory {brain} does not exist "
            f"({ct_env.ENV_BRAIN_DIR}={env_note})",
            f"Point {ct_env.ENV_BRAIN_DIR} at the real brain directory, or run "
            "the Curated Thoughts app once to initialize it. When importing a "
            "brain from another machine, set "
            f"{ct_env.ENV_BRAIN_DIR} to the imported directory.",
        )
    if not brain.is_dir():
        return CheckResult(
            "brain-dir",
            FAIL,
            f"brain path {brain} exists but is not a directory",
            f"Move or remove the file at {brain}; the sidecar expects a "
            "directory containing brain.db and config.json.",
        )
    if not os.access(brain, os.R_OK | os.X_OK):
        return CheckResult(
            "brain-dir",
            FAIL,
            f"brain directory {brain} is not readable by this user",
            f"Fix permissions: chmod u+rx {brain} (check ownership with ls -ld).",
        )
    missing = [n for n, p in (("brain.db", paths.db_path), ("config.json", paths.config_path))
               if not p.exists()]
    if missing:
        return CheckResult(
            "brain-dir",
            WARN,
            f"brain directory {brain} exists but is missing {', '.join(missing)}",
            "Run the Curated Thoughts app once to initialize the brain, or "
            "run `curated-thoughts --onboard` to create config.json. An "
            "imported brain must carry brain.db and config.json together.",
        )
    return CheckResult(
        "brain-dir",
        PASS,
        f"brain at {brain} (db + config present)",
    )


def check_vault(brain_paths=None):
    """(5) the vault the brain actually points at.

    The vault is the documents tree, and its path lives in config.json under
    `vault_path` — it is machine-specific, so it is the first thing that
    breaks when a brain is imported from another machine.
    """
    paths = brain_paths or ct_env.resolve_brain_paths()
    config, err = ct_env.read_brain_config(paths.config_path)
    if config is None:
        return CheckResult(
            "vault",
            FAIL,
            f"cannot read vault_path: {paths.config_path} {err}",
            "Run `curated-thoughts --onboard` to create a valid config.json, "
            "or repair it by hand. `curated-thoughts --doctor` reports the "
            "config problem in more detail.",
        )
    vault, verr = ct_env.resolve_vault_path(config)
    if vault is None:
        return CheckResult(
            "vault",
            FAIL,
            f"{verr} ({paths.config_path})",
            "Set vault_path in config.json to the documents directory this "
            "brain indexes, or run `curated-thoughts --onboard --vault <dir>`.",
        )
    if not vault.exists():
        return CheckResult(
            "vault",
            FAIL,
            f"vault {vault} (from {paths.config_path}) does not exist",
            "This is the usual symptom of a brain imported from another "
            "machine: vault_path is an absolute path that only existed on the "
            "source machine. Re-point it at this machine's documents "
            "directory (`curated-thoughts --onboard --vault <dir>`).",
        )
    if not vault.is_dir():
        return CheckResult(
            "vault",
            FAIL,
            f"vault path {vault} exists but is not a directory",
            f"vault_path in {paths.config_path} must name a directory.",
        )
    if not os.access(vault, os.R_OK | os.X_OK):
        return CheckResult(
            "vault",
            FAIL,
            f"vault {vault} is not readable by this user",
            f"Fix permissions: chmod u+rx {vault}.",
        )
    return CheckResult("vault", PASS, f"vault at {vault} exists and is readable")


def check_embedding():
    """(6) embedding backend hint — env keys present or Ollama reachable.
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
    """(7) curated-thoughts registered under mcp_servers, and the plugin
    enabled under plugins. String scan — no yaml dependency."""
    text = _read_text_file(HERMES_CONFIG)
    if text is None:
        return CheckResult(
            "hermes-registration",
            FAIL,
            f"Hermes config not found at {HERMES_CONFIG}",
            "Run Hermes onboarding once to create config.yaml, or re-run "
            "install.sh from the plugin directory to print the mcp_servers "
            "block.",
        )
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
    # The plugins half: Hermes enables plugins via `plugins.enabled`.
    if not re.search(r"^plugins:\s*$", text, re.M):
        return CheckResult(
            "hermes-registration",
            WARN,
            f"mcp_servers.{MCP_SERVER_KEY} is registered, but {HERMES_CONFIG} "
            "has no plugins section",
            f"The MCP tools will work, but the plugin's skills and "
            f"session-start hook stay dormant. Add to {HERMES_CONFIG}:\n"
            "plugins:\n"
            "  enabled:\n"
            f"    - {PLUGIN_NAME}",
        )
    if not re.search(r"^\s+-\s+" + re.escape(PLUGIN_NAME) + r"\s*$", text, re.M):
        return CheckResult(
            "hermes-registration",
            WARN,
            f"mcp_servers.{MCP_SERVER_KEY} is registered, but '{PLUGIN_NAME}' "
            "is not listed under plugins.enabled",
            f"Add '{PLUGIN_NAME}' to the plugins.enabled list in "
            f"{HERMES_CONFIG} so its skills and session-start hook load.",
        )
    return CheckResult(
        "hermes-registration",
        PASS,
        f"mcp_servers.{MCP_SERVER_KEY} registered with --mcp, and plugin "
        f"'{PLUGIN_NAME}' enabled, in {HERMES_CONFIG}",
    )


def check_import_preflight(path=None, brain_paths=None):
    """(8) import pre-flight: is this brain safe for an agent to trust?

    Replaces the old static okf-hygiene advisory with a check that actually
    inspects the brain. Two failure modes matter, both from curated-thoughts
    PR #188 (issue #186):

      * the engine's setup() rewrite destroys structured source_ref values,
        so a brain carrying JSON refs is damaged on the next app launch;
      * an imported brain brings that exposure with it, and arrives on a
        machine whose engine version decides what happens next.

    Read-only: the database is opened through a mode=ro URI.
    """
    paths = brain_paths or ct_env.resolve_brain_paths()
    engine_version, engine_source = ct_preflight.detect_engine_version(sidecar_path=path)
    engine_note = (
        f"engine core-llm-wiki {engine_version}"
        if engine_version
        else "engine version unknown"
    )

    census = ct_preflight.census_source_refs(paths.db_path)
    if census.error:
        return CheckResult(
            "import-preflight",
            WARN,
            f"could not census source_ref rows: {census.error} ({engine_note})",
            "The brain database could not be read for the pre-flight census. "
            "If the brain is on another volume or still being imported, "
            f"re-run once {paths.db_path} is in place.",
        )
    if not census.table_present:
        return CheckResult(
            "import-preflight",
            PASS,
            f"no llm_wiki_entries table yet — nothing to verify ({engine_note})",
        )

    damaged = census.damaged
    at_risk = census.at_risk
    tokens = census.tokens
    has_evidence = census.evidence_table_present
    shape = census.shape()
    if not census.scoped:
        shape += "; UNSCOPED (no source_type column)"
    hints = "; ".join(f"{k} ×{v}" for k, v in sorted(census.recovery_hints.items()))

    if damaged:
        return CheckResult(
            "import-preflight",
            FAIL,
            f"{damaged} of {census.total} librarian_inferred entries have a "
            f"mangled source_ref ({shape}; {engine_note})"
            + (f" [recovery: {hints}]" if hints else ""),
            "These rows lost their evidence JSON to the engine's setup() "
            "back-rewrite (curated-thoughts issue #186): provenance display "
            "is empty and proposal-based retraction cannot match them. Do not "
            "treat this graph's provenance as trustworthy. The V18 repair "
            "migration in curated-thoughts PR #188 re-derives the evidence "
            "(outbox-first, then proposal lookup) and exports before it "
            "mutates; run it before relying on this brain.",
        )
    if at_risk:
        return CheckResult(
            "import-preflight",
            FAIL,
            f"{at_risk} of {census.total} librarian_inferred entries carry a "
            f"source_ref the engine will rewrite on next launch "
            f"({shape}; {engine_note})",
            "These rows still hold structured (JSON) source_ref values, or a "
            "whitespace-padded ref. core-llm-wiki's setup() selects them via "
            "its five-predicate migration selector and strips them through "
            "normalizeSourceRef on every app launch, destroying the evidence. "
            "Do not open this brain with the desktop app until Curated "
            "Thoughts carries the PR #188 structural fix (source_ref becomes "
            "an engine-proof token and evidence moves to librarian_evidence). "
            "The current engine pin, 7.1.0, still mangles.",
        )
    if tokens and has_evidence is False:
        # The whole table is absent: the export was not brain-complete. This
        # is an import-contract failure, distinct from individual rows going
        # missing (below), and it is not something the destination can heal.
        return CheckResult(
            "import-preflight",
            FAIL,
            f"{tokens} engine-proof token refs but no librarian_evidence "
            f"table ({shape}; {engine_note})",
            "This brain was written by a post-fix Curated Thoughts, but the "
            "CT-owned librarian_evidence table did not travel with it. The "
            "wiki entries survived; their provenance did not. PR #188 §2.5.5 "
            "defines a supported export as brain-complete — entries, "
            "evidence, chunks and proposals together. Re-export including "
            "librarian_evidence; an export copying only llm_wiki_entries "
            "silently drops every evidence link.",
        )
    if census.missing_evidence_rows:
        # Individual rows missing. PR #188 §2.3 rules these still-grounded
        # with a loud warning, never auto-purged — so this is a WARN, not a
        # FAIL: the graph is usable, the provenance for those rows is not.
        return CheckResult(
            "import-preflight",
            WARN,
            f"{census.missing_evidence_rows} of {tokens} token entries have no "
            f"librarian_evidence row ({shape}; {engine_note})",
            "Per PR #188 §2.3 these entries are treated as still-grounded and "
            "are never auto-purged, so nothing is being deleted — but their "
            "provenance cannot be displayed and retraction cannot resolve "
            "them. Most often a partial export or an interrupted import. "
            "Re-export brain-complete (§2.5.5) to restore the links.",
        )
    detail = (
        f"{census.total} librarian_inferred entries, all source_refs "
        f"engine-proof ({shape}; {engine_note})"
    )
    if census.unanchored_rows:
        # Phase 1 of §2.4 deliberately writes unanchored facts so the drop
        # rate can be measured before the policy flips to skip+log. Their
        # presence is expected, not a defect.
        detail += (
            f"; {census.unanchored_rows} unanchored evidence rows "
            "(expected under PR #188 §2.4 Phase 1 write-with-flag)"
        )
    return CheckResult("import-preflight", PASS, detail)


def check_version_compat(path, tool_count=None):
    """(9) sidecar version — corroborating metadata, not the tier authority.

    The sidecar exposes no --version flag and MCP serverInfo reports the rmcp
    framework version, so on most installs the release version is simply not
    discoverable. That is informational, never a warning: the tool count in
    check 3 is what determines the capability tier. This check exists to catch
    the case where a discoverable version *disagrees* with the observed tools.
    """
    observed_tier = _tier_for_tool_count(tool_count) if tool_count is not None else None

    version = None
    source = None
    # dpkg is a Linux-only convenience; its absence is not a problem.
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

    if version is None and observed_tier:
        return CheckResult(
            "version-compat",
            PASS,
            f"sidecar release version not discoverable on this platform; "
            f"tier {observed_tier} determined from the live tool count",
        )
    if version is None:
        return CheckResult(
            "version-compat",
            PASS,
            "sidecar release version not discoverable and no tool count "
            "available; see the sidecar-mcp check for the capability tier",
        )

    tier = _tier_for(version)
    vtxt = f"{version[0]}.{version[1]}.{version[2]}"
    if tier is None:
        return CheckResult(
            "version-compat",
            WARN,
            f"sidecar version {vtxt} ({source}) is outside every tier in "
            "shared/compat.yaml",
            "The installed Curated Thoughts predates 2.4 (or is a "
            "pre-release). Upgrade to the latest release; tiers are v2.4-read "
            f"(>=2.4,<2.5, {READ_TIER_TOOLS} tools) and v2.5-full (>=2.5, "
            f"{FULL_TIER_TOOLS} tools).",
        )
    name, lo, hi, tools, wp = tier
    rng = f">={lo[0]}.{lo[1]}" + (f",<{hi[0]}.{hi[1]}" if hi else "")
    if observed_tier and observed_tier != name:
        return CheckResult(
            "version-compat",
            WARN,
            f"version {vtxt} ({source}) implies tier {name}, but the live "
            f"sidecar exposed a {observed_tier} tool surface",
            "The installed package and the running sidecar disagree. A stale "
            "sidecar process may still be serving an older binary: kill all "
            f"{SIDECAR_NAME} processes so the next MCP call respawns the "
            "upgraded one, then re-run this doctor.",
        )
    return CheckResult(
        "version-compat",
        PASS,
        f"sidecar {vtxt} ({source}) → tier {name} ({rng}, {tools} tools, "
        f"write path {wp})",
    )


# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------

def run_checks(timeout=MCP_TIMEOUT, env=None):
    """Run all checks; returns list of CheckResult."""
    results = []
    path, resolved, source = find_sidecar()
    brain_paths = ct_env.resolve_brain_paths()

    results.append(check_sidecar_binary((path, resolved, source)))
    results.append(check_sidecar_identity(path, resolved))

    mcp_result = check_sidecar_reachable(
        path, timeout=timeout, env=env, brain_paths=brain_paths
    )
    results.append(mcp_result)

    # Reuse the observed tool count for the version cross-check rather than
    # spawning the sidecar a second time.
    tool_count = None
    m = re.match(r"^(\d+) tools listed", mcp_result.detail)
    if m:
        tool_count = int(m.group(1))

    results.append(check_brain_dir(brain_paths))
    results.append(check_vault(brain_paths))
    results.append(check_embedding())
    results.append(check_hermes_registration())
    results.append(check_import_preflight(path=path, brain_paths=brain_paths))
    results.append(check_version_compat(path, tool_count=tool_count))
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
    # --self-test is a global flag and must be accepted in any position,
    # including after the subcommand (`check --self-test`). Strip it out
    # ourselves rather than using parse_known_args, so every *other*
    # unrecognized option (e.g. `check --jsno`) still errors out.
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    self_test = "--self-test" in raw_argv
    args = parser.parse_args([a for a in raw_argv if a != "--self-test"])

    if self_test:
        return cmd_self_test()
    if args.command == "check":
        return cmd_check(json_output=args.json)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

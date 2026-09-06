"""Automated enforcement of the CONTRIBUTING.md architecture rules.

Three independent gate families (spec §5):
    gate_versions  — version/manifest hygiene
    gate_arch      — the architecture rules (Task 6)
    gate_compat    — compat.yaml drift (Task 7)

Every message names the offending file and the rule it enforces, because a
gate the author cannot act on is a gate they will route around.
"""
from __future__ import annotations

import ast
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

import yaml

import ct_ci_manifest

# A release exists to change what a user runs. Adding a missing unit test or
# fixing a typo in the README changes nothing a user runs, and forcing a bump
# for it trains maintainers to bump reflexively — which is how version numbers
# stop meaning anything (spec §5.1). The exemption is all-or-nothing: one
# shipped-code file in the same change and the bump is required again.
EXEMPT_PATTERNS = (
    "integrations/*/README.md",
    "integrations/*/CHANGELOG.md",
    "integrations/*/docs/*",
    "integrations/*/docs/**",
    "integrations/*/tests/*",
    "integrations/*/tests/**",
    "integrations/*/**/test_*.py",
    "integrations/*/**/*.test.ts",
)


def is_exempt(rel_path):
    """True when this path may change without requiring a version bump."""
    return any(
        fnmatch.fnmatch(rel_path, pattern)
        or fnmatch.fnmatch(rel_path, pattern.replace("/**", "/*/**"))
        for pattern in EXEMPT_PATTERNS
    ) or any(
        # fnmatch's '*' spans '/', so a two-segment prefix check covers nesting.
        rel_path.startswith(prefix)
        for prefix in _dir_prefixes(rel_path)
    )


def _dir_prefixes(rel_path):
    parts = rel_path.split("/")
    if len(parts) >= 3 and parts[0] == "integrations":
        for marker in ("tests", "docs"):
            if marker in parts[2:]:
                return [rel_path]
    return []


def changed_files(repo_root, base_ref):
    """Repo-relative POSIX paths that differ from base_ref."""
    result = subprocess.run(
        ["git", "diff", "--name-only", base_ref],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def _file_at_ref(repo_root, ref, rel_path):
    """File contents at a git ref, or None when the file did not exist."""
    result = subprocess.run(
        ["git", "show", f"{ref}:{rel_path}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    return result.stdout if result.returncode == 0 else None


def read_mirror(directory, mirror):
    """Read `plugin.yaml#version`-style references. None when absent."""
    filename, _, field = mirror.partition("#")
    path = Path(directory) / filename
    if not path.exists():
        return None
    if path.suffix in (".yaml", ".yml"):
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    else:
        import json

        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    return data.get(field)


def _semver_key(version):
    """Sort key for SemVer. A prerelease sorts below its release."""
    core, _, pre = str(version).partition("-")
    numbers = tuple(int(part) for part in core.split("."))
    return (numbers, 0 if pre else 1, pre)


def gate_versions(repo_root, base_ref):
    """Version/manifest hygiene (spec §5.1)."""
    repo_root = Path(repo_root)
    problems = []
    changed = set(changed_files(repo_root, base_ref)) if base_ref else set()

    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        rel_dir = f"integrations/{name}/"
        manifest_path = directory / "integration.yaml"
        problems.extend(ct_ci_manifest.validate_manifest(data, manifest_path))

        mirror = data.get("version_mirror")
        if mirror:
            mirrored = read_mirror(directory, mirror)
            if mirrored is None:
                problems.append(
                    f"{manifest_path}: version_mirror '{mirror}' does not resolve "
                    f"(spec §5.1)"
                )
            elif str(mirrored) != str(data.get("version")):
                problems.append(
                    f"{manifest_path}: version {data.get('version')!r} does not match "
                    f"{mirror} = {mirrored!r}. The CI manifest and the native manifest "
                    f"must agree (spec §5.1)."
                )

        touched = [p for p in changed if p.startswith(rel_dir)]
        material = [p for p in touched if not is_exempt(p)]
        if not material:
            continue

        old_manifest = _file_at_ref(repo_root, base_ref, f"{rel_dir}integration.yaml")
        if old_manifest is None:
            continue  # brand-new integration: nothing to bump from
        try:
            old_version = (yaml.safe_load(old_manifest) or {}).get("version")
        except yaml.YAMLError:
            problems.append(
                f"{rel_dir}integration.yaml at {base_ref}: is not valid YAML, so the "
                f"version bump cannot be verified (spec §5.1)."
            )
            continue
        new_version = data.get("version")
        try:
            bumped = _semver_key(new_version) > _semver_key(old_version)
        except (ValueError, TypeError):
            problems.append(
                f"{manifest_path}: version {new_version!r} cannot be compared "
                f"against {old_version!r}; versions must be numeric SemVer "
                f"2.0.0 (spec §5.1)."
            )
            continue
        if not bumped:
            problems.append(
                f"{rel_dir}: {len(material)} shipped file(s) changed "
                f"(e.g. {material[0]}) but version is still {new_version}. "
                f"It must be greater than {old_version} (spec §5.1). Docs and "
                f"tests are exempt; shipped code is not."
            )
            continue

        changelog = directory / "CHANGELOG.md"
        text = changelog.read_text(encoding="utf-8") if changelog.exists() else ""
        if f"## {new_version}" not in text:
            problems.append(
                f"{changelog}: no entry for version {new_version}. Add a "
                f"'## {new_version} — YYYY-MM-DD' section; the release body is "
                f"taken from it (spec §4.2, §5.1)."
            )
    return problems


# Modules a shipped script may import: the standard library, its own siblings,
# and the generated compat module. Everything else violates CONTRIBUTING rule 4.
STDLIB_ALLOWLIST = frozenset(sys.stdlib_module_names) | {
    "_compat_generated",
    "ct_env",
    "ct_doctor",
    "ct_preflight",
    "ct_status",
}

# CONTRIBUTING rule 3 / the environment contract: these three and nothing else.
CONTRACT_ENV_VARS = frozenset(
    {"CURATED_BRAIN_DIR", "CURATED_BRAIN_DB", "CURATED_BRAIN_CONFIG"}
)

# Any drive-letter path, not merely C:\Users\ — a hardcoded
# "C:\Program Files\..." binary location is just as machine-specific.
ABS_PATH_RE = re.compile(
    r"(^/Users/[^/\s]+)|(^/home/[^/\s]+)|(^[A-Za-z]:[\\/])"
)

_ENV_GETTERS = {"getenv", "get"}


def _is_env_lookup(node):
    """True for os.environ.get('X'), os.getenv('X') and os.environ['X']."""
    if isinstance(node, ast.Subscript):
        target = ast.unparse(node.value)
        return target.endswith("environ")
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr in _ENV_GETTERS:
            return ast.unparse(node.func.value).endswith(("environ", "os"))
    return False


def _env_name(node):
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
        return node.slice.value
    if isinstance(node, ast.Call) and node.args:
        first = node.args[0]
        if isinstance(first, ast.Constant):
            return first.value
    return None


def _string_constants(tree):
    """Yield (node, value) for string literals that are values, not docstrings."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstrings:
                yield node, node.value


def scan_python(path, rel, allow_sqlite):
    """Architecture violations in one Python file. rel is repo-relative POSIX."""
    problems = []
    source = Path(path).read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(rel))
    except SyntaxError as exc:
        return [f"{rel}:{exc.lineno}: syntax error, cannot audit ({exc.msg})"]

    in_fixtures = "/tests/fixtures/" in f"/{rel}"
    integration = rel.split("/")[1] if rel.startswith("integrations/") else None
    imports_sqlite = False

    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        for name in names:
            root = name.split(".")[0]
            if root == "integrations" or (
                name.startswith("integrations.")
            ):
                other = name.split(".")[1] if "." in name else ""
                if other != integration:
                    problems.append(
                        f"{rel}:{node.lineno}: cross-integration import of "
                        f"'{name}'. Nothing in one integration may depend on "
                        f"another (CONTRIBUTING rule: repository layout)."
                    )
                continue
            if root == "sqlite3":
                imports_sqlite = True
                if not allow_sqlite:
                    problems.append(
                        f"{rel}:{node.lineno}: imports sqlite3. Integrations reach "
                        f"the brain through the sidecar's MCP tools "
                        f"(CONTRIBUTING rule 6). A read-only census may be "
                        f"exempted via policy.allow_sqlite_readonly in "
                        f"integration.yaml."
                    )
                continue
            if root not in STDLIB_ALLOWLIST:
                problems.append(
                    f"{rel}:{node.lineno}: imports '{name}', which is not stdlib. "
                    f"Shipped scripts use the standard library only "
                    f"(CONTRIBUTING rule 4)."
                )

    for node, value in _string_constants(tree):
        if not in_fixtures and ABS_PATH_RE.search(value):
            problems.append(
                f"{rel}:{node.lineno}: hardcoded absolute or drive-letter path "
                f"{value!r}. No machine-specific content (CONTRIBUTING rule 3); "
                f"resolve paths at runtime."
            )

    for node in ast.walk(tree):
        if _is_env_lookup(node):
            name = _env_name(node)
            if (
                isinstance(name, str)
                and name.startswith("CURATED_")
                and name not in CONTRACT_ENV_VARS
            ):
                problems.append(
                    f"{rel}:{node.lineno}: reads '{name}'. The environment "
                    f"contract is exactly {sorted(CONTRACT_ENV_VARS)}; there are "
                    f"no integration-specific variables (README: the environment "
                    f"contract)."
                )

    # The exemption covers read-only census only, and only on the calls that
    # actually open the brain: every sqlite3.connect(...) in a declared file
    # must carry a 'mode=ro' URI (spec §5.2). Unrelated .connect() calls —
    # sockets, HTTP clients — are none of this gate's business.
    if allow_sqlite and imports_sqlite:
        for call in (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "connect"
            and ast.unparse(node.func.value).endswith("sqlite3")
        ):
            uri = "".join(
                node.value
                for arg in call.args
                for node in ast.walk(arg)
                if isinstance(node, ast.Constant) and isinstance(node.value, str)
            )
            if "mode=ro" not in uri:
                problems.append(
                    f"{rel}:{call.lineno}: sqlite3.connect(...) does not open the "
                    f"database with a 'mode=ro' URI. The "
                    f"policy.allow_sqlite_readonly exemption is for read-only "
                    f"census only (spec §5.2)."
                )
            elif not any(kw.arg == "uri" for kw in call.keywords):
                problems.append(
                    f"{rel}:{call.lineno}: sqlite3.connect(...) passes a 'mode=ro' "
                    f"URI without uri=True, so SQLite treats it as a plain file "
                    f"path. Open read-only with uri=True (spec §5.2)."
                )
    return problems


def gate_arch(repo_root):
    """The CONTRIBUTING architecture rules across integrations/ (spec §5.2)."""
    repo_root = Path(repo_root)
    problems = []
    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        exempt = set((data.get("policy") or {}).get("allow_sqlite_readonly") or [])
        for path in sorted(directory.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            rel_in_integration = path.relative_to(directory).as_posix()
            rel = path.relative_to(repo_root).as_posix()
            problems.extend(
                scan_python(path, rel, rel_in_integration in exempt)
            )
    return problems

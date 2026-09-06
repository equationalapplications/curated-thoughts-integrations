#!/usr/bin/env python3
"""ct_ci.py — monorepo CI tooling for curated-thoughts-integrations.

Runs in CI only and never ships to a user, so unlike everything under
integrations/, this may use PyYAML (spec §3.1).

Subcommands:
    validate    Schema-check every integration.yaml.
    generate    Render shared/compat.yaml into stdlib compat constants.
    discover    Emit the CI matrix as JSON for the workflow's discover job.

Exit codes: 0 = pass, 1 = a gate failed, 2 = usage error.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO_ROOT = Path(__file__).resolve().parents[1]


def _import(name):
    """Import a subcommand module lazily.

    Some subcommand modules (ct_ci_policy) read sys.stdlib_module_names at
    import time, which only exists on Python 3.10+.  Importing at dispatch
    time keeps the other subcommands (e.g. `package`) runnable on 3.9.
    """
    import importlib

    return importlib.import_module(name)


def cmd_validate(args):
    ct_ci_manifest = _import("ct_ci_manifest")
    errors = []
    for _id, _dir, data in ct_ci_manifest.discover_manifests(args.repo):
        errors.extend(ct_ci_manifest.validate_manifest(data, _dir / "integration.yaml"))
    for error in errors:
        print(f"FAIL {error}", file=sys.stderr)
    if errors:
        print(f"\n{len(errors)} manifest problem(s).", file=sys.stderr)
        return 1
    print("All integration manifests valid.")
    return 0


def cmd_generate(args):
    ct_ci_generate = _import("ct_ci_generate")
    if args.check:
        stale = ct_ci_generate.check_current(args.repo)
        for problem in stale:
            print(f"FAIL {problem}", file=sys.stderr)
        return 1 if stale else 0
    for path in ct_ci_generate.write_all(args.repo):
        print(f"wrote {path.relative_to(args.repo)}")
    return 0


GATES = {
    "versions": "gate_versions",
    "architecture": "gate_arch",
    "compat": "gate_compat",
}


def cmd_policy(args):
    ct_ci_policy = _import("ct_ci_policy")
    failures = []
    for name, gate_name in sorted(GATES.items()):
        gate = getattr(ct_ci_policy, gate_name)
        try:
            problems = (
                gate(args.repo, args.base) if name == "versions" else gate(args.repo)
            )
        except subprocess.CalledProcessError:
            print(
                f"FAIL [{name}] git could not resolve --base {args.base!r}; "
                f"pass a ref that exists in this repository (e.g. origin/main).",
                file=sys.stderr,
            )
            return 2
        for problem in problems:
            print(f"FAIL [{name}] {problem}", file=sys.stderr)
        failures.extend(problems)
        if not problems:
            print(f"ok   [{name}]")
    if failures:
        print(f"\n{len(failures)} policy violation(s).", file=sys.stderr)
        return 1
    return 0


def cmd_package(args):
    ct_ci_package = _import("ct_ci_package")
    try:
        integration_id, version = ct_ci_package.parse_tag(args.tag)
        directory, data = ct_ci_package._manifest(args.repo, integration_id)
        if str(data.get("version")) != version:
            print(
                f"FAIL tag {args.tag} declares {version} but "
                f"{directory}/integration.yaml says {data.get('version')}",
                file=sys.stderr,
            )
            return 1
        tarball = ct_ci_package.build(args.repo, integration_id, args.out)
        sums = ct_ci_package.write_checksums([tarball], args.out)
        body = ct_ci_package.changelog_section(directory, version)
    except ValueError as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1
    (Path(args.out) / "RELEASE_NOTES.md").write_text(body + "\n", encoding="utf-8")
    print(f"artifact={tarball}")
    print(f"checksums={sums}")
    print(f"prerelease={str(ct_ci_package.is_prerelease(version)).lower()}")
    return 0


def cmd_discover(args):
    ct_ci_discover = _import("ct_ci_discover")
    entries = ct_ci_discover.select(args.repo, args.base, args.all)
    print(json.dumps(entries))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ct_ci.py", description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=REPO_ROOT, help="repository root"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="schema-check every integration.yaml")
    generate = sub.add_parser("generate", help="render compat constants")
    generate.add_argument(
        "--check",
        action="store_true",
        help="fail if a generated file is missing or stale, writing nothing",
    )
    discover = sub.add_parser("discover", help="emit the CI matrix as JSON")
    discover.add_argument("--base", default=None, help="git ref to diff against")
    discover.add_argument(
        "--all", action="store_true", help="select every implemented integration"
    )
    policy = sub.add_parser("policy", help="run the repository policy gates")
    policy.add_argument(
        "--base",
        default=None,
        help="git ref to diff against for version hygiene (e.g. origin/main)",
    )
    package = sub.add_parser("package", help="build the artifact for a tag")
    package.add_argument("--tag", required=True, help="e.g. hermes-v0.2.1")
    package.add_argument("--out", type=Path, default=Path("dist"))

    args = parser.parse_args(argv)
    if args.command == "validate":
        return cmd_validate(args)
    if args.command == "generate":
        return cmd_generate(args)
    if args.command == "discover":
        return cmd_discover(args)
    if args.command == "policy":
        return cmd_policy(args)
    if args.command == "package":
        return cmd_package(args)
    parser.error(f"unknown command {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""ct_ci.py — monorepo CI tooling for curated-thoughts-integrations.

Runs in CI only and never ships to a user, so unlike everything under
integrations/, this may use PyYAML (spec §3.1).

Subcommands:
    validate    Schema-check every integration.yaml.

Exit codes: 0 = pass, 1 = a gate failed, 2 = usage error.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ct_ci_manifest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]


def cmd_validate(args):
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


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ct_ci.py", description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=REPO_ROOT, help="repository root"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="schema-check every integration.yaml")

    args = parser.parse_args(argv)
    if args.command == "validate":
        return cmd_validate(args)
    parser.error(f"unknown command {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())

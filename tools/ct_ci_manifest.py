"""Loading and validating integrations/<id>/integration.yaml.

Runs in CI only, never ships, so PyYAML is permitted here (spec §3.1).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "shared" / "integration.schema.json"
MANIFEST_NAME = "integration.yaml"

# PEP-440-free, SemVer 2.0.0 official expression.
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)


def load_manifest(path):
    """Parse a manifest file. Raises yaml.YAMLError on malformed input."""
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _schema():
    with open(SCHEMA_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _check_schema(data, schema, path, errors, prefix=""):
    """Validate the subset of JSON Schema the manifest schema uses.

    Deliberately hand-rolled over `jsonschema`: the vocabulary here is small
    and fixed, and one fewer CI dependency is one fewer thing to pin.
    """
    for key in schema.get("required", []):
        if key not in data:
            errors.append(f"{path}: missing required field '{prefix}{key}'")
    if schema.get("additionalProperties") is False:
        for key in data:
            if key not in schema.get("properties", {}):
                errors.append(f"{path}: unknown field '{prefix}{key}'")
    for key, rule in schema.get("properties", {}).items():
        if key not in data:
            continue
        value = data[key]
        where = f"{prefix}{key}"
        if "enum" in rule and value not in rule["enum"]:
            errors.append(
                f"{path}: field '{where}' must be one of {rule['enum']}, got {value!r}"
            )
        kind = rule.get("type")
        if kind == "string" and not isinstance(value, str):
            errors.append(f"{path}: field '{where}' must be a string")
        elif kind == "array":
            if not isinstance(value, list):
                errors.append(f"{path}: field '{where}' must be a list")
            elif len(value) < rule.get("minItems", 0):
                errors.append(f"{path}: field '{where}' must not be empty")
        elif kind == "object":
            if not isinstance(value, dict):
                errors.append(f"{path}: field '{where}' must be a mapping")
            else:
                _check_schema(value, rule, path, errors, prefix=f"{where}.")
        if isinstance(value, str) and "pattern" in rule:
            if not re.match(rule["pattern"], value):
                errors.append(
                    f"{path}: field '{where}' does not match {rule['pattern']}"
                )


def validate_manifest(data, path):
    """Return a list of error strings; empty means the manifest is valid."""
    errors = []
    if not isinstance(data, dict):
        return [f"{path}: manifest must be a YAML mapping"]

    _check_schema(data, _schema(), path, errors)

    version = data.get("version")
    if isinstance(version, str) and not SEMVER_RE.match(version):
        errors.append(f"{path}: version {version!r} is not valid SemVer 2.0.0")

    if data.get("status") == "implemented":
        for key in ("matrix", "checks", "version_mirror"):
            if key not in data:
                errors.append(
                    f"{path}: implemented integrations must declare '{key}'"
                )
        matrix = data.get("matrix") or {}
        wanted = "python" if data.get("language") == "python" else "node"
        if isinstance(matrix, dict) and wanted not in matrix:
            errors.append(
                f"{path}: language '{data.get('language')}' requires 'matrix.{wanted}'"
            )
        for unwanted in ({"python", "node"} - {wanted}):
            if isinstance(matrix, dict) and unwanted in matrix:
                errors.append(
                    f"{path}: language '{data.get('language')}' must not declare "
                    f"'matrix.{unwanted}'"
                )
    return errors


def discover_manifests(repo_root):
    """Return [(id, integration_dir, data)] for every manifest, sorted by id."""
    found = []
    for manifest in sorted((Path(repo_root) / "integrations").glob(f"*/{MANIFEST_NAME}")):
        found.append((manifest.parent.name, manifest.parent, load_manifest(manifest)))
    return sorted(found, key=lambda item: item[0])

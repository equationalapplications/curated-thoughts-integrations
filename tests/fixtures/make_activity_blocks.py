"""Generate tests/fixtures/activity_blocks.json: golden activity blocks.

The activity block (heading, `_for:` label, marker-first title line,
provenance, the `— supersedes` suffix of a correction, the 600-char cap and
its ellipsis) is rendered by Hermes's `ct_wisdom_activity.render_activity_block`
and by the TypeScript core's `renderActivityBlock`. This file records the
Hermes output for a few inputs; both suites check their renderer against it
(tests/tools/test_activity_block_golden.py and
packages/ct-wisdom-core/tests/activity_blocks.test.ts).

Run: python3 tests/fixtures/make_activity_blocks.py [out.json]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "integrations" / "hermes" / "scripts"))

import ct_wisdom_activity as act  # noqa: E402

EMOJI = "\U0001F600"

CASES = [
    {"name": "entry",
     "item": {"id": "fact_0e2e0000000000000000000a", "title": "CI rejects pushes when `pnpm test` fails.",
              "text": "In this repository, always run pnpm test before committing.", "provenance": "stated"},
     "superseded": [], "line": "run pnpm test"},
    {"name": "correction",
     "item": {"id": "fact_c0rrect10n000000000000b", "title": "Secrets live in .env.local",
              "text": "Use .env.local, never .env.", "provenance": "librarian_inferred"},
     "superseded": ["fact_01d00000000000000000000c", "fact_01d00000000000000000000d"],
     "line": "write .env.local"},
    {"name": "unlabeled provenance, multi-line title",
     "item": {"id": "f1", "title": "Two\nlines", "text": "body", "provenance": None},
     "superseded": [], "line": "read src/x.ts"},
    {"name": "truncated text with an emoji at the cut",
     "item": {"id": "f2", "title": "Long", "text": "w" * 3 + EMOJI * 700, "provenance": "stated"},
     "superseded": [], "line": "read src/long.ts"},
    {"name": "label over the cap",
     "item": {"id": "f3", "title": "T", "text": "x", "provenance": "stated"},
     "superseded": [], "line": "read " + "d/" * 70 + "f.ts"},
    {"name": "forged marker in the fields",
     "item": {"id": "f4", "title": "evil ct-fact:x title", "text": "ct-fact:y body", "provenance": "stated"},
     "superseded": [], "line": "read a.ts"},
]


def main(out):
    cases = []
    for case in CASES:
        activity = act.Activity("read", "x", ("file", "k"), case["line"], "x")
        block = act.render_activity_block(case["item"], case["superseded"], activity)
        cases.append(dict(case, expected=block))
    Path(out).write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).with_name("activity_blocks.json")))

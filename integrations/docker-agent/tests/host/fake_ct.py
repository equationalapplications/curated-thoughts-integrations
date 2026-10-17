#!/usr/bin/env python3
"""fake_ct.py — a stdlib stand-in for the `ct` CLI, for the host contract.

Answers the identity probe (`--help` names Curated Thoughts), the capability
probe (`wisdom match --help`), `recall … --json` and `wisdom match --json …`
from the JSON file named by $FAKE_CT_FACTS:

  {"recall": [{"id", "title", "text"}], "match": {"<query>": [{"id", ...}]}}

Every invocation's argv is appended to $FAKE_CT_LOG (JSON Lines). Test
infrastructure only; never shipped behavior.
"""

import json
import os
import sys


def main(argv):
    log = os.environ.get("FAKE_CT_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\n")
    if argv[:1] == ["--help"]:
        print("Curated Thoughts command line (fake)")
        return 0
    if argv[:3] == ["wisdom", "match", "--help"]:
        print("usage: ct wisdom match")
        return 0
    with open(os.environ["FAKE_CT_FACTS"], encoding="utf-8") as handle:
        facts = json.load(handle)
    if argv[:1] == ["recall"]:
        print(json.dumps({"wiki": facts.get("recall", [])}))
        return 0
    if argv[:2] == ["wisdom", "match"]:
        query = argv[argv.index("--") + 1] if "--" in argv else ""
        exclude = {a.split("=", 1)[1] for a in argv if a.startswith("--exclude=")}
        entries = [dict(f, provenance=f.get("provenance", "stated"), score=0.8)
                   for f in facts.get("match", {}).get(query, []) if f["id"] not in exclude]
        print(json.dumps({"entries": entries, "corrections": [], "gate": "semantic-v1:fake"}))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

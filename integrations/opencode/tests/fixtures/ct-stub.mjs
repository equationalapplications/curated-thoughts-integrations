#!/usr/bin/env node
// ct-stub.mjs — TEST-ONLY stand-in for the Curated Thoughts `ct` CLI. Never
// shipped. Used by the unit hook tests, the real-binary host contract and the
// live e2e so no embedding backend or brain is needed (leg spec LD11/LD12).
// Install it as an executable named `ct` on PATH.
//
// Behaviour (env-configured; the plugin passes its env to every spawn):
//   ct --help                       → identity line ("Curated Thoughts"), exit 0
//   ct recall <q> --json --k N      → {"wiki": $CT_STUB_RECALL}            (default [])
//   ct wisdom match --help          → exit $CT_STUB_MATCH_HELP_EXIT          (default 0)
//   ct wisdom match --json --max N [--exclude=<id>…] -- <query>
//        → {"entries": $CT_STUB_MATCH minus excluded ids (unless
//           CT_STUB_IGNORE_EXCLUDE=1), first N, "corrections": []}
//   CT_STUB_MATCH_ACTIVITY, when set, answers the autonomous-work calls
//        (`--max 1`) instead of CT_STUB_MATCH (same exclude rule).
//   CT_STUB_MATCH_TIMEOUT=1 makes `wisdom match` hang (timeout path).
// Every invocation appends one JSON line {argv} to $CT_STUB_LOG when set.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.CT_STUB_LOG) {
  try {
    appendFileSync(process.env.CT_STUB_LOG, `${JSON.stringify({ argv })}\n`);
  } catch {
    /* logging is best-effort */
  }
}

const json = (name, fallback) => {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch {
    return fallback;
  }
};

if (argv[0] === '--help') {
  process.stdout.write('ct — Curated Thoughts CLI (test stub)\n');
  process.exit(0);
}

if (argv[0] === 'recall') {
  process.stdout.write(JSON.stringify({ wiki: json('CT_STUB_RECALL', []) }));
  process.exit(0);
}

if (argv[0] === 'wisdom' && argv[1] === 'match') {
  if (argv.includes('--help')) {
    process.stdout.write('usage: ct wisdom match [--json] [--max N] [--exclude=ID] -- QUERY\n');
    process.exit(Number(process.env.CT_STUB_MATCH_HELP_EXIT ?? '0'));
  }
  if (process.env.CT_STUB_MATCH_TIMEOUT === '1') {
    setTimeout(() => process.exit(0), 60_000);
  } else {
    const maxAt = argv.indexOf('--max');
    const max = maxAt >= 0 ? Number(argv[maxAt + 1]) : 2;
    const exclude = new Set(argv.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice('--exclude='.length)));
    let entries = max === 1 && process.env.CT_STUB_MATCH_ACTIVITY ? json('CT_STUB_MATCH_ACTIVITY', []) : json('CT_STUB_MATCH', []);
    if (process.env.CT_STUB_IGNORE_EXCLUDE !== '1') entries = entries.filter((e) => !exclude.has(e.id));
    process.stdout.write(JSON.stringify({ entries: entries.slice(0, max), corrections: [] }));
    process.exit(0);
  }
} else {
  process.stderr.write(`ct-stub: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

#!/usr/bin/env node
// Deterministic stub `ct` for the OpenClaw live capture (AC 9). Logs every argv.
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(require('path').join(__dirname, '..', 'ct-calls.jsonl'), JSON.stringify(args) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o));
if (args.length === 1 && args[0] === '--help') { process.stdout.write('Curated Thoughts (stub)\n'); process.exit(0); }
if (args[0] === 'recall') {
  out({ wiki: [{ id: 'boot-procedures', title: 'Procedures', text: 'Prefer small reversible changes.' }] });
  process.exit(0);
}
if (args[0] === 'wisdom' && args[1] === 'match') {
  if (args.includes('--help')) { process.stdout.write('usage: ct wisdom match\n'); process.exit(0); }
  const max = Number(args[args.indexOf('--max') + 1]);
  const ex = new Set(args.filter((a) => a.startsWith('--exclude=')).map((a) => a.slice(10)));
  const facts = [
    { id: 'w-release', title: 'Release flow', text: 'Releases are tagged by the controller after merge, never in the PR.' },
    { id: 'w-lockfile', title: 'Lockfiles', text: 'Lockfiles are written with pnpm 9.15.9.' },
    { id: 'w-third', title: 'Third fact', text: 'A third fact for turn two.' },
  ];
  out({ entries: facts.filter((f) => !ex.has(f.id)).slice(0, max), corrections: [] });
  process.exit(0);
}
process.exit(1);

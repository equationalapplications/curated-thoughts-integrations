#!/usr/bin/env node
// vendor_core.mjs — post-tsc build step (leg spec LD3).
//
// The installed OpenCode payload ships WITHOUT node_modules/ (registration.ts
// copies lib/ + package.json only), so a bare `@equational-applications/
// ct-wisdom-core` import in lib/ would throw at plugin load and take the whole
// plugin down — v0 health block included. This step:
//   1. copies the built shared core (packages/ct-wisdom-core/lib) into
//      lib/ct-wisdom-core/ — the same staging release.yml performs, so the two
//      are idempotent;
//   2. rewrites that one bare specifier in lib/**/*.js to the relative path of
//      lib/ct-wisdom-core/index.js.
// Fails loudly when the core has not been built (pnpm copies `file:` deps at
// install time; build the core first: `(cd packages/ct-wisdom-core && pnpm run build)`).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPECIFIER = '@equational-applications/ct-wisdom-core';
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(PKG, 'lib');
const DEST = join(LIB, 'ct-wisdom-core');

// Prefer the monorepo build; fall back to the pnpm-installed copy (same bytes).
const sources = [
  resolve(PKG, '..', '..', 'packages', 'ct-wisdom-core', 'lib'),
  join(PKG, 'node_modules', '@equational-applications', 'ct-wisdom-core', 'lib'),
];
const source = sources.find((dir) => existsSync(join(dir, 'index.js')));
if (source === undefined) {
  process.stderr.write(
    'vendor_core: ct-wisdom-core build output not found — build it first:\n' +
      '  (cd packages/ct-wisdom-core && pnpm run build)\n',
  );
  process.exit(1);
}

if (resolve(source) !== resolve(DEST)) {
  rmSync(DEST, { recursive: true, force: true });
  cpSync(source, DEST, { recursive: true });
}

function jsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (full === DEST) continue; // never rewrite the vendored core itself
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const pattern = new RegExp(`(['"])${SPECIFIER.replace(/[/.-]/g, (c) => `\\${c}`)}\\1`, 'g');
let rewritten = 0;
for (const file of jsFiles(LIB)) {
  const text = readFileSync(file, 'utf8');
  if (!pattern.test(text)) continue;
  pattern.lastIndex = 0;
  let rel = relative(dirname(file), join(DEST, 'index.js')).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  writeFileSync(file, text.replace(pattern, (_m, q) => `${q}${rel}${q}`));
  rewritten++;
}
process.stdout.write(`vendor_core: vendored ${relative(PKG, DEST)} (${rewritten} file(s) rewritten)\n`);

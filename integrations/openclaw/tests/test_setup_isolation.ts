/**
 * The process-wide scratch HOME (tests/setup-home.ts, vitest setupFiles)
 * ran before this file: every child and in-process call in the suite
 * inherits a scratch home and brain, never the developer's real ones
 * (live-brain incident, 2026-10-17).
 */

import { realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { relative, isAbsolute, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/** `child` is strictly inside `parent` (plain path comparison). */
function isUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

describe('test setup: process-wide scratch HOME', () => {
  it('HOME is a scratch dir under the OS tmpdir, not the real home, and the brain is under it', () => {
    const home = process.env.HOME ?? '';
    expect(home).not.toBe('');
    // Symlinks resolved on both sides (macOS: /var -> /private/var).
    expect(isUnder(realpathSync(home), realpathSync(tmpdir()))).toBe(true);
    expect(home).not.toBe(userInfo().homedir);
    expect(process.env.USERPROFILE).toBe(home);
    const brain = process.env.CURATED_BRAIN_DIR ?? '';
    expect(brain).not.toBe('');
    expect(isUnder(brain, home)).toBe(true);
  });
});

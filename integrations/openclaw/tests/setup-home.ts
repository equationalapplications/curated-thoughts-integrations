/**
 * Vitest setup file (vitest.config.ts `test.setupFiles`): before any test
 * file runs, point HOME, USERPROFILE, the XDG base dirs and
 * CURATED_BRAIN_DIR at a fresh scratch dir. Every child process and
 * in-process call in the suite then inherits a scratch home, so no test
 * can reach the developer's real home or brain (live-brain incident,
 * 2026-10-17). Tests that pass their own env still may; this is the floor.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'ct-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
process.env.XDG_STATE_HOME = join(home, '.local', 'state');
process.env.XDG_CACHE_HOME = join(home, '.cache');
process.env.CURATED_BRAIN_DIR = join(home, 'brain');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

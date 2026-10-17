/**
 * activity_blocks.test.ts — golden activity blocks shared with Hermes
 * (tests/fixtures/activity_blocks.json, generated from Hermes's
 * `ct_wisdom_activity.render_activity_block` by
 * tests/fixtures/make_activity_blocks.py; Hermes checks the same file in
 * tests/tools/test_activity_block_golden.py). The TS renderer must produce
 * the same bytes: heading, label, marker-first title line, provenance, a
 * correction's `— supersedes` suffix and the code-point cap.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderActivityBlock } from '../src/index.js';
import type { Activity } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/activity_blocks.json', import.meta.url));

interface BlockCase {
  name: string;
  item: { id: string; title: string; text: string; provenance: string | null };
  superseded: string[];
  line: string;
  expected: string;
}

describe('golden activity blocks (Hermes parity)', () => {
  it('renders every shared case byte for byte, a correction included', () => {
    const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BlockCase[];
    expect(cases.some((c) => c.superseded.length > 0)).toBe(true);
    for (const c of cases) {
      const activity: Activity = { verb: 'read', target: 'x', key: 'k', line: c.line, query: 'x' };
      expect(renderActivityBlock(c.item, c.superseded, activity), c.name).toBe(c.expected);
    }
  });
});

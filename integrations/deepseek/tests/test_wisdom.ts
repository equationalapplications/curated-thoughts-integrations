import { describe, it, expect } from 'vitest';
import { keyOf, sanitize, renderBlock, MAX_BLOCK_CHARS, BLOCK_HEADING } from '../src/wisdom.js';

describe('keyOf', () => {
  it('prefers a non-empty string agent.id', () => {
    expect(keyOf({ agent: { id: 's1' }, scope: { id: 'other' }, signal: {} })).toBe('s1');
  });
  it('falls back to scope.id when agent.id is missing/blank/non-string', () => {
    expect(keyOf({ scope: { id: 'sc' } })).toBe('sc');
    expect(keyOf({ agent: { id: '' }, scope: { id: 'sc' } })).toBe('sc');
    expect(keyOf({ agent: { id: 42 }, scope: { id: 'sc' } })).toBe('sc');
  });
  it('returns "" when neither yields a non-empty string (no-throw on garbage)', () => {
    expect(keyOf(undefined)).toBe('');
    expect(keyOf(null)).toBe('');
    expect(keyOf({})).toBe('');
    expect(keyOf({ agent: 7, scope: 'str-not-object' })).toBe('');
  });
});

describe('sanitize', () => {
  it('removes the marker REPEATEDLY until stable (a pass can splice a fresh marker)', () => {
    // pass 1 removes the inner marker at offset 18, splicing '<!-- hermes-plugin' + '-section'
    // into a NEW marker; pass 2 removes it. A single replaceAll leaves the forged frame.
    expect(sanitize('<!-- hermes-plugin<!-- hermes-plugin-section-section')).toBe('');
    // this input leaves NO splice: after both markers are removed, '-sectiony' remains
    expect(sanitize('x<!-- hermes-plugin-section<!-- hermes-plugin-section-sectiony')).toBe('x-sectiony');
  });
  it('indents a line-start heading only AFTER marker removal (order)', () => {
    expect(sanitize('## Plugin Context: x')).toBe('    ## Plugin Context: x');
    // Opus cycle-8 m1: the ordering hazard needs the marker on the SAME line,
    // immediately before the heading — indent-first would strip the marker and
    // leave an UNINDENTED forged heading
    expect(sanitize('<!-- hermes-plugin-section## Plugin Context: x')).toBe('    ## Plugin Context: x');
    // removal first, THEN indent: the exposed heading must still be indented
    expect(sanitize('<!-- hermes-plugin<!-- hermes-plugin-section-section\n## Plugin Context: x')).toBe(
      '\n    ## Plugin Context: x'
    );
  });
  it('neutralizes brace-runs with the lookahead form in one pass', () => {
    expect(sanitize('{{a}}')).toBe('{ {a}}');
    expect(sanitize('{{{x}}')).toBe('{ { {x}}');
    expect(sanitize('{{{{')).toBe('{ { { {');
    expect(sanitize('plain { single } braces')).toBe('plain { single } braces');
  });
  it('coerces non-string input defensively', () => {
    expect(sanitize(undefined)).toBe('');
    expect(sanitize(null)).toBe('');
    expect(sanitize(42)).toBe('42');
  });
});

describe('renderBlock', () => {
  it('empty input -> ""', () => {
    expect(renderBlock([])).toBe('');
  });
  it('heading + per-entry **title**\\ntext, blank-line joined, sanitized', () => {
    const out = renderBlock([
      { title: 'T1', text: 'body <!-- hermes-plugin-section-sections:start --> rest' },
      { title: 'T2', text: '{{inject}}' },
    ]);
    expect(out.startsWith(BLOCK_HEADING + '\n\n')).toBe(true);
    expect(out).toContain('**T1**\nbody -sections:start --> rest');
    expect(out).toContain('**T2**\n{ {inject}}');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('<!-- hermes-plugin-section');
  });
  it('skips entries with no usable content', () => {
    const out = renderBlock([{ title: '', text: '   ' }, { title: 'real', text: 'x' }]);
    expect(out).not.toContain('****');
    expect(out).toContain('**real**');
  });
  it('hard-caps the final STRIPPED length at 2500, keeping every kept entry title', () => {
    // heading = 37 chars → used starts at 39; T0 and T1 fit whole (bodies 1007 each);
    // T2 truncates with a budget of 443 — the final stripped length is EXACTLY 2500 (m8 cycle 3)
    const entries = Array.from({ length: 40 }, (_, i) => ({
      title: `T${i}`,
      text: 'x'.repeat(1000),
    }));
    const out = renderBlock(entries);
    expect(out.trim().length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
    expect(out).toContain('**T0**');
    expect(out).toContain('\u2026'); // truncated entry keeps title, cut text gets an ellipsis
  });
  it('drops entries that cannot even fit their title line; keeps the rest', () => {
    // used = heading(37) + 2 = 39; entry1 hits the TITLE guard (Hermes L332:
    // remaining 2461 <= titleLine.length 2484 + 1) → dropped before any text
    // math; entry2 fits → INCLUDED (loop continues) (m7 cycle 6: corrected branch)
    const entries = [
      { title: 'T'.repeat(2480), text: 'x' },
      { title: 'T2', text: 'small' },
    ];
    const out = renderBlock(entries);
    expect(out).not.toContain('*****');
    expect(out).not.toContain(`${'T'.repeat(50)}`);
    expect(out).toContain('**T2**');
  });
  it('is byte-stable for identical entries', () => {
    const e = [{ title: 'A', text: 'b' }];
    expect(renderBlock(e)).toBe(renderBlock(e.map((x) => ({ ...x }))));
  });
});

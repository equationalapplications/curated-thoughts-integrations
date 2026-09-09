import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEEPSEEK_SKILLS_ROOT = join(__dirname, '../skills');
const HERMES_SKILLS_ROOT = join(__dirname, '../../hermes/skills');

const SKILL_NAMES = ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar'] as const;

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function readBody(name: string, root: string): string {
  return stripFrontmatter(readFileSync(join(root, name, 'SKILL.md'), 'utf8'));
}

/**
 * The verbatim/equality mandate covers the SHARED body only. Harness-specific
 * content legitimately differs between the Hermes and dsh copies (sanctioned
 * ruling on the final branch review), so it is normalized — stripped and
 * replaced with a canonical placeholder — on BOTH sides before comparison:
 *
 *   1. The doctor-invocation sentence in "First move: run the doctor":
 *      Hermes ships `ct_doctor.py`, dsh ships `node lib/scripts/ct_doctor.js`.
 *   2. Doctor-check list item 7 ("Harness registration"): each harness's
 *      registration check is described in its own harness's terms
 *      (~/.hermes/config.yaml vs cordis.yml).
 *   3. Whole `## Registration in <Harness>` sections (each documents its own
 *      registration mechanics).
 *
 * Anything NOT covered by these three rules must remain byte-identical.
 */
function normalizeHarnessSpecific(body: string): string {
  return body
    // (1) doctor invocation sentence (the "It reports PASS / WARN / FAIL"
    // continuation on the same line is shared body and must survive)
    .replace(/^Run the plugin's .*?before guessing\./m, "Run the plugin's doctor before guessing.")
    // (2) doctor-check list item 7 (multi-line; ends right before item 8)
    .replace(
      /7\. \*\*Harness registration\*\* —[\s\S]*?(?=\n8\. )/,
      '7. **Harness registration** (harness-specific description).',
    )
    // (3) "Registration in <Harness>" section: heading through the next
    // heading (exclusive)
    .replace(/^## Registration in [\s\S]*?(?=\n## )/m, '## Registration (harness-specific).\n');
}

describe('deepseek skill files ship', () => {
  for (const name of SKILL_NAMES) {
    it(`${name}/SKILL.md exists`, () => {
      expect(() => readFileSync(join(DEEPSEEK_SKILLS_ROOT, name, 'SKILL.md'), 'utf8')).not.toThrow();
    });
  }
});

describe('deepseek skills match Hermes (shared body; harness-specific sections normalized)', () => {
  for (const name of SKILL_NAMES) {
    it(`${name}/SKILL.md body matches Hermes after harness-specific normalization`, () => {
      const deepseekBody = readBody(name, DEEPSEEK_SKILLS_ROOT);
      const hermesBody = readBody(name, HERMES_SKILLS_ROOT);
      expect(normalizeHarnessSpecific(deepseekBody)).toBe(normalizeHarnessSpecific(hermesBody));
    });
  }

  it('normalization does not silently equalize arbitrary content', () => {
    // Guard against the normalizer becoming a no-op-everything: it must NOT
    // equalize bodies that differ outside the harness-specific rules.
    const a = readBody('curated-thoughts-usage', DEEPSEEK_SKILLS_ROOT);
    expect(normalizeHarnessSpecific(a)).toBe(normalizeHarnessSpecific(a));
    expect(normalizeHarnessSpecific(a + '\nstray\n')).not.toBe(normalizeHarnessSpecific(a));
  });
});

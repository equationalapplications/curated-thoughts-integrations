/**
 * test_skills_content.ts — the packaged skills satisfy OpenCode's SKILL.md
 * contract (spec §8) and preserve the harness-agnostic guidance verbatim.
 *
 * OpenCode recognizes only name/description/license/compatibility/metadata in
 * skill frontmatter; `name` must equal the directory name and match
 * ^[a-z0-9]+(-[a-z0-9]+)*$; `description` must be 1–1024 chars. The routing
 * reminders, sidecar-mediated write rules, provenance cautions and OKF
 * guidance are harness-agnostic — the content test pins their key terms so a
 * later edit cannot silently drop them.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(PKG_ROOT, 'skills');

const SKILL_NAMES = ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar'] as const;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Only these frontmatter keys are recognized by OpenCode's skill loader.
const RECOGNIZED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);

interface Frontmatter {
  [key: string]: string;
}

/** Minimal YAML frontmatter parser: `key: value` lines between --- markers. */
function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  expect(text.startsWith('---\n'), 'SKILL.md must start with a --- frontmatter block').toBe(true);
  const end = text.indexOf('\n---', 4);
  expect(end).toBeGreaterThan(0);
  const block = text.slice(4, end);
  const body = text.slice(end + 4);
  const data: Frontmatter = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    expect(m, `frontmatter line is a flat "key: value" pair: ${JSON.stringify(line)}`).toBeTruthy();
    data[m![1]] = m![2];
  }
  return { data, body };
}

function skillSource(name: string): string {
  return readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
}

describe('packaged skills', () => {
  it('ships exactly the three skill directories', () => {
    expect(readdirSync(SKILLS_DIR).sort()).toEqual([...SKILL_NAMES].sort());
  });

  for (const name of SKILL_NAMES) {
    describe(name, () => {
      const text = skillSource(name);
      const { data, body } = parseFrontmatter(text);

      it('frontmatter parses and uses only recognized keys', () => {
        const unknown = Object.keys(data).filter((k) => !RECOGNIZED_KEYS.has(k));
        expect(unknown, 'unrecognized frontmatter keys').toEqual([]);
      });

      it('name equals the directory name and matches the OpenCode pattern', () => {
        expect(data.name).toBe(name);
        expect(data.name).toMatch(NAME_RE);
      });

      it('description is 1–1024 chars', () => {
        expect(data.description.length).toBeGreaterThanOrEqual(1);
        expect(data.description.length).toBeLessThanOrEqual(1024);
      });

      it('frontmatter matches integrations/hermes verbatim (harness-agnostic)', () => {
        const hermes = readFileSync(
          resolve(PKG_ROOT, '..', 'hermes', 'skills', name, 'SKILL.md'),
          'utf8',
        );
        expect(parseFrontmatter(hermes).data).toEqual(data);
      });

      it('keeps the harness-agnostic routing/writing guidance', () => {
        // Terms pinned per plan Step 6.2: routing reminders, sidecar-mediated
        // writes, provenance, OKF. Each skill pins the terms it actually
        // carries (the Hermes original is the reference; the byte-identical
        // test below covers usage/sidecar verbatim).
        expect(body).toContain('shared/compat.yaml');
        expect(body).toContain('curated_add_wisdom'); // the tier/write-path signal
      });
    });
  }

  describe('curated-thoughts-ops points at the OpenCode doctor', () => {
    const body = parseFrontmatter(skillSource('curated-thoughts-ops')).body;

    it('uses the OpenCode doctor invocation, not the Hermes one', () => {
      expect(body).toContain('node lib/scripts/ct_doctor.js check');
      expect(body).not.toContain('ct_doctor.py');
      expect(body).not.toContain('hermes doctor');
    });

    it('describes OpenCode registration, not plugin.yaml / config.yaml', () => {
      expect(body).toContain('mcp["curated-thoughts"]');
      expect(body).toContain('plugins/curated-thoughts.js');
      expect(body).not.toContain('plugin.yaml');
      expect(body).not.toContain('~/.hermes');
    });

    it('preserves the import pre-flight provenance guidance', () => {
      expect(body).toContain('source_ref');
      expect(body).toContain('librarian-[0-9a-f]{32}');
      expect(body).toContain('Export whole brains, not table subsets');
    });

    it('preserves the safe-routing rules verbatim', () => {
      expect(body).toContain('Report, don\'t improvise');
      expect(body).toContain('Never write out-of-band');
      expect(body).toContain('Tier mismatch ≠ failure');
      expect(body).toContain('Fail open');
    });
  });

  it('curated-thoughts-usage and -sidecar are byte-identical to Hermes (no Hermes-specific commands)', () => {
    for (const name of ['curated-thoughts-usage', 'curated-thoughts-sidecar'] as const) {
      const hermes = readFileSync(resolve(PKG_ROOT, '..', 'hermes', 'skills', name, 'SKILL.md'), 'utf8');
      expect(skillSource(name), name).toBe(hermes);
    }
  });

  it('the OKF guidance survives wherever the skill carries it', () => {
    // OKF frontmatter requirements live in curated-thoughts-usage.
    expect(parseFrontmatter(skillSource('curated-thoughts-usage')).body).toContain('OKF');
  });
});

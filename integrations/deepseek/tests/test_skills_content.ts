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

describe('deepseek skill files ship', () => {
  for (const name of SKILL_NAMES) {
    it(`${name}/SKILL.md exists`, () => {
      expect(() => readFileSync(join(DEEPSEEK_SKILLS_ROOT, name, 'SKILL.md'), 'utf8')).not.toThrow();
    });
  }
});

describe('deepseek skills are verbatim copies of Hermes (body-agnostic)', () => {
  for (const name of SKILL_NAMES) {
    it(`${name}/SKILL.md body matches Hermes`, () => {
      const deepseekBody = readBody(name, DEEPSEEK_SKILLS_ROOT);
      const hermesBody = readBody(name, HERMES_SKILLS_ROOT);
      expect(deepseekBody).toBe(hermesBody);
    });
  }
});

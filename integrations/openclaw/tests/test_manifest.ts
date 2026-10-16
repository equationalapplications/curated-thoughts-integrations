import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ciManifest = readFileSync(join(ROOT, 'integration.yaml'), 'utf8');

const SKILLS = ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar'];

describe('openclaw.plugin.json (native manifest, pin 2026.10.3 field set)', () => {
  it('identifies the plugin as curated-thoughts', () => {
    expect(manifest.id).toBe('curated-thoughts');
    expect(typeof manifest.configSchema).toBe('object');
  });

  it('declares skill directories that contain all three skills', () => {
    expect(Array.isArray(manifest.skills)).toBe(true);
    for (const dir of manifest.skills as string[]) {
      for (const name of SKILLS) {
        expect(existsSync(join(ROOT, dir, name, 'SKILL.md'))).toBe(true);
      }
    }
  });

  it('declares exactly the middleware runtime it registers (installed plugins are rejected otherwise)', () => {
    expect(manifest.contracts.agentToolResultMiddleware).toEqual(['openclaw']);
  });

  it('mounts the CT sidecar as a plugin-owned stdio MCP server', () => {
    expect(manifest.mcpServers['curated-thoughts']).toEqual({
      transport: 'stdio',
      command: 'curated-thoughts-mcp',
      args: ['--mcp'],
    });
  });

  it('is a startup hook plugin', () => {
    expect(manifest.activation.onStartup).toBe(true);
    expect(manifest.activation.onCapabilities).toContain('hook');
  });
});

describe('package.json#openclaw', () => {
  it('points the runtime entry at built JavaScript', () => {
    expect(pkg.openclaw.extensions).toEqual(['./lib/src/index.js']);
    expect(pkg.main).toBe('lib/src/index.js');
  });

  it('declares the plugin API floor at the verified pin', () => {
    expect(pkg.openclaw.compat.pluginApi).toBe('>=2026.10.3');
  });

  it('ships the manifest and skills', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['lib', 'skills', 'openclaw.plugin.json']));
  });

  it('keeps package, plugin and CI manifest versions in lockstep', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(ciManifest).toMatch(new RegExp(`^version: ${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
    expect(ciManifest).toMatch(/^language: node$/m);
    expect(ciManifest).toMatch(/^status: implemented$/m);
  });
});

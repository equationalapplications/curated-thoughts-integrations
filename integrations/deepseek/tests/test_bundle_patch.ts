/**
 * test_bundle_patch.ts — regression gate for the declarative install path.
 *
 * The MCP client is mounted by the shipped `cordis.patch.yml`, activated via
 * the package.json `"dsh": { "bundle": { "patch": ... } }` declaration when
 * `dsh plugin add` installs the package. If either half of that contract
 * drifts (declaration renamed, patch file dropped from `files`, a row
 * rewritten to a shape DSH does not parse), the plugin silently stops
 * loading — the exact failure mode of 0.1.2, which no CI check caught
 * because CI never boots real DSH.
 *
 * The patch file is checked textually: adding a YAML parser dependency for
 * one fixture is not worth it, and the row shapes below are pinned verbatim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  files?: string[];
  dsh?: { bundle?: { patch?: string } };
};

describe('dsh bundle declaration (package.json)', () => {
  it('declares the bundle patch the way DSH documents it', () => {
    // dsh plugin add reconciles dsh.profile.bundles from this exact key
    // (apps/cli/reference/README.md: "a package whose manifest declares
    // \"dsh\": { \"bundle\": { \"patch\": \"./cordis.patch.yml\" } }").
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
  });

  it('ships the patch file and install.sh in `files`', () => {
    for (const f of ['cordis.patch.yml', 'scripts/install.sh']) {
      expect(pkg.files ?? []).toContain(f);
    }
  });
});

describe('cordis.patch.yml rows', () => {
  const patch = readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8');

  it('inserts both rows in a single - insert: entry', () => {
    expect(patch).toMatch(/^- insert:/m);
  });

  it('carries this plugin as the curated-thoughts row', () => {
    expect(patch).toContain("id: curated-thoughts");
    expect(patch).toContain("name: '@equational-applications/dsh-curated-thoughts'");
  });

  it('mounts the MCP client as a separate stdio row', () => {
    // A bare `ctx.plugin(string, ...)` is rejected by cordis; the mount
    // must be declarative and name the client package, not the sidecar.
    expect(patch).toContain("id: mcp-curated-thoughts");
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain('transport: stdio');
    expect(patch).toContain('command: curated-thoughts-mcp');
    expect(patch).toContain('args: [--mcp]');
  });

  it('resolves the sidecar brain dir at composition time (no literal ~)', () => {
    // The sidecar does NOT expand a leading `~` — verified in the e2e
    // container: CURATED_BRAIN_DIR='~/.brain' is treated as a relative path
    // and the sidecar exits. The MCP row must therefore resolve the path
    // with a !!js composition-time expression.
    expect(patch).toMatch(/CURATED_BRAIN_DIR: !!js /);
    expect(patch).not.toMatch(/CURATED_BRAIN_DIR: *['"]?~/);
  });

  it('plugin and MCP rows share one brain-dir source', () => {
    // Both rows resolve CURATED_BRAIN_DIR from the same composition-time
    // expression so a profile override can target either uniformly. The
    // plugin row's `brainDir` carries the same !!js form (otherwise a
    // profile-side override of config.brainDir would drift away from the
    // MCP sidecar's env until apply() caught up).
    expect(patch).toMatch(/brainDir: !!js process\.env\.CURATED_BRAIN_DIR/);
    expect(patch).toMatch(/CURATED_BRAIN_DIR: !!js process\.env\.CURATED_BRAIN_DIR/);
  });

  it('never contains a bare - name: plugin row (unmatched patch target)', () => {
    // 0.1.2's installer appended `- name: ...` rows, which DSH reports as
    // unmatched patch targets and never activates.
    expect(patch).not.toMatch(/^- name:/m);
  });
});

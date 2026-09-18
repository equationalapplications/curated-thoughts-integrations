/**
 * test_registration.ts — propose() is the read-only half of the installer
 * (spec §4). It resolves the destination, renders the loader, plans the skill
 * copy and computes the comment-preserving config merge, and never mutates
 * the filesystem.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findNodeAtLocation, parse, parseTree } from 'jsonc-parser';
import {
  loaderTarget,
  propose,
  renderLoader,
  resolvePaths,
  SKILL_NAMES,
} from '../scripts/registration.js';
import {
  isolateProcessEnv,
  makeSandbox,
  PKG_ROOT,
  SKILLS,
  treeSnapshot,
  writeFile,
  type Sandbox,
} from './install_sandbox.js';

const TEMPLATE = readFileSync(join(PKG_ROOT, 'scripts', 'loader.js.tmpl'), 'utf8');
const OUR_ENTRY = {
  type: 'local',
  command: ['curated-thoughts-mcp', '--mcp'],
  enabled: true,
  environment: { CURATED_BRAIN_DIR: '/tmp/brain' },
};

// Creating symlinks on Windows needs admin rights or developer mode.
const CAN_SYMLINK = process.platform !== 'win32';

let sb: Sandbox;
let restoreEnv: () => void;

beforeEach(() => {
  sb = makeSandbox();
  restoreEnv = isolateProcessEnv(sb);
});

afterEach(() => {
  restoreEnv();
  sb.cleanup();
});

function run(extra: Partial<Parameters<typeof propose>[0]> = {}) {
  return propose({ env: sb.env, packageRoot: sb.pkg, ...extra });
}

function writeConfig(name: 'opencode.json' | 'opencode.jsonc', text: string): string {
  const p = join(sb.ocDir, name);
  writeFile(p, text);
  return p;
}

describe('resolvePaths', () => {
  it('uses XDG_CONFIG_HOME / XDG_DATA_HOME and defaults to opencode.json', () => {
    const p = resolvePaths(sb.env);
    expect(p.destination).toBe(join(sb.ocDir, 'opencode.json'));
    expect(p.payloadDir).toBe(sb.payloadDir);
    expect(p.loaderPath).toBe(sb.loaderPath);
    expect(p.skillsDir).toBe(join(sb.ocDir, 'skills'));
  });

  it('falls back to ~/.config and ~/.local/share without XDG vars', () => {
    const env = { ...sb.env };
    delete env.XDG_CONFIG_HOME;
    delete env.XDG_DATA_HOME;
    const p = resolvePaths(env);
    expect(p.destination).toBe(join(sb.home, '.config', 'opencode', 'opencode.json'));
    expect(p.payloadDir).toBe(join(sb.home, '.local', 'share', 'curated-thoughts', 'opencode'));
  });

  it('prefers an existing opencode.jsonc', () => {
    writeConfig('opencode.jsonc', '{}');
    expect(resolvePaths(sb.env).destination).toBe(join(sb.ocDir, 'opencode.jsonc'));
  });

  it('when both exist, picks opencode.jsonc (merged last) and warns', () => {
    writeConfig('opencode.json', '{}');
    writeConfig('opencode.jsonc', '{}');
    const p = resolvePaths(sb.env);
    expect(p.destination).toBe(join(sb.ocDir, 'opencode.jsonc'));
    expect(p.warnings.join('\n')).toMatch(/both .*opencode\.json.*opencode\.jsonc/i);
  });

  it('never targets OPENCODE_CONFIG, but warns that it overrides global config', () => {
    const custom = join(sb.root, 'custom.json');
    const p = resolvePaths({ ...sb.env, OPENCODE_CONFIG: custom });
    expect(p.destination).toBe(join(sb.ocDir, 'opencode.json'));
    expect(p.warnings.join('\n')).toContain(custom);
    expect(p.warnings.join('\n')).toMatch(/OPENCODE_CONFIG/);
  });
});

describe('propose — config merge', () => {
  it('adds mcp["curated-thoughts"] with the real shape and preserves unrelated keys', () => {
    writeConfig(
      'opencode.json',
      JSON.stringify({ theme: 'dark', mcp: { other: { type: 'remote', url: 'https://x' } } }, null, 2),
    );
    const proposal = run();
    expect(proposal.destination).toBe(join(sb.ocDir, 'opencode.json'));
    expect(proposal.mcp['curated-thoughts']).toEqual({
      type: 'local',
      command: ['curated-thoughts-mcp', '--mcp'],
      enabled: true,
      environment: { CURATED_BRAIN_DIR: '/tmp/brain' },
    });
    expect(proposal.config.action).toBe('edit');
    const after = parse(proposal.config.after!);
    expect(after.theme).toBe('dark');
    expect(after.mcp.other).toEqual({ type: 'remote', url: 'https://x' });
    expect(after.mcp['curated-thoughts']).toEqual(OUR_ENTRY);
  });

  it('creates a new config file with $schema when none exists', () => {
    const proposal = run();
    expect(proposal.config.action).toBe('create');
    const after = parse(proposal.config.after!);
    expect(after.$schema).toBe('https://opencode.ai/config.json');
    expect(after.mcp['curated-thoughts']).toEqual(OUR_ENTRY);
  });

  it('resolves CURATED_BRAIN_DIR the way ct_env does (default ~/.brain, absolute)', () => {
    const env = { ...sb.env };
    delete env.CURATED_BRAIN_DIR;
    const proposal = propose({ env, packageRoot: sb.pkg });
    expect(proposal.mcp['curated-thoughts'].environment).toEqual({
      CURATED_BRAIN_DIR: join(sb.home, '.brain'),
    });
  });

  it('keeps comments and trailing commas in a JSONC config', () => {
    const text = [
      '{',
      '  // my theme',
      '  "theme": "dark", /* inline */',
      '  "mcp": {',
      '    "other": { "type": "remote", "url": "https://x", },',
      '  },',
      '}',
      '',
    ].join('\n');
    writeConfig('opencode.jsonc', text);
    const proposal = run();
    expect(proposal.config.action).toBe('edit');
    expect(proposal.config.after).toContain('// my theme');
    expect(proposal.config.after).toContain('/* inline */');
    expect(proposal.config.after).toContain('"url": "https://x", }');
    expect(parse(proposal.config.after!).mcp['curated-thoughts']).toEqual(OUR_ENTRY);
  });

  it('never modifies the plugin array (byte-identical)', () => {
    const text = [
      '{',
      '  "plugin": [ "opencode-foo@1.2.3",   ["file:///x.js", { "a": 1 }] ], // keep',
      '  "mcp": {}',
      '}',
    ].join('\n');
    writeConfig('opencode.json', text);
    const proposal = run();
    const slice = (t: string) => {
      const node = findNodeAtLocation(parseTree(t)!, ['plugin'])!;
      return t.slice(node.offset, node.offset + node.length);
    };
    expect(slice(proposal.config.after!)).toBe(slice(text));
    expect(slice(text)).toBe('[ "opencode-foo@1.2.3",   ["file:///x.js", { "a": 1 }] ]');
  });

  it('adds no plugin array when there was none', () => {
    writeConfig('opencode.json', '{}');
    expect(parse(run().config.after!).plugin).toBeUndefined();
  });

  it('an existing disabled entry remains disabled and is a no-op', () => {
    writeConfig(
      'opencode.json',
      JSON.stringify({ mcp: { 'curated-thoughts': { ...OUR_ENTRY, enabled: false } } }),
    );
    const proposal = run();
    expect(proposal.mcp['curated-thoughts'].enabled).toBe(false);
    expect(proposal.config.action).toBe('unchanged');
    expect(proposal.conflicts).toEqual([]);
  });

  it('a bare { "enabled": false } stub is completed but stays disabled', () => {
    writeConfig('opencode.json', '{ "mcp": { "curated-thoughts": { "enabled": false } } }');
    const proposal = run();
    expect(proposal.mcp['curated-thoughts'].enabled).toBe(false);
    expect(proposal.config.action).toBe('edit');
    expect(parse(proposal.config.after!).mcp['curated-thoughts']).toEqual({ ...OUR_ENTRY, enabled: false });
  });

  it('an existing entry with a different command is preserved and reported as a conflict', () => {
    const theirs = { type: 'local', command: ['/opt/ct/curated-thoughts-mcp', '--mcp'], enabled: true };
    const text = JSON.stringify({ mcp: { 'curated-thoughts': theirs } }, null, 2);
    writeConfig('opencode.json', text);
    const proposal = run();
    expect(proposal.config.action).toBe('manual');
    expect(proposal.config.after).toBeNull();
    expect(proposal.mcp['curated-thoughts'].command).toEqual(theirs.command);
    expect(proposal.conflicts.join('\n')).toMatch(/different command/);
  });

  it('a duplicate alias pointing at the same binary is a conflict', () => {
    writeConfig(
      'opencode.json',
      JSON.stringify({ mcp: { brain: { type: 'local', command: ['/usr/bin/curated-thoughts-mcp', '--mcp'] } } }),
    );
    const proposal = run();
    expect(proposal.config.action).toBe('manual');
    expect(proposal.conflicts.join('\n')).toMatch(/mcp\.brain/);
  });

  it('an already-configured entry is a no-op', () => {
    writeConfig('opencode.json', JSON.stringify({ mcp: { 'curated-thoughts': OUR_ENTRY } }));
    const proposal = run();
    expect(proposal.config.action).toBe('unchanged');
    expect(proposal.conflicts).toEqual([]);
  });

  it('a layout too unusual to insert into safely is manual, never a false "unchanged"', () => {
    // A block comment opening after the last property and spanning lines.
    writeConfig('opencode.jsonc', '{\n  "theme": "dark" /* starts\n  ends */\n}\n');
    const proposal = run();
    expect(proposal.config.action).toBe('manual');
    expect(proposal.config.after).toBeNull();
    expect(proposal.conflicts.join('\n')).toMatch(/safe in-place edit/);
  });

  it('an unparseable config falls back to manual merge instructions', () => {
    writeConfig('opencode.jsonc', '{ "mcp": { oops ');
    const proposal = run();
    expect(proposal.config.action).toBe('manual');
    expect(proposal.config.after).toBeNull();
    expect(proposal.conflicts.join('\n')).toMatch(/parse/i);
    expect(proposal.config.block).toContain('"curated-thoughts"');
  });

  it.skipIf(!CAN_SYMLINK)('refuses a symlinked config file', () => {
    const real = join(sb.root, 'dotfiles', 'opencode.json');
    writeFile(real, '{}');
    mkdirSync(sb.ocDir, { recursive: true });
    symlinkSync(real, join(sb.ocDir, 'opencode.json'));
    const proposal = run();
    expect(proposal.config.action).toBe('manual');
    expect(proposal.conflicts.join('\n')).toMatch(/symlink/i);
  });

  it('--skip-config leaves the config alone and still prints the block', () => {
    writeConfig('opencode.json', '{}');
    const proposal = run({ skipConfig: true });
    expect(proposal.config.action).toBe('skipped');
    expect(proposal.config.after).toBeNull();
    expect(proposal.config.block).toContain('"curated-thoughts-mcp"');
  });
});

describe('propose — payload and loader', () => {
  it('plans the payload dir and a loader that re-exports it by file:// URL', () => {
    const proposal = run();
    expect(proposal.payloadDir).toBe(sb.payloadDir);
    expect(proposal.loader.path).toBe(sb.loaderPath);
    const url = pathToFileURL(join(sb.payloadDir, 'lib', 'src', 'index.js')).href;
    expect(proposal.loader.contents).toContain(`export { CuratedThoughts } from "${url}";`);
    expect(proposal.loader.contents).toMatch(/do not edit/);
    expect(proposal.loader.contents).toContain(`// Payload: ${sb.payloadDir}`);
    expect(proposal.loader.action).toBe('create');
    expect(proposal.payload.action).toBe('create');
  });

  it('a loader pointing at the same payload is a no-op', () => {
    writeFile(sb.loaderPath, renderLoader(TEMPLATE, sb.payloadDir));
    expect(run().loader.action).toBe('unchanged');
  });

  it('a loader pointing at a different payload is a conflict, not repointed', () => {
    writeFile(sb.loaderPath, renderLoader(TEMPLATE, join(sb.root, 'elsewhere')));
    const proposal = run();
    expect(proposal.loader.action).toBe('conflict');
    expect(proposal.conflicts.join('\n')).toContain(join(sb.root, 'elsewhere'));
  });

  it('a loader file we did not write is a conflict', () => {
    writeFile(sb.loaderPath, 'export const Mine = 1;\n');
    expect(run().loader.action).toBe('conflict');
  });

  it.skipIf(!CAN_SYMLINK)('a plugins/ dir that symlinks out of the config dir is refused', () => {
    const outside = join(sb.root, 'outside-plugins');
    mkdirSync(outside, { recursive: true });
    mkdirSync(sb.ocDir, { recursive: true });
    symlinkSync(outside, join(sb.ocDir, 'plugins'));
    const proposal = run();
    expect(proposal.loader.action).toBe('conflict');
    expect(proposal.conflicts.join('\n')).toMatch(/symlink/i);
  });

  it('replacing an existing payload is planned as replace', () => {
    mkdirSync(join(sb.payloadDir, 'lib'), { recursive: true });
    expect(run().payload.action).toBe('replace');
  });
});

describe('propose — skills', () => {
  it('plans three { from, to } copies into <config>/opencode/skills/<name>/SKILL.md', () => {
    expect([...SKILL_NAMES]).toEqual(SKILLS);
    const proposal = run();
    expect(proposal.skills).toHaveLength(3);
    for (const name of SKILLS) {
      expect(proposal.skills).toContainEqual(
        expect.objectContaining({
          from: join(sb.pkg, 'skills', name, 'SKILL.md'),
          to: join(sb.ocDir, 'skills', name, 'SKILL.md'),
          action: 'create',
        }),
      );
    }
  });

  it('an identical destination is a no-op; a different one is a conflict', () => {
    const [same, diff] = SKILLS;
    writeFile(join(sb.ocDir, 'skills', same!, 'SKILL.md'), readFileSync(join(sb.pkg, 'skills', same!, 'SKILL.md'), 'utf8'));
    writeFile(join(sb.ocDir, 'skills', diff!, 'SKILL.md'), 'user edits\n');
    const proposal = run();
    const by = Object.fromEntries(proposal.skills.map((s) => [s.name, s.action]));
    expect(by[same!]).toBe('unchanged');
    expect(by[diff!]).toBe('conflict');
    expect(proposal.conflicts.join('\n')).toContain(diff!);
  });

  it('a missing source skill is a warning, not a crash', () => {
    rmSync(join(sb.pkg, 'skills', 'curated-thoughts-ops'), { recursive: true });
    const proposal = run();
    expect(proposal.skills.find((s) => s.name === 'curated-thoughts-ops')!.action).toBe('missing-source');
    expect(proposal.warnings.join('\n')).toMatch(/curated-thoughts-ops/);
  });
});

describe('propose — no mutation', () => {
  it('leaves the filesystem untouched in every state', () => {
    writeConfig('opencode.jsonc', '{ // c\n "mcp": { "curated-thoughts": { "enabled": false } } }');
    writeFile(sb.loaderPath, 'export const Mine = 1;\n');
    writeFile(join(sb.ocDir, 'skills', 'curated-thoughts-usage', 'SKILL.md'), 'x');
    const before = treeSnapshot(sb.root);
    const proposal = run();
    expect(proposal.config.action).toBe('edit');
    expect(treeSnapshot(sb.root)).toEqual(before);
  });

  it('apply() refuses without CT_INSTALL_EDIT=1', async () => {
    const before = treeSnapshot(sb.root);
    await expect(run().apply()).rejects.toThrow(/CT_INSTALL_EDIT=1/);
    expect(treeSnapshot(sb.root)).toEqual(before);
  });
});

describe('loader template', () => {
  it('extracts the target payload entry from a rendered loader', () => {
    const dir = join(sb.root, 'p');
    expect(loaderTarget(renderLoader(TEMPLATE, dir))).toBe(join(dir, 'lib', 'src', 'index.js'));
    expect(loaderTarget('export const x = 1;')).toBeNull();
  });

  const posix = process.platform !== 'win32';
  const cases: Array<[string, string]> = [
    ['spaces', 'pay load dir'],
    ['non-ASCII', 'ünïcödé 空間 🧠'],
    // `"` is not a legal Windows filename character.
    ['quotes, hash and percent', posix ? `we"ird #1 50%` : 'weird #1 50%'],
    ...(posix ? ([['a newline (cannot escape the comment)', 'line\nthrow new Error("pwned")']] as Array<[string, string]>) : []),
  ];
  for (const [label, segment] of cases) {
    it(`a payload path with ${label} still loads as an ES module`, async () => {
      const payload = join(sb.root, segment, 'curated-thoughts', 'opencode');
      writeFile(join(payload, 'lib', 'src', 'index.js'), `export const CuratedThoughts = 'loaded';\n`);
      const contents = renderLoader(TEMPLATE, payload);
      expect(contents.split('\n').filter((l) => l !== '')).toHaveLength(3);
      const loader = join(sb.root, 'loader-check.mjs');
      writeFileSync(loader, contents);
      execFileSync(process.execPath, ['--check', loader]);
      // Import in a real Node child: vitest's own resolver mangles
      // percent-encoded file URLs, the runtime does not.
      const got = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const m = await import(process.argv[1]); process.stdout.write(String(m.CuratedThoughts));',
          pathToFileURL(loader).href,
        ],
        { encoding: 'utf8' },
      );
      expect(got).toBe('loaded');
      expect(loaderTarget(contents)).toBe(join(payload, 'lib', 'src', 'index.js'));
    });
  }
});

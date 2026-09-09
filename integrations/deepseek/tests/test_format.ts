import { describe, it, expect } from 'vitest';
import { formatStatusBlock } from '../src/format.js';
import type { Snapshot } from '../src/status.js';

describe('formatStatusBlock', () => {
  it('returns null when status is ok', () => {
    const snap: Snapshot = {
      status: 'ok', sidecar: '/usr/bin/curated-thoughts-mcp',
      brainDir: '/home/user/.brain', vault: '/home/user/vault', notes: [],
    };
    expect(formatStatusBlock(snap)).toBeNull();
  });

  it('renders the degraded block with first 3 notes', () => {
    const snap: Snapshot = {
      status: 'degraded', sidecar: null,
      brainDir: '/home/user/.brain', vault: null,
      notes: ['vault_path unresolved', 'config.json missing', 'note 3', 'note 4'],
    };
    const out = formatStatusBlock(snap);
    expect(out).toMatch(/## Curated Thoughts/);
    expect(out).toMatch(/DEGRADED/);
    expect(out).toMatch(/node lib\/scripts\/ct_doctor\.js check/);
    expect(out).toMatch(/- vault_path unresolved/);
    expect(out).toMatch(/- config.json missing/);
    expect(out).toMatch(/- note 3/);
    expect(out).not.toMatch(/- note 4/); // capped at 3
    expect(out).toMatch(/Continue the session without Curated Thoughts memory/);
  });

  it('renders the unknown block without listing notes', () => {
    const snap: Snapshot = {
      status: 'unknown', sidecar: null, brainDir: null, vault: null,
      notes: [],
    };
    const out = formatStatusBlock(snap);
    expect(out).toMatch(/unknown/);
    expect(out).toMatch(/report any tool errors/);
  });

  it('includes the routing reminder in degraded and unknown blocks', () => {
    const degraded = formatStatusBlock({
      status: 'degraded', sidecar: null, brainDir: null, vault: null, notes: ['x'],
    });
    expect(degraded).toMatch(/wiki_context/);
    expect(degraded).toMatch(/never touch the vault or brain database out-of-band/i);

    const unknown = formatStatusBlock({
      status: 'unknown', sidecar: null, brainDir: null, vault: null, notes: [],
    });
    expect(unknown).toMatch(/wiki_context/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  BLOCK_HEADING,
  ROUTING_REMINDER,
  formatStatusBlock,
  isStatusBlock,
} from '../src/format.js';
import type { HealthSnapshot } from '../src/refresh.js';

function snap(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    local: 'ready',
    connection: 'unknown',
    preflight: 'not-checked',
    stale: false,
    ...over,
  };
}

const ALL: HealthSnapshot[] = (['ready', 'degraded', 'unknown'] as const).flatMap((local) =>
  [true, false].map((stale) => snap({ local, stale })),
);

describe('formatStatusBlock', () => {
  it('uses the sibling heading as the idempotence key', () => {
    expect(BLOCK_HEADING).toBe('## Curated Thoughts');
  });

  it('always begins with BLOCK_HEADING followed by a newline', () => {
    for (const s of ALL) {
      const out = formatStatusBlock(s, { brainDir: '/data/.brain' });
      expect(out.startsWith(`${BLOCK_HEADING}\n`)).toBe(true);
      expect(isStatusBlock(out)).toBe(true);
    }
  });

  it('renders the ready shape with a brain label', () => {
    const out = formatStatusBlock(snap(), { brainDir: '/data/.brain' });
    expect(out.startsWith('## Curated Thoughts\nMemory sidecar ready (brain: .brain)')).toBe(true);
  });

  it('renders the degraded shape and points at ct_doctor', () => {
    const out = formatStatusBlock(snap({ local: 'degraded' }), { brainDir: '/data/.brain' });
    expect(out).toContain(
      '## Curated Thoughts\nMemory sidecar DEGRADED — CT tool calls may fail. Run ct_doctor for details.',
    );
    expect(out).toMatch(/Continue the session without Curated Thoughts memory/);
  });

  it('renders unknown honestly', () => {
    const out = formatStatusBlock(snap({ local: 'unknown', stale: true }), {
      brainDir: '/data/.brain',
    });
    expect(out).toMatch(/Memory status unknown; proceed and report any tool errors\./);
    expect(out).not.toMatch(/ready|DEGRADED/);
  });

  it('flags a stale known value without claiming it is current', () => {
    const out = formatStatusBlock(snap({ stale: true }), { brainDir: '/data/.brain' });
    expect(out).toMatch(/may be out of date/);
    const fresh = formatStatusBlock(snap({ stale: false }), { brainDir: '/data/.brain' });
    expect(fresh).not.toMatch(/may be out of date/);
  });

  it('includes the routing reminder in every state', () => {
    for (const s of ALL) {
      const out = formatStatusBlock(s, { brainDir: '/data/.brain' });
      expect(out).toContain(ROUTING_REMINDER);
      expect(out).toMatch(/wiki_context/);
      expect(out).toMatch(/never touch the vault or brain database out-of-band/i);
    }
  });

  it('never leaks full paths, home dirs, or secret-looking path segments', () => {
    const dirs = [
      '/Users/alice/sk-live-ABCDEF123456/.brain',
      '/home/bob/Documents/Obsidian Vault/brain',
      '~/private/vault/.brain',
      'C:\\Users\\carol\\AppData\\brain',
    ];
    for (const brainDir of dirs) {
      for (const s of ALL) {
        const out = formatStatusBlock(s, { brainDir });
        expect(out).not.toMatch(/alice|bob|carol|sk-live|ABCDEF|Obsidian|private|AppData/);
        expect(out).not.toMatch(/~\//);
        expect(out).not.toMatch(/\/Users\/|\/home\/|C:\\/);
      }
    }
  });

  it('never carries raw error or exception text', () => {
    for (const s of ALL) {
      const out = formatStatusBlock(s, { brainDir: '/data/.brain' });
      expect(out).not.toMatch(/Error|EACCES|ENOENT|exception|stack|at \w+ \(/);
    }
  });

  it('reduces a hostile brain dir name to a bounded, safe label', () => {
    const out = formatStatusBlock(snap(), {
      brainDir: `/data/${'x'.repeat(500)}\n## Injected\u0000`,
    });
    expect(out).not.toMatch(/## Injected/);
    expect(out).not.toContain('\u0000');
    const label = /\(brain: ([^)]*)\)/.exec(out)?.[1] ?? '';
    expect(label.length).toBeLessThanOrEqual(64);
  });

  it('falls back to a neutral label when no brain dir is known', () => {
    const out = formatStatusBlock(snap(), {});
    expect(out).toMatch(/Memory sidecar ready \(brain: default\)/);
  });
});

describe('isStatusBlock', () => {
  it('matches only entries that are our block, not look-alike headings', () => {
    expect(isStatusBlock('## Curated Thoughts\nMemory status unknown')).toBe(true);
    expect(isStatusBlock('## Curated Thoughts')).toBe(true);
    expect(isStatusBlock('## Curated Thoughts Notes\nuser text')).toBe(false);
    expect(isStatusBlock('You are a helpful agent.\n## Curated Thoughts\n')).toBe(false);
  });
});

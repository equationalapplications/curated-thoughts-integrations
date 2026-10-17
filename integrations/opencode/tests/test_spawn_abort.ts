/**
 * test_spawn_abort.ts — the OpenCode spawn binding honours the abort signal
 * (review of PR #66, item 3): when the activity budget runs out, the `ct`
 * child's process tree is killed at once, not at its own 3 s timeout.
 * POSIX only (a shell child).
 */
import { describe, expect, it } from 'vitest';
import { nodeSpawnFn } from '../src/wisdom-live/adapter.js';

describe.skipIf(process.platform === 'win32')('nodeSpawnFn abort', () => {
  it('an aborted signal kills the child tree at once', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = nodeSpawnFn({ ...process.env })({ command: '/bin/sh', args: ['-c', 'sleep 30'], timeoutMs: 20_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const out = await pending;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.code).toBeNull();
  });

  it('a signal aborted before the spawn kills the child immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const out = await nodeSpawnFn({ ...process.env })({ command: '/bin/sh', args: ['-c', 'sleep 30'], timeoutMs: 20_000, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.code).toBeNull();
  });
});

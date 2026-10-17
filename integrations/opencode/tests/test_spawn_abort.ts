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
    expect(out.aborted).toBe(true); // 0.4.1: distinguishable, never a breaker failure
  });

  it('a run that ends normally is not marked aborted, and leaves no abort listener', async () => {
    const { getEventListeners } = await import('node:events');
    const ac = new AbortController();
    const out = await nodeSpawnFn({ ...process.env })({ command: '/bin/sh', args: ['-c', 'true'], timeoutMs: 5000, signal: ac.signal });
    expect(out.aborted ?? false).toBe(false);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('a spawn error removes the abort listener too', async () => {
    const { getEventListeners } = await import('node:events');
    const ac = new AbortController();
    const out = await nodeSpawnFn({ ...process.env })({ command: '/no/such/ct-binary', args: [], timeoutMs: 5000, signal: ac.signal });
    expect(out.spawnError).toBe(true);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
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

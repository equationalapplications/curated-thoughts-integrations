import { describe, it, expect } from 'vitest';
import { nodeSpawnFn } from '../src/wisdom/spawn.js';

const posix = process.platform !== 'win32';

describe('nodeSpawnFn (real child process)', () => {
  it('decodes multi-byte output split across chunks intact', async () => {
    // 200k copies of a 3-byte character: far past one pipe chunk, so some
    // character is split across a boundary unless decoding happens once.
    const script = "process.stdout.write('\\u20ac'.repeat(200000))";
    const r = await nodeSpawnFn(process.env)({ command: process.execPath, args: ['-e', script], timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(200000);
    expect(r.stdout.includes('�')).toBe(false);
  });

  it('reports a spawn error for a missing binary', async () => {
    const r = await nodeSpawnFn(process.env)({ command: '/nonexistent/ct-binary', args: [], timeoutMs: 2000 });
    expect(r.spawnError).toBe(true);
  });

  it.skipIf(!posix)('kills a hung child at the timeout', async () => {
    const r = await nodeSpawnFn(process.env)({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });
});

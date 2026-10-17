/**
 * spawn-error.test.ts — Node's 'error' event on a child that DID start
 * (e.g. a failed kill) is not a failed start (PR #76 review, finding 4).
 * node:child_process is mocked in this file only, so the real binding's
 * listeners run against a fake child whose events the test drives.
 */

import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeStream extends EventEmitter {
  destroy(): void { /* nothing to close */ }
}
class FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn(() => true);
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

const state: { next: FakeChild | undefined } = { next: undefined };

vi.mock('node:child_process', () => ({
  spawn: () => state.next,
}));

const { nodeSpawnFn } = await import('../src/spawn.js');

describe("nodeSpawnFn 'error' handling (mocked child)", () => {
  beforeEach(() => {
    state.next = undefined;
  });

  it("an 'error' after a successful start is ignored; exit/close settle with the real code", async () => {
    const child = new FakeChild(424242);
    state.next = child;
    const pending = nodeSpawnFn({})({ command: 'ct', args: [], timeoutMs: 5000 });
    child.emit('error', new Error('kill EPERM'));
    child.stdout.emit('data', Buffer.from('{"entries": []}'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const out = await pending;
    expect(out.spawnError).toBe(false);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe('{"entries": []}');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("an 'error' from a child that never got a pid is a spawn error", async () => {
    const child = new FakeChild(undefined);
    state.next = child;
    const pending = nodeSpawnFn({})({ command: 'ct', args: [], timeoutMs: 5000 });
    child.emit('error', new Error('spawn ct ENOENT'));
    const out = await pending;
    expect(out.spawnError).toBe(true);
    expect(out.code).toBeNull();
  });

  describe('a kill that fails while the child keeps running still settles (PR #76 fix round 1)', () => {
    // A pid no real process has (above every OS pid range), and process.kill
    // stubbed to fail, so no real process or group is ever signalled.
    const FAKE_PID = 2 ** 30 + 7;
    let killSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
    });
    afterEach(() => {
      killSpy.mockRestore();
    });

    /** The direct kill fails too: it emits 'error' (as Node does) and the child never exits or closes. */
    function stuckChild(): FakeChild {
      const child = new FakeChild(FAKE_PID);
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('error', new Error('kill EPERM')));
        return false;
      });
      return child;
    }

    it('timeout: settles within the kill deadline as timedOut, not a spawn error', { timeout: 3000 }, async () => {
      const child = stuckChild();
      state.next = child;
      const started = Date.now();
      const pending = nodeSpawnFn({}, { killGraceMs: 100 })({ command: 'ct', args: [], timeoutMs: 100 });
      child.stdout.emit('data', Buffer.from('partial'));
      const out = await pending;
      expect(Date.now() - started).toBeLessThan(200 + 800);
      expect(out.timedOut).toBe(true);
      expect(out.spawnError).toBe(false);
      expect(out.code).toBeNull();
      expect(out.stdout).toBe('partial');
      expect(child.kill).toHaveBeenCalled();
    });

    it('abort: settles within the kill deadline as aborted', { timeout: 3000 }, async () => {
      const child = stuckChild();
      state.next = child;
      const abort = new AbortController();
      const started = Date.now();
      const pending = nodeSpawnFn({}, { killGraceMs: 100 })({ command: 'ct', args: [], timeoutMs: 60_000, signal: abort.signal });
      abort.abort();
      const out = await pending;
      expect(Date.now() - started).toBeLessThan(100 + 800);
      expect(out.aborted).toBe(true);
      expect(out.timedOut).toBe(false);
      expect(out.spawnError).toBe(false);
      expect(out.code).toBeNull();
    });

    it('overflow: settles within the kill deadline as a spawn error, never aborted', { timeout: 3000 }, async () => {
      const child = stuckChild();
      state.next = child;
      const started = Date.now();
      const pending = nodeSpawnFn({}, { killGraceMs: 100, capBytes: 4 })({ command: 'ct', args: [], timeoutMs: 60_000 });
      child.stdout.emit('data', Buffer.from('too long'));
      const out = await pending;
      expect(Date.now() - started).toBeLessThan(100 + 800);
      expect(out.spawnError).toBe(true);
      expect(out.aborted).toBeUndefined();
      expect(out.timedOut).toBe(false);
    });
  });
});

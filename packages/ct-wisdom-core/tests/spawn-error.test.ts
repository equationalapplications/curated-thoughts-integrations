/**
 * spawn-error.test.ts — Node's 'error' event on a child that DID start
 * (e.g. a failed kill) is not a failed start (PR #76 review, finding 4).
 * node:child_process is mocked in this file only, so the real binding's
 * listeners run against a fake child whose events the test drives.
 */

import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});

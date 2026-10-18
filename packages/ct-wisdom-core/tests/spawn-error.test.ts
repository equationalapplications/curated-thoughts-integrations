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
  unref = vi.fn();
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

interface TaskkillCall { command: string; args: string[]; options: Record<string, unknown> }

const state: {
  next: FakeChild | undefined;
  /** An exit code, or 'hang': the fake taskkill never emits 'exit' or 'error'. */
  taskkillCode: number | 'hang';
  taskkill: FakeChild | undefined;
  taskkillCall: TaskkillCall | undefined;
} = {
  next: undefined,
  taskkillCode: 1,
  taskkill: undefined,
  taskkillCall: undefined,
};

vi.mock('node:child_process', () => ({
  // On Windows a kill first spawns taskkill.exe: give that its own fake that
  // exits asynchronously with state.taskkillCode (default 1 = failed, so the
  // binding falls back to the direct child.kill), or never ends ('hang').
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    if (typeof command === 'string' && /taskkill\.exe$/i.test(command)) {
      const tk = new FakeChild(2 ** 30 + 9);
      state.taskkill = tk;
      state.taskkillCall = { command, args, options };
      const code = state.taskkillCode;
      if (code !== 'hang') setTimeout(() => tk.emit('exit', code, null), 5);
      return tk;
    }
    return state.next;
  },
}));

const { nodeSpawnFn, TASKKILL_TIMEOUT_MS } = await import('../src/spawn.js');

describe("nodeSpawnFn 'error' handling (mocked child)", () => {
  beforeEach(() => {
    state.next = undefined;
    state.taskkillCode = 1;
    state.taskkill = undefined;
    state.taskkillCall = undefined;
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
    expect(child.unref).not.toHaveBeenCalled();
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
      // The surviving child must not keep the host's event loop alive.
      expect(child.unref).toHaveBeenCalled();
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

    // The win32 branch, mocked, on every OS: the binding reads
    // process.platform and process.env.SystemRoot at kill time.
    describe('win32 branch (platform stubbed)', () => {
      const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      let savedRoot: string | undefined;
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        savedRoot = process.env.SystemRoot;
        process.env.SystemRoot = 'C:\\Windows';
      });
      afterEach(() => {
        if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
        if (savedRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = savedRoot;
      });

      /** The one taskkill call: absolute path, exact args, no shell, hidden, no Node spawn timeout. */
      function expectTaskkillCall(): void {
        const call = state.taskkillCall;
        expect(call).toBeDefined();
        expect(call!.command.endsWith('\\System32\\taskkill.exe')).toBe(true);
        expect(call!.command).toBe('C:\\Windows\\System32\\taskkill.exe');
        expect(call!.args).toEqual(['/PID', String(FAKE_PID), '/T', '/F']);
        expect(call!.options.shell).toBe(false);
        expect(call!.options.windowsHide).toBe(true);
        expect(call!.options.stdio).toBe('ignore');
        expect(call!.options.cwd).toBe('C:\\Windows');
        expect('timeout' in call!.options).toBe(false);
      }

      it('a taskkill that exits 0 means no direct kill, and the call still settles as timedOut within the deadline', { timeout: 3000 }, async () => {
        const child = stuckChild();
        state.next = child;
        state.taskkillCode = 0;
        const started = Date.now();
        const pending = nodeSpawnFn({}, { killGraceMs: 100 })({ command: 'ct', args: [], timeoutMs: 100 });
        child.stdout.emit('data', Buffer.from('partial'));
        const out = await pending;
        expect(Date.now() - started).toBeLessThan(200 + 800);
        expect(out.timedOut).toBe(true);
        expect(out.spawnError).toBe(false);
        expect(out.stdout).toBe('partial');
        expect(state.taskkill).toBeDefined();
        expectTaskkillCall();
        expect(child.kill).not.toHaveBeenCalled();
        expect(killSpy).not.toHaveBeenCalled();
      });

      it('a taskkill that fails (exit 1) falls back to the direct kill, after taskkill, and settles within the deadline', { timeout: 3000 }, async () => {
        const child = stuckChild();
        state.next = child;
        state.taskkillCode = 1;
        const started = Date.now();
        const pending = nodeSpawnFn({}, { killGraceMs: 100 })({ command: 'ct', args: [], timeoutMs: 100 });
        const out = await pending;
        expect(Date.now() - started).toBeLessThan(200 + 800);
        expect(out.timedOut).toBe(true);
        expect(out.spawnError).toBe(false);
        expectTaskkillCall();
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(killSpy).not.toHaveBeenCalled();
      });

      it('a taskkill that never exits is killed by its own unref\'d timer, then the direct kill runs; the call settles within the kill deadline', { timeout: TASKKILL_TIMEOUT_MS + 3000 }, async () => {
        const child = stuckChild();
        state.next = child;
        state.taskkillCode = 'hang';
        // Real timers, spied: the handle armed for TASKKILL_TIMEOUT_MS is
        // the binding's taskkill bound; it must be unref'd (hasRef false).
        const realSetTimeout = globalThis.setTimeout;
        const handles: Array<{ ms: number | undefined; handle: ReturnType<typeof setTimeout> }> = [];
        const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
          const handle = realSetTimeout(fn, ms, ...rest);
          handles.push({ ms, handle });
          return handle;
        }) as typeof setTimeout);
        try {
          const started = Date.now();
          const pending = nodeSpawnFn({}, { killGraceMs: 100 })({ command: 'ct', args: [], timeoutMs: 100 });
          const out = await pending;
          // Settles on the kill deadline, long before taskkill's own bound.
          expect(Date.now() - started).toBeLessThan(200 + 800);
          expect(out.timedOut).toBe(true);
          expect(out.spawnError).toBe(false);
          expectTaskkillCall();
          const tk = state.taskkill!;
          expect(tk.kill).not.toHaveBeenCalled();
          expect(child.kill).not.toHaveBeenCalled();
          const bound = handles.filter((h) => h.ms === TASKKILL_TIMEOUT_MS);
          expect(bound).toHaveLength(1);
          expect(bound[0]!.handle.hasRef()).toBe(false);
          // Let the taskkill bound fire.
          await new Promise((r) => realSetTimeout(r, TASKKILL_TIMEOUT_MS + 300));
          expect(tk.kill).toHaveBeenCalledWith('SIGKILL');
          expect(child.kill).toHaveBeenCalledTimes(1);
          expect(tk.kill.mock.invocationCallOrder[0]!).toBeLessThan(child.kill.mock.invocationCallOrder[0]!);
          expect(killSpy).not.toHaveBeenCalled();
        } finally {
          timerSpy.mockRestore();
        }
      });
    });
  });
});

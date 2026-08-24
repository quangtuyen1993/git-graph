import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  spawn: vi.fn(), kill: vi.fn(), timeoutSeconds: 0, deepseekKey: 'sk-secret-key',
}));

vi.mock('child_process', () => ({ spawn: hoisted.spawn }));
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'deepseekApiKey' ? hoisted.deepseekKey : hoisted.timeoutSeconds),
    }),
  },
}));

import { AIReviewService, ReviewCancelledError } from '../../src/extension/services/ai-review.service';

// An implausible pid: real signals accidentally reaching this can't hit a live
// process group on the machine running the test.
const FAKE_PID = 999999;

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = FAKE_PID;
  // A live ChildProcess reports null for both until it exits; killTree() reads
  // them to decide whether the pgid is still its own to signal.
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = hoisted.kill;
  return proc;
}

beforeEach(() => {
  hoisted.spawn.mockReset();
  hoisted.kill.mockReset();
  hoisted.timeoutSeconds = 0;
  // Fake timers so the unref'd 5s SIGKILL timer inside killTree() never
  // actually fires a real signal during a test, regardless of when a
  // process.kill spy in that test gets restored.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AIReviewService streaming', () => {
  it('forwards each stdout chunk to onChunk as it arrives', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const chunks: string[] = [];

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p',
      onChunk: (text) => chunks.push(text),
    });

    proc.stdout.emit('data', Buffer.from('first '));
    proc.stdout.emit('data', Buffer.from('second'));
    proc.emit('close', 0);
    await promise;

    expect(chunks).toEqual(['first ', 'second']);
  });

  it('still resolves with the whole content when no onChunk is given', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({ diff: 'd', provider: 'claude', payloadText: 'p' });

    proc.stdout.emit('data', Buffer.from('all of it'));
    proc.emit('close', 0);

    expect((await promise).content).toBe('all of it');
  });

  it('does not let a throwing onChunk stop the run from completing normally, or skip the deadline bump', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p',
      onChunk: () => { throw new Error('panel was disposed'); },
    });

    proc.stdout.emit('data', Buffer.from('content'));
    proc.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ content: 'content' });
  });

  it('rejects with ReviewCancelledError when the signal aborts', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);

    processKill.mockRestore();
  });

  it('rejects with ReviewCancelledError immediately when the signal is already aborted, without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });

    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
    expect(hoisted.spawn).not.toHaveBeenCalled();

    processKill.mockRestore();
  });

  it('kills the process group, not just the direct child', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);

    expect(processKill).toHaveBeenCalledWith(-FAKE_PID, 'SIGTERM');
    processKill.mockRestore();
  });

  it('never resolves if close fires after a cancel', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });

    controller.abort();
    proc.emit('close', 0);

    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
    processKill.mockRestore();
  });

  it('spawns detached so the whole tree is signallable', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({ diff: 'd', provider: 'claude', payloadText: 'p' });
    proc.emit('close', 0);
    await promise;

    // detached is POSIX-only; on Windows the tree is killed with taskkill instead.
    expect(hoisted.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: process.platform !== 'win32' }),
    );
  });

  it('kills the process tree on inactivity timeout, not just the direct child', async () => {
    hoisted.timeoutSeconds = 5;
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({ diff: 'd', provider: 'claude', payloadText: 'p' });
    const assertion = expect(promise).rejects.toThrow(/produced no output/);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(processKill).toHaveBeenCalledWith(-FAKE_PID, 'SIGTERM');
    processKill.mockRestore();
  });

  it('does not leave a stray SIGKILL armed when killTree runs twice in one run', async () => {
    // Reachable order: the inactivity timeout fires killTree() first, then
    // the user cancels and onAbort fires killTree() again (the timeout path
    // deliberately leaves the abort listener attached). The first SIGKILL
    // handle must not survive uncleared, or it fires a stray real signal
    // 5s later at a possibly-recycled pgid.
    hoisted.timeoutSeconds = 5;
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toThrow(/produced no output/);

    // First killTree(): the inactivity timeout fires, arming a SIGKILL for t+5s.
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    processKill.mockClear();

    // Second killTree(): the user cancels afterward, which should clear the
    // first SIGKILL handle and arm its own.
    controller.abort();

    // Advance exactly to when both the (stale, should-be-cleared) first
    // handle and the second handle would fire. Only the second may go off.
    await vi.advanceTimersByTimeAsync(5000);

    const sigkillCalls = processKill.mock.calls.filter((call) => call[1] === 'SIGKILL');
    expect(sigkillCalls.length).toBe(1);

    processKill.mockRestore();
  });
  it('does not signal a pgid the child has already released', () => {
    // M3: between 'exit' and 'close' the child is gone and the pgid can have
    // been recycled; a SIGTERM then lands on whatever inherited the number.
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);

    // The child has exited but 'close' has not fired yet.
    proc.exitCode = 0;
    controller.abort();

    expect(processKill).not.toHaveBeenCalled();
    processKill.mockRestore();
    return assertion;
  });

  it('does not signal a pgid whose child was already killed by a signal', () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);

    proc.signalCode = 'SIGTERM';
    controller.abort();

    expect(processKill).not.toHaveBeenCalled();
    processKill.mockRestore();
    return assertion;
  });

  it('listens for errors on the Windows taskkill it spawns', () => {
    // I6: a ChildProcess emitting 'error' with no listener throws — an uncaught
    // exception in the extension host, on the cancel path.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const proc = fakeProcess();
      const killer = new EventEmitter();
      hoisted.spawn.mockImplementation((command: string) => (command === 'taskkill' ? killer : proc));
      const controller = new AbortController();

      const service = new AIReviewService();
      const promise = service.review({
        diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
      });
      const assertion = expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);

      controller.abort();

      expect(hoisted.spawn).toHaveBeenCalledWith('taskkill', ['/pid', String(FAKE_PID), '/T', '/F']);
      // Unhandled, this throws out of emit() and takes the host with it.
      expect(() => killer.emit('error', new Error('taskkill not found'))).not.toThrow();
      return assertion;
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('never logs the spawn arguments, which carry the API key and the prompt', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'deepseek', payloadText: 'the whole prompt', model: 'deepseek-chat',
    });
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    })));
    proc.exitCode = 0;
    proc.emit('close', 0);
    await promise;

    const logged = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logged).toContain('Spawning: curl');
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('sk-secret');
    expect(logged).not.toContain('the whole prompt');
    log.mockRestore();
  });
});

describe('rate-limit detection', () => {
  it('rejects when CLI returns a short rate-limit message', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p',
    });

    const rateLimitOutput = "You've hit your session limit · resets 2:40am (Asia/Saigon)\n";
    proc.stdout.emit('data', Buffer.from(rateLimitOutput));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow(/rate-limited/);
  });

  it('does not flag a long review that mentions rate limit', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p',
    });

    // A 600+ char output that happens to mention "rate limit" should pass through
    const longReview = 'A'.repeat(500) + ' This code may trigger a rate limit if called too often. ' + 'B'.repeat(100);
    proc.stdout.emit('data', Buffer.from(longReview));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.content).toContain('rate limit');
  });
});

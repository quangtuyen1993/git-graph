import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), timeoutSeconds: 0 }));

vi.mock('child_process', () => ({ spawn: hoisted.spawn }));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => hoisted.timeoutSeconds }) },
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
});

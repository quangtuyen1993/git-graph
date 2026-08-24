import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }));

vi.mock('child_process', () => ({ spawn: hoisted.spawn }));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => 0 }) },
}));

import { AIReviewService, ReviewCancelledError } from '../../src/extension/services/ai-review.service';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = 4242;
  proc.kill = hoisted.kill;
  return proc;
}

beforeEach(() => {
  hoisted.spawn.mockReset();
  hoisted.kill.mockReset();
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

  it('rejects with ReviewCancelledError when the signal aborts', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
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

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM');
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
});

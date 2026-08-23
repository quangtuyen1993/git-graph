import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationGate } from '../../src/webview/lib/mutation-gate';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MessageBridge', () => {
  it('resolves, rejects, dispatches, and unsubscribes requests/events', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const handler = vi.fn();
    const unsubscribe = bridge.on('changed', handler);
    const pending = bridge.send('ping', { ok: true });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'ping' }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'event', event: 'changed', data: 7 } }));
    expect(handler).toHaveBeenCalledWith(7);
    unsubscribe();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'response', id: 'req-1', result: 'ok' } }));
    await expect(pending).resolves.toBe('ok');
    const rejected = bridge.send('bad');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'response', id: 'req-2', error: { message: 'no' } } }));
    await expect(rejected).rejects.toThrow('no');
  });

  it('keeps a 31-second history mutation pending and mutation-gated', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const gate = new MutationGate();
    const mutation = gate.run('Rewording commit…', () => bridge.send('git.reword'));
    const observedMutation = mutation.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(31_000);

    expect(gate.activeLabel).toBe('Rewording commit…');
    await expect(gate.run('Resetting…', async () => undefined))
      .rejects.toThrow('A Git mutation is already in progress');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'response', id: 'req-1', result: { success: true } },
    }));
    await expect(observedMutation).resolves.toEqual({
      status: 'resolved',
      value: { success: true },
    });
    expect(gate.activeLabel).toBeNull();
  });

  it('allows a slow graph build to complete without a client timeout', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const build = bridge.send('graph.build');
    const observedBuild = build.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'response', id: 'req-1', result: { totalRows: 1, layoutVersion: 1 } },
    }));

    await expect(observedBuild).resolves.toEqual({
      status: 'resolved',
      value: { totalRows: 1, layoutVersion: 1 },
    });
  });

  it('retains the bounded timeout for ordinary read requests', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const read = bridge.send('git.status');
    const observedRead = read.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    const result = await observedRead;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toEqual(new Error('Request git.status timed out'));
    }
  });

  it.each(['ui.confirm', 'ui.inputBox'])('keeps a slow %s dialog mutation-gated until its response', async (method) => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const gate = new MutationGate();
    const dialog = gate.run('Awaiting confirmation…', () => bridge.send(method));
    const observedDialog = dialog.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(31_000);

    expect(gate.activeLabel).toBe('Awaiting confirmation…');
    await expect(gate.run('Second mutation…', async () => undefined))
      .rejects.toThrow('A Git mutation is already in progress');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'response', id: 'req-1', result: method === 'ui.confirm' ? true : 'value' },
    }));
    await expect(observedDialog).resolves.toEqual({
      status: 'resolved',
      value: method === 'ui.confirm' ? true : 'value',
    });
    expect(gate.activeLabel).toBeNull();
  });

  it('keeps an ordinary rebase mutation gated past the default host timeout boundary', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const gate = new MutationGate();
    const rebase = gate.run('Rebasing…', () => bridge.send('git.rebase'));
    const observedRebase = rebase.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(31_000);

    expect(gate.activeLabel).toBe('Rebasing…');
    await expect(gate.run('Second mutation…', async () => undefined))
      .rejects.toThrow('A Git mutation is already in progress');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'response', id: 'req-1', result: { success: true } },
    }));
    await expect(observedRebase).resolves.toEqual({
      status: 'resolved',
      value: { success: true },
    });
  });

  it('does not spend a queued mutation timeout while it waits for earlier host work', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const gate = new MutationGate();
    const blocker = bridge.send('graph.build');
    const queuedCheckout = gate.run('Checking out…', () => bridge.send('git.checkout'));
    const observedCheckout = queuedCheckout.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(gate.activeLabel).toBe('Checking out…');
    await expect(gate.run('Second mutation…', async () => undefined))
      .rejects.toThrow('A Git mutation is already in progress');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'response', id: 'req-1', result: { totalRows: 1, layoutVersion: 1 } },
    }));
    await expect(blocker).resolves.toEqual({ totalRows: 1, layoutVersion: 1 });
    expect(gate.activeLabel).toBe('Checking out…');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'response', id: 'req-2', result: { success: true } },
    }));
    await expect(observedCheckout).resolves.toEqual({
      status: 'resolved',
      value: { success: true },
    });
    expect(gate.activeLabel).toBeNull();
  });

  it('keeps every Git mutation RPC unbounded until a terminal host response', async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, getState: () => ({}), setState: vi.fn() }));
    const { MessageBridge } = await import('../../src/webview/lib/message-bridge');
    const bridge = new MessageBridge();
    const mutationMethods = [
      'git.checkout',
      'git.createBranch',
      'git.deleteBranch',
      'git.renameBranch',
      'git.merge',
      'git.rebase',
      'git.cherryPick',
      'git.revert',
      'git.stash',
      'git.stashApply',
      'git.stashPop',
      'git.stashDrop',
      'git.stashPush',
      'git.worktreeAdd',
      'git.worktreeRemove',
      'git.push',
      'git.pull',
      'git.fetch',
      'git.reset',
      'git.createTag',
      'git.deleteTag',
      'git.abortMerge',
      'git.abortRebase',
      'git.squash',
      'git.reword',
    ];
    const states = mutationMethods.map(() => 'pending');
    const requests = mutationMethods.map((method, index) => (
      bridge.send(method).then(
        (value) => {
          states[index] = 'resolved';
          return { status: 'resolved' as const, value };
        },
        (error) => {
          states[index] = 'rejected';
          return { status: 'rejected' as const, error };
        },
      )
    ));

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(states).toEqual(mutationMethods.map(() => 'pending'));

    mutationMethods.forEach((_, index) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'response', id: `req-${index + 1}`, result: { success: true } },
      }));
    });
    await expect(Promise.all(requests)).resolves.toEqual(
      mutationMethods.map(() => ({ status: 'resolved', value: { success: true } })),
    );
  });
});

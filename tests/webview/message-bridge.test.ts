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
});

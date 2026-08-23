import { describe, expect, it, vi } from 'vitest';

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
});

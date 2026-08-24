import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { MessageRouter } from '../../src/extension/controllers/message-router';
import type { Request } from '../../src/extension/types/messages.types';

describe('MessageRouter lifetime', () => {
  it('disposes its receive subscription and cannot post after disposal', async () => {
    let receive: ((message: Request) => void) | undefined;
    const disposeSubscription = vi.fn();
    const postMessage = vi.fn();
    const panel = {
      webview: {
        onDidReceiveMessage(callback: (message: Request) => void) {
          receive = callback;
          return { dispose: disposeSubscription };
        },
        postMessage,
      },
    };
    const handler = vi.fn(async () => ({ ok: true }));
    const router = new MessageRouter();
    router.register('example', handler);
    router.setHost(panel as never);

    router.dispose();
    receive?.({ id: 'after-dispose', type: 'request', method: 'example.run', params: {} });
    router.sendEvent('example.changed');
    await Promise.resolve();

    expect(disposeSubscription).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('accepts any host exposing a webview, not just panels', async () => {
    const posted: unknown[] = [];
    const router = new MessageRouter();
    router.setHost({
      webview: {
        postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      onDidDispose: () => ({ dispose: () => undefined }),
    } as never);

    router.sendEvent('graph.invalidated');

    expect(posted).toEqual([{ type: 'event', event: 'graph.invalidated', data: undefined }]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: Array<{ toString(): string } | string>) => ({
      toString: () => parts.map(String).join('/'),
    }),
  },
  ViewColumn: { One: 1 },
  window: { createWebviewPanel: vscodeMocks.createWebviewPanel },
}));

import { GitGraphWebviewProvider } from '../../src/extension/providers/webview-provider';

interface FakePanel {
  iconPath?: { light: unknown; dark: unknown };
  reveal: ReturnType<typeof vi.fn>;
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri: ReturnType<typeof vi.fn>;
  };
  onDidDispose: (callback: () => void) => { dispose(): void };
  disposePanel: () => void;
}

function createFakePanel(): FakePanel {
  const disposalCallbacks: Array<() => void> = [];
  return {
    reveal: vi.fn(),
    webview: {
      html: '',
      cspSource: 'test-csp',
      asWebviewUri: vi.fn((uri: { toString(): string }) => uri),
    },
    onDidDispose(callback: () => void) {
      disposalCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    disposePanel() {
      for (const callback of disposalCallbacks) callback();
    },
  };
}

describe('GitGraphWebviewProvider', () => {
  beforeEach(() => {
    vscodeMocks.createWebviewPanel.mockReset();
    vscodeMocks.createWebviewPanel.mockImplementation(() => createFakePanel());
  });

  it('reuses the single panel and rebuilds it after disposal', async () => {
    const createSession = vi.fn();
    const provider = new GitGraphWebviewProvider(
      { toString: () => '/extension' } as never,
      createSession,
    );

    const first = provider.openPanel() as unknown as FakePanel;
    const second = provider.openPanel() as unknown as FakePanel;

    expect(second).toBe(first);
    expect(first.reveal).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(first);
    expect(first.iconPath).toBeDefined();

    first.disposePanel();
    const rebuilt = provider.openPanel() as unknown as FakePanel;

    expect(rebuilt).not.toBe(first);
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});

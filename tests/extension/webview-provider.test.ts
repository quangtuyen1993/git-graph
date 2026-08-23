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

  it('reuses the root panel without conflating it with repository panels', async () => {
    const createSession = vi.fn();
    const provider = new GitGraphWebviewProvider(
      { toString: () => '/extension' } as never,
      createSession,
      async (repoPath) => repoPath,
    );

    const rootA = provider.openPanel() as unknown as FakePanel;
    const rootB = provider.openPanel() as unknown as FakePanel;
    const child = await provider.openRepositoryPanel('/real/sdk', 'sdk') as unknown as FakePanel;

    expect(rootB).toBe(rootA);
    expect(rootA.reveal).toHaveBeenCalledTimes(1);
    expect(child).not.toBe(rootA);
    expect(createSession).toHaveBeenCalledWith(rootA, { kind: 'root' });
    expect(createSession).toHaveBeenCalledWith(child, {
      kind: 'repository',
      repoPath: '/real/sdk',
      repoName: 'sdk',
    });
    expect(rootA.iconPath).toBeDefined();
    expect(child.iconPath).toBeDefined();

    child.disposePanel();

    expect(provider.openPanel()).toBe(rootA);
    expect(rootA.reveal).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repository panels by canonical path and forgets disposed panels', async () => {
    const createSession = vi.fn();
    const provider = new GitGraphWebviewProvider(
      { toString: () => '/extension' } as never,
      createSession,
      async (repoPath) => repoPath === '/alias/sdk' ? '/real/sdk' : repoPath,
    );

    const childA = await provider.openRepositoryPanel('/alias/sdk', 'sdk') as unknown as FakePanel;
    const childB = await provider.openRepositoryPanel('/real/sdk', 'sdk') as unknown as FakePanel;

    expect(childB).toBe(childA);
    expect(childA.reveal).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(childA, {
      kind: 'repository',
      repoPath: '/real/sdk',
      repoName: 'sdk',
    });

    childA.disposePanel();
    const reopened = await provider.openRepositoryPanel('/real/sdk', 'sdk') as unknown as FakePanel;

    expect(reopened).not.toBe(childA);
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});

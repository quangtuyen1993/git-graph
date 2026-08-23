import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostMocks = vi.hoisted(() => ({
  createFileSystemWatcher: vi.fn(),
  createWebviewPanel: vi.fn(),
  findRepo: vi.fn(),
  gitDirectory: vi.fn(),
  resolveSubmodule: vi.fn(),
  registerCommand: vi.fn(),
  showWarningMessage: vi.fn(),
  workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  realpath: async (path: string) => path,
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: Array<{ toString(): string } | string>) => ({
      toString: () => parts.map(String).join('/'),
    }),
  },
  ViewColumn: { One: 1 },
  RelativePattern: class {
    constructor(public readonly base: string, public readonly pattern: string) {}
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: hostMocks.registerCommand,
  },
  window: {
    createWebviewPanel: hostMocks.createWebviewPanel,
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: hostMocks.showWarningMessage,
  },
  workspace: {
    get workspaceFolders() {
      return hostMocks.workspaceFolders;
    },
    createFileSystemWatcher: hostMocks.createFileSystemWatcher,
    registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('../../src/extension/services/git.service', () => ({
  GitService: class {
    static findRepo(path: string): Promise<string | null> {
      return hostMocks.findRepo(path);
    }

    constructor(private readonly repoPath: string) {}

    getRepoPath(): string {
      return this.repoPath;
    }

    gitDirectory(): Promise<string> {
      return hostMocks.gitDirectory(this.repoPath);
    }

    resolveSubmodule(relativePath: string): Promise<unknown> {
      return hostMocks.resolveSubmodule(this.repoPath, relativePath);
    }
  },
}));

vi.mock('../../src/extension/services/ai-review.service', () => ({
  AIReviewService: class {
    detectProviders = vi.fn();
    review = vi.fn();
  },
}));

import { activate } from '../../src/extension/extension';
import type { Request } from '../../src/extension/types/messages.types';

interface FakePanel {
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri(uri: unknown): unknown;
    onDidReceiveMessage(callback: (message: Request) => void): { dispose(): void };
    postMessage: ReturnType<typeof vi.fn>;
  };
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose(callback: () => void): { dispose(): void };
  receive(message: Request): void;
  disposePanel(): void;
}

function fakePanel(): FakePanel {
  const disposalCallbacks: Array<() => void> = [];
  let receiveMessage: ((message: Request) => void) | undefined;
  return {
    webview: {
      html: '',
      cspSource: 'test-csp',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage(callback) {
        receiveMessage = callback;
        return { dispose: vi.fn() };
      },
      postMessage: vi.fn(),
    },
    reveal: vi.fn(),
    onDidDispose(callback) {
      disposalCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    receive(message) {
      receiveMessage?.(message);
    },
    disposePanel() {
      for (const callback of disposalCallbacks) callback();
    },
  };
}

function fakeWatcher() {
  return {
    dispose: vi.fn(),
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
  };
}

async function activateAndOpenRoot(): Promise<FakePanel> {
  const subscriptions: Array<{ dispose(): unknown }> = [];
  await activate({
    extensionUri: { toString: () => '/extension' },
    subscriptions,
  } as never);
  const open = hostMocks.registerCommand.mock.calls.find(([command]) => command === 'gitGraphPro.open')?.[1];
  open();
  return hostMocks.createWebviewPanel.mock.results.at(-1)?.value as FakePanel;
}

describe('extension panel sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace/root' } },
      { name: 'other', uri: { fsPath: '/workspace/other' } },
    ];
    hostMocks.findRepo.mockImplementation(async (path: string) => path.replace('/workspace', '/repo'));
    hostMocks.gitDirectory.mockImplementation(async (path: string) => path.replace('/repo', '/git'));
    hostMocks.resolveSubmodule.mockResolvedValue({
      name: 'sdk',
      path: 'packages/sdk',
      absolutePath: '/real/sdk',
      state: 'clean',
    });
    hostMocks.createWebviewPanel.mockImplementation(() => fakePanel());
    hostMocks.createFileSystemWatcher.mockImplementation(() => fakeWatcher());
  });

  it('binds each root session watcher initially, rebinds after switching, and disposes it with the panel', async () => {
    const panel = await activateAndOpenRoot();

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    expect(hostMocks.createFileSystemWatcher.mock.calls[0][0]).toMatchObject({
      base: '/git/root',
      pattern: '{HEAD,refs/**,index}',
    });
    const initialWatcher = hostMocks.createFileSystemWatcher.mock.results[0].value;

    panel.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(2));
    expect(initialWatcher.dispose).toHaveBeenCalledTimes(1);
    expect(hostMocks.createFileSystemWatcher.mock.calls[1][0]).toMatchObject({ base: '/git/other' });
    const reboundWatcher = hostMocks.createFileSystemWatcher.mock.results[1].value;

    panel.disposePanel();

    expect(reboundWatcher.dispose).toHaveBeenCalledTimes(1);
  });

  it('warns about initial and rebind watcher failures without rejecting panel setup or repo.switch', async () => {
    hostMocks.gitDirectory.mockRejectedValueOnce(new Error('initial watcher failed'));
    const panel = await activateAndOpenRoot();

    await vi.waitFor(() => expect(hostMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('initial watcher failed'),
    ));
    expect(panel.webview.html).toContain('<div id="app"></div>');

    hostMocks.gitDirectory.mockRejectedValueOnce(new Error('rebind watcher failed'));
    panel.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });

    await vi.waitFor(() => expect(hostMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('rebind watcher failed'),
    ));
    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({
      id: 'switch',
      type: 'response',
      result: { success: true, name: 'other', path: '/repo/other' },
    }));
  });

  it('resolves a relative submodule path in the panel session before opening its repository panel', async () => {
    const panel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));

    panel.receive({
      id: 'open-submodule',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk', absolutePath: '/forged/sdk' },
    });

    await vi.waitFor(() => expect(hostMocks.createWebviewPanel).toHaveBeenCalledTimes(2));
    expect(hostMocks.resolveSubmodule).toHaveBeenCalledWith('/repo/root', 'packages/sdk');
    expect(hostMocks.createWebviewPanel.mock.calls[1][1]).toBe('Git Graph: sdk');
    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({
      id: 'open-submodule',
      type: 'response',
      result: { success: true },
    }));
  });
});

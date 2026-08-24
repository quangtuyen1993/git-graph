import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostMocks = vi.hoisted(() => ({
  createFileSystemWatcher: vi.fn(),
  createWebviewPanel: vi.fn(),
  executeCommand: vi.fn(),
  findRepo: vi.fn(),
  getHeadHash: vi.fn(),
  getParents: vi.fn(),
  gitDirectory: vi.fn(),
  registerTextDocumentContentProvider: vi.fn(),
  resolveSubmodule: vi.fn(),
  registerCommand: vi.fn(),
  showFile: vi.fn(),
  showWarningMessage: vi.fn(),
  globalState: new Map<string, unknown>(),
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
    file: (path: string) => ({ toString: () => path }),
    from: ({ scheme, path, query }: { scheme: string; path: string; query: string }) => ({
      toString: () => `${scheme}:${path}?${query}`,
    }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ViewColumn: { One: 1 },
  RelativePattern: class {
    constructor(public readonly base: string, public readonly pattern: string) {}
  },
  commands: {
    executeCommand: hostMocks.executeCommand,
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
    registerTextDocumentContentProvider: hostMocks.registerTextDocumentContentProvider,
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

    getHeadHash(): Promise<string> {
      return hostMocks.getHeadHash(this.repoPath);
    }

    gitDirectory(): Promise<string> {
      return hostMocks.gitDirectory(this.repoPath);
    }

    resolveSubmodule(relativePath: string): Promise<unknown> {
      return hostMocks.resolveSubmodule(this.repoPath, relativePath);
    }

    getParents(hash: string): Promise<string[]> {
      return hostMocks.getParents(this.repoPath, hash);
    }

    showFile(ref: string, path: string): Promise<string> {
      return hostMocks.showFile(this.repoPath, ref, path);
    }

    branches(): Promise<Array<{ name: string }>> {
      return Promise.resolve([{ name: this.repoPath }]);
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
  let change: (() => void) | undefined;
  return {
    dispose: vi.fn(),
    onDidChange: vi.fn((callback: () => void) => {
      change = callback;
    }),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    fireChange() {
      change?.();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function responseFor(panel: FakePanel, id: string): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    response = panel.webview.postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(message => message.type === 'response' && message.id === id);
    expect(response).toBeDefined();
  });
  return response!;
}

async function activateAndOpenRoot(): Promise<FakePanel> {
  const subscriptions: Array<{ dispose(): unknown }> = [];
  await activate({
    extensionUri: { toString: () => '/extension' },
    globalState: {
      get: (key: string) => hostMocks.globalState.get(key),
      update: async (key: string, value: unknown) => {
        hostMocks.globalState.set(key, value);
      },
    },
    subscriptions,
  } as never);
  const open = hostMocks.registerCommand.mock.calls.find(([command]) => command === 'gitGraphPro.open')?.[1];
  open();
  return hostMocks.createWebviewPanel.mock.results.at(-1)?.value as FakePanel;
}

describe('extension panel sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.globalState.clear();
    hostMocks.workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace/root' } },
      { name: 'other', uri: { fsPath: '/workspace/other' } },
    ];
    hostMocks.findRepo.mockImplementation(async (path: string) => path.replace('/workspace', '/repo'));
    hostMocks.gitDirectory.mockImplementation(async (path: string) => path.replace('/repo', '/git'));
    hostMocks.getParents.mockResolvedValue(['parent']);
    hostMocks.getHeadHash.mockResolvedValue('different-head');
    hostMocks.showFile.mockImplementation(async (repoPath: string, ref: string, path: string) => (
      `${repoPath}:${ref}:${path}`
    ));
    hostMocks.resolveSubmodule.mockResolvedValue({
      name: 'sdk',
      path: 'packages/sdk',
      absolutePath: '/real/sdk',
      state: 'clean',
    });
    hostMocks.createWebviewPanel.mockImplementation(() => fakePanel());
    hostMocks.createFileSystemWatcher.mockImplementation(() => fakeWatcher());
    hostMocks.registerTextDocumentContentProvider.mockImplementation((_scheme, provider) => {
      return { dispose: vi.fn(), provider };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('warns about initial and rebind watcher failures without delaying repo.switch for warning dismissal', async () => {
    hostMocks.gitDirectory.mockRejectedValueOnce(new Error('initial watcher failed'));
    const panel = await activateAndOpenRoot();

    await vi.waitFor(() => expect(hostMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('initial watcher failed'),
    ));
    expect(panel.webview.html).toContain('<div id="app"></div>');

    hostMocks.gitDirectory.mockRejectedValueOnce(new Error('rebind watcher failed'));
    const pendingWarning = deferred<string | undefined>();
    hostMocks.showWarningMessage.mockReturnValueOnce(pendingWarning.promise);
    panel.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });

    await vi.waitFor(() => expect(hostMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('rebind watcher failed'),
    ));
    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({
      id: 'switch',
      type: 'response',
      result: { success: true, name: 'other', path: '/repo/other' },
    }));
    pendingWarning.resolve(undefined);
  });

  it('serializes overlapping root switches so response order matches the installed repository watcher', async () => {
    hostMocks.workspaceFolders.push({ name: 'last', uri: { fsPath: '/workspace/last' } });
    const slowOtherDirectory = deferred<string>();
    hostMocks.gitDirectory.mockImplementation((path: string) => (
      path === '/repo/other'
        ? slowOtherDirectory.promise
        : Promise.resolve(path.replace('/repo', '/git'))
    ));
    const panel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));

    const appliedRepositories: string[] = [];
    panel.webview.postMessage.mockImplementation((message: Record<string, unknown>) => {
      if (message.type === 'response' && (message.id === 'switch-other' || message.id === 'switch-last')) {
        const result = message.result as { path?: string } | undefined;
        if (result?.path) appliedRepositories.push(result.path);
      }
    });

    panel.receive({
      id: 'switch-other',
      type: 'request',
      method: 'repo.switch',
      params: { path: '/repo/other' },
    });
    await vi.waitFor(() => expect(hostMocks.gitDirectory).toHaveBeenCalledWith('/repo/other'));
    panel.receive({
      id: 'switch-last',
      type: 'request',
      method: 'repo.switch',
      params: { path: '/repo/last' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    slowOtherDirectory.resolve('/git/other');

    await responseFor(panel, 'switch-other');
    await responseFor(panel, 'switch-last');

    expect(appliedRepositories).toEqual(['/repo/other', '/repo/last']);
    expect(hostMocks.createFileSystemWatcher.mock.calls.at(-1)?.[0]).toMatchObject({ base: '/git/last' });
  });

  it('suppresses a stale initial watcher failure after a newer repository bind succeeds', async () => {
    const staleInitialDirectory = deferred<string>();
    hostMocks.gitDirectory.mockImplementation((path: string) => (
      path === '/repo/root'
        ? staleInitialDirectory.promise
        : Promise.resolve(path.replace('/repo', '/git'))
    ));
    const panel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.gitDirectory).toHaveBeenCalledWith('/repo/root'));

    panel.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });
    await responseFor(panel, 'switch');
    staleInitialDirectory.reject(new Error('superseded watcher failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(hostMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it('cancels a pending watcher invalidation when repository switching supersedes it', async () => {
    vi.useFakeTimers();
    const panel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    const initialWatcher = hostMocks.createFileSystemWatcher.mock.results[0].value;
    initialWatcher.fireChange();

    panel.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });
    await responseFor(panel, 'switch');
    await vi.advanceTimersByTimeAsync(500);

    const events = panel.webview.postMessage.mock.calls
      .map(([message]) => message as { type: string })
      .filter(message => message.type === 'event');
    expect(events).toEqual([]);
  });

  it('switches the session to a submodule instead of opening another panel', async () => {
    const panel = await activateAndOpenRoot();

    panel.receive({
      id: 'sub',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk' },
    });

    const opened = await responseFor(panel, 'sub');
    expect(opened.result).toMatchObject({ success: true, name: 'sdk', path: '/real/sdk' });
    expect(hostMocks.createWebviewPanel).toHaveBeenCalledTimes(1);

    panel.receive({ id: 'list', type: 'request', method: 'repo.list', params: {} });

    const listed = await responseFor(panel, 'list');
    expect((listed.result as { repos: Array<{ name: string; path: string; active: boolean }> }).repos)
      .toContainEqual({ name: 'sdk', path: '/real/sdk', active: true });

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(2));
  });

  it('keeps the Open File action by using the active repository file for a HEAD diff', async () => {
    hostMocks.getHeadHash.mockResolvedValue('commit');
    const panel = await activateAndOpenRoot();

    panel.receive({
      id: 'head-diff',
      type: 'request',
      method: 'ui.openDiff',
      params: { path: 'src/shared.ts', hash: 'commit', status: 'modified' },
    });
    await responseFor(panel, 'head-diff');

    const [, parentUri, currentUri] = hostMocks.executeCommand.mock.calls
      .find(([command]) => command === 'vscode.diff')!;
    expect(parentUri.toString()).toContain('git-graph-pro-diff:');
    expect(currentUri.toString()).toBe('/repo/root/src/shared.ts');
  });
});

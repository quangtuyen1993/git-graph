import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostMocks = vi.hoisted(() => ({
  createFileSystemWatcher: vi.fn(),
  createWebviewPanel: vi.fn(),
  executeCommand: vi.fn(),
  findRepo: vi.fn(),
  getParents: vi.fn(),
  gitDirectory: vi.fn(),
  registerTextDocumentContentProvider: vi.fn(),
  resolveSubmodule: vi.fn(),
  registerCommand: vi.fn(),
  showFile: vi.fn(),
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
    hostMocks.getParents.mockResolvedValue(['parent']);
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

  it('keeps child repo and Git RPCs fixed to the canonical child repository', async () => {
    const rootPanel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    rootPanel.receive({
      id: 'open-submodule',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk' },
    });
    await vi.waitFor(() => expect(hostMocks.createWebviewPanel).toHaveBeenCalledTimes(2));
    const childPanel = hostMocks.createWebviewPanel.mock.results[1].value as FakePanel;

    childPanel.receive({ id: 'child-list', type: 'request', method: 'repo.list', params: {} });
    childPanel.receive({ id: 'child-branches', type: 'request', method: 'git.branches', params: {} });
    childPanel.receive({
      id: 'child-switch',
      type: 'request',
      method: 'repo.switch',
      params: { path: '/repo/other' },
    });

    expect(await responseFor(childPanel, 'child-list')).toMatchObject({
      result: { repos: [{ name: 'sdk', path: '/real/sdk', active: true }] },
    });
    expect(await responseFor(childPanel, 'child-branches')).toMatchObject({
      result: [{ name: '/real/sdk' }],
    });
    expect(await responseFor(childPanel, 'child-switch')).toMatchObject({
      error: { message: expect.stringContaining('fixed repository') },
    });
  });

  it('isolates child watcher events and disposal from the root panel session', async () => {
    vi.useFakeTimers();
    const rootPanel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    rootPanel.receive({
      id: 'open-submodule',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk' },
    });
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(2));
    const childPanel = hostMocks.createWebviewPanel.mock.results[1].value as FakePanel;
    const rootWatcher = hostMocks.createFileSystemWatcher.mock.results[0].value;
    const childWatcher = hostMocks.createFileSystemWatcher.mock.results[1].value;

    childWatcher.fireChange();
    await vi.advanceTimersByTimeAsync(500);

    expect(rootPanel.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }));
    expect(childPanel.webview.postMessage).toHaveBeenCalledWith({
      type: 'event',
      event: 'git.refsChanged',
      data: undefined,
    });

    childPanel.disposePanel();
    expect(childWatcher.dispose).toHaveBeenCalledTimes(1);
    expect(rootWatcher.dispose).not.toHaveBeenCalled();

    rootPanel.receive({ id: 'root-branches', type: 'request', method: 'git.branches', params: {} });
    expect(await responseFor(rootPanel, 'root-branches')).toMatchObject({
      result: [{ name: '/repo/root' }],
    });
  });

  it.each([
    {
      method: 'ui.openDiff',
      params: { path: 'src/shared.ts', hash: 'commit', status: 'modified' },
    },
    {
      method: 'ui.compareDiff',
      params: {
        path: 'src/shared.ts',
        sourceBranch: 'feature',
        targetBranch: 'main',
        status: 'modified',
      },
    },
  ])('keeps two panel sessions\' $method virtual documents distinct at the same clock tick', async ({ method, params }) => {
    const rootPanel = await activateAndOpenRoot();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    rootPanel.receive({
      id: 'open-submodule',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk' },
    });
    await vi.waitFor(() => expect(hostMocks.createWebviewPanel).toHaveBeenCalledTimes(2));
    const childPanel = hostMocks.createWebviewPanel.mock.results[1].value as FakePanel;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1234);

    try {
      rootPanel.receive({ id: 'root-diff', type: 'request', method, params });
      childPanel.receive({ id: 'child-diff', type: 'request', method, params });
      await responseFor(rootPanel, 'root-diff');
      await responseFor(childPanel, 'child-diff');

      const diffCalls = hostMocks.executeCommand.mock.calls
        .filter(([command]) => command === 'vscode.diff');
      expect(diffCalls).toHaveLength(2);
      const [rootLeft, rootRight] = diffCalls[0].slice(1, 3) as Array<{ toString(): string }>;
      const [childLeft, childRight] = diffCalls[1].slice(1, 3) as Array<{ toString(): string }>;
      expect([rootLeft.toString(), rootRight.toString()])
        .not.toEqual([childLeft.toString(), childRight.toString()]);

      const provider = hostMocks.registerTextDocumentContentProvider.mock.calls[0][1] as {
        provideTextDocumentContent(uri: { toString(): string }): string;
      };
      expect(provider.provideTextDocumentContent(rootLeft)).toContain('/repo/root:');
      expect(provider.provideTextDocumentContent(rootRight)).toContain('/repo/root:');
      expect(provider.provideTextDocumentContent(childLeft)).toContain('/real/sdk:');
      expect(provider.provideTextDocumentContent(childRight)).toContain('/real/sdk:');
    } finally {
      now.mockRestore();
    }
  });
});

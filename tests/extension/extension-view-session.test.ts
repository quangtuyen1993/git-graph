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
  registerWebviewViewProvider: vi.fn(),
  resolveSubmodule: vi.fn(),
  registerCommand: vi.fn(),
  createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
  getConfiguration: vi.fn(() => ({ get: () => undefined })),
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
  EventEmitter: class {
    private listeners: Array<() => void> = [];
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(): void {
      this.listeners.forEach(listener => listener());
    }
  },
  ThemeIcon: class {
    constructor(public readonly id: string) {}
  },
  TreeItem: class {
    description?: string;
    iconPath?: unknown;
    contextValue?: string;
    tooltip?: string;
    command?: unknown;
    constructor(public readonly label: string) {}
  },
  commands: {
    executeCommand: hostMocks.executeCommand,
    registerCommand: hostMocks.registerCommand,
  },
  window: {
    createWebviewPanel: hostMocks.createWebviewPanel,
    registerWebviewViewProvider: hostMocks.registerWebviewViewProvider,
    createTreeView: hostMocks.createTreeView,
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
    getConfiguration: hostMocks.getConfiguration,
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

// A stand-in that tracks construction and captures the onChange callback, so
// tests can assert on cancelAll() (hoisting: one runner for the whole
// extension, not one per session) and on event delivery (the onChange
// rewiring from a per-session `router` to the activate-scope `activeRouter`)
// without exercising real review I/O.
const reviewRunnerMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    cancelAll: ReturnType<typeof vi.fn>;
    onChange: (repoId: string, id: string) => void;
  }>,
}));

vi.mock('../../src/extension/services/review-runner', () => ({
  ReviewRunner: class {
    cancelAll = vi.fn();
    onChange: (repoId: string, id: string) => void;
    constructor(_store: unknown, _service: unknown, onChange: (repoId: string, id: string) => void) {
      this.onChange = onChange;
      reviewRunnerMocks.instances.push(this as unknown as {
        cancelAll: ReturnType<typeof vi.fn>;
        onChange: (repoId: string, id: string) => void;
      });
    }
  },
}));

import { activate, deactivate } from '../../src/extension/extension';
import type { Request } from '../../src/extension/types/messages.types';

interface FakeView {
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri(uri: unknown): unknown;
    onDidReceiveMessage(callback: (message: Request) => void): { dispose(): void };
    postMessage: ReturnType<typeof vi.fn>;
    options: unknown;
  };
  visible: boolean;
  onDidDispose(callback: () => void): { dispose(): void };
  onDidChangeVisibility(callback: () => void): { dispose(): void };
  receive(message: Request): void;
  setVisible(next: boolean): void;
  disposeView(): void;
}

function fakeView(visible = true): FakeView {
  const disposalCallbacks: Array<() => void> = [];
  const visibilityCallbacks: Array<() => void> = [];
  let receiveMessage: ((message: Request) => void) | undefined;
  const view: FakeView = {
    webview: {
      html: '',
      options: undefined,
      cspSource: 'test-csp',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage(callback) {
        receiveMessage = callback;
        return { dispose: vi.fn() };
      },
      postMessage: vi.fn(),
    },
    visible,
    onDidDispose(callback) {
      disposalCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    onDidChangeVisibility(callback) {
      visibilityCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    receive(message) {
      receiveMessage?.(message);
    },
    setVisible(next) {
      view.visible = next;
      for (const callback of visibilityCallbacks) callback();
    },
    disposeView() {
      for (const callback of disposalCallbacks) callback();
    },
  };
  return view;
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

function sentEvents(view: FakeView): string[] {
  return view.webview.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === 'event')
    .map((message) => message.event as string);
}

async function responseFor(view: FakeView, id: string): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    response = view.webview.postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(message => message.type === 'response' && message.id === id);
    expect(response).toBeDefined();
  });
  return response!;
}

async function activateAndResolveView(view: FakeView = fakeView()): Promise<FakeView> {
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
  const provider = hostMocks.registerWebviewViewProvider.mock.calls
    .find(([viewType]) => viewType === 'gitGraphPro.graph')?.[1] as {
      resolveWebviewView(view: unknown): void;
    };
  provider.resolveWebviewView(view);
  return view;
}

describe('extension view sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewRunnerMocks.instances.length = 0;
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
    hostMocks.createFileSystemWatcher.mockImplementation(() => fakeWatcher());
    hostMocks.registerTextDocumentContentProvider.mockImplementation((_scheme, provider) => {
      return { dispose: vi.fn(), provider };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('binds each root session watcher initially, rebinds after switching, and disposes it with the view', async () => {
    const view = await activateAndResolveView();

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    expect(hostMocks.createFileSystemWatcher.mock.calls[0][0]).toMatchObject({
      base: '/git/root',
      pattern: '{HEAD,refs/**,index}',
    });
    const initialWatcher = hostMocks.createFileSystemWatcher.mock.results[0].value;

    view.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(2));
    expect(initialWatcher.dispose).toHaveBeenCalledTimes(1);
    expect(hostMocks.createFileSystemWatcher.mock.calls[1][0]).toMatchObject({ base: '/git/other' });
    const reboundWatcher = hostMocks.createFileSystemWatcher.mock.results[1].value;

    view.disposeView();

    expect(reboundWatcher.dispose).toHaveBeenCalledTimes(1);
  });

  it('warns about initial and rebind watcher failures without delaying repo.switch for warning dismissal', async () => {
    hostMocks.gitDirectory.mockRejectedValueOnce(new Error('initial watcher failed'));
    const view = await activateAndResolveView();

    await vi.waitFor(() => expect(hostMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('initial watcher failed'),
    ));
    expect(view.webview.html).toContain('<div id="app"></div>');

    hostMocks.gitDirectory.mockRejectedValueOnce(new Error('rebind watcher failed'));
    const pendingWarning = deferred<string | undefined>();
    hostMocks.showWarningMessage.mockReturnValueOnce(pendingWarning.promise);
    view.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });

    await vi.waitFor(() => expect(hostMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('rebind watcher failed'),
    ));
    await vi.waitFor(() => expect(view.webview.postMessage).toHaveBeenCalledWith({
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
    const view = await activateAndResolveView();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));

    const appliedRepositories: string[] = [];
    view.webview.postMessage.mockImplementation((message: Record<string, unknown>) => {
      if (message.type === 'response' && (message.id === 'switch-other' || message.id === 'switch-last')) {
        const result = message.result as { path?: string } | undefined;
        if (result?.path) appliedRepositories.push(result.path);
      }
    });

    view.receive({
      id: 'switch-other',
      type: 'request',
      method: 'repo.switch',
      params: { path: '/repo/other' },
    });
    await vi.waitFor(() => expect(hostMocks.gitDirectory).toHaveBeenCalledWith('/repo/other'));
    view.receive({
      id: 'switch-last',
      type: 'request',
      method: 'repo.switch',
      params: { path: '/repo/last' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    slowOtherDirectory.resolve('/git/other');

    await responseFor(view, 'switch-other');
    await responseFor(view, 'switch-last');

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
    const view = await activateAndResolveView();
    await vi.waitFor(() => expect(hostMocks.gitDirectory).toHaveBeenCalledWith('/repo/root'));

    view.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });
    await responseFor(view, 'switch');
    staleInitialDirectory.reject(new Error('superseded watcher failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(hostMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it('cancels a pending watcher invalidation when repository switching supersedes it', async () => {
    vi.useFakeTimers();
    const view = await activateAndResolveView();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    const initialWatcher = hostMocks.createFileSystemWatcher.mock.results[0].value;
    initialWatcher.fireChange();

    view.receive({ id: 'switch', type: 'request', method: 'repo.switch', params: { path: '/repo/other' } });
    await responseFor(view, 'switch');
    await vi.advanceTimersByTimeAsync(500);

    const events = view.webview.postMessage.mock.calls
      .map(([message]) => message as { type: string })
      .filter(message => message.type === 'event');
    expect(events).toEqual([]);
  });

  it('switches the session to a submodule instead of opening another view', async () => {
    const view = await activateAndResolveView();

    view.receive({
      id: 'sub',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk' },
    });

    const opened = await responseFor(view, 'sub');
    expect(opened.result).toMatchObject({ success: true, name: 'sdk', path: '/real/sdk' });
    expect(hostMocks.createWebviewPanel).not.toHaveBeenCalled();

    view.receive({ id: 'list', type: 'request', method: 'repo.list', params: {} });

    const listed = await responseFor(view, 'list');
    expect((listed.result as { repos: Array<{ name: string; path: string; active: boolean }> }).repos)
      .toContainEqual({ name: 'sdk', path: '/real/sdk', active: true });

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(2));
  });

  it('opens a submodule owned by a repository that is not the active one', async () => {
    const view = await activateAndResolveView();
    hostMocks.resolveSubmodule.mockClear();

    // Active repo is /repo/root; the submodule belongs to /repo/other.
    view.receive({
      id: 'sub-other',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk', repoPath: '/repo/other' },
    });
    await responseFor(view, 'sub-other');

    // Resolving against the active repo would fail with "Submodule not found".
    expect(hostMocks.resolveSubmodule).toHaveBeenCalledWith('/repo/other', 'packages/sdk');
  });

  it('keeps the Open File action by using the active repository file for a HEAD diff', async () => {
    hostMocks.getHeadHash.mockResolvedValue('commit');
    const view = await activateAndResolveView();

    view.receive({
      id: 'head-diff',
      type: 'request',
      method: 'ui.openDiff',
      params: { path: 'src/shared.ts', hash: 'commit', status: 'modified' },
    });
    await responseFor(view, 'head-diff');

    const [, parentUri, currentUri] = hostMocks.executeCommand.mock.calls
      .find(([command]) => command === 'vscode.diff')!;
    expect(parentUri.toString()).toContain('git-graph-pro-diff:');
    expect(currentUri.toString()).toBe('/repo/root/src/shared.ts');
  });

  it('holds refresh events until the hidden view comes back', async () => {
    const view = await activateAndResolveView(fakeView(false));

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    const watcher = hostMocks.createFileSystemWatcher.mock.results[0].value;

    vi.useFakeTimers();
    watcher.fireChange();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    expect(sentEvents(view)).toEqual([]);

    view.setVisible(true);

    expect(sentEvents(view)).toEqual(['git.refsChanged', 'graph.invalidated']);

    view.setVisible(true);

    expect(sentEvents(view)).toEqual(['git.refsChanged', 'graph.invalidated']);
  });

  it('registers the graph as a panel view and focuses it from the open command', async () => {
    await activateAndResolveView();

    expect(hostMocks.registerWebviewViewProvider).toHaveBeenCalledWith(
      'gitGraphPro.graph',
      expect.anything(),
      { webviewOptions: { retainContextWhenHidden: true } },
    );
    expect(hostMocks.createWebviewPanel).not.toHaveBeenCalled();

    const openCommand = hostMocks.registerCommand.mock.calls
      .find(([command]) => command === 'gitGraphPro.open')?.[1] as () => void;
    openCommand();

    expect(hostMocks.executeCommand).toHaveBeenCalledWith('gitGraphPro.graph.focus');
  });

  it('shares one ReviewRunner across sessions and cancels its in-flight runs on deactivate', async () => {
    await activateAndResolveView();
    expect(reviewRunnerMocks.instances).toHaveLength(1);

    const provider = hostMocks.registerWebviewViewProvider.mock.calls
      .find(([viewType]) => viewType === 'gitGraphPro.graph')?.[1] as {
        resolveWebviewView(view: unknown): void;
      };

    // Resolving a second view (a hide/re-show) tears down and rebuilds the
    // session, but must not construct a second ReviewRunner: a per-session
    // runner would fragment the in-flight map that review.start relies on for
    // cross-session dedup.
    provider.resolveWebviewView(fakeView());
    expect(reviewRunnerMocks.instances).toHaveLength(1);

    deactivate();

    expect(reviewRunnerMocks.instances[0].cancelAll).toHaveBeenCalledTimes(1);
  });

  it('delivers review.changed to the live webview when the runner reports a change', async () => {
    const view = await activateAndResolveView();
    const runner = reviewRunnerMocks.instances[0];

    runner.onChange('repo-a', 'review-1');

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: 'event',
      event: 'review.changed',
      data: { id: 'review-1' },
    });
  });

  it('does not post review.changed once the webview has been disposed', async () => {
    const view = await activateAndResolveView();
    const runner = reviewRunnerMocks.instances[0];

    view.disposeView();
    view.webview.postMessage.mockClear();

    runner.onChange('repo-a', 'review-2');

    expect(view.webview.postMessage).not.toHaveBeenCalled();
  });

  it('routes review.changed to whichever session is currently live after a hide/re-show', async () => {
    const view1 = await activateAndResolveView();
    const provider = hostMocks.registerWebviewViewProvider.mock.calls
      .find(([viewType]) => viewType === 'gitGraphPro.graph')?.[1] as {
        resolveWebviewView(view: unknown): void;
      };

    // Resolving a second view disposes session 1 (clearing activeRouter back
    // to undefined) and builds session 2 (reassigning activeRouter to it) —
    // exactly the identity-guarded handoff in extension.ts's dispose().
    const view2 = fakeView();
    provider.resolveWebviewView(view2);
    view1.webview.postMessage.mockClear();
    view2.webview.postMessage.mockClear();

    const runner = reviewRunnerMocks.instances[0];
    runner.onChange('repo-a', 'review-3');

    expect(view2.webview.postMessage).toHaveBeenCalledWith({
      type: 'event',
      event: 'review.changed',
      data: { id: 'review-3' },
    });
    expect(view1.webview.postMessage).not.toHaveBeenCalled();
  });
});

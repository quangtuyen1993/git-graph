import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This file drives the *actual* registered `gitGraphPro.forge.signIn`
// command callback end to end, through the real BitbucketAuthProvider and
// BitbucketCloudProvider — unlike extension-view-session.test.ts, which
// stands BitbucketCloudProvider in with a stub. Two real defects on this
// path only show up once createSession() actually runs and its rejection
// round-trips through vscode.authentication.getSession, so that round trip
// has to be real too (simulated below), not stubbed away.

interface FakeSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: string[];
}

interface FakeAuthProvider {
  getSessions(scopes?: readonly string[]): Promise<FakeSession[]>;
  createSession(scopes: readonly string[]): Promise<FakeSession>;
}

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
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  getRemoteUrl: vi.fn(),
  push: vi.fn().mockResolvedValue(undefined),
  globalState: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
  registeredAuthProviders: new Map<string, FakeAuthProvider>(),
}));

/**
 * Stands in for `vscode.authentication.getSession`. The real one is not a
 * same-process function call: VS Code's authentication broker lives outside
 * the extension host, so a rejection from a provider's `createSession`
 * round-trips through it before reaching the caller. That round trip
 * reconstructs a plain `Error`, preserving `name`/`message`/`stack` but
 * dropping the subclass and any custom fields (`kind`, `hostMessage`, ...).
 * Both defects this file tests are invisible unless that loss is simulated —
 * a mock that just called `provider.createSession()` and let the real
 * `ForgeError`/`BitbucketSignInCancelledError` through untouched would pass
 * before either fix existed, and prove nothing.
 */
async function fakeGetSession(
  id: string, scopes: readonly string[], options?: { createIfNone?: boolean },
): Promise<FakeSession | undefined> {
  const provider = hostMocks.registeredAuthProviders.get(id);
  if (!provider) return undefined;
  const existing = await provider.getSessions(scopes);
  if (existing.length > 0) return existing[0];
  if (!options?.createIfNone) return undefined;
  try {
    return await provider.createSession(scopes);
  } catch (err) {
    const clean = new Error(err instanceof Error ? err.message : String(err));
    if (err instanceof Error) clean.name = err.name;
    throw clean;
  }
}

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
  authentication: {
    registerAuthenticationProvider: vi.fn((id: string, _label: string, provider: FakeAuthProvider) => {
      hostMocks.registeredAuthProviders.set(id, provider);
      return { dispose: vi.fn() };
    }),
    getSession: vi.fn(fakeGetSession),
  },
  window: {
    createWebviewPanel: hostMocks.createWebviewPanel,
    registerWebviewViewProvider: hostMocks.registerWebviewViewProvider,
    createTreeView: hostMocks.createTreeView,
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: hostMocks.showWarningMessage,
    showInformationMessage: hostMocks.showInformationMessage,
    showErrorMessage: hostMocks.showErrorMessage,
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

    push(remote?: string, branch?: string, options?: unknown): Promise<void> {
      return hostMocks.push(this.repoPath, remote, branch, options);
    }

    getRemoteUrl(remote: string): Promise<string | undefined> {
      return hostMocks.getRemoteUrl(this.repoPath, remote);
    }
  },
}));

vi.mock('../../src/extension/services/ai-review.service', () => ({
  AIReviewService: class {
    detectProviders = vi.fn();
    review = vi.fn();
  },
}));

vi.mock('../../src/extension/services/review-runner', () => ({
  ReviewRunner: class {
    cancelAll = vi.fn();
    onChange: (repoId: string, id: string) => void;
    constructor(_store: unknown, _service: unknown, onChange: (repoId: string, id: string) => void) {
      this.onChange = onChange;
    }
  },
}));

// The only Bitbucket-specific I/O this file controls: what the user typed
// (or didn't) and what verification found. Everything else — createSession,
// the cancellation/translation logic, the command handler — is real.
const bitbucketSignInMocks = vi.hoisted(() => ({
  prompt: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../../src/extension/services/forge/bitbucket/bitbucket-sign-in', () => ({
  promptForBitbucketCredentials: bitbucketSignInMocks.prompt,
  verifyBitbucketCredentials: bitbucketSignInMocks.verify,
}));

import { activate, deactivate } from '../../src/extension/extension';
import { ForgeError } from '../../src/extension/services/forge/forge.types';

async function activateExtension(): Promise<void> {
  const subscriptions: Array<{ dispose(): unknown }> = [];
  await activate({
    extensionUri: { toString: () => '/extension' },
    globalState: {
      get: (key: string) => hostMocks.globalState.get(key),
      update: async (key: string, value: unknown) => {
        hostMocks.globalState.set(key, value);
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
    subscriptions,
  } as never);
}

function signInCommand(): () => Promise<void> {
  const call = hostMocks.registerCommand.mock.calls.find(([command]) => command === 'gitGraphPro.forge.signIn');
  if (!call) throw new Error('gitGraphPro.forge.signIn was never registered');
  return call[1] as () => Promise<void>;
}

function signOutCommand(): () => Promise<void> {
  const call = hostMocks.registerCommand.mock.calls.find(([command]) => command === 'gitGraphPro.forge.signOut');
  if (!call) throw new Error('gitGraphPro.forge.signOut was never registered');
  return call[1] as () => Promise<void>;
}

describe('gitGraphPro.forge.signIn command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.globalState.clear();
    hostMocks.registeredAuthProviders.clear();
    hostMocks.workspaceFolders = [{ name: 'root', uri: { fsPath: '/workspace/root' } }];
    hostMocks.findRepo.mockImplementation(async (path: string) => path.replace('/workspace', '/repo'));
    hostMocks.getRemoteUrl.mockResolvedValue('git@bitbucket.org:acme/mpos.git');
  });

  afterEach(() => {
    deactivate();
  });

  // Defect 1: createSession must still throw on a cancelled prompt (the
  // vscode.AuthenticationProvider contract has no other way to say "no
  // session"), but the command must not report that as a failure — no
  // rejection out of the command, no stack trace, nothing in console.error.
  it('is a quiet no-op when the credential prompt is cancelled', async () => {
    bitbucketSignInMocks.prompt.mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await activateExtension();
    await expect(signInCommand()()).resolves.toBeUndefined();

    expect(hostMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Defect 2: an under-scoped/mistyped token fails verification with a
  // 'forbidden' ForgeError. The user must see the provider's own
  // description — naming the missing scopes — as a readable notification,
  // not the raw host message and not an uncaught command error.
  it('shows the provider\'s scope-naming description when verification is forbidden', async () => {
    bitbucketSignInMocks.prompt.mockResolvedValue({ token: 'bad-token' });
    bitbucketSignInMocks.verify.mockRejectedValue(
      new ForgeError('forbidden', 403, 'Your credentials lack one or more required privilege scopes.'),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await activateExtension();
    await expect(signInCommand()()).resolves.toBeUndefined();

    expect(consoleError).not.toHaveBeenCalled();
    expect(hostMocks.showErrorMessage).toHaveBeenCalledTimes(1);
    const [message] = hostMocks.showErrorMessage.mock.calls[0] as [string];
    expect(message).toContain('read:repository:bitbucket');
    expect(message).toContain('read:pullrequest:bitbucket');
    expect(message).toContain('write:pullrequest:bitbucket');
    // Not the raw, untranslated host message the user actually saw.
    expect(message).not.toBe('Your credentials lack one or more required privilege scopes.');
    consoleError.mockRestore();
  });

  it('signs in and reports no error when the token verifies', async () => {
    bitbucketSignInMocks.prompt.mockResolvedValue({ token: 'good-token' });
    bitbucketSignInMocks.verify.mockResolvedValue('Tuyen Nguyen');

    await activateExtension();
    await expect(signInCommand()()).resolves.toBeUndefined();

    expect(hostMocks.showErrorMessage).not.toHaveBeenCalled();
  });
});

describe('gitGraphPro.forge.signOut command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.globalState.clear();
    hostMocks.registeredAuthProviders.clear();
    hostMocks.workspaceFolders = [{ name: 'root', uri: { fsPath: '/workspace/root' } }];
    hostMocks.findRepo.mockImplementation(async (path: string) => path.replace('/workspace', '/repo'));
  });

  afterEach(() => {
    deactivate();
  });

  // The twin of defects 1/2 above: gitGraphPro.forge.signOut had the same
  // unguarded shape, and a repository with no forge remote — an ordinary,
  // everyday state, unlike every other forge.* case, which the webview only
  // reaches after forge.status has already gated it — used to throw
  // requireForge()'s "No pull request provider for this repository" out of
  // the command uncaught, reported as a failed command with a stack trace.
  it('is a quiet informational no-op when the repository has no forge remote', async () => {
    hostMocks.getRemoteUrl.mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await activateExtension();
    await expect(signOutCommand()()).resolves.toBeUndefined();

    expect(hostMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    // Says something useful rather than failing silently or throwing.
    expect(hostMocks.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message] = hostMocks.showInformationMessage.mock.calls[0] as [string];
    expect(message).toMatch(/no.*provider|nothing to sign out/i);
    consoleError.mockRestore();
  });
});

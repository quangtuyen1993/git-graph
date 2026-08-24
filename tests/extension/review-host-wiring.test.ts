import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review side must not be hostage to the graph webview. Activation must
 * succeed, register the reviews webview alongside the graph webview, and
 * reconcile whatever is sitting on disk — all without the extension host
 * ever resolving a webview view (the state a fresh window is in before the
 * user opens either tab).
 */

const hostMocks = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  registerWebviewViewProvider: vi.fn(),
  registerTextDocumentContentProvider: vi.fn(),
  createFileSystemWatcher: vi.fn(),
  openTextDocument: vi.fn(async () => ({ uri: 'doc' })),
  showTextDocument: vi.fn(async () => undefined),
  setTextDocumentLanguage: vi.fn(async () => undefined),
  storageRoot: '',
}));

const gitMocks = vi.hoisted(() => ({
  revParse: vi.fn(async (ref: string) => (ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40))),
  getDiff: vi.fn(async () => 'diff --git a/x b/x\n+one line\n'),
}));

const runnerMocks = vi.hoisted(() => ({
  start: vi.fn(async () => 'started-id'),
  cancel: vi.fn(() => true),
  isRunning: vi.fn(() => false),
  cancelAll: vi.fn(),
}));

// realpathSync is what getRepoId() resolves the repo path through; the paths in
// this test are fictional, so it stands in as identity.
vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(),
  realpathSync: (path: string) => path,
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath?: string }, ...rest: string[]) => ({
      fsPath: [base?.fsPath ?? String(base), ...rest].join('/'),
      toString: () => [base?.fsPath ?? String(base), ...rest].join('/'),
    }),
    file: (path: string) => ({ fsPath: path, toString: () => path }),
    from: () => ({ toString: () => 'uri' }),
  },
  EventEmitter: class {
    private listeners: Array<() => void> = [];
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(): void { this.listeners.forEach(listener => listener()); }
    dispose = vi.fn();
  },
  RelativePattern: class { constructor(public readonly base: string, public readonly pattern: string) {} },
  commands: { registerCommand: hostMocks.registerCommand, executeCommand: vi.fn() },
  languages: { setTextDocumentLanguage: hostMocks.setTextDocumentLanguage },
  window: {
    registerWebviewViewProvider: hostMocks.registerWebviewViewProvider,
    showTextDocument: hostMocks.showTextDocument,
    showWarningMessage: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ name: 'root', uri: { fsPath: '/workspace/root' } }],
    createFileSystemWatcher: hostMocks.createFileSystemWatcher,
    registerTextDocumentContentProvider: hostMocks.registerTextDocumentContentProvider,
    openTextDocument: hostMocks.openTextDocument,
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

vi.mock('../../src/extension/services/git.service', () => ({
  GitService: class {
    static findRepo(path: string): Promise<string | null> {
      return Promise.resolve(path.replace('/workspace', '/repo'));
    }

    constructor(private readonly repoPath: string) {}

    getRepoPath(): string { return this.repoPath; }
    gitDirectory(): Promise<string> { return Promise.resolve(`${this.repoPath}/.git`); }
    revParse(ref: string): Promise<string> { return gitMocks.revParse(ref); }
    getDiff(): Promise<string> { return gitMocks.getDiff(); }
    diff(): Promise<{ files: unknown[] }> { return Promise.resolve({ files: [] }); }
    log(): Promise<Array<{ subject: string }>> { return Promise.resolve([]); }
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
    start = runnerMocks.start;
    cancel = runnerMocks.cancel;
    isRunning = runnerMocks.isRunning;
    cancelAll = runnerMocks.cancelAll;
    constructor(_store: unknown, _service: unknown, _onChange: unknown) {}
  },
}));

import { activate } from '../../src/extension/extension';
import { repoIdFor } from '../../src/extension/services/review-key';
import type { ReviewEntry } from '../../src/extension/services/review-store';

const REPO_ID = repoIdFor('/repo/root');
const ENTRY_ID = 'aaaaaaa..bbbbbbb.claude.sonnet';

let storageRoot: string;
let subscriptions: Array<{ dispose(): unknown }>;

function persistedEntry(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    id: ENTRY_ID,
    kind: 'branch',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feat/x',
    headSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status: 'done',
    startedAt: '2026-08-24T00:00:00.000Z',
    finishedAt: '2026-08-24T00:05:00.000Z',
    ...over,
  };
}

async function seed(entries: ReviewEntry[]): Promise<string> {
  const dir = join(storageRoot, 'reviews', REPO_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify(entries, null, 2), 'utf8');
  for (const entry of entries) {
    await writeFile(join(dir, `${entry.id}.md`), 'the stored review', 'utf8');
  }
  return dir;
}

/** Activates without ever resolving a webview view. */
async function activateHeadless(): Promise<void> {
  subscriptions = [];
  await activate({
    extensionUri: { toString: () => '/extension' },
    globalStorageUri: { fsPath: storageRoot },
    globalState: { get: () => undefined, update: async () => undefined },
    subscriptions,
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  runnerMocks.isRunning.mockReturnValue(false);
  runnerMocks.start.mockResolvedValue('started-id');
  storageRoot = await mkdtemp(join(tmpdir(), 'review-host-'));
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('the review host without a graph webview ever resolving', () => {
  it('registers the reviews webview alongside the graph webview', async () => {
    await activateHeadless();

    const registered = hostMocks.registerWebviewViewProvider.mock.calls.map(c => c[0]);
    expect(registered).toContain('gitGraphPro.graph');
    expect(registered).toContain('gitGraphPro.reviews');
  });

  it('registers the reviews webview so it survives the panel hiding', async () => {
    await activateHeadless();

    const call = hostMocks.registerWebviewViewProvider.mock.calls
      .find(([viewType]) => viewType === 'gitGraphPro.reviews');
    expect(call?.[2]).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
  });

  it('reconciles a review left running by a previous window', async () => {
    // I1: getRepoId() and reconcileOrphans() must reach the on-disk store on
    // activation even though nothing ever resolves a webview.
    const dir = await seed([persistedEntry({ status: 'running' })]);

    await activateHeadless();

    const [stored] = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(stored.status).toBe('interrupted');
  });

  it('activates cleanly when nothing has ever been stored for the repo', async () => {
    await expect(activateHeadless()).resolves.toBeUndefined();
  });
});

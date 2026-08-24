import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review side must not be hostage to the graph webview. These tests
 * activate the extension and never resolve a webview view — the state a fresh
 * window is in when the user opens the Code Review tab (activation via
 * `onView:gitGraphPro.reviews`).
 */

const hostMocks = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
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
  ThemeIcon: class { constructor(public readonly id: string) {} },
  TreeItem: class {
    description?: string;
    iconPath?: unknown;
    contextValue?: string;
    tooltip?: string;
    command?: unknown;
    constructor(public readonly label: string) {}
  },
  RelativePattern: class { constructor(public readonly base: string, public readonly pattern: string) {} },
  commands: { registerCommand: hostMocks.registerCommand, executeCommand: vi.fn() },
  languages: { setTextDocumentLanguage: hostMocks.setTextDocumentLanguage },
  window: {
    registerWebviewViewProvider: hostMocks.registerWebviewViewProvider,
    createTreeView: hostMocks.createTreeView,
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

function treeProvider(): { getChildren(): Promise<ReviewEntry[]>; dispose(): void } {
  const call = hostMocks.createTreeView.mock.calls
    .find(([id]) => id === 'gitGraphPro.reviews') as unknown as [string, { treeDataProvider: never }];
  return call[1].treeDataProvider;
}

function command(id: string): (entry: ReviewEntry) => Promise<void> {
  const call = hostMocks.registerCommand.mock.calls.find(([name]) => name === id);
  return call?.[1] as (entry: ReviewEntry) => Promise<void>;
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

describe('the review view without a graph webview', () => {
  it('lists persisted reviews when no webview has ever been resolved', async () => {
    // I1: getRepoId() used to come from the webview session, so the view was
    // empty in a fresh window despite reviews sitting on disk.
    await seed([persistedEntry()]);
    await activateHeadless();

    const rows = await treeProvider().getChildren();

    expect(rows.map(row => row.id)).toEqual([ENTRY_ID]);
  });

  it('opens a row body with no webview attached', async () => {
    await seed([persistedEntry()]);
    await activateHeadless();

    await command('gitGraphPro.review.open')(persistedEntry());

    expect(hostMocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: join(storageRoot, 'reviews', REPO_ID, `${ENTRY_ID}.md`) }),
    );
    expect(hostMocks.showTextDocument).toHaveBeenCalled();
  });

  it('deletes a row with no webview attached', async () => {
    const dir = await seed([persistedEntry()]);
    await activateHeadless();

    await command('gitGraphPro.review.delete')(persistedEntry());

    await expect(readFile(join(dir, `${ENTRY_ID}.md`), 'utf8')).rejects.toThrow();
    expect(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))).toEqual([]);
  });

  it('reruns a row with no webview attached', async () => {
    // I2: rerun returned early whenever no webview session was live, so the
    // command silently did nothing.
    const dir = await seed([persistedEntry()]);
    await activateHeadless();

    await command('gitGraphPro.review.rerun')(persistedEntry());

    expect(runnerMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      repoId: REPO_ID,
      baseRef: 'main',
      headRef: 'feat/x',
      provider: 'claude',
      model: 'sonnet',
    }));
    // The stale entry is dropped first; the fresh run owns the id from here.
    expect(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))).toEqual([]);
  });

  it('registers the tree provider as a disposable so its emitter is released', async () => {
    // M2
    await activateHeadless();

    expect(subscriptions).toContain(treeProvider() as never);
  });
});

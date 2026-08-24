import { realpathSync } from 'fs';
import * as vscode from 'vscode';
import { MessageRouter } from './controllers/message-router';
import { RepositorySession, type RepositoryInfo } from './controllers/repository-session';
import { GitGraphWebviewProvider } from './providers/webview-provider';
import { GitService } from './services/git.service';
import type { ReviewRunner } from './services/review-runner';
import type { WebviewHost } from './types/webview-host.types';

let webviewProvider: GitGraphWebviewProvider;

// The single ReviewRunner constructed in activate() below. Held here so
// deactivate() can kill every in-flight CLI process — without this, a
// detached review process keeps running (and keeps spending) after the
// window closes.
let activeRunner: ReviewRunner | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const repos: RepositoryInfo[] = [];

  if (workspaceFolders && workspaceFolders.length > 0) {
    for (const folder of workspaceFolders) {
      const repoPath = await GitService.findRepo(folder.uri.fsPath);
      if (repoPath) {
        repos.push({ path: repoPath, name: folder.name });
      }
    }
  }

  const GIT_GRAPH_SCHEME = 'git-graph-pro-diff';
  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    private contents = new Map<string, string>();
    private readonly maxEntries = 100;

    setContent(uri: string, content: string): void {
      if (this.contents.size >= this.maxEntries) {
        const oldestKey = this.contents.keys().next().value;
        if (oldestKey !== undefined) this.contents.delete(oldestKey);
      }
      this.contents.set(uri, content);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
      return this.contents.get(uri.toString()) ?? '';
    }
  })();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_GRAPH_SCHEME, contentProvider),
  );

  const { AIReviewService } = await import('./services/ai-review.service');
  const aiReview = new AIReviewService();
  let nextPanelSessionId = 0;

  const { ReviewStore } = await import('./services/review-store');
  const { ReviewRunner } = await import('./services/review-runner');
  const { createReviewHandler } = await import('./controllers/review-method-handler');
  const { repoIdFor } = await import('./services/review-key');
  const { ReviewTreeProvider } = await import('./providers/review-tree-provider');
  const { registerReviewView } = await import('./providers/review-view-registration');

  // ReviewStore's constructor only assigns a field; it cannot throw. reconcileOrphans()
  // does real I/O (readdir/readFile/writeFile against globalStorageUri) and must never
  // take activation down with it — a missing directory or an unreadable index degrades
  // to "orphaned runs stay marked running" rather than a failed activation.
  const reviewStore = new ReviewStore(vscode.Uri.joinPath(context.globalStorageUri, 'reviews').fsPath);
  try {
    await reviewStore.reconcileOrphans();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[extension] Failed to reconcile orphaned reviews: ${message}`);
  }

  // The live session/router, for consumers that have no webview to ask (the
  // review tree view, Task 11's status-bar clock) and for routing events back
  // to whichever webview is currently attached. Assigned by createSession
  // below and cleared on dispose.
  let activeSession: RepositorySession | undefined;
  let activeRouter: MessageRouter | undefined;
  // The current session's review method handler, for the reviews tree view's
  // rerun command — it has no webview message to piggyback on, so it needs a
  // direct line to whichever session is live. Mirrors activeSession/activeRouter.
  let activeReviewHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;

  const getRepoId = (): string | undefined => {
    const repoPath = activeSession?.getActiveRepositoryPath();
    return repoPath ? repoIdFor(realpathSync(repoPath)) : undefined;
  };

  // Assigned by Task 11 once the review tree view and status-bar clock exist.
  // Declared here (rather than left undefined-and-optional-chained on an
  // undeclared name) so the onChange callback below type-checks today.
  let reviewTree: { refresh(): void } | undefined;
  let syncTicker: (() => Promise<void>) | undefined;

  // One runner for the whole extension, not one per session: its in-flight
  // map is the source of truth for cross-session dedup (review.start
  // idempotency), so a second session for the same repo must see the first
  // session's in-flight run rather than falling back to the store's
  // persisted status.
  const reviewRunner = new ReviewRunner(reviewStore, aiReview, (_repoId, id) => {
    activeRouter?.sendEvent('review.changed', { id });
    reviewTree?.refresh();            // undefined until Task 11 registers the view
    void syncTicker?.();              // undefined until Task 11 adds the clock
  });
  activeRunner = reviewRunner;         // held at module scope so deactivate() can cancelAll()

  // Hoisted out of createSession: it only touches reviewStore and vscode, not
  // the session, so the reviews tree view (Task 11) can share it too.
  const openBody = async (repoId: string, id: string): Promise<void> => {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(reviewStore.bodyPath(repoId, id)),
    );
    await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  function createSession(host: WebviewHost): () => void {
    const panelSessionId = ++nextPanelSessionId;
    let virtualDocumentRequestSequence = 0;
    const router = new MessageRouter();
    const session = new RepositorySession({
      initialRepository: repos[0] ?? null,
      repositories: repos,
    });
    activeSession = session;
    activeRouter = router;

    let gitWatcher: vscode.FileSystemWatcher | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let watcherGeneration = 0;
    let disposed = false;
    let repositorySwitchQueue = Promise.resolve();

    async function bindGitWatcher(): Promise<void> {
      const generation = ++watcherGeneration;
      gitWatcher?.dispose();
      gitWatcher = undefined;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      const gitService = session.getGitService();
      if (!gitService) return;

      try {
        const gitDirectory = await gitService.gitDirectory();
        if (disposed || generation !== watcherGeneration) return;

        gitWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(gitDirectory, '{HEAD,refs/**,index}'),
        );
        const invalidate = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            session.invalidate();
            router.sendEvent('git.refsChanged');
            router.sendEvent('graph.invalidated');
          }, 500);
        };
        gitWatcher.onDidChange(invalidate);
        gitWatcher.onDidCreate(invalidate);
        gitWatcher.onDidDelete(invalidate);
      } catch (error) {
        if (disposed || generation !== watcherGeneration) return;
        gitWatcher?.dispose();
        gitWatcher = undefined;
        const message = error instanceof Error ? error.message : String(error);
        const warning = vscode.window.showWarningMessage(`Unable to watch Git repository: ${message}`);
        void Promise.resolve(warning).catch(() => undefined);
      }
    }

    /**
     * Every repository change goes through here: the switch itself, then the
     * watcher rebind. Queued, because two switches racing would leave the
     * watcher pointing at the loser's .git directory.
     */
    function queueRepositorySwitch(params: unknown): Promise<unknown> {
      const run = async () => {
        const result = await session.handleRepo('repo.switch', params);
        await bindGitWatcher();
        return result;
      };
      const result = repositorySwitchQueue.then(run, run);
      repositorySwitchQueue = result.then(() => undefined, () => undefined);
      return result;
    }

    router.register('repo', async (method: string, params: unknown) => {
      if (method === 'repo.switch') return queueRepositorySwitch(params);
      return session.handleRepo(method, params);
    });
    router.register('git', (method: string, params: unknown) => session.handleGit(method, params));
    router.register('graph', (method: string, params: unknown) => session.handleGraph(method, params));

    router.register('ui', async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'ui.getState': {
          const key = p.key as string;
          return context.globalState.get(key) ?? null;
        }
        case 'ui.setState': {
          const key = p.key as string;
          await context.globalState.update(key, p.value);
          return { success: true };
        }
        case 'ui.inputBox': {
          const result = await vscode.window.showInputBox({
            prompt: p.prompt as string,
            placeHolder: p.placeholder as string,
            value: p.value as string | undefined,
          });
          return result ?? null;
        }
        case 'ui.confirm': {
          const answer = await vscode.window.showWarningMessage(
            p.message as string,
            { modal: true },
            'Yes',
          );
          return answer === 'Yes';
        }
        case 'ui.openDiff': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const filePath = p.path as string;
          const oldPath = p.oldPath as string | null | undefined;
          const hash = p.hash as string;
          const status = (p.status as string) ?? 'modified';
          const parents = await gitService.getParents(hash);
          const parentHash = parents.length > 0 ? parents[0] : null;
          let parentContent = '';
          if (parentHash && status !== 'added') {
            parentContent = await gitService.showFile(parentHash, oldPath ?? filePath) ?? '';
          }

          const shortHash = hash.substring(0, 7);
          const fileName = filePath.split('/').pop() ?? filePath;
          const virtualDocumentRequestId = ++virtualDocumentRequestSequence;
          const parentUri = vscode.Uri.from({
            scheme: GIT_GRAPH_SCHEME,
            path: `/${oldPath ?? filePath}`,
            query: `ref=${parentHash ?? 'empty'}&ts=${Date.now()}&session=${panelSessionId}&request=${virtualDocumentRequestId}&side=parent`,
          });
          contentProvider.setContent(parentUri.toString(), parentContent);

          const headHash = (await gitService.getHeadHash().catch(() => null)) ?? null;
          const isHeadCommit = !!headHash && headHash === hash;
          let currentUri: vscode.Uri;
          if (isHeadCommit && status !== 'deleted') {
            currentUri = vscode.Uri.joinPath(vscode.Uri.file(gitService.getRepoPath()), filePath);
          } else {
            const currentContent = await gitService.showFile(hash, filePath) ?? '';
            currentUri = vscode.Uri.from({
              scheme: GIT_GRAPH_SCHEME,
              path: `/${filePath}`,
              query: `ref=${hash}&ts=${Date.now()}&session=${panelSessionId}&request=${virtualDocumentRequestId}&side=current`,
            });
            contentProvider.setContent(currentUri.toString(), currentContent);
          }

          let title: string;
          if (status === 'added') {
            title = `${fileName} (added in ${shortHash})`;
          } else if (status === 'deleted') {
            title = `${fileName} (deleted in ${shortHash})`;
          } else {
            title = `${fileName} (${parentHash?.substring(0, 7) ?? '∅'} → ${shortHash})`;
          }
          await vscode.commands.executeCommand('vscode.diff', parentUri, currentUri, title);
          return { success: true };
        }
        case 'ui.openFolder': {
          const folderUri = vscode.Uri.file(p.path as string);
          await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: true });
          return { success: true };
        }
        case 'ui.openReviewDocument': {
          const content = p.content as string;
          const label = (p.label as string) ?? 'review';
          if (!content?.trim()) throw new Error('Nothing to open — run a review first');

          // Write to a real file so the editor tab gets a meaningful name and the
          // user can edit/save it. The path is derived from the label, so
          // re-running the same comparison overwrites instead of accumulating.
          const os = await import('os');
          const fsp = await import('fs/promises');
          const path = await import('path');

          const slug = label
            .replace(/[^\w.-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'review';
          const dir = path.join(os.tmpdir(), 'git-graph-pro-reviews');
          await fsp.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${slug}.md`);
          await fsp.writeFile(file, content, 'utf8');

          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Active,
            preview: false,
          });
          return { success: true, path: file };
        }
        case 'ui.pickBranch': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const branchList = await gitService.branches();
          const exclude = p.exclude as string | undefined;
          const items = branchList
            .filter(branch => branch.name !== exclude)
            .map(branch => ({
              label: branch.name,
              description: branch.current ? '(current)' : (branch.remote ? 'remote' : ''),
            }));
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: (p.placeholder as string) ?? 'Select a branch',
            title: (p.title as string) ?? 'Compare with...',
          });
          return picked ? picked.label : null;
        }
        case 'ui.compareDiff': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const filePath = p.path as string;
          const oldPath = p.oldPath as string | null | undefined;
          const baseBranch = p.sourceBranch as string;
          const headBranch = p.targetBranch as string;
          const status = (p.status as string) ?? 'modified';
          const baseContent = status !== 'added'
            ? await gitService.showFile(baseBranch, oldPath ?? filePath) ?? ''
            : '';
          const fileName = filePath.split('/').pop() ?? filePath;
          const virtualDocumentRequestId = ++virtualDocumentRequestSequence;
          const baseUri = vscode.Uri.from({
            scheme: GIT_GRAPH_SCHEME,
            path: `/${oldPath ?? filePath}`,
            query: `ref=${baseBranch}&ts=${Date.now()}&session=${panelSessionId}&request=${virtualDocumentRequestId}&side=base`,
          });
          contentProvider.setContent(baseUri.toString(), baseContent);

          const branchList = await gitService.branches();
          const currentBranch = branchList.find(branch => branch.current)?.name;
          const headIsCheckedOut = !!currentBranch && currentBranch === headBranch;
          let headUri: vscode.Uri;
          if (headIsCheckedOut && status !== 'deleted') {
            headUri = vscode.Uri.joinPath(vscode.Uri.file(gitService.getRepoPath()), filePath);
          } else {
            const headContent = status !== 'deleted'
              ? await gitService.showFile(headBranch, filePath) ?? ''
              : '';
            headUri = vscode.Uri.from({
              scheme: GIT_GRAPH_SCHEME,
              path: `/${filePath}`,
              query: `ref=${headBranch}&ts=${Date.now()}&session=${panelSessionId}&request=${virtualDocumentRequestId}&side=head`,
            });
            contentProvider.setContent(headUri.toString(), headContent);
          }

          let title: string;
          if (status === 'added') {
            title = `${fileName} (added in ${headBranch})`;
          } else if (status === 'deleted') {
            title = `${fileName} (deleted in ${headBranch})`;
          } else {
            title = `${fileName} (${baseBranch} → ${headBranch})`;
          }
          await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title);
          return { success: true };
        }
        case 'ui.openSubmodule': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const submodule = await gitService.resolveSubmodule(p.path as string);
          const added = await session.addRepository({
            name: submodule.name,
            path: submodule.absolutePath,
          });
          return queueRepositorySwitch({ path: added.path });
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });

    router.register('ping', async () => ({ pong: true, timestamp: Date.now() }));

    router.register('ai', async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'ai.providers':
          return aiReview.detectProviders();
        case 'ai.compare': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const baseBranch = p.sourceBranch as string;
          const headBranch = p.targetBranch as string;
          const result = await gitService.diff(baseBranch, headBranch);
          return { files: result.files };
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });

    const reviewHandler = createReviewHandler({
      store: reviewStore,
      runner: reviewRunner,
      getGitService: () => session.getGitService() as never,
      getRepoId,
      getMaxDiffChars: () =>
        vscode.workspace.getConfiguration('gitGraphPro.aiReview').get<number>('maxDiffChars') ?? 0,
      openBody,
    });
    router.register('review', reviewHandler);
    activeReviewHandler = reviewHandler;

    router.setHost(host);
    void bindGitWatcher();

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      watcherGeneration += 1;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      gitWatcher?.dispose();
      gitWatcher = undefined;
      if (activeSession === session) activeSession = undefined;
      if (activeRouter === router) activeRouter = undefined;
      if (activeReviewHandler === reviewHandler) activeReviewHandler = undefined;
      router.dispose();
    };

    host.onDidDispose(dispose);

    return dispose;
  }

  webviewProvider = new GitGraphWebviewProvider(
    context.extensionUri,
    (host) => createSession(host),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitGraphWebviewProvider.viewType,
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    void vscode.commands.executeCommand('gitGraphPro.graph.focus');
  });
  context.subscriptions.push(openCommand);

  const treeProvider = new ReviewTreeProvider(reviewStore, getRepoId);
  reviewTree = treeProvider;

  // One timer for the whole view, started only while a run is in flight and
  // stopped when the last one ends, so a running row's clock advances without
  // a stray setInterval outliving the extension.
  let tick: ReturnType<typeof setInterval> | undefined;
  syncTicker = async () => {
    let running = false;
    try {
      // getRepoId() does a synchronous realpathSync — a repo that vanished (or
      // renamed) between the run starting and this tick can throw. A ticker
      // glitch must not throw out of onChange or leave a dangling interval;
      // treat "can't tell" as "not running" and let the next onChange retry.
      const repoId = getRepoId();
      if (repoId) {
        running = (await reviewStore.list(repoId)).some(entry => entry.status === 'running');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[extension] Failed to check in-flight reviews: ${message}`);
    }
    if (running && !tick) {
      tick = setInterval(() => treeProvider.refresh(), 1000);
    } else if (!running && tick) {
      clearInterval(tick);
      tick = undefined;
    }
  };
  context.subscriptions.push({
    dispose: () => {
      if (tick) clearInterval(tick);
      tick = undefined;
    },
  });

  registerReviewView({
    tree: treeProvider,
    runner: reviewRunner,
    store: reviewStore,
    getRepoId,
    openBody,
    rerun: async (entry) => {
      let repoId: string | undefined;
      try {
        // Same hazard as syncTicker above: getRepoId() can throw if the repo
        // path is gone. Rerun must be a no-op then, not an unhandled rejection.
        repoId = getRepoId();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[extension] Failed to resolve repo for rerun: ${message}`);
        return;
      }
      if (!repoId || !activeReviewHandler) return;
      await reviewStore.remove(repoId, entry.id);
      await activeReviewHandler('review.start', {
        sourceBranch: entry.sourceBranch,
        targetBranch: entry.targetBranch,
        provider: entry.provider,
        model: entry.model,
      });
    },
    registerCommand: (id, fn) => vscode.commands.registerCommand(id, fn),
    registerTreeView: (id, tree) => vscode.window.createTreeView(id, { treeDataProvider: tree }),
    subscribe: (d) => context.subscriptions.push(d),
  });
}

export function deactivate(): void {
  // Panel-owned resources are disposed by their panel disposal listeners.

  // Nothing must outlive the window. Without this, detached CLI process groups
  // keep running and keep spending after VS Code is gone.
  activeRunner?.cancelAll();
  activeRunner = undefined;
}

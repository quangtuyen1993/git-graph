import { realpathSync } from 'fs';
import * as vscode from 'vscode';
import { MessageRouter } from './controllers/message-router';
import { RepositorySession, type RepositoryInfo } from './controllers/repository-session';
import {
  GitGraphWebviewProvider,
  type PanelRequest,
} from './providers/webview-provider';
import { GitService } from './services/git.service';

let webviewProvider: GitGraphWebviewProvider;

// Every ReviewRunner constructed across panel sessions is registered here so
// deactivate() can kill every in-flight CLI process. Without this, a detached
// review process keeps running (and keeps spending) after the window closes.
const runners: { cancelAll(): void }[] = [];

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

  // Assigned by Task 11 once the review tree view and status-bar clock exist.
  // Declared here (rather than left undefined-and-optional-chained on an
  // undeclared name) so the onChange callback below type-checks today.
  let reviewTree: { refresh(): void } | undefined;
  let syncTicker: (() => Promise<void>) | undefined;

  function createPanelSession(panel: vscode.WebviewPanel, request: PanelRequest): void {
    const panelSessionId = ++nextPanelSessionId;
    let virtualDocumentRequestSequence = 0;
    const router = new MessageRouter();
    const session = request.kind === 'root'
      ? new RepositorySession({
          initialRepository: repos[0] ?? null,
          repositories: repos,
        })
      : new RepositorySession({
          initialRepository: { name: request.repoName, path: request.repoPath },
          repositories: [{ name: request.repoName, path: request.repoPath }],
        });

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

    router.register('repo', async (method: string, params: unknown) => {
      if (request.kind === 'root' && method === 'repo.switch') {
        const switchRepository = async () => {
          const result = await session.handleRepo(method, params);
          await bindGitWatcher();
          return result;
        };
        const result = repositorySwitchQueue.then(switchRepository, switchRepository);
        repositorySwitchQueue = result.then(() => undefined, () => undefined);
        return result;
      }
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
            viewColumn: vscode.ViewColumn.Beside,
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
          await webviewProvider.openRepositoryPanel(submodule.absolutePath, submodule.name);
          return { success: true };
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

    const reviewRunner = new ReviewRunner(reviewStore, aiReview, (_repoId, id) => {
      router.sendEvent('review.changed', { id });
      reviewTree?.refresh();            // undefined until Task 11 registers the view
      void syncTicker?.();              // undefined until Task 11 adds the clock
    });
    runners.push(reviewRunner);         // module-level array, drained in deactivate

    const getRepoId = (): string | undefined => {
      const repoPath = session.getGitService()?.getRepoPath();
      return repoPath ? repoIdFor(realpathSync(repoPath)) : undefined;
    };

    const openBody = async (repoId: string, id: string): Promise<void> => {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(reviewStore.bodyPath(repoId, id)),
      );
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
      await vscode.window.showTextDocument(doc, { preview: false });
    };

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

    router.setPanel(panel);
    void bindGitWatcher();

    panel.onDidDispose(() => {
      disposed = true;
      watcherGeneration += 1;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      gitWatcher?.dispose();
      gitWatcher = undefined;
      router.dispose();
    });
  }

  webviewProvider = new GitGraphWebviewProvider(
    context.extensionUri,
    (panel, request) => createPanelSession(panel, request),
  );

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    webviewProvider.openPanel();
  });
  context.subscriptions.push(openCommand);
}

export function deactivate(): void {
  // Panel-owned resources are disposed by their panel disposal listeners.

  // Nothing must outlive the window. Without this, detached CLI process groups
  // keep running and keep spending after VS Code is gone.
  for (const runner of runners) runner.cancelAll();
  runners.length = 0;
}

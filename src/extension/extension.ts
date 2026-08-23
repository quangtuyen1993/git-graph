import * as vscode from 'vscode';
import { MessageRouter } from './controllers/message-router';
import { RepositorySession, type RepositoryInfo } from './controllers/repository-session';
import {
  GitGraphWebviewProvider,
  type PanelRequest,
} from './providers/webview-provider';
import { GitService } from './services/git.service';

let webviewProvider: GitGraphWebviewProvider;

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

  const GIT_GRAPH_SCHEME = 'git-graph';
  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    private contents = new Map<string, string>();

    setContent(uri: string, content: string): void {
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

  function createPanelSession(panel: vscode.WebviewPanel, request: PanelRequest): void {
    const router = new MessageRouter();
    const session = request.kind === 'root'
      ? new RepositorySession({
          initialRepository: repos[0] ?? null,
          repositories: repos,
          allowRepositorySwitch: true,
        })
      : new RepositorySession({
          initialRepository: { name: request.repoName, path: request.repoPath },
          repositories: [{ name: request.repoName, path: request.repoPath }],
          allowRepositorySwitch: false,
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
          const currentContent = await gitService.showFile(hash, filePath) ?? '';
          let parentContent = '';
          if (parentHash && status !== 'added') {
            parentContent = await gitService.showFile(parentHash, oldPath ?? filePath) ?? '';
          }

          const shortHash = hash.substring(0, 7);
          const fileName = filePath.split('/').pop() ?? filePath;
          const parentUri = vscode.Uri.parse(`${GIT_GRAPH_SCHEME}:${oldPath ?? filePath}?ref=${parentHash ?? 'empty'}&ts=${Date.now()}`);
          const currentUri = vscode.Uri.parse(`${GIT_GRAPH_SCHEME}:${filePath}?ref=${hash}&ts=${Date.now()}`);
          contentProvider.setContent(parentUri.toString(), parentContent);
          contentProvider.setContent(currentUri.toString(), currentContent);

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
          const sourceBranch = p.sourceBranch as string;
          const targetBranch = p.targetBranch as string;
          const status = (p.status as string) ?? 'modified';
          const targetContent = status !== 'added'
            ? await gitService.showFile(targetBranch, oldPath ?? filePath) ?? ''
            : '';
          const sourceContent = status !== 'deleted'
            ? await gitService.showFile(sourceBranch, filePath) ?? ''
            : '';
          const fileName = filePath.split('/').pop() ?? filePath;
          const targetUri = vscode.Uri.parse(`${GIT_GRAPH_SCHEME}:${oldPath ?? filePath}?ref=${targetBranch}&ts=${Date.now()}`);
          const sourceUri = vscode.Uri.parse(`${GIT_GRAPH_SCHEME}:${filePath}?ref=${sourceBranch}&ts=${Date.now()}`);
          contentProvider.setContent(targetUri.toString(), targetContent);
          contentProvider.setContent(sourceUri.toString(), sourceContent);
          const title = `${fileName} (${targetBranch} → ${sourceBranch})`;
          await vscode.commands.executeCommand('vscode.diff', targetUri, sourceUri, title);
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
          const sourceBranch = p.sourceBranch as string;
          const targetBranch = p.targetBranch as string;
          const result = await gitService.diff(targetBranch, sourceBranch);
          return { files: result.files };
        }
        case 'ai.review': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const sourceBranch = p.sourceBranch as string;
          const targetBranch = p.targetBranch as string;
          const provider = p.provider as string;
          const model = p.model as string | undefined;
          const diff = await gitService.getDiff(sourceBranch, targetBranch);
          if (!diff.trim()) {
            return {
              content: 'No differences found between branches.',
              provider,
              model: model ?? '',
              timestamp: new Date().toISOString(),
            };
          }

          const maxChars = 100_000;
          const truncatedDiff = diff.length > maxChars
            ? diff.substring(0, maxChars) + `\n\n... (truncated, ${diff.length - maxChars} chars omitted)`
            : diff;
          return aiReview.review({ diff: truncatedDiff, provider, model });
        }
        case 'ai.reviewDiff': {
          const diff = p.diff as string;
          const provider = p.provider as string;
          const model = p.model as string | undefined;
          return aiReview.review({ diff, provider, model });
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    });

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
}

import * as vscode from 'vscode';
import { GitGraphWebviewProvider } from './providers/webview-provider';
import { MessageRouter } from './controllers/message-router';
import { GitService } from './services/git.service';
import { GraphService } from './services/graph.service';
import type { GitLogOptions } from './types/git.types';
import type { GraphOptions } from './types/graph.types';

let webviewProvider: GitGraphWebviewProvider;

export function activate(context: vscode.ExtensionContext): void {
  const router = new MessageRouter();

  // Determine repo path from workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  let gitService: GitService | null = null;
  const graphService = new GraphService();

  if (workspaceFolders && workspaceFolders.length > 0) {
    const rootPath = workspaceFolders[0].uri.fsPath;
    gitService = new GitService(rootPath);
  }

  // Register git namespace handler
  router.register('git', async (method: string, params: unknown) => {
    if (!gitService) {
      throw new Error('No git repository found in workspace');
    }

    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'git.log':
        return gitService.log(p as GitLogOptions);
      case 'git.branches':
        return gitService.branches();
      case 'git.tags':
        return gitService.tags();
      case 'git.status':
        return gitService.status();
      case 'git.show':
        return gitService.show(p.hash as string);
      case 'git.diff':
        return gitService.diff(p.ref1 as string, p.ref2 as string);
      case 'git.checkout':
        await gitService.checkout(p.ref as string);
        return { success: true };
      case 'git.createBranch':
        await gitService.createBranch(p.name as string, p.startPoint as string | undefined);
        return { success: true };
      case 'git.deleteBranch':
        await gitService.deleteBranch(p.name as string, p.force as boolean | undefined);
        return { success: true };
      case 'git.merge':
        await gitService.merge(p.branch as string, p.options as { noFF?: boolean; message?: string } | undefined);
        return { success: true };
      case 'git.rebase':
        await gitService.rebase(p.onto as string);
        return { success: true };
      case 'git.cherryPick':
        await gitService.cherryPick(p.hash as string);
        return { success: true };
      case 'git.stash':
        return gitService.stash(
          p.action as 'push' | 'pop' | 'drop' | 'list',
          p.options as { message?: string; index?: number } | undefined
        );
      case 'git.push':
        await gitService.push(
          p.remote as string | undefined,
          p.branch as string | undefined,
          p.options as { force?: boolean; setUpstream?: boolean } | undefined
        );
        return { success: true };
      case 'git.pull':
        await gitService.pull(
          p.remote as string | undefined,
          p.branch as string | undefined,
          p.options as { rebase?: boolean } | undefined
        );
        return { success: true };
      case 'git.fetch':
        await gitService.fetch(p.remote as string | undefined);
        return { success: true };
      case 'git.reset':
        await gitService.reset(p.mode as 'soft' | 'mixed' | 'hard', p.ref as string);
        return { success: true };
      case 'git.createTag':
        await gitService.createTag(p.name as string, p.hash as string | undefined, p.message as string | undefined);
        return { success: true };
      case 'git.deleteTag':
        await gitService.deleteTag(p.name as string);
        return { success: true };
      case 'git.abortMerge':
        await gitService.abortMerge();
        return { success: true };
      case 'git.abortRebase':
        await gitService.abortRebase();
        return { success: true };
      case 'git.squash':
        await gitService.squash(p.hashes as string[], p.message as string);
        return { success: true };
      case 'git.canSquash':
        return gitService.canSquash(p.hashes as string[]);
      case 'git.isOnCurrentBranch':
        return { onBranch: await gitService.isOnCurrentBranch(p.hash as string) };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // Register graph namespace handler
  router.register('graph', async (method: string, params: unknown) => {
    if (!gitService) {
      throw new Error('No git repository found in workspace');
    }

    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'graph.build': {
        const options = p as GraphOptions;
        const logOptions: GitLogOptions = {
          maxCount: options.maxCount ?? 500,
          skip: options.skip,
          branch: options.branch,
          all: options.all ?? true
        };
        const commits = await gitService.log(logOptions);
        const layout = graphService.buildLayout(commits);

        // Fetch shortstat and merge into nodes
        try {
          const stats = await gitService.getShortStats(logOptions.maxCount ?? 500, logOptions.all ?? true);
          for (const node of layout.nodes) {
            const stat = stats.get(node.hash);
            if (stat) {
              node.filesChanged = stat.filesChanged;
              node.additions = stat.additions;
              node.deletions = stat.deletions;
            }
          }
        } catch {
          // Stats are optional — don't fail the build if this errors
        }

        return { totalRows: layout.totalRows, maxLane: layout.maxLane };
      }
      case 'graph.getWindow': {
        const startRow = (p.startRow as number) ?? 0;
        const count = (p.count as number) ?? 50;
        return graphService.getWindow(startRow, count);
      }
      case 'graph.getLayout': {
        return {
          totalRows: graphService.getTotalRows(),
          maxLane: graphService.getMaxLane()
        };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // Register a content provider for showing git file content in diff editor
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
    vscode.workspace.registerTextDocumentContentProvider(GIT_GRAPH_SCHEME, contentProvider)
  );

  // Register UI namespace handler for native VS Code dialogs
  router.register('ui', async (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'ui.inputBox': {
        const result = await vscode.window.showInputBox({
          prompt: p.prompt as string,
          placeHolder: p.placeholder as string,
          value: p.value as string | undefined,
        });
        return result ?? null; // null means cancelled
      }
      case 'ui.confirm': {
        const answer = await vscode.window.showWarningMessage(
          p.message as string,
          { modal: true },
          'Yes'
        );
        return answer === 'Yes';
      }
      case 'ui.openDiff': {
        if (!gitService) throw new Error('No git repository found');
        const filePath = p.path as string;
        const hash = p.hash as string;
        const status = (p.status as string) ?? 'modified';

        // Get parent commit
        const parents = await gitService.getParents(hash);
        const parentHash = parents.length > 0 ? parents[0] : null;

        // Get file content at current commit
        const currentContent = await gitService.showFile(hash, filePath) ?? '';

        // Get file content at parent commit (empty for added files)
        let parentContent = '';
        if (parentHash && status !== 'added') {
          parentContent = await gitService.showFile(parentHash, filePath) ?? '';
        }

        const shortHash = hash.substring(0, 7);
        const fileName = filePath.split('/').pop() ?? filePath;

        // Create URIs for the virtual documents
        const parentUri = vscode.Uri.parse(`${GIT_GRAPH_SCHEME}:${filePath}?ref=${parentHash ?? 'empty'}&ts=${Date.now()}`);
        const currentUri = vscode.Uri.parse(`${GIT_GRAPH_SCHEME}:${filePath}?ref=${hash}&ts=${Date.now()}`);

        // Set content for the content provider
        contentProvider.setContent(parentUri.toString(), parentContent);
        contentProvider.setContent(currentUri.toString(), currentContent);

        // Build diff title
        let title: string;
        if (status === 'added') {
          title = `${fileName} (added in ${shortHash})`;
        } else if (status === 'deleted') {
          title = `${fileName} (deleted in ${shortHash})`;
        } else {
          title = `${fileName} (${parentHash?.substring(0, 7) ?? '∅'} → ${shortHash})`;
        }

        // Open VS Code diff editor
        await vscode.commands.executeCommand('vscode.diff', parentUri, currentUri, title);
        return { success: true };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // Keep ping for testing
  router.register('ping', async () => {
    return { pong: true, timestamp: Date.now() };
  });

  webviewProvider = new GitGraphWebviewProvider(context.extensionUri, router);

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    webviewProvider.openPanel();
  });

  context.subscriptions.push(openCommand);

  // File watcher: auto-refresh graph when git refs change
  if (workspaceFolders && workspaceFolders.length > 0) {
    const rootPath = workspaceFolders[0].uri.fsPath;

    // Watch .git directory for changes (commits, branch switches, etc.)
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootPath, '.git/{HEAD,refs/**,index}')
    );

    const debounceRefresh = (() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          router.sendEvent('git.refsChanged');
          router.sendEvent('graph.invalidated');
        }, 500);
      };
    })();

    gitWatcher.onDidChange(debounceRefresh);
    gitWatcher.onDidCreate(debounceRefresh);
    gitWatcher.onDidDelete(debounceRefresh);

    context.subscriptions.push(gitWatcher);
  }
}

export function deactivate(): void {
  // cleanup
}

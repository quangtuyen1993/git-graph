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

  // Keep ping for testing
  router.register('ping', async () => {
    return { pong: true, timestamp: Date.now() };
  });

  webviewProvider = new GitGraphWebviewProvider(context.extensionUri, router);

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    webviewProvider.openPanel();
  });

  context.subscriptions.push(openCommand);
}

export function deactivate(): void {
  // cleanup
}

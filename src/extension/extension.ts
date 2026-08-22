import * as vscode from 'vscode';
import { GitGraphWebviewProvider } from './providers/webview-provider';
import { MessageRouter } from './controllers/message-router';

let webviewProvider: GitGraphWebviewProvider;

export function activate(context: vscode.ExtensionContext): void {
  const router = new MessageRouter();

  // Register a placeholder handler for testing
  router.register('ping', async (_method, _params) => {
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

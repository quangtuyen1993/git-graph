import * as vscode from 'vscode';
import { GitGraphWebviewProvider } from './providers/webview-provider';

let webviewProvider: GitGraphWebviewProvider;

export function activate(context: vscode.ExtensionContext): void {
  webviewProvider = new GitGraphWebviewProvider(context.extensionUri);

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    webviewProvider.openPanel();
  });

  context.subscriptions.push(openCommand);
}

export function deactivate(): void {
  // cleanup
}

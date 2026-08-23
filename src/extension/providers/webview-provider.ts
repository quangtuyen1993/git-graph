import * as vscode from 'vscode';
import { MessageRouter } from '../controllers/message-router';

export class GitGraphWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;
  private router: MessageRouter;

  constructor(
    private readonly extensionUri: vscode.Uri,
    router: MessageRouter
  ) {
    this.router = router;
  }

  public openPanel(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal();
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gitGraphPro',
      'Git Graph Pro',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.extensionUri, 'resources')
        ],
        retainContextWhenHidden: true
      }
    );

    // Set editor tab icon
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg'),
    };

    this.panel.webview.html = this.getHtmlContent(this.panel.webview);
    this.router.setPanel(this.panel);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    return this.panel;
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', 'main.css')
    );

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      script-src 'nonce-${nonce}';
      style-src ${webview.cspSource} 'unsafe-inline';
      img-src ${webview.cspSource} data: https://www.gravatar.com;
      font-src ${webview.cspSource};
    ">
    <link rel="stylesheet" href="${styleUri}">
    <title>Git Graph Pro</title>
</head>
<body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

import * as vscode from 'vscode';

export type CreatePanelSession = (panel: vscode.WebviewPanel) => void;

export class GitGraphWebviewProvider {
  private rootPanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly createPanelSession: CreatePanelSession,
  ) {}

  public openPanel(): vscode.WebviewPanel {
    if (this.rootPanel) {
      this.rootPanel.reveal();
      return this.rootPanel;
    }

    const panel = this.createPanel('Git Graph Pro');
    this.rootPanel = panel;
    this.createPanelSession(panel);

    panel.onDidDispose(() => {
      if (this.rootPanel === panel) this.rootPanel = undefined;
    });

    return panel;
  }

  private createPanel(title: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'gitGraphPro',
      title,
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

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.svg'),
    };

    panel.webview.html = this.getHtmlContent(panel.webview);
    return panel;
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

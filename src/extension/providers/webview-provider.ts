import * as fs from 'fs';
import * as vscode from 'vscode';
import type { WebviewHost } from '../types/webview-host.types';

export type CreateSession = (host: WebviewHost) => () => void;

export interface WebviewAppSpec {
  asset: 'main' | 'review';
  title: string;
}

export class GitGraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitGraphPro.graph';

  private disposeSession: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly createSession: CreateSession,
    private readonly spec: WebviewAppSpec = { asset: 'main', title: 'Git Graph Pro' },
  ) {}

  /**
   * Called again every time the user hides and re-shows the view, so the
   * previous session must go first: otherwise its file watcher survives and
   * every hide/show doubles the refresh traffic.
   */
  public resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeSession?.();
    this.disposeSession = undefined;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    view.webview.html = this.getHtmlContent(view.webview);

    const dispose = this.createSession(view);
    this.disposeSession = dispose;

    view.onDidDispose(() => {
      if (this.disposeSession === dispose) this.disposeSession = undefined;
      dispose();
    });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', `${this.spec.asset}.js`)
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', `${this.spec.asset}.css`)
    );

    const globalStyleFsUri = vscode.Uri.joinPath(
      this.extensionUri, 'dist', 'webview', 'assets', 'global.css'
    );
    const globalStyleLink = fs.existsSync(globalStyleFsUri.fsPath)
      ? `<link rel="stylesheet" href="${webview.asWebviewUri(globalStyleFsUri)}">\n    `
      : '';

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
    ${globalStyleLink}<link rel="stylesheet" href="${styleUri}">
    <title>${this.spec.title}</title>
</head>
<body>
    <div id="app"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
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

import type * as vscode from 'vscode';

/**
 * The slice of a webview container this extension actually uses. Both
 * vscode.WebviewPanel and vscode.WebviewView satisfy it structurally, so the
 * session wiring does not care which one it is running inside.
 */
export interface WebviewHost {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
  /** A WebviewView exposes visibility; treat a host without it as always visible. */
  readonly visible?: boolean;
  readonly onDidChangeVisibility?: vscode.Event<void>;
}

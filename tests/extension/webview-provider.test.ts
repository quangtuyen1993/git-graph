import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: Array<{ toString(): string } | string>) => {
      const joined = parts.map(String).join('/');
      return {
        toString: () => joined,
        fsPath: joined,
      };
    },
  },
}));

import { GitGraphWebviewProvider } from '../../src/extension/providers/webview-provider';

interface FakeView {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: ReturnType<typeof vi.fn>;
  };
  onDidDispose: (callback: () => void) => { dispose(): void };
  disposeView: () => void;
}

function createFakeView(): FakeView {
  const disposalCallbacks: Array<() => void> = [];
  return {
    webview: {
      html: '',
      options: undefined,
      cspSource: 'test-csp',
      asWebviewUri: vi.fn((uri: { toString(): string }) => uri),
    },
    onDidDispose(callback: () => void) {
      disposalCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    disposeView() {
      for (const callback of disposalCallbacks) callback();
    },
  };
}

describe('GitGraphWebviewProvider', () => {
  let createSession: ReturnType<typeof vi.fn>;
  let disposers: Array<ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    disposers = [];
    createSession = vi.fn(() => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    });
  });

  it('scripts the view and hands it a session', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);
    const view = createFakeView();

    provider.resolveWebviewView(view as never);

    expect(view.webview.options).toMatchObject({ enableScripts: true });
    expect(view.webview.html).toContain('<div id="app">');
    expect(view.webview.html).toContain('type="module"');
    expect(createSession).toHaveBeenCalledWith(view);
  });

  it('disposes the previous session when the view is resolved again', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);

    provider.resolveWebviewView(createFakeView() as never);
    provider.resolveWebviewView(createFakeView() as never);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(disposers[1]).not.toHaveBeenCalled();
  });

  it('disposes the session when the view itself goes away', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);
    const view = createFakeView();

    provider.resolveWebviewView(view as never);
    view.disposeView();

    expect(disposers[0]).toHaveBeenCalledTimes(1);
  });

  it('renders the review asset when constructed for the review app', () => {
    const provider = new GitGraphWebviewProvider(
      { toString: () => '/extension' } as never,
      createSession,
      { asset: 'review', title: 'Code Review' },
    );
    const view = createFakeView();
    provider.resolveWebviewView(view as never);

    expect(view.webview.html).toContain('assets/review.js');
    expect(view.webview.html).toContain('assets/review.css');
    expect(view.webview.html).toContain('<title>Code Review</title>');
    expect(view.webview.html).not.toContain('assets/main.js');
    expect(view.webview.html).toContain('type="module"');
  });

  it('links the shared global stylesheet when it exists on disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wvp-'));
    fs.mkdirSync(path.join(tempDir, 'dist', 'webview', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'dist', 'webview', 'assets', 'global.css'), '/* shared */');

    const provider = new GitGraphWebviewProvider({ toString: () => tempDir } as never, createSession);
    const view = createFakeView();

    provider.resolveWebviewView(view as never);

    expect(view.webview.html).toContain('assets/global.css');
  });

  it('omits the shared global stylesheet link when it does not exist on disk', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);
    const view = createFakeView();

    provider.resolveWebviewView(view as never);

    expect(view.webview.html).not.toContain('assets/global.css');
  });
});

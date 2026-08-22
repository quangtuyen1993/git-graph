# Phase 1: Project Scaffold & Build Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the VS Code extension project with dual build pipeline (esbuild for host, Vite+Svelte for webview), producing a loadable extension that opens an editor tab with a basic Svelte webview.

**Architecture:** TypeScript extension host built with esbuild, Svelte 4 webview built with Vite. Extension registers a command that opens a WebviewPanel as an editor tab. Webview renders a minimal Svelte app showing placeholder UI. Communication scaffold (MessageBridge) wired but no real data yet.

**Tech Stack:** TypeScript 5.4+, Svelte 4, Vite 5, esbuild, @types/vscode 1.85+, dagre (installed but not used yet)

## Global Constraints

- Node.js >= 18, VS Code engine >= 1.85.0
- Extension ID: `git-graph-pro` (private, not published)
- All source in `src/extension/` (host) and `src/webview/` (webview)
- Build output: `dist/extension.js` (host), `dist/webview/` (webview assets)
- No runtime dependencies in extension host (dagre is dev + bundled)
- Webview must include CSP meta tag with nonce
- Use VS Code theme CSS variables for all colors

---

### Task 1: Initialize npm project and VS Code extension manifest

**Files:**
- Create: `package.json`
- Create: `.vscodeignore`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `package.json` with extension manifest fields (`contributes.commands`, `activationEvents`, `main`), scripts (`dev`, `build`, `package`)

- [ ] **Step 1: Create package.json with extension manifest**

```json
{
  "name": "git-graph-pro",
  "displayName": "Git Graph Pro",
  "description": "Interactive Git graph with full workflow and AI code review",
  "version": "0.1.0",
  "private": true,
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["SCM Providers"],
  "activationEvents": [],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "gitGraphPro.open",
        "title": "Git Graph Pro: Open"
      }
    ]
  },
  "scripts": {
    "dev": "concurrently \"npm run dev:host\" \"npm run dev:webview\"",
    "dev:host": "esbuild src/extension/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --sourcemap --watch",
    "dev:webview": "vite build --watch --mode development",
    "build": "npm run build:host && npm run build:webview",
    "build:host": "esbuild src/extension/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --minify",
    "build:webview": "vite build",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "esbuild": "^0.20.0",
    "svelte": "^4.2.0",
    "@sveltejs/vite-plugin-svelte": "^3.1.0",
    "vite": "^5.4.0",
    "concurrently": "^8.2.0",
    "dagre": "^0.8.5",
    "@types/dagre": "^0.7.52"
  }
}
```

- [ ] **Step 2: Create .vscodeignore**

```
.vscode/**
src/**
node_modules/**
docs/**
tsconfig.json
svelte.config.js
vite.config.ts
esbuild.config.mjs
.gitignore
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
dist/
*.vsix
.vscode-test/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .vscodeignore .gitignore
git commit -m "feat: initialize project with extension manifest and dependencies"
```

---

### Task 2: TypeScript and build configuration

**Files:**
- Create: `tsconfig.json`
- Create: `svelte.config.js`
- Create: `vite.config.ts`

**Interfaces:**
- Consumes: `package.json` scripts from Task 1
- Produces: Working build configs that compile `src/extension/**/*.ts` → `dist/extension.js` and `src/webview/**/*.{svelte,ts}` → `dist/webview/`

- [ ] **Step 1: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/webview/**"]
}
```

- [ ] **Step 2: Create svelte.config.js**

```javascript
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess()
};
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist/webview',
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    },
    emptyOutDir: true
  }
});
```

- [ ] **Step 4: Verify build configs parse without error**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 || true`
Expected: May warn about missing source files (OK — no `.ts` files yet), but no config parse errors.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json svelte.config.js vite.config.ts
git commit -m "feat: add TypeScript, Svelte, and Vite build configs"
```

---

### Task 3: Extension host entry point and WebviewProvider

**Files:**
- Create: `src/extension/extension.ts`
- Create: `src/extension/providers/webview-provider.ts`
- Create: `src/extension/types/messages.types.ts`

**Interfaces:**
- Consumes: VS Code API (`vscode.commands`, `vscode.window.createWebviewPanel`)
- Produces:
  - `activate(context: vscode.ExtensionContext): void` — extension entry
  - `GitGraphWebviewProvider` class with `openPanel(): vscode.WebviewPanel`
  - `Request`, `Response`, `Event` message type interfaces

- [ ] **Step 1: Create message types**

Create `src/extension/types/messages.types.ts`:

```typescript
export interface Request {
  id: string;
  type: 'request';
  method: string;
  params?: unknown;
}

export interface Response {
  id: string;
  type: 'response';
  result?: unknown;
  error?: { code: number; message: string };
}

export interface Event {
  type: 'event';
  event: string;
  data?: unknown;
}

export type Message = Request | Response | Event;
```

- [ ] **Step 2: Create WebviewProvider**

Create `src/extension/providers/webview-provider.ts`:

```typescript
import * as vscode from 'vscode';

export class GitGraphWebviewProvider {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

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
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
        ],
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.getHtmlContent(this.panel.webview);

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
      img-src ${webview.cspSource} data:;
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
```

- [ ] **Step 3: Create extension entry point**

Create `src/extension/extension.ts`:

```typescript
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
```

- [ ] **Step 4: Verify host builds**

Run: `npx esbuild src/extension/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --sourcemap`
Expected: `dist/extension.js` created, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension/
git commit -m "feat: add extension entry point, WebviewProvider, and message types"
```

---

### Task 4: Svelte webview app with MessageBridge

**Files:**
- Create: `src/webview/index.html`
- Create: `src/webview/main.ts`
- Create: `src/webview/App.svelte`
- Create: `src/webview/lib/message-bridge.ts`
- Create: `src/webview/styles/global.css`

**Interfaces:**
- Consumes: VS Code `acquireVsCodeApi()` in webview context
- Produces:
  - `MessageBridge` class: `send(method: string, params?: unknown): Promise<unknown>`, `on(event: string, handler: (data: unknown) => void): void`
  - Mounted Svelte `App` component in `#app` div

- [ ] **Step 1: Create webview index.html (Vite entry)**

Create `src/webview/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Git Graph Pro</title>
</head>
<body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
</body>
</html>
```

Note: This HTML is used by Vite for development/build. The actual HTML served in VS Code webview comes from `webview-provider.ts` which references the built assets.

- [ ] **Step 2: Create MessageBridge**

Create `src/webview/lib/message-bridge.ts`:

```typescript
import type { Request, Response, Event } from '../../extension/types/messages.types';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type EventHandler = (data: unknown) => void;

export class MessageBridge {
  private vscode: VsCodeApi;
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private requestId = 0;

  constructor() {
    this.vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      const message = event.data as Response | Event;
      this.handleMessage(message);
    });
  }

  public send(method: string, params?: unknown): Promise<unknown> {
    const id = `req-${++this.requestId}`;
    const request: Request = { id, type: 'request', method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.vscode.postMessage(request);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  public on(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  private handleMessage(message: Response | Event): void {
    if (message.type === 'response') {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.type === 'event') {
      const handlers = this.eventHandlers.get(message.event);
      if (handlers) {
        handlers.forEach((handler) => handler(message.data));
      }
    }
  }
}

// Singleton instance
export const bridge = new MessageBridge();
```

- [ ] **Step 3: Create global styles with VS Code theme variables**

Create `src/webview/styles/global.css`:

```css
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --accent: var(--vscode-focusBorder);
  --border: var(--vscode-panel-border);
  --hover-bg: var(--vscode-list-hoverBackground);
  --selection-bg: var(--vscode-list-activeSelectionBackground);
  --selection-fg: var(--vscode-list-activeSelectionForeground);
  --error: var(--vscode-errorForeground);
  --warning: var(--vscode-editorWarning-foreground);
  --info: var(--vscode-editorInfo-foreground);
  --success: var(--vscode-gitDecoration-addedResourceForeground);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background-color: var(--bg);
  color: var(--fg);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  line-height: 1.4;
  overflow: hidden;
}

#app {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 4: Create App.svelte placeholder**

Create `src/webview/App.svelte`:

```svelte
<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount } from 'svelte';

  let status = 'Loading...';

  onMount(() => {
    status = 'Git Graph Pro — Ready';
    // Future: bridge.send('git.status') to load initial data
  });
</script>

<div class="container">
  <header class="toolbar">
    <h1>{status}</h1>
  </header>
  <main class="graph-area">
    <p class="placeholder">Graph will render here</p>
  </main>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
  }

  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
  }

  .graph-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .placeholder {
    opacity: 0.5;
    font-size: 16px;
  }
</style>
```

- [ ] **Step 5: Create main.ts entry point**

Create `src/webview/main.ts`:

```typescript
import App from './App.svelte';
import './styles/global.css';

const app = new App({
  target: document.getElementById('app')!
});

export default app;
```

- [ ] **Step 6: Build webview and verify output**

Run: `npx vite build`
Expected: `dist/webview/` created with `assets/main.js` and `assets/main.css` (names may vary).

- [ ] **Step 7: Commit**

```bash
git add src/webview/
git commit -m "feat: add Svelte webview app with MessageBridge and theme integration"
```

---

### Task 5: Launch configuration and end-to-end verification

**Files:**
- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`
- Modify: `src/extension/providers/webview-provider.ts` (fix asset paths if needed)

**Interfaces:**
- Consumes: Everything from Tasks 1-4
- Produces: F5-launchable extension that opens a webview tab via command palette

- [ ] **Step 1: Create .vscode/launch.json**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}"
      ],
      "outFiles": [
        "${workspaceFolder}/dist/**/*.js"
      ],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

- [ ] **Step 2: Create .vscode/tasks.json**

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build",
      "group": {
        "kind": "build",
        "isDefault": true
      },
      "problemMatcher": []
    }
  ]
}
```

- [ ] **Step 3: Update webview-provider to dynamically find built assets**

The Vite build may produce hashed filenames. Update `webview-provider.ts` to read the `dist/webview/` directory or use fixed names (we configured fixed names in `vite.config.ts`'s `rollupOptions.output`).

Verify that `vite.config.ts` output config uses `entryFileNames: 'assets/[name].js'` (which produces `assets/main.js`). The provider already references `assets/main.js` and `assets/main.css` — this should match.

- [ ] **Step 4: Full build verification**

Run: `npm run build`
Expected:
- `dist/extension.js` exists (host bundle)
- `dist/webview/assets/main.js` exists (webview bundle)
- `dist/webview/assets/main.css` exists (webview styles)
- No build errors

- [ ] **Step 5: Verify extension activates**

Run: (manual test)
1. Open this project in VS Code
2. Press F5 (launches Extension Development Host)
3. In new window, open Command Palette → "Git Graph Pro: Open"
4. Expected: Editor tab opens with "Git Graph Pro — Ready" header and "Graph will render here" placeholder

If webview shows blank/error, check:
- Developer Tools (Help → Toggle Developer Tools) for CSP errors
- Asset paths in webview HTML source

- [ ] **Step 6: Commit launch configs**

```bash
git add .vscode/
git commit -m "feat: add VS Code launch and task configs for extension debugging"
```

---

### Task 6: Message Router scaffold (host-side)

**Files:**
- Create: `src/extension/controllers/message-router.ts`
- Modify: `src/extension/providers/webview-provider.ts` (wire router to panel)

**Interfaces:**
- Consumes: `Request` type from `messages.types.ts`, `vscode.WebviewPanel`
- Produces:
  - `MessageRouter` class: `register(namespace: string, handler: MethodHandler): void`, `handleMessage(message: Request): Promise<void>`
  - `MethodHandler` type: `(method: string, params: unknown) => Promise<unknown>`
  - WebviewProvider wired to pass incoming messages to router

- [ ] **Step 1: Create MessageRouter**

Create `src/extension/controllers/message-router.ts`:

```typescript
import * as vscode from 'vscode';
import type { Request, Response, Event } from '../types/messages.types';

export type MethodHandler = (method: string, params: unknown) => Promise<unknown>;

export class MessageRouter {
  private handlers = new Map<string, MethodHandler>();
  private panel: vscode.WebviewPanel | undefined;

  public setPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;

    panel.webview.onDidReceiveMessage((message: Request) => {
      if (message.type === 'request') {
        this.handleMessage(message);
      }
    });
  }

  public register(namespace: string, handler: MethodHandler): void {
    this.handlers.set(namespace, handler);
  }

  public sendEvent(event: string, data?: unknown): void {
    if (this.panel) {
      const msg: Event = { type: 'event', event, data };
      this.panel.webview.postMessage(msg);
    }
  }

  private async handleMessage(request: Request): Promise<void> {
    const [namespace] = request.method.split('.');

    const handler = this.handlers.get(namespace);

    let response: Response;
    if (!handler) {
      response = {
        id: request.id,
        type: 'response',
        error: { code: -1, message: `No handler for namespace: ${namespace}` }
      };
    } else {
      try {
        const result = await handler(request.method, request.params);
        response = { id: request.id, type: 'response', result };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        response = {
          id: request.id,
          type: 'response',
          error: { code: -1, message: errorMessage }
        };
      }
    }

    this.panel?.webview.postMessage(response);
  }
}
```

- [ ] **Step 2: Wire MessageRouter into WebviewProvider**

Update `src/extension/providers/webview-provider.ts` — add router integration:

Add import at top:
```typescript
import { MessageRouter } from '../controllers/message-router';
```

Change constructor and openPanel:
```typescript
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
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
        ],
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = this.getHtmlContent(this.panel.webview);
    this.router.setPanel(this.panel);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    return this.panel;
  }

  // ... rest unchanged
}
```

- [ ] **Step 3: Update extension.ts to create router**

Update `src/extension/extension.ts`:

```typescript
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
```

- [ ] **Step 4: Update App.svelte to test message round-trip**

Update `src/webview/App.svelte` to send a ping on mount:

```svelte
<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount } from 'svelte';

  let status = 'Connecting...';

  onMount(async () => {
    try {
      const result = await bridge.send('ping.hello') as { pong: boolean; timestamp: number };
      if (result.pong) {
        status = 'Git Graph Pro — Connected ✓';
      }
    } catch (e) {
      status = `Git Graph Pro — Error: ${e}`;
    }
  });
</script>

<div class="container">
  <header class="toolbar">
    <h1>{status}</h1>
  </header>
  <main class="graph-area">
    <p class="placeholder">Graph will render here</p>
  </main>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
  }

  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
  }

  .graph-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .placeholder {
    opacity: 0.5;
    font-size: 16px;
  }
</style>
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Builds without errors. When launched with F5, webview shows "Git Graph Pro — Connected ✓" (confirming host↔webview message round-trip works).

- [ ] **Step 6: Commit**

```bash
git add src/extension/ src/webview/
git commit -m "feat: add MessageRouter with host↔webview communication scaffold"
```

---

## Verification Checklist (Phase 1 Complete When:)

- [ ] `npm run build` succeeds with no errors
- [ ] Extension loads in Extension Development Host
- [ ] Command "Git Graph Pro: Open" appears in command palette
- [ ] Webview opens as editor tab (not sidebar)
- [ ] Webview shows "Git Graph Pro — Connected ✓"
- [ ] Webview respects VS Code theme (dark/light)
- [ ] No CSP errors in developer console
- [ ] Host ↔ Webview message round-trip works (ping/pong)

# Submodule Repository Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SUBMODULES` sidebar section that opens each initialized submodule in its own fully functional, repository-isolated Git Graph editor tab.

**Architecture:** Add typed submodule discovery to `GitService`, render direct submodules through the existing metadata refresh and sidebar, then replace the singleton host state with one `RepositorySession` per webview panel. A panel registry keeps the root workspace panel separate and deduplicates fixed submodule panels by canonical repository path.

**Tech Stack:** TypeScript 5.4, Svelte 4, VS Code Webview API, Git CLI, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-08-23-submodule-tabs-design.md`

## Global Constraints

- The existing root tab remains scoped to workspace root repositories and retains its multi-root selector.
- Each submodule tab owns independent Git, graph, request, invalidation, and watcher state.
- Selecting the same canonical submodule path reveals its existing tab.
- Only direct submodules are shown; nested submodules are reached through their parent's tab.
- Opening an uninitialized, missing, stale, or invalid submodule reports an error and performs no Git mutation.
- Do not add dependencies or change the existing Git action surface.
- Preserve the repository's existing UI styling, RPC naming, latest-wins refresh behavior, and keyboard accessibility.

---

## File Structure

- `src/extension/types/git.types.ts`: owns the shared `SubmoduleEntry` and `SubmoduleState` contracts.
- `src/extension/utils/git-parser.ts`: parses `.gitmodules` config output and `git submodule status` output.
- `src/extension/services/git.service.ts`: discovers, validates, and resolves direct submodules and actual Git directories.
- `src/extension/controllers/git-method-handler.ts`: exposes `git.submoduleList` to webviews.
- `src/webview/components/sidebar/BranchSidebar.svelte`: renders and activates submodule rows.
- `src/webview/App.svelte`: refreshes submodule metadata and dispatches `ui.openSubmodule`.
- `src/extension/controllers/repository-session.ts`: owns one panel's mutable repository and graph services.
- `src/extension/providers/webview-provider.ts`: owns root/submodule panels and canonical-path deduplication.
- `src/extension/extension.ts`: creates session-scoped routers/handlers/watchers and validates `ui.openSubmodule`.
- Existing unit and integration test files are extended beside the behavior they verify.

---

### Task 1: Typed Submodule Discovery and Validation

**Files:**
- Modify: `src/extension/types/git.types.ts`
- Modify: `src/extension/utils/git-parser.ts`
- Modify: `src/extension/services/git.service.ts`
- Modify: `src/extension/controllers/git-method-handler.ts`
- Modify: `tests/extension/git-parser.test.ts`
- Modify: `tests/extension/git-method-handler.test.ts`
- Create: `tests/extension/git-submodule.integration.test.ts`
- Modify: `tests/coverage-closure.test.ts`

**Interfaces:**
- Consumes: `GitCLI.exec(args)`, `GitService.findRepo(startPath)`.
- Produces: `SubmoduleState`, `SubmoduleEntry`, `parseSubmoduleConfig(output)`, `parseSubmoduleStatus(output, repoPath, namesByPath)`, `GitService.submoduleList()`, `GitService.resolveSubmodule(relativePath)`, `GitService.gitDirectory()`, and RPC `git.submoduleList`.

- [ ] **Step 1: Write failing parser tests for every state and path/name handling**

Add tests using full 40-character object IDs and a path containing spaces:

```ts
import { parseSubmoduleConfig, parseSubmoduleStatus } from '../../src/extension/utils/git-parser';

it('parses configured names and all direct submodule states', () => {
  const names = parseSubmoduleConfig([
    'submodule.sdk.path packages/sdk',
    'submodule.ui-kit.path packages/ui kit',
  ].join('\n'));
  const output = [
    ` ${'a'.repeat(40)} packages/sdk (heads/main)`,
    `-${'b'.repeat(40)} packages/uninitialized`,
    `+${'c'.repeat(40)} packages/ui kit (v2.0.0-1-gabc)`,
    `U${'d'.repeat(40)} packages/conflicted`,
  ].join('\n');

  expect(parseSubmoduleStatus(output, '/repo', names)).toEqual([
    expect.objectContaining({ name: 'sdk', path: 'packages/sdk', absolutePath: '/repo/packages/sdk', head: 'a'.repeat(40), state: 'initialized' }),
    expect.objectContaining({ name: 'uninitialized', path: 'packages/uninitialized', head: null, state: 'uninitialized' }),
    expect.objectContaining({ name: 'ui-kit', path: 'packages/ui kit', head: 'c'.repeat(40), state: 'modified' }),
    expect.objectContaining({ name: 'conflicted', path: 'packages/conflicted', state: 'conflicted' }),
  ]);
});

it('returns an empty list for an empty status', () => {
  expect(parseSubmoduleStatus('', '/repo', new Map())).toEqual([]);
});
```

- [ ] **Step 2: Run the parser tests to verify the new exports are missing**

Run: `npm test -- tests/extension/git-parser.test.ts`

Expected: FAIL because `parseSubmoduleConfig` and `parseSubmoduleStatus` are not exported.

- [ ] **Step 3: Add the types and minimal parsers**

Add these contracts to `git.types.ts`:

```ts
export type SubmoduleState = 'initialized' | 'uninitialized' | 'modified' | 'conflicted';

export interface SubmoduleEntry {
  name: string;
  path: string;
  absolutePath: string;
  head: string | null;
  state: SubmoduleState;
}
```

In `git-parser.ts`, parse config lines at their first whitespace so paths may contain spaces. Parse status prefixes with this exact mapping: space → `initialized`, `-` → `uninitialized`, `+` → `modified`, `U` → `conflicted`. Strip only Git's final parenthesized describe suffix, use the configured section name when available, and otherwise use `path.basename(relativePath)`:

```ts
export function parseSubmoduleConfig(output: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of output.split('\n').filter(Boolean)) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const relativePath = line.slice(separator).trim();
    const match = key.match(/^submodule\.(.+)\.path$/);
    if (match && relativePath) names.set(relativePath, match[1]);
  }
  return names;
}
```

Implement `parseSubmoduleStatus` with an anchored status/hash/path expression, reject malformed non-empty lines with `Error('Unable to parse submodule status: ...')`, and set `head` to `null` only for `-` entries.

- [ ] **Step 4: Run the parser tests and confirm they pass**

Run: `npm test -- tests/extension/git-parser.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing service, integration, and RPC tests**

Extend the fake service in `git-method-handler.test.ts` with `submoduleList: async () => []`, so its RPC coverage scan accepts the App call added later. Add an explicit assertion:

```ts
await expect(handleGitMethod(fakeGitService as GitService, 'git.submoduleList', {}))
  .resolves.toEqual([]);
```

In `git-submodule.integration.test.ts`, create a parent and child `TempGitRepo`, commit once in each, and add the child with:

```ts
await parent.execGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', child.path, 'modules/child']);
const service = new GitService(parent.path);
const [entry] = await service.submoduleList();
expect(entry).toMatchObject({ name: 'modules/child', path: 'modules/child', state: 'initialized' });
await expect(service.resolveSubmodule('modules/child')).resolves.toMatchObject({ path: 'modules/child' });
await expect(service.resolveSubmodule('../outside')).rejects.toThrow('Submodule not found');
```

After `git submodule deinit -f modules/child`, assert `state === 'uninitialized'` and `resolveSubmodule('modules/child')` rejects with `Submodule is not initialized`.

- [ ] **Step 6: Run the new backend tests to verify the methods/RPC are missing**

Run: `npm test -- tests/extension/git-submodule.integration.test.ts tests/extension/git-method-handler.test.ts`

Expected: FAIL because `GitService.submoduleList`, `resolveSubmodule`, and `git.submoduleList` do not exist.

- [ ] **Step 7: Implement service discovery, fresh validation, and RPC routing**

Implement the service methods with these signatures:

```ts
public async submoduleList(): Promise<SubmoduleEntry[]>;
public async resolveSubmodule(relativePath: string): Promise<SubmoduleEntry>;
public async gitDirectory(): Promise<string>;
```

`submoduleList()` runs both commands, treating missing `.gitmodules` config as empty:

```ts
const [statusOutput, configOutput] = await Promise.all([
  this.cli.exec(['submodule', 'status']),
  this.cli.exec(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']).catch(() => ''),
]);
return parseSubmoduleStatus(statusOutput, this.getRepoPath(), parseSubmoduleConfig(configOutput));
```

`resolveSubmodule()` performs a fresh `submoduleList`, finds an exact relative path, rejects `uninitialized`, canonicalizes the configured directory with `fs/promises.realpath`, calls `GitService.findRepo`, canonicalizes the returned root, and requires both canonical paths to be equal. Return the entry with its canonical `absolutePath`. `gitDirectory()` returns trimmed output from `git rev-parse --absolute-git-dir`.

Add this handler branch:

```ts
case 'git.submoduleList':
  return gitService.submoduleList();
```

Extend `coverage-closure.test.ts` to expect `['submodule', 'status']`, the `.gitmodules` config command, and `['rev-parse', '--absolute-git-dir']` from the new service methods.

- [ ] **Step 8: Run all backend tests for this task**

Run: `npm test -- tests/extension/git-parser.test.ts tests/extension/git-submodule.integration.test.ts tests/extension/git-method-handler.test.ts tests/coverage-closure.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the backend slice**

```bash
git add src/extension/types/git.types.ts src/extension/utils/git-parser.ts src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts tests/extension/git-parser.test.ts tests/extension/git-method-handler.test.ts tests/extension/git-submodule.integration.test.ts tests/coverage-closure.test.ts
git commit -m "feat: discover and validate git submodules"
```

---

### Task 2: Submodules Sidebar and Open Request

**Files:**
- Modify: `src/webview/components/sidebar/BranchSidebar.svelte`
- Modify: `src/webview/App.svelte`
- Modify: `tests/webview/branch-sidebar.test.ts`
- Modify: `tests/webview/app-sidebar-actions.test.ts`
- Modify: `tests/webview/app-refresh-race.test.ts`
- Modify: `tests/webview/app-mutation-progress.test.ts`
- Modify: `tests/webview/app-published-history.test.ts`

**Interfaces:**
- Consumes: `SubmoduleEntry[]` from RPC `git.submoduleList`.
- Produces: sidebar event `submoduleOpen: { path: string }` and webview request `ui.openSubmodule: { path: string }`.

- [ ] **Step 1: Write failing sidebar accessibility and activation tests**

Add this fixture and assertions to `branch-sidebar.test.ts`:

```ts
const submodules = [
  { name: 'sdk', path: 'packages/sdk', absolutePath: '/repo/packages/sdk', head: 'f'.repeat(40), state: 'initialized' as const },
  { name: 'legacy', path: 'vendor/legacy', absolutePath: '/repo/vendor/legacy', head: null, state: 'uninitialized' as const },
];

it.each(['click', 'Enter', ' '])('requests a submodule tab on %s', async (activation) => {
  const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });
  const open = vi.fn();
  component.$on('submoduleOpen', open);
  const row = getByRole('button', { name: /submodule sdk.*packages\/sdk.*initialized/i });
  if (activation === 'click') await fireEvent.click(row);
  else await fireEvent.keyDown(row, { key: activation });
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { path: 'packages/sdk' } }));
});
```

Also assert the `SUBMODULES` header count is `2`, its toggle collapses the rows, and the uninitialized row's accessible label includes `uninitialized`.

- [ ] **Step 2: Run the component test to verify the prop/section are missing**

Run: `npm test -- tests/webview/branch-sidebar.test.ts`

Expected: FAIL because no submodule rows or event exist.

- [ ] **Step 3: Implement the minimal sidebar section**

Add a local `SubmoduleEntry` interface, exported `submodules` prop, `submodulesExpanded = true`, and one direct section after `WORKTREES`. Each row is a semantic button with title/path, state class, and keyboard activation. Dispatch only the relative path:

```svelte
<button
  type="button"
  class="branch-item submodule {submodule.state}"
  aria-label={`Submodule ${submodule.name}, ${submodule.path}, ${submodule.state}`}
  title={submodule.path}
  on:click={() => dispatch('submoduleOpen', { path: submodule.path })}
  on:keydown={(event) => handleSubmoduleKeydown(event, submodule)}
>
  <span class="branch-icon">{submodule.state === 'initialized' ? '◈' : '◇'}</span>
  <span class="branch-name">{submodule.name}</span>
</button>
```

Use existing VS Code theme variables; modified/conflicted use warning/error foregrounds and uninitialized uses `descriptionForeground`.

- [ ] **Step 4: Run the sidebar test and confirm it passes**

Run: `npm test -- tests/webview/branch-sidebar.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing App refresh/open tests**

In `app-sidebar-actions.test.ts`, return one submodule for `git.submoduleList`, click its accessible row, and assert:

```ts
await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openSubmodule', { path: 'packages/sdk' }));
```

In `app-refresh-race.test.ts`, add a deferred `submodules` value to `slowMetadata`, return it for refresh round 2, resolve it with the other deferred metadata, and assert stale submodule text never appears. This proves the new list participates in the existing metadata latest-wins gate.

Return `[]` for `git.submoduleList` in the mocks in `app-mutation-progress.test.ts` and `app-published-history.test.ts`.

- [ ] **Step 6: Run App tests to verify refresh and open wiring are missing**

Run: `npm test -- tests/webview/app-sidebar-actions.test.ts tests/webview/app-refresh-race.test.ts tests/webview/app-mutation-progress.test.ts tests/webview/app-published-history.test.ts`

Expected: FAIL on the missing RPC call/row.

- [ ] **Step 7: Integrate submodules into App metadata and sidebar events**

Add `submodules` state, include `bridge.send('git.submoduleList')` in the existing `Promise.all`, and assign it only after the current `graphRefreshGate` token is confirmed. Pass `{submodules}` into `BranchSidebar`.

Add the event handler without using the mutation gate:

```ts
async function handleSidebarSubmoduleOpen(event: CustomEvent<{ path: string }>) {
  try {
    await bridge.send('ui.openSubmodule', { path: event.detail.path });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    setTimeout(() => { error = ''; }, 5000);
  }
}
```

Bind it as `on:submoduleOpen={handleSidebarSubmoduleOpen}`. Do not add `ui.openSubmodule` to the mutation RPC set because opening is read-only.

- [ ] **Step 8: Run all webview tests for this task**

Run: `npm test -- tests/webview/branch-sidebar.test.ts tests/webview/app-sidebar-actions.test.ts tests/webview/app-refresh-race.test.ts tests/webview/app-mutation-progress.test.ts tests/webview/app-published-history.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the webview slice**

```bash
git add src/webview/components/sidebar/BranchSidebar.svelte src/webview/App.svelte tests/webview/branch-sidebar.test.ts tests/webview/app-sidebar-actions.test.ts tests/webview/app-refresh-race.test.ts tests/webview/app-mutation-progress.test.ts tests/webview/app-published-history.test.ts
git commit -m "feat: add submodules to the graph sidebar"
```

---

### Task 3: Isolated Repository Session State

**Files:**
- Create: `src/extension/controllers/repository-session.ts`
- Create: `tests/extension/repository-session.test.ts`

**Interfaces:**
- Consumes: `GitService`, `GraphService`, `GraphMethodHandler`, `handleGitMethod`.
- Produces: `RepositoryInfo`, `RepositorySessionOptions`, and `RepositorySession` methods `handleRepo`, `handleGit`, `handleGraph`, `invalidate`, `getGitService`, and `getCurrentRepository`.

- [ ] **Step 1: Write failing isolation and fixed-session tests**

Create two fake Git services whose `branches()` and graph-loading methods return values containing their repository path. Instantiate two sessions and assert calls remain isolated:

```ts
const root = new RepositorySession({
  initialRepository: { name: 'root', path: '/root' },
  repositories: [{ name: 'root', path: '/root' }, { name: 'other', path: '/other' }],
  allowRepositorySwitch: true,
  createGitService: fakeGitServiceFactory,
});
const child = new RepositorySession({
  initialRepository: { name: 'sdk', path: '/root/packages/sdk' },
  repositories: [{ name: 'sdk', path: '/root/packages/sdk' }],
  allowRepositorySwitch: false,
  createGitService: fakeGitServiceFactory,
});

expect(await root.handleGit('git.branches', {})).toEqual([{ name: '/root' }]);
expect(await child.handleGit('git.branches', {})).toEqual([{ name: '/root/packages/sdk' }]);
await root.handleRepo('repo.switch', { path: '/other' });
expect(root.getCurrentRepository()?.path).toBe('/other');
expect(child.getCurrentRepository()?.path).toBe('/root/packages/sdk');
await expect(child.handleRepo('repo.switch', { path: '/root' })).rejects.toThrow('fixed repository');
```

Also start graph builds in both sessions and assert each `graph.getWindow` contains only its service's commits and layout version; this catches accidental sharing of one `GraphService` or `GraphMethodHandler`.

- [ ] **Step 2: Run the session test to verify the module is missing**

Run: `npm test -- tests/extension/repository-session.test.ts`

Expected: FAIL because `repository-session.ts` does not exist.

- [ ] **Step 3: Implement one repository/graph context per session**

Use this public shape:

```ts
export interface RepositoryInfo { name: string; path: string }

export interface RepositorySessionOptions {
  initialRepository: RepositoryInfo | null;
  repositories: readonly RepositoryInfo[];
  allowRepositorySwitch: boolean;
  createGitService?: (path: string) => GitService;
}

export class RepositorySession {
  public getGitService(): GitService | null;
  public getCurrentRepository(): RepositoryInfo | null;
  public handleRepo(method: string, params: unknown): Promise<unknown>;
  public handleGit(method: string, params: unknown): Promise<unknown>;
  public handleGraph(method: string, params: unknown): Promise<unknown>;
  public invalidate(): void;
}
```

Construct a fresh `GraphService` and `GraphMethodHandler` in every instance. `repo.list` returns only `repositories` with an `active` flag. `repo.switch` first rejects when `allowRepositorySwitch` is false, then requires an exact configured repository path, invalidates the current graph handler, and replaces the service through `createGitService`. `handleGit` and `handleGraph` delegate to existing handlers and preserve their existing no-repository errors.

- [ ] **Step 4: Run the isolation tests and confirm they pass**

Run: `npm test -- tests/extension/repository-session.test.ts tests/extension/graph-method-handler.test.ts tests/extension/git-method-handler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the session abstraction**

```bash
git add src/extension/controllers/repository-session.ts tests/extension/repository-session.test.ts
git commit -m "refactor: isolate repository state per graph session"
```

---

### Task 4: Root and Canonical Submodule Panel Registry

**Files:**
- Modify: `src/extension/providers/webview-provider.ts`
- Create: `tests/extension/webview-provider.test.ts`

**Interfaces:**
- Consumes: a `CreatePanelSession(panel, request)` callback supplied by extension activation.
- Produces: `PanelRequest`, `GitGraphWebviewProvider.openPanel()`, and `GitGraphWebviewProvider.openRepositoryPanel(repoPath, repoName)`.

- [ ] **Step 1: Write failing provider tests for root reuse, canonical dedupe, and cleanup**

Mock `vscode.window.createWebviewPanel` with panels that record `reveal()` and disposal callbacks. Inject `canonicalizePath` so `/alias/sdk` and `/real/sdk` both resolve to `/real/sdk`:

```ts
const provider = new GitGraphWebviewProvider(extensionUri, createSession, async (repoPath) => (
  repoPath === '/alias/sdk' ? '/real/sdk' : repoPath
));

const rootA = provider.openPanel();
const rootB = provider.openPanel();
expect(rootB).toBe(rootA);
expect(rootA.reveal).toHaveBeenCalledTimes(1);

const childA = await provider.openRepositoryPanel('/alias/sdk', 'sdk');
const childB = await provider.openRepositoryPanel('/real/sdk', 'sdk');
expect(childB).toBe(childA);
expect(childA.reveal).toHaveBeenCalledTimes(1);
expect(createSession).toHaveBeenCalledWith(childA, { kind: 'repository', repoPath: '/real/sdk', repoName: 'sdk' });
```

Invoke the child's disposal callback, reopen `/real/sdk`, and assert a new panel/session is created. Assert disposing a child never removes or disposes the root panel.

- [ ] **Step 2: Run the provider test to verify the multi-panel API is missing**

Run: `npm test -- tests/extension/webview-provider.test.ts`

Expected: FAIL because the constructor callback and `openRepositoryPanel` do not exist.

- [ ] **Step 3: Implement the panel registry with fixed session requests**

Replace the singleton router field with these interfaces/state:

```ts
export type PanelRequest =
  | { kind: 'root' }
  | { kind: 'repository'; repoPath: string; repoName: string };

export type CreatePanelSession = (panel: vscode.WebviewPanel, request: PanelRequest) => void;

private rootPanel: vscode.WebviewPanel | undefined;
private readonly repositoryPanels = new Map<string, vscode.WebviewPanel>();
```

Keep `openPanel()` as the command-compatible root entry point. It reveals the existing root panel or creates `Git Graph Pro` and calls `createPanelSession(panel, { kind: 'root' })`.

Implement:

```ts
public async openRepositoryPanel(repoPath: string, repoName: string): Promise<vscode.WebviewPanel> {
  const canonicalPath = await this.canonicalizePath(repoPath);
  const existing = this.repositoryPanels.get(canonicalPath);
  if (existing) {
    existing.reveal();
    return existing;
  }
  const panel = this.createPanel(`Git Graph: ${repoName}`);
  this.repositoryPanels.set(canonicalPath, panel);
  this.createPanelSession(panel, { kind: 'repository', repoPath: canonicalPath, repoName });
  panel.onDidDispose(() => {
    if (this.repositoryPanels.get(canonicalPath) === panel) this.repositoryPanels.delete(canonicalPath);
  });
  return panel;
}
```

Factor the existing webview options/HTML assignment into `createPanel(title)` without changing CSP, scripts, styles, retention, or view column.

- [ ] **Step 4: Run provider tests and confirm they pass**

Run: `npm test -- tests/extension/webview-provider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the panel registry**

```bash
git add src/extension/providers/webview-provider.ts tests/extension/webview-provider.test.ts
git commit -m "feat: manage isolated git graph editor tabs"
```

---

### Task 5: Wire Session-Scoped Host Handlers and Watchers

**Files:**
- Modify: `src/extension/extension.ts`
- Modify: `src/extension/controllers/message-router.ts`
- Create: `tests/extension/message-router.test.ts`

**Interfaces:**
- Consumes: `PanelRequest`, `RepositorySession`, `GitService.resolveSubmodule`, `GitService.gitDirectory`, and `GitGraphWebviewProvider.openRepositoryPanel`.
- Produces: one `MessageRouter` and Git metadata watcher per panel plus host method `ui.openSubmodule`.

- [ ] **Step 1: Add a failing router lifetime test**

Create `message-router.test.ts` with a fake panel receive-message disposable. Register a handler, attach the panel, call `dispose()`, and assert the receive subscription is disposed. Send an event after disposal and assert `postMessage` is not called, proving the router clears registered handlers and drops the disposed panel reference.

- [ ] **Step 2: Run the host tests before refactoring**

Run: `npm test -- tests/extension/message-router.test.ts`

Expected: FAIL on missing per-panel setup/disposal behavior.

- [ ] **Step 3: Refactor activation into a panel-session factory**

In `activate`, discover workspace repositories once and create the shared virtual-document content provider and `AIReviewService` once. Construct `GitGraphWebviewProvider` with a callback:

```ts
webviewProvider = new GitGraphWebviewProvider(
  context.extensionUri,
  (panel, request) => createPanelSession(panel, request),
);
```

`createPanelSession` must create a new `MessageRouter` and `RepositorySession` for every panel:

```ts
const session = request.kind === 'root'
  ? new RepositorySession({ initialRepository: repos[0] ?? null, repositories: repos, allowRepositorySwitch: true })
  : new RepositorySession({
      initialRepository: { name: request.repoName, path: request.repoPath },
      repositories: [{ name: request.repoName, path: request.repoPath }],
      allowRepositorySwitch: false,
    });
```

Register `repo`, `git`, and `graph` namespaces against this session. Register the existing `ping`, UI (`inputBox`, `confirm`, `openDiff`, `openFolder`, `pickBranch`, `compareDiff`), and AI (`providers`, `compare`, `review`, `reviewDiff`) cases on each router, replacing every read of the old closure-level `gitService` with `session.getGitService()` and the existing no-repository guard.

Add this UI case before the default branch:

```ts
case 'ui.openSubmodule': {
  const gitService = session.getGitService();
  if (!gitService) throw new Error('No git repository found');
  const submodule = await gitService.resolveSubmodule(p.path as string);
  await webviewProvider.openRepositoryPanel(submodule.absolutePath, submodule.name);
  return { success: true };
}
```

This case deliberately accepts only a relative path and performs a fresh host-side resolution before opening.

- [ ] **Step 4: Make router and watcher lifetimes panel-scoped**

Store and dispose the return value from `panel.webview.onDidReceiveMessage` inside `MessageRouter`; add `dispose()` that disposes that subscription, clears registered handlers, and drops the panel reference. Pending outbound requests belong to the webview-side `MessageBridge`, not this host router, so do not add a second pending-request mechanism.

Within `createPanelSession`, bind a watcher to the actual Git directory:

```ts
let gitWatcher: vscode.FileSystemWatcher | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

async function bindGitWatcher() {
  gitWatcher?.dispose();
  const gitService = session.getGitService();
  if (!gitService) return;
  const gitDirectory = await gitService.gitDirectory();
  gitWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(gitDirectory, '{HEAD,refs/**,index}'),
  );
  const invalidate = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      session.invalidate();
      router.sendEvent('git.refsChanged');
      router.sendEvent('graph.invalidated');
    }, 500);
  };
  gitWatcher.onDidChange(invalidate);
  gitWatcher.onDidCreate(invalidate);
  gitWatcher.onDidDelete(invalidate);
}
```

Await `bindGitWatcher()` after a successful root `repo.switch`. On panel disposal, clear the timer, dispose the watcher, and call `router.dispose()`. Remove the old workspace-global watcher block.

- [ ] **Step 5: Run host and focused end-to-end unit tests**

Run: `npm test -- tests/extension/repository-session.test.ts tests/extension/webview-provider.test.ts tests/extension/git-method-handler.test.ts tests/webview/app-sidebar-actions.test.ts tests/webview/app-refresh-race.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the host integration**

```bash
git add src/extension/extension.ts src/extension/controllers/message-router.ts tests/extension/message-router.test.ts
git commit -m "feat: open submodules in isolated graph tabs"
```

---

### Task 6: Full Verification and Manual Extension Check

**Files:**
- Modify only files required to correct failures introduced by Tasks 1–5.

**Interfaces:**
- Consumes: all feature slices above.
- Produces: a release-ready submodule tab feature with no known regressions.

- [ ] **Step 1: Run formatting-independent diff checks and static analysis**

Run:

```bash
git diff --check
npm run typecheck
```

Expected: both commands exit 0 with no diagnostics.

- [ ] **Step 2: Run the complete automated verification pipeline**

Run: `npm run check`

Expected: unit/integration tests pass, coverage remains above configured thresholds, typecheck passes, and both extension/webview production builds succeed.

- [ ] **Step 3: Exercise the packaged extension against a real initialized submodule**

Run `npm run package`, install the generated VSIX in an Extension Development Host, and verify this exact sequence:

1. Open Git Graph on a repository with one initialized direct submodule.
2. Confirm `SUBMODULES` shows the expected count, name, path tooltip, and state.
3. Click the submodule and confirm a `Git Graph: <name>` editor appears.
4. Check out a branch in the submodule tab and confirm the root tab's active branch does not change.
5. Click the same root-sidebar row again and confirm the existing submodule tab is revealed rather than duplicated.
6. Open a nested submodule from the first submodule tab if available.
7. Deinitialize a test submodule outside the extension, refresh, click it, and confirm an error appears with no initialization command executed.
8. Close and reopen the submodule tab and confirm it starts with clean graph state.

- [ ] **Step 4: Inspect the final change set for scope and repository isolation**

Run:

```bash
git status --short
git diff --stat HEAD~5..HEAD
git log -6 --oneline
```

Expected: only the planned submodule/session files changed, the design and plan commits remain present, and no unrelated source edits are included.

- [ ] **Step 5: Commit only verification fixes if Step 1–4 required source changes**

If verification required corrections, stage only those named files and commit:

```bash
git commit -m "fix: harden submodule graph tab integration"
```

If verification required no corrections, leave the already verified task commits unchanged.

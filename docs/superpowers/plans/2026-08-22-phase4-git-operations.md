# Phase 4: Git Operations from UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add all Git write operations to the extension so users can checkout, create/delete branches, merge, rebase, cherry-pick, stash, push/pull, fetch, and reset directly from the graph UI via context menus.

**Architecture:** Extend GitService with write operations. Add context menu system in webview (right-click commit nodes and branch labels). Webview sends operation requests to host → host executes via GitService → auto-refresh triggers via file watcher. Confirmation dialogs for destructive operations.

**Tech Stack:** TypeScript, existing GitService/GitCLI, Svelte context menu components, VS Code QuickPick for user input

## Global Constraints

- Node.js >= 18, VS Code engine >= 1.85.0
- All source in `src/extension/` (host) and `src/webview/` (webview)
- Build output: `dist/extension.cjs` (host), `dist/webview/` (webview assets)
- All git commands use `spawn('git', [args...])` — never string interpolation
- Destructive operations (reset --hard, branch -D) require confirmation
- Operations that fail with conflict return structured error with conflict file list
- Auto-refresh after every write operation (file watcher handles this)

---

### Task 1: Extend GitService with write operations

**Files:**
- Modify: `src/extension/services/git.service.ts`

**Interfaces:**
- Consumes: `GitCLI.exec()`, types from `git.types.ts`
- Produces: New methods on `GitService`:
  - `checkout(ref: string): Promise<void>`
  - `createBranch(name: string, startPoint?: string): Promise<void>`
  - `deleteBranch(name: string, force?: boolean): Promise<void>`
  - `merge(branch: string, options?: { noFF?: boolean; message?: string }): Promise<void>`
  - `rebase(onto: string): Promise<void>`
  - `cherryPick(hash: string): Promise<void>`
  - `stash(action: 'push' | 'pop' | 'drop' | 'list', options?: { message?: string; index?: number }): Promise<unknown>`
  - `push(remote?: string, branch?: string, options?: { force?: boolean; setUpstream?: boolean }): Promise<void>`
  - `pull(remote?: string, branch?: string, options?: { rebase?: boolean }): Promise<void>`
  - `fetch(remote?: string): Promise<void>`
  - `reset(mode: 'soft' | 'mixed' | 'hard', ref: string): Promise<void>`
  - `createTag(name: string, hash?: string, message?: string): Promise<void>`
  - `deleteTag(name: string): Promise<void>`
  - `abortMerge(): Promise<void>`
  - `abortRebase(): Promise<void>`

- [ ] **Step 1: Add write operation methods to GitService**

Add these methods to `src/extension/services/git.service.ts` after existing methods:

```typescript
  public async checkout(ref: string): Promise<void> {
    await this.cli.exec(['checkout', ref]);
  }

  public async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ['branch', name];
    if (startPoint) args.push(startPoint);
    await this.cli.exec(args);
  }

  public async deleteBranch(name: string, force?: boolean): Promise<void> {
    const flag = force ? '-D' : '-d';
    await this.cli.exec(['branch', flag, name]);
  }

  public async merge(branch: string, options?: { noFF?: boolean; message?: string }): Promise<void> {
    const args = ['merge', branch];
    if (options?.noFF) args.push('--no-ff');
    if (options?.message) args.push('-m', options.message);
    await this.cli.exec(args);
  }

  public async rebase(onto: string): Promise<void> {
    await this.cli.exec(['rebase', onto]);
  }

  public async cherryPick(hash: string): Promise<void> {
    await this.cli.exec(['cherry-pick', hash]);
  }

  public async stash(action: 'push' | 'pop' | 'drop' | 'list', options?: { message?: string; index?: number }): Promise<unknown> {
    const args = ['stash', action];
    if (action === 'push' && options?.message) {
      args.push('-m', options.message);
    }
    if ((action === 'pop' || action === 'drop') && options?.index !== undefined) {
      args.push(`stash@{${options.index}}`);
    }
    const output = await this.cli.exec(args);
    if (action === 'list') {
      return output.trim().split('\n').filter(Boolean);
    }
    return undefined;
  }

  public async push(remote?: string, branch?: string, options?: { force?: boolean; setUpstream?: boolean }): Promise<void> {
    const args = ['push'];
    if (options?.force) args.push('--force-with-lease');
    if (options?.setUpstream) args.push('-u');
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.cli.exec(args, { timeout: 60000 });
  }

  public async pull(remote?: string, branch?: string, options?: { rebase?: boolean }): Promise<void> {
    const args = ['pull'];
    if (options?.rebase) args.push('--rebase');
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.cli.exec(args, { timeout: 60000 });
  }

  public async fetch(remote?: string): Promise<void> {
    const args = ['fetch'];
    if (remote) args.push(remote);
    else args.push('--all');
    await this.cli.exec(args, { timeout: 60000 });
  }

  public async reset(mode: 'soft' | 'mixed' | 'hard', ref: string): Promise<void> {
    await this.cli.exec(['reset', `--${mode}`, ref]);
  }

  public async createTag(name: string, hash?: string, message?: string): Promise<void> {
    const args = ['tag'];
    if (message) args.push('-a', name, '-m', message);
    else args.push(name);
    if (hash) args.push(hash);
    await this.cli.exec(args);
  }

  public async deleteTag(name: string): Promise<void> {
    await this.cli.exec(['tag', '-d', name]);
  }

  public async abortMerge(): Promise<void> {
    await this.cli.exec(['merge', '--abort']);
  }

  public async abortRebase(): Promise<void> {
    await this.cli.exec(['rebase', '--abort']);
  }
```

- [ ] **Step 2: Verify compilation**

Run: `npm run build:host`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/services/git.service.ts
git commit -m "feat: add git write operations (checkout, merge, rebase, stash, push/pull, reset, tags)"
```

---

### Task 2: Register write operations in MessageRouter

**Files:**
- Modify: `src/extension/extension.ts`

**Interfaces:**
- Consumes: GitService write methods, MessageRouter
- Produces: Extended `git.*` handler with all write operations routed

- [ ] **Step 1: Add write operations to git namespace handler**

In `src/extension/extension.ts`, extend the switch in the `git` namespace handler with new cases:

```typescript
      case 'git.checkout':
        await gitService.checkout(p.ref as string);
        return { success: true };
      case 'git.createBranch':
        await gitService.createBranch(p.name as string, p.startPoint as string | undefined);
        return { success: true };
      case 'git.deleteBranch':
        await gitService.deleteBranch(p.name as string, p.force as boolean | undefined);
        return { success: true };
      case 'git.merge':
        await gitService.merge(p.branch as string, p.options as { noFF?: boolean; message?: string } | undefined);
        return { success: true };
      case 'git.rebase':
        await gitService.rebase(p.onto as string);
        return { success: true };
      case 'git.cherryPick':
        await gitService.cherryPick(p.hash as string);
        return { success: true };
      case 'git.stash':
        return gitService.stash(
          p.action as 'push' | 'pop' | 'drop' | 'list',
          p.options as { message?: string; index?: number } | undefined
        );
      case 'git.push':
        await gitService.push(
          p.remote as string | undefined,
          p.branch as string | undefined,
          p.options as { force?: boolean; setUpstream?: boolean } | undefined
        );
        return { success: true };
      case 'git.pull':
        await gitService.pull(
          p.remote as string | undefined,
          p.branch as string | undefined,
          p.options as { rebase?: boolean } | undefined
        );
        return { success: true };
      case 'git.fetch':
        await gitService.fetch(p.remote as string | undefined);
        return { success: true };
      case 'git.reset':
        await gitService.reset(p.mode as 'soft' | 'mixed' | 'hard', p.ref as string);
        return { success: true };
      case 'git.createTag':
        await gitService.createTag(p.name as string, p.hash as string | undefined, p.message as string | undefined);
        return { success: true };
      case 'git.deleteTag':
        await gitService.deleteTag(p.name as string);
        return { success: true };
      case 'git.abortMerge':
        await gitService.abortMerge();
        return { success: true };
      case 'git.abortRebase':
        await gitService.abortRebase();
        return { success: true };
```

- [ ] **Step 2: Verify compilation**

Run: `npm run build:host`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/extension.ts
git commit -m "feat: register git write operations in MessageRouter"
```

---

### Task 3: Context menu component

**Files:**
- Create: `src/webview/components/actions/ContextMenu.svelte`

**Interfaces:**
- Consumes: mouse event position, menu items array
- Produces: `ContextMenu` component:
  - Props: `items: MenuItem[]`, `x: number`, `y: number`, `visible: boolean`
  - `MenuItem`: `{ label: string; action: string; disabled?: boolean; divider?: boolean; danger?: boolean }`
  - Event: `dispatch('action', { action: string })`
  - Auto-closes on click outside or Escape

- [ ] **Step 1: Create ContextMenu.svelte**

Create `src/webview/components/actions/ContextMenu.svelte`:

```svelte
<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  export interface MenuItem {
    label: string;
    action: string;
    disabled?: boolean;
    divider?: boolean;
    danger?: boolean;
  }

  export let items: MenuItem[] = [];
  export let x: number = 0;
  export let y: number = 0;
  export let visible: boolean = false;

  const dispatch = createEventDispatcher();
  let menuEl: HTMLDivElement;

  function handleItemClick(item: MenuItem) {
    if (item.disabled || item.divider) return;
    dispatch('action', { action: item.action });
    visible = false;
  }

  function handleClickOutside(event: MouseEvent) {
    if (menuEl && !menuEl.contains(event.target as Node)) {
      visible = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      visible = false;
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside, true);
    document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if visible}
  <div
    class="context-menu"
    bind:this={menuEl}
    style="left: {x}px; top: {y}px;"
    role="menu"
  >
    {#each items as item}
      {#if item.divider}
        <div class="divider"></div>
      {:else}
        <button
          class="menu-item"
          class:disabled={item.disabled}
          class:danger={item.danger}
          role="menuitem"
          disabled={item.disabled}
          on:click={() => handleItemClick(item)}
        >
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .context-menu {
    position: fixed;
    z-index: 1000;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    border-radius: 4px;
    padding: 4px 0;
    min-width: 160px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: none;
    color: var(--vscode-menu-foreground, #cccccc);
    font-size: 13px;
    font-family: var(--vscode-font-family);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .menu-item:hover:not(.disabled) {
    background: var(--vscode-menu-selectionBackground, #094771);
    color: var(--vscode-menu-selectionForeground, #ffffff);
  }

  .menu-item.disabled {
    opacity: 0.4;
    cursor: default;
  }

  .menu-item.danger {
    color: var(--vscode-errorForeground, #f44747);
  }

  .menu-item.danger:hover:not(.disabled) {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f44747);
  }

  .divider {
    height: 1px;
    margin: 4px 8px;
    background: var(--vscode-menu-separatorBackground, #454545);
  }
</style>
```

- [ ] **Step 2: Verify webview builds**

Run: `npm run build:webview`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/actions/ContextMenu.svelte
git commit -m "feat: add ContextMenu component for right-click actions"
```

---

### Task 4: Integrate context menu into graph (right-click commit + branch)

**Files:**
- Modify: `src/webview/components/graph/CommitNode.svelte` (dispatch contextmenu event)
- Modify: `src/webview/App.svelte` (add ContextMenu, handle actions, call git operations)

**Interfaces:**
- Consumes: `ContextMenu` component, `MessageBridge.send()` for git operations
- Produces:
  - Right-click on commit → menu: Checkout, Create branch, Create tag, Cherry-pick, Reset (soft/mixed/hard), Copy SHA
  - Right-click on branch in sidebar → menu: Checkout, Merge into current, Rebase onto, Delete, Push, Pull
  - Actions execute git operations via bridge → host handles → auto-refresh

- [ ] **Step 1: Add contextmenu event to CommitNode**

Modify `src/webview/components/graph/CommitNode.svelte` — add `on:contextmenu` to the `<g>` element:

```svelte
<g
  class="commit-node"
  on:click={() => dispatch('select', { hash })}
  on:contextmenu|preventDefault={(e) => dispatch('contextmenu', { hash, x: e.clientX, y: e.clientY })}
  on:keydown={(e) => { if (e.key === 'Enter') dispatch('select', { hash }); }}
  role="button"
  tabindex="0"
>
```

- [ ] **Step 2: Update GraphCanvas to forward contextmenu event**

In `src/webview/components/graph/GraphCanvas.svelte`, update the CommitNode event handlers:

Add handler function:
```typescript
  function handleNodeContextMenu(event: CustomEvent<{ hash: string; x: number; y: number }>) {
    dispatch('commitContextMenu', event.detail);
  }
```

Update CommitNode element:
```svelte
      <CommitNode
        ...
        on:select={handleNodeSelect}
        on:contextmenu={handleNodeContextMenu}
      />
```

- [ ] **Step 3: Add ContextMenu and operation handlers to App.svelte**

Add to the `<script>` section of App.svelte:

```typescript
  import ContextMenu from './components/actions/ContextMenu.svelte';
  import type { MenuItem } from './components/actions/ContextMenu.svelte';

  // Context menu state
  let contextMenuVisible = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let contextMenuItems: MenuItem[] = [];
  let contextMenuTarget: { type: 'commit' | 'branch'; value: string } | null = null;

  function handleCommitContextMenu(event: CustomEvent<{ hash: string; x: number; y: number }>) {
    contextMenuTarget = { type: 'commit', value: event.detail.hash };
    contextMenuX = event.detail.x;
    contextMenuY = event.detail.y;
    contextMenuItems = [
      { label: 'Checkout this commit', action: 'checkout' },
      { label: 'Create branch here...', action: 'createBranch' },
      { label: 'Create tag here...', action: 'createTag' },
      { label: '', action: '', divider: true },
      { label: 'Cherry-pick', action: 'cherryPick' },
      { label: 'Revert', action: 'revert' },
      { label: '', action: '', divider: true },
      { label: 'Reset soft to here', action: 'resetSoft' },
      { label: 'Reset mixed to here', action: 'resetMixed' },
      { label: 'Reset hard to here', action: 'resetHard', danger: true },
      { label: '', action: '', divider: true },
      { label: 'Copy SHA', action: 'copySha' },
    ];
    contextMenuVisible = true;
  }

  function handleBranchContextMenu(event: MouseEvent, branchName: string) {
    event.preventDefault();
    contextMenuTarget = { type: 'branch', value: branchName };
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;
    contextMenuItems = [
      { label: 'Checkout', action: 'checkout' },
      { label: 'Merge into current branch', action: 'merge' },
      { label: 'Rebase current onto this', action: 'rebase' },
      { label: '', action: '', divider: true },
      { label: 'Push', action: 'push' },
      { label: 'Pull', action: 'pull' },
      { label: 'Fetch', action: 'fetch' },
      { label: '', action: '', divider: true },
      { label: 'Delete branch', action: 'deleteBranch', danger: true },
    ];
    contextMenuVisible = true;
  }

  async function handleContextMenuAction(event: CustomEvent<{ action: string }>) {
    const action = event.detail.action;
    if (!contextMenuTarget) return;

    try {
      if (contextMenuTarget.type === 'commit') {
        const hash = contextMenuTarget.value;
        switch (action) {
          case 'checkout':
            await bridge.send('git.checkout', { ref: hash });
            break;
          case 'createBranch': {
            const name = prompt('Branch name:');
            if (name) await bridge.send('git.createBranch', { name, startPoint: hash });
            break;
          }
          case 'createTag': {
            const name = prompt('Tag name:');
            if (name) await bridge.send('git.createTag', { name, hash });
            break;
          }
          case 'cherryPick':
            await bridge.send('git.cherryPick', { hash });
            break;
          case 'resetSoft':
            await bridge.send('git.reset', { mode: 'soft', ref: hash });
            break;
          case 'resetMixed':
            await bridge.send('git.reset', { mode: 'mixed', ref: hash });
            break;
          case 'resetHard':
            if (confirm('Reset HARD will discard all uncommitted changes. Continue?')) {
              await bridge.send('git.reset', { mode: 'hard', ref: hash });
            }
            break;
          case 'copySha':
            navigator.clipboard.writeText(hash);
            break;
        }
      } else if (contextMenuTarget.type === 'branch') {
        const branchName = contextMenuTarget.value;
        switch (action) {
          case 'checkout':
            await bridge.send('git.checkout', { ref: branchName });
            break;
          case 'merge':
            await bridge.send('git.merge', { branch: branchName });
            break;
          case 'rebase':
            await bridge.send('git.rebase', { onto: branchName });
            break;
          case 'push':
            await bridge.send('git.push', { remote: 'origin', branch: branchName });
            break;
          case 'pull':
            await bridge.send('git.pull', { remote: 'origin', branch: branchName });
            break;
          case 'fetch':
            await bridge.send('git.fetch', { remote: 'origin' });
            break;
          case 'deleteBranch':
            if (confirm(`Delete branch "${branchName}"?`)) {
              await bridge.send('git.deleteBranch', { name: branchName });
            }
            break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }

    contextMenuTarget = null;
  }
```

Add to the template — context menu on branch list items:
```svelte
        {#each branches as branch}
          <li
            class:current={branch.current}
            on:contextmenu={(e) => handleBranchContextMenu(e, branch.name)}
          >
```

Add GraphCanvas event:
```svelte
            <GraphCanvas
              ...
              on:selectCommit={handleSelectCommit}
              on:commitContextMenu={handleCommitContextMenu}
            />
```

Add ContextMenu component at end of template:
```svelte
  <ContextMenu
    items={contextMenuItems}
    x={contextMenuX}
    y={contextMenuY}
    visible={contextMenuVisible}
    on:action={handleContextMenuAction}
  />
```

- [ ] **Step 4: Add toolbar actions (Fetch, Stash, Pull, Push)**

Add buttons to the toolbar in App.svelte:

```svelte
  <header class="toolbar">
    <h1>Git Graph Pro</h1>
    <span class="status">{status}</span>
    <div class="toolbar-actions">
      <button class="toolbar-btn" on:click={() => bridge.send('git.fetch')} title="Fetch All">⬇ Fetch</button>
      <button class="toolbar-btn" on:click={() => bridge.send('git.pull')} title="Pull">↓ Pull</button>
      <button class="toolbar-btn" on:click={() => bridge.send('git.push')} title="Push">↑ Push</button>
      <button class="toolbar-btn" on:click={() => bridge.send('git.stash', { action: 'push' })} title="Stash">📦 Stash</button>
    </div>
  </header>
```

Add toolbar-actions styles:
```css
  .toolbar-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }

  .toolbar-btn {
    padding: 4px 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #cccccc);
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
  }

  .toolbar-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }
```

- [ ] **Step 5: Verify full build**

Run: `npm run build`
Expected: Both host and webview build without errors.

- [ ] **Step 6: Commit**

```bash
git add src/webview/ src/extension/
git commit -m "feat: integrate context menu with git operations (commit + branch right-click)"
```

---

## Verification Checklist (Phase 4 Complete When:)

- [ ] `npm run build` succeeds
- [ ] Right-click commit node → context menu appears with correct options
- [ ] Right-click branch in sidebar → context menu appears
- [ ] Checkout commit/branch works (graph refreshes showing new HEAD)
- [ ] Create branch from commit works (new branch appears in sidebar)
- [ ] Create tag works (tag badge appears on commit)
- [ ] Cherry-pick works
- [ ] Merge branch works (merge commit appears)
- [ ] Delete branch works (removed from sidebar)
- [ ] Push/Pull/Fetch buttons in toolbar work
- [ ] Stash button works
- [ ] Reset (soft/mixed/hard) works with confirmation for hard
- [ ] Copy SHA copies to clipboard
- [ ] Errors display in error banner and auto-dismiss
- [ ] After any operation, graph auto-refreshes

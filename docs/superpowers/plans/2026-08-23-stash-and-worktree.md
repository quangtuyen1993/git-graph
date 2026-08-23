# Stash & Worktree Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stash list management and git worktree management sections to the left sidebar, with full CRUD operations via right-click context menus.

**Architecture:** Two new collapsible sections in BranchSidebar: STASHES (list/apply/pop/drop/create) and WORKTREES (list/add/remove/switch). Backend extends GitService with worktree operations and enriches stash listing. Sidebar dispatches events to App.svelte which handles context menu + bridge calls.

**Tech Stack:** Svelte 4, TypeScript, VS Code Extension API, git CLI

## Global Constraints

- Build must pass: `npm run build` (host esbuild + webview vite)
- No new dependencies — only git CLI operations
- Follow existing patterns: GitService methods → extension.ts router → bridge messages → App.svelte handlers
- Accessibility: all interactive items need role + aria attributes

---

### Task 1: Extend GitService with stash list details + worktree operations

**Files:**
- Modify: `src/extension/services/git.service.ts`
- Modify: `src/extension/types/git.types.ts`

**Interfaces:**
- Consumes: `GitCLI.exec()` for running git commands
- Produces:
  - `stashList(): Promise<StashEntry[]>` — returns detailed stash entries (index, message, date, branch)
  - `worktreeList(): Promise<WorktreeEntry[]>` — parsed `git worktree list --porcelain`
  - `worktreeAdd(path: string, branch?: string): Promise<void>`
  - `worktreeRemove(path: string, force?: boolean): Promise<void>`

- [ ] **Step 1: Add types**

Add to `src/extension/types/git.types.ts`:

```typescript
export interface StashEntry {
  index: number;
  message: string;
  date: string;       // ISO 8601
  branch: string;     // branch where stash was created
  hash: string;       // stash commit hash
}

export interface WorktreeEntry {
  path: string;
  head: string;       // commit hash HEAD points to
  branch: string | null; // null if detached HEAD
  bare: boolean;
  isMain: boolean;    // true for the main worktree
}
```

- [ ] **Step 2: Add stashList method**

In `git.service.ts`:

```typescript
public async stashList(): Promise<StashEntry[]> {
  const output = await this.cli.exec([
    'stash', 'list',
    '--format=%gd%x1f%gs%x1f%ai%x1f%H'
  ]);
  if (!output.trim()) return [];

  return output.trim().split('\n').filter(Boolean).map(line => {
    const [ref, message, date, hash] = line.split('\x1f');
    const indexMatch = ref?.match(/\{(\d+)\}/);
    const branchMatch = message?.match(/on (.+?):/);
    return {
      index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
      message: message?.replace(/^[^:]+:\s*/, '') ?? '',
      date: date ?? '',
      branch: branchMatch?.[1] ?? '',
      hash: hash ?? '',
    };
  });
}
```

- [ ] **Step 3: Add worktree methods**

```typescript
public async worktreeList(): Promise<WorktreeEntry[]> {
  const output = await this.cli.exec(['worktree', 'list', '--porcelain']);
  if (!output.trim()) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice(9), bare: false, isMain: entries.length === 0 };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.branch = null;
    }
  }
  if (current.path) entries.push(current as WorktreeEntry);

  return entries;
}

public async worktreeAdd(path: string, branch?: string, newBranch?: string): Promise<void> {
  const args = ['worktree', 'add'];
  if (newBranch) {
    args.push('-b', newBranch, path);
  } else if (branch) {
    args.push(path, branch);
  } else {
    args.push(path);
  }
  await this.cli.exec(args);
}

public async worktreeRemove(path: string, force?: boolean): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  await this.cli.exec(args);
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Both host and webview build without errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/types/git.types.ts
git commit -m "feat: add stash list details + worktree CRUD to GitService"
```

---

### Task 2: Register stash + worktree routes in MessageRouter

**Files:**
- Modify: `src/extension/extension.ts`

**Interfaces:**
- Consumes: `GitService.stashList()`, `GitService.worktreeList()`, `GitService.worktreeAdd()`, `GitService.worktreeRemove()`, `GitService.stash()`
- Produces: Message routes:
  - `git.stashList` → `StashEntry[]`
  - `git.stashApply` (index) → `{ success: true }`
  - `git.stashPop` (index) → `{ success: true }`
  - `git.stashDrop` (index) → `{ success: true }`
  - `git.stashPush` (message?) → `{ success: true }`
  - `git.worktreeList` → `WorktreeEntry[]`
  - `git.worktreeAdd` (path, branch?, newBranch?) → `{ success: true }`
  - `git.worktreeRemove` (path, force?) → `{ success: true }`

- [ ] **Step 1: Add cases to git handler switch**

In `extension.ts` git handler, add after existing stash case:

```typescript
case 'git.stashList':
  return gitService.stashList();
case 'git.stashApply':
  await gitService.stash('apply' as any); // use exec directly
  return { success: true };
case 'git.stashPop':
  await gitService.stash('pop', { index: p.index as number | undefined });
  return { success: true };
case 'git.stashDrop':
  await gitService.stash('drop', { index: p.index as number | undefined });
  return { success: true };
case 'git.stashPush':
  await gitService.stash('push', { message: p.message as string | undefined });
  return { success: true };
case 'git.worktreeList':
  return gitService.worktreeList();
case 'git.worktreeAdd':
  await gitService.worktreeAdd(
    p.path as string,
    p.branch as string | undefined,
    p.newBranch as string | undefined
  );
  return { success: true };
case 'git.worktreeRemove':
  await gitService.worktreeRemove(p.path as string, p.force as boolean | undefined);
  return { success: true };
```

- [ ] **Step 2: Fix stashApply (exec directly since 'apply' not in union type)**

Add to `git.service.ts`:

```typescript
public async stashApply(index?: number): Promise<void> {
  const args = ['stash', 'apply'];
  if (index !== undefined) args.push(`stash@{${index}}`);
  await this.cli.exec(args);
}
```

Update extension.ts:
```typescript
case 'git.stashApply':
  await gitService.stashApply(p.index as number | undefined);
  return { success: true };
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extension/extension.ts src/extension/services/git.service.ts
git commit -m "feat: register stash + worktree message routes"
```

---

### Task 3: Add STASHES section to BranchSidebar

**Files:**
- Modify: `src/webview/components/sidebar/BranchSidebar.svelte`
- Modify: `src/webview/App.svelte`

**Interfaces:**
- Consumes: `tags` prop pattern (already exists)
- Produces:
  - New prop: `stashes: StashEntry[]`
  - New event: `stashContextMenu` with `{ event: MouseEvent, stash: StashEntry }`

- [ ] **Step 1: Add stash type and prop to BranchSidebar**

```typescript
interface StashEntry {
  index: number;
  message: string;
  date: string;
  branch: string;
  hash: string;
}

export let stashes: StashEntry[] = [];
```

Add state: `let stashesExpanded = true;`

- [ ] **Step 2: Add STASHES section template (after TAGS)**

```svelte
<!-- STASHES section -->
<div class="section">
  <button
    class="section-header"
    on:click={() => { stashesExpanded = !stashesExpanded; }}
  >
    <span class="chevron" class:collapsed={!stashesExpanded}>▶</span>
    <span class="section-title">STASHES</span>
    <span class="section-count">{stashes.length}</span>
  </button>

  {#if stashesExpanded}
    <ul class="branch-list">
      {#each stashes as stash (stash.index)}
        <li
          class="branch-item stash"
          on:contextmenu={(e) => handleStashContextMenu(e, stash)}
          role="treeitem"
          aria-selected={false}
        >
          <span class="branch-icon">📦</span>
          <span class="branch-name" title={stash.message}>
            {stash.message || `stash@{${stash.index}}`}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
```

- [ ] **Step 3: Add stash context menu handler + styling**

Handler:
```typescript
function handleStashContextMenu(event: MouseEvent, stash: StashEntry) {
  event.preventDefault();
  event.stopPropagation();
  dispatch('stashContextMenu', { event, stash });
}
```

CSS:
```css
.branch-item.stash .branch-name {
  color: var(--vscode-descriptionForeground, #aaaaaa);
  font-style: italic;
}
```

- [ ] **Step 4: Wire in App.svelte**

Add stashes state and fetch in refreshGraph:
```typescript
let stashes: { index: number; message: string; date: string; branch: string; hash: string }[] = [];

// in refreshGraph():
stashes = await bridge.send('git.stashList') as typeof stashes;
```

Pass prop and handle event:
```svelte
<BranchSidebar
  {branches}
  {tags}
  {stashes}
  on:branchContextMenu={handleBranchContextMenu}
  on:tagContextMenu={handleTagContextMenu}
  on:stashContextMenu={handleStashContextMenu}
  on:checkout={handleBranchCheckout}
/>
```

Add handleStashContextMenu:
```typescript
async function handleStashContextMenu(event: CustomEvent<{ event: MouseEvent; stash: { index: number; message: string } }>) {
  const { event: mouseEvent, stash } = event.detail;
  contextMenuVisible = false;
  await tick();

  contextMenuTarget = { type: 'branch', value: String(stash.index) };
  contextMenuX = mouseEvent.clientX;
  contextMenuY = mouseEvent.clientY;
  contextMenuItems = [
    { label: 'Apply', action: 'stashApply' },
    { label: 'Pop (apply + delete)', action: 'stashPop' },
    { label: '', action: '', divider: true },
    { label: 'Drop', action: 'stashDrop', danger: true },
  ];
  contextMenuVisible = true;
}
```

Add cases to handleContextMenuAction (in branch section):
```typescript
case 'stashApply':
  await bridge.send('git.stashApply', { index: parseInt(branchName) });
  break;
case 'stashPop':
  await bridge.send('git.stashPop', { index: parseInt(branchName) });
  break;
case 'stashDrop': {
  const confirmed = await bridge.send('ui.confirm', { message: `Drop stash@{${branchName}}?` }) as boolean;
  if (confirmed) {
    await bridge.send('git.stashDrop', { index: parseInt(branchName) });
  }
  break;
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/sidebar/BranchSidebar.svelte src/webview/App.svelte
git commit -m "feat: add STASHES section to sidebar with apply/pop/drop"
```

---

### Task 4: Add WORKTREES section to BranchSidebar

**Files:**
- Modify: `src/webview/components/sidebar/BranchSidebar.svelte`
- Modify: `src/webview/App.svelte`

**Interfaces:**
- Consumes: `WorktreeEntry` type from Task 1
- Produces:
  - New prop: `worktrees: WorktreeEntry[]`
  - New event: `worktreeContextMenu` with `{ event: MouseEvent, worktree: WorktreeEntry }`

- [ ] **Step 1: Add worktree type and prop to BranchSidebar**

```typescript
interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  isMain: boolean;
}

export let worktrees: WorktreeEntry[] = [];
```

Add state: `let worktreesExpanded = true;`

- [ ] **Step 2: Add WORKTREES section template (after STASHES)**

```svelte
<!-- WORKTREES section -->
<div class="section">
  <button
    class="section-header"
    on:click={() => { worktreesExpanded = !worktreesExpanded; }}
  >
    <span class="chevron" class:collapsed={!worktreesExpanded}>▶</span>
    <span class="section-title">WORKTREES</span>
    <span class="section-count">{worktrees.length}</span>
  </button>

  {#if worktreesExpanded}
    <ul class="branch-list">
      {#each worktrees as wt (wt.path)}
        <li
          class="branch-item worktree"
          class:main={wt.isMain}
          on:contextmenu={(e) => handleWorktreeContextMenu(e, wt)}
          role="treeitem"
          aria-selected={wt.isMain}
        >
          <span class="branch-icon">{wt.isMain ? '🏠' : '📂'}</span>
          <span class="branch-name" title={wt.path}>
            {wt.branch ?? wt.head.substring(0, 7)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
```

- [ ] **Step 3: Add worktree context menu handler + styling**

Handler:
```typescript
function handleWorktreeContextMenu(event: MouseEvent, worktree: WorktreeEntry) {
  event.preventDefault();
  event.stopPropagation();
  dispatch('worktreeContextMenu', { event, worktree });
}
```

CSS:
```css
.branch-item.worktree .branch-name {
  color: var(--vscode-textLink-foreground, #4fc1ff);
}

.branch-item.worktree.main .branch-name {
  font-weight: 600;
}
```

- [ ] **Step 4: Wire in App.svelte**

Add worktrees state and fetch:
```typescript
let worktrees: { path: string; head: string; branch: string | null; bare: boolean; isMain: boolean }[] = [];

// in refreshGraph():
worktrees = await bridge.send('git.worktreeList') as typeof worktrees;
```

Pass prop and handle event:
```svelte
<BranchSidebar
  {branches}
  {tags}
  {stashes}
  {worktrees}
  on:branchContextMenu={handleBranchContextMenu}
  on:tagContextMenu={handleTagContextMenu}
  on:stashContextMenu={handleStashContextMenu}
  on:worktreeContextMenu={handleWorktreeContextMenu}
  on:checkout={handleBranchCheckout}
/>
```

Add handleWorktreeContextMenu:
```typescript
async function handleWorktreeContextMenu(event: CustomEvent<{ event: MouseEvent; worktree: { path: string; isMain: boolean; branch: string | null } }>) {
  const { event: mouseEvent, worktree } = event.detail;
  contextMenuVisible = false;
  await tick();

  contextMenuTarget = { type: 'branch', value: worktree.path };
  contextMenuX = mouseEvent.clientX;
  contextMenuY = mouseEvent.clientY;

  if (worktree.isMain) {
    contextMenuItems = [
      { label: 'Add new worktree...', action: 'worktreeAdd' },
    ];
  } else {
    contextMenuItems = [
      { label: 'Open in VS Code', action: 'worktreeOpen' },
      { label: '', action: '', divider: true },
      { label: 'Add new worktree...', action: 'worktreeAdd' },
      { label: 'Remove worktree', action: 'worktreeRemove', danger: true },
    ];
  }
  contextMenuVisible = true;
}
```

Add cases to handleContextMenuAction:
```typescript
case 'worktreeAdd': {
  const wtPath = await bridge.send('ui.inputBox', { prompt: 'Worktree path:', placeholder: '../my-worktree' }) as string | null;
  if (wtPath) {
    const wtBranch = await bridge.send('ui.inputBox', { prompt: 'Branch name (leave empty for detached):', placeholder: '' }) as string | null;
    await bridge.send('git.worktreeAdd', { path: wtPath, newBranch: wtBranch || undefined });
  }
  break;
}
case 'worktreeRemove': {
  const confirmed = await bridge.send('ui.confirm', { message: `Remove worktree at "${branchName}"?` }) as boolean;
  if (confirmed) {
    await bridge.send('git.worktreeRemove', { path: branchName });
  }
  break;
}
case 'worktreeOpen':
  await bridge.send('ui.openFolder', { path: branchName });
  break;
```

Also add `ui.openFolder` handler in extension.ts:
```typescript
case 'ui.openFolder': {
  const folderUri = vscode.Uri.file(p.path as string);
  await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: true });
  return { success: true };
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/sidebar/BranchSidebar.svelte src/webview/App.svelte src/extension/extension.ts
git commit -m "feat: add WORKTREES section to sidebar with add/remove/open"
```

---

## Verification Checklist (Feature Complete When:)

- [ ] `npm run build` succeeds
- [ ] Left sidebar shows: LOCAL, REMOTE, TAGS, STASHES, WORKTREES (all collapsible)
- [ ] Right-click stash → Apply / Pop / Drop works
- [ ] Creating a stash (`git stash push`) adds entry to STASHES list
- [ ] Right-click worktree → Open / Remove works
- [ ] "Add new worktree..." prompts for path and branch, creates it
- [ ] Main worktree shows 🏠, cannot be removed
- [ ] After any stash/worktree operation, sidebar refreshes

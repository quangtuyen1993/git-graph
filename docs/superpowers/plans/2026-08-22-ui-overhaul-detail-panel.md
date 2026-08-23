# UI Overhaul: Commit Detail Panel + Files Changed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a commit detail panel (right side) that shows full commit info + files changed list when a commit is selected. Match GitLens Commit Graph UX: click commit → right panel shows author, SHA, message, and file change list with add/delete stats.

**Architecture:** Split layout into left panel (commit graph list, already exists) and right panel (commit detail, new). Right panel fetches commit detail + file changes from host via `git.show`. Files displayed in a filterable list.

**Tech Stack:** Svelte, existing MessageBridge + GitService

## Global Constraints

- Build output: dist/extension.cjs (host), dist/webview/ (webview)
- Use VS Code theme CSS variables
- Right panel width: ~350px, resizable (future), collapsible when nothing selected
- File list entries clickable → open VS Code diff (future)

---

### Task 1: Remove lines-changed stats from commit row, keep only files count icon

The current row shows `+10 -5` which is noisy. Replace with just a small files-changed count (like GitLens shows as a badge next to avatar).

**Files:**
- Modify: `src/webview/App.svelte`

**Changes:**
- Remove `col-stats` column content (additions/deletions numbers)
- Replace with a small icon/badge showing just the file count: e.g., `📄 5`
- Position it next to or below the avatar column
- Keep stats data in GraphNode (needed for detail panel)

- [ ] **Step 1: Simplify the stats display in commit row**

In App.svelte, change the col-stats content from `3 +10 -5` to just the files count as a subtle badge:

```svelte
<div class="col-files">
  {#if node.filesChanged > 0}
    <span class="files-count" title="{node.filesChanged} files changed">{node.filesChanged}</span>
  {/if}
</div>
```

Style it as a small muted number (like GitLens shows).

- [ ] **Step 2: Update CSS**

Replace `.col-stats` styles with `.col-files`:
```css
.commit-row .col-files {
  width: 32px;
  min-width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  opacity: 0.6;
}

.files-count {
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #ffffff);
  padding: 1px 5px;
  border-radius: 8px;
  font-size: 10px;
}
```

- [ ] **Step 3: Update table header**

Change "col-stats" header to just a file icon or empty space.

- [ ] **Step 4: Verify build**

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/webview/App.svelte
git commit -m "refactor: simplify commit row stats to file count badge only"
```

---

### Task 2: Create CommitDetail component

**Files:**
- Create: `src/webview/components/detail/CommitDetail.svelte`

**Interfaces:**
- Props:
  - `commit: { hash, abbreviatedHash, subject, message, author, authorEmail, authorDate } | null`
  - `files: { path, oldPath, status, additions, deletions, binary }[] | null`
  - `loading: boolean`
- Events: `dispatch('openFile', { path, hash })`

**Layout (matching GitLens):**
```
┌─────────────────────────────────┐
│ [Avatar] Author Name            │
│          12 minutes ago         │
│                                 │
│ abc1234  ⊹ main                 │
│                                 │
│ Full commit message text        │
│                                 │
├─────────────────────────────────┤
│ FILES CHANGED (5)    🔍 Filter  │
├─────────────────────────────────┤
│ ● App.svelte  src/webview  +1-1 │
│ ● Foo.ts      src/ext      +12  │
│ ● Bar.ts      src/ext      -8   │
│ ...                             │
└─────────────────────────────────┘
```

- [ ] **Step 1: Create CommitDetail.svelte**

```svelte
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { getGravatarUrl } from '../../lib/gravatar';

  export let commit: {
    hash: string;
    abbreviatedHash: string;
    subject: string;
    message: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    refs: string[];
  } | null = null;

  export let files: {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }[] | null = null;

  export let loading: boolean = false;

  const dispatch = createEventDispatcher();

  let filterText = '';

  $: filteredFiles = files?.filter(f =>
    f.path.toLowerCase().includes(filterText.toLowerCase())
  ) ?? [];

  $: totalAdditions = files?.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  $: totalDeletions = files?.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} minutes ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hours ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay} days ago`;
    const diffMonth = Math.floor(diffDay / 30);
    if (diffMonth < 12) return `${diffMonth} months ago`;
    return `${Math.floor(diffMonth / 12)} years ago`;
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case 'added': return '🟢';
      case 'deleted': return '🔴';
      case 'renamed': return '🟡';
      case 'modified': default: return '🟠';
    }
  }

  function getStatusLetter(status: string): string {
    switch (status) {
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'modified': default: return 'M';
    }
  }

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  function getFileDir(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  }
</script>

{#if !commit}
  <div class="detail-empty">
    <p>Select a commit to view details</p>
  </div>
{:else}
  <div class="detail-panel">
    <!-- Author section -->
    <div class="detail-author">
      <img
        src={getGravatarUrl(commit.authorEmail)}
        alt={commit.author}
        class="detail-avatar"
        width="32"
        height="32"
      />
      <div class="author-info">
        <span class="author-name">{commit.author}</span>
        <span class="author-date">{formatRelativeTime(commit.authorDate)}</span>
      </div>
    </div>

    <!-- SHA + refs -->
    <div class="detail-refs">
      <code class="detail-sha">{commit.abbreviatedHash}</code>
      {#each commit.refs as ref}
        <span class="detail-ref-badge">{ref.replace(/^HEAD -> /, '')}</span>
      {/each}
    </div>

    <!-- Commit message -->
    <div class="detail-message">
      {commit.message || commit.subject}
    </div>

    <!-- Files changed -->
    <div class="detail-files-header">
      <span class="files-title">FILES CHANGED</span>
      <span class="files-count-badge">{files?.length ?? 0}</span>
      {#if totalAdditions > 0}<span class="total-add">+{totalAdditions}</span>{/if}
      {#if totalDeletions > 0}<span class="total-del">-{totalDeletions}</span>{/if}
    </div>

    <!-- Filter -->
    <div class="detail-filter">
      <input
        type="text"
        placeholder="Filter files..."
        bind:value={filterText}
        class="filter-input"
      />
    </div>

    <!-- File list -->
    {#if loading}
      <div class="files-loading">Loading...</div>
    {:else}
      <div class="file-list">
        {#each filteredFiles as file}
          <div
            class="file-entry"
            on:click={() => dispatch('openFile', { path: file.path, hash: commit.hash })}
            on:keydown={(e) => { if (e.key === 'Enter') dispatch('openFile', { path: file.path, hash: commit.hash }); }}
            role="button"
            tabindex="0"
          >
            <span class="file-status file-status-{file.status}">{getStatusLetter(file.status)}</span>
            <span class="file-name">{getFileName(file.path)}</span>
            <span class="file-dir">{getFileDir(file.path)}</span>
            <span class="file-stats">
              {#if file.additions > 0}<span class="file-add">+{file.additions}</span>{/if}
              {#if file.deletions > 0}<span class="file-del">-{file.deletions}</span>{/if}
            </span>
            <span class="file-status-letter">{getStatusLetter(file.status)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .detail-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.5;
    font-size: 13px;
  }

  .detail-panel {
    padding: 16px;
    overflow-y: auto;
    height: 100%;
  }

  .detail-author {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .detail-avatar {
    border-radius: 50%;
  }

  .author-info {
    display: flex;
    flex-direction: column;
  }

  .author-name {
    font-weight: 600;
    font-size: 14px;
  }

  .author-date {
    font-size: 12px;
    opacity: 0.7;
  }

  .detail-refs {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .detail-sha {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-textLink-foreground, #007acc);
  }

  .detail-ref-badge {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }

  .detail-message {
    font-size: 13px;
    line-height: 1.5;
    margin-bottom: 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .detail-files-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--vscode-panel-border, #333);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .files-title {
    opacity: 0.7;
  }

  .files-count-badge {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
  }

  .total-add {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
    font-size: 11px;
  }

  .total-del {
    color: var(--vscode-errorForeground, #f44747);
    font-size: 11px;
  }

  .detail-filter {
    margin-bottom: 8px;
  }

  .filter-input {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border, #333);
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #ccc);
    font-size: 12px;
    border-radius: 3px;
    outline: none;
  }

  .filter-input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .files-loading {
    opacity: 0.5;
    font-size: 12px;
    padding: 8px;
  }

  .file-list {
    display: flex;
    flex-direction: column;
  }

  .file-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
  }

  .file-entry:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
  }

  .file-status {
    width: 16px;
    text-align: center;
    font-size: 11px;
    font-weight: 600;
  }

  .file-status-added { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .file-status-deleted { color: var(--vscode-errorForeground, #f44747); }
  .file-status-modified { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .file-status-renamed { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }

  .file-name {
    font-weight: 500;
    white-space: nowrap;
  }

  .file-dir {
    opacity: 0.5;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .file-stats {
    display: flex;
    gap: 4px;
    margin-left: auto;
    font-size: 11px;
    white-space: nowrap;
  }

  .file-add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .file-del { color: var(--vscode-errorForeground, #f44747); }

  .file-status-letter {
    width: 16px;
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    opacity: 0.7;
  }
</style>
```

- [ ] **Step 2: Verify webview builds**

Run: `npm run build:webview`

- [ ] **Step 3: Commit**

```bash
git add src/webview/components/detail/CommitDetail.svelte
git commit -m "feat: add CommitDetail component with author info, message, and file list"
```

---

### Task 3: Integrate CommitDetail panel into App.svelte layout

**Files:**
- Modify: `src/webview/App.svelte`

**Changes:**
- Split main area into: left (commit graph list) | right (CommitDetail panel)
- When `selectedHash` changes → fetch commit detail via `bridge.send('git.show', { hash })`
- Pass data to CommitDetail component
- Right panel hidden when nothing selected, shows with animation

- [ ] **Step 1: Add split layout**

Wrap existing scroll-area and add detail panel on right:
```svelte
<main class="main-content">
  <section class="graph-panel">
    <!-- existing table-header + scroll-area -->
  </section>

  {#if selectedHash && selectedHash !== 'WORKING'}
    <aside class="detail-panel-container">
      <CommitDetail
        commit={selectedCommitDetail}
        files={selectedCommitFiles}
        loading={detailLoading}
      />
    </aside>
  {/if}
</main>
```

- [ ] **Step 2: Add data fetching for selected commit**

```typescript
let selectedCommitDetail: any = null;
let selectedCommitFiles: any[] | null = null;
let detailLoading = false;

async function loadCommitDetail(hash: string) {
  detailLoading = true;
  try {
    const result = await bridge.send('git.show', { hash }) as { commit: any; files: any[] };
    selectedCommitDetail = result.commit;
    selectedCommitFiles = result.files;
  } catch (e) {
    selectedCommitDetail = null;
    selectedCommitFiles = null;
  } finally {
    detailLoading = false;
  }
}

// Call loadCommitDetail when selectedHash changes
$: if (selectedHash && selectedHash !== 'WORKING') {
  loadCommitDetail(selectedHash);
} else {
  selectedCommitDetail = null;
  selectedCommitFiles = null;
}
```

- [ ] **Step 3: Add layout CSS**

```css
.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.graph-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.detail-panel-container {
  width: 350px;
  min-width: 300px;
  border-left: 1px solid var(--vscode-panel-border, #333);
  overflow: hidden;
}
```

- [ ] **Step 4: Remove old footer detail-bar**

Remove the `{#if selectedHash}...<footer class="detail-bar">...` section.

- [ ] **Step 5: Verify full build**

Run: `npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/webview/
git commit -m "feat: integrate CommitDetail panel with split layout (graph left, detail right)"
```

---

## Verification Checklist

- [ ] `npm run build` succeeds
- [ ] Click commit → right panel shows: avatar, author, date, SHA, refs, message
- [ ] Right panel shows FILES CHANGED with count + file list
- [ ] Each file shows: status icon, filename, directory path, +/- stats, status letter
- [ ] Filter input filters file list
- [ ] No commit selected → right panel hidden (graph takes full width)
- [ ] Files changed count badge visible on commit rows (left panel)
- [ ] Gravatar avatars load correctly

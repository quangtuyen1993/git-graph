# Branch Context Menu Enhancement & Commit Search

**Date:** 2026-08-25  
**Status:** Approved  

## Overview

Five features for the git-graph VS Code extension:
1. **Branch context menu** — add missing actions when right-clicking a branch in the sidebar
2. **Commit search** — search bar in the graph title bar to find commits by message or hash
3. **Loading spinner** — visual feedback during network operations (push, pull, fetch, review)
4. **Lifecycle error fix** — fix continuous error logging on startup due to race conditions
5. **Multi-branch filter** — allow selecting multiple branches in the graph filter

---

## Part 1: Branch Context Menu Enhancements

### Current State

The extension already has a context menu system (`ContextMenu.svelte`) with submenu support, and a git service layer (`GitService`) with all necessary git operations. The menu is built dynamically in `App.svelte`'s `handleBranchContextMenu`.

Existing actions: Checkout, Merge into current, Rebase current onto this, Push, Pull, Fetch, Rename, Delete, Compare with...

### New Actions to Add

| Action | Label Template | Git Operation |
|--------|---------------|---------------|
| New Branch from... | `New Branch from '<branch>'...` | `git.createBranch(name, startPoint)` |
| Checkout and Rebase | `Checkout and Rebase onto '<current>'` | `git.checkout(ref)` → `git.rebase(previousCurrent)` |
| Diff with Working Tree | `Show Diff with Working Tree` | Open diff view (branch vs working tree) |
| Rebase current onto | `Rebase '<current>' onto '<branch>'` | `git.rebase(selectedBranch)` |
| Pull Using Rebase | `Pull into '<current>' Using Rebase` | `git.pull(remote, branch, { rebase: true })` |
| Pull Using Merge | `Pull into '<current>' Using Merge` | `git.pull(remote, branch, {})` |

### Menu Structure (non-current local branch)

```
Checkout
New Branch from '<branch>'...
─────────────────────────────────────
Checkout and Rebase onto '<current>'
─────────────────────────────────────
Compare with '<current>'
Show Diff with Working Tree
─────────────────────────────────────
Rebase '<current>' onto '<branch>'
Merge '<branch>' into '<current>'
─────────────────────────────────────
Pull into '<current>' Using Rebase
Pull into '<current>' Using Merge
─────────────────────────────────────
Push ▶
Fetch
Rename
Delete
```

### Menu Structure (remote branch, e.g. `origin/bugfix/RMS2025-1027`)

```
Checkout
New Branch from '<branch>'...
─────────────────────────────────────
Checkout and Rebase onto '<current>'
─────────────────────────────────────
Compare with '<current>'
Show Diff with Working Tree
─────────────────────────────────────
Rebase '<current>' onto '<branch>'
Merge '<branch>' into '<current>'
─────────────────────────────────────
Pull into '<current>' Using Rebase
Pull into '<current>' Using Merge
─────────────────────────────────────
Delete Remote Branch
```

### Data Flow per Action

**New Branch from...:**
1. Click → `bridge.send('ui.inputBox', { prompt: "New branch name", placeholder: "feature/..." })`
2. User enters name → `bridge.send('git.createBranch', { name, startPoint: selectedBranch })`
3. Success → refresh branches + invalidate graph

**Checkout and Rebase onto current:**
1. Click → `bridge.send('ui.confirm', { message: "Checkout '<branch>' and rebase onto '<current>'?" })`
2. Confirmed → save `currentBranch` reference
3. `bridge.send('git.checkout', { ref: selectedBranch })`
4. Success → `bridge.send('git.rebase', { onto: savedCurrentBranch })`
5. Success → refresh all

**Show Diff with Working Tree:**
1. Click → `bridge.send('git.diff', { ref1: selectedBranch, ref2: 'WORKING_TREE' })`
2. Extension opens VS Code diff view or shows diff in review panel

**Rebase current onto selected:**
1. Click → confirm dialog
2. Confirmed → `bridge.send('git.rebase', { onto: selectedBranch })`
3. Success → refresh

**Pull into current Using Rebase:**
1. Click → `bridge.send('git.pull', { remote, branch, rebase: true })`
2. Success → refresh

**Pull into current Using Merge:**
1. Click → `bridge.send('git.pull', { remote, branch, rebase: false })`
2. Success → refresh

### Error Handling

- Rebase/merge conflicts → show notification with "Abort" action
- Branch not fully merged (delete) → already handled via `BranchNotFullyMergedError`
- Network errors (push/pull) → show error notification

---

## Part 2: Commit Search in Graph Title Bar

### UI Component: `CommitSearch.svelte`

Located in the title bar area of the graph view.

### States

| State | Visual |
|-------|--------|
| Collapsed | Search icon (🔍) button only |
| Expanded | Input field with placeholder "Search commit message or hash..." |
| Loading | Spinner inside input field |
| Results | Badge showing "N matches" + prev/next arrows (↑↓) |
| No results | "No commits found" text |

### Behavior

- Click search icon → expand input, auto-focus
- Type text → debounce 300ms → send search request
- Input looks like hash (`/^[0-9a-f]{7,40}$/i`) → prioritize `git rev-parse`
- Input is text → use `git log --grep="text" --max-count=50 --all`
- Results returned → highlight first match on graph, scroll to it
- Multiple results → show count badge + arrow buttons to navigate between matches
- Escape or X button → clear search, remove highlights, collapse
- Keyboard shortcut: `Ctrl+F` / `Cmd+F` to toggle search (when graph is focused)

### Extension-side: `git.searchCommits` Method

Add to `GitService`:

```typescript
async searchCommits(query: string): Promise<string[]> {
  // Try exact hash match first
  if (/^[0-9a-f]{7,40}$/i.test(query)) {
    try {
      const hash = await this.revParse(query);
      if (hash) return [hash];
    } catch { /* not a valid ref, fall through to grep */ }
  }
  // Search by commit message
  const result = await this.cli.exec([
    'log', '--grep=' + query, '-i',
    '--max-count=50', '--format=%H', '--all'
  ]);
  return result.stdout.split('\n').filter(Boolean);
}
```

Add to `git-method-handler.ts`:
```typescript
'git.searchCommits': (params) => git.searchCommits(params.query)
```

### Webview-side: Message Bridge Call

```typescript
const results = await bridge.send('git.searchCommits', { query });
// results: string[] of commit hashes
```

### Graph Integration

When search returns hashes:
1. Check if commit hash exists in currently loaded graph rows
2. If yes → scroll virtualized list to that row + apply highlight CSS class
3. If not loaded → determine the commit's position in full history, adjust the virtual scroll offset to load that region, then highlight
4. Navigation (↑↓) cycles through `results[]`, scrolling to each match

### Highlight Style

- Matched commit row gets a distinct background color (e.g., `var(--vscode-editor-findMatchHighlightBackground)`)
- Active match (currently focused) gets stronger highlight (e.g., `var(--vscode-editor-findMatchBackground)`)

---

## Files to Modify

### Context Menu (Part 1)
- `src/webview/App.svelte` — add menu items to `handleBranchContextMenu`, add action handlers
- No new git methods needed — all operations already exist in GitService

### Commit Search (Part 2)
- `src/webview/components/search/CommitSearch.svelte` — **NEW** component
- `src/webview/App.svelte` — integrate CommitSearch in title bar, handle search results + graph scrolling
- `src/extension/services/git.service.ts` — add `searchCommits()` method
- `src/extension/controllers/git-method-handler.ts` — register `git.searchCommits`
- `src/webview/styles/` — add search highlight styles

---

---

## Part 3: Loading Spinner for Network Operations

### Problem

When executing push, pull, fetch, or review operations, the UI appears frozen with no feedback.
User has no indication whether the operation is in progress or stuck.

### Solution: `LoadingSpinner.svelte` Component

A circular spinning indicator that appears during long-running operations.

### Where It Appears

| Operation | Spinner Location |
|-----------|-----------------|
| Push / Pull / Fetch | Next to the branch name in sidebar OR overlay on graph toolbar |
| Review (AI) | In the review panel header |
| Any network call | Global spinner in title bar area |

### Implementation

**Component: `src/webview/components/ui/LoadingSpinner.svelte`**

```svelte
<script>
  export let size: 'sm' | 'md' | 'lg' = 'md';
  export let label = 'Loading...';
</script>

<span class="spinner spinner-{size}" role="status" aria-label={label}>
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"
            stroke-dasharray="31.4 31.4" stroke-linecap="round" />
  </svg>
</span>
```

CSS animation: `@keyframes spin { to { transform: rotate(360deg); } }`

**State management in `App.svelte`:**

```typescript
let pendingOperations: Set<string> = new Set();

async function withLoading<T>(opName: string, fn: () => Promise<T>): Promise<T> {
  pendingOperations.add(opName);
  pendingOperations = pendingOperations; // trigger reactivity
  try {
    return await fn();
  } finally {
    pendingOperations.delete(opName);
    pendingOperations = pendingOperations;
  }
}

// Usage:
await withLoading('push', () => bridge.send('git.push', { remote, branch }));
```

**Visual behavior:**
- Spinner appears immediately when operation starts
- Disappears when operation completes (success or error)
- If multiple operations pending, spinner stays until all complete
- Spinner uses VS Code theme color (`--vscode-progressBar-background`)

---

## Part 4: Fix Lifecycle Errors on Startup

### Root Cause Analysis

When the extension first opens, errors are logged continuously due to two race conditions:

**Race 1: Unhandled promise in `graph.invalidated` event handler**

```typescript
// CURRENT (broken) — App.svelte
bridge.on('graph.invalidated', () => {
  refreshGraph(); // async function, promise not handled!
});
```

`refreshGraph()` is async and can throw (e.g., "Graph build superseded"). The event handler
doesn't await or catch it, causing unhandled promise rejections.

**Race 2: File watcher fires during initial load**

1. `onMount` → first `refreshGraph()` triggers `git log` → touches `.git/` files
2. File watcher (500ms debounce) detects changes → sends `graph.invalidated` event
3. Second `refreshGraph()` fires while first is still running
4. GraphMethodHandler throws "Graph build superseded" for the older build
5. Error propagates as unhandled rejection → logged to console
6. Repeat cycle

### Fix

**Fix 1: Handle promise in event listener**

```typescript
// FIXED
bridge.on('graph.invalidated', () => {
  refreshGraph().catch((err) => {
    // Suppress "superseded" errors — they're expected during concurrent refreshes
    if (!err?.message?.includes('superseded')) {
      console.warn('[git-graph] refresh failed:', err);
    }
  });
});
```

**Fix 2: Debounce/gate refreshGraph to prevent concurrent execution**

```typescript
let refreshInFlight = false;
let refreshQueued = false;

async function refreshGraph() {
  if (refreshInFlight) {
    refreshQueued = true; // will re-run after current completes
    return;
  }
  refreshInFlight = true;
  try {
    // ... existing refresh logic
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshGraph().catch(() => {}); // re-run queued refresh
    }
  }
}
```

**Fix 3: Suppress watcher events during initial load**

```typescript
// In extension.ts — delay watcher binding until first graph build completes
let initialLoadComplete = false;

function requestRefresh() {
  if (!initialLoadComplete) return; // skip watcher events during startup
  router.sendEvent('graph.invalidated');
}

// Set flag after first successful graph.build response
```

### Files to Modify

- `src/webview/App.svelte` — add error handling to event listener, add refresh gating
- `src/extension/extension.ts` — suppress watcher during initial load (optional, belt-and-suspenders)

---

## Part 5: Multi-Branch Filter

### Current State

The graph filter is a single `<select>` dropdown:
```html
<select class="toolbar-select graph-branch-filter">
  <option value="">All branches</option>
  {#each branches as branch}
    <option value={branch.name}>{branch.name}</option>
  {/each}
</select>
```

State: `selectedBranchFilter: string | null` (single branch or null for "all").
Backend: `git log <branch>` accepts only one branch ref.

### New Design: Multi-select Branch Filter

**UI: `BranchFilterDropdown.svelte`**

Replace the native `<select>` with a custom multi-select dropdown:

- Button shows: "All branches" / "2 branches" / "feature/auth, develop..." (truncated)
- Click opens dropdown with checkboxes for each branch
- Search/filter input at the top of the dropdown (filter list of branches)
- "Select All" / "Clear All" quick actions
- Checkboxes for each branch with colored branch indicator
- Click outside or Escape to close
- Changes apply immediately (no "Apply" button needed)

**State change:**

```typescript
// Before
let selectedBranchFilter: string | null = null;

// After
let selectedBranchFilters: string[] = []; // empty = all branches
```

**Backend change in `git.service.ts`:**

```typescript
// Before: git log <branch>
// After: git log <branch1> <branch2> <branch3>

async log(options: LogOptions): Promise<Commit[]> {
  const args = ['log', ...formatArgs];
  if (options.branches?.length) {
    args.push(...options.branches); // multiple branch refs
  } else if (options.all !== false) {
    args.push('--all');
  }
  // ...
}
```

**Changes needed:**
- `src/webview/App.svelte` — replace `<select>` with `BranchFilterDropdown`
- `src/webview/components/toolbar/BranchFilterDropdown.svelte` — **NEW** component
- `src/extension/services/git.service.ts` — accept `branches: string[]` in LogOptions
- `src/extension/controllers/graph-method-handler.ts` — pass array to log()
- `src/webview/lib/graph-builder` (if exists) — handle multiple branch sources

---

## Files to Modify (Complete Summary)

### Part 1: Context Menu
- `src/webview/App.svelte` — add menu items + action handlers

### Part 2: Commit Search
- `src/webview/components/search/CommitSearch.svelte` — **NEW**
- `src/webview/App.svelte` — integrate in title bar
- `src/extension/services/git.service.ts` — add `searchCommits()`
- `src/extension/controllers/git-method-handler.ts` — register method

### Part 3: Loading Spinner
- `src/webview/components/ui/LoadingSpinner.svelte` — **NEW**
- `src/webview/App.svelte` — wrap network calls with `withLoading()`

### Part 4: Lifecycle Error Fix
- `src/webview/App.svelte` — error handling + refresh gating
- `src/extension/extension.ts` — suppress watcher during init (optional)

### Part 5: Multi-Branch Filter
- `src/webview/components/toolbar/BranchFilterDropdown.svelte` — **NEW**
- `src/webview/App.svelte` — replace `<select>` filter
- `src/extension/services/git.service.ts` — accept `branches[]`
- `src/extension/controllers/graph-method-handler.ts` — pass array

---

## Out of Scope

- Regex search in commit messages
- Search in file content (git log -S / git log -G)
- Advanced filtering (by author, date range) — could be added later

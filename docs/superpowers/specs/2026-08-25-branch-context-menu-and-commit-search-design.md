# Branch Context Menu Enhancement & Commit Search

**Date:** 2026-08-25  
**Status:** Approved  

## Overview

Two features for the git-graph VS Code extension:
1. **Branch context menu** — add missing actions when right-clicking a branch in the sidebar
2. **Commit search** — search bar in the graph title bar to find commits by message or hash

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

## Out of Scope

- Regex search in commit messages
- Search in file content (git log -S / git log -G)
- Advanced filtering (by author, date range) — could be added later
- Sidebar branch filter changes (stays as-is)

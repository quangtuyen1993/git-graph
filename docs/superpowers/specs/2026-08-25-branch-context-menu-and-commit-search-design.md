# Branch Context Menu, Commit Search, Lifecycle & Graph Row Layout

**Date:** 2026-08-25
**Status:** Approved

## Overview

Six changes for the git-graph VS Code extension:

1. **Branch context menu** — add missing actions when right-clicking a branch in the sidebar
2. **Commit search** — search bar in the graph toolbar to find commits by message or hash
3. **Loading spinner** — visual feedback during network operations (push, pull, fetch, review)
4. **Lifecycle error fix** — stop the startup error banner and the repeated refresh failures
5. **Multi-branch filter** — allow selecting multiple branches in the graph filter
6. **Graph row layout** — commit subject left, ref chips right-aligned, both ellipsised

## Global Constraints

- Svelte 4 (`^4.2.0`) — use `export let` props and assignment-based reactivity, not runes.
- `GitCLI.exec()` resolves to a **`string`**, not `{ stdout }`.
- `npm run check` (vitest + coverage thresholds + typecheck + build) must pass before each commit.
- Coverage thresholds are enforced: statements 80, lines 80, functions 80, branches 70.
- The graph view is a `WebviewView` (bottom panel). `enableFindWidget` is a `WebviewPanel`
  option and is **not** in effect here, so `Ctrl/Cmd+F` is free for the webview to bind.
- Graph layout is computed **extension-side**. The webview only ever holds one row window.

---

## Part 1: Branch Context Menu Enhancements

### Current State

`ContextMenu.svelte` supports items, dividers, danger styling, and submenus. The menu is built
in `App.svelte`'s `handleBranchContextMenu`. Existing actions: Checkout, Merge into current,
Rebase current onto this, Push, Pull, Fetch, Rename, Delete, Compare with...

### New Actions

| Action | Label | Implementation |
|--------|-------|----------------|
| New Branch from... | `New Branch from '<branch>'...` | `ui.inputBox` → `git.createBranch(name, startPoint)` |
| Checkout and Rebase | `Checkout and Rebase onto '<current>'` | ensure local branch → `git.checkout` → `git.rebase(previousCurrent)` |
| Diff with Working Tree | `Show Diff with Working Tree` | **new** `git.diffWorkingTree(ref)` |
| Rebase current onto | `Rebase '<current>' onto '<branch>'` | `git.rebase(selectedBranch)` |
| Pull Using Rebase | `Pull into '<current>' Using Rebase` | `git.pull(remote, ref, { rebase: true })` |
| Pull Using Merge | `Pull into '<current>' Using Merge` | `git.pull(remote, ref, { rebase: false })` |

### Menu Structure — local branch, not current

```
Checkout
New Branch from '<branch>'...
─────────────────────────────
Compare with '<current>'
Show Diff with Working Tree
─────────────────────────────
Rebase '<current>' onto '<branch>'
Merge '<branch>' into '<current>'
─────────────────────────────
Push ▶
Fetch
Rename
Delete                        (danger)
```

`Checkout and Rebase onto '<current>'` and the two Pull items appear **only** when the branch
has an upstream (see Resolved Ambiguities). Otherwise they are omitted, not disabled.

### Menu Structure — remote branch (e.g. `origin/bugfix/RMS2025-1027`)

```
Checkout
New Branch from '<branch>'...
─────────────────────────────
Checkout and Rebase onto '<current>'
─────────────────────────────
Compare with '<current>'
Show Diff with Working Tree
─────────────────────────────
Rebase '<current>' onto '<branch>'
Merge '<branch>' into '<current>'
─────────────────────────────
Pull into '<current>' Using Rebase
Pull into '<current>' Using Merge
─────────────────────────────
Delete Remote Branch          (danger)
```

### Resolved Ambiguities

**Pull into current — which remote and ref?**
Only shown when a remote ref can be resolved.
- Remote branch `origin/bugfix/X` → `remote = 'origin'`, `ref = 'bugfix/X'` (split on the first
  `/`, matching the remote name from the branch list).
- Local branch with upstream `origin/dev` → same split of its upstream.
- Local branch without upstream → item omitted.

Semantics: this pulls the **selected** ref into the **current** branch — it is a
fetch-and-integrate of someone else's ref, not a pull of the current branch's own upstream.

**Checkout and Rebase onto current — remote branch means detached HEAD.**
`git checkout origin/x` detaches HEAD, which makes the following rebase meaningless. So:
1. If a local branch with the short name already exists → `git.checkout(shortName)`.
2. Otherwise → `git.createBranch(shortName, 'origin/x')` then `git.checkout(shortName)`.
   `git branch <name> <remote-tracking-ref>` sets upstream automatically.
3. Then `git.rebase(previousCurrentBranch)`.

**Show Diff with Working Tree needs a new git method.**
`GitService.diff(ref1, ref2)` always builds `${ref1}...${ref2}`:

```typescript
// git.service.ts:193-195 — existing
this.cli.exec(['diff', '--numstat', '-z', '-M', '-C', `${ref1}...${ref2}`])
```

There is no working-tree sentinel anywhere in the codebase. Add:

```typescript
// Compares <ref> against the working tree — no second ref, no three-dot range.
public async diffWorkingTree(ref: string): Promise<DiffResult> {
  const [numstatOutput, nameStatusOutput, rawOutput] = await Promise.all([
    this.cli.exec(['diff', '--numstat', '-z', '-M', '-C', ref]),
    this.cli.exec(['diff', '--name-status', '-z', '-M', '-C', ref]),
    this.cli.exec(['diff', ref]),
  ]);
  // parse identically to diff()
}
```

Register as `git.diffWorkingTree` in `git-method-handler.ts`.

### Data Flow

**New Branch from...**
1. `ui.inputBox` → `{ prompt: 'New branch name', placeholder: 'feature/...' }`
2. Cancelled (undefined) → no-op
3. `git.createBranch { name, startPoint: selectedBranch }`
4. Refresh

**Rebase current onto selected / Checkout and Rebase**
1. `ui.confirm` with the exact command being run in `detail`
2. Run the calls in order, stopping at the first failure
3. Refresh

**Pull Using Rebase / Merge**
1. `git.pull { remote, branch: ref, rebase: true | false }` wrapped in `withLoading` (Part 3)
2. Refresh

### Error Handling

- Rebase/merge conflict → error notification offering `git.abortRebase` / `git.abortMerge`
- Delete unmerged branch → existing `BranchNotFullyMergedError` path, offers force delete
- Network failure → error notification, spinner cleared in `finally`

---

## Part 2: Commit Search in the Graph Toolbar

### UI Component: `CommitSearch.svelte`

| State | Visual |
|-------|--------|
| Collapsed | Search icon button |
| Expanded | Input, placeholder `Search commit message or hash...`, auto-focused |
| Loading | `LoadingSpinner` (Part 3) inside the input |
| Results | `<n>/<total>` counter + prev/next buttons |
| Empty | `No commits found` |

### Behavior

- Click icon or press `Ctrl/Cmd+F` → expand and focus
- Typing → 300 ms debounce → one in-flight search at a time (latest wins)
- Input matching `/^[0-9a-f]{7,40}$/i` → hash lookup first, message grep as fallback
- Otherwise → message grep only
- Result → jump to the first match: highlight it and scroll it into view
- Prev/next cycle through matches, wrapping around
- `Escape` or the clear button → clear results, remove highlight, collapse
- Search state clears whenever `layoutVersion` changes or the branch filter changes
  (row indexes belong to one layout only)

### `git.searchCommits`

```typescript
public async searchCommits(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    // --verify + ^{commit} is the only reliable existence check; plain rev-parse
    // echoes syntactically valid object names back even when absent.
    const hash = await this.cli
      .exec(['rev-parse', '--verify', `${trimmed}^{commit}`])
      .then((out) => out.trim())
      .catch(() => '');
    if (hash !== '') return [hash];
  }

  // exec() resolves to a string, not { stdout }.
  const output = await this.cli.exec([
    'log', `--grep=${trimmed}`, '-i', '--max-count=50', '--format=%H', '--all',
  ]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}
```

Registered as `git.searchCommits` in `git-method-handler.ts`.

### Locating a commit — reuse `graph.getRow`

The webview cannot locate a commit on its own (layout is extension-side, the webview holds one
window), but the lookup already exists — no new method is needed:

```typescript
// graph.service.ts:190 — existing
public getRow(hash: string, layoutVersion?: number): number | null

// graph-method-handler.ts:43 — existing, returns { row }
case 'graph.getRow': { ... return { row: this.graphService.getRow(p.hash, p.layoutVersion) }; }
```

Search flow: `git.searchCommits` → hashes → `graph.getRow { hash, layoutVersion }` for the
active match → row index → scroll to `row * ROW_HEIGHT` → the existing window machinery loads
that region.

- `row === null` → the commit exists but is outside the current filter. Surface
  `Commit is outside the current branch filter`, do not fail silently.
- A stale `layoutVersion` makes `getRow` **throw** (`Graph layout version mismatch`). Search
  clears its state on every layout change, so this is a guard, not a normal path — catch it and
  clear results.

### Highlight

- Every matched row visible in the window: `--vscode-editor-findMatchHighlightBackground`
- The active match: `--vscode-editor-findMatchBackground`
- Highlight is derived from the result set, so it survives window scrolling without extra work

---

## Part 3: Loading Spinner for Network Operations

### Problem

Push, pull, fetch, and AI review give no feedback while running, so the UI looks frozen.

### Component: `src/webview/components/common/LoadingSpinner.svelte`

```svelte
<script lang="ts">
  export let size: 'sm' | 'md' = 'sm';
  export let label = 'Working...';
</script>

<span class="spinner spinner-{size}" role="status" aria-label={label}>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor"
            stroke-width="2" stroke-dasharray="47 16" stroke-linecap="round" />
  </svg>
</span>
```

`@keyframes spin { to { transform: rotate(360deg); } }`, colour
`var(--vscode-progressBar-background)`, honours `prefers-reduced-motion` by slowing to 2 s.

### Placement (one place per surface, no alternatives)

| Surface | Location |
|---------|----------|
| Push / Pull / Fetch / Checkout / Rebase / Merge | The existing `.mutation-progress` banner |
| AI review | Review panel header, `ReviewApp.svelte` |
| Commit search | Inside the search input |

### State — reuse the existing MutationGate

Progress state already exists and is already rendered as a text banner; it only lacks a spinner:

```typescript
// App.svelte:266-267 — existing
const mutationGate = new MutationGate();
let mutationProgress: string | null = null;
```

```svelte
<!-- App.svelte:1471-1473 — existing -->
{#if mutationProgress}
  <div class="mutation-progress" aria-live="polite">{mutationProgress}</div>
{/if}
```

Every context-menu mutation already flows through `runMutation` → `mutationGate.run(label)` →
`mutationProgress = label`, including a dedicated `Awaiting confirmation…` state. So the work is:

1. Render `LoadingSpinner` inside the existing banner, left of the label.
2. Hide the spinner when the label is `Awaiting confirmation…` — nothing is running, we are
   waiting on the user, and a spinner there reads as a hang.
3. Give push/pull/fetch mutations explicit labels (`Pushing to origin…`, `Pulling origin/dev…`)
   instead of the generic `Preparing…`.
4. Add a spinner to the review panel header driven by the review job state in `ReviewApp.svelte`.

Do **not** introduce a parallel `pendingOperations` set — `MutationGate` already serialises
mutations and throws on overlap, and a second mechanism would drift from it.

---

## Part 4: Fix Startup Lifecycle Errors

### Root Cause

`invalidate()` bumps the build generation **before** the event goes out, so any in-flight build
is guaranteed to fail:

```typescript
// graph-method-handler.ts:20-22
public invalidate(): void {
  this.buildGeneration += 1;
  this.graphService.invalidateLayout(++this.nextLayoutVersion);
}

// graph-method-handler.ts:65-73
const generation = ++this.buildGeneration;
const commits = await loadAllCommits(gitService, logOptions);
this.assertCurrent(generation, gitService, repoPath); // throws 'Graph build superseded'
```

Invalidations come from the file watcher on `{HEAD,refs/**,index}`, driven by external writers
(the built-in Git extension, index refreshes) — not by our own `git log`, which writes nothing.

`refreshGraph` only swallows failures when **its own** token is already stale:

```typescript
// App.svelte:578-581
} catch (refreshError) {
  if (!graphRefreshGate.isLatest(refreshToken)) return;
  throw refreshError;
}
```

So there are two distinct symptoms:

1. **Startup error banner.** The `onMount` refresh is still the latest token when the
   supersede error arrives, so it rethrows into the `onMount` try/catch, which sets
   `error` and `status = 'Error'` (App.svelte:298-314). A benign race renders as a hard failure.
2. **Repeated console errors.** Later refreshes come from an event handler with no rejection
   handling at all (App.svelte:316-318), so every superseded build is an unhandled rejection.

A third, quieter bug: the `graph.invalidated` listener is registered **after** the whole startup
await chain, so any invalidation during startup is dropped and the graph silently stays stale.

### Fixes

**Fix 1 — make supersede a typed, non-fatal outcome.**
The protocol already carries `error.kind` (used by `BRANCH_NOT_FULLY_MERGED`). Tag the
supersede error `GRAPH_BUILD_SUPERSEDED` instead of relying on message text, and treat that
kind as "a newer build is coming, do nothing" in `refreshGraph` — return instead of rethrow,
so it never reaches the error banner or the console.

**Fix 2 — register the listener before the first refresh.**
Move `bridge.on('graph.invalidated', ...)` above the initial `refreshGraph()` in `onMount`, and
give it a rejection handler:

```typescript
bridge.on('graph.invalidated', () => {
  void scheduleRefresh();
});
```

**Fix 3 — coalesce invalidations instead of adding a second gate.**
`graphRefreshGate` (`LatestRequestGate`) already drops stale results; a parallel
`refreshInFlight`/`refreshQueued` pair would fight it, and re-entering `refreshGraph()` from a
`finally` block can loop under a busy watcher. Instead debounce the event:

```typescript
let invalidateTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRefresh(): void {
  clearTimeout(invalidateTimer);
  invalidateTimer = setTimeout(() => {
    refreshGraph().catch((err) => {
      if (!isSuperseded(err)) console.warn('[git-graph] refresh failed:', err);
    });
  }, 200);
}
```

Bursts of watcher events collapse into one refresh; the existing gate handles overlap.
The timer is cleared in the existing `onDestroy` cleanup.

### Files

- `src/extension/controllers/graph-method-handler.ts` — typed supersede error
- `src/extension/types/messages.types.ts` — add the `GRAPH_BUILD_SUPERSEDED` kind
- `src/webview/App.svelte` — listener ordering, debounce, non-fatal supersede handling

---

## Part 5: Multi-Branch Filter

### Current State

A single `<select>` in the toolbar drives `selectedBranchFilter: string | null`, sent as
`{ branch: branchFilter, all: false }` to `graph.build` (App.svelte:538-540).

### What Actually Blocks Multi-Branch

`GitService.log()` **already** accepts multiple refs — no change needed there:

```typescript
// git.service.ts:84-91
if (options.revisions !== undefined) {
  if (options.revisions.length === 0) return [];
  args.push(...options.revisions);
} else {
  if (options.all) args.push('--all');
  if (options.branch) args.push(options.branch);
}
```

The blocker is `snapshotLogOptions()`, which resolves only one branch:

```typescript
// git.service.ts:99-102
if (options.branch) {
  const revision = await this.cli.exec(['rev-parse', '--verify', options.branch]);
  revisions = [revision.trim()];
}
```

### Changes

1. `GitLogOptions` gains `branches?: string[]`; `branch` stays for compatibility.
2. `snapshotLogOptions` resolves every entry of `branches` via
   `rev-parse --verify <branch>` and dedupes into `revisions`. A ref that fails to resolve is
   skipped, not fatal — a branch can disappear between the branch list and the build.
3. `GraphOptions` / `graph.build` accept `branches: string[]`.
4. `App.svelte` state becomes `selectedBranchFilters: string[]`; empty means all branches.
5. Status text: `<n> commits on <branch>` for one, `<n> commits on <k> branches` for several.

### UI: `BranchFilterDropdown.svelte`

- Trigger label: `All branches` / the branch name / `<k> branches`
- Popover with a filter input, `Select All` / `Clear All`, and one checkbox per branch
  (no colour swatch — the branch list carries no lane colour; lane colours only exist on graph
  nodes)
- Applies immediately on toggle; closes on outside click or `Escape`
- Keyboard: arrows move, `Space` toggles, `Enter` closes

### Files

- `src/webview/components/toolbar/BranchFilterDropdown.svelte` — new
- `src/webview/App.svelte` — replace the `<select>`, thread `branches[]`
- `src/extension/services/git.service.ts` — `snapshotLogOptions` multi-ref
- `src/extension/types/git.types.ts` — `branches?: string[]`
- `src/extension/controllers/graph-method-handler.ts` — pass the array through

---

## Part 6: Graph Row Layout — Right-Aligned Ref Chips

### Current State

Chips render **before** the subject and refuse to shrink, so a commit with several refs pushes
its message off the row entirely:

```svelte
<!-- App.svelte:1687-1692 -->
<div class="col-message">
  {#each node.refs as ref}
    <span class="ref-badge ref-{getRefType(ref)}">{getRefDisplayName(ref)}</span>
  {/each}
  <span class="commit-subject">{node.subject}</span>
</div>
```

```css
/* App.svelte:2130-2141 */
.commit-row .col-message { flex: 1; display: flex; gap: 6px; overflow: hidden; }
/* App.svelte:2191-2200 */
.ref-badge { display: inline-block; white-space: nowrap; flex-shrink: 0; }
/* App.svelte:2219-2223 */
.commit-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

### Target Layout

Subject on the left, chips pinned to the right edge of the message column, both ellipsised:

```
│ fix: resolve login redirect loop when sessi…        [development] [origin/dev…] │
```

### Design

```svelte
<div class="col-message">
  <span class="commit-subject" title={node.subject}>{node.subject}</span>
  {#if node.refs.length > 0}
    <span class="ref-chips">
      {#each node.refs as ref}
        <span class="ref-badge ref-{getRefType(ref)}"
              title={getRefDisplayName(ref)}>{getRefDisplayName(ref)}</span>
      {/each}
    </span>
  {/if}
</div>
```

```css
.commit-row .col-message {
  flex: 1;
  min-width: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.commit-subject {
  flex: 1 1 auto;
  min-width: 0;          /* without this a flex item never ellipsises */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-chips {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 50%;        /* chips never starve the subject */
  display: flex;
  gap: 6px;
  overflow: hidden;
  justify-content: flex-end;
}

.ref-badge {
  max-width: 160px;      /* one long ref truncates instead of eating the row */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;        /* was 0 */
}
```

### Decisions

- **Space split.** Subject is the flexible item; chips cap at 50% of the column. On a narrow
  window both ellipsise rather than one winning outright.
- **Chip order.** `HEAD` and the current branch sort first so they survive truncation; remote
  refs last. Sorting happens in a pure helper in `src/webview/lib/` (testable, covered).
- **Overflow.** Chips clip at the container edge; no `+N` counter. `title` gives the full name
  on hover for both subject and chips.
- **Reading order.** Subject now precedes the chips in the DOM, which matches the visual order
  left-to-right and reads better for screen readers than the current chips-first markup.
- **Header alignment.** `.table-header .col-message` (App.svelte:1953) keeps its left-aligned
  label — the header has no chips.
- **Uncommitted-changes row** (App.svelte:1663) uses the same column and has no refs; it
  inherits the new subject rules unchanged.

---

## Testing Strategy

`npm run check` runs vitest, coverage thresholds, typecheck, and build. Coverage `include`
already covers the files this work touches:

```
src/extension/services/git.service.ts
src/extension/controllers/git-method-handler.ts
src/extension/controllers/graph-method-handler.ts
src/webview/lib/**/*.ts
```

Consequences for the plan:

- New logic in those files **requires** tests, or `npm run check` fails on thresholds.
- Put decision logic in pure helpers under `src/webview/lib/` — already in the include list and
  testable without a DOM: context-menu item construction, remote/ref splitting for pull, hash-vs-
  text query classification, ref-chip sort order, branch-filter label formatting.
- Svelte components are **not** in the include list (only `ContextMenu`, `ResizeHandle`,
  `BranchSidebar` are), so the three new components do not move coverage. Do not add them to the
  list as part of this work.
- Extension-side unit tests use the existing `tests/helpers` git CLI mocks; assert on the
  **argv arrays** passed to `exec` (that is what pins `--verify`, `^{commit}`, `--grep`, and
  multi-ref ordering).

---

## Out of Scope

- Regex search in commit messages
- Content search (`git log -S` / `-G`)
- Author and date-range filters
- A `+N` overflow counter for ref chips
- Reordering or resizing graph columns

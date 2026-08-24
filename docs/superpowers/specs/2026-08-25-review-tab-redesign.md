# Review Tab Redesign

## Problem

The current Review tab is hard to use:
1. No way to review a single commit's changes directly from the review tab — must right-click in the graph
2. Branch compare and commit range are conflated into one UI that swaps between `<select>` dropdowns and an opaque chip
3. Inputs are plain `<select>` elements — no search, no typing a hash directly
4. No repo picker — relies entirely on the graph's active repo
5. Claude CLI rate-limit responses (exit 0, non-review content) are silently saved as if they were valid reviews

## Design: Approach A — Rewrite ReviewApp

Rewrite `ReviewApp.svelte` as a single component with a new layout. Extract a reusable `Combobox.svelte` component.

### Layout

```
┌─ Repo picker ────────────────────────────┐
│ [combobox: repo path]                    │
├─ Mode tabs ──────────────────────────────┤
│ [1 Commit] [2 Commits] [2 Branches]     │
├─ Input area (changes per mode) ──────────┤
│ "1 Commit":   [commit combobox]          │
│ "2 Commits":  [base commit] ← [head]    │
│ "2 Branches": [base branch] ← [head]    │
├─ Action bar ─────────────────────────────┤
│ [Provider ▾] [Model input] [Review btn] │
├─ Changed files ──────────────────────────┤
│ (compare result from selected pair)      │
├─ Reviews history ────────────────────────┤
│ (list of past/running reviews)           │
└──────────────────────────────────────────┘
```

### Components

#### ReviewApp.svelte (rewrite)

The shell that owns all state and renders the layout above. Mode is stored as a reactive variable (`'commit' | 'range' | 'branch'`). Switching mode clears the input values and files but preserves reviews history and provider/model selection.

#### Combobox.svelte (new, reusable)

A text input with a dropdown suggestion list. Behavior:
- **Focus** → show full list (capped at ~50 items)
- **Type** → filter list by substring match on both display label and value
- **Select** → fill input, close dropdown, fire `on:select` event
- **Free text** → user can type any value (hash, branch name) without selecting from list; value committed on blur or Enter
- **Keyboard** → arrow keys navigate, Enter selects, Escape closes

Props:
- `items: Array<{ label: string; value: string; detail?: string }>` — suggestion source
- `value: string` — current text value (bindable)
- `placeholder: string`
- `aria-label: string`

Events: `on:select`, `on:input`, `on:blur`

#### Repo picker

Syncs with the graph's repo picker — same repos, same active selection. Not a combobox; uses the same `<select>` dropdown the graph already uses for consistency. Changing it reloads branches and recent commits for the combobox suggestions in the input area. On mount, defaults to the graph's active repo. When the graph switches repo, review tab follows.

The combobox with text input + dropdown suggest is specifically for the **branch and commit inputs** — the motivation is that scrolling through a long branch list by eye is painful; typing to filter is much faster.

Host message: `review.getRepos` → returns `Array<{ path: string; name: string }>`.

### Mode Details

#### Mode: 1 Commit

- One combobox for commit selection
- Suggestions: recent commits from the selected repo (hash abbreviated + subject)
- On select/blur: auto-compare (commit vs its first parent)
- Review button sends `review.start` with `kind: 'commit'`

#### Mode: 2 Commits

- Two comboboxes: "Base commit" and "Head commit"
- Suggestions: same recent commits list
- Swap button (⇄) between them
- On both filled: auto-compare the range
- Review button sends `review.start` with `kind: 'range'`

#### Mode: 2 Branches

- Two comboboxes: "Base branch" and "Head branch"
- Suggestions: branch list from the selected repo
- Head defaults to current branch, base defaults to main/master
- Swap button (⇄)
- On both filled: auto-compare
- Review button sends `review.start` with `kind: 'branch'`

### Graph Interaction Changes

In `App.svelte` commit context menu:

1. **"Review this commit"** — unchanged, sends `review.setTarget` with `kind: 'commit'`
2. **"Review with selected [hash7]"** — new item, visible when `selectedForCompare` is set and differs from the right-clicked commit. Sends `review.setTarget` with `kind: 'range', baseRef: selectedForCompare, headRef: clickedHash`.
3. **"Select for compare"** / **"Compare with selected"** — unchanged, already works

When `review.setTarget` arrives at the review tab:
- `kind: 'commit'` → switch to "1 Commit" mode, fill the combobox
- `kind: 'range'` → switch to "2 Commits" mode, fill both comboboxes
- `kind: 'branch'` → switch to "2 Branches" mode, fill both comboboxes

### Host Messages (new/changed)

| Message | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `review.getRepos` | webview → host | — | `Array<{ path: string; name: string }>` |
| `review.getCommits` | webview → host | `{ repo?: string; limit?: number }` | `Array<{ hash: string; subject: string; date: string }>` |
| `review.setTarget` | host → webview (broadcast) | `{ kind, baseRef, headRef, subject? }` | — |

`git.branches` already exists and returns the branch list for the active repo. `review.getCommits` is new — returns recent commits (default 100) for the repo specified in `repo` param (falls back to the review tab's selected repo if omitted).

Both "1 Commit" and "2 Commits" modes use the same commit suggestions list from `review.getCommits`. The existing `review.compare` message is still used by all 3 modes to fetch the changed files for the selected pair.

### State Persistence

Persisted keys (via `ui.setState` / `ui.getState`):
- `review.mode` — `'commit' | 'range' | 'branch'`
- `review.repo` — selected repo path (null = follow graph)
- Existing keys preserved: `aiReview.provider`, `aiReview.model`, `detail.viewMode`
- Target persistence via existing `review.saveTarget` / `review.getTarget`

### Rate-Limit Detection

In `AIReviewService`, after the CLI exits with code 0, check the output for known rate-limit patterns before returning it as review content:

```typescript
const RATE_LIMIT_PATTERNS = [
  /session limit/i,
  /rate limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /resets? \d/i,
];

function detectRateLimit(output: string): string | null {
  if (output.length > 500) return null; // Real reviews are longer
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(output)) return output.trim();
  }
  return null;
}
```

If detected, throw an error with the rate-limit message so the review entry is marked `failed` with a meaningful error rather than silently saved as `done` with garbage content.

### Files Changed (estimated)

| File | Action |
|------|--------|
| `src/webview/ReviewApp.svelte` | Rewrite |
| `src/webview/components/Combobox.svelte` | New |
| `src/webview/App.svelte` | Add "Review with selected" menu item |
| `src/extension/controllers/review-method-handler.ts` | Add `review.getRepos`, `review.getCommits` |
| `src/extension/services/ai-review.service.ts` | Add rate-limit detection |
| Tests | New tests for Combobox, updated tests for ReviewApp, graph menu |

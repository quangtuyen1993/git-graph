# Code Review, Merged Into the Graph

## Problem

The review panel asks the user to declare a method before they can state an intent.

Its four tabs — `1 Commit`, `2 Commits`, `2 Branches`, `Pull Request` — are four ways of naming the same thing. At `review.start` every one of them resolves to a base sha and a head sha; the tabs differ only in how the user spells those two ends, and in two cases the base is derived rather than chosen. The system's own cache key already says so: `buildReviewId` ignores the commit/range/branch distinction entirely and varies only for `'pr'`.

The one benefit tabs are supposed to buy — keeping each mode's half-filled state separate — is not delivered. `setMode()` clears every git-based input on switch, so glancing at another tab and back destroys what was typed. Only the pull request selection survives, by explicit exception.

Meanwhile the panel duplicates a picker the product already has. The graph shows commits, branches and pull requests, with selection, multi-select and context menus already built. The review panel makes the user find the same thing again by typing part of its name into a combobox.

And the two surfaces cannot be seen at once: `Git Graph` and `Code Review` are sibling tabs in the same panel area. Comparing a diff against the review that discusses it means switching tabs.

### The duplication runs deeper than the tabs

Two context-menu items in the graph dispatch identical code:

```
case 'reviewWithSelected':   review.setTarget { kind:'range', baseRef, headRef }
case 'compareWithSelected':  review.setTarget { kind:'range', baseRef, headRef }
```

Not similar — the same parameters to the same method. `Compare with '<current>'` on the branch menu calls it too. So the review panel is already the graph's **compare surface**: `review.compare` returns the changed files, the panel lists them, clicking a row opens a diff, and no AI is involved. Compare is review without the run.

That has a consequence for what gets deleted. `review.setTarget` and `review.compare` are not review-only machinery, and removing the panel without giving compare a destination would take a working feature with it.

It also settles what `review.setTarget` does: it resolves, stores, focuses the panel and broadcasts. **It never starts a review** — the user presses a button afterwards. Every "review" gesture in the graph today is a navigation.

### Three defects this design removes

**The repository picker does not work**, and it fails in a way that mislabels data. `handleRepoChange` writes `ui.setState('review.repo', …)` — a key nothing in `src/extension` ever reads. It then reloads branches and commits through `deps.getGitService()`, which serves the host's *active* repository, not the selected one. `review.start` files the result under `deps.getRepoId()`, likewise the active repository.

So selecting repository B relabels the panel, shows repository A's branches, commits and pull requests, and stores the review under A. Anyone who has used that dropdown has reviews filed against the wrong repository.

This design deletes the picker: the graph already owns repository selection, and the review view follows it.

**Two settings are declared and never read.** `gitGraphPro.aiReview.defaultProvider` (an enum defaulting to `auto`) and `gitGraphPro.aiReview.defaultModel` appear in `package.json` and no code anywhere reads either. The provider actually in force is persisted in the ui-state key `aiReview.provider`, written only by the panel's dropdown. A user who sets the documented setting sees nothing happen.

This is the same shape as `review.repo` — declared, sometimes written, never read — which makes three such keys in one feature. This design makes the two settings live: `defaultProvider` selects the provider, `auto` means the first available one, `defaultModel` supplies the model, and the ui-state keys go.

## Design

Everything moves into the Git Graph panel. The `Code Review` panel is removed.

```
┌─ sidebar ────────┬─ graph ──────────────┬─ detail ──────────┐
│ ▸ LOCAL          │                      │  Commit detail    │
│ ▸ REMOTE         │   ●─┐                │       or          │
│ ▸ TAGS           │   │ ●                │  Pull request     │
│ ▸ STASHES        │   ●─┘                │       or          │
│ ▸ WORKTREES      │   │                  │  Review     ← new │
│ ▸ SUBMODULES     │                      │                   │
│ ▸ PULL REQUESTS  │                      │                   │
│ ▸ REVIEWS  ← new │                      │                   │
└──────────────────┴──────────────────────┴───────────────────┘
```

Two additions, both following an idiom the sidebar already uses:

- **`REVIEWS`**, an eighth collapsible section listing this repository's reviews. Selecting a row shows it in the detail panel — exactly how `PULL REQUESTS` behaves.
- **A third mode for the detail panel**, alongside commit detail and pull request detail.

The AI provider and model become settings rather than per-run controls. `gitGraphPro.aiReview.defaultProvider` already exists.

### Starting a review

Four of the five entry points already exist. This design routes existing gestures to a new destination rather than inventing new ones.

| Target | Gesture | Status |
|---|---|---|
| A commit | Commit context menu → `Review this commit` | exists |
| A range | Shift-select rows, or set a compare anchor → `Review with selected` | exists |
| A pull request | Pull request detail → `Review with AI` | exists |
| A branch against another | Branch context menu → `Review '<branch>' vs '<current>'` | new, beside the existing `Compare with '<current>'` |
| Uncommitted changes | Working-tree row context menu → `Review uncommitted changes` | new |

And two gestures that open the same surface **without** running a review:

| Target | Gesture | Status |
|---|---|---|
| A range, diff only | `Compare with selected` | exists — currently identical to `Review with selected` |
| A branch against another, diff only | `Compare with '<current>'` | exists |

`Review with selected` and `Compare with selected` stop being duplicates: one runs a review, the other does not.

Triggering runs the review immediately. The detail panel switches to the review mode, shows progress while the runner streams, then the result.

**This is a behaviour change, not a retargeting.** Today these gestures navigate: `review.setTarget` fills the panel's fields and the user presses Review. Making the gesture run the review is the point — it is what removes the second step — but it is new behaviour to build, not an existing call rerouted.

### One surface, two states

The review mode has a **diff-only** state: the resolved base and head, the changed-file list, no AI body. It is what the compare gestures open, and it is what a review shows before its run finishes.

This falls out of the finding above rather than being invented for it. Compare is review without the run, so the same component serves both, `review.compare` keeps its caller, and the panel that compare depends on can be deleted safely.

File rows in this state open a diff, as they do today.

### The target model

The four wire kinds — `commit`, `range`, `branch`, `pr` — stay exactly as they are, even though no tab corresponds to them any more. A kind is now *provenance inferred from the gesture*, not a mode the user declared.

Keeping them is not sentiment. `isReviewTarget` silently rejects a persisted target whose kind is not in `REVIEW_TARGET_KINDS`, and stored review entries fall back to the branch label format when their kind is unrecognised. Removing a kind would quietly discard saved state; keeping them costs nothing.

A fifth kind, `worktree`, is added for uncommitted changes. Its base is `HEAD`; its head is the working tree.

**`worktree` cannot be cached by sha pair, and this matters.** `buildReviewId` is built from base and head shas. The working tree has no sha — its content is what changes. Keyed on `HEAD` alone, the sequence *review → edit → review again* returns the first result verbatim, because the id never moved. Combined with the silent cache hit described below, the user would believe the model had read code it never saw.

**Resolution:** the diff's content hash participates in the id for `worktree` targets. The diff must be computed before the id is known — which costs nothing, because reviewing requires the diff anyway.

### Two silences to end

Both exist today. The redesign makes each worse if left alone, because the trigger moves further from the result.

**A cache hit says nothing.** `review.start` on an identical target, provider and model opens the existing review and returns `cached: true`, a flag the webview ignores. Under the current design the user at least watched themselves press a button. Under this one, a context-menu click that instantly yields a week-old review reads as either an impossibly fast model or one that ignored the changes. The review mode must state that it is showing an existing result, when it was produced, and offer to re-run.

**A failed review shows a bare glyph.** `ReviewEntry.error` exists and is populated, but nothing renders it. The reason is reachable only by opening the review body, which nothing tells the user to do. Selecting a failed review must show why it failed.

### Errors belong to what failed

The panel currently routes eight unrelated operations — compare, pull request list, pull request files, repository reload, file open, row actions, review start — into one anonymous error slot with no operation label, no dismissal, and clearing that only happens on two of the eight successes. A failed pull request fetch at startup sits on screen while the user works on something else, attributed to nothing.

In this design an error is rendered where it happened: a history load failure in the `REVIEWS` section, a review failure inside that review.

### The derived base is always visible

The review mode shows the resolved pair as text:

```
Review · feature/RMS-1027 → develop            [Re-run] [Open as file]
Kiro · claude-opus-5 · 2 minutes ago
─────────────────────────────────────────────────────────
base  a1b2c3d  develop
head  e4f5g6h  feature/RMS-1027
─────────────────────────────────────────────────────────
summary, findings, verdict
```

This is load-bearing rather than decorative. The worst outcome of removing the tabs is a review whose base the user cannot see, and the base is derived in three of the five cases — a commit's parent, a pull request's target branch, the working tree's `HEAD`. Precisely the cases the user did not choose are the ones that must be shown.

`Open as file` keeps the existing path to the review as markdown in an editor, so a long review still gets search, folding and copy.

### One bit that should travel

The extension computes `localBothPresent` — whether both shas exist in the local repository — but never sends it to the webview. Lacking it, the review panel uses `mode === 'pr'` as a proxy for "this diff came from the API", and consequently disables pull request file rows **even when both commits are present locally** and opening a diff would work.

The bit travels with the target. The proxy goes away, and file rows are live whenever they can be.

## What is removed

- `ReviewApp.svelte` (~994 lines). The review mode becomes a component under `components/detail/`, beside `CommitDetail` and `PullRequestDetail`.
- `review-main.ts`, the `gitGraphProReview` view container, and the `gitGraphPro.reviews` view.
- **`createReviewSession` in `extension.ts` — the second webview host.**
- `review.setTarget` and its focus-and-broadcast machinery. With one panel there is no handoff between panels — and with the diff-only state, nothing it served is left stranded.
- The `review.mode` and `review.repo` ui-state keys, and the `aiReview.provider` and `aiReview.model` ones the settings replace.
- Four tabs, five comboboxes, the provider dropdown, the model input, the Review button, the repository picker.

Removing the second host is worth naming on its own: it deletes the requirement that every message namespace be registered on **both** hosts — a rule that has already produced one defect and one test that could not catch it.

## What is preserved

- The handler's `review.*` methods — thirteen today, fourteen once the review mode adds `review.body` — each accounted for rather than assumed:
  - **Kept with callers:** `start`, `rerun`, `list`, `get`, `body`, `cancel`, `delete`, `open`, `compare` (the diff-only state), `saveTarget`.
  - **Removed with what they served:** `setTarget` (the panel handoff), `getRepos` and `getCommits` (the pickers), `getTarget` (the panel's restore).
- The review store on disk. **Reviews saved by the current version must still load and open.** This is a hard constraint.
- `review.saveTarget`'s write-behind semantics for whatever still persists a target.
- The forge-availability gate on restore: a stored `'pr'` target in a repository whose provider is gone must degrade, not error.

## Testing

- A review stored by the current version, in each of the four existing kinds, still loads and opens.
- `worktree`: review, edit a file, review again — the second run executes rather than returning the cached result.
- A cache hit on any other kind renders as an existing result with its age and a way to re-run.
- A failed review shows its reason when selected.
- With no AI provider available, every entry point explains what is needed rather than offering a dead control.
- The derived base renders for all three derived cases.
- Pull request file rows open a diff when both commits are local, driven by `localBothPresent` rather than the kind.
- An error from one operation does not appear to belong to another.
- Both compare gestures open the diff-only state and start no review.
- `gitGraphPro.aiReview.defaultProvider` selects the provider; `auto` picks the first available one.

## Roadmap

| Phase | Deliverable | Depends on | Ships alone | Acceptance |
|---|---|---|---|---|
| **1** | The review mode in the detail panel, plus the `REVIEWS` sidebar section, both fed by the existing `review.*` methods. The old panel still exists and still works. | nothing | Yes | An existing stored review can be selected in `REVIEWS` and read in the detail panel, including its derived base and, for a failed one, its reason |
| **2** | Entry points: the two new context-menu items, the three review gestures changed from navigate to run, and the two compare gestures pointed at the diff-only state | 1 | Yes | Each of the five review gestures runs a review that appears in the detail panel; both compare gestures open the diff-only state and run nothing; with no provider, each review gesture explains what is missing instead of offering a dead control |
| **3** | The `worktree` kind, with the diff-content hash in the review id | 2 | Yes | Review, edit, review again runs a second time; the id differs between the two |
| **4** | The two silences and the attributed errors: cache-hit disclosure, failure reasons, per-operation error placement, and `localBothPresent` travelling to the webview | 1 | Yes | A cache hit is visibly a cache hit; a pull request file row opens a diff when both commits are local |
| **5** | Remove the old panel: `ReviewApp.svelte`, `review-main.ts`, the view container, `createReviewSession`, `review.setTarget`, the dead ui-state keys | 2, 4 | Yes | The extension registers one webview host; each of the fourteen `review.*` methods is either kept with a caller or removed with what it served; both compare gestures still work; the full suite passes with the second host gone |

Phase 1 ships a second way to read reviews while the old panel still works, so nothing is lost if later phases stall. Phase 5 is the only irreversible step and it runs last, once every gesture it would strand has a replacement.

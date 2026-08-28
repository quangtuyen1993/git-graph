# Code Review in the Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to execute this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move code review into the Git Graph panel and delete the separate review panel, so a review is started from the thing being reviewed and read beside it.

**Spec:** `docs/superpowers/specs/2026-08-28-review-in-graph-design.md`

## How this plan is shaped

Tasks state **requirements, not implementations**. No function bodies, no test bodies — the implementer writes both.

This is a deliberate departure from the writing-plans default, and it is the same shape as `docs/superpowers/plans/2026-08-26-forge-provider-phase4-8.md`. The predecessor to that plan wrote out ~3,300 lines of complete code and the execution ledger records the result: the plan became the largest single source of defects, implementers became transcribers, and reviewers spent their attention checking transcription fidelity rather than judgment. The shape that replaced it worked, so it is reused here.

What each task carries instead:

- **Anchors** — the real code to read first, whose conventions the work must match.
- **Interfaces named, never restated.** "Consumes `ReviewEntry` as declared in `review-store.ts`" cannot go stale; a copied-out type can, and did.
- **Named traps** — where a reviewer would predictably catch something, the task says so first, spending the finding before it costs a fix round.
- **Acceptance rows as test obligations** — a scenario plus the reason the assertion exists. Write the test, watch it fail, make it pass.
- **An acceptance-clause → task table per phase.** A phase is not ready to execute while a row is unowned. This is the structural fix for a criterion that once shipped missing because no task owned it.
- **A deviation footer.** Where the shipped code contradicts this plan, follow the code and say so.

## Global Constraints

- **Reviews saved by the current version must keep loading and opening**, in all four existing kinds. This is the hard constraint of the whole plan: the review store on disk predates it and belongs to the user.
- **The four wire kinds — `commit`, `range`, `branch`, `pr` — stay.** `isReviewTarget` silently rejects a persisted target whose kind it does not recognise, and stored entries fall back to the branch label format. A kind is now provenance inferred from a gesture, not a mode the user declared.
- **The derived base is always visible.** It is derived in three of five cases, and those are exactly the cases the user did not choose.
- **Both compare gestures must keep working.** `Compare with selected` and `Compare with '<current>'` call `review.setTarget` today, so the panel being deleted is also the graph's compare surface. Compare is review without the run: the same component serves both, and `review.compare` keeps its caller.
- **No provider vocabulary above `forge/bitbucket/`.**
- **A repository with no forge provider behaves exactly as today** — no section, no errors, no console noise.
- **Subagents never run the full suite or coverage.** They run the files they touch; the controller runs the suite, coverage and `svelte-check` once per phase.
- Three gates must pass: `tsc --noEmit` against `tsconfig.json` and `tsconfig.test.json`, and `svelte-check --tsconfig ./tsconfig.webview.json`.
- Verify with `npx vitest run --fileParallelism=false`; the suite is flaky under parallel execution because integration tests spawn real git.

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/webview/components/detail/ReviewDetail.svelte` | The detail panel's third mode: one review — target, derived base, changed files, progress, body, failure reason. Serves the diff-only state too, which is the same view without the AI body |
| `src/webview/components/sidebar/ReviewList.svelte` | The `REVIEWS` section body, following `PullRequestList.svelte`'s shape |

**Modified**

| File | Change |
|---|---|
| `src/webview/App.svelte` | Hosts the review mode and the `REVIEWS` section; owns review state and the `review.*` calls |
| `src/webview/components/sidebar/BranchSidebar.svelte` | Eighth section, following the seventh |
| `src/extension/controllers/review-method-handler.ts` | `worktree` kind; cache-hit disclosure; `localBothPresent` on the wire |
| `src/extension/services/review-target.ts` | `worktree` resolution; `REVIEW_TARGET_KINDS` |
| `src/extension/services/review-key.ts` | Diff-content hash in the id for `worktree` |
| `src/extension/services/git.service.ts` | Working-tree diff for review, if not already exposed in the shape needed |
| `src/extension/extension.ts` | Phase 5 only: remove the second webview host |
| `package.json` | Phase 5 only: remove the review view container and view |

**Deleted in phase 5**

`src/webview/ReviewApp.svelte`, `src/webview/review-main.ts`, and the `gitGraphProReview` container.

---

# Phase 1 — Read a review inside the graph

**Deliverable:** the `REVIEWS` sidebar section and the detail panel's review mode, both fed by the existing `review.*` methods. The old panel still exists and still works.
**Depends on:** nothing.
**Ships independently:** yes.

Nothing is removed in this phase. It adds a second way to read reviews, so if the plan stalls here nothing is lost.

## Task 1: The `REVIEWS` sidebar section

**Files:** create `src/webview/components/sidebar/ReviewList.svelte`; modify `BranchSidebar.svelte`, `src/webview/lib/sidebar-state.ts` if the section state needs it, `App.svelte`.

**Read first:** `PullRequestList.svelte` and how `BranchSidebar.svelte` mounts it — including the seventh section's expanded-state persistence, its count badge, and how the sidebar's search box filters it. The comment in `BranchSidebar.svelte` about expanded sections pushing the branch list off screen applies to an eighth section at least as much as it did to the seventh.

**Interfaces:**
- Consumes `review.list` and the `ReviewEntry` shape as declared in `src/extension/services/review-store.ts`. Do not restate that type.
- Produces `ReviewList.svelte` with a `select` event carrying the review's id.

**Requirements:**

1. An eighth collapsible section, **collapsed by default**, following the existing seven in markup, chevron, count badge and hover treatment.
2. Each row shows status, a target label, the provider and model, and a relative time.
3. **A failed review shows why it failed.** `ReviewEntry.error` is populated today and rendered nowhere; a failed row is a bare glyph and the reason is reachable only by opening the body, which nothing tells the user to do. At minimum the row surfaces it; the detail panel shows it in full.
4. A running review shows that it is running.
5. The sidebar's existing search box filters these rows too, on the target label.
6. Selecting a row emits `select`.
7. **A stored `pr` review in a repository whose forge provider is gone still lists and still opens.** The forge-availability gate on restore is a preserved behaviour, not a new one: the review already ran and its result is on disk, so losing the provider must degrade the row — no live pull request metadata — rather than error or hide it.

**Named trap:** status glyphs (`✓`, `✗`, `⧗`) carry meaning that colour and shape alone do not convey to a screen reader. The sibling `PullRequestList.svelte` solves this with `aria-label` on the glyph, which contributes to the row's accessible name; follow it rather than inventing a second approach.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | The section is collapsed on first render — the header exists, no rows are in the DOM until it is toggled |
| 2 | A failed entry's reason is reachable from the row without opening the review body |
| 3 | A running entry renders as running, not as neither-passed-nor-failed |
| 4 | Typing in the sidebar search narrows these rows |
| 5 | Selecting a row emits `select` with that review's id |
| 6 | A stored `pr` review lists and opens with no forge provider registered — it degrades, it does not error |

**Report deviations rather than silently reconciling.**

## Task 2: The detail panel's review mode

**Files:** create `src/webview/components/detail/ReviewDetail.svelte`; modify `App.svelte`, `src/extension/controllers/review-method-handler.ts` and its test.

**Three gaps the pre-flight scan found, with their rulings. Each is verified in the tree, not suspected:**

- **Nothing returns the review body.** `ReviewStore.readBody()` exists at `review-store.ts:125`, but no `review.*` method exposes it: `review.get` returns a `ReviewEntry`, which is metadata only, and `review.open` opens the file in an editor. *Ruling:* add a `review.body` method returning `store.readBody`, id-validated with `assertSafeReviewId` exactly as its neighbours are. Without it, "the body renders inline" is unbuildable.
- **`ReviewEntry` carries no file list.** *Ruling:* source it from `review.compare {kind, baseRef, headRef}` for git-based kinds and `forge.pr.files` for kind `pr`, mirroring the split `ReviewApp.svelte:422` already makes. Phase 4 Task 2 replaces that kind test with `localBothPresent`; until then this preserves existing behaviour rather than inventing a new proxy.
- **No push channel exists for progress.** The runner appends chunks to the body file and notifies nobody; the only broadcast in the review path is `review.target`, which is unrelated. *Ruling:* poll while the selected review's status is `running`, and stop when it settles.

**Read first:** `CommitDetail.svelte` and `PullRequestDetail.svelte` — the two modes this joins, for structure, naming and styling idiom — and how `App.svelte` switches the right-hand panel between them. Also `review-store.ts` for what a stored entry actually contains, and `review-runner.ts` for how a running review streams.

**Interfaces:**
- Consumes `review.get`, `review.open`, the new `review.body`, and `review.compare` / `forge.pr.files`; `ReviewEntry` as declared in `review-store.ts`.
- Produces `review.body` — id in, body text out, `''` when the file is missing.
- Produces `ReviewDetail.svelte` with events for re-running, opening as a file, and deleting.

**Requirements:**

1. A header naming what was reviewed, with the provider, model and when it ran.
2. **The resolved base and head are shown as text**, each with its short sha and its human name. This is the plan's load-bearing display requirement: the base is derived in three of five cases, and the worst outcome of removing the tabs is a review whose base the user cannot see.
3. The review body renders inline.
4. **The changed-file list renders, and its rows open a diff.** This is not decoration carried over from the old panel: `review.compare` feeds it, the compare gestures depend on it, and phase 2 points them here.
5. **A diff-only state** — base, head and files, no AI body, no progress. It is what compare opens and what a review shows before its run produces anything, so it is one state rather than two.
6. A failed review shows its reason here in full.
7. `Open as file` keeps the existing path to the review as markdown in an editor — a long review still needs search, folding and copy.
8. A running review shows progress as it streams rather than a static spinner, if the existing runner makes that available; if it does not, say so in the report rather than faking it.

**Named trap:** `PullRequestDetail.svelte` had three keyed `{#each}` blocks whose keys could collide on empty defaults, which throws at runtime rather than degrading. If you key anything here on a field the store can leave empty, do not repeat that.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | A stored review renders its body, provider, model and time |
| 2 | Base and head both render with sha and name — asserted for **all three** derived cases: a commit's parent, a pull request's target branch, and the working tree's `HEAD` |
| 3 | A failed review shows its reason without opening the file |
| 4 | `Open as file` still opens the markdown |
| 5 | Rendering with no review selected produces nothing, not a broken frame |
| 6 | The changed-file list renders and a row dispatches a diff-open |
| 7 | The diff-only state renders base, head and files with no AI body and no progress affordance |

## Task 3: Wire the two together

**Files:** modify `App.svelte`.

**Read first:** how `App.svelte` currently drives `PullRequestList` → `PullRequestDetail`, including how the right panel opens and what clears the selection. Every selection-changing path in that file must agree about the new state.

**Requirements:**

1. Selecting a review in the sidebar shows it in the detail panel.
2. The review selection clears where the other detail selections clear. **Find every such site** — an earlier phase of this project shipped one reset path that forgot a sibling, and it was invisible until someone traced all of them by hand.
3. Loading a review that fails to load leaves the panel in a state the user can leave — not an empty frame with no way out. A sibling component shipped exactly that dead end.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Selecting a review in the sidebar renders it in the detail panel |
| 2 | Selecting a commit afterwards replaces it, and vice versa |
| 3 | A failed `review.get` leaves a dismissible state, not a blank panel |

### Phase 1 acceptance-clause → task

| Spec clause | Task |
|---|---|
| `REVIEWS` section following the `PULL REQUESTS` idiom | 1 |
| Failed review shows its reason | 1, 2 |
| Detail panel's third mode | 2 |
| Derived base always visible | 2 |
| `Open as file` preserved | 2 |
| Diff-only state; changed-file list | 2 |
| Stored reviews still load and open | 1, 2, 3 |

---

# Phase 2 — Start a review from the graph

**Deliverable:** the five review gestures run reviews; the two compare gestures open the diff-only state; the provider settings become live.
**Depends on:** phase 1.
**Ships independently:** yes.

## Task 1: The three review gestures start running reviews

**Files:** modify `App.svelte`.

**Read first:** `App.svelte:2234` (`reviewCommit`), `:2237` (`reviewWithSelected`), `:862` (the pull request's `Review with AI`), and `review.setTarget` in the handler — it resolves, stores, focuses the old panel and broadcasts, and **it never starts a review**.

**This is a behaviour change, not a rerouting.** All three gestures navigate today: they fill the old panel's fields and the user presses Review. Making the gesture run the review is the point of the redesign — it removes the second step — but it is new behaviour to build. A task written as "point the existing call somewhere else" will underestimate it.

**Requirements:**

1. Each of the three **runs** a review and shows it in the detail panel's review mode, rather than filling in a form elsewhere.
2. The old panel continues to work in this phase. Both destinations may exist at once; phase 5 removes the old one.
3. The provider and model come from Task 3's resolution, not from a control on the surface. There is nowhere to put two dropdowns in a context menu item.
4. **With no AI provider available, each gesture explains what is missing** rather than presenting a control that does nothing. Today the review button is merely disabled with no explanation; a greyed context-menu item would be worse. Either the item is absent, or acting on it says what to install.

**Named trap:** this project has already shipped controls that looked live and did nothing — four buttons that dispatched into handlers that were never registered, and file rows that appeared clickable while inert. A menu item that starts nothing belongs to that family. Verify by what happens on click, not by what the code intends.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Each of the three gestures produces a review visible in the detail panel |
| 2 | A review actually runs from the gesture — no intermediate form, no second press — with no per-run provider control in the flow |
| 3 | With no provider available, each explains what is missing |
| 4 | The old panel still functions |

## Task 2: The two new gestures

**Files:** modify `App.svelte`; `git.service.ts` if the working-tree diff is not already available in the shape needed.

**Read first:** the branch context menu's `Compare with '<current>'` at `App.svelte:1677`/`:1728` — the new branch review item is its sibling and should read like one, and Task 3 changes where that neighbour points. And the working-tree row, and whatever `diffWorkingTree` already provides.

**Requirements:**

1. `Review '<branch>' vs '<current>'` on the branch context menu.
2. `Review uncommitted changes` on the working-tree row.
3. The branch item's base is the current branch, shown in the item's own label so the user reads the comparison before choosing it.
4. The working-tree gesture produces a `worktree` target — phase 3 gives that kind its resolution and its id. In this phase it may be wired to fail cleanly with a clear message; do not fake a result.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | The branch item names both ends in its label |
| 2 | The branch gesture produces a review of that branch against the current one |
| 3 | The working-tree gesture is present and, until phase 3, fails with a message rather than silently |

## Task 3: The compare gestures, the `ai` namespace, and where the provider comes from

**Files:** modify `App.svelte`, `src/extension/extension.ts`; tests for the host registration.

**Read first:** `App.svelte:2246` (`compareWithSelected`) and `:2509` (`compareBranch`), both of which call `review.setTarget`; `createSession` and `createReviewSession` in `extension.ts` — compare which namespaces each registers; and `ReviewApp.svelte:160-190`, where the provider is chosen today.

**Three findings drive this task. Each is verified, not suspected:**

- `reviewWithSelected` and `compareWithSelected` dispatch **identical code** — same params, same method. Two menu items, one behaviour. They stop being duplicates here: one runs a review, the other opens the diff-only state.
- The graph's host registers `repo`, `git`, `graph`, `ui`, `ping`, `review`, `forge` — **not `ai`**. `ai.providers` is registered only on the review host, so Task 1's no-provider message has no way to know anything until this is fixed.
- `gitGraphPro.aiReview.defaultProvider` and `defaultModel` are declared in `package.json` and **read by nothing**. The provider in force lives in the ui-state key `aiReview.provider`, written only by the dropdown being deleted.

**Requirements:**

1. Both compare gestures open the diff-only state in the detail panel. They run no review and consult no AI provider.
2. `ai` is registered on the graph's host, serving `ai.providers` as the review host does. Note `ai.providers` is in `UNBOUNDED_REQUEST_METHODS` in `message-bridge.ts` because it touches git and the filesystem — that must still hold from the graph.
3. **The two declared settings become the source of truth.** `defaultProvider` selects the provider and its default `auto` means the first available one — which is what the dropdown does today, so the behaviour is preserved while the setting stops being inert. `defaultModel` supplies the model.
4. The ui-state keys `aiReview.provider` and `aiReview.model` are no longer written. They are removed in phase 5 with the panel that reads them.

**Named trap:** `defaultProvider` is an enum — `auto`, `claude`, `codex`, `kiro`, `openai`, `deepseek`. A configured provider that is not currently available is not the same as no provider configured, and must not silently fall back as though the user had chosen nothing; say which one is unavailable.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Each compare gesture opens the diff-only state with the files list, and starts no review |
| 2 | `ai.providers` resolves from the graph's host |
| 3 | `defaultProvider: auto` selects the first available provider |
| 4 | An explicitly configured provider is used when available |
| 5 | A configured but unavailable provider reports *that* provider as unavailable, rather than behaving as if none was set |
| 6 | Starting a review writes neither `aiReview.provider` nor `aiReview.model` |

### Phase 2 acceptance-clause → task

| Spec clause | Task |
|---|---|
| Three review gestures change from navigate to run | 1 |
| No-provider case explained at every entry point | 1, 3 |
| Branch context-menu item | 2 |
| Working-tree context-menu item | 2 |
| Both compare gestures open the diff-only state | 3 |
| `ai` namespace available to the graph | 3 |
| `defaultProvider` / `defaultModel` become live | 3 |

---

# Phase 3 — The `worktree` kind

**Deliverable:** reviewing uncommitted changes, correctly cached.
**Depends on:** phase 2.
**Ships independently:** yes.

## Task 1: Resolution and identity

**Files:** modify `review-target.ts`, `review-key.ts`, `review-method-handler.ts`, `git.service.ts`.

**Read first:** `resolveReviewTarget` and its per-kind branches, `REVIEW_TARGET_KINDS` and `isReviewTarget`, and `buildReviewId` — including the comment explaining why only `'pr'` currently varies the id.

**Interfaces:**
- Produces: `ReviewTargetKind` gains `'worktree'`; `REVIEW_TARGET_KINDS` gains it too, or `isReviewTarget` will silently reject every persisted `worktree` target.

**Requirements:**

1. A `worktree` target resolves with base `HEAD` and head the working tree. It never rev-parses a head ref, because there is no commit to parse.
2. **The diff's content hash participates in the review id.** This is the requirement the whole phase turns on. `buildReviewId` is built from a sha pair; the working tree has no sha, so keyed on `HEAD` alone the sequence *review → edit a file → review again* returns the first result verbatim, with the user believing the model read the new code. The diff must therefore be computed before the id is known — which costs nothing, since reviewing needs the diff anyway.
3. The four existing kinds' ids are **unchanged, byte for byte**. Stored reviews are addressed by id; changing one orphans history.
4. An empty working tree — nothing to review — is a clear message, not an empty review or a crash.

**Named trap:** the derived base for `worktree` is `HEAD`, and the Global Constraints require a derived base to be visible. Make sure the detail panel from phase 1 renders it rather than showing a blank base for this kind.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Review the working tree, modify a file, review again — the second run **executes**, and the two ids differ. Watch this fail against an id built from `HEAD` alone; if it passes before the fix, the test is wrong |
| 2 | Ids for the four existing kinds are unchanged — assert against known values, so a future change to the id scheme fails loudly |
| 3 | A persisted `worktree` target survives a reload, which is what `REVIEW_TARGET_KINDS` gates |
| 4 | A clean working tree produces a message, not an empty review |
| 5 | The detail panel shows `HEAD` as the base |

### Phase 3 acceptance-clause → task

| Spec clause | Task |
|---|---|
| `worktree` kind resolves | 1 |
| Diff-content hash in the id | 1 |
| Existing kinds' ids unchanged | 1 |
| Derived base visible for `worktree` | 1 |

---

# Phase 4 — End the silences

**Deliverable:** a cache hit says so, errors belong to what failed, and pull request file rows are live when they can be.
**Depends on:** phase 1.
**Ships independently:** yes.

## Task 1: Cache-hit disclosure and attributed errors

**Files:** modify `review-method-handler.ts`, `App.svelte`, `ReviewDetail.svelte`, `ReviewList.svelte`.

**Read first:** `review.start`'s cached path, which already returns `cached: true` — a flag the webview reads nowhere.

**Requirements:**

1. **A cache hit is visible.** Starting a review on an identical target, provider and model opens the existing one; the review mode must say it is showing an existing result, when it was produced, and offer to re-run. Moving the trigger into a context menu makes this sharper than it was: a click that instantly yields a week-old review reads as an impossibly fast model, or one that ignored the changes.
2. **An error is rendered where it happened.** The old panel routed eight unrelated operations into one anonymous slot with no label, no dismissal, and clearing on only two of the eight successes — so a failed pull request fetch at startup sat on screen while the user worked elsewhere, attributed to nothing. A history-load failure belongs to the `REVIEWS` section; a review failure belongs to that review.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | A cache hit renders as an existing result, with its age and a way to re-run |
| 2 | Re-running after a cache hit executes a real run |
| 3 | A history-load failure appears in the section, and does not appear in the detail panel |
| 4 | An error from one operation does not survive into an unrelated success |

## Task 2: `localBothPresent` on the wire

**Files:** modify `review-method-handler.ts`, `App.svelte`, `PullRequestDetail.svelte`.

**Read first:** where `localBothPresent` is computed in `review-target.ts`, and the three places the review UI currently uses `mode === 'pr'` as a proxy for "the diff came from the API".

**Requirements:**

1. The bit travels with the target to the webview.
2. Pull request file rows open a diff whenever both commits are present locally, rather than being disabled because the target is a pull request. The proxy goes away.
3. When the commits are genuinely not local, the existing behaviour — reconstructing the file's diff from the pull request's own diff text — still applies. That path already exists in `App.svelte`; do not build a second one.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | A pull request whose commits are local has live file rows |
| 2 | A pull request whose commits are not local still opens a file's diff, reconstructed |
| 3 | No code path decides diff provenance from the target's kind |

### Phase 4 acceptance-clause → task

| Spec clause | Task |
|---|---|
| Cache hit disclosed | 1 |
| Errors attributed to their operation | 1 |
| Failure reasons visible | 1 |
| `localBothPresent` travels; proxy removed | 2 |

---

# Phase 5 — Remove the old panel

**Deliverable:** one webview host; the review panel is gone.
**Depends on:** phases 2 and 4.
**Ships independently:** yes.
**This is the only irreversible phase, and it runs last.**

## Task 1: Delete

**Files:** delete `src/webview/ReviewApp.svelte`, `src/webview/review-main.ts`; modify `extension.ts`, `package.json`, `vite.config.ts` or the build config if it names the review entry point.

**Read first:** `createReviewSession` in `extension.ts` and everything it registers, and the `gitGraphProReview` container and `gitGraphPro.reviews` view in `package.json`.

**Requirements:**

1. Remove the review view container, its view, its entry point, and `createReviewSession`.
2. Remove `review.setTarget` and its focus-and-broadcast machinery. With one panel there is no handoff between panels.
3. Remove the `review.mode` and `review.repo` ui-state keys. The second is written and never read — the defect that mislabelled reviews by repository.
4. **`review.saveTarget` and its write-behind semantics survive** for whatever still persists a target. It is easy to delete by association — it sits beside `review.setTarget`, which does go — but the two are unrelated: `setTarget` was a handoff between two panels, and `saveTarget` is persistence.
5. **All fourteen `review.*` methods are accounted for, one by one.** The count matters: the spec first named seven and read as complete, the handler had thirteen, and phase 1 adds `review.body` as the fourteenth. A method left with no caller is dead code someone will maintain without knowing it is dead; a method whose only caller was deleted is a feature silently removed. The expected disposition:

   - **Keep, with a caller in the graph:** `start`, `rerun`, `list`, `get`, `body`, `cancel`, `delete`, `open`, `compare`, `saveTarget`.
   - **Remove with what it served:** `setTarget` (the panel handoff), `getRepos` and `getCommits` (the pickers), `getTarget` (the panel's restore).

   Verify this against the code rather than trusting the list; report any method whose real disposition differs.
6. Remove the `aiReview.provider` and `aiReview.model` ui-state keys, replaced by the settings in phase 2 Task 3.

**Named trap:** removing the second host means every message namespace no longer needs registering twice. The tests that assert placement of those registrations were written for two hosts and had to be strengthened once already, because the first version counted occurrences file-wide and would have passed with both registrations in one factory. Those tests must be updated, not deleted — and their replacement must still be able to fail.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | The extension registers exactly one webview host |
| 2 | Each of the fourteen `review.*` methods is kept with a caller or removed with what it served |
| 2b | `review.compare` still has a caller — both compare gestures work with the old panel gone |
| 3 | Reviews stored before this plan began still load and open |
| 4 | The full suite passes with the second host gone |
| 5 | `package.json` no longer contributes a review view, and nothing references the deleted entry point |

### Phase 5 acceptance-clause → task

| Spec clause | Task |
|---|---|
| `ReviewApp.svelte`, `review-main.ts`, container removed | 1 |
| `createReviewSession` removed | 1 |
| `review.setTarget` removed, `review.saveTarget` preserved | 1 |
| Dead ui-state keys removed, including `aiReview.*` | 1 |
| Fourteen methods each accounted for | 1 |
| Stored reviews still load | 1 |

---

# Roadmap

| Phase | Deliverable | Depends on | Ships alone | Acceptance |
|---|---|---|---|---|
| **1** | Review mode in the detail panel; `REVIEWS` sidebar section | nothing | Yes | A stored review is selectable in `REVIEWS` and readable in the detail panel, with its derived base and, when failed, its reason |
| **2** | Five gestures run reviews; two compare gestures open the diff-only state; the provider settings become live | 1 | Yes | Each review gesture runs a review with no second press; both compare gestures run nothing; `defaultProvider` selects the provider; with no provider, each review gesture explains what is missing |
| **3** | The `worktree` kind | 2 | Yes | Review, edit, review again executes a second time with a different id; the four existing kinds' ids are unchanged |
| **4** | Cache-hit disclosure, attributed errors, `localBothPresent` | 1 | Yes | A cache hit is visibly a cache hit; a pull request file row opens a diff when both commits are local |
| **5** | The old panel removed | 2, 4 | Yes | One webview host; each of the fourteen `review.*` methods kept with a caller or removed with what it served; both compare gestures still work; reviews stored before this plan still load |

Phase 1 adds a second way to read reviews while the old panel still works, so a stall costs nothing. Phase 4 depends only on phase 1 and can run beside 2 and 3 if that suits. Phase 5 is the only step that cannot be undone, and it runs after every gesture it would strand has a replacement.

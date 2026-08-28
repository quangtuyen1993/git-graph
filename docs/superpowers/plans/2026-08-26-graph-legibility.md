# Graph & Sidebar Legibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to execute this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the graph and sidebar readable at a glance — folder groups no longer read quieter than the branches inside them, empty commits recede, a selected row stays legible in every theme, and a missing graph row tells the user the true reason instead of a guess.

**Spec:** `docs/superpowers/specs/2026-08-26-graph-legibility-design.md`

## How this plan is shaped

Tasks state **requirements, not implementations**. No function bodies, no test bodies — the implementer writes both.

This is a deliberate departure from the writing-plans default, and it is the same shape as `docs/superpowers/plans/2026-08-28-review-in-graph.md`. That plan's own header records why the shape exists: a predecessor plan that wrote out ~3,300 lines of complete code became the largest single source of defects in its execution — implementers transcribed rather than built, and reviewers spent their attention checking transcription fidelity instead of judgment. The shape that replaced it worked there, so it is reused here.

What each task carries instead:

- **Anchors** — the real code to read first, cited `file:line`, whose conventions the work must match.
- **Interfaces named, never restated.** "Consumes `ShortStat` as declared in `git.types.ts`" cannot go stale; a copied-out type can.
- **Named traps** — where a reviewer would predictably catch something, the task says so first, spending the finding before it costs a fix round.
- **Acceptance rows as test obligations** — a scenario plus the reason the assertion exists.
- **An acceptance-clause → task table per phase.** A phase is not ready to execute while a row is unowned. This is the structural fix for a criterion that once shipped missing because no task owned it.

One addition this plan carries from the spec itself, not from the review-in-graph plan: **two tasks ship with no automated test at all** (Phase 1 Task 2, Phase 3 Task 2's `opacity` value). That is not an omission — jsdom computes no colours and no layout, so a structural assertion like "this rule contains no `color`" would test the implementation rather than the behaviour, and would break on harmless edits. Each such task says so explicitly and names the manual check that replaces the test, rather than leaving the gap unexplained.

**Deviations:** where the shipped code contradicts this plan, follow the code and say so in the execution report rather than silently reconciling.

## Global Constraints

Copied verbatim from the spec, plus the verification constraints below that bind every task.

From the spec:

- Svelte 4 (`^4.2.0`): `export let` props, assignment-based reactivity. No runes.
- `GitCLI.exec()` resolves to a **`string`**, never `{ stdout }`.
- Assert on the **argv array** passed to `exec`, not on parsed output, when pinning git flags.
- Coverage `include` already covers `src/extension/services/git.service.ts`,
  `src/extension/controllers/graph-method-handler.ts`, and `src/webview/lib/**/*.ts`.
  New logic in those places **requires** tests.
- Coverage thresholds enforced: statements 80, lines 80, functions 80, branches 70.
- Do not add new `.svelte` files to the coverage `include` list.
- `npm run check` is currently red on this repository for a pre-existing reason: real-git
  integration tests carry a 5s default `testTimeout` but take 90–120s under v8 coverage
  instrumentation. Every such failure is a timeout, never an assertion. Run the test files
  you touch plus `npm run typecheck`; do not gate work on the full suite.
- Do not change `ROW_HEIGHT` (`src/webview/lib/virtual-scroll.ts`).
- **Line numbers in this spec drift.** Other workstreams are actively editing the same files —
  `App.svelte` gained 1300 lines between this spec's first draft and its final one. Every
  location below is therefore given as a CSS selector or a symbol name, with a line number only
  as a hint. Locate the selector, not the line. All four premises were re-verified against
  `main` at `e8ddf5e`. The amendment's corrections and additions (R1–R5 in the review) were
  re-verified separately, against `b27187b`.

Binding on every task in this plan, in addition:

- Verify with `npx vitest run --fileParallelism=false`; the suite is flaky under parallel
  execution because integration tests spawn real git.
- Three type gates must pass: `tsc --noEmit` against `tsconfig.json` and against
  `tsconfig.test.json`, and `svelte-check --tsconfig ./tsconfig.webview.json`.
- Coverage thresholds are 80/70/80/80 and must never be lowered to make code pass.
- Subagents run only the test files they touch, never the full suite; the controller runs the
  suite once per phase.
- This spec's work runs wholly before or wholly after phase 2 of
  `docs/superpowers/plans/2026-08-28-review-in-graph.md`, never interleaved — both edit
  `App.svelte` in the same neighbourhoods. The collision is textual, not semantic.

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/webview/lib/missing-row.ts` | Pure helper: classifies why `graph.getRow` returned `null` for a hash, so the three call sites that read that `null` cannot drift apart |

**Modified**

| File | Change |
|---|---|
| `src/webview/components/sidebar/BranchTreeList.svelte` | Part 1: two colour values |
| `src/webview/App.svelte` | Parts 2, 3, 4: webview `GraphNode` mirror type gains `filesChanged`/`additions`/`deletions`; `graph.getStats` issued after each rendered window; dim class + CSS; two contrast-rule edits; three missing-row call sites rewired to the shared helper |
| `src/extension/services/git.service.ts` | Part 2: add `shortStatsFor`, delete `getShortStats`, share the stat-line parser |
| `src/extension/controllers/graph-method-handler.ts` | Part 2: drop the build-time stats call, add the hash-keyed cache and the `graph.getStats` method |
| `src/extension/services/graph.service.ts` | Part 2: stat defaults `0` → `null` in `createLayout` |
| `src/extension/types/graph.types.ts` | Part 2: widen `GraphNode.filesChanged`/`.additions`/`.deletions` from `number` to `number \| null` |
| `src/extension/types/git.types.ts` | Part 2: add the `ShortStat` type |
| `tests/coverage-closure.test.ts`, `tests/extension/repository-session.test.ts`, `tests/extension/graph-method-handler.test.ts` | Part 2: drop `getShortStats` references |

**Removed**

`GitService.getShortStats` (a method, not a file) — deleted by Phase 2 Task 1, replaced by `shortStatsFor`.

---

# Phase 1 — Read fixes: sidebar colour, contrast, honest messages

**Deliverable:** Parts 1, 3 and 4 — sidebar folder groups match branch-name brightness; a selected or branch-focused row keeps legible text in every theme; each of the three `graph.getRow` null sites names the correct cause.
**Depends on:** nothing.
**Ships independently:** yes.

None of these three parts touch the data model. Each ships or reverts on its own.

## Task 1: Sidebar folder group colours (Part 1)

**Files:** modify `src/webview/components/sidebar/BranchTreeList.svelte`.

**Read first:** `.branch-group` (`BranchTreeList.svelte:207-212`), `.group-icon`
(`BranchTreeList.svelte:249-257`), `.branch-name` (`BranchTreeList.svelte:299-305`), and
`.branch-item.selected` (`BranchTreeList.svelte:272-275`) as the existing pattern for a themed
colour token with its hex fallback.

**Interfaces:** none — CSS values only, no new symbol.

**Requirements:**

1. `.branch-group`'s `color` changes from `var(--vscode-descriptionForeground, #767676)` to
   `var(--vscode-foreground, #cccccc)`.
2. `.group-icon`'s `color` changes the same way, in the same edit.
3. `.group-name` continues to set no colour of its own, inheriting from `.branch-group` as today.
4. Untouched: the section headers (`.section-header` at `BranchSidebar.svelte:855-864`, whose
   labels are `<span class="section-title">` at e.g. `BranchSidebar.svelte:453`) — there is no
   `.section-title` rule to leave alone, the label inherits `--vscode-sideBarSectionHeader-foreground`
   from `.section-header`, a different token from `.branch-group`'s; `.branch-item.remote .branch-name`
   (`BranchSidebar.svelte:1000`), which stays `descriptionForeground` deliberately; and `.chevron`'s
   `opacity: 0.8`.

**Named trap:** the icon and the text must move together in the same edit. A folder row half
bright — name updated, icon still grey — reads as a rendering bug rather than a style choice,
which is a worse result than leaving both dim.

**No automated test.** This is a colour-token swap with no logic; jsdom does not compute colours.
Verify by eye: open the sidebar in a light theme and a dark theme and confirm a folder row's name
and icon read at the same brightness as a branch row's name.

**Acceptance:**

| # | Verification obligation |
|---|---|
| 1 | `.branch-group` and `.group-icon` render at `--vscode-foreground` — by eye, both themes, a folder row's brightness matches a branch row's |
| 2 | Section headers, `.branch-item.remote .branch-name`, and `.chevron`'s opacity are unchanged — confirmed by diff review, not by rendering |

## Task 2: Light-theme contrast (Part 3)

**Files:** modify `src/webview/App.svelte` (CSS only).

**Read first:** `.commit-row.selected`, split across two adjacent rules
(`App.svelte:3674-3676` for `--lane-alpha`, `3680-3683` for `color` and the accent-bar
`box-shadow`); `.commit-row.branch-focused` (`App.svelte:3699-3709`), the
`@keyframes branch-focus-flash` it references (`3711-3719`), and the
`@media (prefers-reduced-motion: reduce)` override that disables the animation
(`3721-3725`); `.branch-item.selected` in `BranchTreeList.svelte:272-275` as the correctly-paired
counter-example the spec cites — it sets `background` and `color` from the same theme token pair,
which is why it is not a bug.

**Interfaces:** none.

**Requirements:**

1. `.commit-row.selected` (`App.svelte:3680-3683`): delete the
   `color: var(--vscode-list-activeSelectionForeground, #ffffff);` line. Text falls back to
   inherited `--vscode-foreground`. `--lane-alpha: 0.22` (3674-3676) and
   `box-shadow: inset 2px 0 0 0 rgb(var(--lane-rgb))` stay.
2. `.commit-row.branch-focused` (`App.svelte:3699-3709`): delete `color: #ffffff;` and
   `filter: brightness(1.45) saturate(1.35);`. Lower `--lane-alpha` from `0.72` to `0.35`.
   `z-index: 3`, the three `box-shadow` layers, and `animation: branch-focus-flash 300ms ease-out`
   are unchanged.
3. `@keyframes branch-focus-flash` and the reduced-motion override are untouched — neither
   references the two dropped properties.
4. No rule in this file gains a `color` or `filter` override on a background whose alpha the
   rule itself sets, now or as a result of this change — the general principle the two edits
   above enact, worth checking by eye across the diff rather than assuming it from the two
   sites alone.

**Named trap:** `filter: brightness()`/`saturate()` alters the rendered text exactly as an
overridden `color` does, through a different property. Dropping `color` while leaving the
`filter` line in `.branch-focused` would still fail the review this fix exists to pass.

**No automated test.** jsdom performs no layout and computes no colours, so contrast cannot be
asserted; a structural assertion that a rule "contains no `color`" tests the implementation
rather than the behaviour and breaks on harmless edits. Verify by eye: select a row in a light
theme and a dark theme, and separately trigger `.branch-focused` (click a branch in the sidebar)
in both. Expect the lane colours in the accent bar and glow to read less vivid without the
`filter` — that is the intended reduction in emphasis, the same direction as the alpha drop from
0.72 to 0.35, not a regression to chase.

**Acceptance:**

| # | Verification obligation |
|---|---|
| 1 | `.commit-row.selected` sets no `color` — by eye, both themes, selected-row text reads legibly against the tinted background |
| 2 | `.commit-row.branch-focused` sets no `color` and no `filter` — by eye, both themes, text stays legible against the tinted, box-shadowed row |
| 3 | The three box-shadows and the flash animation are byte-for-byte unchanged — confirmed by diff review, since only `color`, `filter`, and `--lane-alpha`'s value should move |

## Task 3: Honest missing-row messages (Part 4)

**Files:** create `src/webview/lib/missing-row.ts`; modify `App.svelte` at its three
`graph.getRow`-null call sites — PR jump (`scrollToPullRequestHead`, `App.svelte:725-764`, the
`result.row === null` branch at `753-758`), commit search (`revealSearchMatch`,
`App.svelte:2287-` onward, the `result.row === null` branch at `2298-2300`), and sidebar branch
jump (`handleBranchSelect`, `App.svelte:2221-2244`, the silent `return` at `2231`).

**Read first:** `src/webview/lib/commit-search.ts` as the shape for a small pure helper with no
Svelte or webview dependency, and its sibling test `tests/webview/commit-search.test.ts`, for how
a helper this size is tested directly; `showTransientMessage`'s signature
(`App.svelte:207`, `(message: string, action: TransientMessageAction | null = null)`, the
interface at `App.svelte:182`); `scrollToPullRequestHead`'s doc comment (`App.svelte:712-724`),
which already reasons through a related but different guess — not-yet-loaded versus
not-fetched — that this task's `filtered`/`absent` split sits beside, one layer further in;
`selectedBranchFilters` (`App.svelte:398`, `string[]`), the state every call site reads to know
whether a filter is active.

**Interfaces:**

- Produces: `export type MissingRowReason = 'filtered' | 'absent';` and
  `export function missingRowReason(opts: { branchFilterActive: boolean }): MissingRowReason;`
  in `src/webview/lib/missing-row.ts`, matching the spec's Part 4 signature exactly.
- Consumes: `selectedBranchFilters` at each call site as the source of `branchFilterActive`
  (non-empty means a filter is active).

**Requirements:**

1. `missingRowReason` returns `'filtered'` when `branchFilterActive` is true, `'absent'`
   otherwise — no other input, because a hash reaching any of these three call sites has already
   ruled out every other cause.
2. PR jump (`App.svelte:753-758`): on `'filtered'`, the message reads "This pull request's head
   commit is outside the current branch filter." with a **Clear filter** action that resets
   `selectedBranchFilters` and re-triggers the lookup. On `'absent'`, today's message
   ("...the branch may not be fetched locally.") and its **Fetch** action are unchanged.
3. Commit search (`App.svelte:2298-2300`): switches to the helper. The message text is unchanged
   from today's — it is already right, because a search hit is sourced from `git.searchCommits`
   (`App.svelte:2272`), so a hash `runCommitSearch` finds cannot be `'absent'` by construction;
   `'filtered'` is the only reason reachable here. This is also why `missingRowReason`'s single
   `branchFilterActive` input suffices across all three sites: no site needs more than that one
   fact to pick the right reason.
4. Sidebar branch jump (`App.svelte:2231`): stops returning silently on `result.row === null`.
   Shows the `'filtered'` message via `showTransientMessage` — a sidebar branch's hash is always
   locally present by construction (the branch list is sourced from local refs), so `'absent'` is
   unreachable here too, but the call still goes through the shared helper so the three sites
   cannot drift apart again, which is the defect this task closes.

**Named trap:** `missingRowReason` must stay a pure function with no closure over
`selectedBranchFilters`, `bridge`, or `showTransientMessage` — those differ per call site (the
PR jump's Fetch action re-fetches and re-scrolls; commit search offers no action at all).
Pushing them into the helper would make it untestable for no gain.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | `missingRowReason({ branchFilterActive: true })` returns `'filtered'`; `false` returns `'absent'` — both branches, asserted directly against the pure function |
| 2 | PR jump with a filter active shows the filtered message and offers **Clear filter**, not Fetch |
| 3 | PR jump with no filter active keeps today's message and **Fetch** action, unchanged |
| 4 | Commit search's message text is unchanged and is now sourced from the shared helper, not a literal |
| 5 | Sidebar branch jump with a filter active shows a message instead of returning with no visible effect |

### Phase 1 acceptance-clause → task

| Spec clause | Task |
|---|---|
| `.branch-group`/`.group-icon` colour matches `.branch-name` | 1 |
| Section headers, remote branch names, `.chevron` opacity stay unchanged | 1 |
| `.commit-row.selected` drops `color` | 2 |
| `.commit-row.branch-focused` drops `color` and `filter`, lowers `--lane-alpha` to `0.35` | 2 |
| The rule stated so it does not regrow: no `color`/`filter` override on a self-tinted background | 2 |
| PR jump names the correct cause and offers Fetch only when it would help | 3 |
| Commit search's two messages, already right, now sourced from the shared helper | 3 |
| Sidebar branch jump stops failing silently | 3 |

---

# Phase 2 — Part 2's data layer

**Deliverable:** the build-time `getShortStats` call and method are gone; `shortStatsFor(hashes)`
exists; a hash-keyed cache with negative caching backs a new `graph.getStats` method; stat
defaults are `null`.
**Depends on:** nothing.
**Ships independently:** yes — no visible change; the value is a faster, correct graph build.

## Task 1: `shortStatsFor`, replacing `getShortStats`

**Files:** modify `src/extension/services/git.service.ts`, `src/extension/types/git.types.ts`;
modify `tests/coverage-closure.test.ts` (the `getShortStats` case at line 83),
`tests/extension/repository-session.test.ts` (the `getShortStats` stub at line 33),
`tests/extension/graph-method-handler.test.ts` (the `getShortStats` stub at line 41).

**Read first:** `getShortStats` itself (`git.service.ts:494-535`) for the stat-line parsing to
preserve — the 40-hex hash-line match and the "N files changed, N insertions(+), N
deletions(-)" line match, both tolerant of an omitted insertions or deletions clause;
`searchCommits` and its test `tests/extension/git-search-commits.test.ts` as the shape for a
focused, single-purpose `GitService` test file and the `serviceWith()` seam it uses to stub
`GitCLI.exec` directly on the instance; `GraphGitService`
(`graph-method-handler.ts:6-9`, the `Pick<GitService, …>` alias `graph.build` depends on).

**Interfaces:**

- Produces: `export interface ShortStat { filesChanged: number; additions: number; deletions: number }`
  in `src/extension/types/git.types.ts`, alongside `Commit`, `FileChange` and the file's other
  git-domain types; and `public async shortStatsFor(hashes: string[]): Promise<Map<string, ShortStat>>`
  on `GitService`.
- Removes: `GitService.getShortStats`.

**Requirements:**

1. `shortStatsFor(hashes)` runs `git log --no-walk --shortstat --format=%H <hash>…` — argv
   `['log', '--no-walk', '--shortstat', '--format=%H', ...hashes]`, hashes appended in the order
   given.
2. An empty `hashes` array returns an empty `Map` without calling `exec`.
3. The stat-line parser is the one `getShortStats` used, extracted so there is one
   implementation, not a copy — `shortStatsFor` and the deleted method's logic must not diverge.
4. `getShortStats` and its JSDoc are deleted from `git.service.ts`.
5. `GraphGitService`'s `Pick<GitService, …>` union drops `'getShortStats'` (Task 2 of this phase
   adds `'shortStatsFor'` in its place).
6. The three listed test files no longer reference `getShortStats` — stubs and assertions
   updated or removed so nothing points at a method that no longer exists.

**Named trap:** `git log --no-walk --shortstat` prints no stat line for a merge commit — the
spec's own table documents this. `shortStatsFor` must not synthesize a
`{ filesChanged: 0, ... }` entry for a hash git said nothing about; a hash with no stat line is
simply absent from the returned `Map`. Deciding what an absent entry *means* belongs to Task 2's
cache, not here — doing it in this method would collapse the "genuinely empty" and "merge" cases
that the rest of Part 2 exists to keep apart.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | `shortStatsFor(['aa'.repeat(20), 'bb'.repeat(20)])` calls `exec` with `['log', '--no-walk', '--shortstat', '--format=%H', 'aa'.repeat(20), 'bb'.repeat(20)]` — argv assertion, not parsed-output assertion |
| 2 | `shortStatsFor([])` returns an empty map and never calls `exec` |
| 3 | A shortstat line missing an insertions or deletions clause parses the present number(s) and defaults the absent one to `0` |
| 4 | A hash git returned no stat line for is absent from the returned map, not present with zeroed stats |
| 5 | `npm run typecheck` passes with `getShortStats` gone from `GitService` and the three listed test files updated |

## Task 2: The hash-keyed cache, `graph.getStats`, and null stat defaults

**Files:** modify `src/extension/controllers/graph-method-handler.ts`,
`src/extension/services/graph.service.ts`, `src/extension/types/graph.types.ts`.

**Read first:** `build()` (`graph-method-handler.ts:65-99`), specifically the `try`/`catch`
(`77-89`) around the build-time stats call being deleted, and its comment explaining stats are
optional and must not fail the build — a property this task must preserve while moving the work
elsewhere; `assertCurrent` (`graph-method-handler.ts:100-115`) for the repo-identity check
(`current !== gitService || current?.getRepoPath() !== repoPath`) this cache reuses;
`GraphMethodHandler.invalidate()` (`graph-method-handler.ts:20-23`) and **both** of its
callers — `repo.switch` in `repository-session.ts:96` (an actual repository change, called
before `this.gitService` is reassigned at line 98) and the git filesystem watcher's
500ms-debounced `session.invalidate()` in `extension.ts:338-344`, which fires on any
`HEAD`/`refs/**`/`index` change — i.e. on an ordinary commit or checkout, not only a repository
switch; `GraphService.createLayout`'s node construction (`graph.service.ts:97-113`, the defaults
at `110-112`); `GraphNode` in `graph.types.ts:1-16` (`filesChanged`/`additions`/`deletions`
currently typed `number`, comments at `13-15`); `GraphService.getWindow`
(`graph.service.ts:162-188`) and `GraphMethodHandler`'s `graph.getWindow` case
(`graph-method-handler.ts:35-42`) to confirm both stay fully synchronous.

**Interfaces:**

- Consumes: `GitService.shortStatsFor` and `ShortStat`, as Task 1 declares them. Do not restate
  the type.
- Produces: a `graph.getStats` case in `GraphMethodHandler.handle`, request
  `{ hashes: string[] }`, response a JSON-safe map from hash to `ShortStat | null` (not a `Map`
  instance — it must survive the webview's `postMessage` boundary).
- `GraphNode.filesChanged`, `.additions`, `.deletions` (`graph.types.ts`) widen from `number` to
  `number | null`.

**Requirements:**

1. `build()` no longer calls `getShortStats` or `shortStatsFor`; the `try`/`catch` at
   `77-89` is deleted with it. `graph.build` issues no shortstat git call at all.
2. `GraphService.createLayout` (`graph.service.ts:110-112`) defaults `filesChanged`,
   `additions`, `deletions` to `null`, not `0`.
3. A hash-keyed cache — `Map<string, ShortStat | null>` — lives on `GraphMethodHandler`,
   populated only by `graph.getStats` calls; `graph.build` never touches it.
4. **The cache is cleared by a repository-identity check, performed when the cache is read or
   written, not by every `invalidate()` call.** `invalidate()` fires on ordinary ref/commit
   changes (the file-watcher path) far more often than on a repository switch; a commit's
   shortstat is immutable regardless of what else changed on the branch, so wiping the cache
   inside `invalidate()` unconditionally would defeat almost all of its value. Track the
   `repoPath`/`gitService` identity the cache was built against — the same two values
   `assertCurrent` compares — and clear the map when a `graph.getStats` call observes that
   identity has changed since the cache was last populated.
5. `graph.getStats({ hashes })`: hashes already in the cache cost no git call. Hashes not in the
   cache are covered by exactly one `shortStatsFor` call for that group. The response covers
   every requested hash — cached and freshly fetched together. Every requested hash is cached
   afterward, including ones `shortStatsFor` returned no entry for (cached as `null`), so a merge
   is fetched once and never requested again.
6. `graph.getWindow` (`graph.service.ts:162-188`) is unchanged by this task — still returns
   immediately from the in-memory layout, stats at whatever the layout currently holds.
7. A `shortStatsFor` rejection inside `graph.getStats` must not populate the cache with `null`
   for the hashes it was asked about — a failed hash stays absent from the cache so a later call
   retries it, rather than being cached as `null`, which would otherwise mean "known empty or
   merge" forever.

**Named trap:** clearing the cache unconditionally inside `invalidate()` is the implementation
that looks obviously correct and is not. `invalidate()` runs on every ordinary commit or
checkout via the 500ms-debounced watcher (`extension.ts:338-344`), not only on `repo.switch`
(`repository-session.ts:96`); doing the clear there would re-fetch a window's worth of shortstat
after every git operation in the repository, not only when the repository itself changes. The
identity check belongs at the point the cache is read or written — the same discipline
`assertCurrent` already uses at the point a build result is published, rather than trying to
catch every event that could have invalidated it.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | `graph.build` calls `log`/`snapshotLogOptions` on the `GraphGitService` seam but never `shortStatsFor` |
| 2 | `graph.getWindow` returns nodes with `filesChanged`/`additions`/`deletions` at `null` and issues no git call itself |
| 3 | Two `graph.getStats` calls for the same hash set issue exactly one `shortStatsFor` call |
| 4 | A `graph.getStats` call mixing already-cached and new hashes fetches only the new ones |
| 5 | A hash `shortStatsFor` returns no entry for (a merge) is cached as `null` after one call and is never requested again on a later `graph.getStats` for the same hash |
| 6 | A `repo.switch` invalidates the cache — a hash cached under the old repository is re-fetched after the switch |
| 7 | An ordinary `invalidate()` that is not a repo switch (the file-watcher path) leaves a previously cached hash cached — no `shortStatsFor` call for it on the next `graph.getStats` |

### Phase 2 acceptance-clause → task

| Spec clause | Task |
|---|---|
| Build-time `getShortStats` call and method removed | 1, 2 |
| `shortStatsFor(hashes)` added, hash-addressed, shares the parser | 1 |
| Empty input short-circuits with no git call | 1 |
| Three stale test references updated | 1 |
| Hash-keyed cache, cleared only on repository-identity change | 2 |
| Cache holds negative entries so a merge is requested once | 2 |
| `graph.getWindow` stays synchronous, stats left `null` | 2 |
| `graph.getStats` method: cached and freshly fetched hashes returned together | 2 |
| Stat defaults `0` → `null` in `createLayout` | 2 |

---

# Phase 3 — Part 2's presentation

**Deliverable:** the webview requests stats for what it renders, and the dim class fades a
genuinely empty commit without touching a merge, an unresolved row, or whatever the user is
currently looking at.
**Depends on:** phase 2.
**Ships independently:** yes.

## Task 1: Wire `graph.getStats` into the webview and carry stats on rendered rows

**Files:** modify `App.svelte`.

**Read first:** the webview's own `GraphNode`/`GraphWindow` interfaces (`App.svelte:62-93`) —
these are hand-maintained mirrors of the extension-side types in `graph.types.ts`, not an
import, so Phase 2's type change does not reach the webview on its own; the two places a window
response lands — `graphWindow = nextWindow;` inside `refreshGraph` (`App.svelte:1741`) and the
`apply` callback inside `updateGraphWindow`'s call to `graphWindowRequestCoordinator.handle`
(`App.svelte:1786-1789`); the commit-row `{#each graphWindow.nodes as node (node.hash)}` block
(`App.svelte:3156-3190`) and its existing `class:selected`/`class:branch-focused`/
`class:search-match` bindings (`3160-3163`), which any future dim-class logic (Task 2) must read
alongside.

**Interfaces:**

- Consumes: `graph.getStats` and its `hash → ShortStat | null` response shape, as Phase 2 Task 2
  declares it. Do not restate the shape.

**Requirements:**

1. The webview's `GraphNode` interface (`App.svelte:62-74`) gains `filesChanged: number | null`,
   `additions: number | null`, `deletions: number | null`, matching what `graph.getWindow` now
   sends.
2. After a window lands — at both `App.svelte:1741` and inside the `apply` callback around
   `1786-1789` — the webview calls `graph.getStats` with the hashes of the nodes just rendered,
   and attaches the result to those nodes once it resolves.
3. A hash the webview has already received stats for (successfully) is not requested again on a
   later window that includes it — scrolling back over seen rows costs nothing, on top of the
   host-side cache from Phase 2 already preventing the git call.
4. A rejected or slow `graph.getStats` call leaves the affected nodes' stats at `null` — no
   retry loop, no error surfaced to the user, nothing beyond the row staying at its default.

**Named trap:** Svelte 4 uses assignment-based reactivity (Global Constraints). Writing
`node.filesChanged = …` onto an object already sitting inside the assigned `graphWindow.nodes`
array will not by itself cause the row to re-render — the update needs an assignment Svelte's
compiler can see (replacing the node, or reassigning `graphWindow`), not an in-place field
mutation on an object the framework has already rendered from.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | After a window renders, `graph.getStats` is called with that window's hashes |
| 2 | Once `graph.getStats` resolves, the corresponding rows' `filesChanged`/`additions`/`deletions` reflect the response in the rendered DOM — proving the update is actually reactive, not just an unread variable |
| 3 | Re-scrolling to a previously seen, already-resolved hash issues no duplicate `graph.getStats` request for it |
| 4 | A rejected `graph.getStats` call leaves the graph rendered and undimmed — nothing thrown reaches the user |

## Task 2: The dim class and CSS rule

**Files:** modify `App.svelte`.

**Read first:** the commit-row markup and its class bindings (`App.svelte:3157-3164`, the same
block Task 1 touches for stats); `.commit-row .col-graph` / `.col-message` / `.col-date` /
`.col-sha` / `.col-author` (`App.svelte:3727-3776`), the four column rules the dim opacity
applies to (or, for `.col-graph`, deliberately does not); `.commit-row.selected` /
`.branch-focused` / `.search-match` (`App.svelte:3670-3709`, edited by Phase 1 Task 2) — the dim
class must defer to all three.

**Interfaces:** none new — consumes `filesChanged` (Task 1 of this phase) and `parents` (already
present on `GraphNode`) on each rendered node.

**Requirements:**

1. A row's dim class applies when `node.filesChanged === 0 && node.parents.length <= 1`. `null`
   never dims — unknown is not empty. `parents.length > 1` never dims regardless of
   `filesChanged` — merges stay full strength, since this reads the commit's own parent count and
   is correct regardless of what git reported for its stats. A root commit
   (`parents.length === 0`) dims like any ordinary single-parent commit if it changed no files.
2. The class is suppressed on a row that is `selected`, `search-match`, or `branch-focused` —
   whatever the user is currently looking at is never dimmed, regardless of its stats.
3. CSS applies `opacity: 0.55` to `.col-message`, `.col-date`, `.col-sha`, `.col-author` only.
   `.col-graph` is explicitly excluded — the lane and its edges stay full strength so the reader
   can follow topology through an empty commit.
4. The dim rule uses `opacity`, not a `color` override, on these columns — consistent with the
   rule Phase 1 Task 2 states, and so it does not fight the specificity of the selection and
   find-match rules.

**Named trap:** the dim condition needs both `filesChanged` (just wired by Task 1) and `parents`
(already present), and must be suppressed by the row's *other* state classes — it cannot be a
static CSS selector alone. It needs a Svelte `class:` binding computed per node, the same way
`class:selected` already is, not a plain CSS rule keyed off a data attribute nobody sets.

**No automated test for the `opacity: 0.55` value itself**, per the spec: jsdom performs no
layout and computes no colours, so no test can verify a dimmed row stays legible against any
given theme's row background — the same limitation Phase 1 Task 2 states for its own contrast
claims, applying here too. `0.55` is a chosen number, not a measured one. Verify by eye: open the
graph in a light theme and a dark theme, dim a genuinely empty commit, and confirm its message
text is still readable in both.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | A non-merge row with `filesChanged: 0` renders with the dim class |
| 2 | A merge (`parents.length > 1`) with `filesChanged: 0` does not render with the dim class |
| 3 | A row with `filesChanged: null` does not render with the dim class |
| 4 | A selected row with `filesChanged: 0` does not render with the dim class |
| 5 | `.col-graph` is absent from the dimmed-columns selector list — confirmed by reading the CSS rule, since jsdom cannot assert computed opacity |
| 6 (manual) | A dimmed row's message text is legible at `opacity: 0.55` in a light theme and a dark theme |

### Phase 3 acceptance-clause → task

| Spec clause | Task |
|---|---|
| Webview requests stats for hashes it has just rendered — pull, not broadcast | 1 |
| A rejected/slow request leaves rows undimmed, nothing surfaced to the user | 1 |
| Dim rule: `filesChanged === 0 && parents.length <= 1` | 2 |
| `null` never dims; merges never dim; a root commit dims like any single-parent commit | 2 |
| Selected/search-match/branch-focused rows never dim | 2 |
| `.col-graph` stays full strength; text columns get `opacity: 0.55` | 2 |
| `0.55` is unverified by test, verified by eye instead | 2 |

---

# Roadmap

| Phase | Deliverable | Depends on | Ships alone | Acceptance |
|---|---|---|---|---|
| **1** | Parts 1, 3, 4 — sidebar group colours, light-theme contrast, honest missing-row messages | nothing | Yes | Folder groups and branch names are distinguishable; no rule overrides `color` or `filter` on a self-tinted background; each of the three `graph.getRow` null sites says which of the two causes applies |
| **2** | Part 2's data layer — delete the build-time `getShortStats` call and the method, add `shortStatsFor(hashes)`, hash-keyed cache with negative caching, stat defaults `null`, the `graph.getStats` method | nothing | Yes | Graph build issues no shortstat call; stats for a window are correct under an active branch filter; a merge is requested once and never again |
| **3** | Part 2's presentation — the dim class and the `parents`-guarded dimming rule | 2 | Yes | A genuinely empty commit dims; a merge does not; a row with unknown stats does not |

Phases 1 and 2 are independent of each other and may run in either order.

**Sequencing against the other plan:** `docs/superpowers/plans/2026-08-28-review-in-graph.md`
has phases 2, 4 and 5 outstanding, and its phase 2 edits `App.svelte` in the same
neighbourhoods this spec does — `reviewCommit`/`reviewWithSelected` at `:2234-:2246` sit between
this spec's branch-jump site (`:2221`) and its search site (`:2294`), and the pull request's
`Review with AI` (`:862`) neighbours the PR-jump flow (`:~749`) that Part 4 rewrites. No semantic
conflict was found; the collision is textual. This spec runs wholly before or wholly after that
phase 2, never interleaved.

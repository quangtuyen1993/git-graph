# Graph & Sidebar Legibility

**Date:** 2026-08-26
**Status:** Approved

## Overview

Four changes, all about making the graph readable at a glance:

1. **Sidebar folder groups** — folder rows are grey while branch names are not; level them.
2. **Dim empty commits** — a commit that changed no files should recede.
3. **Light-theme contrast** — a selected row is unreadable in light themes.
4. **Explain a missing row honestly** — stop telling the user to fetch when fetching cannot help.

Parts 1 and 3 are CSS only. Part 2 adds a per-window git query and removes a slower one
from the build path. Part 4 extracts one shared decision that three call sites currently
each guess at differently.

## Global Constraints

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

---

## Part 1: Sidebar folder groups

### Current state

`src/webview/components/sidebar/BranchTreeList.svelte` renders folder rows for nested branch
names (`feature/auth/login` → `feature > auth > login`):

```css
.branch-group { color: var(--vscode-descriptionForeground, #767676); }  /* ~line 210 */
.group-icon   { color: var(--vscode-descriptionForeground, #767676); }  /* ~line 249 */
.branch-name  { color: var(--vscode-foreground, #cccccc); }             /* ~line 304 */
```

`.group-name` sets no colour, so it inherits the grey from `.branch-group`. The result is a
tree where the folder that organises the branches is quieter than the branches themselves —
backwards, since the folder is the thing you scan to navigate.

### Change

`.branch-group` and `.group-icon` both move to `var(--vscode-foreground, #cccccc)`, matching
`.branch-name`. Text and icon move together so a single row does not end up half bright.

### Explicitly unchanged

- The section headers (LOCAL / REMOTE / TAGS / STASHES / WORKTREES / SUBMODULES / PULL REQUESTS
  / REVIEWS) stay as they are. There is no `.section-title` rule to leave unchanged — that claim
  was wrong. The label markup (`<span class="section-title">`, e.g. `BranchSidebar.svelte:453`)
  sets no colour of its own; it inherits from `.section-header` (`BranchSidebar.svelte:855-864`),
  which reads `--vscode-sideBarSectionHeader-foreground` (fallback `#bbbbbb`) — a different token
  from `.branch-group`'s `descriptionForeground`, and one this change does not touch. These are
  partition labels; brightening them would put them in competition with their own contents.
- `.branch-item.remote .branch-name` in `BranchSidebar.svelte` stays `descriptionForeground`.
  Remote branches being quieter than local ones is a deliberate distinction, not an oversight.
- `.chevron` keeps `opacity: 0.8`.

No logic, no tests. Verified by eye in both themes.

---

## Part 2: Dim commits that changed no files

### Why `filesChanged === 0` cannot be trusted today

`node.filesChanged` already exists end to end, but the value `0` currently means three
different things:

| Cause | Why |
|---|---|
| Genuinely empty | `git commit --allow-empty` |
| Merge commit | `git log --shortstat` prints no stat line for merges |
| Beyond the stats window | `getShortStats(500, all)` caps at 500 commits; the rest keep the `0` default set in `graph.service.ts` (~line 110) |

Dimming on `filesChanged === 0` would therefore dim every merge and every row past 500 — the
opposite of the intent.

There is a fourth problem. `getShortStats` builds its command with no revisions:

```
git log --shortstat --format=%H [--all] --max-count=500
```

With a branch filter active, `logOptions.all` is `false`, so it walks **HEAD** rather than the
filtered branches. Stats are then missing or wrong for exactly the commits on screen.

### Change: stats per window, keyed by hash

**Remove the build-time call.** `GraphMethodHandler.build()` currently fetches 500 commits'
worth of shortstat (~line 78). That call sits on the critical path (it diffs 500 commits),
it is the buggy one described above, and **nothing reads its output** — the webview never
referenced `filesChanged`. Deleting it makes graph build faster. It is the only caller of
`getShortStats`, so that method goes too; three test references need updating
(`tests/coverage-closure.test.ts`, `tests/extension/repository-session.test.ts`,
`tests/extension/graph-method-handler.test.ts` — each stubs or asserts it).

**Add a hash-addressed query** to `GitService`:

```typescript
public async shortStatsFor(hashes: string[]): Promise<Map<string, ShortStat>>
```

running `git log --no-walk --shortstat --format=%H <hash>…`. Hashes are absolute, so this is
immune to the HEAD-walking bug: it answers for exactly the commits asked about, under any
filter. An empty input array returns an empty map without invoking git. The stat-line parsing
is shared with the deleted method's logic rather than copied.

**Cache in `GraphMethodHandler`, keyed by commit hash.** A commit's shortstat is immutable —
the hash pins the tree, so the diff against its parent cannot change. The cache therefore never
goes stale and needs no `layoutVersion` invalidation; it is cleared only when the repository
changes, using the same identity check `assertCurrent` already performs.

The cache holds an entry for every hash a `shortStatsFor` call was made for, not only the hashes
git returned a stat line for. `git log --no-walk --shortstat` prints nothing for a merge — the
table above documents that — so without this, a merge would never enter the returned map, would
therefore always read as absent from the cache, and would be re-requested from git on every
window, forever. The consequence: a merge's cache entry holds `null`, the same value an
unresolved commit holds. The dimming rule below is unaffected by this, because it reads
`parents.length` and never reaches a merge's stats at all. But the +/− counts follow-up named in
Out of scope will have to treat a merge's `null` as "no stat line exists for merges", not as "not
loaded yet" — the two cases are indistinguishable in this cache, and will need to be told apart
some other way if that follow-up is built.

**`graph.getWindow` stays synchronous and returns immediately, stats left at `null`.** It does
not await `shortStatsFor`. The alternative — an awaited git subprocess in front of every
first-visit window response — is exactly what the deleted build-time call's `try`/`catch`
(`graph-method-handler.ts:77-89`) existed to keep off a critical path, and that property must
not be lost while moving the work. `graph.getWindow` (`graph-method-handler.ts:35-41`) is a
synchronous in-memory slice today; enrichment must not change that.

**A second host method, `graph.getStats(hashes)`, does the enrichment.** The webview calls it
with the hashes it has just rendered, right after a window response arrives or new rows scroll
into view. `GraphMethodHandler` collects the hashes absent from the cache, issues one
`shortStatsFor` call for that group, populates the cache (negative entries included, as above),
and returns stats for the full set of requested hashes — cached and freshly fetched together —
for the webview to attach to whichever rows currently hold those hashes. Scrolling back over
seen rows costs nothing, because those hashes are already cached and no git call is issued for
them.

Pull, not broadcast: the webview already knows which hashes are on screen, only the one panel
that asked wants the answer, and a broadcast would push stats to every attached webview whether
or not it is looking at those rows.

**Error handling, stated because its absence is what made the earlier version of this design a
finding:** a failed or slow `graph.getStats` call leaves the affected rows at `null`. No dim, no
error banner, nothing surfaced to the user. Stats are decoration; the graph is the feature —
the same property the deleted build-time call protected with its own `try`/`catch`, now
preserved by construction: a `graph.getStats` failure has nothing to fail *into*, since the
window it would have enriched has already rendered undimmed.

**`filesChanged` defaults to `null`, not `0`** (set in `GraphService.createLayout`, plus
`additions` and `deletions` for consistency). `null` means "not known yet"; `0` means "known to
be empty". Without this split a row would flash dim before its stats arrive.

### Dimming rule

A row dims when:

```
filesChanged === 0 && parents.length <= 1
```

- `null` never dims — unknown is not empty.
- `parents.length > 1` never dims. Merges stay at full strength: a merge legitimately carries no
  diff of its own, and it is usually what someone is looking for. This test reads the commit's
  own parent count rather than its stats, so it is correct regardless of what git reports.
- A root commit (no parents) is treated like an ordinary single-parent commit.

### Presentation

`opacity: 0.55` applied to the text columns — `.col-message`, `.col-date`, `.col-sha`,
`.col-author`. Two deliberate exclusions:

- **`.col-graph` keeps full strength.** The lane and its edges are structure; fading them breaks
  the reader's ability to follow topology past an empty commit.
- **A row that is `selected`, `search-match` or `branch-focused` is never dimmed.** Whatever the
  user is currently looking at must not quietly fade.

Opacity rather than a `color` override, so this never fights the specificity of the selection
and find-match rules — and per Part 3's rule, colour is not ours to override.

`0.55` is a chosen number, not a measured one. jsdom performs no layout and computes no colours,
so no automated test can verify a dimmed row stays legible against any given theme's row
background — the same limitation Part 3 states plainly for its own contrast claims, applying
here too. Verified by eye: open the graph in a light theme and a dark theme, dim a genuinely
empty commit, and confirm its message text is still readable at `opacity: 0.55` in both.

### Testing

- `shortStatsFor`: argv assertion (`['log','--no-walk','--shortstat','--format=%H', …hashes]`),
  stat-line parsing, and the empty-input short circuit.
- `graph.getWindow`: returns rows immediately with `filesChanged`/`additions`/`deletions` at
  `null`; it issues no git call itself.
- The cache / `graph.getStats`: requesting the same hashes twice issues exactly one git call; a
  request mixing cached and uncached hashes fetches only the uncached ones; a merge hash is
  cached as `null` after its one `shortStatsFor` call and is never requested again, since
  `shortStatsFor` returns no entry for it.
- Webview: dims for empty non-merge; does not dim a merge with `filesChanged === 0`; does not dim
  `null`; does not dim a selected row; a rejected or slow `graph.getStats` call leaves the row
  undimmed, with nothing surfaced to the user.

---

## Part 3: Light-theme contrast

### The rule being broken

`list.activeSelectionForeground` is the text colour VS Code defines **to pair with**
`list.activeSelectionBackground`. Light themes set it to white, because they pair it with a
strong blue selection background. Using it on a background we mixed ourselves inverts its
meaning.

**Site 1 — `.commit-row.selected`** (`App.svelte`, ~line 3675), the reported bug:

```css
.commit-row.selected {
  --lane-alpha: 0.22;                                            /* pale lane tint */
  color: var(--vscode-list-activeSelectionForeground, #ffffff);   /* white in light themes */
}
```

White text on a pale tint over a light editor background is unreadable.

**Site 2 — `.commit-row.branch-focused`** (`App.svelte:3699-3709`), not reported but reachable
by clicking a branch in the sidebar (`focusedBranchHash`, assigned in `handleBranchSelect`):

```css
.commit-row.branch-focused {
  --lane-alpha: 0.72;
  z-index: 3;
  color: #ffffff;
  filter: brightness(1.45) saturate(1.35);
  box-shadow:
    inset 4px 0 0 rgb(var(--lane-rgb)),
    inset 0 0 0 1px rgba(var(--lane-rgb), 0.95),
    0 0 20px 4px rgba(var(--lane-rgb), 0.72);
  animation: branch-focus-flash 300ms ease-out;
}
```

Hardcoded white regardless of theme. At alpha 0.72 the lane colour dominates enough to survive
in dark themes, but the lane palette includes yellow and cyan, where white reads poorly in any
theme. The rule also carries `filter: brightness(1.45) saturate(1.35)` — a second way the text's
own rendering gets altered, not just its declared colour — alongside three box-shadows and a
300ms flash animation.

**Not a bug:** `.branch-item.selected` in `BranchTreeList.svelte` (~line 272) sets
`background: activeSelectionBackground` **and** `color: activeSelectionForeground` together.
Used as a pair it is correct in every theme — which is the evidence for the fix below.

### Change

- `.commit-row.selected`: drop the `color` line. Text inherits `--vscode-foreground`, which the
  theme guarantees against the editor background. Selection stays obvious through the two
  affordances already present: the tint step (hover `0.13` → selected `0.22`) and the
  lane-coloured accent bar `inset 2px 0 0 0 rgb(var(--lane-rgb))`.
- `.commit-row.branch-focused`: drop `color: #ffffff` **and** `filter: brightness(1.45)
  saturate(1.35)`, and lower `--lane-alpha` from `0.72` to `0.35`. The high alpha is what forced
  a hardcoded text colour in the first place; lowering it removes the need. `filter:
  brightness()`/`saturate()` multiplies the luminance and saturation of everything inside the
  element, text included — it reaches the same violation as overriding `color`, through a
  different property, so it is dropped for the same reason. The three box-shadows and the flash
  animation stay: the 4px inset is the accent bar the rule below names as permitted emphasis, the
  ring and outer glow sit at or beyond the row's edge without touching a glyph, and the animation
  is temporal — none of the three alters how the text itself renders. Three distinct levels
  remain: hover `0.13`, selected `0.22`, branch-focused `0.35`.

  Expect the lane colours in the bar and ring to read less vivid without the `filter` — that is
  the intended reduction in emphasis, the same direction as dropping alpha from `0.72` to `0.35`,
  not a loss to compensate for elsewhere.

### The rule, recorded so this does not regrow

**Do not override `color` — or any property that alters how the text itself renders, such as
`filter` — on a background we tinted ourselves.** `filter: brightness()`/`saturate()` reaches the
same violation as overriding `color`, through a different property; naming only `color` would
leave the door open for the next person to reach for `filter` in good faith. To emphasise a row,
raise the background alpha, add an accent bar, or change `font-weight` — never the text's own
rendering. A theme-provided foreground pair may only be used when both halves of the pair are
used together.

### Testing

jsdom performs no layout and computes no colours, so contrast cannot be asserted. Structural
assertions ("this rule contains no `color`") test the implementation rather than the behaviour
and break on harmless edits. This part therefore ships **without automated tests**, verified by
opening the graph in a light theme and a dark theme and selecting a row in each. That is stated
plainly rather than papered over with a test that proves nothing.

---

## Part 4: Explain a missing row honestly

### Current state

`graph.getRow` returns `null` for two unrelated reasons — the commit is not in the repository,
or it is in the repository but outside the active branch filter, so the layout has no row for
it. Three call sites read that `null` and each guesses differently:

| Call site | Behaviour on `null` |
|---|---|
| Pull-request jump (`App.svelte`, ~line 755) | Always claims the branch may not be fetched, and offers a **Fetch** action |
| Commit search | Always says the commit is outside the current branch filter |
| Sidebar branch jump | Silent |

The pull-request case is the harmful one: under an active filter the head commit is already
local, so the message misdiagnoses the problem and the Fetch it offers cannot fix it. The code
immediately above it already guards against a related guess — "claiming it isn't would be
exactly the kind of guess this fix exists to avoid" — but only for the not-yet-loaded case.

### Change

One pure helper in `src/webview/lib/`:

```typescript
export type MissingRowReason = 'filtered' | 'absent';
export function missingRowReason(opts: { branchFilterActive: boolean }): MissingRowReason;
```

It returns the reason only. Actions stay at the call sites because they are closures over local
state (`Fetch` re-fetches and re-scrolls; `Clear filter` resets `selectedBranchFilters`), and
pushing closures into a pure helper would make it untestable for no gain.

Call sites map the reason to their own wording:

- **Pull-request jump** — `filtered`: "This pull request's head commit is outside the current
  branch filter." with a **Clear filter** action. `absent`: today's message and its **Fetch**
  action, unchanged.
- **Commit search** — both messages are already right; it switches to the helper so the three
  sites cannot drift apart again. They're already right because search hits are sourced from the
  repository itself (`git.searchCommits`, `App.svelte:2272`) — a hash `runCommitSearch` finds
  cannot be `absent` by construction, so `filtered` is the only reason `graph.getRow` can return
  `null` here. This is also why `missingRowReason`'s single `branchFilterActive` input is
  sufficient across all three call sites: no call site needs more than that one fact to pick the
  right reason.
- **Sidebar branch jump** — `filtered`: says so, instead of returning silently. This closes a
  known gap where the same `null` produced a message in one place and nothing in another.

The invariant worth stating: **a Fetch action appears only when fetching would actually help.**

### Testing

- Helper: both branches, directly (it lives in the covered `src/webview/lib/**`).
- Webview, per call site: with a filter active the message names the filter and the action is
  Clear filter; with no filter the message names fetching and the action is Fetch.

---

## Files

| File | Parts | Change |
|---|---|---|
| `src/webview/components/sidebar/BranchTreeList.svelte` | 1 | two colour values |
| `src/extension/services/git.service.ts` | 2 | add `shortStatsFor`, delete `getShortStats`, share the parser |
| `src/extension/controllers/graph-method-handler.ts` | 2 | drop build-time stats, add the hash cache and the `graph.getStats` method |
| `src/extension/services/graph.service.ts` | 2 | stat defaults `0` → `null` |
| `src/webview/lib/missing-row.ts` | 4 | **new** |
| `src/webview/App.svelte` | 2, 3, 4 | node type, dim class + CSS, the `graph.getStats` call issued after each rendered window, two contrast rules, three call sites |
| `tests/coverage-closure.test.ts`, `tests/extension/repository-session.test.ts`, `tests/extension/graph-method-handler.test.ts` | 2 | drop `getShortStats` references |

## Out of scope

- Showing the actual `+`/`−` counts in the row. The stats are now available per window, which
  makes it easy later; it is not asked for here.
- Splitting `App.svelte` (3882 lines). Named as worthwhile in the previous review, still not a
  gate for this work.
- Raising the 5s `testTimeout` on the real-git integration tests. Pre-existing, and it belongs
  to a change about test infrastructure, not about legibility.
- Remote branch names and section titles in the sidebar, deliberately left as they are (Part 1).

---

## Roadmap

Three phases. Parts 1, 3 and 4 are CSS and messaging with no data-model change; Part 2 is a
plumbing project that happens to end in a dim class. Splitting Part 2's data fix from its
presentation matters because the data fix is independently valuable: deleting the build-time
call removes a 500-commit diff from the graph-build critical path and fixes a real
wrong-revisions bug, with no visible change at all.

| Phase | Deliverable | Depends on | Ships alone | Acceptance |
|---|---|---|---|---|
| **1** | Parts 1, 3, 4 — sidebar group colours, light-theme contrast, honest missing-row messages | nothing | Yes | Folder groups and branch names are distinguishable; no rule overrides `color` or `filter` on a self-tinted background; each of the three `graph.getRow` null sites says which of the two causes applies |
| **2** | Part 2's data layer — delete the build-time `getShortStats` call and the method, add `shortStatsFor(hashes)`, hash-keyed cache with negative caching, stat defaults `null`, the `graph.getStats` method | nothing | Yes | Graph build issues no shortstat call; stats for a window are correct under an active branch filter; a merge is requested once and never again |
| **3** | Part 2's presentation — the dim class and the `parents`-guarded dimming rule | 2 | Yes | A genuinely empty commit dims; a merge does not; a row with unknown stats does not |

Phases 1 and 2 are independent of each other and may run in either order.

**Sequencing against the other plan:** `docs/superpowers/plans/2026-08-28-review-in-graph.md`
has phases 2, 4 and 5 outstanding, and its phase 2 edits `App.svelte` in the same neighbourhoods
this spec does — `reviewCommit`/`reviewWithSelected` at :2234–:2246 sit between this spec's
branch-jump site (:2221) and its search site (:2294), and the pull request's `Review with AI`
(:862) neighbours the PR-jump flow (:~749) that Part 4 rewrites. No semantic conflict was found;
the collision is textual. This spec runs wholly before or wholly after that phase 2, never
interleaved.

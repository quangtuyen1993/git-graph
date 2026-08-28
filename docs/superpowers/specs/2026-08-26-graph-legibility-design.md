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
  `main` at `e8ddf5e`.

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

- `.section-title` (LOCAL / REMOTE / TAGS / STASHES …) stays `descriptionForeground`. These are
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

**`graph.getWindow` enriches its nodes:** take the window from `GraphService`, collect the
hashes absent from the cache, issue one `shortStatsFor` call for that group, populate the cache,
attach the values to the nodes. Scrolling back over seen rows costs nothing.

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

### Testing

- `shortStatsFor`: argv assertion (`['log','--no-walk','--shortstat','--format=%H', …hashes]`),
  stat-line parsing, and the empty-input short circuit.
- `graph.getWindow` enrichment: nodes come back carrying stats; asking for the same window twice
  issues exactly one git call; a second window fetches only its uncached hashes.
- Webview: dims for empty non-merge; does not dim a merge with `filesChanged === 0`; does not dim
  `null`; does not dim a selected row.

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

**Site 2 — `.commit-row.branch-focused`** (`App.svelte`, ~line 3700), not reported but reachable
by clicking a branch in the sidebar (`focusedBranchHash`, assigned in `handleBranchSelect`):

```css
.commit-row.branch-focused { --lane-alpha: 0.72; color: #ffffff; }
```

Hardcoded white regardless of theme. At alpha 0.72 the lane colour dominates enough to survive
in dark themes, but the lane palette includes yellow and cyan, where white reads poorly in any
theme.

**Not a bug:** `.branch-item.selected` in `BranchTreeList.svelte` (~line 272) sets
`background: activeSelectionBackground` **and** `color: activeSelectionForeground` together.
Used as a pair it is correct in every theme — which is the evidence for the fix below.

### Change

- `.commit-row.selected`: drop the `color` line. Text inherits `--vscode-foreground`, which the
  theme guarantees against the editor background. Selection stays obvious through the two
  affordances already present: the tint step (hover `0.13` → selected `0.22`) and the
  lane-coloured accent bar `inset 2px 0 0 0 rgb(var(--lane-rgb))`.
- `.commit-row.branch-focused`: drop `color: #ffffff` and lower `--lane-alpha` from `0.72` to
  `0.35`. The high alpha is what forced a hardcoded text colour in the first place; lowering it
  removes the need. Three distinct levels remain: hover `0.13`, selected `0.22`,
  branch-focused `0.35`.

### The rule, recorded so this does not regrow

**Do not override `color` on a background we tinted ourselves.** To emphasise a row, raise the
background alpha, add an accent bar, or change `font-weight` — never the text colour. A
theme-provided foreground pair may only be used when both halves of the pair are used together.

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
  sites cannot drift apart again.
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
| `src/extension/controllers/graph-method-handler.ts` | 2 | drop build-time stats, add the window cache and enrichment |
| `src/extension/services/graph.service.ts` | 2 | stat defaults `0` → `null` |
| `src/webview/lib/missing-row.ts` | 4 | **new** |
| `src/webview/App.svelte` | 2, 3, 4 | node type, dim class + CSS, two contrast rules, three call sites |
| `tests/coverage-closure.test.ts`, `tests/extension/repository-session.test.ts`, `tests/extension/graph-method-handler.test.ts` | 2 | drop `getShortStats` references |

## Out of scope

- Showing the actual `+`/`−` counts in the row. The stats are now available per window, which
  makes it easy later; it is not asked for here.
- Splitting `App.svelte` (2587 lines). Named as worthwhile in the previous review, still not a
  gate for this work.
- Raising the 5s `testTimeout` on the real-git integration tests. Pre-existing, and it belongs
  to a change about test infrastructure, not about legibility.
- Remote branch names and section titles in the sidebar, deliberately left as they are (Part 1).

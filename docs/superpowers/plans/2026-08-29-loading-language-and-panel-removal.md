# Loading Feedback, Review Language, and Retiring the Review Panel

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to execute this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show the user that work is happening instead of explaining why it did not, let a review be written in a chosen language, and finish retiring the second webview panel.

**Specs:** `docs/superpowers/specs/2026-08-28-review-in-graph-design.md` governs phases 4, 2 and 5. Items 1+3 and item 4 are bounded changes with no spec of their own; their requirements are stated here.

## How this plan is shaped

Tasks state **requirements, not implementations** — the settled convention in this repository, and the reasoning is in `docs/superpowers/plans/2026-08-28-review-in-graph.md`'s header.

This plan additionally carries a **coordination contract**, because two workers run concurrently in wave 1 and this project has already lost a commit to two agents sharing one checkout. Ownership below is exclusive: a path has exactly one owner per wave, and a worker may read anything but writes only what it owns.

## Coordination contract

**Goal and acceptance:** wave 1 ships two independent changes with no shared writable path and no shared interface. Later waves are sequential because the webview consumes what the extension produces.

**Modules**

| Owner | Responsibility | Exclusive writable paths |
|---|---|---|
| **Track A** | Loading feedback in the graph | `src/webview/**`, `tests/webview/**` |
| **Track B** | Review output language | `src/extension/**`, `package.json`, `tests/extension/**`, `tests/coverage-closure.test.ts` |
| **Controller** | Everything unassigned | `tests/smoke.test.ts`, `tests/fixtures/**`, `tests/helpers/**`, `docs/**`, build config |

Those last three test paths are named because leaving them out is how ownership overlaps
hide. `tests/coverage-closure.test.ts` goes to Track B because it enumerates extension
surface and has been edited by extension work twice already; `tests/fixtures/**` and
`tests/helpers/**` are shared, so **neither worker may edit them** — a worker needing a
fixture change stops and reports it, and the controller makes the edit. A shared fixture
quietly edited by one worker is a defect the other worker inherits without knowing.

**Seams:** none in wave 1. Track B's setting is read entirely inside the extension when the review prompt is built; nothing it produces reaches the webview, and nothing Track A writes is read by the extension. This is why the two are safe together and why no contract freeze is needed between them.

**State ownership:** the single source of truth for "work is in flight" is Track A's, in the webview. It must not be duplicated extension-side.

**Dependencies:** wave 1 = A1 ‖ B1. Wave 2 = phase 4. Wave 3 = phase 2. Wave 4 = phase 5. Waves 2-4 are one worker each; see "Why later waves do not parallelise".

**Integration owner:** the controller. It runs the full suite, the three type gates and coverage once per wave, and owns any cross-module fix.

**Verification gates:** `npx vitest run --fileParallelism=false`; `tsc --noEmit` against `tsconfig.json` and `tsconfig.test.json`; `svelte-check --tsconfig ./tsconfig.webview.json`; coverage thresholds 80/70/80/80 never lowered.

### Why later waves do not parallelise

The dependency graph is not the binding constraint — **`App.svelte` is**. Phases 4 and 2 both write it, and so does item 1+3. Splitting a phase across tracks would put its webview half in Track A and its extension half in Track B, but the webview half consumes what the extension half produces (`localBothPresent`, the `ai` namespace), so the halves are a wave boundary rather than a parallel pair. Running them concurrently would move the cost from waiting to merge conflicts in a 4000-line file, which is the trade this project already lost once.

## Global Constraints

- **Reviews saved by the current version must keep loading and opening**, in all four existing kinds.
- **Both compare gestures must keep working** — `Compare with selected` and `Compare with '<current>'` still route through the panel phase 5 deletes.
- **A repository with no forge provider behaves exactly as today** — no section, no errors, no console noise.
- **No provider vocabulary above `forge/bitbucket/`.**
- Subagents run only the test files they touch, never the full suite; the controller runs it once per wave.
- **One worker per writable path per wave.** No two implementers share a checkout without worktree isolation.

---

# Wave 1

Two workers, concurrent, disjoint.

## Task A1: Loading feedback, and a pull request jump that acts instead of explaining

**Owns:** `src/webview/**`, `tests/webview/**`
**Consumes:** nothing new. `git.fetch` already exists and the current Fetch action already calls it.
**Produces:** nothing the extension reads.

**Read first:** `App.svelte`'s `<header class="toolbar">` (~:3149); `showTransientMessage` (~:242) and the `progressLabels` record (~:2594), which is the existing **mutation** progress banner and is a different thing from what you are adding; `graphRefreshesInFlight` (~:373) and `isGraphReady`/`waitForGraphReady`; and `scrollToPullRequestHead` (~:759) with the long comment above it explaining why it waits for the build before saying anything.

**The problem, stated as the user stated it.** Clicking a pull request whose head is not in the graph produces a sentence and a button. The user's words, twice: *"I can see it reports that and then it fetches it anyway"*, and *"I just need a loading indicator there"*. The message is not wrong — the guards above are correct and the commit really is absent — but explaining and waiting for a click is the wrong response to a situation the tool can simply resolve.

**Requirements:**

1. **A thin indeterminate progress bar sits directly under the toolbar header**, visible whenever background work is in flight and absent otherwise. It must not shift the layout when it appears — reserve its height or overlay it.
2. **One source of truth for "work is in flight."** `graphRefreshesInFlight` already counts graph builds; the bar must also cover fetches and any other long host call, through a single counter or store rather than a second parallel mechanism. Two competing notions of "busy" is the defect to avoid.
3. **The bar is distinct from the existing mutation progress banner**, which is labelled and describes a specific operation. This one is ambient and unlabelled; it answers "is it working?", not "what is it doing?".
4. **A pull request jump that misses because the branch is not fetched now fetches, rather than reporting.** The bar shows the work; when the fetch lands, the jump completes. The user does not press anything.
5. **A fetch that fails still says so.** Silence on failure is worse than the message being replaced — the user clicked expecting to land somewhere.
6. The two messages that remain true keep their behaviour: the filtered case with its **Clear filter** action, and "the graph hasn't finished loading" when no build has ever completed.
7. **Respect `prefers-reduced-motion`** — an animated bar is exactly the kind of thing that rule exists for.

**Named trap:** the auto-fetch introduces a second reason the jump can be waiting, on top of the existing wait for the graph build. Both must resolve to one visible state, and a superseded jump — the user clicked a different pull request meanwhile — must not scroll when its fetch lands. The existing `selectedPullRequestId !== pullRequestId` guards are the pattern.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | The bar appears while a graph refresh is in flight and disappears when it settles |
| 2 | The bar appears during a fetch triggered by a pull request jump |
| 3 | A pull request jump whose head is absent issues a fetch without user action, and scrolls when it lands |
| 4 | A failed fetch surfaces a message rather than failing silently |
| 5 | Selecting a different pull request while a fetch is in flight does not scroll to the first one |
| 6 | The filtered message and its Clear filter action are unchanged |
| 7 | Adding and removing the bar does not move the rows below it |

## Task B1: The review output language

**Owns:** `src/extension/**`, `package.json`, `tests/extension/**`
**Consumes:** nothing from Track A.
**Produces:** nothing the webview reads. The setting is read where the prompt is built.

**Read first:** `buildReviewPayload` in `src/extension/services/review-payload.ts:142` and the `ReviewPayloadInput` interface at `:43`; its one caller, `review-method-handler.ts:245`; and `ai-review.service.ts`, which reads `gitGraphPro.aiReview` configuration at three sites (`:90`, `:226`, `:309`) — follow how those are read rather than inventing a fourth style.

**Requirements:**

1. A new setting, `gitGraphPro.aiReview.outputLanguage`, **free text, defaulting to empty**. Free text rather than an enum so a language we did not think of is not locked out.
2. **Empty means "do not ask"** — the payload is byte-identical to today's, so an existing user sees no change and no instruction is spent on a preference they never expressed.
3. When set, the review body comes back in that language. The instruction belongs where the prompt is assembled, not in each provider adapter — there are several and they must not drift.
4. **The setting affects the review body only.** Structural output the extension parses, if any, keeps its current form; check before assuming there is none.
5. **A stored review keeps the language it was written in.** Changing the setting does not retranslate history, and nothing re-reads the setting when displaying an old review.

**Named trap:** `review.start` serves a cached review when the target, provider and model match. The language is none of those, so changing the setting and re-running yields the old review in the old language, silently. Decide this deliberately and say which you chose: either the language participates in the review id, or the setting's documentation states plainly that it applies to new reviews. Do not leave it undecided.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | With the setting empty, the built payload is byte-identical to today's |
| 2 | With the setting set, the payload carries the instruction once, in the assembly layer |
| 3 | The instruction does not appear twice when a provider adapter also builds a prompt |
| 4 | A stored review's displayed body is unaffected by later changes to the setting |
| 5 | The cache interaction behaves as the ruling on the named trap decided, and a test pins that decision |

### Wave 1 acceptance-clause → task

| Clause | Task |
|---|---|
| Ambient progress bar under the header | A1 |
| One source of truth for in-flight work | A1 |
| Pull request jump fetches instead of reporting | A1 |
| Failure still speaks | A1 |
| `outputLanguage` setting, empty by default | B1 |
| Instruction added once, at assembly | B1 |
| Cache-versus-language decided and pinned | B1 |

---

# Waves 2-4 — finishing the review panel

These are the outstanding phases of `docs/superpowers/plans/2026-08-28-review-in-graph.md`, unchanged. They run in that plan's own order, one worker each, because every one of them writes `App.svelte`.

- **Wave 2 = phase 4.** Cache-hit disclosure (including removing the `openBody` side effect that pops an editor on every cache hit), errors attributed to the operation that failed, the poll tick no longer tearing the panel down, a confirmation on Delete, `localBothPresent` on the wire, and the review detail file rows becoming interactive — the debt phase 1 deliberately booked here. Consolidate the webview's copies of the review wire union **before** adding `localBothPresent` to it.
- **Wave 3 = phase 2.** The three review gestures change from navigate to run; the two new gestures; the compare gestures point at the diff-only state; the `ai` namespace reaches the graph's host; `defaultProvider`/`defaultModel` become live.
- **Wave 4 = phase 5.** The panel, its container, `review-main.ts`, `createReviewSession` and `review.setTarget` are removed. **This is when the second tab disappears.**

**Also owed, and unscheduled until a wave owns the file:** expose `commitExists` to the webview so the filtered message cannot claim a filter excluded a commit no ref reaches. It needs `graph-method-handler.ts` and `App.svelte`; fold it into wave 2, which owns both.

---

# Roadmap

| Phase | Deliverable | Depends on | Ships alone | Acceptance |
|---|---|---|---|---|
| **1** | Loading bar + pull request auto-fetch (A1) ‖ review output language (B1) | nothing | Yes, each independently | The bar shows during graph builds and fetches; a pull request jump to an unfetched branch resolves itself; a language setting produces a review in that language and, left empty, changes nothing |
| **2** | Phase 4 of the review-in-graph plan, plus the `commitExists` exposure | 1 (App.svelte contention only) | Yes | A cache hit is visibly a cache hit and opens no editor; review file rows open diffs; no message claims a filter excluded a commit no ref reaches |
| **3** | Phase 2 of the review-in-graph plan | 2 | Yes | Every review gesture runs a review; both compare gestures open the diff-only state; the provider settings are live |
| **4** | Phase 5 of the review-in-graph plan | 2, 3 | Yes | One webview host; the Code Review tab is gone; both compare gestures still work; reviews stored before all this still load |

Phase 1's two tasks are the only genuinely concurrent work here, and they are concurrent because they share no writable path — not because the dependency graph permits it. Phase 4 is the only irreversible step and it runs last, after every gesture it would strand has a replacement.

**Manual gate carried forward:** the light/dark checklist from the legibility work has still never been run, and it is the only gate on that work's contrast and dimming changes. It is not a blocker for this plan, but it does not expire.

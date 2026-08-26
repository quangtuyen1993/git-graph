# Forge Provider — Completion Plan (Phases 3.7 through 8)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to execute this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the forge provider layer — AI review of pull requests, acting on them, creating them, a second provider, and the accumulated debt — without repeating how phases 1-3 were planned.

**Spec:** `docs/superpowers/specs/2026-08-25-forge-provider-bitbucket-design.md`
**Predecessor:** `docs/superpowers/plans/2026-08-25-forge-provider-phase1-3.md` (delivered)

## How this plan is shaped, and why

The phase 1-3 plan wrote out complete implementations — function bodies, test bodies, fixtures, roughly 3,300 lines. The execution ledger records what that cost: the plan became the largest single source of defects (a cache concurrency bug, an overwritten rate-limit deadline, a path-traversal hole, a `capabilities` object that lied, a stale `ForgeRepoRef` shape, an invented component API), implementers became transcribers, reviewers became transcription auditors, and one acceptance criterion — the changed-files list — was owned by no task at all and nearly shipped missing.

Three things from that plan earned their place and are kept: **Global Constraints stated as prose invariants** (every one was enforced against real code at least once), the per-task **Consumes / Produces** block (it is what made the pre-flight conflict scan possible), and **one-sentence intent notes** — the single most consequential fix of the run was decided *against the plan's own code* because the requirement existed as a sentence.

What changed:

- **Tasks state requirements, not implementations.** No function bodies, no test bodies.
- **Interfaces are named, never restated.** "Produces: `ForgeStore.fetch` returning `CacheResult<T>` as declared in `forge-store.ts`" cannot go stale; a copied-out type can and did.
- **Each task lists anchors to read first** — the real code whose conventions it must match.
- **Traps are named.** Where a reviewer would predictably catch something, the task says so up front and spends the finding before it costs a fix round.
- **Acceptance rows are test obligations**: a scenario plus the reason the assertion exists. Write the test, watch it fail, make it pass.
- **Every phase ends with an acceptance-clause → task table.** A phase is not ready to execute while a row is empty. This is the structural fix for the files-list failure; it takes five minutes on a 400-line plan and is impossible on a 3,300-line one.
- **Every task footer says: report deviations rather than silently reconciling; where the shipped code contradicts this plan, follow the code and say so.** Three of the previous run's best catches came from implementers deviating and disclosing.

## Global Constraints

These bind every task below.

- **The forge layer is additive.** Any forge failure is contained. A repository with no forge remote behaves exactly as it does today — no section, no errors, no console noise, and activation cannot break.
- **Credentials never reach the webview and never reach a log**, including error logs. `AuthenticationSession` carries an `accessToken` by design; it stays inside the auth provider and the API client.
- **No provider vocabulary above `forge/bitbucket/`.** Shared code switches on `ForgeErrorKind`, never an HTTP status, and never names a host. Provider-specific remediation text comes from `describeError`.
- **`forge.status` never prompts.** It runs on every panel load.
- **No test contacts a live API or the network.**
- Coverage thresholds: statements 80 / lines 80 / functions 80 / branches 70. New source files under `src/extension/services/forge/` or `src/extension/controllers/` go into `coverage.include`; `src/webview/lib/**/*.ts` is already covered by a glob.
- **Subagents never run the full suite.** They run the focused files; the controller runs the suite and coverage once per phase.
- Verify with `npx vitest run --fileParallelism=false` — the suite is flaky under parallel execution because integration tests spawn real git. Both gates must pass: `tsc --noEmit` against `tsconfig.json` and `tsconfig.test.json`.

---

# Phase 3.7 — Interface amendments

**Why first:** every one of these is a type-level change that phases 4-7 build on, and each gets more expensive with every phase that ships against the current shape. One task, one review, roughly half a day. It rides at the front of phase 4's execution rather than being its own ceremony.

## Task 1: Amend the shared contract for a second provider

**Files:** modify `src/extension/services/forge/forge.types.ts`, `src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts`, `src/extension/services/forge/bitbucket/bitbucket-mapper.ts`, `src/extension/controllers/forge-method-handler.ts`, `src/extension/extension.ts`, `tests/helpers/fake-forge-provider.ts`, and the Bitbucket fixtures.

**Read first:** `ForgeProvider` and `ForgeErrorKind` in `forge.types.ts`; `describeError` and `signOut` in `bitbucket-cloud.provider.ts`; the `forge.signOut` case and the `handle()` catch in `forge-method-handler.ts`; `mapComment`'s inline-anchor handling in `bitbucket-mapper.ts`.

**Interfaces — Produces:** an optional-or-capability-gated `signOut`; `ForgeComment` gains `side`; `ReviewStatus` gains `'commented'`; `'not-found'` routed through `describeError`.

**Requirements:**

1. **`signOut()` must be optional.** It is currently unimplementable for a GitHub provider: Bitbucket works only because we own the auth provider and can remove the session ourselves, while a consumer of VS Code's built-in `github` provider has no API to remove a session — only the owning provider does. Three shared call sites depend on it today: the `forge.signOut` case, the 401 cleanup path in `handle()`, and the `gitGraphPro.forge.signOut` command. Make it optional on the interface (or gate it behind a capability). When absent: the handler answers with guidance to sign out via the Accounts menu, and the 401 path skips the sign-out while still invalidating the cache and broadcasting `forge.changed`.
2. **`ForgeComment` gains `side`** (which side of the diff an inline comment anchors to). The Bitbucket mapper already has the signal — it prefers `inline.to` and falls back to `inline.from`. Phase 4 renders prior discussion into an AI review payload, and a comment on a deleted line is ambiguous without it.
3. **`ReviewStatus` gains `'commented'`.** GitHub reports it; today it would collapse into `'pending'`, which claims someone has not responded when they have.
4. **`'not-found'` routes through `describeError`.** Its current shared text speaks API-token vocabulary ("insufficient token scope"), which is meaningless to a GitHub OAuth user. `'forbidden'` already delegates; make `'not-found'` match.
5. **Document the reviewer-status degradation on the type rather than restructuring it.** `PullRequestSummary.reviewers[].status` forces an N+1 on GitHub, whose list endpoint returns requested reviewers without their states. Add a doc comment: a provider may report `'pending'` for every reviewer on a list response where per-PR calls would otherwise be required; the detail view is authoritative. No UI may depend on summary chips being accurate.

**Constraints:** no behaviour change for Bitbucket beyond `'not-found'`'s wording; `FakeForgeProvider` must satisfy the amended interface without a cast.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1a | A provider without `signOut` produces the Accounts-menu guidance from `forge.signOut` rather than throwing. |
| 1b | A 401 from a provider without `signOut` still invalidates the cache and broadcasts `forge.changed` — the session-cleanup path must not depend on the optional method. |
| 2 | A Bitbucket comment anchored only via `inline.from` maps with the correct `side`; one with `inline.to` maps with the other. Build both fixtures — they are the phase 7 deferred item and phase 4 consumes them. |
| 3 | A `'commented'` reviewer state survives mapping instead of collapsing to `'pending'`. |
| 4 | A `'not-found'` error's message comes from the provider, and the shared handler contains no token vocabulary (assert by grep in the test, as the neutrality tests already do). |
| 5 | `tsc --noEmit` passes against both configs with `FakeForgeProvider` unchanged apart from the new members. |

**Report deviations rather than silently reconciling. Where the shipped code contradicts this task, follow the code and say so.**

### Acceptance-clause → task

| Requirement | Task |
|---|---|
| optional `signOut` | 1 |
| `ForgeComment.side` | 1 |
| `ReviewStatus.commented` | 1 |
| `'not-found'` via `describeError` | 1 |
| reviewer-degradation contract | 1 |

---

# Phase 4 — AI review of a pull request

**Deliverable:** a pull request can be reviewed by the extension's existing AI pipeline, from either panel.
**Depends on:** phase 3.7.
**Ships independently:** yes.

**The seam, as it actually is.** `ReviewRunner.start()` takes a pre-assembled `payloadText` and `buildReviewPayload` takes a plain diff string, so the AI layer itself needs no change — that part of the spec is still true. But `review.start` is not one seam, it is five: target resolution (which rev-parses both refs), the diff fetch, the file summaries, the commit subjects, and the empty-diff guard. Each needs a `'pr'` branch. Two already have forge-side answers built and cached from phase 3 — the sha-keyed diff and the diffstat file list. One (commit subjects) has no interface support; omit it on the API path rather than widen the interface for garnish.

## Task 1: Teach the review pipeline the `'pr'` target kind

**Files:** modify `src/extension/services/review-store.ts`, `src/extension/services/review-target.ts`, `src/extension/services/review-payload.ts`, `src/extension/services/review-key.ts`, `src/extension/controllers/review-method-handler.ts`, `src/extension/services/git.service.ts`, `src/extension/extension.ts`; extend the existing review test files.

**Read first:** the `review.start` case in `review-method-handler.ts` end to end — it performs five git operations that all assume both refs exist locally; `resolveReviewTarget` and the `KINDS` set in `review-target.ts`; `buildReviewId` in `review-key.ts`; the comment above `findCommits` in `git.service.ts` explaining why plain `rev-parse` is not an existence check.

**Interfaces:**
- **Consumes:** `PullRequestDetail` from `forge.types.ts` (do not restate it); `forge.pr.diff` and `forge.pr.files` as already cached in `forge-method-handler.ts`.
- **Produces:** `ReviewTargetKind` gains `'pr'`; the stored review entry gains `prId`, `prNumber`, `providerId`; `ReviewHandlerDeps` gains a `forge` member — **narrow closures injected from `extension.ts`**, mirroring how `getRemoteUrl` is injected into the forge handler today. Never an import of anything under `forge/bitbucket/` from `review-*`.

**Requirements:**

1. A `review.start` with `kind: 'pr'` resolves its sha pair from `PullRequestDetail.sourceCommit` / `targetCommit`, **never** from `revParse`. A pull request's branch may never have been fetched; this is the spec's named regression case.
2. The diff is local-first: when both shas are genuinely present locally, use `GitService.getDiff` — its `...` semantics already match how a host builds a PR diff — otherwise fetch through the forge diff path, which is sha-keyed and immutably cached.
3. **Named trap:** "present locally" must be established with a real existence check (`rev-parse --verify <sha>^{commit}` or `cat-file -e`). Plain `rev-parse` echoes any sha-shaped string back successfully whether the object exists or not — `git.service.ts` says so in its own comment. A plain-revParse check passes in every test that uses a local fixture repo and fails in production on exactly the unfetched-branch case this task exists for. `GitService` needs a real existence method; add it here.
4. File summaries come from `forge.pr.files`. Commit subjects are included only on the local path.
5. Prior discussion is rendered into the payload ahead of the diff via a new `priorDiscussion` input to `buildReviewPayload` — the only change to that file. Inline comments carry their path and line, and their `side` from phase 3.7.
6. **All three kind-whitelists learn `'pr'`**: the params parser, the inline array in `review.saveTarget`, and `KINDS` in `review-target.ts`. The second is a duplicated literal that will otherwise silently reject the new kind.
7. `review.rerun` for a `'pr'` entry re-resolves through the stored `prId` and `providerId`, not the stored sha pair — a rerun reviews the pull request as it is now.
8. **Decide and implement the review-id question.** `buildReviewId` is sha-pair-based, so a PR review and a "2 Branches" review of the same pair currently produce the *same id* — the entry's kind is whichever ran first, and rerun will rerun it as that kind. Fold the kind into the id. Ids are opaque filenames; nothing parses them back.

**Constraints:** no import from `forge/bitbucket/` anywhere under `review-*`; a forge failure during `review.start` surfaces as the translated message, not a raw `ForgeError`; kinds `'branch' | 'commit' | 'range'` behave byte-for-byte as today.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | A `'pr'` review whose head sha is absent locally completes via the forge diff. Assert with a spy proving `revParse` was never called, **and** with a fixture whose sha is well-formed but not in the repo — so a plain-revParse implementation would fail this test rather than pass it. |
| 2 | A `'pr'` review of a fully-fetched pull request calls `getDiff` and performs zero forge diff fetches. |
| 3 | The review appears in history titled `PR #<number> <title>`, and rerun on it re-fetches the pull request detail. |
| 4 | A payload for a pull request with comments contains a discussion section ahead of the diff; a comment on a deleted line carries its path, line and side. |
| 5 | `review.saveTarget` round-trips a `'pr'` target. |
| 6 | A PR review and a `'range'` review of the same sha pair produce different ids. |
| 7 | The pre-existing review test files pass unmodified. |

**Report deviations rather than silently reconciling.**

## Task 2: `Pull Request` mode in the review panel

**Files:** modify the review panel component and its tests.

**Read first:** the existing mode tabs and the entry-description helper; `Combobox.svelte`'s contract; how the panel currently reaches the extension.

**Requirements:**

1. A fourth mode joins the existing three. Selecting it lists open pull requests via `forge.pr.list` — the `forge` namespace is already registered on both hosts, so no new plumbing is needed.
2. Choosing a pull request shows its changed files and reviewer status before the Review button, consistent with how the other modes present their target.
3. The mode is absent when `forge.status` reports the repository has no provider — the same rule the sidebar section follows.
4. Review history renders a `'pr'` entry by its number and title.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | With no provider, the mode tab does not render at all. |
| 2 | Selecting a pull request populates the file list and reviewer chips from the forge methods, not from git. |
| 3 | A `'pr'` history entry displays its number and title rather than a sha pair. |
| 4 | Switching away from and back to the mode does not lose the selection. |

## Task 3: `Review with AI` from the graph panel

**Files:** modify `src/webview/App.svelte`, `src/webview/components/detail/PullRequestDetail.svelte`.

**Read first:** `review.setTarget`, which already performs focus-and-broadcast but resolves through git; `reviewWithAiEnabled` in `PullRequestDetail.svelte`, which was built waiting for exactly this.

**Requirements:**

1. The detail panel's `Review with AI` button becomes live: `reviewWithAiEnabled` is passed true, and the click hands off to the review panel with the pull request preselected.
2. `review.setTarget` learns the `'pr'` branch so the handoff does not go through git.
3. **Stretch, in this phase and not deferred:** make the changed-file rows open a diff. Phase 3 shipped them display-only because opening a file resolves against the local repository and a pull request head is usually not fetched. This phase builds the machinery that answers it — the full PR diff, sha-key-cached, and `parseUnifiedDiff` already in the webview — so rendering one file's diff from that text is nearly free once task 1 lands. Left out, this drifts to phase 8 and looks like polish, when it is the difference between the detail panel being a viewer and being a list.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Clicking `Review with AI` focuses the review panel with that pull request selected. |
| 2 | The handoff performs no git resolution for a pull request whose branch is not fetched. |
| 3 | A file row opens that file's diff for a pull request with no local commits. |

### Phase 4 acceptance-clause → task

| Spec / roadmap clause | Task |
|---|---|
| `'pr'` target kind across store, target and key | 1 |
| local-first diff, API fallback | 1 |
| prior discussion in the payload | 1 |
| review filed as `PR #n <title>` | 1, 2 |
| `[Pull Request]` review mode | 2 |
| `Review with AI` button | 3 |
| unfetched-branch review succeeds | 1 |

**Pulled forward into this phase from the deferred list:** the inline-comment `to`/`from` fixtures (they are this phase's payload spec); remote-resolution caching per repository path, which the spec promised and which currently spawns `git remote get-url` on every forge dispatch — tolerable for a sidebar, not for a review flow; and `handleGraphBranchFilters` failing to clear the pull request selection, since task 3 is already in that wiring.

---

# Phase 6 — Approve, request changes, merge

**Runs before phase 5.** It is roughly half the size — two POST endpoints on a client that already has `post`/`postEmpty`, plus a confirmation dialog on capability gates that already render — it completes the read-then-act loop on pull requests that already exist, and it forces the mergeability question before phase 5's create form needs to display conflicts.

**Depends on:** phase 3.7.
**Ships independently:** yes.

## Task 1: Write operations on the provider

**Files:** modify `bitbucket-cloud.provider.ts`, `bitbucket-mapper.ts`, `forge-method-handler.ts`.

**Requirements:**

1. `setReviewStatus` and `merge` are implemented against the real endpoints, and the provider's `capabilities` flips the corresponding flags to `true`. The buttons then appear with **no UI change** — that is what the capability mechanism is for, and phase 3 deliberately set them false rather than rendering controls that did nothing.
2. `setReviewStatus` carries the optional body the interface already declares. Bitbucket ignores it; GitHub requires it when requesting changes.
3. **Mergeability becomes real.** `mapPullRequestDetail` currently hardcodes `mergeable: 'unknown'`, so the ⚠ conflicted header the UI already renders can never fire. Bitbucket's diffstat conflict status is the cheapest signal available and the mapper currently folds it into `'modified'` — a deferred item recorded as cosmetic during phase 3, which it stops being the moment this phase exists. Surface it.
4. **Read-after-write must have a stated position.** Approving and immediately re-fetching can return a participant list that does not yet show the approval. Choose optimistic local update or refetch-and-tolerate-lag, implement it, and say which in the report. Undecided, this surfaces later as a flaky "approving sometimes does not update the chip" defect and costs a fix round on eventual consistency.
5. Every write invalidates the affected cache keys and broadcasts `forge.changed`, as the existing write paths do.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Approving updates reviewer state and the sidebar reflects it. |
| 2 | Requesting changes carries a body when one is supplied. |
| 3 | A pull request with a conflicting diffstat reports `mergeable: 'conflicted'` and the ⚠ header renders. |
| 4 | The chosen read-after-write behaviour is tested explicitly, including the lag case. |
| 5 | A blocked merge surfaces the host's own reason verbatim rather than a generic failure. |

## Task 2: Merge confirmation

**Requirements:** merging asks for confirmation naming the pull request, the strategy and the target branch. Approving does not — it can be undone; merging cannot. Available strategies come from `capabilities.mergeStrategies`, never a hardcoded list.

**Acceptance:** the dialog names all three facts; cancelling performs no request; only the provider's declared strategies are offered.

### Phase 6 acceptance-clause → task

| Roadmap clause | Task |
|---|---|
| approving updates state on host and sidebar | 1 |
| merge asks for confirmation naming PR and strategy | 2 |
| blocked merge surfaces the host's reason | 1 |
| capability flags flip, no UI change | 1 |

---

# Phase 5 — Creating pull requests

**The schedule risk of the remaining work — not phase 7.** Everything else extends an idiom that exists. This is the first multi-field, validating, submitting surface in the webview: `components/detail/` is entirely read-only today, and the current input idiom is one-shot `ui.inputBox` calls, which the spec explicitly rejects for this flow. The form gets its own task; the context menu item is ten lines and does not share it.

**Depends on:** phase 3.7.
**Ships independently:** yes.

## Task 1: Interface additions, with a GitHub feasibility check

**Requirements:**

1. The form defaults the target branch to the repository's default branch, and the interface has no way to obtain it. Add a repo-info method — both hosts return it in one cheap, cacheable GET.
2. Reviewers are supplied as account ids, and nothing currently produces candidates for a pull request that does not yet exist. Add a suggestion source, and **be modest about its contract**: Bitbucket's default-reviewers endpoint as suggestions, not a workspace member directory. GitHub's nearest equivalent is paginated and permission-gated, and a "list everyone" promise is exactly the kind phase 7 then cannot keep.
3. Both additions are presented in the report as interface changes with a stated GitHub feasibility answer, not as Bitbucket conveniences.
4. **Duplicate classification becomes reachable.** The code comment currently promises that this phase branches on `'duplicate'`, but `classify` takes only a status, so nothing can produce that kind. Make classification body-aware for the create path. Without this, the spec's duplicate row ships unimplemented the same way the changed-files list nearly did.

**Acceptance:** default target branch comes from the host; suggestions are labelled as suggestions in the UI; a duplicate attempt produces `kind: 'duplicate'` and reports the existing pull request with a link.

## Task 2: The create form

**Requirements:** title defaulting to the last commit subject; description; target branch; reviewers; close-source-branch. It opens in the detail panel, not as a chain of input boxes — four sequential prompts lose everything to a single Escape. Errors display the host's message verbatim, per the spec's error table.

**Acceptance:**

| # | Test obligation |
|---|---|
| 1 | Escape or cancel preserves entered values rather than discarding the form. |
| 2 | Submitting creates the pull request and it appears in the list without a manual refresh. |
| 3 | A duplicate attempt names the existing pull request and offers to open it. |
| 4 | A host error renders the host's own text. |

## Task 3: The context menu item

**Requirements:** `Create Pull Request...` joins the branch context menu, and appears **only** when the branch has an upstream — an unpushed branch has nothing to open a pull request from.

**Acceptance:** absent for a branch with no upstream; present and opening the form for one with an upstream.

### Phase 5 acceptance-clause → task

| Roadmap clause | Task |
|---|---|
| create from a branch with an upstream | 2, 3 |
| appears in the list without manual refresh | 2 |
| menu item absent without an upstream | 3 |
| duplicate reports the existing PR | 1, 2 |

---

# Phase 7 — The GitHub provider

**Depends on:** phases 4-6.
**Ships independently:** yes.
**This phase is the test of the whole abstraction.**

## Task 1: The instrument, before any implementation

**Requirements:** a test or script asserting that this phase's diff touches only `forge/github/`, one hunk of `extension.ts`, and the coverage lines of `vitest.config.ts`. Written and committed **first**.

**Why first:** without it the acceptance criterion is enforced by whoever remembers it, and the phase 3.7 findings show exactly how shared-code leaks happen — one small handler fallback at a time.

**Named trap:** extracting a shared request queue during this phase would itself violate the criterion. Accept duplicated queue code inside `github/` — GitHub's rate limiting differs anyway (403 with a remaining-count header, secondary limits with `Retry-After`), and `ForgeError.retryAfterSeconds` plus provider-owned classification already accommodate it. Extraction belongs to phase 8. Do not let this phase grant itself a "shared refactor" exemption; that exemption is how the criterion dies.

## Task 2: The provider

**Requirements:** implement `ForgeProvider` for GitHub, authenticating through VS Code's built-in provider rather than a bespoke flow. Register it. Omit `signOut` — phase 3.7 made it optional precisely because this provider cannot implement it.

**Acceptance:** GitHub pull requests appear in the same UI with no change outside `forge/github/` and one registry registration, asserted by task 1's instrument. Any change required elsewhere is a defect in the interface and is fixed there, not worked around here.

---

# Phase 8 — Close the ledger

**Depends on:** nothing; can run any time after phase 4.
**Ships independently:** yes.

**Deliverable:** every item in the phases 1-3 deferred list is either closed or carries a recorded won't-fix ruling.
**Acceptance criterion:** exactly that — a criterion that can be checked. "Clean up leftovers" is not one, and a phase without a real criterion never ships.

**In scope:** the untested 429 branches (page cap, HTTP-date parsing, deadline extended mid-sleep); the corrupt-stored-secret test; the manifest-label drift; the weak traversal assertion and the untested `async` on `getPullRequestDiff`; the duplicated filter predicate, unless phase 5 already touched those files; the two overlapping sign-in round-trips; the `#42` badge's accessible name; `forgeStore.clear()` scoping to the affected repository; a byte cap instead of a count cap on the immutable cache; the shared request-queue extraction deferred out of phase 7; and **`svelte-check`**, which the final review recommends before phase 5 — `src/webview/**` is excluded from both tsconfigs, so the forge logic in `App.svelte` is neither type-checked nor covered.

**Closed as won't-fix, with reasons recorded:** the `pr.id` `'0'` collision (requires two pull requests missing ids — the mapper default is a last resort, not a state the host produces); the host-wiring placement assertion's strictness (a false-fail on a refactor nobody is proposing); proactively deleting a corrupt stored secret (the fail-safe path is already correct).

---

# Roadmap

| Phase | Deliverable | Depends on | Ships alone | Acceptance |
|---|---|---|---|---|
| **3.7** | Interface amendments: optional `signOut`, `ForgeComment.side`, `ReviewStatus.commented`, `'not-found'` via `describeError`, reviewer-degradation contract | phase 3 (shipped) | No — invisible, but safe to merge | All five amendments land; `FakeForgeProvider` satisfies the interface with no cast; Bitbucket behaviour unchanged apart from one message |
| **4** | AI review of a pull request, from either panel | 3.7 | Yes | A pull request whose branch was never fetched reviews successfully; history shows `PR #n <title>`; prior discussion reaches the payload; file rows open a diff |
| **6** | Approve, request changes, merge | 3.7 | Yes | Approving updates host and sidebar; merge confirms naming PR, strategy and target; a conflicting PR renders the ⚠ header; a blocked merge shows the host's reason |
| **5** | Creating pull requests | 3.7 | Yes | Created from a branch with an upstream and appears without manual refresh; menu item absent without one; a duplicate reports the existing PR |
| **7** | GitHub provider | 4, 5, 6 | Yes | GitHub pull requests appear in the same UI with **no change outside `forge/github/`** plus one registry registration, asserted by an instrument written before any implementation |
| **8** | Ledger closed | after 4 | Yes | Every deferred item is closed or carries a recorded won't-fix ruling |

**Order: 3.7 → 4 → 6 → 5 → 7 → 8.** Phases 4, 5 and 6 depend only on phase 3 structurally, but 5 and 6 both edit the provider, the handler, the detail panel and `App.svelte`, so they serialise in practice — and running implementers concurrently against shared files is a cost this project has already paid. Given they serialise anyway, order them by what each teaches the next: 4 first for user value and because it stress-tests the comment and diff model earliest; 6 before 5 because it is half the size and forces the mergeability question before the create form needs to display conflicts; 5 last because its form is the largest genuinely new surface.

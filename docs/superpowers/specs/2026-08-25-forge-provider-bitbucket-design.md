# Forge Provider Layer — Pull Requests in the Graph (Bitbucket Cloud first)

## Overview

Git Graph Pro is today entirely local: it shells out to `git` and runs AI review over
diffs it computes itself. Nothing in `src/` talks to a hosting service. Pull requests,
however, do not exist in git — a PR, its reviewers, its approval state and its comments
live only on the host. Showing them requires an authenticated API client.

This spec introduces a **forge provider layer**: a provider-neutral interface plus one
implementation for Bitbucket Cloud. It delivers three capabilities:

1. **See** open pull requests in the graph sidebar, tied to the branches they came from.
2. **Act** on them — create, approve, request changes, merge.
3. **Review** them with the existing AI pipeline, using the PR's own diff and discussion.

A second provider (GitHub) is expected. The interface exists for that reason and is
validated by a fake implementation used throughout the tests.

## Global Constraints

- **The forge layer is additive.** Any forge failure — no network, dead token, host
  outage — is contained in the PR section and its detail panel. The graph, the diff
  viewer and AI review behave exactly as they do today.
- **Tokens never reach the webview.** All API calls run in the extension host; the
  webview receives mapped domain objects only. No token value is ever written to a log,
  including error logs.
- **No provider vocabulary escapes `bitbucket/`.** Everything above that directory speaks
  the neutral model in `forge.types.ts`.
- **No background polling in v1.** Bitbucket Cloud allows roughly 1000 requests/hour and
  offers no cheap change signal for pull requests.
- Tests never call a live API.

## Why an interface rather than a direct Bitbucket client

Three reasons, in order of weight:

1. **Testability.** A `FakeForgeProvider` lets the controller, the cache and the whole UI
   run under vitest with no network and no fixtures-per-endpoint.
2. **A second provider is planned.** GitHub is expected, not hypothetical.
3. **Auth is nearly free for GitHub.** VS Code ships a built-in `github` authentication
   provider, so `GitHubProvider.getSession()` reduces to
   `vscode.authentication.getSession('github', scopes)`.

## Part 1: The Forge Layer

### Files

```
src/extension/services/forge/
├── forge.types.ts               # neutral domain model + ForgeProvider + ForgeCapabilities
├── remote-url.ts                # parse a git remote URL → ParsedRemote
├── forge-registry.ts            # ParsedRemote → provider
├── forge-store.ts               # per-repo cache with TTLs
└── bitbucket/
    ├── bitbucket-cloud.provider.ts
    ├── bitbucket-api.ts         # HTTP, concurrency queue, 429 handling
    ├── bitbucket-auth.ts        # vscode.AuthenticationProvider
    └── bitbucket-mapper.ts      # Bitbucket JSON → neutral model
```

`src/extension/services/forge/github/` is created empty in a later phase, not now.

### Domain model

```ts
export interface ParsedRemote { host: string; owner: string; name: string; }
export interface ForgeRepoRef { owner: string; name: string; }
export interface ForgeUser { displayName: string; accountId: string; avatarUrl?: string; }

export type PullRequestState  = 'open' | 'merged' | 'closed' | 'draft';
export type ReviewStatus      = 'approved' | 'changes_requested' | 'pending';
export type MergeStrategy     = 'merge-commit' | 'squash' | 'fast-forward';
export type MergeableState    = 'clean' | 'conflicted' | 'blocked' | 'unknown';

export interface PullRequestSummary {
  id: string;              // string, not number — providers disagree on the type
  number: number;          // what the UI shows
  title: string;
  state: PullRequestState;
  author: ForgeUser;
  sourceBranch: string;
  targetBranch: string;
  reviewers: { user: ForgeUser; status: ReviewStatus }[];
  commentCount: number;
  webUrl: string;
  updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  sourceCommit: string;    // the sha that ties this PR to a node in the graph
  targetCommit: string;
  mergeable: MergeableState;
}

export interface ForgeComment {
  id: string;
  author: ForgeUser;
  body: string;
  createdAt: string;
  parentId?: string;       // threading
  path?: string;           // inline comments
  line?: number;
}

export interface CreatePullRequestInput {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers?: string[];    // account ids
  closeSourceBranch?: boolean;
}

export interface ForgeCapabilities {
  createPullRequest: boolean;
  approve: boolean;
  requestChanges: boolean;
  merge: boolean;
  mergeStrategies: MergeStrategy[];
}

/** What a signed-in provider exposes upward. Never carries the credential. */
export interface ForgeSession {
  providerId: string;
  accountLabel: string;    // display name, for the Accounts menu and the sidebar
}

/** Every non-2xx response becomes one of these. */
export class ForgeError extends Error {
  constructor(
    readonly status: number,
    readonly hostMessage: string,
    readonly retryAfterSeconds?: number,
  ) { super(hostMessage); }
}
```

### The interface

```ts
export interface ForgeProvider {
  readonly id: string;                      // 'bitbucket-cloud'
  readonly name: string;                    // 'Bitbucket'
  readonly capabilities: ForgeCapabilities;
  canHandle(remote: ParsedRemote): boolean;

  getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined>;
  signOut(): Promise<void>;

  listPullRequests(repo: ForgeRepoRef, opts: { state: 'open' | 'merged' | 'closed' }): Promise<PullRequestSummary[]>;
  getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail>;
  getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string>;
  listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]>;

  createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail>;
  setReviewStatus(repo: ForgeRepoRef, id: string, status: 'approved' | 'changes_requested'): Promise<void>;
  merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void>;
}
```

A draft pull request is an open one: `state: 'open'` in `listPullRequests` returns drafts,
and `PullRequestSummary.state` reports `'draft'` for them so the sidebar can mark them.
`'draft'` is therefore never passed as a list filter, which is why that filter type is
narrower than `PullRequestState`.

`capabilities` is declared rather than discovered, and the UI hides unsupported actions
instead of disabling them or letting the call fail. The providers genuinely diverge:
Bitbucket calls a closed PR `declined` where GitHub calls it `closed`; GitHub requires a
body when requesting changes and Bitbucket does not; the two support different merge
strategies.

### Repository detection

`GitService` gains `getRemoteUrl(remote = 'origin')`, backed by
`git config --get remote.<name>.url`.

`remote-url.ts` parses the three forms in use:

```
git@bitbucket.org:workspace/repo.git
https://user@bitbucket.org/workspace/repo.git
ssh://git@bitbucket.org/workspace/repo.git
```

and yields `{ host, owner, name }`, with the trailing `.git` and any userinfo stripped.
Anything unparseable yields `undefined` — never a throw, because every repository in the
workspace goes through this on load.

`ForgeRegistry.resolve(remote)` returns the first registered provider whose `canHandle`
matches. No match means the feature is absent, not broken.

The resolution is cached per repository path and cleared by
`RepositorySession.invalidate()`, which already runs on `repo.switch`. Each submodule
resolves independently, so a superproject and its submodules can map to different repos
on the same host.

The remote name is configurable via `gitGraphPro.forge.remote` (default `origin`) for
fork-based workflows.

## Part 2: Authentication

> **Corrected 2026-08-27.** This section originally stated the scheme as settled fact —
> HTTP Basic, `/2.0/user` as the verify probe, a `read:user:bitbucket` scope — and all
> three were wrong for at least one real user. A newly created, correctly scoped token
> got a blanket 403 on every endpoint. What follows replaces that account; see
> `.superpowers/sdd/signin-ux-fix-report.md` in the `fix-signin` worktree for the incident
> this correction responds to and the documentation research behind it.

### Decision: API tokens or access tokens, not OAuth — sent as Bearer, unconditionally

Bitbucket Cloud **removed app passwords on 28 July 2026**. Its replacements are two
distinct token families, and this extension accepts either:

- **API tokens**, created at id.atlassian.com, tied to an Atlassian account.
- **Access tokens** (repository, project or workspace), created in Bitbucket's own
  settings, tied to a resource rather than an account.

Atlassian's own documentation (`support.atlassian.com/bitbucket-cloud/docs/using-api-tokens`,
`.../using-access-tokens`) establishes the schemes each accepts: an API token can be sent
either as HTTP Basic (`email:token`) or as a Bearer token — the docs call Bearer
"recommended" and note it "removes the need to provide the Atlassian email tied to the
API token." An access token accepts **only** Bearer; it has no email or username at all.

Bearer is therefore the intersection of what both families accept, and `bitbucket-api.ts`
sends it unconditionally on every request. This is deliberately *not* a scheme-detection
or scheme-memory mechanism — there is only one scheme, so nothing needs detecting or
remembering, and a user signs in with either kind of token without this extension ever
asking which one it is. Because Bearer needs nothing besides the token, the sign-in
prompt asks for the token alone — there is no email step, and `BitbucketCredentials`
(bitbucket-auth.ts) has no field for one. The session label a user sees in the Accounts
menu comes from the repository being verified instead (see the `createSession` steps
below), not from anything the user types.

OAuth 2.0 remains available but is rejected for v1 on three grounds:

- **Creating an OAuth consumer requires workspace admin rights.** An API token is bound to
  a personal Atlassian account and needs no administrator. For a developer inside a
  company workspace this is often the difference between the feature working and not.
- Bitbucket Cloud **does not support PKCE**, so an authorization-code flow needs a
  `client_secret`, which a VS Code extension cannot keep secret.
- The machinery — loopback callback server on a pinned port, CSRF `state`, token exchange,
  and single-flight refresh of a 2-hour token — is substantial, and buys an automatic
  refresh the user would otherwise perform once a year.

Atlassian recommends OAuth for broadly distributed multi-user apps. This extension is
`"private": true` and used by its author's team.

The choice is confined to `bitbucket/`. Adding OAuth later changes nothing above that
directory.

### `BitbucketAuthProvider`

Registered as a `vscode.AuthenticationProvider` with id `bitbucket-cloud` and declared in
`package.json` under `contributes.authentication`. This yields the VS Code Accounts menu
entry, its sign-out affordance, and session-change events for free. An authentication
provider is not obliged to run a browser flow — a session built from an input box is a
valid session.

```
createSession():
  1. input box — API token or access token (password: true)
  2. resolve the repository the user currently has open (the configured remote,
     parsed and matched to this host — independent of forge-method-handler's own
     resolution, since createSession is reached through vscode.authentication's
     out-of-process round trip, which carries only the requested scopes)
  3. GET /2.0/repositories/{workspace}/{repo_slug} on that repository → validate immediately
  4. SecretStorage['forge:bitbucket-cloud:token'] = { token, accountLabel }
     accountLabel = the repository's workspace name, else its full name, else the
     repository owner — whichever is first available; session.account.label reads it
```

Step 3 exists so a mistyped or under-scoped token fails at the moment of entry, rather
than surfacing later as an unexplained empty PR list. It checks the repository the user
already has open, not `/2.0/user`: nothing in this extension reads user data for any
other reason, and asking for permission to do so anyway is what let a token correctly
scoped for every real feature still fail sign-in with a 403. A repository with no
Bitbucket remote open cannot reach step 1 at all — `gitGraphPro.forge.signIn` and the
webview's `forge.signIn` both resolve the repository through `requireForge()` before
`createSession` is ever invoked, so the ordinary "no forge repo" case is already handled
above this flow, not inside it. Step 2 fails sensibly (a readable rejection, not a crash)
in the narrow race where that resolution is lost between the two.

A credential stored by an earlier version of this extension — back when the sign-in
prompt still asked for an email — carries a stray `email` field alongside `token` and
`accountLabel`. `BitbucketAuthProvider.load()` reads only `token` and `accountLabel` out
of whatever JSON it finds and rebuilds the object from those two, so that entry loads
into a valid session on this version too; the email is dropped, never migrated forward,
since nothing here has a use for it.

Required token scopes, which the sign-in prompt must list verbatim:
`read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`.
No user-read scope: nothing calls a user endpoint.

There is no refresh and no expiry tracking. A 401 clears the session, fires
`onDidChangeSessions`, and returns the sidebar to its signed-out row.

`signOut()` deletes the stored token. Nothing else is retained, because nothing else is
stored.

## Part 3: API Client, Cache, Controller

### `bitbucket-api.ts`

A thin typed HTTP layer over REST API 2.0 with `Authorization: Bearer {token}`, sent
unconditionally — see Part 2 above for why this is the one scheme that serves both
Bitbucket token families without this layer needing to know which kind a stored
credential is.

It owns two protections:

- **Concurrency cap of 4.** Opening the PR section fires a list, a detail and a diffstat
  at once; unbounded fan-out across several repositories exhausts the hourly budget.
- **429 handling.** On a rate-limit response the queue pauses for `Retry-After` and the UI
  shows a countdown. Without this a single limit breach becomes twenty identical error
  toasts.

Every non-2xx response is translated into a typed `ForgeError` carrying `status` and the
host's own message. `401` and `403` are distinguished deliberately: a 403 is almost always
a missing scope, and telling the user to sign in again makes them repeat the same
under-scoped token until they conclude the extension is broken.

### `forge-store.ts`

| Data | Key | TTL |
|---|---|---|
| PR list | `provider:owner/name:state` | 60s |
| PR detail, comments | `provider:owner/name:pr:{id}` | 5 min |
| PR diff | `provider:owner/name:{sourceCommit}..{targetCommit}` | unbounded |

The diff cache never expires because its key is a pair of shas: new commits on the PR
produce a different `sourceCommit` and therefore a different key. The content behind a
given key is immutable, so a stale read is impossible.

Refresh happens when the section is opened, when refresh is pressed, after any write, and
**after a push or fetch performed from the extension** — pushing to a PR's source branch is
the most common reason its state changes, and the extension is the first to know.

### `forge-method-handler.ts`

Namespace `forge`, registered alongside `git`, `graph` and `review`.

```
forge.status              → { available, providerId, providerName, signedIn, repo, capabilities }
forge.signIn / forge.signOut
forge.pr.list             { state }
forge.pr.get              { id }
forge.pr.diff             { id }
forge.pr.comments         { id }
forge.pr.create           { title, description, sourceBranch, targetBranch, reviewers, closeSourceBranch }
forge.pr.setReviewStatus  { id, status }
forge.pr.merge            { id, strategy, closeSourceBranch }
forge.pr.openExternal     { id }
```

`forge.status` is the single gate the webview consults first. Writes invalidate the
affected cache keys and then `broadcast('forge.changed')` through `RouterRegistry`, so the
graph and the review panel update together.

## Part 4: AI Review of a Pull Request

The AI layer needs no change. `ReviewRunner.start()` already accepts a pre-assembled
`payloadText`, and `buildReviewPayload()` already accepts a plain diff string plus file
summaries and commit subjects. A diff fetched from the API flows straight through.

Two things do change.

### `forge.pr.diff` is local-first

```
both sourceCommit and targetCommit present locally?
  yes → git diff targetCommit...sourceCommit
  no  → GET /2.0/repositories/{owner}/{name}/pullrequests/{id}/diff
```

The local path is faster, spends no rate-limit budget, and works offline. It is also
equivalent: Bitbucket builds a PR diff from the merge base, which is exactly
`target...source` — the same computation the graph's "2 Branches" review mode performs.

### A new review target kind

`ReviewTargetKind` gains `'pr'`, touching `review-store.ts`, `review-target.ts` (including
its `KINDS` validation set) and `review-key.ts`.

```ts
interface PullRequestTargetRef {
  kind: 'pr';
  prId: string;
  prNumber: number;
  providerId: string;   // so an old review is not reinterpreted once GitHub is added
  baseRef: string;      // target branch, for display
  headRef: string;      // source branch
  subject?: string;     // PR title
}
```

`resolveReviewTarget()` must take a separate branch for `'pr'` and **must not call
`revParse`**: a pull request can point at a branch the local repository has never fetched,
and the existing code would fail with "Cannot resolve … it may have been deleted". The
shas come from `PullRequestDetail.sourceCommit` / `targetCommit`.

Review history then reads `PR #123 fix(auth): refresh token race` instead of a sha pair.

### Prior discussion in the payload

`ReviewPayloadInput` gains `priorDiscussion?: string`. Existing PR comments are rendered
into a section ahead of the diff so the model knows what the team has already found and
does not repeat it. This is the only change to `review-payload.ts`.

### UI

A fourth mode, `[Pull Request]`, joins `[1 Commit] [2 Commits] [2 Branches]` in the review
panel. It reuses `Combobox.svelte` to pick from open PRs, then shows changed files and
reviewer status before the existing Review button. The PR detail panel in the sidebar also
carries a `Review with AI` button that opens this mode with the PR preselected.

## Part 5: Sidebar and Detail UI

### The `PULL REQUESTS` section

`BranchSidebar.svelte` already carries six collapsible sections, and its own comment at
line 142 notes that six expanded sections push the branch list — the thing the user came
for — off screen. The seventh section therefore **defaults to collapsed**.

It is hidden entirely when `forge.status.available === false`. When the repository is
supported but the user is signed out, the section renders exactly one row,
`Sign in to Bitbucket` — not an empty section and not a modal.

```
▸ PULL REQUESTS                    4
  ● #123  fix(auth): refresh token race      ✓2  ⌥1
  ● #119  feat(graph): column resize         ✓1
  ◐ #118  chore: bump deps                   ⧗
  ● #112  refactor: extract review store     ✗1
```

The sidebar's existing search input also filters pull requests, by number, title and
source branch name.

### Tying pull requests to the graph

This is what justifies placing pull requests in the sidebar rather than only in the review
panel. A branch row that is the source of a pull request carries a `#123` badge. Selecting
a pull request scrolls the graph to its `sourceCommit` and selects it, reusing the
`graph.getRow` mechanism already built for commit search.

### `PullRequestDetail.svelte`

Rendered in the right-hand detail panel, reusing `FileTreeList.svelte`.

```
#123  fix(auth): refresh token race            [Open in browser]
feature/RMS-1027  →  develop            ● Open   ⚠ conflicted
─────────────────────────────────────────────────────────────
description
─────────────────────────────────────────────────────────────
Reviewers   ✓ an.tran   ✗ minh.le   ⧗ hoa.pham
─────────────────────────────────────────────────────────────
Files (12)      ← FileTreeList; clicking opens the existing diff editor
─────────────────────────────────────────────────────────────
Comments (8)    ← read-only, threaded; inline comments show file:line
─────────────────────────────────────────────────────────────
[Review with AI]  [Approve]  [Request changes]  [Merge ▾]
```

The action row is driven by `capabilities`: an unsupported action is absent, not disabled.

Comments are read-only in v1. The extension does not post AI review output back to the
pull request.

### Creating a pull request

A `Create Pull Request...` item joins the branch context menu built in
`App.svelte`'s `handleBranchContextMenu`, alongside `Push`, `Fetch` and `Rename`. It
appears only when the branch has an upstream — an unpushed branch has nothing to open a
pull request from.

The form opens in the detail panel rather than as a chain of `ui.inputBox` prompts: title
(defaulting to the last commit subject), description, target branch (defaulting to the
repository's default branch), reviewers, and a close-source-branch checkbox. A sequence of
four input boxes loses everything to a single Escape.

### Merge confirmation

Merging opens a confirmation naming the pull request, the strategy and the target:
*"Merge #123 into develop using squash?"*. Approving needs no confirmation — it can be
undone. Merging cannot.

## Part 6: Error Handling

| Condition | Behaviour |
|---|---|
| Remote matches no provider | `available: false`; section hidden; nothing logged |
| Signed out | Single `Sign in to Bitbucket` row |
| 401 | Clear session → signed-out row, "API token expired or revoked" |
| 403 | Name the missing scopes, offer a link to the token settings page |
| 404 on the repository | "Cannot access `owner/name` — private repository or insufficient token scope" |
| 429 | Pause the queue for `Retry-After`, show a countdown |
| Network failure | Keep the cached data on screen, marked *stale · updated 12 minutes ago* |
| Merge rejected | Surface the host's own reason verbatim; never collapse it to "merge failed" |
| Duplicate pull request | Catch specifically: "PR #118 already exists for these branches" + open button |

## Part 7: Testing

The repository has 62 test files and coverage thresholds of 80/80/80/70 over an explicit
include list in `vitest.config.ts`. Every new forge file is added to that list.

- **`FakeForgeProvider`** implements `ForgeProvider` and drives the controller and UI tests
  with no network. This is the concrete return on the abstraction.
- **`bitbucket-mapper.ts`** is tested against real captured Bitbucket JSON in
  `tests/fixtures/bitbucket/`. The mapper is both the likeliest place for a defect and the
  easiest to pin down.
- **`remote-url.ts`** — a table of ssh, https and scp-style URLs, with and without `.git`,
  other hosts, and malformed input.
- **Auth** — storing and clearing a token; a 401 clearing the session; and an assertion
  that the token string never appears in anything written to the console.
- **Cache** — TTL expiry, invalidation after writes, and the diff key deriving from the
  sha pair.
- **Rate limiting** — a 429 with `Retry-After` pauses and then resumes the queue.
- **`resolveReviewTarget` with kind `'pr'` never calls `revParse`**, asserted with a spy.
  This is the regression test for a pull request whose branch was never fetched.

No test contacts a live API.

## Roadmap

Phases 4, 5 and 6 each depend only on Phase 3 and are independent of one another.

### Phase 1 — Forge foundation and detection

- **Deliverable:** `forge.types.ts`, `remote-url.ts`, `forge-registry.ts`,
  `GitService.getRemoteUrl()`, `FakeForgeProvider`. No UI change; no Bitbucket code.
- **Depends on:** nothing.
- **Acceptance:** the URL parse table passes; `forge.status` reports `available: false`
  for a GitHub remote and for a repository with no remote, and reports the correct
  `owner/name` for a Bitbucket remote; existing tests still pass.
- **Ships independently:** no — invisible to users, but safe to merge.

### Phase 2 — Authentication

- **Deliverable:** `bitbucket-auth.ts`, `contributes.authentication`, sign-in and sign-out
  commands.
- **Depends on:** Phase 1.
- **Acceptance:** signing in with a scoped API token stores it in SecretStorage and shows
  the account in the VS Code Accounts menu; a bad token is rejected at entry; sign-out
  removes it; the log-redaction test passes.
- **Ships independently:** no — nothing consumes the session yet.

### Phase 3 — Read-only pull requests

- **Deliverable:** `bitbucket-api.ts`, `bitbucket-mapper.ts`, the read half of
  `bitbucket-cloud.provider.ts`, `forge-store.ts`, the read methods of
  `forge-method-handler.ts`, the `PULL REQUESTS` sidebar section, `PullRequestDetail.svelte`,
  and the `#123` badge on branch rows.
- **Depends on:** Phase 2.
- **Acceptance:** a real repository lists its open pull requests; opening one shows
  description, reviewers, files and comments; selecting one scrolls the graph to its
  source commit; a signed-out state shows one row; a non-Bitbucket repository shows no
  section at all.
- **Ships independently:** **yes — this is the first useful milestone.**

### Phase 4 — AI review of a pull request

- **Deliverable:** the `'pr'` target kind across `review-store`, `review-target` and
  `review-key`; local-first `forge.pr.diff`; `priorDiscussion` in `review-payload.ts`; the
  `[Pull Request]` review mode; the `Review with AI` button.
- **Depends on:** Phase 3.
- **Acceptance:** selecting a pull request and running a review produces a review filed as
  `PR #123 <title>`; a pull request whose branch was never fetched reviews successfully
  via the API diff; the `revParse` spy assertion passes.
- **Ships independently:** yes.

### Phase 5 — Creating pull requests

- **Deliverable:** `forge.pr.create`, the detail-panel form, the
  `Create Pull Request...` context menu item.
- **Depends on:** Phase 3.
- **Acceptance:** a pull request is created from a branch with an upstream and appears in
  the list without a manual refresh; the menu item is absent for a branch with no
  upstream; a duplicate attempt reports the existing pull request.
- **Ships independently:** yes.

### Phase 6 — Approve, request changes, merge

- **Deliverable:** `forge.pr.setReviewStatus`, `forge.pr.merge`, the confirmation dialog,
  and `capabilities` gating of the action row.
- **Depends on:** Phase 3.
- **Acceptance:** approving updates the reviewer state on the host and in the sidebar;
  merging asks for confirmation naming the pull request and strategy; a blocked merge
  surfaces the host's reason.
- **Ships independently:** yes.

### Phase 7 — GitHub provider

- **Deliverable:** `forge/github/` implementing `ForgeProvider`, authenticated through
  VS Code's built-in `github` provider.
- **Depends on:** Phases 3–6.
- **Acceptance:** GitHub pull requests appear in the same UI with **no change outside
  `forge/github/` and one registry registration**. Any change required elsewhere is a
  defect in the Phase 1 interface and is fixed there.
- **Ships independently:** yes. This phase is the real test of the abstraction.

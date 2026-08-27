import * as vscode from 'vscode';
import {
  ForgeError,
  type CreatePullRequestInput, type ForgeCapabilities, type ForgeComment, type ForgeProvider,
  type ForgeRepoInfo, type ForgeRepoRef, type ForgeSession, type ForgeUser, type MergeStrategy, type ParsedRemote,
  type PullRequestDetail, type PullRequestFile, type PullRequestListState, type PullRequestSummary,
} from '../forge.types';
import type { GitHubApi } from './github-api';
import { GITHUB_AUTH_ID, GITHUB_PROVIDER_LABEL, GITHUB_TOKEN_SCOPES } from './github-constants';
import {
  mapComments, mapFiles, mapPullRequestDetail, mapPullRequestSummary, mapUser,
  type RawIssueComment, type RawPullRequest, type RawReview, type RawReviewComment, type RawUser,
} from './github-mapper';

const PAGE_SIZE = 100;

/** GitHub's `state` query param has no third "merged" value — see `listPullRequests`. */
const STATE_QUERY: Record<PullRequestListState, 'open' | 'closed'> = {
  open: 'open',
  merged: 'closed',
  closed: 'closed',
};

const REVIEW_EVENT: Record<'approved' | 'changes_requested', string> = {
  approved: 'APPROVE',
  changes_requested: 'REQUEST_CHANGES',
};

/**
 * GitHub's merge endpoint expects one of these three method names.
 * `Partial` rather than `Record<MergeStrategy, string>` for the same reason
 * as Bitbucket's equivalent map: this provider's own
 * `capabilities.mergeStrategies` only ever offers the three keys below —
 * GitHub has no fast-forward-only merge in its API — so a strategy this
 * provider never declared support for becomes an explicit rejection in
 * `merge()` rather than an unmapped value forwarded to the host.
 */
const MERGE_METHOD_PARAM: Partial<Record<MergeStrategy, string>> = {
  'merge-commit': 'merge',
  squash: 'squash',
  rebase: 'rebase',
};

export interface GitHubProviderDeps {
  api: GitHubApi;
}

export class GitHubCloudProvider implements ForgeProvider {
  public readonly id = GITHUB_AUTH_ID;
  public readonly name = GITHUB_PROVIDER_LABEL;

  public readonly capabilities: ForgeCapabilities = {
    createPullRequest: true,
    approve: true,
    requestChanges: true,
    merge: true,
    mergeStrategies: ['merge-commit', 'squash', 'rebase'],
  };

  // Deliberately no `signOut` member at all — not even one that throws. This
  // provider only *consumes* VS Code's built-in `github` authentication
  // provider; it does not own it, and has no API to remove a session from
  // it. `ForgeProvider.signOut` is optional precisely for this case: the
  // shared `forge.signOut` handler answers with Accounts-menu guidance when
  // this member is absent, and the 401-cleanup path skips it while still
  // invalidating the cache and broadcasting `forge.changed` on its own.

  constructor(private readonly deps: GitHubProviderDeps) {}

  public canHandle(remote: ParsedRemote): boolean {
    return remote.host === 'github.com';
  }

  /**
   * Routed through vscode.authentication.getSession — the built-in `github`
   * provider, not a bespoke flow. `createIfNone` defaults to false so a
   * caller that omits it — `forge.status` runs on every panel load — never
   * puts a sign-in prompt in front of someone who never asked.
   */
  public async getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined> {
    const session = await vscode.authentication.getSession(
      GITHUB_AUTH_ID,
      [...GITHUB_TOKEN_SCOPES],
      { createIfNone: opts?.createIfNone ?? false },
    );
    return session ? { providerId: GITHUB_AUTH_ID, accountLabel: session.account.label } : undefined;
  }

  /**
   * GitHub's `state` query has no "merged" value — merged pull requests are
   * simply closed ones with `merged_at` set — so a 'merged' or 'closed'
   * request both query `state=closed` and are told apart afterwards by the
   * mapped `state`, which `mapPullRequestSummary` already derives from
   * `merged_at`.
   */
  public async listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]> {
    const raw = await this.deps.api.getPaged<RawPullRequest>(
      `${this.base(repo)}/pulls?state=${STATE_QUERY[opts.state]}&per_page=${PAGE_SIZE}`);
    const mapped = raw.map(mapPullRequestSummary);
    if (opts.state === 'open') return mapped;
    return mapped.filter((pr) => pr.state === opts.state);
  }

  /**
   * Also fetches the review list, the same endpoint `getPullRequestFiles`
   * does not need but `mapPullRequestDetail` does — GitHub's single-PR GET
   * carries `requested_reviewers` (who is still awaited) but never a
   * submitted review's state, so the authoritative reviewer list this
   * detail view promises requires a second, per-PR call. That is the one
   * extra call the reviewer-degradation contract on
   * `PullRequestSummary.reviewers` accepts for a detail fetch, distinct
   * from the N+1 it rules out for a list.
   */
  public async getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail> {
    const base = this.base(repo);
    const [raw, reviews] = await Promise.all([
      this.deps.api.getJson<RawPullRequest>(`${base}/pulls/${encodeURIComponent(id)}`),
      this.deps.api.getPaged<RawReview>(`${base}/pulls/${encodeURIComponent(id)}/reviews?per_page=${PAGE_SIZE}`),
    ]);
    return mapPullRequestDetail(raw, reviews);
  }

  /** The diff media type turns the single-PR endpoint's response into raw diff text instead of JSON. */
  public async getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string> {
    return this.deps.api.getText(
      `${this.base(repo)}/pulls/${encodeURIComponent(id)}`,
      { Accept: 'application/vnd.github.v3.diff' },
    );
  }

  public async getPullRequestFiles(repo: ForgeRepoRef, id: string): Promise<PullRequestFile[]> {
    const raw = await this.deps.api.getPaged<Parameters<typeof mapFiles>[0][number]>(
      `${this.base(repo)}/pulls/${encodeURIComponent(id)}/files?per_page=${PAGE_SIZE}`);
    return mapFiles(raw);
  }

  /**
   * GitHub splits pull request discussion into two endpoints — general
   * (issue) comments and inline review comments — where Bitbucket's single
   * endpoint carries both; fetched concurrently and merged by
   * `mapComments` so this provider still returns one list, matching the
   * shared interface.
   */
  public async listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]> {
    const base = this.base(repo);
    const [issueComments, reviewComments] = await Promise.all([
      this.deps.api.getPaged<RawIssueComment>(`${base}/issues/${encodeURIComponent(id)}/comments?per_page=${PAGE_SIZE}`),
      this.deps.api.getPaged<RawReviewComment>(`${base}/pulls/${encodeURIComponent(id)}/comments?per_page=${PAGE_SIZE}`),
    ]);
    return mapComments(issueComments, reviewComments);
  }

  /** The repository resource itself, for `default_branch` — see `ForgeRepoInfo`. */
  public async getRepoInfo(repo: ForgeRepoRef): Promise<ForgeRepoInfo> {
    const raw = await this.deps.api.getJson<{ default_branch?: string }>(this.base(repo));
    return { defaultBranch: raw.default_branch ?? '' };
  }

  /**
   * GitHub's nearest equivalent to Bitbucket's default-reviewers endpoint:
   * the repository's collaborators — see the doc comment on
   * `ForgeProvider.listReviewerCandidates`. Paginated and gated behind
   * push/triage permission on the token; a token without it gets whatever
   * GitHub allows, which this provider does not second-guess.
   */
  public async listReviewerCandidates(repo: ForgeRepoRef): Promise<ForgeUser[]> {
    const raw = await this.deps.api.getPaged<RawUser>(`${this.base(repo)}/collaborators?per_page=${PAGE_SIZE}`);
    return raw.map(mapUser);
  }

  /**
   * `detectDuplicate: true` lets a 422 whose body names an already-open
   * pull request come back as `kind: 'duplicate'` — see github-api.ts's
   * `classify`.
   *
   * Reviewers cannot be requested in the same call: GitHub's create
   * endpoint has no `reviewers` field, only a separate
   * `requested_reviewers` endpoint hit afterwards — its response is the
   * updated pull request object, so that response (not the create
   * response) becomes `raw` when reviewers were requested. This makes
   * pull request creation on GitHub non-atomic in a way Bitbucket's single
   * call is not: a rejected reviewer (e.g. someone without collaborator
   * access) surfaces as an error even though the pull request itself now
   * exists.
   *
   * `closeSourceBranch` has nothing to act on here — the branch has not
   * merged yet, so there is nothing to delete. `merge()` is where this
   * provider honours it.
   */
  public async createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail> {
    const base = this.base(repo);
    let raw = await this.deps.api.post<RawPullRequest>(
      `${base}/pulls`,
      { title: input.title, body: input.description, head: input.sourceBranch, base: input.targetBranch },
      { detectDuplicate: true },
    );

    if (input.reviewers && input.reviewers.length > 0) {
      raw = await this.deps.api.post<RawPullRequest>(
        `${base}/pulls/${raw.number}/requested_reviewers`,
        { reviewers: input.reviewers },
      );
    }

    return mapPullRequestDetail(raw);
  }

  /**
   * GitHub requires a non-empty `body` when the event is REQUEST_CHANGES —
   * the interface carries `opts.body` as optional for exactly a provider
   * like this one, but the webview does not currently collect one for this
   * action (only for merge/approve does not need it), so an absent or
   * blank body falls back to a fixed message rather than failing every
   * "request changes" click with a validation error the UI gives no way to
   * fix.
   */
  public async setReviewStatus(
    repo: ForgeRepoRef,
    id: string,
    status: 'approved' | 'changes_requested',
    opts?: { body?: string },
  ): Promise<void> {
    const body: { event: string; body?: string } = { event: REVIEW_EVENT[status] };
    if (status === 'changes_requested') {
      body.body = opts?.body?.trim() || 'Changes requested.';
    } else if (opts?.body) {
      body.body = opts.body;
    }
    await this.deps.api.post(`${this.base(repo)}/pulls/${encodeURIComponent(id)}/reviews`, body);
  }

  public async merge(
    repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean },
  ): Promise<void> {
    const mergeMethod = MERGE_METHOD_PARAM[opts.strategy];
    if (!mergeMethod) {
      throw new ForgeError('other', 0, `GitHub does not support the '${opts.strategy}' merge strategy`);
    }
    const base = this.base(repo);
    await this.deps.api.put(`${base}/pulls/${encodeURIComponent(id)}/merge`, { merge_method: mergeMethod });

    if (opts.closeSourceBranch) {
      // Best-effort: the merge itself already succeeded, so a failure here
      // (a fork's branch this token cannot delete, a race with someone
      // else deleting it first) must not surface as a failed merge.
      await this.deleteSourceBranch(repo, id, base).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(`[github] failed to delete the source branch of pull request #${id}: ${message}`);
      });
    }
  }

  /**
   * Deletes the pull request's head branch, but only when it lives in this
   * same repository — a pull request from a fork's branch belongs to a
   * different repository this token typically cannot (and should not)
   * delete refs in.
   */
  private async deleteSourceBranch(repo: ForgeRepoRef, id: string, base: string): Promise<void> {
    const raw = await this.deps.api.getJson<RawPullRequest>(`${base}/pulls/${encodeURIComponent(id)}`);
    const headRef = raw.head?.ref;
    const headRepoFullName = raw.head?.repo?.full_name;
    const ownRepoFullName = `${repo.owner}/${repo.name}`;
    if (!headRef || headRepoFullName?.toLowerCase() !== ownRepoFullName.toLowerCase()) return;
    await this.deps.api.del(`${base}/git/refs/heads/${encodeURIComponent(headRef)}`);
  }

  /**
   * The provider-specific half of an error message — only this provider
   * knows which scopes its own token needs. The shared layer renders
   * whatever comes back and never composes advice of its own.
   */
  public describeError(error: ForgeError): string {
    if (error.kind === 'forbidden') {
      return `GitHub refused the request. The account's token is missing a scope. Required: ${GITHUB_TOKEN_SCOPES.join(', ')}.`;
    }
    if (error.kind === 'not-found') {
      return 'Cannot access this repository or pull request on GitHub — it may be private, or the token is missing a scope.';
    }
    return error.hostMessage;
  }

  /**
   * Defence in depth, mirroring bitbucket-cloud.provider.ts's `base()` —
   * `remote-url.ts` is the real boundary against a traversal segment, this
   * guards a `ForgeRepoRef` constructed some other way.
   */
  private base(repo: ForgeRepoRef): string {
    const segments = [repo.owner, ...repo.name.split('/')];
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new ForgeError('other', 0, `Invalid repository reference: ${repo.owner}/${repo.name}`);
    }
    return `/repos/${segments.map(encodeURIComponent).join('/')}`;
  }
}

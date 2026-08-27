import * as vscode from 'vscode';
import {
  ForgeError,
  type CreatePullRequestInput, type ForgeCapabilities, type ForgeComment, type ForgeProvider,
  type ForgeRepoInfo, type ForgeRepoRef, type ForgeSession, type ForgeUser, type MergeStrategy, type ParsedRemote,
  type PullRequestDetail, type PullRequestFile, type PullRequestListState, type PullRequestSummary,
} from '../forge.types';
import type { BitbucketApi } from './bitbucket-api';
import type { BitbucketAuthProvider } from './bitbucket-auth';
import { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL, BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';
import {
  mapComments, mapDiffstat, mapPullRequestDetail, mapPullRequestSummary, mapUser, type RawUser,
} from './bitbucket-mapper';

const PAGE_LENGTH = 50;

const STATE_QUERY: Record<PullRequestListState, string> = {
  open: 'OPEN',
  merged: 'MERGED',
  closed: 'DECLINED',
};

const REVIEW_ENDPOINT: Record<'approved' | 'changes_requested', string> = {
  approved: 'approve',
  changes_requested: 'request-changes',
};

/**
 * Bitbucket's merge endpoint expects snake_case strategy names — this
 * provider's own `capabilities.mergeStrategies` only ever offers the three
 * keys below, so `Partial` (rather than `Record<MergeStrategy, string>`)
 * turns a strategy Bitbucket was never declared to support (namely
 * `'rebase'`, which only makes sense for a future provider) into a lookup
 * miss `merge()` rejects explicitly, instead of forwarding an unmapped value
 * on to the host.
 */
const MERGE_STRATEGY_PARAM: Partial<Record<MergeStrategy, string>> = {
  'merge-commit': 'merge_commit',
  squash: 'squash',
  'fast-forward': 'fast_forward',
};

export interface BitbucketProviderDeps {
  api: BitbucketApi;
  auth: BitbucketAuthProvider;
}

export class BitbucketCloudProvider implements ForgeProvider {
  public readonly id = BITBUCKET_AUTH_ID;
  public readonly name = BITBUCKET_AUTH_LABEL;

  /*
   * `createPullRequest` is real now too (phase 5) — a capability advertises
   * what actually works, not what the type eventually will, and the webview
   * gates its buttons/menu items on this object precisely so it never has to
   * know the difference. No other change was needed for the branch context
   * menu item or the create form's submit to appear; that is what the
   * capability mechanism is for.
   */
  public readonly capabilities: ForgeCapabilities = {
    createPullRequest: true,
    approve: true,
    requestChanges: true,
    merge: true,
    mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
  };

  constructor(private readonly deps: BitbucketProviderDeps) {}

  public canHandle(remote: ParsedRemote): boolean {
    return remote.host === 'bitbucket.org';
  }

  /**
   * Routed through vscode.authentication.getSession rather than calling the
   * auth class directly: that is what makes this extension's own manifest
   * entry (contributes.authentication) true — an Accounts-menu entry, the
   * session-preference and consent plumbing VS Code owns, all live behind
   * this call. `createIfNone` defaults to false so a caller that omits it —
   * forge.status runs on every panel load — never puts a prompt in front of
   * someone who never asked to sign in.
   */
  public async getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined> {
    const session = await vscode.authentication.getSession(
      BITBUCKET_AUTH_ID,
      [...BITBUCKET_TOKEN_SCOPES],
      { createIfNone: opts?.createIfNone ?? false },
    );
    return session ? { providerId: BITBUCKET_AUTH_ID, accountLabel: session.account.label } : undefined;
  }

  /**
   * Through the auth provider's own removal path, not vscode.authentication:
   * there is no public "remove a session" call for a consumer, only the
   * owning AuthenticationProvider's removeSession — which is this provider,
   * reached through `deps.auth`.
   */
  public async signOut(): Promise<void> {
    const sessions = await this.deps.auth.getSessions([...BITBUCKET_TOKEN_SCOPES]);
    await Promise.all(sessions.map((session) => this.deps.auth.removeSession(session.id)));
  }

  public async listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]> {
    const raw = await this.deps.api.getPaged<Parameters<typeof mapPullRequestSummary>[0]>(
      `${this.base(repo)}/pullrequests?state=${STATE_QUERY[opts.state]}&pagelen=${PAGE_LENGTH}`);
    return raw.map(mapPullRequestSummary);
  }

  /**
   * Also fetches the diffstat, the same endpoint `getPullRequestFiles` uses,
   * so `mapPullRequestDetail` can turn its conflict status into a real
   * `mergeable` — the list/detail endpoints report no mergeability field of
   * their own, and the diffstat is the cheapest signal Bitbucket exposes for
   * it. Fetched alongside the detail rather than reused from a separate
   * cached call: this method has no access to the extension-side ForgeStore
   * that backs `forge.pr.files`, and the two are fetched concurrently by the
   * webview besides (see `handlePullRequestSelect` in App.svelte).
   */
  public async getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail> {
    const base = this.base(repo);
    const [raw, diffstat] = await Promise.all([
      this.deps.api.getJson<Parameters<typeof mapPullRequestDetail>[0]>(
        `${base}/pullrequests/${encodeURIComponent(id)}`),
      this.deps.api.getPaged<Parameters<typeof mapDiffstat>[0][number]>(
        `${base}/pullrequests/${encodeURIComponent(id)}/diffstat?pagelen=${PAGE_LENGTH}`),
    ]);
    return mapPullRequestDetail(raw, diffstat);
  }

  public async getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string> {
    return this.deps.api.getText(`${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/diff`);
  }

  /**
   * The file list backed by diffstat rather than the full diff: selecting a
   * pull request needs "which files, how many lines", not their content, and
   * diffstat returns that in a few KB against a diff that can run to tens of
   * MB for a regenerated lockfile or a vendored directory.
   */
  public async getPullRequestFiles(repo: ForgeRepoRef, id: string): Promise<PullRequestFile[]> {
    const raw = await this.deps.api.getPaged<Parameters<typeof mapDiffstat>[0][number]>(
      `${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/diffstat?pagelen=${PAGE_LENGTH}`);
    return mapDiffstat(raw);
  }

  public async listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]> {
    const raw = await this.deps.api.getPaged<Parameters<typeof mapComments>[0][number]>(
      `${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/comments?pagelen=${PAGE_LENGTH}`);
    return mapComments(raw);
  }

  /** The repository resource itself, for its `mainbranch` — see `ForgeRepoInfo`. */
  public async getRepoInfo(repo: ForgeRepoRef): Promise<ForgeRepoInfo> {
    const raw = await this.deps.api.getJson<{ mainbranch?: { name?: string } }>(this.base(repo));
    return { defaultBranch: raw.mainbranch?.name ?? '' };
  }

  /**
   * Bitbucket's default-reviewers endpoint: a host-computed suggestion list
   * for a repository, not a membership directory — see the doc comment on
   * `ForgeProvider.listReviewerCandidates`.
   */
  public async listReviewerCandidates(repo: ForgeRepoRef): Promise<ForgeUser[]> {
    const raw = await this.deps.api.getPaged<RawUser>(`${this.base(repo)}/default-reviewers?pagelen=${PAGE_LENGTH}`);
    return raw.map(mapUser);
  }

  /**
   * `detectDuplicate: true` is what lets a 400 whose body names an already-
   * open pull request come back as `kind: 'duplicate'` instead of the
   * generic `'other'` every other 400 on this endpoint produces (invalid
   * reviewer id, malformed branch name, ...) — see bitbucket-api.ts's
   * `classify`.
   */
  public async createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail> {
    const raw = await this.deps.api.post<Parameters<typeof mapPullRequestDetail>[0]>(
      `${this.base(repo)}/pullrequests`,
      {
        title: input.title,
        description: input.description,
        source: { branch: { name: input.sourceBranch } },
        destination: { branch: { name: input.targetBranch } },
        ...(input.reviewers && input.reviewers.length > 0
          ? { reviewers: input.reviewers.map((accountId) => ({ account_id: accountId })) }
          : {}),
        close_source_branch: input.closeSourceBranch ?? false,
      },
      { detectDuplicate: true },
    );
    return mapPullRequestDetail(raw);
  }

  /**
   * `opts.body` is declared on the shared interface for a provider that
   * needs it (GitHub requires one on a "request changes" review) but
   * Bitbucket's approve/request-changes endpoints take no body of their own
   * — this accepts the parameter to satisfy `ForgeProvider` and never reads
   * it.
   */
  public async setReviewStatus(
    repo: ForgeRepoRef,
    id: string,
    status: 'approved' | 'changes_requested',
    _opts?: { body?: string },
  ): Promise<void> {
    await this.deps.api.post(`${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/${REVIEW_ENDPOINT[status]}`, {});
  }

  public async merge(
    repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean },
  ): Promise<void> {
    const mergeStrategy = MERGE_STRATEGY_PARAM[opts.strategy];
    if (!mergeStrategy) {
      throw new ForgeError('other', 0, `Bitbucket does not support the '${opts.strategy}' merge strategy`);
    }
    await this.deps.api.post(`${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/merge`, {
      merge_strategy: mergeStrategy,
      ...(opts.closeSourceBranch !== undefined ? { close_source_branch: opts.closeSourceBranch } : {}),
    });
  }

  /**
   * The provider-specific half of an error message. Naming the exact scopes a
   * token is missing is something only this provider knows; the shared layer
   * renders whatever comes back and never composes advice of its own.
   */
  public describeError(error: ForgeError): string {
    if (error.kind === 'forbidden') {
      return `Bitbucket refused the request. The API token is missing a scope. Required: ${BITBUCKET_TOKEN_SCOPES.join(', ')}.`;
    }
    if (error.kind === 'not-found') {
      return 'Cannot access this repository or pull request on Bitbucket — it may be private, or the API token is missing a scope.';
    }
    return error.hostMessage;
  }

  /**
   * Defence in depth. `remote-url.ts` is the real boundary — it already
   * refuses to produce a `ParsedRemote` with a `.`/`..`/empty segment — but
   * this guards the case where a caller builds a `ForgeRepoRef` some other
   * way. `encodeURIComponent` does not escape `.` (RFC 3986 unreserved), so
   * a `..` segment left unchecked here would reach `/repositories/../x` and
   * let the WHATWG URL parser inside `fetch` collapse it into a path outside
   * `/repositories`, carrying this provider's Basic auth header with it.
   */
  private base(repo: ForgeRepoRef): string {
    const segments = [repo.owner, ...repo.name.split('/')];
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new ForgeError('other', 0, `Invalid repository reference: ${repo.owner}/${repo.name}`);
    }
    return `/repositories/${segments.map(encodeURIComponent).join('/')}`;
  }
}

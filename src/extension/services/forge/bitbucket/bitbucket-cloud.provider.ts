import * as vscode from 'vscode';
import {
  ForgeError,
  type CreatePullRequestInput, type ForgeCapabilities, type ForgeComment, type ForgeProvider,
  type ForgeRepoRef, type ForgeSession, type MergeStrategy, type ParsedRemote,
  type PullRequestDetail, type PullRequestFile, type PullRequestListState, type PullRequestSummary,
} from '../forge.types';
import type { BitbucketApi } from './bitbucket-api';
import type { BitbucketAuthProvider } from './bitbucket-auth';
import { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL, BITBUCKET_TOKEN_SCOPES } from './bitbucket-constants';
import { mapComments, mapDiffstat, mapPullRequestDetail, mapPullRequestSummary } from './bitbucket-mapper';

const PAGE_LENGTH = 50;

const STATE_QUERY: Record<PullRequestListState, string> = {
  open: 'OPEN',
  merged: 'MERGED',
  closed: 'DECLINED',
};

export interface BitbucketProviderDeps {
  api: BitbucketApi;
  auth: BitbucketAuthProvider;
}

export class BitbucketCloudProvider implements ForgeProvider {
  public readonly id = BITBUCKET_AUTH_ID;
  public readonly name = BITBUCKET_AUTH_LABEL;

  /*
   * All four still `false`: the methods below reject every one of them with a
   * 501 ("arrives in a later phase"). A capability advertises what actually
   * works, not what the type eventually will — the webview gates its buttons
   * on this object precisely so it never has to know the difference. Flip
   * each back to `true` in the same change that implements it; the UI needs
   * no other update to pick that up.
   */
  public readonly capabilities: ForgeCapabilities = {
    createPullRequest: false,
    approve: false,
    requestChanges: false,
    merge: false,
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

  public async getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail> {
    const raw = await this.deps.api.getJson<Parameters<typeof mapPullRequestDetail>[0]>(
      `${this.base(repo)}/pullrequests/${encodeURIComponent(id)}`);
    return mapPullRequestDetail(raw);
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

  public createPullRequest(_repo: ForgeRepoRef, _input: CreatePullRequestInput): Promise<PullRequestDetail> {
    return Promise.reject(new ForgeError('other', 501, 'Creating pull requests arrives in phase 5'));
  }

  public setReviewStatus(
    _repo: ForgeRepoRef,
    _id: string,
    _status: 'approved' | 'changes_requested',
    _opts?: { body?: string },
  ): Promise<void> {
    return Promise.reject(new ForgeError('other', 501, 'Approving pull requests arrives in phase 6'));
  }

  public merge(_repo: ForgeRepoRef, _id: string, _opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void> {
    return Promise.reject(new ForgeError('other', 501, 'Merging pull requests arrives in phase 6'));
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

import type { ParsedRemote } from './remote-url';

export type { ParsedRemote };

export interface ForgeUser { displayName: string; accountId: string; avatarUrl?: string }
/**
 * Host is included, not just owner/name: a catch-all provider (registered
 * last in the registry) and a single provider serving multiple hosts (e.g. a
 * public cloud host plus a self-hosted instance of the same forge) both need
 * it to know which host a ref belongs to — owner/name alone is ambiguous
 * across hosts.
 */
export interface ForgeRepoRef { host: string; owner: string; name: string }

export type PullRequestState = 'open' | 'merged' | 'closed' | 'draft';
export type ReviewStatus     = 'approved' | 'changes_requested' | 'pending' | 'commented';
export type MergeStrategy    = 'merge-commit' | 'squash' | 'fast-forward' | 'rebase';
export type MergeableState   = 'clean' | 'conflicted' | 'blocked' | 'unknown';

/** The subset of states that can be asked for. A draft is an open PR. */
export type PullRequestListState = 'open' | 'merged' | 'closed';

export interface PullRequestSummary {
  id: string;
  number: number;
  title: string;
  state: PullRequestState;
  author: ForgeUser;
  sourceBranch: string;
  targetBranch: string;
  /**
   * A provider may report `'pending'` for every reviewer here when this
   * summary came from `listPullRequests` — GitHub's list endpoint returns
   * requested reviewers without their review state, and getting the real
   * state per reviewer would cost an extra call per pull request (an N+1)
   * just to render a list. Treat this array as a hint on a list response,
   * never a source of truth: no UI may depend on summary chips being
   * accurate. The same field on a `PullRequestDetail` from `getPullRequest`
   * (a per-PR call) is authoritative.
   */
  reviewers: { user: ForgeUser; status: ReviewStatus }[];
  /**
   * A provider may report `0` here on a `listPullRequests` summary even
   * when the pull request has comments — the same list-versus-detail gap
   * `reviewers` above has, hit independently for this field: GitHub's list
   * endpoint carries neither `comments` nor `review_comments` (only its
   * single-PR GET does; see github-mapper.ts's `RawPullRequest.comments`),
   * so `mapPullRequestSummary` defaults both to 0 there. Bitbucket's list
   * endpoint does carry an accurate `comment_count`, but nothing in this
   * type distinguishes the two — treat this field as a hint on a list
   * response, never a source of truth. The same field on a
   * `PullRequestDetail` from `getPullRequest` (a per-PR call) is
   * authoritative.
   */
  commentCount: number;
  webUrl: string;
  updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  sourceCommit: string;
  targetCommit: string;
  mergeable: MergeableState;
}

/** Which side of the diff an inline comment's `line` refers to. */
export type ForgeCommentSide = 'old' | 'new';

export interface ForgeComment {
  id: string;
  author: ForgeUser;
  body: string;
  createdAt: string;
  parentId?: string;
  path?: string;
  line?: number;
  /**
   * Present only alongside `line`. 'new' when the anchor is on the changed
   * (target) version of the file, 'old' when it is only meaningful on the
   * pre-change version — e.g. a comment anchored to a line the change
   * deleted, which has no counterpart on the new side. Without this, such a
   * comment's line number is ambiguous.
   */
  side?: ForgeCommentSide;
}

/**
 * One changed file in a pull request, shaped to match the `ChangedFile` the
 * webview already renders for a commit (`git.show`) and for a parsed diff
 * (`parseUnifiedDiff`). Backed by the diffstat endpoint rather than the full
 * diff: selecting a pull request needs this list, not its content, and the
 * diffstat response is a few KB against a diff that can be tens of MB.
 */
export interface PullRequestFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Cheap, cacheable repository metadata — currently just the default branch,
 * which the create-pull-request form uses to pre-select the target. Backed
 * by one GET on every host this interface has been checked against:
 * Bitbucket's repository resource carries `mainbranch.name`; GitHub's
 * carries `default_branch` on the same shape of call.
 */
export interface ForgeRepoInfo {
  defaultBranch: string;
}

export interface CreatePullRequestInput {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers?: string[];
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
  accountLabel: string;
}

/**
 * Semantic classification of a forge failure, assigned by the provider that
 * produced it. The same HTTP status can mean different things on different
 * hosts (which status signals rate limiting, or a duplicate resource, is a
 * per-host convention), so this — not `status` — is what the shared layer
 * switches on.
 */
export type ForgeErrorKind =
  | 'unauthorized'    // credential absent, expired, or revoked
  | 'forbidden'       // authenticated but not permitted — typically a missing token scope
  | 'not-found'       // no such repository or pull request, or no access to it
  | 'rate-limited'    // back off; see retryAfterSeconds
  | 'duplicate'       // the thing being created already exists
  | 'other';

/** Every non-2xx response becomes one of these. */
export class ForgeError extends Error {
  constructor(
    public readonly kind: ForgeErrorKind,
    public readonly status: number,
    public readonly hostMessage: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(hostMessage);
    this.name = 'ForgeError';
  }
}

export interface ForgeProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ForgeCapabilities;
  canHandle(remote: ParsedRemote): boolean;

  getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined>;
  /**
   * Removes this provider's stored session. Optional: it is only
   * implementable by a provider that owns the `AuthenticationProvider` a
   * session came from, the way Bitbucket's does here — a provider that only
   * *consumes* a session it does not own (e.g. one built on VS Code's
   * built-in `github` provider) has no API to remove one; only the owning
   * extension does. Callers must not throw when this is absent:
   * `forge.signOut` falls back to guidance ("use the Accounts menu"), and
   * the 401-cleanup path in the shared handler skips the call but still
   * invalidates the cache and broadcasts `forge.changed` on its own.
   */
  signOut?(): Promise<void>;

  listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]>;
  getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail>;
  getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string>;
  getPullRequestFiles(repo: ForgeRepoRef, id: string): Promise<PullRequestFile[]>;
  listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]>;

  /**
   * One cheap GET; see `ForgeRepoInfo`. Used to default the create-pull-
   * request form's target branch without hardcoding 'main'/'master'.
   */
  getRepoInfo(repo: ForgeRepoRef): Promise<ForgeRepoInfo>;

  /**
   * Reviewer *candidates* for a pull request that does not exist yet —
   * never a workspace member directory, and no provider here may promise
   * completeness. Bitbucket backs this with its default-reviewers endpoint,
   * which is itself a suggestion list the host computes, not "everyone with
   * access". A GitHub provider's nearest equivalent — the collaborators
   * endpoint — is paginated and gated behind push/triage permission on the
   * token, so it may legitimately return a partial list, or an empty one on
   * a token that lacks permission; this contract allows both. The webview
   * must present this array as suggestions, never as a complete directory to
   * choose from.
   */
  listReviewerCandidates(repo: ForgeRepoRef): Promise<ForgeUser[]>;

  createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail>;
  setReviewStatus(
    repo: ForgeRepoRef,
    id: string,
    status: 'approved' | 'changes_requested',
    opts?: { body?: string },
  ): Promise<void>;
  merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void>;

  /**
   * Provider-specific remediation text for an error this provider produced —
   * e.g. naming the exact token scopes a 'forbidden' is missing. The shared
   * layer renders this; it must never compose provider-specific advice itself.
   */
  describeError(error: ForgeError): string;
}

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
export type ReviewStatus     = 'approved' | 'changes_requested' | 'pending';
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
  reviewers: { user: ForgeUser; status: ReviewStatus }[];
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

export interface ForgeComment {
  id: string;
  author: ForgeUser;
  body: string;
  createdAt: string;
  parentId?: string;
  path?: string;
  line?: number;
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
  signOut(): Promise<void>;

  listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]>;
  getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail>;
  getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string>;
  getPullRequestFiles(repo: ForgeRepoRef, id: string): Promise<PullRequestFile[]>;
  listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]>;

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

import type { ParsedRemote } from './remote-url';

export type { ParsedRemote };

export interface ForgeUser { displayName: string; accountId: string; avatarUrl?: string }
export interface ForgeRepoRef { owner: string; name: string }

export type PullRequestState = 'open' | 'merged' | 'closed' | 'draft';
export type ReviewStatus     = 'approved' | 'changes_requested' | 'pending';
export type MergeStrategy    = 'merge-commit' | 'squash' | 'fast-forward';
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

/** Every non-2xx response becomes one of these. */
export class ForgeError extends Error {
  constructor(
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
  listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]>;

  createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail>;
  setReviewStatus(repo: ForgeRepoRef, id: string, status: 'approved' | 'changes_requested'): Promise<void>;
  merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void>;
}

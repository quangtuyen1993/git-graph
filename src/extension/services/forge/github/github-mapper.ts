import type {
  ForgeComment, ForgeUser, MergeableState, PullRequestDetail, PullRequestFile, PullRequestState,
  PullRequestSummary, ReviewStatus,
} from '../forge.types';

/**
 * GitHub's "simple user" shape — what every endpoint that embeds a user
 * (an author, a requested reviewer, a review's or comment's `user`) actually
 * returns. Unlike Bitbucket's `display_name`, GitHub's inline user objects
 * carry no display name at all, only `login` — a full name is only
 * available from a dedicated `GET /users/{username}` call this provider
 * never makes, since a suggestion list or a reviewer chip does not warrant
 * an extra request per user.
 */
export interface RawUser {
  login?: string;
  id?: number;
  avatar_url?: string;
}

interface RawRef {
  ref?: string;
  sha?: string;
  repo?: { full_name?: string } | null;
}

export interface RawPullRequest {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  /**
   * Only present on the single-PR GET, never on the list endpoint — see
   * `mapPullRequestSummary`'s reviewers comment for the same shape of gap on
   * this field. Defaulted to 0 when absent rather than throwing, since a
   * missing count degrades the list gracefully instead of breaking it.
   */
  comments?: number;
  review_comments?: number;
  updated_at?: string;
  html_url?: string;
  user?: RawUser;
  head?: RawRef;
  base?: RawRef;
  /** Reviewers still awaited — never carries a submitted review's state. */
  requested_reviewers?: RawUser[];
  /** Only present on the single-PR GET; see `mapMergeable`. */
  mergeable_state?: string;
}

export interface RawReview {
  user?: RawUser;
  state?: string;
  submitted_at?: string;
}

export interface RawIssueComment {
  id?: number;
  user?: RawUser;
  body?: string;
  created_at?: string;
}

export interface RawReviewComment {
  id?: number;
  user?: RawUser;
  body?: string;
  created_at?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  side?: string;
  in_reply_to_id?: number;
}

export interface RawFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export function mapUser(raw: RawUser | undefined): ForgeUser {
  const user: ForgeUser = {
    // The login, not a display name GitHub's inline user objects do not
    // carry (see RawUser) — and the login, not the numeric id, because
    // that is what `requested_reviewers` (create, list candidates) expects
    // back as a reviewer identifier.
    displayName: raw?.login ?? '',
    accountId: raw?.login ?? (raw?.id !== undefined ? String(raw.id) : ''),
  };
  return raw?.avatar_url ? { ...user, avatarUrl: raw.avatar_url } : user;
}

function mapState(raw: RawPullRequest): PullRequestState {
  if (raw.draft && raw.state !== 'closed') return 'draft';
  if (raw.merged_at) return 'merged';
  return raw.state === 'closed' ? 'closed' : 'open';
}

export function mapPullRequestSummary(raw: RawPullRequest): PullRequestSummary {
  const number = raw.number ?? 0;
  return {
    id: String(number),
    number,
    title: raw.title ?? '',
    state: mapState(raw),
    author: mapUser(raw.user),
    sourceBranch: raw.head?.ref ?? '',
    targetBranch: raw.base?.ref ?? '',
    // `requested_reviewers` never carries a review's state — see the
    // reviewer-degradation contract documented on
    // `PullRequestSummary.reviewers` in forge.types.ts. `getPullRequest`
    // (mapPullRequestDetail, below) replaces this with the authoritative
    // list once a per-PR reviews call is affordable.
    reviewers: (raw.requested_reviewers ?? []).map((user) => ({ user: mapUser(user), status: 'pending' as const })),
    commentCount: (raw.comments ?? 0) + (raw.review_comments ?? 0),
    webUrl: raw.html_url ?? '',
    updatedAt: raw.updated_at ?? '',
  };
}

/**
 * GitHub's `mergeable_state` values, mapped to the shared vocabulary.
 * 'clean' and 'unstable' (mergeable despite a non-required check failing)
 * both mean "no obstruction to merging" from this provider's perspective;
 * 'dirty' is a real conflict; 'blocked' is branch protection; everything
 * else ('unknown' while GitHub is still computing it, 'behind', 'draft', or
 * the field simply being absent — e.g. immediately after creation) is
 * 'unknown' rather than guessed at.
 */
function mapMergeable(mergeableState: string | undefined): MergeableState {
  switch (mergeableState) {
    case 'clean':
    case 'unstable':
    case 'has_hooks': return 'clean';
    case 'dirty': return 'conflicted';
    case 'blocked': return 'blocked';
    default: return 'unknown';
  }
}

function mapReviewState(state: string | undefined): ReviewStatus | undefined {
  switch (state) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'COMMENTED': return 'commented';
    // DISMISSED no longer counts towards the reviewer's status, and PENDING
    // is a review that was never submitted — neither is a real answer.
    default: return undefined;
  }
}

/**
 * The authoritative reviewer list for a single pull request — GitHub has no
 * endpoint that returns a reviewer's current state directly, so this
 * combines two signals fetched alongside the detail: `reviews` (one entry
 * per submitted review, oldest first) reduced to each user's latest
 * non-dismissed verdict, plus `requested_reviewers` for anyone still
 * awaited who has not reviewed at all.
 */
function mapReviewers(
  requestedReviewers: RawUser[] | undefined, reviews: RawReview[],
): PullRequestSummary['reviewers'] {
  const latestByLogin = new Map<string, { user: RawUser; status: ReviewStatus }>();
  for (const review of reviews) {
    const status = mapReviewState(review.state);
    const login = review.user?.login;
    if (!status || !login) continue;
    // `reviews` is returned oldest-first, so a later entry for the same
    // user overwrites an earlier one and this ends up holding each user's
    // most recent verdict.
    latestByLogin.set(login, { user: review.user ?? {}, status });
  }

  const reviewers = Array.from(latestByLogin.values()).map(({ user, status }) => ({ user: mapUser(user), status }));
  for (const requested of requestedReviewers ?? []) {
    if (requested.login && latestByLogin.has(requested.login)) continue;
    reviewers.push({ user: mapUser(requested), status: 'pending' });
  }
  return reviewers;
}

export function mapPullRequestDetail(raw: RawPullRequest, reviews: RawReview[] = []): PullRequestDetail {
  return {
    ...mapPullRequestSummary(raw),
    reviewers: mapReviewers(raw.requested_reviewers, reviews),
    description: raw.body ?? '',
    sourceCommit: raw.head?.sha ?? '',
    targetCommit: raw.base?.sha ?? '',
    mergeable: mapMergeable(raw.mergeable_state),
  };
}

export function mapIssueComment(raw: RawIssueComment): ForgeComment {
  return {
    id: String(raw.id ?? ''),
    author: mapUser(raw.user),
    body: raw.body ?? '',
    createdAt: raw.created_at ?? '',
  };
}

export function mapReviewComment(raw: RawReviewComment): ForgeComment {
  const comment: ForgeComment = {
    id: String(raw.id ?? ''),
    author: mapUser(raw.user),
    body: raw.body ?? '',
    createdAt: raw.created_at ?? '',
  };
  if (raw.in_reply_to_id !== undefined) comment.parentId = String(raw.in_reply_to_id);
  if (raw.path) {
    comment.path = raw.path;
    // `line` is null on an outdated comment (one anchored to a version of
    // the diff superseded by later commits); `original_line` still carries
    // the line it was anchored to at the time.
    const line = raw.line ?? raw.original_line;
    if (typeof line === 'number') comment.line = line;
    if (raw.side === 'RIGHT') comment.side = 'new';
    else if (raw.side === 'LEFT') comment.side = 'old';
  }
  return comment;
}

/**
 * GitHub splits pull request discussion across two endpoints — general
 * (issue) comments and inline review comments — where Bitbucket's single
 * comments endpoint carries both. Merging them here is what lets this
 * provider's `listComments` present one list, matching the interface's
 * single `ForgeComment[]` contract without the split leaking upward.
 */
export function mapComments(issueComments: RawIssueComment[], reviewComments: RawReviewComment[]): ForgeComment[] {
  return [...issueComments.map(mapIssueComment), ...reviewComments.map(mapReviewComment)];
}

function mapFileStatus(status: string | undefined): string {
  switch (status) {
    case 'added': return 'added';
    case 'removed': return 'deleted';
    case 'renamed': return 'renamed';
    default: return 'modified';
  }
}

/**
 * GitHub's files endpoint carries no explicit binary flag; it omits `patch`
 * for a binary file (and also for a diff too large to render, but that case
 * still reports non-zero additions/deletions). Zero of both on an entry
 * with no patch is the best available signal — the same heuristic
 * bitbucket-mapper.ts uses for the equivalent gap.
 */
function isLikelyBinary(raw: RawFile): boolean {
  return raw.patch === undefined && !raw.additions && !raw.deletions;
}

export function mapFile(raw: RawFile): PullRequestFile {
  const status = mapFileStatus(raw.status);
  const path = raw.filename ?? '';
  const oldPath = status === 'renamed' && raw.previous_filename && raw.previous_filename !== path
    ? raw.previous_filename
    : null;
  return {
    path,
    oldPath,
    status,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    binary: isLikelyBinary(raw),
  };
}

export function mapFiles(raw: RawFile[]): PullRequestFile[] {
  return raw.map(mapFile);
}

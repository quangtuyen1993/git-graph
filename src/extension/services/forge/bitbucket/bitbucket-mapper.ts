import type {
  ForgeComment, ForgeUser, PullRequestDetail, PullRequestState, PullRequestSummary, ReviewStatus,
} from '../forge.types';

interface RawUser {
  display_name?: string;
  account_id?: string;
  links?: { avatar?: { href?: string } };
}

interface RawParticipant {
  role?: string;
  approved?: boolean;
  state?: string | null;
  user?: RawUser;
}

interface RawPullRequest {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  draft?: boolean;
  comment_count?: number;
  updated_on?: string;
  links?: { html?: { href?: string } };
  author?: RawUser;
  source?: { branch?: { name?: string }; commit?: { hash?: string } };
  destination?: { branch?: { name?: string }; commit?: { hash?: string } };
  participants?: RawParticipant[];
}

interface RawComment {
  id?: number;
  created_on?: string;
  deleted?: boolean;
  content?: { raw?: string };
  user?: RawUser;
  parent?: { id?: number };
  inline?: { path?: string; to?: number | null; from?: number | null };
}

function mapUser(raw: RawUser | undefined): ForgeUser {
  const user: ForgeUser = {
    displayName: raw?.display_name ?? '',
    accountId: raw?.account_id ?? '',
  };
  const avatarUrl = raw?.links?.avatar?.href;
  // Only set the key when there is a value: the tests compare whole objects,
  // and an explicit undefined is not the same shape as an absent key.
  return avatarUrl ? { ...user, avatarUrl } : user;
}

function mapState(raw: RawPullRequest): PullRequestState {
  if (raw.draft) return 'draft';
  switch ((raw.state ?? '').toUpperCase()) {
    case 'MERGED': return 'merged';
    case 'DECLINED':
    case 'SUPERSEDED': return 'closed';
    default: return 'open';
  }
}

function mapReviewStatus(participant: RawParticipant): ReviewStatus {
  if (participant.approved) return 'approved';
  return participant.state === 'changes_requested' ? 'changes_requested' : 'pending';
}

export function mapPullRequestSummary(raw: RawPullRequest): PullRequestSummary {
  const number = raw.id ?? 0;
  return {
    id: String(number),
    number,
    title: raw.title ?? '',
    state: mapState(raw),
    author: mapUser(raw.author),
    sourceBranch: raw.source?.branch?.name ?? '',
    targetBranch: raw.destination?.branch?.name ?? '',
    reviewers: (raw.participants ?? [])
      .filter((participant) => participant.role === 'REVIEWER')
      .map((participant) => ({ user: mapUser(participant.user), status: mapReviewStatus(participant) })),
    commentCount: raw.comment_count ?? 0,
    webUrl: raw.links?.html?.href ?? '',
    updatedAt: raw.updated_on ?? '',
  };
}

export function mapPullRequestDetail(raw: RawPullRequest): PullRequestDetail {
  return {
    ...mapPullRequestSummary(raw),
    description: raw.description ?? '',
    sourceCommit: raw.source?.commit?.hash ?? '',
    targetCommit: raw.destination?.commit?.hash ?? '',
    // The list and detail endpoints do not report mergeability; it comes from
    // a separate call this phase does not make.
    mergeable: 'unknown',
  };
}

export function mapComment(raw: RawComment): ForgeComment {
  const comment: ForgeComment = {
    id: String(raw.id ?? ''),
    author: mapUser(raw.user),
    body: raw.content?.raw ?? '',
    createdAt: raw.created_on ?? '',
  };
  if (raw.parent?.id !== undefined) comment.parentId = String(raw.parent.id);
  if (raw.inline?.path) {
    comment.path = raw.inline.path;
    const line = raw.inline.to ?? raw.inline.from;
    if (typeof line === 'number') comment.line = line;
  }
  return comment;
}

/** Deleted comments come back as tombstones with empty bodies; drop them. */
export function mapComments(raw: RawComment[]): ForgeComment[] {
  return raw.filter((comment) => !comment.deleted).map(mapComment);
}

import { describe, expect, it } from 'vitest';
import {
  mapComments, mapFile, mapFiles, mapIssueComment, mapPullRequestDetail, mapPullRequestSummary, mapReviewComment,
  mapUser,
} from '../../src/extension/services/forge/github/github-mapper';
import detailFixture from '../fixtures/github/pull-request.json';
import listFixture from '../fixtures/github/pull-request-list.json';
import reviewsFixture from '../fixtures/github/reviews.json';
import filesFixture from '../fixtures/github/files.json';
import issueCommentsFixture from '../fixtures/github/issue-comments.json';
import reviewCommentsFixture from '../fixtures/github/review-comments.json';

describe('mapUser', () => {
  it('uses the login as both display name and account id', () => {
    expect(mapUser({ login: 'an-tran', id: 1001, avatar_url: 'https://a.example/an.png' })).toEqual({
      displayName: 'an-tran', accountId: 'an-tran', avatarUrl: 'https://a.example/an.png',
    });
  });

  it('omits avatarUrl when absent rather than setting it to undefined', () => {
    expect(mapUser({ login: 'an-tran', id: 1001 })).toEqual({ displayName: 'an-tran', accountId: 'an-tran' });
  });

  it('falls back to the numeric id when login is missing', () => {
    expect(mapUser({ id: 1001 })).toMatchObject({ accountId: '1001' });
  });
});

describe('mapPullRequestSummary', () => {
  it('maps a draft pull request', () => {
    const [draftRaw] = listFixture;
    const summary = mapPullRequestSummary(draftRaw as never);
    expect(summary).toMatchObject({ id: '118', number: 118, state: 'draft', sourceBranch: 'feature/RMS-1027', targetBranch: 'develop' });
  });

  it('maps a merged pull request from merged_at rather than state alone', () => {
    const mergedRaw = listFixture[1];
    expect(mapPullRequestSummary(mergedRaw as never).state).toBe('merged');
  });

  it('maps a closed (not merged) pull request', () => {
    const closedRaw = listFixture[2];
    expect(mapPullRequestSummary(closedRaw as never).state).toBe('closed');
  });

  // Reviewer-degradation contract (forge.types.ts): the list endpoint's
  // requested_reviewers carries no review state, so every entry here must
  // report 'pending' regardless of what any of them actually did.
  it("reports every requested reviewer as 'pending' on a list-shaped mapping", () => {
    const [draftRaw] = listFixture;
    const summary = mapPullRequestSummary(draftRaw as never);
    expect(summary.reviewers).toEqual([{ user: { displayName: 'hoa-pham', accountId: 'hoa-pham', avatarUrl: 'https://avatar.example/hoa.png' }, status: 'pending' }]);
  });

  // GitHub's list endpoint carries neither `comments` nor `review_comments`
  // at all — both undefined here, unlike the detail fixture.
  it('defaults commentCount to 0 when the list shape carries no comment counts', () => {
    const [draftRaw] = listFixture;
    expect(mapPullRequestSummary(draftRaw as never).commentCount).toBe(0);
  });

  it('sums issue and review comment counts when both are present (the detail shape)', () => {
    expect(mapPullRequestSummary(detailFixture as never).commentCount).toBe(5);
  });
});

describe('mapPullRequestDetail', () => {
  it('maps sourceCommit/targetCommit from head/base sha', () => {
    const detail = mapPullRequestDetail(detailFixture as never, []);
    expect(detail.sourceCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(detail.targetCommit).toBe('b2c3d4e5f60718293a4b5c6d7e8f90123456789a');
  });

  it.each([
    ['clean', 'clean'],
    ['unstable', 'clean'],
    ['has_hooks', 'clean'],
    ['dirty', 'conflicted'],
    ['blocked', 'blocked'],
    ['unknown', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('maps mergeable_state %s to %s', (mergeableState, expected) => {
    const raw = { ...(detailFixture as never as Record<string, unknown>), mergeable_state: mergeableState };
    expect(mapPullRequestDetail(raw as never, []).mergeable).toBe(expected);
  });

  // The authoritative reviewer list: reviews.json gives an-tran two reviews
  // (COMMENTED then APPROVED) — the later one must win. minh-le has a single
  // CHANGES_REQUESTED. hoa-pham's only review is DISMISSED, which must not
  // count, so hoa-pham falls back to the 'pending' entry from
  // requested_reviewers in pull-request.json.
  it("combines reviews and requested_reviewers into the authoritative reviewer list, taking each user's latest verdict", () => {
    const detail = mapPullRequestDetail(detailFixture as never, reviewsFixture as never);
    const byLogin = Object.fromEntries(detail.reviewers.map((r) => [r.user.accountId, r.status]));
    expect(byLogin).toEqual({ 'an-tran': 'approved', 'minh-le': 'changes_requested', 'hoa-pham': 'pending' });
  });

  it("collapses to 'pending' for everyone when no reviews have been submitted yet", () => {
    const detail = mapPullRequestDetail(detailFixture as never, []);
    expect(detail.reviewers).toEqual([{ user: { displayName: 'hoa-pham', accountId: 'hoa-pham', avatarUrl: 'https://avatar.example/hoa.png' }, status: 'pending' }]);
  });

  it("maps a 'commented' review state without collapsing it to pending", () => {
    const detail = mapPullRequestDetail(
      detailFixture as never,
      [{ user: { login: 'an-tran', id: 1001 }, state: 'COMMENTED', submitted_at: 't' }] as never,
    );
    expect(detail.reviewers.find((r) => r.user.accountId === 'an-tran')?.status).toBe('commented');
  });
});

describe('mapFile / mapFiles', () => {
  it('maps status, additions and deletions for each entry', () => {
    const files = mapFiles(filesFixture as never);
    expect(files.map((f) => f.status)).toEqual(['added', 'deleted', 'renamed', 'modified']);
  });

  it('carries oldPath only for a rename whose previous_filename differs', () => {
    const files = mapFiles(filesFixture as never);
    const renamed = files.find((f) => f.status === 'renamed');
    expect(renamed).toMatchObject({ path: 'src/renamed-to.ts', oldPath: 'src/renamed-from.ts' });
  });

  it('leaves oldPath null for a non-renamed file', () => {
    const files = mapFiles(filesFixture as never);
    expect(files.find((f) => f.status === 'added')?.oldPath).toBeNull();
  });

  // The fourth fixture entry ('assets/logo.png') has no `patch` and zero
  // additions/deletions on a 'modified' status — the binary heuristic.
  it('flags a file with no patch and no changed lines as binary', () => {
    const binary = mapFile({ filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 });
    expect(binary.binary).toBe(true);
  });

  it('does not flag a real text change with a patch as binary', () => {
    const textChange = mapFile({ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@' });
    expect(textChange.binary).toBe(false);
  });
});

describe('mapIssueComment / mapReviewComment / mapComments', () => {
  it('maps a general (issue) comment with no path or line', () => {
    const comment = mapIssueComment(issueCommentsFixture[0] as never);
    expect(comment).toEqual({ id: '5001', author: { displayName: 'an-tran', accountId: 'an-tran', avatarUrl: 'https://avatar.example/an.png' }, body: 'Ready for review.', createdAt: '2026-08-20T02:20:00Z' });
  });

  it("maps a review comment anchored on the new side ('RIGHT') with side 'new'", () => {
    const comment = mapReviewComment(reviewCommentsFixture[0] as never);
    expect(comment).toMatchObject({ path: 'src/auth.ts', line: 42, side: 'new' });
  });

  it('carries parentId from in_reply_to_id', () => {
    const comment = mapReviewComment(reviewCommentsFixture[1] as never);
    expect(comment.parentId).toBe('6001');
  });

  // A comment anchored only via original_line (line is null — the line was
  // superseded by a later commit) with side 'LEFT' means it sits on a
  // deleted line: side must be 'old', and the line number must still come
  // through from original_line since `line` itself is null.
  it("maps a comment anchored on the old side ('LEFT') via original_line with side 'old'", () => {
    const comment = mapReviewComment(reviewCommentsFixture[2] as never);
    expect(comment).toMatchObject({ path: 'src/legacy.ts', line: 17, side: 'old' });
  });

  it('merges issue comments and review comments into one list', () => {
    const comments = mapComments(issueCommentsFixture as never, reviewCommentsFixture as never);
    expect(comments.map((c) => c.id)).toEqual(['5001', '6001', '6002', '6003']);
  });
});

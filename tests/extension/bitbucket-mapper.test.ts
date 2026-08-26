import { describe, expect, it } from 'vitest';
import {
  mapComments, mapPullRequestDetail, mapPullRequestSummary,
} from '../../src/extension/services/forge/bitbucket/bitbucket-mapper';
import detailFixture from '../fixtures/bitbucket/pull-request.json';
import listFixture from '../fixtures/bitbucket/pull-request-list.json';
import commentsFixture from '../fixtures/bitbucket/comments.json';

describe('bitbucket-mapper', () => {
  it('maps a pull request detail', () => {
    const pr = mapPullRequestDetail(detailFixture as never);
    expect(pr).toMatchObject({
      id: '123', number: 123, state: 'open',
      title: 'fix(auth): refresh token race', description: 'Single-flight the refresh.',
      sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
      sourceCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      targetCommit: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a',
      commentCount: 8, webUrl: 'https://bitbucket.org/acme/mpos/pull-requests/123',
      mergeable: 'unknown',
    });
    expect(pr.author).toEqual({ displayName: 'An Tran', accountId: 'acc-an', avatarUrl: 'https://avatar.example/an.png' });
  });

  // Only reviewers count; a plain participant is not a reviewer.
  it('keeps reviewers only, with their status', () => {
    const pr = mapPullRequestDetail(detailFixture as never);
    expect(pr.reviewers).toEqual([
      { user: { displayName: 'An Tran',  accountId: 'acc-an' },   status: 'approved' },
      { user: { displayName: 'Minh Le',  accountId: 'acc-minh' }, status: 'changes_requested' },
      { user: { displayName: 'Hoa Pham', accountId: 'acc-hoa' },  status: 'pending' },
    ]);
  });

  // A draft is an open PR that reports itself as draft.
  it('reports a draft as state draft', () => {
    const summary = mapPullRequestSummary((listFixture as { values: unknown[] }).values[0] as never);
    expect(summary).toMatchObject({ id: '118', number: 118, state: 'draft', commentCount: 0 });
  });

  it.each([
    ['OPEN', false, 'open'],
    ['MERGED', false, 'merged'],
    ['DECLINED', false, 'closed'],
    ['SUPERSEDED', false, 'closed'],
    ['OPEN', true, 'draft'],
  ])('maps state %s draft=%s to %s', (state, draft, expected) => {
    const summary = mapPullRequestSummary({ ...(detailFixture as object), state, draft } as never);
    expect(summary.state).toBe(expected);
  });

  it('maps comments, threading and inline anchors, and drops deleted ones', () => {
    const comments = mapComments((commentsFixture as { values: unknown[] }).values as never);
    expect(comments).toEqual([
      {
        id: '9001', body: 'This drops the mutex.', createdAt: '2026-08-21T03:00:00.000000+00:00',
        author: { displayName: 'Minh Le', accountId: 'acc-minh' }, path: 'src/auth.ts', line: 42,
      },
      {
        id: '9002', body: 'Fixed.', createdAt: '2026-08-21T04:00:00.000000+00:00',
        author: { displayName: 'An Tran', accountId: 'acc-an' }, parentId: '9001',
      },
    ]);
  });

  // Bitbucket omits fields freely; a missing branch must not crash the sidebar.
  it('survives missing optional fields', () => {
    const summary = mapPullRequestSummary({ id: 7, state: 'OPEN' } as never);
    expect(summary).toMatchObject({
      id: '7', number: 7, title: '', sourceBranch: '', targetBranch: '',
      commentCount: 0, reviewers: [], webUrl: '',
    });
  });
});

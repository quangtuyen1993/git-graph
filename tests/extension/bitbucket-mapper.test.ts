import { describe, expect, it } from 'vitest';
import {
  mapComments, mapDiffstat, mapPullRequestDetail, mapPullRequestSummary,
} from '../../src/extension/services/forge/bitbucket/bitbucket-mapper';
import detailFixture from '../fixtures/bitbucket/pull-request.json';
import listFixture from '../fixtures/bitbucket/pull-request-list.json';
import commentsFixture from '../fixtures/bitbucket/comments.json';
import diffstatFixture from '../fixtures/bitbucket/diffstat.json';

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

  // Requirement 3 (phase 6): mergeable is real now. Bitbucket's diffstat
  // conflict status ('merge conflict', 'rename conflict', 'rename/delete
  // conflict', 'subrepo conflict') is the cheapest signal the host exposes —
  // no diffstat argument at all still means "we didn't ask", not "clean".
  describe('mergeable, from the diffstat conflict status', () => {
    it('reports clean when the diffstat has no conflicts', () => {
      const pr = mapPullRequestDetail(detailFixture as never, (diffstatFixture as { values: unknown[] }).values as never);
      expect(pr.mergeable).toBe('clean');
    });

    it.each(['merge conflict', 'rename conflict', 'rename/delete conflict', 'subrepo conflict'])(
      'reports conflicted when a diffstat entry has status %s',
      (status) => {
        const pr = mapPullRequestDetail(detailFixture as never, [{ status } as never]);
        expect(pr.mergeable).toBe('conflicted');
      },
    );

    it('reports unknown when no diffstat was supplied at all', () => {
      const pr = mapPullRequestDetail(detailFixture as never);
      expect(pr.mergeable).toBe('unknown');
    });
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

  // Requirement 2: ForgeComment gains `side` — 'new' when the anchor comes
  // from inline.to (9001), 'old' when only inline.from is present, e.g. a
  // comment anchored to a line that no longer exists on the current side
  // (9004). A comment on a deleted line is ambiguous without it.
  it('maps comments, threading and inline anchors (with side), and drops deleted ones', () => {
    const comments = mapComments((commentsFixture as { values: unknown[] }).values as never);
    expect(comments).toEqual([
      {
        id: '9001', body: 'This drops the mutex.', createdAt: '2026-08-21T03:00:00.000000+00:00',
        author: { displayName: 'Minh Le', accountId: 'acc-minh' }, path: 'src/auth.ts', line: 42, side: 'new',
      },
      {
        id: '9002', body: 'Fixed.', createdAt: '2026-08-21T04:00:00.000000+00:00',
        author: { displayName: 'An Tran', accountId: 'acc-an' }, parentId: '9001',
      },
      {
        id: '9004', body: 'This line is gone now.', createdAt: '2026-08-21T06:00:00.000000+00:00',
        author: { displayName: 'Hoa Pham', accountId: 'acc-hoa' }, path: 'src/auth.ts', line: 40, side: 'old',
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

  // Finding 3: the diffstat mapper backs `forge.pr.files`, which replaces
  // fetching the whole diff just to list changed files. Covers a rename, a
  // binary file, and an added and a removed file from one captured payload.
  describe('mapDiffstat', () => {
    const files = mapDiffstat((diffstatFixture as { values: unknown[] }).values as never);

    it('maps an added file', () => {
      expect(files[0]).toEqual({
        path: 'src/auth/refresh.ts', oldPath: null, status: 'added',
        additions: 42, deletions: 0, binary: false,
      });
    });

    it('maps a removed file', () => {
      expect(files[1]).toEqual({
        path: 'src/auth/legacy-refresh.ts', oldPath: null, status: 'deleted',
        additions: 0, deletions: 17, binary: false,
      });
    });

    it('maps a rename with both paths', () => {
      expect(files[2]).toEqual({
        path: 'src/auth/token-cache.ts', oldPath: 'src/auth/token-store.ts', status: 'renamed',
        additions: 3, deletions: 3, binary: false,
      });
    });

    it('treats a zero-line modified entry as binary', () => {
      expect(files[3]).toEqual({
        path: 'assets/logo.png', oldPath: null, status: 'modified',
        additions: 0, deletions: 0, binary: true,
      });
    });

    it('survives missing optional fields', () => {
      expect(mapDiffstat([{} as never])).toEqual([
        { path: '', oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: true },
      ]);
    });
  });
});

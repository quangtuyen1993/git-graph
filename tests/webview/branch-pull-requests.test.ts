import { describe, expect, it } from 'vitest';
import { deriveBranchPullRequests, matchesPullRequestQuery } from '../../src/webview/lib/branch-pull-requests';

const pr = (number: number, sourceBranch: string, state = 'open') => ({
  id: String(number), number, sourceBranch, state,
});

describe('deriveBranchPullRequests', () => {
  it('maps a source branch to its pull request number', () => {
    const map = deriveBranchPullRequests([pr(123, 'feature/RMS-1027')] as never);
    expect(map.get('feature/RMS-1027')).toBe(123);
  });

  it('ignores branches with no pull request', () => {
    const map = deriveBranchPullRequests([pr(123, 'feature/a')] as never);
    expect(map.get('feature/b')).toBeUndefined();
  });

  // Reopening a branch produces a second PR; the badge should name the live one.
  it('keeps the highest number when a branch has more than one', () => {
    const map = deriveBranchPullRequests([pr(101, 'feature/a'), pr(140, 'feature/a')] as never);
    expect(map.get('feature/a')).toBe(140);
  });

  it('skips merged and closed pull requests', () => {
    const map = deriveBranchPullRequests([
      pr(101, 'feature/a', 'merged'),
      pr(102, 'feature/b', 'closed'),
      pr(103, 'feature/c', 'draft'),
    ] as never);
    expect(map.has('feature/a')).toBe(false);
    expect(map.has('feature/b')).toBe(false);
    expect(map.get('feature/c')).toBe(103);
  });

  it('returns an empty map for no pull requests', () => {
    expect(deriveBranchPullRequests([]).size).toBe(0);
  });
});

// Ledger item: the duplicated filter predicate. BranchSidebar.svelte's
// visiblePullRequests and PullRequestList.svelte's visible list used to
// each inline the same number/title/source-branch match, one written
// against a `matches()` helper and the other written out longhand — a
// shared function is what keeps them from drifting apart.
describe('matchesPullRequestQuery', () => {
  const row = { number: 118, title: 'Fix the login race', sourceBranch: 'feature/login-race' };

  it('matches by number', () => {
    expect(matchesPullRequestQuery(row, '118')).toBe(true);
  });

  // The needle is already lower-cased by the caller (both call sites do
  // this once per keystroke) — matching is against the title lower-cased
  // here, which is what makes it effectively case-insensitive end to end.
  it('matches by title against a lower-cased needle', () => {
    expect(matchesPullRequestQuery(row, 'login')).toBe(true);
  });

  it('matches by source branch', () => {
    expect(matchesPullRequestQuery(row, 'login-race')).toBe(true);
  });

  it('does not match an unrelated needle', () => {
    expect(matchesPullRequestQuery(row, 'zzz')).toBe(false);
  });
});

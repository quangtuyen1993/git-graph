import { describe, expect, it } from 'vitest';
import { deriveBranchPullRequests } from '../../src/webview/lib/branch-pull-requests';

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

interface PullRequestLike {
  number: number;
  sourceBranch: string;
  state: 'open' | 'merged' | 'closed' | 'draft';
}

/**
 * Source branch → pull request number, for the badge on a branch row.
 *
 * Only live pull requests count. A branch that was merged and reused would
 * otherwise carry a badge pointing at history. When a branch genuinely has two
 * open pull requests the higher number wins, since that is the newer one.
 */
export function deriveBranchPullRequests(pullRequests: PullRequestLike[]): Map<string, number> {
  const byBranch = new Map<string, number>();

  for (const pr of pullRequests) {
    if (pr.state !== 'open' && pr.state !== 'draft') continue;
    if (!pr.sourceBranch) continue;

    const existing = byBranch.get(pr.sourceBranch);
    if (existing === undefined || pr.number > existing) {
      byBranch.set(pr.sourceBranch, pr.number);
    }
  }
  return byBranch;
}

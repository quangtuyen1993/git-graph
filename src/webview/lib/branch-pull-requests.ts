interface PullRequestLike {
  number: number;
  sourceBranch: string;
  state: 'open' | 'merged' | 'closed' | 'draft';
}

interface SearchablePullRequest {
  number: number;
  title: string;
  sourceBranch: string;
}

/**
 * The pull request search predicate: number, title and source branch are the
 * three things someone searches by. Shared so BranchSidebar's own
 * visible-count/section-visibility filtering and PullRequestList's row
 * filtering can't drift apart — they used to duplicate this inline.
 *
 * `needle` must already be trimmed and lower-cased by the caller (both
 * existing call sites already compute that once per keystroke; recomputing
 * it per pull request here would be wasted work on every render).
 */
export function matchesPullRequestQuery(pr: SearchablePullRequest, needle: string): boolean {
  return String(pr.number).includes(needle)
    || pr.title.toLowerCase().includes(needle)
    || pr.sourceBranch.toLowerCase().includes(needle);
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

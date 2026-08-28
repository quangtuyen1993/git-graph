export type ReviewTargetLabelKind = 'branch' | 'commit' | 'range' | 'pr';

interface ReviewTargetLabelEntry {
  kind: ReviewTargetLabelKind;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  subject?: string;
  prNumber?: number;
}

/**
 * The label a review row shows for its target, and the text the sidebar's
 * search box matches against (see ReviewList.svelte and BranchSidebar.svelte
 * — the resolved ambiguity is "the label you search is the label you read").
 * Mirrors ReviewApp.svelte's `entryLabel` so the standalone review panel and
 * the in-graph REVIEWS section can't describe the same entry two different
 * ways. Kept here, shared, the way `matchesPullRequestQuery` is shared for
 * pull requests — so the two call sites can't drift apart.
 *
 * A `pr` review reads only stored fields (`prNumber`, `subject`) — never a
 * live forge lookup — so a review whose forge provider is gone still labels
 * correctly; see constraints.md's "no live pull request metadata" rule.
 */
export function reviewTargetLabel(entry: ReviewTargetLabelEntry): string {
  if (entry.kind === 'pr') {
    const number = entry.prNumber !== undefined ? `#${entry.prNumber}` : '#?';
    return `PR ${number}${entry.subject ? ` ${entry.subject}` : ''}`;
  }
  if (entry.kind === 'commit') {
    return `${entry.headSha.slice(0, 7)}${entry.subject ? ` "${entry.subject}"` : ''}`;
  }
  if (entry.kind === 'range') return `${entry.baseSha.slice(0, 7)}..${entry.headSha.slice(0, 7)}`;
  return `${entry.baseRef} ← ${entry.headRef}`;
}

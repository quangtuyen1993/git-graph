/**
 * Why `graph.getRow` answered `null`.
 *
 * `null` has exactly two causes: the layout has no row for the commit because
 * the active branch filter excluded it (`filtered`), or the repository does not
 * hold the commit at all (`absent`). They call for opposite remedies — clearing
 * a filter versus fetching — so a call site that guesses offers a button that
 * cannot work.
 */
export type MissingRowReason = 'filtered' | 'absent';

/**
 * Picks the reason from the one fact that separates them.
 *
 * A hash only reaches a `getRow` call site after the graph has finished
 * building and the lookup has been confirmed current, so "not loaded yet" and
 * "the layout moved on" are already ruled out by the callers. That leaves the
 * filter: with one active it is the explanation, and without one the commit is
 * genuinely not there.
 *
 * The function stays pure — it takes no closure over the caller's state. The
 * remedy each site offers differs (the pull-request jump re-fetches or clears
 * the filter and retries; commit search offers nothing), so the actions belong
 * at the call sites and only the decision is shared.
 */
export function missingRowReason(opts: { branchFilterActive: boolean }): MissingRowReason {
  return opts.branchFilterActive ? 'filtered' : 'absent';
}

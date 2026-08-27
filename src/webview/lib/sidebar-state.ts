/**
 * The pull request section's status filter — `open` matches the host
 * vocabulary in `PullRequestListState` (extension/services/forge/forge.types.ts);
 * `all` is a UI-only value meaning "fetch open, merged and closed, then
 * merge them" — no provider ever receives it directly.
 */
export type PullRequestListFilter = 'open' | 'merged' | 'closed' | 'all';

const PULL_REQUEST_LIST_FILTERS: ReadonlySet<string> = new Set(['open', 'merged', 'closed', 'all']);

/** Falls back to `'open'` for anything not shaped like a known filter — including state persisted before this field existed. */
export function normalizePullRequestListFilter(value: unknown): PullRequestListFilter {
  return typeof value === 'string' && PULL_REQUEST_LIST_FILTERS.has(value)
    ? value as PullRequestListFilter
    : 'open';
}

/**
 * The sidebar's expand/collapse snapshot, persisted per repository so the
 * sidebar reopens the way the user left it. `pullRequestsFilter` is optional
 * so state saved before this field existed still round-trips through
 * `isSidebarPersistedState` below.
 */
export interface SidebarPersistedState {
  sections: Record<string, boolean>;
  expandedRemotes: Record<string, boolean>;
  expandedGroups: Record<string, boolean>;
  pullRequestsFilter?: PullRequestListFilter;
}

/** Storage may hand back anything; only a well-shaped snapshot is applied. */
export function isSidebarPersistedState(value: unknown): value is SidebarPersistedState {
  const state = value as SidebarPersistedState | null;
  return !!state
    && typeof state === 'object'
    && typeof state.sections === 'object' && state.sections !== null
    && typeof state.expandedRemotes === 'object' && state.expandedRemotes !== null
    && typeof state.expandedGroups === 'object' && state.expandedGroups !== null;
}

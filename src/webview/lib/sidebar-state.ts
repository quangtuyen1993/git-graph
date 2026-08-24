/**
 * The sidebar's expand/collapse snapshot, persisted per repository so the
 * sidebar reopens the way the user left it.
 */
export interface SidebarPersistedState {
  sections: Record<string, boolean>;
  expandedRemotes: Record<string, boolean>;
  expandedGroups: Record<string, boolean>;
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

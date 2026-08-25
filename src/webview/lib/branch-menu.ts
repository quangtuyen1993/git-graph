export interface MenuBranch {
  name: string;
  current: boolean;
  remote: string | null;
  upstream: string | null;
}

export interface PullTarget {
  remote: string;
  ref: string;
}

function splitRemoteRef(fullName: string): PullTarget | null {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) return null;
  return { remote: fullName.slice(0, slash), ref: fullName.slice(slash + 1) };
}

/**
 * "Pull into current" integrates someone else's ref, so it needs a concrete
 * remote and ref. A remote branch supplies both directly; a local branch
 * borrows them from its upstream. Without an upstream there is nothing to
 * pull, and the menu item is omitted rather than shown disabled.
 */
export function resolvePullTarget(branch: MenuBranch): PullTarget | null {
  if (branch.remote) return splitRemoteRef(branch.name);
  if (branch.upstream) return splitRemoteRef(branch.upstream);
  return null;
}

export function localNameFor(branch: MenuBranch): string {
  return branch.remote ? branch.name.replace(/^[^/]+\//, '') : branch.name;
}

export function formatBranchFilterLabel(selected: string[]): string {
  if (selected.length === 0) return 'All branches';
  if (selected.length === 1) return selected[0];
  return `${selected.length} branches`;
}

export function formatFilterStatus(totalRows: number, selected: string[], branchCount: number): string {
  if (selected.length === 0) return `${branchCount} branches, ${totalRows} commits`;
  if (selected.length === 1) return `${totalRows} commits on ${selected[0]}`;
  return `${totalRows} commits on ${selected.length} branches`;
}

export interface WorkingTreeStatus {
  staged: unknown[];
  unstaged: unknown[];
  untracked: unknown[];
  conflicted: unknown[];
}

export function hasWorkingTreeChanges(status: WorkingTreeStatus): boolean {
  return status.staged.length > 0 ||
    status.unstaged.length > 0 ||
    status.untracked.length > 0 ||
    status.conflicted.length > 0;
}

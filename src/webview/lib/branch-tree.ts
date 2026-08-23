export interface NamedBranch {
  name: string;
}

export interface BranchTreeNode<TBranch extends NamedBranch> {
  label: string;
  path: string;
  branch: TBranch | null;
  children: BranchTreeNode<TBranch>[];
}

export function buildBranchTree<TBranch extends NamedBranch>(
  branches: TBranch[],
  pathForBranch: (branch: TBranch) => string = branch => branch.name,
): BranchTreeNode<TBranch>[] {
  const roots: BranchTreeNode<TBranch>[] = [];

  for (const branch of [...branches].sort((left, right) => (
    pathForBranch(left).localeCompare(pathForBranch(right))
  ))) {
    const segments = pathForBranch(branch).split('/').filter(Boolean);
    let siblings = roots;

    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join('/');
      let node = siblings.find(candidate => candidate.label === segments[index]);
      if (!node) {
        node = { label: segments[index], path, branch: null, children: [] };
        siblings.push(node);
      }
      if (index === segments.length - 1) node.branch = branch;
      siblings = node.children;
    }
  }

  return roots;
}

export function activeBranchGroupPaths(branchName: string): string[] {
  const segments = branchName.split('/').filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

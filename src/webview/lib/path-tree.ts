/**
 * Groups slash-separated paths into a folder tree.
 *
 * Shared by the branch sidebar (which splits `feat/graph/x` on `/`) and the
 * commit detail's changed-file list (which splits `src/lib/x.ts` the same way),
 * so the two cannot drift apart.
 */
export interface PathTreeNode<TItem> {
  /** The single segment this node represents, e.g. `lib`. */
  label: string;
  /** The full path down to and including this node, e.g. `src/lib`. */
  path: string;
  /** The item that ends here, or null for an intermediate folder. */
  item: TItem | null;
  children: PathTreeNode<TItem>[];
}

export function buildPathTree<TItem>(
  items: TItem[],
  pathOf: (item: TItem) => string,
): PathTreeNode<TItem>[] {
  const roots: PathTreeNode<TItem>[] = [];

  for (const item of [...items].sort((left, right) => pathOf(left).localeCompare(pathOf(right)))) {
    const segments = pathOf(item).split('/').filter(Boolean);
    let siblings = roots;

    for (let index = 0; index < segments.length; index += 1) {
      const path = segments.slice(0, index + 1).join('/');
      let node = siblings.find((candidate) => candidate.label === segments[index]);
      if (!node) {
        node = { label: segments[index], path, item: null, children: [] };
        siblings.push(node);
      }
      if (index === segments.length - 1) node.item = item;
      siblings = node.children;
    }
  }

  return roots;
}

/** How many items sit at or beneath this node — folders themselves do not count. */
export function countLeaves<TItem>(node: PathTreeNode<TItem>): number {
  const own = node.item ? 1 : 0;
  return node.children.reduce((total, child) => total + countLeaves(child), own);
}

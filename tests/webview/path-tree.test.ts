import { describe, expect, it } from 'vitest';
import { buildPathTree, countLeaves } from '../../src/webview/lib/path-tree';

const file = (path: string) => ({ path });

describe('buildPathTree', () => {
  it('groups paths into folders', () => {
    const tree = buildPathTree([file('images/icon.png')], (f) => f.path);

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('images');
    expect(tree[0].item).toBeNull();
    expect(tree[0].children[0].label).toBe('icon.png');
    expect(tree[0].children[0].item).toEqual(file('images/icon.png'));
  });

  it('keeps a root-level path as a leaf with no folder', () => {
    const tree = buildPathTree([file('README.md')], (f) => f.path);

    expect(tree[0].label).toBe('README.md');
    expect(tree[0].children).toHaveLength(0);
    expect(tree[0].item).toEqual(file('README.md'));
  });

  it('shares a folder between siblings rather than repeating it', () => {
    const tree = buildPathTree(
      [file('src/a.ts'), file('src/b.ts')],
      (f) => f.path,
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((child) => child.label)).toEqual(['a.ts', 'b.ts']);
  });

  it('nests deeply and records the full path on every node', () => {
    const tree = buildPathTree([file('src/lib/deep/x.ts')], (f) => f.path);

    expect(tree[0].path).toBe('src');
    expect(tree[0].children[0].path).toBe('src/lib');
    expect(tree[0].children[0].children[0].path).toBe('src/lib/deep');
  });

  it('sorts by path so the order does not depend on input order', () => {
    const tree = buildPathTree([file('z.ts'), file('a.ts')], (f) => f.path);

    expect(tree.map((node) => node.label)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('countLeaves', () => {
  it('counts the files beneath a folder, not its folders', () => {
    const [root] = buildPathTree(
      [file('src/a.ts'), file('src/lib/b.ts'), file('src/lib/c.ts')],
      (f) => f.path,
    );

    expect(countLeaves(root)).toBe(3);
  });

  it('counts a leaf as one', () => {
    const [leaf] = buildPathTree([file('a.ts')], (f) => f.path);

    expect(countLeaves(leaf)).toBe(1);
  });
});

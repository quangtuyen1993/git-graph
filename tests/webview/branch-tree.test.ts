import { describe, expect, it } from 'vitest';
import { activeBranchGroupPaths, buildBranchTree } from '../../src/webview/lib/branch-tree';

interface TestBranch {
  name: string;
  current: boolean;
}

const branch = (name: string, current = false): TestBranch => ({ name, current });

describe('branch tree', () => {
  it('nests slash-delimited branch segments without losing leaf branches', () => {
    const tree = buildBranchTree([
      branch('main'),
      branch('fix/abc/abce'),
      branch('fix/abc/abcd', true),
      branch('fix/other/one'),
    ]);

    expect(tree.map(node => node.label)).toEqual(['fix', 'main']);
    expect(tree[0].children.map(node => node.label)).toEqual(['abc', 'other']);
    expect(tree[0].children[0].children.map(node => node.label)).toEqual(['abcd', 'abce']);
    expect(tree[0].children[0].children.map(node => node.branch?.name)).toEqual([
      'fix/abc/abcd',
      'fix/abc/abce',
    ]);
    expect(tree[1].branch?.name).toBe('main');
  });

  it('returns only ancestor groups for the active branch', () => {
    expect(activeBranchGroupPaths('fix/abc/abcd')).toEqual(['fix', 'fix/abc']);
    expect(activeBranchGroupPaths('main')).toEqual([]);
  });
});

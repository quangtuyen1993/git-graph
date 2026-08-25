import { describe, expect, it, vi } from 'vitest';
import { openCompareDiff } from '../../src/extension/services/compare-diff';

function harness(over: Record<string, unknown> = {}) {
  const contents = new Map<string, string>();
  const executeDiff = vi.fn(async (_left: unknown, _right: unknown, _title: string) => {});
  const deps = {
    git: {
      showFile: vi.fn(async (ref: string) => `content@${ref}`),
      branches: vi.fn(async () => [{ name: 'feat/x', current: true }]),
      getRepoPath: () => '/repo',
    },
    setContent: (key: string, content: string) => { contents.set(key, content); },
    virtualUri: (path: string, query: string) => ({ toString: () => `virt:${path}?${query}` }),
    fileUri: (repoPath: string, path: string) => `file:${repoPath}/${path}`,
    executeDiff,
    nextTag: () => 'ts=1&session=1&request=1',
    ...over,
  };
  return { deps, contents, executeDiff };
}

describe('openCompareDiff', () => {
  it('diffs base content against the working file when head is checked out', async () => {
    const { deps, executeDiff, contents } = harness();

    await openCompareDiff(deps as never, {
      path: 'src/a.ts', oldPath: null, sourceBranch: 'main', targetBranch: 'feat/x', status: 'modified',
    });

    const [left, right, title] = executeDiff.mock.calls[0];
    expect(String(left)).toContain('side=base');
    expect(right).toBe('file:/repo/src/a.ts');
    expect(title).toBe('a.ts (main → feat/x)');
    expect(contents.get(String(left))).toBe('content@main');
  });

  it('uses a virtual head uri when head is not the checked-out branch', async () => {
    const { deps, executeDiff } = harness({
      git: {
        showFile: vi.fn(async (ref: string) => `content@${ref}`),
        branches: vi.fn(async () => [{ name: 'other', current: true }]),
        getRepoPath: () => '/repo',
      },
    });

    await openCompareDiff(deps as never, {
      path: 'src/a.ts', sourceBranch: 'main', targetBranch: 'feat/x',
    });

    const [, right] = executeDiff.mock.calls[0];
    expect(String(right)).toContain('side=head');
  });

  it('skips base content for an added file and titles it as added', async () => {
    const { deps, executeDiff, contents } = harness();

    await openCompareDiff(deps as never, {
      path: 'src/new.ts', sourceBranch: 'main', targetBranch: 'feat/x', status: 'added',
    });

    const [left, , title] = executeDiff.mock.calls[0];
    expect(contents.get(String(left))).toBe('');
    expect(title).toBe('new.ts (added in feat/x)');
  });

  it('reads the old path on the base side of a rename', async () => {
    const showFile = vi.fn(async (_ref: string, path: string) => `content:${path}`);
    const { deps, contents, executeDiff } = harness({
      git: { showFile, branches: vi.fn(async () => [{ name: 'feat/x', current: true }]), getRepoPath: () => '/repo' },
    });

    await openCompareDiff(deps as never, {
      path: 'src/renamed.ts', oldPath: 'src/old.ts', sourceBranch: 'main', targetBranch: 'feat/x', status: 'renamed',
    });

    expect(showFile).toHaveBeenCalledWith('main', 'src/old.ts');
    const [left] = executeDiff.mock.calls[0];
    expect(contents.get(String(left))).toBe('content:src/old.ts');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { GraphService } from '../src/extension/services/graph.service';
import { BRANCH_COLORS, getColor } from '../src/webview/lib/graph-colors';
import { getGravatarUrl, md5 } from '../src/webview/lib/gravatar';
import { calculateVisibleRange, getTotalHeight } from '../src/webview/lib/virtual-scroll';
import { calculatePanelLayout, resizePanel } from '../src/webview/lib/panel-layout';
import { GitService } from '../src/extension/services/git.service';
import type { Commit } from '../src/extension/types/git.types';
import { BRANCH_FORMAT, TAG_FORMAT, LOG_FORMAT } from '../src/extension/utils/git-parser';

const commit = (hash: string, parents: string[] = []): Commit => ({
  hash, abbreviatedHash: hash.slice(0, 7), parents, author: 'A', authorEmail: 'a@example.com',
  authorDate: '2026-01-01T00:00:00Z', committer: 'A', committerEmail: 'a@example.com',
  committerDate: '2026-01-01T00:00:00Z', message: hash, subject: hash, refs: [],
});

describe('coverage closure helpers', () => {
  it('builds graph lanes, merge edges, windows, and empty state', () => {
    const service = new GraphService();
    expect(service.getWindow(0, 2).totalRows).toBe(0);
    const layout = service.buildLayout([
      commit('merge', ['main', 'side']), commit('main', ['root']), commit('side', ['root']), commit('root'),
    ]);
    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(4);
    expect(layout.maxLane).toBeGreaterThan(0);
    expect(service.getTotalRows()).toBe(4);
    expect(service.getWindow(-2, 2)).toMatchObject({ startRow: 0, endRow: 2, nodes: expect.any(Array) });
    expect(service.getWindow(3, 20).edges.length).toBeGreaterThan(0);
    expect(service.getMaxLane()).toBe(layout.maxLane);
  });

  it('covers colors, scroll ranges, panel sizing, and gravatar', () => {
    expect(getColor(0)).toBe(BRANCH_COLORS[0]);
    expect(getColor(BRANCH_COLORS.length)).toBe(BRANCH_COLORS[0]);
    expect(md5('  Test@Example.com ')).toBe('55502f40dc8b7c769880b10874abc9d0');
    expect(getGravatarUrl(' Test@Example.com ', 42)).toContain('s=84');
    expect(calculateVisibleRange({ scrollTop: 640, viewportHeight: 320, totalRows: 100 })).toEqual({ startRow: 0, endRow: 50, count: 50 });
    expect(calculateVisibleRange({ scrollTop: 3200, viewportHeight: 320, totalRows: 100 })).toEqual({ startRow: 80, endRow: 100, count: 20 });
    expect(getTotalHeight(3)).toBe(96);
    const narrow = calculatePanelLayout({ viewportWidth: 400, leftOpen: true, rightOpen: true, leftWidth: 350, rightWidth: 350 });
    expect(narrow.left.width + narrow.right.width).toBeLessThanOrEqual(96);
    expect(resizePanel({ viewportWidth: 1200, leftOpen: true, rightOpen: false, leftWidth: 200, rightWidth: 300 }, 'left', 999).left.width).toBe(460);

  });

  it('covers GitService command construction and defensive branches', async () => {
    const service = new GitService('/repo');
    const calls: string[][] = [];
    const exec = vi.fn(async (args: string[]) => { calls.push(args); return ''; });
    (service as any).cli = { getRepoPath: () => '/repo', setRepoPath: vi.fn(), exec };
    const cases: Array<{ name: string; expected: string[]; run: () => Promise<unknown> }> = [
      { name: 'log options', expected: ['log', `--format=${LOG_FORMAT}`, '--max-count=2', '--skip=1', '--author=A', '--grep=x', '--after=y', '--before=z', '--all', 'main'], run: () => service.log({ maxCount: 2, skip: 1, author: 'A', grep: 'x', after: 'y', before: 'z', all: true, branch: 'main' }) },
      { name: 'branches', expected: ['branch', '-a', `--format=${BRANCH_FORMAT}`], run: () => service.branches() },
      { name: 'tags', expected: ['tag', '-l', `--format=${TAG_FORMAT}`], run: () => service.tags() },
      { name: 'status', expected: ['status', '--porcelain=v2', '--branch', '-z'], run: () => service.status() },
      { name: 'git directory', expected: ['rev-parse', '--absolute-git-dir'], run: () => service.gitDirectory() },
      { name: 'checkout', expected: ['checkout', 'main'], run: () => service.checkout('main') },
      { name: 'branch', expected: ['branch', 'b'], run: () => service.createBranch('b') },
      { name: 'branch start', expected: ['branch', 'c', 'HEAD'], run: () => service.createBranch('c', 'HEAD') },
      { name: 'delete', expected: ['branch', '-d', 'b'], run: () => service.deleteBranch('b') },
      { name: 'delete force', expected: ['branch', '-D', 'b'], run: () => service.deleteBranch('b', true) },
      { name: 'rename', expected: ['branch', '-m', 'b', 'c'], run: () => service.renameBranch('b', 'c') },
      { name: 'merge', expected: ['merge', 'b', '--no-ff', '-m', 'm'], run: () => service.merge('b', { noFF: true, message: 'm' }) },
      { name: 'rebase', expected: ['rebase', 'main'], run: () => service.rebase('main') },
      { name: 'cherry-pick', expected: ['cherry-pick', 'h'], run: () => service.cherryPick('h') },
      { name: 'revert', expected: ['revert', '--no-edit', 'h'], run: () => service.revert('h') },
      { name: 'stash push', expected: ['stash', 'push', '-m', 'save'], run: () => service.stash('push', { message: 'save' }) },
      { name: 'stash pop', expected: ['stash', 'pop', 'stash@{2}'], run: () => service.stash('pop', { index: 2 }) },
      { name: 'stash drop', expected: ['stash', 'drop'], run: () => service.stash('drop') },
      { name: 'stash apply', expected: ['stash', 'apply'], run: () => service.stashApply() },
      { name: 'push', expected: ['push', '--force-with-lease', '-u', 'origin', 'main'], run: () => service.push('origin', 'main', { force: true, setUpstream: true }) },
      { name: 'pull', expected: ['pull', '--rebase', 'origin', 'main'], run: () => service.pull('origin', 'main', { rebase: true }) },
      { name: 'fetch all', expected: ['fetch', '--all'], run: () => service.fetch() },
      { name: 'reset', expected: ['reset', '--hard', 'HEAD'], run: () => service.reset('hard', 'HEAD') },
      { name: 'annotated tag', expected: ['tag', '-a', 'w', '-m', 'tag', 'HEAD'], run: () => service.createTag('w', 'HEAD', 'tag') },
      { name: 'tag', expected: ['tag', 'v'], run: () => service.createTag('v') },
      { name: 'delete tag', expected: ['tag', '-d', 'v'], run: () => service.deleteTag('v') },
      { name: 'abort merge', expected: ['merge', '--abort'], run: () => service.abortMerge() },
      { name: 'abort rebase', expected: ['rebase', '--abort'], run: () => service.abortRebase() },
      { name: 'short stats', expected: ['log', '--shortstat', '--format=%H', '--all', '--max-count=500'], run: () => service.getShortStats() },
      { name: 'show file', expected: ['show', 'h:missing'], run: () => service.showFile('h', 'missing') },
      { name: 'parents', expected: ['rev-parse', 'h^'], run: () => service.getParents('h') },
      { name: 'worktrees', expected: ['worktree', 'list', '--porcelain'], run: () => service.worktreeList() },
      { name: 'worktree new branch', expected: ['worktree', 'add', '-b', 'new', '/tmp/w'], run: () => service.worktreeAdd('/tmp/w', undefined, 'new') },
      { name: 'worktree remove', expected: ['worktree', 'remove', '--force', '/tmp/w'], run: () => service.worktreeRemove('/tmp/w', true) },
    ];
    for (const testCase of cases) {
      calls.length = 0;
      await testCase.run();
      expect(calls).toEqual([testCase.expected]);
    }
    calls.length = 0;
    await service.submoduleList();
    expect(calls).toEqual([
      ['submodule', 'status'],
      ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
    ]);
    (service as any).cli.exec = vi.fn(async (args: string[]) => { if (args[0] === 'merge-base') throw new Error('no'); if (args[0] === 'rev-parse') throw new Error('no'); return ''; });
    await expect(service.canSquash(['a'])).resolves.toMatchObject({ ok: false });
    await expect(service.canSquash(['a', 'b'])).resolves.toMatchObject({ ok: false });
    await expect(service.isOnCurrentBranch('x')).resolves.toBe(false);
    await expect(service.isPublished('x')).resolves.toBe(false);
    await expect(GitService.findRepo('/missing')).resolves.toBeNull();
  });
});

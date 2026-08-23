import { describe, expect, it, vi } from 'vitest';
import { GraphService } from '../src/extension/services/graph.service';
import { BRANCH_COLORS, getColor } from '../src/webview/lib/graph-colors';
import { getGravatarUrl, md5 } from '../src/webview/lib/gravatar';
import { calculateVisibleRange, getTotalHeight } from '../src/webview/lib/virtual-scroll';
import { calculatePanelLayout, resizePanel } from '../src/webview/lib/panel-layout';
import { GitService } from '../src/extension/services/git.service';
import type { Commit } from '../src/extension/types/git.types';

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
    expect(getGravatarUrl(' Test@Example.com ', 42)).toContain('s=42');
    expect(calculateVisibleRange({ scrollTop: 640, viewportHeight: 320, totalRows: 100 })).toEqual({ startRow: 0, endRow: 50, count: 50 });
    expect(calculateVisibleRange({ scrollTop: 3200, viewportHeight: 320, totalRows: 100 })).toEqual({ startRow: 80, endRow: 100, count: 20 });
    expect(getTotalHeight(3)).toBe(96);
    const narrow = calculatePanelLayout({ viewportWidth: 400, leftOpen: true, rightOpen: true, leftWidth: 350, rightWidth: 350 });
    expect(narrow.left.width + narrow.right.width).toBeLessThanOrEqual(96);
    expect(resizePanel({ viewportWidth: 1200, leftOpen: true, rightOpen: false, leftWidth: 200, rightWidth: 300 }, 'left', 999).left.width).toBe(400);

  });

  it('covers GitService command construction and defensive branches', async () => {
    const service = new GitService('/repo');
    const calls: string[][] = [];
    (service as any).cli = { getRepoPath: () => '/repo', setRepoPath: vi.fn(), exec: vi.fn(async (args: string[]) => { calls.push(args); return ''; }) };
    await service.log({ maxCount: 2, skip: 1, author: 'A', grep: 'x', after: 'y', before: 'z', all: true, branch: 'main' });
    await service.branches(); await service.tags(); await service.status();
    await service.checkout('main'); await service.createBranch('b'); await service.createBranch('c', 'HEAD');
    await service.deleteBranch('b'); await service.deleteBranch('b', true); await service.renameBranch('b', 'c');
    await service.merge('b', { noFF: true, message: 'm' }); await service.rebase('main'); await service.cherryPick('h'); await service.revert('h');
    await service.stash('push', { message: 'save' }); await service.stash('pop', { index: 2 }); await service.stash('drop');
    await service.push('origin', 'main', { force: true, setUpstream: true }); await service.pull('origin', 'main', { rebase: true }); await service.fetch();
    await service.reset('hard', 'HEAD'); await service.createTag('v'); await service.createTag('w', 'HEAD', 'tag'); await service.deleteTag('v'); await service.abortMerge(); await service.abortRebase();
    await service.getShortStats(); await service.showFile('h', 'missing'); await service.getParents('h'); await service.stashApply();
    await service.worktreeList(); await service.worktreeAdd('/tmp/w'); await service.worktreeAdd('/tmp/w', 'main'); await service.worktreeAdd('/tmp/w', undefined, 'new'); await service.worktreeRemove('/tmp/w', true);
    expect(calls.length).toBeGreaterThan(30);
    (service as any).cli.exec = vi.fn(async (args: string[]) => { if (args[0] === 'merge-base') throw new Error('no'); if (args[0] === 'rev-parse') throw new Error('no'); return ''; });
    await expect(service.canSquash(['a'])).resolves.toMatchObject({ ok: false });
    await expect(service.canSquash(['a', 'b'])).resolves.toMatchObject({ ok: false });
    await expect(service.isOnCurrentBranch('x')).resolves.toBe(false);
    await expect(service.isPublished('x')).resolves.toBe(false);
    await expect(GitService.findRepo('/missing')).resolves.toBeNull();
  });
});

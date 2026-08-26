import { describe, expect, it, vi } from 'vitest';
import { createReviewHandler } from '../../src/extension/controllers/review-method-handler';
import { ReviewTargetState } from '../../src/extension/services/review-target';
import type { Commit } from '../../src/extension/types/git.types';

function harness(over: Record<string, unknown> = {}) {
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    remove: vi.fn(async () => {}),
    bodyPath: vi.fn(() => '/tmp/body.md'),
  };
  const runner = {
    start: vi.fn(async (_input: Record<string, unknown>) => 'new-id'),
    cancel: vi.fn(() => true),
    isRunning: vi.fn(() => true),
  };
  const git = {
    revParse: vi.fn(async (ref: string) => (ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40))),
    getDiff: vi.fn(async () => 'diff --git a/x b/x'),
    diff: vi.fn(async () => ({ files: [] })),
    log: vi.fn(async (): Promise<Commit[]> => []),
    getParents: vi.fn(async () => ['c'.repeat(40)]),
  };
  const targets = new ReviewTargetState();
  const focusReviewView = vi.fn(async () => {});
  const broadcast = vi.fn();
  const handler = createReviewHandler({
    store: store as never,
    runner: runner as never,
    getGitService: () => git as never,
    getRepoId: () => 'repo-a',
    getRepos: () => [{ path: '/repo/a', name: 'repo-a', active: true }],
    getMaxDiffChars: () => 0,
    openBody: vi.fn(async () => {}),
    targets,
    focusReviewView,
    broadcast,
    ...over,
  });
  return { handler, store, runner, git, targets, focusReviewView, broadcast };
}

describe('review namespace', () => {
  it('starts a run and returns its id without waiting for the CLI', async () => {
    const { handler, runner } = harness();

    const result = await handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'new-id', cached: false });
    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('reuses a completed review for the same shas and model instead of spawning', async () => {
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'done' } as never);

    const result = await handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', cached: true });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('re-runs when the cached entry failed rather than serving the failure', async () => {
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'failed' } as never);

    await handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('refuses an empty diff without creating an entry', async () => {
    const { handler, runner, git } = harness();
    git.getDiff.mockResolvedValue('   ');

    await expect(handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'main', provider: 'claude', model: 'sonnet',
    })).rejects.toThrow(/no differences/i);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('cancels through the runner', async () => {
    const { handler, runner } = harness();

    expect(await handler('review.cancel', { id: 'x' })).toEqual({ cancelled: true });
    expect(runner.cancel).toHaveBeenCalledWith('repo-a', 'x');
  });

  it('lists entries for the active repo', async () => {
    const { handler, store } = harness();

    await handler('review.list', {});
    expect(store.list).toHaveBeenCalledWith('repo-a');
  });

  it('fails clearly when no repository is active', async () => {
    const { handler } = harness({ getGitService: () => undefined });

    await expect(handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet',
    })).rejects.toThrow(/no git repository/i);
  });

  it('reuses a running review without recomputing the diff or spawning again', async () => {
    const { handler, runner, git, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'running' } as never);

    const result = await handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', cached: false });
    expect(runner.start).not.toHaveBeenCalled();
    expect(git.getDiff).not.toHaveBeenCalled();
    expect(git.diff).not.toHaveBeenCalled();
    expect(git.log).not.toHaveBeenCalled();
  });

  it.each(['review.get', 'review.cancel', 'review.delete', 'review.open'])(
    '%s refuses an id that would escape the store',
    async (method) => {
      const { handler, store, runner } = harness();

      await expect(handler(method, { id: '../../../../tmp/victim' })).rejects.toThrow(/invalid review id/i);

      expect(store.get).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
      expect(runner.cancel).not.toHaveBeenCalled();
    },
  );
  it('restarts a `running` entry the runner is not actually working on', async () => {
    // I4: a run dies with the window. Trusting the persisted status hands back
    // an id nothing is working on — the row spins forever, the 1 Hz ticker
    // never stops, and that review can never be restarted.
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'running' } as never);
    runner.isRunning.mockReturnValue(false);

    const result = await handler('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(runner.isRunning).toHaveBeenCalledWith('aaaaaaa..bbbbbbb.claude.sonnet');
    expect(runner.start).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: 'new-id', cached: false });
  });

  it('reviews a single commit against its first parent', async () => {
    const { handler, runner, git } = harness();
    git.log.mockResolvedValue([{ subject: 'fix: y' }] as never);

    await handler('review.start', { kind: 'commit', headRef: 'b'.repeat(40), provider: 'claude', model: '' });

    const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
    expect(input.kind).toBe('commit');
    expect(input.baseSha).toBe('c'.repeat(40));
    expect(input.subject).toBe('fix: y');
    // diff chạy trên cặp đã resolve
    expect(git.getDiff).toHaveBeenCalledWith('c'.repeat(40), 'b'.repeat(40));
  });

  it('setTarget stores, focuses the review view, and broadcasts', async () => {
    const { handler, targets, focusReviewView, broadcast } = harness();

    await handler('review.setTarget', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });

    expect(targets.get('repo-a')).toMatchObject({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    expect(focusReviewView).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith('review.target',
      expect.objectContaining({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' }));
  });

  it('setTarget with a dead ref rejects with the ref name and stores nothing', async () => {
    const { handler, targets, git } = harness();
    git.revParse.mockRejectedValue(new Error('unknown revision'));

    await expect(handler('review.setTarget', { kind: 'branch', baseRef: 'gone', headRef: 'feat/x' }))
      .rejects.toThrow(/"/);
    expect(targets.get('repo-a')).toBeNull();
  });

  it('getTarget returns what setTarget stored, null before that', async () => {
    const { handler } = harness();
    expect(await handler('review.getTarget', {})).toBeNull();
    await handler('review.setTarget', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    expect(await handler('review.getTarget', {})).toMatchObject({ headRef: 'feat/x' });
  });

  it('rerun removes the entry and starts again from its stored target', async () => {
    const { handler, store, runner } = harness();
    store.get.mockResolvedValueOnce({
      id: 'old-id', kind: 'branch', baseRef: 'main', baseSha: 'a'.repeat(40),
      headRef: 'feat/x', headSha: 'b'.repeat(40), provider: 'claude', model: 'sonnet',
      status: 'failed', startedAt: '2026-08-01T00:00:00.000Z',
    } as never);

    const result = await handler('review.rerun', { id: 'old-id' });

    expect(store.remove).toHaveBeenCalledWith('repo-a', 'old-id');
    expect(runner.start).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ cached: false });
  });

  it('compare resolves the target and returns the changed files', async () => {
    const { handler, git } = harness();
    git.diff.mockResolvedValue({ files: [{ path: 'a.ts' }] } as never);

    const result = await handler('review.compare', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });

    expect(result).toEqual({ files: [{ path: 'a.ts' }] });
    expect(git.diff).toHaveBeenCalledWith('main', 'feat/x');
  });

  it('review.getRepos returns the repository list', async () => {
    const repos = [
      { path: '/repo/a', name: 'repo-a', active: true },
      { path: '/repo/b', name: 'repo-b', active: false },
    ];
    const { handler } = harness({ getRepos: () => repos });
    const result = await handler('review.getRepos', {});
    expect(result).toEqual(repos);
  });

  it('review.getCommits returns recent commits mapped to summary fields', async () => {
    const { handler, git } = harness();
    git.log.mockResolvedValue([
      {
        hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa',
        parents: [], author: 'A', authorEmail: 'a@test', authorDate: '2026-08-24T00:00:00Z',
        committer: 'A', committerEmail: 'a@test', committerDate: '2026-08-24T00:00:00Z',
        message: 'First', subject: 'First', refs: [],
      },
    ]);
    const result = await handler('review.getCommits', { limit: 50 });
    expect(result).toEqual([
      { hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'First', authorDate: '2026-08-24T00:00:00Z' },
    ]);
    expect(git.log).toHaveBeenCalledWith({ maxCount: 50 });
  });

  it('review.getCommits defaults to 100 when no limit is given', async () => {
    const { handler, git } = harness();
    git.log.mockResolvedValue([]);
    await handler('review.getCommits', {});
    expect(git.log).toHaveBeenCalledWith({ maxCount: 100 });
  });
});

describe('review.saveTarget', () => {
  it('stores the target without resolving refs, focusing, or broadcasting', async () => {
    const { handler, targets, focusReviewView, broadcast, git } = harness();

    const result = await handler('review.saveTarget', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x',
    });

    expect(result).toEqual({ success: true });
    expect(targets.get('repo-a')).toMatchObject({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    expect(git.revParse).not.toHaveBeenCalled();
    expect(focusReviewView).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('keeps the subject so a persisted commit chip can still render', async () => {
    const { handler, targets } = harness();

    await handler('review.saveTarget', {
      kind: 'commit', baseRef: 'c'.repeat(40), headRef: 'b'.repeat(40), subject: 'fix: y',
    });

    expect(targets.get('repo-a')?.subject).toBe('fix: y');
  });

  it('rejects a malformed target instead of persisting garbage', async () => {
    const { handler, targets } = harness();

    await expect(handler('review.saveTarget', { kind: 'nope', headRef: 'x' }))
      .rejects.toThrow();
    expect(targets.get('repo-a')).toBeNull();
  });
});

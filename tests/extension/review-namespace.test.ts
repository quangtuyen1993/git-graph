import { describe, expect, it, vi } from 'vitest';
import { createReviewHandler } from '../../src/extension/controllers/review-method-handler';

function harness(over: Record<string, unknown> = {}) {
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    remove: vi.fn(async () => {}),
    bodyPath: vi.fn(() => '/tmp/body.md'),
  };
  const runner = { start: vi.fn(async () => 'new-id'), cancel: vi.fn(() => true) };
  const git = {
    revParse: vi.fn(async (ref: string) => (ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40))),
    getDiff: vi.fn(async () => 'diff --git a/x b/x'),
    diff: vi.fn(async () => ({ files: [] })),
    log: vi.fn(async () => []),
  };
  const handler = createReviewHandler({
    store: store as never,
    runner: runner as never,
    getGitService: () => git as never,
    getRepoId: () => 'repo-a',
    getMaxDiffChars: () => 0,
    openBody: vi.fn(async () => {}),
    ...over,
  });
  return { handler, store, runner, git };
}

describe('review namespace', () => {
  it('starts a run and returns its id without waiting for the CLI', async () => {
    const { handler, runner } = harness();

    const result = await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'new-id', cached: false });
    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('reuses a completed review for the same shas and model instead of spawning', async () => {
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'done' } as never);

    const result = await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', cached: true });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('re-runs when the cached entry failed rather than serving the failure', async () => {
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'failed' } as never);

    await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('refuses an empty diff without creating an entry', async () => {
    const { handler, runner, git } = harness();
    git.getDiff.mockResolvedValue('   ');

    await expect(handler('review.start', {
      sourceBranch: 'main', targetBranch: 'main', provider: 'claude', model: 'sonnet',
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
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    })).rejects.toThrow(/no git repository/i);
  });

  it('reuses a running review without recomputing the diff or spawning again', async () => {
    const { handler, runner, git, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'running' } as never);

    const result = await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', cached: false });
    expect(runner.start).not.toHaveBeenCalled();
    expect(git.getDiff).not.toHaveBeenCalled();
    expect(git.diff).not.toHaveBeenCalled();
    expect(git.log).not.toHaveBeenCalled();
  });
});

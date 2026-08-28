import { describe, expect, it, vi } from 'vitest';
import { createReviewHandler } from '../../src/extension/controllers/review-method-handler';
import { ReviewTargetState } from '../../src/extension/services/review-target';
import type { Commit } from '../../src/extension/types/git.types';
import { fakePullRequest, FAKE_PR_FILES } from '../helpers/fake-forge-provider';
import type { ForgeComment, PullRequestDetail, PullRequestFile } from '../../src/extension/services/forge/forge.types';

function harness(over: Record<string, unknown> = {}) {
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    remove: vi.fn(async () => {}),
    bodyPath: vi.fn(() => '/tmp/body.md'),
    readBody: vi.fn(async () => ''),
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
    // The pull request path never uses revParse to test locality — it needs
    // its own real existence check. Tests that care about local-vs-forge
    // routing override this per case.
    commitExists: vi.fn(async () => true),
  };
  // A pull request that has never been fetched: forge is the only place that
  // knows about it, which is exactly the shape review.start's 'pr' branch
  // must work against.
  const forge = {
    getPullRequest: vi.fn(async (): Promise<PullRequestDetail> => fakePullRequest()),
    getDiff: vi.fn(async () => 'diff --git a/x b/x'),
    getFiles: vi.fn(async (): Promise<PullRequestFile[]> => FAKE_PR_FILES),
    getComments: vi.fn(async (): Promise<ForgeComment[]> => []),
    getProviderId: vi.fn(async () => 'bitbucket-cloud'),
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
    forge: forge as never,
    ...over,
  });
  return { handler, store, runner, git, forge, targets, focusReviewView, broadcast };
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

  it.each(['review.get', 'review.cancel', 'review.delete', 'review.open', 'review.body'])(
    '%s refuses an id that would escape the store',
    async (method) => {
      const { handler, store, runner } = harness();

      await expect(handler(method, { id: '../../../../tmp/victim' })).rejects.toThrow(/invalid review id/i);

      expect(store.get).not.toHaveBeenCalled();
      expect(store.remove).not.toHaveBeenCalled();
      expect(store.readBody).not.toHaveBeenCalled();
      expect(runner.cancel).not.toHaveBeenCalled();
    },
  );

  it('review.body returns the stored review body for a valid id', async () => {
    const { handler, store } = harness();
    store.readBody.mockResolvedValue('# Review\n\nLooks good.');

    const result = await handler('review.body', { id: 'aaaaaaa..bbbbbbb.claude.sonnet' });

    expect(result).toBe('# Review\n\nLooks good.');
    expect(store.readBody).toHaveBeenCalledWith('repo-a', 'aaaaaaa..bbbbbbb.claude.sonnet');
  });

  it('review.body returns an empty string when the body file is missing', async () => {
    const { handler, store } = harness();
    store.readBody.mockResolvedValue('');

    const result = await handler('review.body', { id: 'aaaaaaa..bbbbbbb.claude.sonnet' });

    expect(result).toBe('');
  });
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

  it('setTarget resolves a pull request through forge, never through revParse', async () => {
    // Mirrors review.start's own 'pr' branch: the sha pair must come from
    // PullRequestDetail, not from resolving headRef/baseRef through git —
    // targetFromParams leaves both '' for kind 'pr', so a naive setTarget
    // that always calls resolveReviewTarget would revParse the empty string.
    const { handler, targets, focusReviewView, broadcast, git, forge } = harness();
    forge.getPullRequest.mockResolvedValue(fakePullRequest({
      id: '123', number: 7, title: 'Add feature',
      sourceBranch: 'feature/x', targetBranch: 'develop',
    }));

    const result = await handler('review.setTarget', { kind: 'pr', prId: '123' });

    expect(result).toEqual({ success: true });
    expect(git.revParse).not.toHaveBeenCalled();
    expect(targets.get('repo-a')).toMatchObject({
      kind: 'pr', prId: '123', baseRef: 'develop', headRef: 'feature/x', subject: 'Add feature',
    });
    expect(focusReviewView).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith('review.target',
      expect.objectContaining({ kind: 'pr', prId: '123' }));
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

  it('round-trips a pull request target', async () => {
    // I5: saveTarget round-trips a 'pr' target — the pickers must be able to
    // reopen on the same pull request after a window reload.
    const { handler, targets, git } = harness();

    const result = await handler('review.saveTarget', {
      kind: 'pr', prId: 'PR-9', headRef: 'feature/x', subject: 'Add feature',
    });

    expect(result).toEqual({ success: true });
    expect(targets.get('repo-a')).toMatchObject({ kind: 'pr', prId: 'PR-9', subject: 'Add feature' });
    expect(git.revParse).not.toHaveBeenCalled();
  });

  it('rejects a pull request target with no id', async () => {
    const { handler, targets } = harness();

    await expect(handler('review.saveTarget', { kind: 'pr', headRef: 'feature/x' }))
      .rejects.toThrow(/invalid review target/i);
    expect(targets.get('repo-a')).toBeNull();
  });
});

describe('review.start for a pull request', () => {
  it('uses the local diff and never touches the forge diff when both shas are already fetched', async () => {
    // I2: a fully-fetched pull request must diff locally, not through the API.
    const { handler, runner, git, forge } = harness();
    git.commitExists.mockResolvedValue(true);

    const result = await handler('review.start', { kind: 'pr', prId: '123', provider: 'claude', model: 'sonnet' });

    expect(result).toMatchObject({ cached: false });
    expect(git.getDiff).toHaveBeenCalledWith('b'.repeat(40), 'a'.repeat(40));
    expect(forge.getDiff).not.toHaveBeenCalled();
    // Files still come from forge.pr.files even on the local path.
    expect(forge.getFiles).toHaveBeenCalledWith('123');
    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('includes commit subjects only on the local path', async () => {
    const { handler, git, runner } = harness();
    git.commitExists.mockResolvedValue(true);
    git.log.mockResolvedValue([{ subject: 'fix: race' }] as never);

    await handler('review.start', { kind: 'pr', prId: '123', provider: 'claude', model: 'sonnet' });

    const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
    expect(input.payloadText).toContain('fix: race');
  });

  it('omits commit subjects on the forge-diff path — the interface has no support for them there', async () => {
    const { handler, git, forge, runner } = harness();
    git.commitExists.mockResolvedValue(false);

    await handler('review.start', { kind: 'pr', prId: '123', provider: 'claude', model: 'sonnet' });

    expect(forge.getDiff).toHaveBeenCalledWith('123');
    expect(git.log).not.toHaveBeenCalled();
    const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
    expect(input.payloadText).not.toContain('### Commits');
  });

  it('files history as "PR #<number> <title>" via the existing subject field, and rerun re-fetches the pull request', async () => {
    // I3: the entry must carry enough for a "PR #<number> <title>" history
    // row, and a rerun must ask the provider again rather than trust the old
    // sha pair.
    const { handler, runner, store, forge } = harness();
    forge.getPullRequest.mockResolvedValue(fakePullRequest({ id: '123', number: 123, title: 'Add feature' }));

    await handler('review.start', { kind: 'pr', prId: '123', provider: 'claude', model: 'sonnet' });

    const started = runner.start.mock.calls[0][0] as Record<string, unknown>;
    expect(started.subject).toBe('Add feature');
    expect(started.prNumber).toBe(123);
    expect(started.prId).toBe('123');
    expect(started.providerId).toBe('bitbucket-cloud');

    // rerun
    store.get.mockResolvedValueOnce({
      id: 'old-id', kind: 'pr', baseRef: 'develop', baseSha: 'a'.repeat(40),
      headRef: 'feature/RMS-1027', headSha: 'b'.repeat(40), prId: '123', prNumber: 123,
      providerId: 'bitbucket-cloud', provider: 'claude', model: 'sonnet',
      status: 'done', startedAt: '2026-08-01T00:00:00.000Z',
    } as never);
    forge.getPullRequest.mockClear();

    await handler('review.rerun', { id: 'old-id' });

    expect(forge.getPullRequest).toHaveBeenCalledWith('123');
  });

  it('rejects a rerun of a pull request entry with no stored id', async () => {
    const { handler, store } = harness();
    store.get.mockResolvedValueOnce({
      id: 'old-id', kind: 'pr', baseRef: 'develop', baseSha: 'a'.repeat(40),
      headRef: 'feature/x', headSha: 'b'.repeat(40), provider: 'claude', model: 'sonnet',
      status: 'done', startedAt: '2026-08-01T00:00:00.000Z',
    } as never);

    await expect(handler('review.rerun', { id: 'old-id' })).rejects.toThrow(/missing its pull request id/i);
  });

  it('renders prior discussion ahead of the diff, carrying path, line and side for a deleted-line comment', async () => {
    // I4: a comment on a deleted line is ambiguous without path, line and side.
    const { handler, forge, runner } = harness();
    forge.getComments.mockResolvedValue([
      {
        id: 'c1', author: { displayName: 'An Tran', accountId: 'acc-1' }, body: 'Why remove this?',
        createdAt: '2026-08-25T00:00:00Z', path: 'src/a.ts', line: 42, side: 'old',
      },
    ] as never);

    await handler('review.start', { kind: 'pr', prId: '123', provider: 'claude', model: 'sonnet' });

    const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
    const text = input.payloadText as string;
    const discussionIndex = text.indexOf('Prior discussion');
    const diffIndex = text.indexOf('### Diff');
    expect(discussionIndex).toBeGreaterThan(-1);
    expect(discussionIndex).toBeLessThan(diffIndex);
    expect(text).toContain('An Tran');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('42');
    expect(text).toContain('old side');
    expect(text).toContain('Why remove this?');
  });

  it('refuses an empty diff without starting a run', async () => {
    const { handler, runner, git } = harness();
    git.commitExists.mockResolvedValue(true);
    git.getDiff.mockResolvedValue('   ');

    await expect(handler('review.start', { kind: 'pr', prId: '123', provider: 'claude', model: 'sonnet' }))
      .rejects.toThrow(/no differences/i);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('requires a pull request id', async () => {
    const { handler } = harness();
    await expect(handler('review.start', { kind: 'pr', provider: 'claude', model: 'sonnet' }))
      .rejects.toThrow(/missing pull request id/i);
  });

  it('rejects an unknown review kind up front', async () => {
    const { handler } = harness();
    await expect(handler('review.start', { kind: 'issue', headRef: 'x', provider: 'claude', model: 'sonnet' }))
      .rejects.toThrow(/unknown review kind/i);
  });
});

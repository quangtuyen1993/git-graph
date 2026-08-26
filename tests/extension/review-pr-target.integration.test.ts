import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { createReviewHandler } from '../../src/extension/controllers/review-method-handler';
import { ReviewStore } from '../../src/extension/services/review-store';
import { ReviewTargetState } from '../../src/extension/services/review-target';
import { TempGitRepo } from '../helpers/temp-git-repo';
import { fakePullRequest } from '../helpers/fake-forge-provider';

/**
 * These tests run review.start's 'pr' branch against a *real* git repository
 * and a *real* GitService — not a mocked `git` object. Requirement 3 is a
 * named trap: a plain `revParse` echoes any syntactically valid sha back
 * successfully whether or not the object exists locally, so a mocked git
 * object can be rigged to make either implementation "pass". Only a real git
 * binary distinguishes them: a well-formed-but-absent sha must make
 * `commitExists` report false, and revParse must never be consulted for
 * locality in the first place.
 */
describe('review.start against a real repository (pull request locality)', () => {
  let repo: TempGitRepo;
  let git: GitService;
  let storageRoot: string;
  let store: ReviewStore;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    await repo.commitFile('Initial commit', 'README.md', '# Test\n');
    git = new GitService(repo.path);
    storageRoot = await mkdtemp(join(tmpdir(), 'review-pr-target-'));
    store = new ReviewStore(storageRoot);
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(storageRoot, { recursive: true, force: true });
  });

  function handlerFor(forgeOverrides: Record<string, unknown> = {}) {
    const runner = {
      start: vi.fn(async (_input: Record<string, unknown>) => 'started-id'),
      cancel: vi.fn(() => true),
      isRunning: vi.fn(() => false),
    };
    const forge = {
      getPullRequest: vi.fn(async () => fakePullRequest()),
      getDiff: vi.fn(async () => 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+forge content\n'),
      getFiles: vi.fn(async () => []),
      getComments: vi.fn(async () => []),
      getProviderId: vi.fn(async () => 'bitbucket-cloud'),
      ...forgeOverrides,
    };
    const handler = createReviewHandler({
      store: store as never,
      runner: runner as never,
      getGitService: () => git as never,
      getRepoId: () => 'repo-x',
      getRepos: () => [],
      getMaxDiffChars: () => 0,
      openBody: vi.fn(async () => {}),
      targets: new ReviewTargetState(),
      focusReviewView: vi.fn(async () => {}),
      broadcast: vi.fn(),
      forge: forge as never,
    });
    return { handler, runner, forge };
  }

  it('completes via the forge diff when the head sha was never fetched, without ever consulting revParse for locality', async () => {
    // Both shas are syntactically valid 40-hex strings that do not exist as
    // objects in this repository — exactly what an unfetched pull request
    // branch looks like locally. A plain-revParse "existence check" would
    // echo each one back successfully and wrongly conclude both are present.
    const absentBase = 'e'.repeat(40);
    const absentHead = 'f'.repeat(40);
    const detail = fakePullRequest({
      id: 'PR-1', number: 7, title: 'Add feature',
      sourceCommit: absentHead, targetCommit: absentBase,
      sourceBranch: 'feature/x', targetBranch: 'main',
    });

    const revParseSpy = vi.spyOn(git, 'revParse');
    const { handler, runner, forge } = handlerFor({ getPullRequest: vi.fn(async () => detail) });

    const result = await handler('review.start', { kind: 'pr', prId: 'PR-1', provider: 'claude', model: 'sonnet' });

    expect(result).toMatchObject({ cached: false });
    expect(revParseSpy).not.toHaveBeenCalled();
    expect(forge.getDiff).toHaveBeenCalledWith('PR-1');
    expect(runner.start).toHaveBeenCalledOnce();
    const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
    expect(input.payloadText).toContain('forge content');
    expect(input.baseSha).toBe(absentBase);
    expect(input.headSha).toBe(absentHead);
  });

  it('uses the real local diff and performs zero forge diff fetches when both shas are genuinely present', async () => {
    const baseSha = await repo.execGit(['rev-parse', 'HEAD']).then(s => s.trim());
    const headSha = await repo.commitFile('Add feature', 'feature.txt', 'hello from the feature branch\n');

    const detail = fakePullRequest({
      id: 'PR-2', number: 8, title: 'Add feature',
      sourceCommit: headSha, targetCommit: baseSha,
      sourceBranch: 'feature/x', targetBranch: 'main',
    });

    const { handler, runner, forge } = handlerFor({ getPullRequest: vi.fn(async () => detail) });

    const result = await handler('review.start', { kind: 'pr', prId: 'PR-2', provider: 'claude', model: 'sonnet' });

    expect(result).toMatchObject({ cached: false });
    expect(forge.getDiff).not.toHaveBeenCalled();
    expect(runner.start).toHaveBeenCalledOnce();
    const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
    expect(input.payloadText).toContain('feature.txt');
    expect(input.payloadText).toContain('hello from the feature branch');
  });
});

/**
 * review.setTarget's 'pr' branch used to fall through to resolveReviewTarget
 * — the git-based resolver — which revParses target.headRef. targetFromParams
 * leaves headRef/baseRef as '' for kind 'pr', so that path either throws on
 * the empty ref or, worse, silently "resolves" it. Same trap as review.start:
 * a well-formed-but-absent sha is the only way to prove locality is decided
 * by a real existence check rather than a mocked revParse that would echo
 * anything back.
 */
describe('review.setTarget against a real repository (pull request locality)', () => {
  let repo: TempGitRepo;
  let git: GitService;
  let storageRoot: string;
  let store: ReviewStore;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    await repo.commitFile('Initial commit', 'README.md', '# Test\n');
    git = new GitService(repo.path);
    storageRoot = await mkdtemp(join(tmpdir(), 'review-pr-target-'));
    store = new ReviewStore(storageRoot);
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('stores a pull request target for an unfetched branch without ever consulting revParse', async () => {
    const absentBase = 'e'.repeat(40);
    const absentHead = 'f'.repeat(40);
    const detail = fakePullRequest({
      id: 'PR-1', number: 7, title: 'Add feature',
      sourceCommit: absentHead, targetCommit: absentBase,
      sourceBranch: 'feature/x', targetBranch: 'main',
    });

    const revParseSpy = vi.spyOn(git, 'revParse');
    const targets = new ReviewTargetState();
    const focusReviewView = vi.fn(async () => {});
    const broadcast = vi.fn();
    const forge = {
      getPullRequest: vi.fn(async () => detail),
      getDiff: vi.fn(async () => ''),
      getFiles: vi.fn(async () => []),
      getComments: vi.fn(async () => []),
      getProviderId: vi.fn(async () => 'bitbucket-cloud'),
    };
    const handler = createReviewHandler({
      store: store as never,
      runner: { start: vi.fn(), cancel: vi.fn(), isRunning: vi.fn() } as never,
      getGitService: () => git as never,
      getRepoId: () => 'repo-x',
      getRepos: () => [],
      getMaxDiffChars: () => 0,
      openBody: vi.fn(async () => {}),
      targets,
      focusReviewView,
      broadcast,
      forge: forge as never,
    });

    const result = await handler('review.setTarget', { kind: 'pr', prId: 'PR-1' });

    expect(result).toEqual({ success: true });
    expect(revParseSpy).not.toHaveBeenCalled();
    expect(targets.get('repo-x')).toMatchObject({ kind: 'pr', prId: 'PR-1', headRef: 'feature/x', baseRef: 'main' });
    expect(focusReviewView).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith('review.target', expect.objectContaining({ kind: 'pr', prId: 'PR-1' }));
  });
});

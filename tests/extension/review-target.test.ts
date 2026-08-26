import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_TREE_SHA, REVIEW_TARGET_KINDS, ReviewTargetState, resolvePullRequestTarget, resolveReviewTarget,
} from '../../src/extension/services/review-target';
import { fakePullRequest } from '../helpers/fake-forge-provider';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_P = 'c'.repeat(40);

function fakeGit(over: Record<string, unknown> = {}) {
  return {
    revParse: vi.fn(async (ref: string) => (ref === 'main' ? SHA_A : SHA_B)),
    getParents: vi.fn(async () => [SHA_P]),
    log: vi.fn(async () => [{ subject: 'fix: the thing' }]),
    ...over,
  };
}

describe('resolveReviewTarget', () => {
  it('resolves both refs for a branch target', async () => {
    const git = fakeGit();
    const resolved = await resolveReviewTarget(git, { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    expect(resolved).toMatchObject({ kind: 'branch', baseRef: 'main', baseSha: SHA_A, headRef: 'feat/x', headSha: SHA_B });
  });

  it('computes base from the first parent for a commit target and picks up the subject', async () => {
    const git = fakeGit();
    const resolved = await resolveReviewTarget(git, { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(resolved.baseSha).toBe(SHA_P);
    expect(resolved.baseRef).toBe(SHA_P);
    expect(resolved.subject).toBe('fix: the thing');
  });

  it('uses the empty tree as base for a root commit', async () => {
    const git = fakeGit({ getParents: vi.fn(async () => []) });
    const resolved = await resolveReviewTarget(git, { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(resolved.baseSha).toBe(EMPTY_TREE_SHA);
  });

  it('marks a merge commit in the subject', async () => {
    const git = fakeGit({ getParents: vi.fn(async () => [SHA_P, SHA_A]) });
    const resolved = await resolveReviewTarget(git, { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(resolved.baseSha).toBe(SHA_P); // first parent
    expect(resolved.subject).toBe('fix: the thing (merge)');
  });

  it('names the failing ref when rev-parse rejects', async () => {
    const git = fakeGit({ revParse: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(resolveReviewTarget(git, { kind: 'branch', baseRef: 'gone', headRef: 'feat/x' }))
      .rejects.toThrow(/"feat\/x"|"gone"/);
  });
});

describe('REVIEW_TARGET_KINDS', () => {
  it('includes every kind the params parser and review.saveTarget must also accept', () => {
    expect(REVIEW_TARGET_KINDS.has('branch')).toBe(true);
    expect(REVIEW_TARGET_KINDS.has('commit')).toBe(true);
    expect(REVIEW_TARGET_KINDS.has('range')).toBe(true);
    expect(REVIEW_TARGET_KINDS.has('pr')).toBe(true);
    expect(REVIEW_TARGET_KINDS.has('issue')).toBe(false);
  });
});

describe('resolvePullRequestTarget', () => {
  function fakePrGit(over: Record<string, unknown> = {}) {
    return { commitExists: vi.fn(async () => true), ...over };
  }

  it('resolves the sha pair from PullRequestDetail without ever calling revParse', async () => {
    const detail = fakePullRequest({
      id: 'PR-1', number: 42, title: 'fix(auth): refresh token race',
      sourceBranch: 'feature/x', targetBranch: 'develop',
      sourceCommit: SHA_A, targetCommit: SHA_B,
    });
    const forge = { getPullRequest: vi.fn(async () => detail) };
    const git = fakePrGit();

    const resolved = await resolvePullRequestTarget(git, forge, 'PR-1');

    expect(resolved).toMatchObject({
      kind: 'pr',
      baseRef: 'develop', baseSha: SHA_B,
      headRef: 'feature/x', headSha: SHA_A,
      subject: 'fix(auth): refresh token race',
      prId: 'PR-1', prNumber: 42,
    });
    expect(forge.getPullRequest).toHaveBeenCalledWith('PR-1');
    expect('revParse' in git).toBe(false);
  });

  it('reports both shas present when the existence check finds them both', async () => {
    const forge = { getPullRequest: vi.fn(async () => fakePullRequest()) };
    const git = fakePrGit({ commitExists: vi.fn(async () => true) });

    const resolved = await resolvePullRequestTarget(git, forge, '123');
    expect(resolved.localBothPresent).toBe(true);
  });

  it('reports not-present when only one sha exists locally', async () => {
    const forge = { getPullRequest: vi.fn(async () => fakePullRequest()) };
    const calls: string[] = [];
    const git = fakePrGit({
      commitExists: vi.fn(async (sha: string) => { calls.push(sha); return sha === fakePullRequest().targetCommit; }),
    });

    const resolved = await resolvePullRequestTarget(git, forge, '123');
    expect(resolved.localBothPresent).toBe(false);
    // Both sides are checked with a real existence call, not skipped once one fails.
    expect(calls).toContain(fakePullRequest().targetCommit);
    expect(calls).toContain(fakePullRequest().sourceCommit);
  });
});

describe('ReviewTargetState', () => {
  it('keeps targets separate per repo', () => {
    const state = new ReviewTargetState();
    state.set('repo-a', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    state.set('repo-b', { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(state.get('repo-a')?.headRef).toBe('feat/x');
    expect(state.get('repo-b')?.kind).toBe('commit');
    expect(state.get('repo-c')).toBeNull();
  });

  it('keeps a pull request target intact, including its provider-local id', () => {
    const state = new ReviewTargetState();
    state.set('repo-a', { kind: 'pr', baseRef: '', headRef: '', prId: 'PR-9' });
    expect(state.get('repo-a')).toMatchObject({ kind: 'pr', prId: 'PR-9' });
  });
});

describe('ReviewTargetState with storage', () => {
  function fakeStorage(initial: Record<string, unknown> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      get: vi.fn((key: string) => data.get(key)),
      update: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
      data,
    };
  }

  it('writes each target to storage under a per-repo key', () => {
    const storage = fakeStorage();
    const state = new ReviewTargetState(storage);

    state.set('repo-a', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });

    expect(storage.update).toHaveBeenCalledWith('review.target.repo-a',
      { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
  });

  it('falls back to storage on a memory miss and hydrates memory', () => {
    const storage = fakeStorage({
      'review.target.repo-a': { kind: 'branch', baseRef: 'main', headRef: 'feat/x' },
    });
    const state = new ReviewTargetState(storage);

    expect(state.get('repo-a')).toEqual({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    storage.get.mockClear();
    expect(state.get('repo-a')?.headRef).toBe('feat/x');
    expect(storage.get).not.toHaveBeenCalled(); // hydrated — second read is memory
  });

  it('still returns null when neither memory nor storage has the repo', () => {
    const state = new ReviewTargetState(fakeStorage());
    expect(state.get('repo-x')).toBeNull();
  });

  it('ignores a malformed stored value instead of returning garbage', () => {
    const storage = fakeStorage({ 'review.target.repo-a': { nonsense: true } });
    const state = new ReviewTargetState(storage);
    expect(state.get('repo-a')).toBeNull();
  });

  it('works without storage exactly as before', () => {
    const state = new ReviewTargetState();
    state.set('repo-a', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    expect(state.get('repo-a')?.baseRef).toBe('main');
  });
});

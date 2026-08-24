import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_TREE_SHA, ReviewTargetState, resolveReviewTarget,
} from '../../src/extension/services/review-target';

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

describe('ReviewTargetState', () => {
  it('keeps targets separate per repo', () => {
    const state = new ReviewTargetState();
    state.set('repo-a', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    state.set('repo-b', { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(state.get('repo-a')?.headRef).toBe('feat/x');
    expect(state.get('repo-b')?.kind).toBe('commit');
    expect(state.get('repo-c')).toBeNull();
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

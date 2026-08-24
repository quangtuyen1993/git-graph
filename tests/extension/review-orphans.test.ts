import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, type ReviewEntry } from '../../src/extension/services/review-store';

let root: string;
let store: ReviewStore;

function entry(id: string, status: ReviewEntry['status']): ReviewEntry {
  return {
    id,
    sourceBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetBranch: 'feat/x',
    targetSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status,
    startedAt: '2026-08-24T00:00:00.000Z',
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-orphans-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ReviewStore.reconcileOrphans', () => {
  it('rewrites a stranded running entry as interrupted', async () => {
    await store.create('repo-a', entry('stranded', 'running'));

    expect(await store.reconcileOrphans()).toEqual(['stranded']);
    expect((await store.get('repo-a', 'stranded'))?.status).toBe('interrupted');
  });

  it('leaves finished entries alone', async () => {
    await store.create('repo-a', entry('finished', 'done'));
    await store.create('repo-a', entry('broken', 'failed'));

    expect(await store.reconcileOrphans()).toEqual([]);
    expect((await store.get('repo-a', 'finished'))?.status).toBe('done');
    expect((await store.get('repo-a', 'broken'))?.status).toBe('failed');
  });

  it('sweeps every repo, not just the first', async () => {
    await store.create('repo-a', entry('a', 'running'));
    await store.create('repo-b', entry('b', 'running'));

    expect((await store.reconcileOrphans()).sort()).toEqual(['a', 'b']);
  });

  it('stamps finishedAt so the row can show a relative time', async () => {
    await store.create('repo-a', entry('stranded', 'running'));
    await store.reconcileOrphans();

    expect((await store.get('repo-a', 'stranded'))?.finishedAt).toBeTruthy();
  });

  it('is a no-op when nothing has ever been stored', async () => {
    expect(await store.reconcileOrphans()).toEqual([]);
  });

  it('never throws when the root directory does not exist', async () => {
    // Create a ReviewStore pointing to a path that was never created
    const nonexistentRoot = join(tmpdir(), 'nonexistent-root-' + Math.random().toString(36));
    const orphanStore = new ReviewStore(nonexistentRoot);

    // reconcileOrphans must never throw at activation, even with missing root
    expect(await orphanStore.reconcileOrphans()).toEqual([]);
  });
});

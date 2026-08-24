import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, type ReviewEntry } from '../../src/extension/services/review-store';

const REPO = 'abc123abc123';
let root: string;
let store: ReviewStore;

function entry(id: string, over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    id,
    sourceBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetBranch: 'feat/x',
    targetSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status: 'running',
    startedAt: '2026-08-24T00:00:00.000Z',
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-store-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ReviewStore', () => {
  it('round-trips an entry through the index', async () => {
    await store.create(REPO, entry('one'));

    expect(await store.get(REPO, 'one')).toMatchObject({ id: 'one', status: 'running' });
    expect(await store.list(REPO)).toHaveLength(1);
  });

  it('returns an empty list for a repo it has never seen', async () => {
    expect(await store.list('never-seen')).toEqual([]);
  });

  it('lists newest first', async () => {
    await store.create(REPO, entry('old', { startedAt: '2026-08-24T00:00:00.000Z' }));
    await store.create(REPO, entry('new', { startedAt: '2026-08-24T01:00:00.000Z' }));

    expect((await store.list(REPO)).map(e => e.id)).toEqual(['new', 'old']);
  });

  it('appends streamed chunks to the body file', async () => {
    await store.create(REPO, entry('one'));
    await store.appendBody(REPO, 'one', 'first ');
    await store.appendBody(REPO, 'one', 'second');

    expect(await store.readBody(REPO, 'one')).toBe('first second');
  });

  it('patches status and finishedAt without losing other fields', async () => {
    await store.create(REPO, entry('one'));
    await store.finish(REPO, 'one', { status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' });

    const saved = await store.get(REPO, 'one');
    expect(saved).toMatchObject({ status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' });
    expect(saved?.sourceBranch).toBe('main');
  });

  it('removes the entry and its body', async () => {
    await store.create(REPO, entry('one'));
    await store.appendBody(REPO, 'one', 'body');
    await store.remove(REPO, 'one');

    expect(await store.get(REPO, 'one')).toBeUndefined();
    await expect(readFile(store.bodyPath(REPO, 'one'), 'utf8')).rejects.toThrow();
  });

  it('evicts the oldest once past the cap', async () => {
    for (let i = 0; i < 52; i++) {
      await store.create(REPO, entry(`id-${i}`, {
        status: 'done',
        startedAt: new Date(Date.UTC(2026, 7, 24, 0, i)).toISOString(),
      }));
    }

    const ids = (await store.list(REPO)).map(e => e.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain('id-0');
    expect(ids).not.toContain('id-1');
    expect(ids).toContain('id-51');
  });

  it('never evicts a running entry', async () => {
    await store.create(REPO, entry('pinned', {
      status: 'running',
      startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    }));
    for (let i = 0; i < 55; i++) {
      await store.create(REPO, entry(`id-${i}`, {
        status: 'done',
        startedAt: new Date(Date.UTC(2026, 7, 24, 0, i)).toISOString(),
      }));
    }

    expect((await store.list(REPO)).map(e => e.id)).toContain('pinned');
  });

  it('rebuilds a corrupt index by scanning body files instead of throwing', async () => {
    await store.create(REPO, entry('one'));
    await store.appendBody(REPO, 'one', 'body');
    await writeFile(join(root, REPO, 'index.json'), '{ not json', 'utf8');

    const listed = await store.list(REPO);
    expect(listed.map(e => e.id)).toEqual(['one']);
    expect(listed[0].status).toBe('interrupted');
  });

  it('creates the repo directory on first write', async () => {
    await mkdir(root, { recursive: true });
    await store.create('brand-new-repo', entry('one'));

    expect(await store.get('brand-new-repo', 'one')).toBeDefined();
  });
});

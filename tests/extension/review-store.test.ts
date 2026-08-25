import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewStore, type ReviewEntry } from '../../src/extension/services/review-store';

const REPO = 'abc123abc123';
let root: string;
let store: ReviewStore;

function entry(id: string, over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    id,
    kind: 'branch',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feat/x',
    headSha: 'b'.repeat(40),
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
    expect(saved?.baseRef).toBe('main');
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

  it('does not clobber concurrent mutations on the same repo', async () => {
    // Start two creates concurrently (do not await the first before starting the second)
    await Promise.all([
      store.create(REPO, entry('first', { startedAt: '2026-08-24T00:00:00.000Z' })),
      store.create(REPO, entry('second', { startedAt: '2026-08-24T00:01:00.000Z' })),
    ]);

    // Both entries should survive
    const list = await store.list(REPO);
    expect(list.map(e => e.id)).toEqual(['second', 'first']);
    expect(list).toHaveLength(2);
  });

  it('does not clobber create racing with finish', async () => {
    await store.create(REPO, entry('first'));

    // Race a finish of the first entry with a create of a second entry
    await Promise.all([
      store.finish(REPO, 'first', { status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' }),
      store.create(REPO, entry('second')),
    ]);

    const first = await store.get(REPO, 'first');
    const second = await store.get(REPO, 'second');

    expect(first).toMatchObject({ status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' });
    expect(second).toBeDefined();
    expect(await store.list(REPO)).toHaveLength(2);
  });

  it('does not deadlock when a critical section rejects', async () => {
    // Create an initial entry
    await store.create(REPO, entry('one'));

    // Store the original writeIndex implementation
    const internals = store as never as {
      writeIndex: (repoId: string, entries: ReviewEntry[]) => Promise<void>;
    };
    const originalWriteIndex = internals.writeIndex;

    // Spy on writeIndex to track calls and selectively reject
    const writeIndexSpy = vi.spyOn(internals, 'writeIndex');
    let callCount = 0;
    writeIndexSpy.mockImplementation(async (repoId, entries) => {
      callCount++;
      if (callCount === 1) {
        // Still write the file, then reject to simulate a write that fails mid-operation
        await originalWriteIndex.call(store, repoId, entries);
        throw new Error('Simulated write failure on first call');
      }
      // On subsequent calls, use the original implementation
      return originalWriteIndex.call(store, repoId, entries);
    });

    // First finish: writeIndex will reject even though it still tries to write
    try {
      await store.finish(REPO, 'one', { status: 'done' });
      throw new Error('Expected first finish to reject');
    } catch (err) {
      if ((err as any).message === 'Expected first finish to reject') throw err;
      // Expected - writeIndex rejected
    }

    // Second finish: this tests that the critical section still runs despite the prior rejection.
    // Without the error handler in current.then(() => fn(), () => fn()), the second finish's
    // fn() would never execute because current would be a rejected promise with no recovery path.
    await store.finish(REPO, 'one', { status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' });

    // Verify the second finish actually ran by checking the entry was updated
    const finished = await store.get(REPO, 'one');
    expect(finished?.status).toBe('done');
    expect(finished?.finishedAt).toBe('2026-08-24T00:05:00.000Z');

    // Verify both critical sections actually tried to write (first rejected, second succeeded)
    expect(callCount).toBe(2);

    writeIndexSpy.mockRestore();
  });
  it('keeps unawaited appends in call order', async () => {
    // Regression: appendBody used to mkdir+appendFile per call with no chaining,
    // so two chunks issued in the same tick became two concurrent
    // open/write/close cycles whose completion order the libuv threadpool
    // decided. Measured: 101 of 300 runs produced "worldhello ".
    await store.create(REPO, entry('one'));
    const chunks = Array.from({ length: 24 }, (_, i) => `chunk-${i};`);

    // Deliberately not awaited between calls.
    await Promise.all(chunks.map(chunk => store.appendBody(REPO, 'one', chunk)));

    expect(await store.readBody(REPO, 'one')).toBe(chunks.join(''));
  });

  it('writeBody replaces the streamed text without interleaving a pending append', async () => {
    await store.create(REPO, entry('one'));

    const append = store.appendBody(REPO, 'one', 'raw stdout');
    const replace = store.writeBody(REPO, 'one', 'processed');
    await Promise.all([append, replace]);

    expect(await store.readBody(REPO, 'one')).toBe('processed');
  });

  it('creates the body file before the index entry', async () => {
    // A crash between the two writes must leave an invisible orphan body, not
    // an indexed row whose `open` throws.
    const writeIndexSpy = vi.spyOn(store as never as { writeIndex: () => Promise<void> }, 'writeIndex')
      .mockRejectedValue(new Error('crash between the two writes'));

    await expect(store.create(REPO, entry('one'))).rejects.toThrow(/crash between/);
    writeIndexSpy.mockRestore();

    await expect(readFile(store.bodyPath(REPO, 'one'), 'utf8')).resolves.toBe('');
    expect(await store.list(REPO)).toEqual([]);
  });

  it('never lets a read observe a write in progress', async () => {
    // readIndex's recovery path *rewrites* the file with `unknown` skeletons, so
    // one torn read would destroy every entry's metadata. Reads must take the
    // same lock as writes: while a write's critical section is open, no read of
    // the index may be in flight.
    await store.create(REPO, entry('seed'));

    let writing = false;
    const observed: string[] = [];
    const internals = store as never as {
      writeIndex: (repoId: string, entries: ReviewEntry[]) => Promise<void>;
      readIndexFile: (repoId: string) => Promise<string | null>;
    };
    const realWrite = internals.writeIndex;
    const realRead = internals.readIndexFile;

    const writeSpy = vi.spyOn(internals, 'writeIndex').mockImplementation(async (repoId, entries) => {
      writing = true;
      // Hold the write open: an unsynchronised reader slots straight in here.
      await new Promise(resolve => setTimeout(resolve, 50));
      await realWrite.call(store, repoId, entries);
      writing = false;
    });
    const readSpy = vi.spyOn(internals, 'readIndexFile').mockImplementation(async (repoId) => {
      if (writing) observed.push('read-during-write');
      return realRead.call(store, repoId);
    });

    const write = store.create(REPO, entry('written', { status: 'done' }));
    // Well inside the 50ms window the write is holding open.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(writing).toBe(true);
    const reads = Promise.all([store.list(REPO), store.get(REPO, 'seed')]);

    await Promise.all([write, reads]);
    writeSpy.mockRestore();
    readSpy.mockRestore();

    expect(observed).toEqual([]);
    const list = await store.list(REPO);
    expect(list.map(e => e.id).sort()).toEqual(['seed', 'written']);
    expect(list.every(e => e.provider === 'claude')).toBe(true);
  });

  it('never exposes a truncated index to a reader outside the lock', async () => {
    // A plain writeFile truncates before it writes; a reader landing in that
    // window sees '' and the destructive rebuild takes over. Write-then-rename
    // means an outside reader only ever sees a complete index.
    for (let i = 0; i < 12; i++) {
      await store.create(REPO, entry(`seed-${i}`, { status: 'done' }));
    }

    const indexFile = join(root, REPO, 'index.json');
    let stop = false;
    const reads: string[] = [];
    const reader = (async () => {
      while (!stop) {
        const raw = await readFile(indexFile, 'utf8').catch(() => null);
        if (raw !== null) reads.push(raw);
      }
    })();

    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      writes.push(store.finish(REPO, 'seed-0', { status: 'done', error: `pass-${i}` }));
    }
    await Promise.all(writes);
    stop = true;
    await reader;

    expect(reads.length).toBeGreaterThan(0);
    const torn = reads.filter(raw => {
      try {
        return !Array.isArray(JSON.parse(raw));
      } catch {
        return true;
      }
    });
    expect(torn).toEqual([]);
  });

  it('retries a transient empty read instead of destroying the index', async () => {
    await store.create(REPO, entry('one'));
    const real = (store as never as { readIndexFile: (repoId: string) => Promise<string | null> }).readIndexFile;
    const rebuild = vi.spyOn(store as never as { rebuildIndex: () => Promise<unknown[]> }, 'rebuildIndex');
    let calls = 0;
    const readSpy = vi
      .spyOn(store as never as { readIndexFile: (repoId: string) => Promise<string | null> }, 'readIndexFile')
      .mockImplementation(async (repoId: string) => (++calls === 1 ? '' : real.call(store, repoId)));

    const listed = await store.list(REPO);

    expect(rebuild).not.toHaveBeenCalled();
    expect(listed.map(e => e.id)).toEqual(['one']);
    expect(listed[0].provider).toBe('claude');
    readSpy.mockRestore();
    rebuild.mockRestore();
  });

  it('leaves no temporary index files behind', async () => {
    await store.create(REPO, entry('one'));
    await store.finish(REPO, 'one', { status: 'done' });

    const { readdir } = await import('fs/promises');
    const files = await readdir(join(root, REPO));
    expect(files.filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to turn a traversing id into a path', () => {
    expect(() => store.bodyPath(REPO, '../../../../tmp/victim')).toThrow(/invalid review id/i);
  });
});

describe('index migration', () => {
  it('maps a legacy sourceBranch entry to baseRef/headRef with kind branch', async () => {
    const legacy = [{
      id: 'aaaaaaa..bbbbbbb.claude.sonnet',
      sourceBranch: 'main', sourceSha: 'a'.repeat(40),
      targetBranch: 'feat/x', targetSha: 'b'.repeat(40),
      provider: 'claude', model: 'sonnet',
      status: 'done', startedAt: '2026-08-01T00:00:00.000Z',
    }];
    await mkdir(join(root, 'repo-a'), { recursive: true });
    await writeFile(join(root, 'repo-a', 'index.json'), JSON.stringify(legacy), 'utf8');

    const entries = await store.list('repo-a');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'aaaaaaa..bbbbbbb.claude.sonnet',
      kind: 'branch',
      baseRef: 'main', baseSha: 'a'.repeat(40),
      headRef: 'feat/x', headSha: 'b'.repeat(40),
    });
    // migration ghi lại file một lần: đọc thẳng từ đĩa phải thấy format mới
    const rewritten = JSON.parse(await readFile(join(root, 'repo-a', 'index.json'), 'utf8'));
    expect(rewritten[0].baseRef).toBe('main');
    expect(rewritten[0].sourceBranch).toBeUndefined();
  });

  it('drops an entry that is neither format instead of throwing', async () => {
    await mkdir(join(root, 'repo-a'), { recursive: true });
    await writeFile(join(root, 'repo-a', 'index.json'),
      JSON.stringify([{ garbage: true }, null]), 'utf8');

    await expect(store.list('repo-a')).resolves.toEqual([]);
  });

  it('round-trips a commit-kind entry', async () => {
    await store.create('repo-a', {
      id: 'aaaaaaa..bbbbbbb.claude.default',
      kind: 'commit',
      baseRef: 'a'.repeat(40), baseSha: 'a'.repeat(40),
      headRef: 'b'.repeat(40), headSha: 'b'.repeat(40),
      subject: 'fix: something (merge)',
      provider: 'claude', model: 'default',
      status: 'running', startedAt: new Date().toISOString(),
    });
    const entries = await store.list('repo-a');
    expect(entries[0].kind).toBe('commit');
    expect(entries[0].subject).toBe('fix: something (merge)');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { loadAllCommits } from '../../src/extension/services/graph-loader';
import { GitService } from '../../src/extension/services/git.service';
import type { Commit, GitLogOptions } from '../../src/extension/types/git.types';
import { TempGitRepo } from '../helpers/temp-git-repo';

function commit(index: number): Commit {
  const hash = index.toString(16).padStart(40, '0');
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    parents: [],
    author: 'Ada',
    authorEmail: 'ada@example.test',
    authorDate: '2026-08-23T00:00:00.000Z',
    committer: 'Ada',
    committerEmail: 'ada@example.test',
    committerDate: '2026-08-23T00:00:00.000Z',
    message: `Commit ${index}`,
    subject: `Commit ${index}`,
    refs: [],
  };
}

describe('loadAllCommits', () => {
  it('loads fixed-size batches in order and preserves filters on every request', async () => {
    const commits = Array.from({ length: 1037 }, (_, index) => commit(index));
    const log = vi.fn<(options: GitLogOptions) => Promise<Commit[]>>()
      .mockResolvedValueOnce(commits.slice(0, 500))
      .mockResolvedValueOnce(commits.slice(500, 1000))
      .mockResolvedValueOnce(commits.slice(1000));

    const result = await loadAllCommits(
      { log, snapshotLogOptions: async (options) => options },
      { author: 'Ada', branch: 'main', all: false },
    );

    expect(log.mock.calls).toEqual([
      [{ author: 'Ada', branch: 'main', all: false, maxCount: 500, skip: 0 }],
      [{ author: 'Ada', branch: 'main', all: false, maxCount: 500, skip: 500 }],
      [{ author: 'Ada', branch: 'main', all: false, maxCount: 500, skip: 1000 }],
    ]);
    expect(result).toEqual(commits);
  });

  it('stops after one request when the first batch is empty', async () => {
    const log = vi.fn<(options: GitLogOptions) => Promise<Commit[]>>()
      .mockResolvedValue([]);

    await expect(loadAllCommits(
      { log, snapshotLogOptions: async (options) => options },
      { branch: 'main' },
    )).resolves.toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ branch: 'main', maxCount: 500, skip: 0 });
  });
});

describe('loadAllCommits integration', () => {
  it('loads an unborn all-refs repository as an empty graph', async () => {
    const repo = await TempGitRepo.create();

    try {
      const service = new GitService(repo.path);
      await expect(loadAllCommits(service, { all: true })).resolves.toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps an explicitly empty revision snapshot empty if HEAD appears later', async () => {
    const repo = await TempGitRepo.create();

    try {
      const service = new GitService(repo.path);
      const realSnapshot = service.snapshotLogOptions.bind(service);
      vi.spyOn(service, 'snapshotLogOptions').mockImplementationOnce(async (options) => {
        const snapshot = await realSnapshot(options);
        expect(snapshot.revisions).toEqual([]);
        await repo.commitSeries(['Appeared after snapshot']);
        return snapshot;
      });

      await expect(loadAllCommits(service, { all: true })).resolves.toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('snapshots an explicit branch without including a divergent branch', async () => {
    const repo = await TempGitRepo.create();

    try {
      const [baseHash] = await repo.commitSeries(['Base']);
      await repo.execGit(['branch', 'feature']);
      await repo.commitSeries(['Main only']);
      await repo.execGit(['checkout', 'feature']);
      const [featureHash] = await repo.commitSeries(['Feature only']);
      await repo.execGit(['checkout', 'main']);
      const service = new GitService(repo.path);
      const logSpy = vi.spyOn(service, 'log');

      const commits = await loadAllCommits(service, { branch: 'feature' });

      expect(commits.map(({ hash }) => hash)).toEqual([featureHash, baseHash]);
      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
        branch: undefined,
        all: false,
        revisions: [featureHash],
      }));
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps an all-refs multi-branch snapshot stable while both refs change between batches', async () => {
    const repo = await TempGitRepo.create();

    try {
      const [baseHash] = await repo.commitSeries(['Base']);
      await repo.execGit(['branch', 'side']);
      const mainHashes = await repo.commitSeries(['Main 1', 'Main 2']);
      await repo.execGit(['checkout', 'side']);
      const sideHashes = await repo.commitSeries(['Side 1', 'Side 2']);
      await repo.execGit(['checkout', 'main']);
      const originalHashes = [baseHash, ...mainHashes, ...sideHashes];
      const service = new GitService(repo.path);
      const realLog = service.log.bind(service);
      const revisionSnapshots: (string[] | undefined)[] = [];
      let batchCount = 0;
      vi.spyOn(service, 'log').mockImplementation(async (options = {}) => {
        revisionSnapshots.push(options.revisions);
        const batch = await realLog(options);
        batchCount += 1;
        if (batchCount === 1) {
          await repo.commitSeries(['New main after snapshot']);
          await repo.execGit(['checkout', 'side']);
          await repo.commitSeries(['New side after snapshot']);
          await repo.execGit(['checkout', 'main']);
        }
        return batch;
      });

      const commits = await loadAllCommits(service, { all: true }, 2);

      expect(commits).toHaveLength(originalHashes.length);
      expect(new Set(commits.map(({ hash }) => hash))).toEqual(new Set(originalHashes));
      expect(batchCount).toBe(3);
      expect(revisionSnapshots[0]).toHaveLength(2);
      expect(revisionSnapshots).toEqual([
        revisionSnapshots[0],
        revisionSnapshots[0],
        revisionSnapshots[0],
      ]);
    } finally {
      await repo.cleanup();
    }
  }, 60_000);

  it('loads all 501 commits from a real repository in two git log batches', async () => {
    const repo = await TempGitRepo.create();

    try {
      const hashes = await repo.commitSeries(
        Array.from({ length: 501 }, (_, index) => `Commit ${index + 1}`),
      );
      const service = new GitService(repo.path);
      const logSpy = vi.spyOn(service, 'log');

      const commits = await loadAllCommits(service, {});

      expect(commits.map(({ hash }) => hash)).toEqual(hashes.reverse());
      expect(logSpy.mock.calls).toEqual([
        [expect.objectContaining({ maxCount: 500, skip: 0 })],
        [expect.objectContaining({ maxCount: 500, skip: 500 })],
      ]);
      const firstSnapshot = logSpy.mock.calls[0][0]?.revisions;
      expect(firstSnapshot).toHaveLength(1);
      expect(logSpy.mock.calls[1][0]?.revisions).toEqual(firstSnapshot);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('uses one revision snapshot when refs change between batches', async () => {
    const repo = await TempGitRepo.create();

    try {
      const originalHashes = await repo.commitSeries(
        Array.from({ length: 501 }, (_, index) => `Original ${index + 1}`),
      );
      const service = new GitService(repo.path);
      const realLog = service.log.bind(service);
      let batchCount = 0;
      vi.spyOn(service, 'log').mockImplementation(async (options) => {
        const batch = await realLog(options);
        batchCount += 1;
        if (batchCount === 1) {
          await repo.commitSeries(['Added while loading']);
        }
        return batch;
      });

      const commits = await loadAllCommits(service, {});

      expect(commits.map(({ hash }) => hash)).toEqual([...originalHashes].reverse());
      expect(batchCount).toBe(2);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);
});

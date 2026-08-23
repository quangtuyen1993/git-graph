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
      { log },
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

    await expect(loadAllCommits({ log }, { branch: 'main' })).resolves.toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ branch: 'main', maxCount: 500, skip: 0 });
  });
});

describe('loadAllCommits integration', () => {
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
        [{ maxCount: 500, skip: 0 }],
        [{ maxCount: 500, skip: 500 }],
      ]);
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});

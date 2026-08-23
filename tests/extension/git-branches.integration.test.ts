import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.branches', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns commit hashes that match the full hashes used by the graph', async () => {
    const expectedHash = await repo.commitFile('Initial commit', 'README.md', '# Test\n');
    const service = new GitService(repo.path);

    const [branches, commits] = await Promise.all([
      service.branches(),
      service.log({ all: true }),
    ]);

    expect(branches.find(branch => branch.name === 'main')?.hash).toBe(expectedHash);
    expect(commits[0]?.hash).toBe(expectedHash);
  });
});

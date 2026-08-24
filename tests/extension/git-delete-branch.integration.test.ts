import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BranchNotFullyMergedError, GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.deleteBranch', () => {
  let repo: TempGitRepo;
  let service: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    await repo.commitFile('Initial commit', 'README.md', '# Test\n');
    service = new GitService(repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /** A branch holding a commit that exists on no other branch. */
  async function unmergedBranch(name: string): Promise<void> {
    await repo.execGit(['checkout', '-b', name]);
    await repo.commitFile(`only on ${name}`, `${name}.txt`, 'unmerged\n');
    await repo.execGit(['checkout', '-']);
  }

  it('deletes a merged branch without force', async () => {
    await repo.execGit(['branch', 'merged-branch']);

    await service.deleteBranch('merged-branch');

    expect(await service.branches()).not.toContainEqual(
      expect.objectContaining({ name: 'merged-branch' }),
    );
  });

  it('refuses an unmerged branch with a typed error rather than raw git stderr', async () => {
    await unmergedBranch('unmerged-branch');

    await expect(service.deleteBranch('unmerged-branch'))
      .rejects.toBeInstanceOf(BranchNotFullyMergedError);
  });

  it('names the branch on the typed error so the UI can explain the risk', async () => {
    await unmergedBranch('unmerged-branch');

    await expect(service.deleteBranch('unmerged-branch'))
      .rejects.toThrow(/unmerged-branch/);
  });

  it('deletes an unmerged branch when force is given', async () => {
    await unmergedBranch('unmerged-branch');

    await service.deleteBranch('unmerged-branch', true);

    expect(await service.branches()).not.toContainEqual(
      expect.objectContaining({ name: 'unmerged-branch' }),
    );
  });

  it('reports an unrelated failure as itself, not as an unmerged branch', async () => {
    await expect(service.deleteBranch('no-such-branch'))
      .rejects.not.toBeInstanceOf(BranchNotFullyMergedError);
  });
}, 60_000);

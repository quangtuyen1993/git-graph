import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.revert', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('creates a revert commit whose tree matches the reverted commit parent', async () => {
    await repo.commitFile('Base', 'message.txt', 'before\n');
    const target = await repo.commitFile('Change message', 'message.txt', 'after\n');
    const parentTree = await repo.treeOf(`${target}^`);

    await new GitService(repo.path).revert(target);

    expect(await repo.commitCount()).toBe(3);
    expect((await repo.subjects())[0]).toMatch(/^Revert/);
    expect(await repo.treeOf('HEAD')).toBe(parentTree);
  });
});

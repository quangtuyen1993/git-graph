import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService history rewrites', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reword preserves commits after the rewritten commit', async () => {
    const [, b, c] = await repo.commitSeries(['A', 'B', 'C']);

    await new GitService(repo.path).reword(b, 'B changed');

    expect(await repo.subjects()).toEqual(['C', 'B changed', 'A']);
    expect(await repo.commitCount()).toBe(3);
    expect(await repo.treeOf('HEAD')).toBe(await repo.treeOf(c));
  });

  it('squash preserves descendants after the selected range', async () => {
    const [, b, c, d] = await repo.commitSeries(['A', 'B', 'C', 'D']);
    const service = new GitService(repo.path);

    expect(await service.canSquash([c, b])).toEqual({ ok: true });
    await service.squash([c, b], 'BC squashed');

    expect(await repo.subjects()).toEqual(['D', 'BC squashed', 'A']);
    expect(await repo.commitCount()).toBe(3);
    expect(await repo.treeOf('HEAD')).toBe(await repo.treeOf(d));
  });

  it('rewords the root commit without dropping descendants', async () => {
    const [a] = await repo.commitSeries(['A', 'B']);

    await new GitService(repo.path).reword(a, 'A changed');

    expect(await repo.subjects()).toEqual(['B', 'A changed']);
    expect(await repo.commitCount()).toBe(2);
  });

  it('squashes a range beginning at the root commit', async () => {
    const [a, b] = await repo.commitSeries(['A', 'B', 'C']);
    const service = new GitService(repo.path);

    expect(await service.canSquash([b, a])).toEqual({ ok: true });
    await service.squash([b, a], 'AB squashed');

    expect(await repo.subjects()).toEqual(['C', 'AB squashed']);
    expect(await repo.commitCount()).toBe(2);
  });

  it('detects whether a commit is published to the upstream branch', async () => {
    const [pushedHash] = await repo.commitSeries(['Pushed']);
    const service = new GitService(repo.path);

    expect(await service.isPublished(pushedHash)).toBe(false);
    await repo.publishCurrentBranch();
    const [localOnlyHash] = await repo.commitSeries(['Local only']);

    expect(await service.isPublished(pushedHash)).toBe(true);
    expect(await service.isPublished(localOnlyHash)).toBe(false);
  });
});

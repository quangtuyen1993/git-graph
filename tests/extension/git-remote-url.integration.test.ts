import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.getRemoteUrl', () => {
  let repo: TempGitRepo;
  let git: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    git = new GitService(repo.path);
  });
  afterEach(async () => { await repo.cleanup(); });

  it('returns undefined when the repository has no remote', async () => {
    expect(await git.getRemoteUrl()).toBeUndefined();
  });

  it('returns origin by default', async () => {
    await repo.execGit(['remote', 'add', 'origin', 'git@bitbucket.org:acme/mpos.git']);
    expect(await git.getRemoteUrl()).toBe('git@bitbucket.org:acme/mpos.git');
  });

  it('returns a named remote', async () => {
    await repo.execGit(['remote', 'add', 'origin', 'git@bitbucket.org:acme/mpos.git']);
    await repo.execGit(['remote', 'add', 'upstream', 'git@bitbucket.org:upstream/mpos.git']);
    expect(await git.getRemoteUrl('upstream')).toBe('git@bitbucket.org:upstream/mpos.git');
  });

  it('returns undefined for a remote that does not exist', async () => {
    expect(await git.getRemoteUrl('nope')).toBeUndefined();
  });

  it('returns the fetch URL, not the last push mirror, for a multi-URL remote', async () => {
    await repo.execGit(['remote', 'add', 'origin', 'git@bitbucket.org:acme/mpos.git']);
    await repo.execGit(['remote', 'set-url', '--add', 'origin', 'git@bitbucket.org:acme/mirror.git']);
    expect(await git.getRemoteUrl()).toBe('git@bitbucket.org:acme/mpos.git');
  });
});

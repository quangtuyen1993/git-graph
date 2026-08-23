import { describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService submodules', () => {
  it('discovers and validates initialized submodules, then rejects deinitialized ones', async () => {
    const parent = await TempGitRepo.create();
    const child = await TempGitRepo.create();

    try {
      await parent.commitSeries(['parent']);
      await child.commitSeries(['child']);
      await parent.execGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', child.path, 'modules/child']);
      const service = new GitService(parent.path);
      const [entry] = await service.submoduleList();

      expect(entry).toMatchObject({ name: 'modules/child', path: 'modules/child', state: 'initialized' });
      await expect(service.resolveSubmodule('modules/child')).resolves.toMatchObject({ path: 'modules/child' });
      await expect(service.resolveSubmodule('../outside')).rejects.toThrow('Submodule not found');

      await parent.execGit(['submodule', 'deinit', '-f', 'modules/child']);

      expect((await service.submoduleList())[0]).toMatchObject({ state: 'uninitialized' });
      await expect(service.resolveSubmodule('modules/child')).rejects.toThrow('Submodule is not initialized');
    } finally {
      await Promise.all([parent.cleanup(), child.cleanup()]);
    }
  });
});

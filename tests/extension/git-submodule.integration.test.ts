import { realpath, rename, stat } from 'fs/promises';
import path from 'path';
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

  it('rejects without mutation when an initialized submodule directory is moved after discovery', async () => {
    const parent = await TempGitRepo.create();
    const child = await TempGitRepo.create();

    try {
      await parent.commitSeries(['parent']);
      await child.commitSeries(['child']);
      await parent.execGit(['-c', 'protocol.file.allow=always', 'submodule', 'add', child.path, 'modules/child']);
      await parent.commitSeries(['add submodule']);

      const configuredPath = path.join(parent.path, 'modules/child');
      const movedPath = path.join(parent.path, 'modules/moved-child');
      const headBefore = await parent.execGit(['rev-parse', 'HEAD']);
      const configBefore = await parent.execGit(['show', 'HEAD:.gitmodules']);
      const indexBefore = await parent.execGit(['ls-files', '--stage', '--', 'modules/child']);

      class MovingSubmoduleGitService extends GitService {
        private moved = false;

        public override async submoduleList() {
          const entries = await super.submoduleList();
          if (!this.moved) {
            await rename(configuredPath, movedPath);
            this.moved = true;
          }
          return entries;
        }
      }

      const service = new MovingSubmoduleGitService(parent.path);
      await expect(service.resolveSubmodule('modules/child'))
        .rejects.toThrow('Submodule directory is missing: modules/child');

      await expect(realpath(configuredPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(movedPath).then(entry => entry.isDirectory())).resolves.toBe(true);
      await expect(parent.execGit(['rev-parse', 'HEAD'])).resolves.toBe(headBefore);
      await expect(parent.execGit(['show', 'HEAD:.gitmodules'])).resolves.toBe(configBefore);
      await expect(parent.execGit(['ls-files', '--stage', '--', 'modules/child'])).resolves.toBe(indexBefore);
    } finally {
      await Promise.all([parent.cleanup(), child.cleanup()]);
    }
  });
});

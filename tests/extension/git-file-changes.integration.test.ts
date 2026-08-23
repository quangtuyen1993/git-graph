import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rename, rm, writeFile } from 'fs/promises';
import path from 'path';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService file changes', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns statuses, paths, counts, and binary flags from a real Git commit', async () => {
    await writeFiles(repo.path, {
      'modified.ts': 'before\n',
      'deleted.ts': 'deleted\n',
      'old name.ts': 'rename\n',
      'source.ts': 'copy source\n',
    });
    await repo.execGit(['add', '--all']);
    await repo.execGit(['commit', '-m', 'base files']);

    await rm(path.join(repo.path, 'deleted.ts'));
    await rename(path.join(repo.path, 'old name.ts'), path.join(repo.path, 'new name.ts'));
    await writeFiles(repo.path, {
      'added file with spaces.ts': 'added\n',
      'folder/tab\tfile.ts': 'tab\n',
      'tên-tiếng-Việt.ts': 'unicode\n',
      'modified.ts': 'before\nafter\n',
      'source.ts': 'copy source\nupdated\n',
      'copy.ts': 'copy source\nupdated\n',
    });
    await writeFile(path.join(repo.path, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    await repo.execGit(['add', '--all']);
    await repo.execGit(['commit', '-m', 'all file changes']);
    const hash = (await repo.execGit(['rev-parse', 'HEAD'])).trim();

    const result = await new GitService(repo.path).show(hash);

    expect(result.commit.hash).toBe(hash);
    expect(result.files).toHaveLength(9);
    expect(result.files).toEqual(expect.arrayContaining([
      { path: 'added file with spaces.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'folder/tab\tfile.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'tên-tiếng-Việt.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'modified.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'deleted.ts', oldPath: null, status: 'deleted', additions: 0, deletions: 1, binary: false },
      { path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed', additions: 0, deletions: 0, binary: false },
      { path: 'copy.ts', oldPath: 'source.ts', status: 'copied', additions: 1, deletions: 0, binary: false },
      { path: 'source.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'image.bin', oldPath: null, status: 'added', additions: 0, deletions: 0, binary: true },
    ]));
  });
});

async function writeFiles(repoPath: string, files: Record<string, string>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([filePath, contents]) => {
    const absolutePath = path.join(repoPath, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }));
}

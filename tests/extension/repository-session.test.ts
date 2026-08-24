import { describe, expect, it } from 'vitest';
import { RepositorySession } from '../../src/extension/controllers/repository-session';
import type { GitService } from '../../src/extension/services/git.service';
import type { Commit, GitLogOptions } from '../../src/extension/types/git.types';

function commit(repositoryPath: string): Commit {
  const hash = repositoryPath.length.toString(16).padStart(40, '0');
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    parents: [],
    author: 'Repository test',
    authorEmail: 'repository@example.test',
    authorDate: '2026-08-23T00:00:00Z',
    committer: 'Repository test',
    committerEmail: 'repository@example.test',
    committerDate: '2026-08-23T00:00:00Z',
    message: repositoryPath,
    subject: repositoryPath,
    refs: [],
  };
}

function fakeGitServiceFactory(repositoryPath: string): GitService {
  return {
    getRepoPath: () => repositoryPath,
    snapshotLogOptions: async (options: Omit<GitLogOptions, 'maxCount' | 'skip'>) => ({
      ...options,
      all: false,
      revisions: [repositoryPath],
    }),
    log: async () => [commit(repositoryPath)],
    getShortStats: async () => new Map(),
    branches: async () => [{ name: repositoryPath }],
  } as unknown as GitService;
}

describe('RepositorySession', () => {
  it('switches between configured repositories and rejects unknown paths', async () => {
    const root = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }, { name: 'other', path: '/other' }],
      createGitService: fakeGitServiceFactory,
    });

    expect(await root.handleGit('git.branches', {})).toEqual([{ name: '/root' }]);
    expect(await root.handleRepo('repo.list', {})).toEqual({
      repos: [
        { name: 'root', path: '/root', active: true },
        { name: 'other', path: '/other', active: false },
      ],
    });
    await expect(root.handleRepo('repo.switch', { path: '/unconfigured' }))
      .rejects.toThrow('Repo not found: /unconfigured');

    await root.handleRepo('repo.switch', { path: '/other' });

    expect(root.getCurrentRepository()?.path).toBe('/other');
    expect(await root.handleGit('git.branches', {})).toEqual([{ name: '/other' }]);
  });

  it('publishes graph windows only from the session that built them', async () => {
    const root = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }],
      createGitService: fakeGitServiceFactory,
    });
    const child = new RepositorySession({
      initialRepository: { name: 'sdk', path: '/root/packages/sdk' },
      repositories: [{ name: 'sdk', path: '/root/packages/sdk' }],
      createGitService: fakeGitServiceFactory,
    });

    const rootBuild = await root.handleGraph('graph.build', { all: true }) as { layoutVersion: number };
    const childBuild = await child.handleGraph('graph.build', { all: true }) as { layoutVersion: number };

    const rootWindow = await root.handleGraph('graph.getWindow', {
      startRow: 0,
      count: 20,
      layoutVersion: rootBuild.layoutVersion,
    }) as { nodes: Commit[] };
    const childWindow = await child.handleGraph('graph.getWindow', {
      startRow: 0,
      count: 20,
      layoutVersion: childBuild.layoutVersion,
    }) as { nodes: Commit[] };

    expect(rootWindow.nodes.map((node) => node.subject)).toEqual(['/root']);
    expect(childWindow.nodes.map((node) => node.subject)).toEqual(['/root/packages/sdk']);
  });

  it('adds repositories at runtime and deduplicates them by canonical path', async () => {
    const session = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }],
      createGitService: fakeGitServiceFactory,
      canonicalizePath: async (path) => (path === '/root/alias/sdk' ? '/root/packages/sdk' : path),
    });

    const added = await session.addRepository({ name: 'sdk', path: '/root/alias/sdk' });
    expect(added).toEqual({ name: 'sdk', path: '/root/packages/sdk' });

    const again = await session.addRepository({ name: 'sdk', path: '/root/packages/sdk' });
    expect(again).toBe(added);

    expect(await session.handleRepo('repo.list', {})).toEqual({
      repos: [
        { name: 'root', path: '/root', active: true },
        { name: 'sdk', path: '/root/packages/sdk', active: false },
      ],
    });

    await session.handleRepo('repo.switch', { path: '/root/packages/sdk' });

    expect(session.getCurrentRepository()?.path).toBe('/root/packages/sdk');
    expect(await session.handleGit('git.branches', {})).toEqual([{ name: '/root/packages/sdk' }]);
  });
});

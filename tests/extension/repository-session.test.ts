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
    shortStatsFor: async () => new Map(),
    branches: async () => [{ name: repositoryPath }],
    submoduleList: async () => [],
  } as unknown as GitService;
}

/** A factory whose repos each own one submodule, named after the repo. */
function submoduleAwareFactory(failingRepoPath?: string) {
  return (repositoryPath: string): GitService => ({
    ...fakeGitServiceFactory(repositoryPath),
    submoduleList: async () => {
      if (repositoryPath === failingRepoPath) throw new Error('not a git repository');
      return [{
        name: `${repositoryPath}-sub`,
        path: 'packages/sdk',
        head: 'f'.repeat(40),
        state: 'initialized' as const,
        absolutePath: `${repositoryPath}/packages/sdk`,
      }];
    },
  }) as unknown as GitService;
}

describe('RepositorySession', () => {
  it('switches between configured repositories and rejects unknown paths', async () => {
    const root = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }, { name: 'other', path: '/other' }],
      createGitService: fakeGitServiceFactory,
    });

    expect(await root.handleGit('git.branches', {})).toEqual([{ name: '/root' }]);
    expect(await root.handleRepo('repo.list', {})).toMatchObject({
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

    expect(await session.handleRepo('repo.list', {})).toMatchObject({
      repos: [
        { name: 'root', path: '/root', active: true },
        { name: 'sdk', path: '/root/packages/sdk', active: false },
      ],
    });

    await session.handleRepo('repo.switch', { path: '/root/packages/sdk' });

    expect(session.getCurrentRepository()?.path).toBe('/root/packages/sdk');
    expect(await session.handleGit('git.branches', {})).toEqual([{ name: '/root/packages/sdk' }]);
  });

  it('exposes the active repository path for consumers outside the webview', () => {
    const session = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }],
      createGitService: fakeGitServiceFactory,
    });

    expect(session.getActiveRepositoryPath()).toBe('/root');
  });

  it('reports undefined before any repository is active', () => {
    const session = new RepositorySession({
      initialRepository: null,
      repositories: [],
      createGitService: fakeGitServiceFactory,
    });

    expect(session.getActiveRepositoryPath()).toBeUndefined();
  });
});

describe('RepositorySession workspace submodules', () => {
  const repositories = [{ name: 'root', path: '/root' }, { name: 'other', path: '/other' }];

  it('lists submodules from every repository, not just the active one', async () => {
    const session = new RepositorySession({
      initialRepository: repositories[0],
      repositories,
      createGitService: submoduleAwareFactory(),
    });

    const { submodules } = await session.handleRepo('repo.list', {}) as {
      submodules: { name: string; repoPath: string }[];
    };

    expect(submodules.map(s => s.repoPath).sort()).toEqual(['/other', '/root']);
  });

  it('tags each submodule with the repository that owns it', async () => {
    const session = new RepositorySession({
      initialRepository: repositories[0],
      repositories,
      createGitService: submoduleAwareFactory(),
    });

    const { submodules } = await session.handleRepo('repo.list', {}) as {
      submodules: { repoPath: string; repoName: string; absolutePath: string }[];
    };
    const fromOther = submodules.find(s => s.repoPath === '/other');

    expect(fromOther?.repoName).toBe('other');
    expect(fromOther?.absolutePath).toBe('/other/packages/sdk');
  });

  it('keeps the list usable when one repository cannot be enumerated', async () => {
    const session = new RepositorySession({
      initialRepository: repositories[0],
      repositories,
      createGitService: submoduleAwareFactory('/other'),
    });

    const { submodules } = await session.handleRepo('repo.list', {}) as {
      submodules: { repoPath: string }[];
    };

    expect(submodules.map(s => s.repoPath)).toEqual(['/root']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createActiveRepo, type SessionLike } from '../../src/extension/services/active-repo';
import { repoIdFor } from '../../src/extension/services/review-key';

interface FakeGit { readonly path: string }

function harness(over: {
  session?: SessionLike<FakeGit> | undefined;
  initialPath?: string;
  realpath?: (path: string) => string;
} = {}) {
  let session = over.session;
  const created: string[] = [];
  const repo = createActiveRepo<FakeGit>({
    getSession: () => session,
    initialPath: 'initialPath' in over ? over.initialPath : '/workspace/repo',
    createGitService: (path) => {
      created.push(path);
      return { path };
    },
    realpath: over.realpath ?? ((path) => path),
  });
  return { repo, created, setSession: (next: SessionLike<FakeGit> | undefined) => { session = next; } };
}

function fakeSession(path: string | undefined): SessionLike<FakeGit> {
  return {
    getActiveRepositoryPath: () => path,
    getGitService: () => (path ? { path: `session:${path}` } : null),
  };
}

describe('createActiveRepo', () => {
  it('resolves a repo id with no webview session at all', () => {
    // I1: the reviews view activates on its own (onView:gitGraphPro.reviews).
    // Without this it listed nothing despite reviews being on disk, and every
    // row command silently no-opped.
    const { repo } = harness({ session: undefined });

    expect(repo.getRepoId()).toBe(repoIdFor('/workspace/repo'));
  });

  it('prefers the live session over the workspace default', () => {
    const { repo } = harness({ session: fakeSession('/workspace/submodule') });

    expect(repo.getRepoId()).toBe(repoIdFor('/workspace/submodule'));
  });

  it('keeps the last session repo after the webview is disposed', () => {
    const { repo, setSession } = harness({ session: fakeSession('/workspace/submodule') });
    expect(repo.getPath()).toBe('/workspace/submodule');

    setSession(undefined);

    expect(repo.getPath()).toBe('/workspace/submodule');
    expect(repo.getRepoId()).toBe(repoIdFor('/workspace/submodule'));
  });

  it('reports no repo when the workspace has none and no session exists', () => {
    const { repo } = harness({ session: undefined, initialPath: undefined });

    expect(repo.getRepoId()).toBeUndefined();
    expect(repo.getGitService()).toBeUndefined();
  });

  it('canonicalises the path before hashing it', () => {
    const { repo } = harness({
      session: undefined,
      realpath: (path) => `${path}-real`,
    });

    expect(repo.getRepoId()).toBe(repoIdFor('/workspace/repo-real'));
  });

  it('lets a realpath failure through so callers can tell it apart from "no repo"', () => {
    const { repo } = harness({
      session: undefined,
      realpath: () => { throw new Error('ENOENT: repo directory gone'); },
    });

    expect(() => repo.getRepoId()).toThrow(/ENOENT/);
  });

  it('builds a git service for the tree view when no webview is attached', () => {
    // I2: rerun used to reach through a webview-scoped handler and returned
    // early whenever the graph was closed.
    const { repo, created } = harness({ session: undefined });

    expect(repo.getGitService()).toEqual({ path: '/workspace/repo' });
    expect(created).toEqual(['/workspace/repo']);
  });

  it('reuses the fallback git service until the repo path changes', () => {
    const { repo, created, setSession } = harness({ session: undefined });

    const first = repo.getGitService();
    expect(repo.getGitService()).toBe(first);

    setSession(fakeSession('/workspace/other'));
    expect(repo.getGitService()).toEqual({ path: 'session:/workspace/other' });

    setSession(undefined);
    expect(repo.getGitService()).toEqual({ path: '/workspace/other' });
    expect(created).toEqual(['/workspace/repo', '/workspace/other']);
  });

  it('uses the session git service while a webview is attached', () => {
    const { repo, created } = harness({ session: fakeSession('/workspace/submodule') });

    expect(repo.getGitService()).toEqual({ path: 'session:/workspace/submodule' });
    expect(created).toEqual([]);
  });

  it('defaults realpath to the real filesystem when none is injected', () => {
    const create = vi.fn();
    const repo = createActiveRepo<FakeGit>({
      getSession: () => undefined,
      initialPath: process.cwd(),
      createGitService: create as never,
    });

    expect(repo.getRepoId()).toBeTypeOf('string');
  });
});

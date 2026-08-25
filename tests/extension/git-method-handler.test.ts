import { readFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { handleGitMethod } from '../../src/extension/controllers/git-method-handler';
import { GitService } from '../../src/extension/services/git.service';

const fakeGitService = {
  log: async () => [],
  searchCommits: async () => [],
  branches: async () => [],
  tags: async () => [],
  status: async () => ({ branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] }),
  submoduleList: async () => [{
    name: 'sdk',
    path: 'packages/sdk',
    absolutePath: '/repo/packages/sdk',
    head: 'f'.repeat(40),
    state: 'initialized' as const,
  }],
  show: async () => ({ commit: {}, files: [] }),
  diff: async () => ({ files: [], raw: '' }),
  diffWorkingTree: async () => ({ files: [], raw: '' }),
  checkout: async () => undefined,
  createBranch: async () => undefined,
  deleteBranch: async () => undefined,
  renameBranch: async () => undefined,
  merge: async () => undefined,
  rebase: async () => undefined,
  cherryPick: async () => undefined,
  revert: async () => undefined,
  stash: async () => undefined,
  stashList: async () => [],
  stashApply: async () => undefined,
  worktreeList: async () => [],
  worktreeAdd: async () => undefined,
  worktreeRemove: async () => undefined,
  push: async () => undefined,
  pull: async () => undefined,
  fetch: async () => undefined,
  reset: async () => undefined,
  createTag: async () => undefined,
  deleteTag: async () => undefined,
  abortMerge: async () => undefined,
  abortRebase: async () => undefined,
  squash: async () => undefined,
  reword: async () => undefined,
  canSquash: async () => ({ ok: true }),
  isOnCurrentBranch: async () => true,
  isPublished: async () => false,
} satisfies Partial<GitService>;

describe('handleGitMethod', () => {
  it('returns discovered submodules without exposing host-only absolute paths', async () => {
    await expect(handleGitMethod(fakeGitService as GitService, 'git.submoduleList', {}))
      .resolves.toEqual([{
        name: 'sdk',
        path: 'packages/sdk',
        head: 'f'.repeat(40),
        state: 'initialized',
      }]);
  });

  it('handles every Git RPC the webview can send', async () => {
    const appSource = await readFile(path.resolve('src/webview/App.svelte'), 'utf8');
    const webviewMethods = [...appSource.matchAll(/bridge\.send\('(git\.[^']+)'/g)].map((match) => match[1]);
    const methods = new Set([...webviewMethods, 'git.revert', 'git.isPublished']);
    const unknownMethods: string[] = [];

    for (const method of methods) {
      try {
        await handleGitMethod(fakeGitService as GitService, method, {
          hash: 'abc123',
          hashes: ['abc123', 'def456'],
          ref: 'main',
          ref1: 'HEAD',
          ref2: 'HEAD~1',
          name: 'name',
          oldName: 'old-name',
          newName: 'new-name',
          branch: 'main',
          path: '/tmp/worktree',
          mode: 'mixed',
          message: 'message',
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unknown method:')) {
          unknownMethods.push(method);
        } else {
          throw error;
        }
      }
    }

    expect(unknownMethods).toEqual([]);
  });

  it('routes git.searchCommits to the service, forwarding only the query string', async () => {
    const hashes = ['a'.repeat(40)];
    const received: unknown[] = [];
    const service = {
      ...fakeGitService,
      searchCommits: async (query: string) => {
        received.push(query);
        return hashes;
      },
    };
    const result = await handleGitMethod(service as unknown as GitService, 'git.searchCommits', { query: 'fix' });
    expect(received).toHaveLength(1);
    // Guards the `p.query` extraction: passing `p` or `undefined` must fail here.
    expect(received[0]).toBe('fix');
    expect(result).toEqual(hashes);
  });

  it('routes git.diffWorkingTree to the service', async () => {
    const service = { ...fakeGitService, diffWorkingTree: async () => ({ files: [], raw: 'RAW' }) };
    const result = await handleGitMethod(service as unknown as GitService, 'git.diffWorkingTree', { ref: 'develop' });
    expect(result).toEqual({ files: [], raw: 'RAW' });
  });
});

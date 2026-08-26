import { describe, expect, it, vi } from 'vitest';
import { BitbucketCloudProvider } from '../../src/extension/services/forge/bitbucket/bitbucket-cloud.provider';
import detailFixture from '../fixtures/bitbucket/pull-request.json';
import listFixture from '../fixtures/bitbucket/pull-request-list.json';
import commentsFixture from '../fixtures/bitbucket/comments.json';
import diffstatFixture from '../fixtures/bitbucket/diffstat.json';

function build(api: Partial<Record<'getJson' | 'getText' | 'getPaged', unknown>> = {}) {
  const stub = {
    getJson: vi.fn().mockResolvedValue(detailFixture),
    getText: vi.fn().mockResolvedValue('diff --git a/a b/a\n'),
    getPaged: vi.fn().mockResolvedValue((listFixture as { values: unknown[] }).values),
    ...api,
  };
  const auth = { getSession: vi.fn().mockResolvedValue({ providerId: 'bitbucket-cloud', accountLabel: 'Tuyen' }), signOut: vi.fn() };
  const provider = new BitbucketCloudProvider({ api: stub as never, auth: auth as never });
  return { provider, stub, auth };
}

const repo = { host: 'bitbucket.org', owner: 'acme', name: 'mpos' };

describe('BitbucketCloudProvider', () => {
  it('claims bitbucket.org and nothing else', () => {
    const { provider } = build();
    expect(provider.canHandle({ host: 'bitbucket.org', owner: 'a', name: 'b' })).toBe(true);
    expect(provider.canHandle({ host: 'github.com', owner: 'a', name: 'b' })).toBe(false);
  });

  it('declares its merge strategies', () => {
    const { provider } = build();
    expect(provider.capabilities.mergeStrategies).toEqual(['merge-commit', 'squash', 'fast-forward']);
  });

  it('lists open pull requests through the paged endpoint', async () => {
    const { provider, stub } = build();
    const prs = await provider.listPullRequests(repo, { state: 'open' });

    expect(stub.getPaged).toHaveBeenCalledWith(
      '/repositories/acme/mpos/pullrequests?state=OPEN&pagelen=50');
    expect(prs[0]).toMatchObject({ id: '118', state: 'draft' });
  });

  it.each([
    ['open', 'OPEN'],
    ['merged', 'MERGED'],
    ['closed', 'DECLINED'],
  ])('asks for %s as %s', async (state, expected) => {
    const { provider, stub } = build();
    await provider.listPullRequests(repo, { state: state as never });
    expect(stub.getPaged).toHaveBeenCalledWith(expect.stringContaining(`state=${expected}`));
  });

  it('fetches one pull request', async () => {
    const { provider, stub } = build();
    const pr = await provider.getPullRequest(repo, '123');
    expect(stub.getJson).toHaveBeenCalledWith('/repositories/acme/mpos/pullrequests/123');
    expect(pr.sourceCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  });

  it('fetches the diff as text', async () => {
    const { provider, stub } = build();
    expect(await provider.getPullRequestDiff(repo, '123')).toBe('diff --git a/a b/a\n');
    expect(stub.getText).toHaveBeenCalledWith('/repositories/acme/mpos/pullrequests/123/diff');
  });

  it('lists changed files through the diffstat endpoint', async () => {
    const { provider, stub } = build({
      getPaged: vi.fn().mockResolvedValue((diffstatFixture as { values: unknown[] }).values),
    });
    const files = await provider.getPullRequestFiles(repo, '123');
    expect(stub.getPaged).toHaveBeenCalledWith(
      '/repositories/acme/mpos/pullrequests/123/diffstat?pagelen=50');
    expect(files).toHaveLength(4);
    expect(files.map((f) => f.status)).toEqual(['added', 'deleted', 'renamed', 'modified']);
  });

  it('lists comments without the deleted ones', async () => {
    const { provider } = build({
      getPaged: vi.fn().mockResolvedValue((commentsFixture as { values: unknown[] }).values),
    });
    const comments = await provider.listComments(repo, '123');
    expect(comments.map((c) => c.id)).toEqual(['9001', '9002']);
  });

  it('reports write methods as not implemented in this phase', async () => {
    const { provider } = build();
    await expect(provider.merge(repo, '1', { strategy: 'squash' })).rejects.toMatchObject({ status: 501 });
  });

  // remote-url.ts is the real boundary that keeps a traversal segment out of
  // a ForgeRepoRef; this pins the defence-in-depth guard in base() for the
  // case where a ForgeRepoRef is constructed some other way, so a caller can
  // never turn one into a request that escapes /repositories/{owner}/{name}.
  it.each([
    { host: 'bitbucket.org', owner: '..', name: 'evil' },
    { host: 'bitbucket.org', owner: 'acme', name: '../evil' },
    { host: 'bitbucket.org', owner: '.', name: 'evil' },
  ])('rejects a ForgeRepoRef with a traversal segment (%j) rather than requesting it', async (unsafeRepo) => {
    const { provider, stub } = build();
    await expect(provider.getPullRequest(unsafeRepo, '123')).rejects.toBeInstanceOf(Error);
    expect(stub.getJson).not.toHaveBeenCalled();
  });
});

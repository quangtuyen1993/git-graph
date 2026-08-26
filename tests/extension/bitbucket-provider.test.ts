import { beforeEach, describe, expect, it, vi } from 'vitest';
import detailFixture from '../fixtures/bitbucket/pull-request.json';
import listFixture from '../fixtures/bitbucket/pull-request-list.json';
import commentsFixture from '../fixtures/bitbucket/comments.json';
import diffstatFixture from '../fixtures/bitbucket/diffstat.json';

// BitbucketCloudProvider.getSession/signOut route through
// vscode.authentication now (see below), so importing it pulls in 'vscode' —
// mocked minimally with just the one function these tests actually exercise.
const authenticationMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('vscode', () => ({
  authentication: { getSession: authenticationMocks.getSession },
}));

const { BitbucketCloudProvider } = await import('../../src/extension/services/forge/bitbucket/bitbucket-cloud.provider');
const { BITBUCKET_AUTH_ID, BITBUCKET_TOKEN_SCOPES } =
  await import('../../src/extension/services/forge/bitbucket/bitbucket-constants');

beforeEach(() => {
  authenticationMocks.getSession.mockReset();
});

function build(api: Partial<Record<'getJson' | 'getText' | 'getPaged', unknown>> = {}) {
  const stub = {
    getJson: vi.fn().mockResolvedValue(detailFixture),
    getText: vi.fn().mockResolvedValue('diff --git a/a b/a\n'),
    getPaged: vi.fn().mockResolvedValue((listFixture as { values: unknown[] }).values),
    ...api,
  };
  const auth = {
    getSessions: vi.fn().mockResolvedValue([]),
    removeSession: vi.fn().mockResolvedValue(undefined),
  };
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

describe('BitbucketCloudProvider auth routing', () => {
  it('routes getSession through vscode.authentication.getSession, mapping the account label', async () => {
    authenticationMocks.getSession.mockResolvedValue({
      id: 'sid', accessToken: 'tok',
      account: { id: 'a@b.com', label: 'Tuyen Nguyen' },
      scopes: [...BITBUCKET_TOKEN_SCOPES],
    });
    const { provider } = build();

    const session = await provider.getSession();

    expect(authenticationMocks.getSession).toHaveBeenCalledWith(
      BITBUCKET_AUTH_ID, [...BITBUCKET_TOKEN_SCOPES], { createIfNone: false });
    expect(session).toEqual({ providerId: BITBUCKET_AUTH_ID, accountLabel: 'Tuyen Nguyen' });
  });

  // forge.status runs on every panel load and must never trigger a prompt:
  // omitting opts must still pass createIfNone: false, not leave it unset.
  it('defaults createIfNone to false when no options are given', async () => {
    authenticationMocks.getSession.mockResolvedValue(undefined);
    const { provider } = build();

    await provider.getSession();

    expect(authenticationMocks.getSession).toHaveBeenCalledWith(
      expect.any(String), expect.any(Array), expect.objectContaining({ createIfNone: false }));
  });

  it('passes createIfNone through when the caller explicitly asks to sign in', async () => {
    authenticationMocks.getSession.mockResolvedValue(undefined);
    const { provider } = build();

    await provider.getSession({ createIfNone: true });

    expect(authenticationMocks.getSession).toHaveBeenCalledWith(
      expect.any(String), expect.any(Array), expect.objectContaining({ createIfNone: true }));
  });

  it('returns undefined without inventing a session when none exists', async () => {
    authenticationMocks.getSession.mockResolvedValue(undefined);
    const { provider } = build();
    expect(await provider.getSession()).toBeUndefined();
  });

  it('signs out by removing every session the auth provider currently holds, not via vscode.authentication', async () => {
    const { provider, auth } = build();
    auth.getSessions.mockResolvedValue([{ id: 'sid-1' }, { id: 'sid-2' }]);

    await provider.signOut();

    expect(auth.getSessions).toHaveBeenCalledWith([...BITBUCKET_TOKEN_SCOPES]);
    expect(auth.removeSession).toHaveBeenCalledWith('sid-1');
    expect(auth.removeSession).toHaveBeenCalledWith('sid-2');
  });

  it('signOut is a no-op when there is no session to remove', async () => {
    const { provider, auth } = build();
    await provider.signOut();
    expect(auth.removeSession).not.toHaveBeenCalled();
  });
});

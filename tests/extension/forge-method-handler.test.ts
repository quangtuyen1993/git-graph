import { describe, expect, it, vi } from 'vitest';
import { createForgeHandler, forgeErrorMessage } from '../../src/extension/controllers/forge-method-handler';
import { ForgeRegistry } from '../../src/extension/services/forge/forge-registry';
import { ForgeStore } from '../../src/extension/services/forge/forge-store';
import { ForgeError } from '../../src/extension/services/forge/forge.types';
import { FakeForgeProvider, fakePullRequest } from '../helpers/fake-forge-provider';

function build(options: {
  remoteUrl?: string | undefined;
  provider?: FakeForgeProvider;
} = {}) {
  const provider = options.provider ?? new FakeForgeProvider({ id: 'bitbucket-cloud', name: 'Bitbucket', host: 'bitbucket.org' });
  const registry = new ForgeRegistry();
  registry.register(provider);
  const store = new ForgeStore();
  const broadcast = vi.fn();
  const openExternal = vi.fn().mockResolvedValue(undefined);

  const handle = createForgeHandler({
    registry,
    store,
    getRemoteUrl: async () => ('remoteUrl' in options ? options.remoteUrl : 'git@bitbucket.org:acme/mpos.git'),
    broadcast,
    openExternal,
  });
  return { handle, provider, broadcast, openExternal, store };
}

describe('forge namespace', () => {
  it('reports unavailable when the repository has no remote', async () => {
    const { handle } = build({ remoteUrl: undefined });
    expect(await handle('forge.status', {})).toEqual({ available: false });
  });

  it('reports unavailable when no provider claims the host', async () => {
    const { handle } = build({ remoteUrl: 'git@gitlab.com:acme/mpos.git' });
    expect(await handle('forge.status', {})).toEqual({ available: false });
  });

  it('reports the provider, repo and session when available', async () => {
    const { handle } = build();
    expect(await handle('forge.status', {})).toMatchObject({
      available: true,
      providerId: 'bitbucket-cloud',
      providerName: 'Bitbucket',
      signedIn: true,
      accountLabel: 'An Tran',
      repo: { host: 'bitbucket.org', owner: 'acme', name: 'mpos' },
    });
  });

  it('reports signedIn false without prompting', async () => {
    const provider = new FakeForgeProvider({ host: 'bitbucket.org', session: undefined });
    const { handle } = build({ provider });
    expect(await handle('forge.status', {})).toMatchObject({ available: true, signedIn: false });
  });

  it('lists pull requests and caches within the TTL', async () => {
    const { handle, provider } = build();
    const first = await handle('forge.pr.list', { state: 'open' }) as { pullRequests: unknown[]; stale: boolean };
    await handle('forge.pr.list', { state: 'open' });

    expect(first.pullRequests).toHaveLength(1);
    expect(first.stale).toBe(false);
    expect(provider.calls.filter((c) => c.method === 'listPullRequests')).toHaveLength(1);
  });

  it('defaults the list state to open', async () => {
    const { handle, provider } = build();
    await handle('forge.pr.list', {});
    expect(provider.calls[0].args[1]).toEqual({ state: 'open' });
  });

  it('fetches a pull request, its diff and its comments', async () => {
    const { handle, provider } = build();
    expect(await handle('forge.pr.get', { id: '123' })).toMatchObject({ id: '123' });
    expect(await handle('forge.pr.diff', { id: '123' })).toMatchObject({ diff: expect.stringContaining('diff --git') });
    expect(await handle('forge.pr.comments', { id: '123' })).toEqual({ comments: [] });
    expect(provider.calls.map((c) => c.method)).toEqual(['getPullRequest', 'getPullRequestDiff', 'listComments']);
  });

  it('keys the diff cache by the sha pair, not the pull request id', async () => {
    const provider = new FakeForgeProvider({
      host: 'bitbucket.org',
      pullRequests: [fakePullRequest({ id: '1', sourceCommit: 'aaa', targetCommit: 'bbb' })],
    });
    const { handle } = build({ provider });

    await handle('forge.pr.diff', { id: '1' });
    await handle('forge.pr.diff', { id: '1' });
    expect(provider.calls.filter((c) => c.method === 'getPullRequestDiff')).toHaveLength(1);
  });

  it('refresh drops the cache and broadcasts', async () => {
    const { handle, provider, broadcast } = build();
    await handle('forge.pr.list', { state: 'open' });
    await handle('forge.refresh', {});
    await handle('forge.pr.list', { state: 'open' });

    expect(provider.calls.filter((c) => c.method === 'listPullRequests')).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledWith('forge.changed', {});
  });

  it('signs in on demand and broadcasts the change', async () => {
    const provider = new FakeForgeProvider({ host: 'bitbucket.org', session: undefined });
    const { handle, broadcast } = build({ provider });
    await handle('forge.signIn', {});
    expect(broadcast).toHaveBeenCalledWith('forge.changed', {});
  });

  it('signs out, clears the cache and broadcasts', async () => {
    const { handle, provider, broadcast } = build();
    await handle('forge.signOut', {});
    expect(await provider.getSession()).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith('forge.changed', {});
  });

  it('opens a pull request in the browser', async () => {
    const { handle, openExternal } = build();
    await handle('forge.pr.openExternal', { id: '123' });
    expect(openExternal).toHaveBeenCalledWith('https://bitbucket.org/acme/mpos/pull-requests/123');
  });

  it('rejects an unknown method', async () => {
    const { handle } = build();
    await expect(handle('forge.nope', {})).rejects.toThrow('Unknown method: forge.nope');
  });

  it('rejects a pull request call when the repository is not on a forge', async () => {
    const { handle } = build({ remoteUrl: undefined });
    await expect(handle('forge.pr.list', {})).rejects.toThrow('No pull request provider for this repository');
  });

  it('does not let one repository\'s cache invalidation clear a sibling whose name shares its prefix', async () => {
    // Two repositories in the same workspace whose names share a prefix
    // ('mpos' and 'mpos2') must not invalidate each other's cache: the
    // cache-key prefix must be delimiter-terminated so ForgeStore.invalidate's
    // bare startsWith match can't cross into the longer sibling name.
    const providerA = new FakeForgeProvider({ id: 'bitbucket-cloud', name: 'Bitbucket', host: 'bitbucket.org' });
    const registry = new ForgeRegistry();
    registry.register(providerA);
    const store = new ForgeStore();
    const broadcast = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);

    let remoteUrl = 'git@bitbucket.org:acme/mpos.git';
    const handle = createForgeHandler({
      registry,
      store,
      getRemoteUrl: async () => remoteUrl,
      broadcast,
      openExternal,
    });

    // Populate the cache for 'mpos'.
    await handle('forge.pr.list', { state: 'open' });
    // Populate the cache for 'mpos2' (sibling repo, shares the 'mpos' prefix).
    remoteUrl = 'git@bitbucket.org:acme/mpos2.git';
    await handle('forge.pr.list', { state: 'open' });

    // Invalidate 'mpos2's cache via forge.refresh.
    await handle('forge.refresh', {});
    // Re-fetching 'mpos2' should hit the provider again (its cache was dropped).
    await handle('forge.pr.list', { state: 'open' });
    expect(providerA.calls.filter((c) => c.method === 'listPullRequests')).toHaveLength(3);

    // Switch back to 'mpos' — its cache must still be intact (not invalidated
    // by the 'mpos2' refresh above), so no new provider call happens.
    remoteUrl = 'git@bitbucket.org:acme/mpos.git';
    await handle('forge.pr.list', { state: 'open' });
    expect(providerA.calls.filter((c) => c.method === 'listPullRequests')).toHaveLength(3);
  });
});

describe('forgeErrorMessage', () => {
  it('tells an expired token from a missing scope', () => {
    expect(forgeErrorMessage(new ForgeError('unauthorized', 401, 'Unauthorized')))
      .toMatch(/expired or (has been )?revoked/i);

    // 'forbidden' never composes scope advice itself — it delegates to the
    // provider that produced the error, so the shared layer never names a
    // provider or a scope list.
    const provider = new FakeForgeProvider({ host: 'bitbucket.org' });
    const forbiddenError = new ForgeError('forbidden', 403, 'Forbidden');
    const forbidden = forgeErrorMessage(forbiddenError, provider);
    expect(forbidden).toBe(provider.describeError(forbiddenError));
    expect(forbidden).not.toMatch(/sign in again/i);
  });

  it('explains a not-found as access rather than absence', () => {
    expect(forgeErrorMessage(new ForgeError('not-found', 404, 'Not found')))
      .toMatch(/private repository or insufficient token scope/i);
  });

  it('reports the retry delay on a rate limit', () => {
    expect(forgeErrorMessage(new ForgeError('rate-limited', 429, 'Rate limit', 37))).toContain('37');
  });

  it('passes the host message through for anything else, with no provider given', () => {
    expect(forgeErrorMessage(new ForgeError('other', 500, 'Bitbucket is having a moment')))
      .toBe('Bitbucket is having a moment');
  });

  it('handles a non-ForgeError', () => {
    expect(forgeErrorMessage(new Error('socket hang up'))).toBe('socket hang up');
    expect(forgeErrorMessage('nope')).toBe('nope');
  });

  it('never names a hosting service on its own, without a provider', () => {
    // Correction: forgeErrorMessage's own copy (everything except the
    // provider-delegated 'forbidden' branch) must stay host-neutral — the
    // per-host wording (which credential, which specific scopes) belongs to
    // provider.describeError, never to this shared file. It's fine for the
    // shared copy to use the generic word "scope" (as the not-found message
    // does) — what it must never do is name a hosting service.
    const messages = [
      forgeErrorMessage(new ForgeError('unauthorized', 401, 'nope')),
      forgeErrorMessage(new ForgeError('not-found', 404, 'nope')),
      forgeErrorMessage(new ForgeError('rate-limited', 429, 'nope', 5)),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/bitbucket|github|gitlab/i);
    }
  });
});

describe('forge namespace error translation', () => {
  it('translates a provider ForgeError before it reaches the webview, using the provider that threw it', async () => {
    const provider = new FakeForgeProvider({ host: 'bitbucket.org' });
    const error = new ForgeError('forbidden', 403, 'Forbidden');
    provider.listPullRequests = () => Promise.reject(error);
    const { handle } = build({ provider });

    await expect(handle('forge.pr.list', {})).rejects.toThrow(provider.describeError(error));
  });
});

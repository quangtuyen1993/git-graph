import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgeError, type ForgeProvider } from '../../src/extension/services/forge/forge.types';
import detailFixture from '../fixtures/github/pull-request.json';
import listFixture from '../fixtures/github/pull-request-list.json';
import reviewsFixture from '../fixtures/github/reviews.json';
import filesFixture from '../fixtures/github/files.json';
import issueCommentsFixture from '../fixtures/github/issue-comments.json';
import reviewCommentsFixture from '../fixtures/github/review-comments.json';

// GitHubCloudProvider.getSession routes through vscode.authentication now
// (see below), so importing it pulls in 'vscode' — mocked minimally with
// just the one function these tests actually exercise, the same pattern
// bitbucket-provider.test.ts uses.
const authenticationMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('vscode', () => ({
  authentication: { getSession: authenticationMocks.getSession },
}));

const { GitHubCloudProvider } = await import('../../src/extension/services/forge/github/github-cloud.provider');
const { GITHUB_AUTH_ID, GITHUB_TOKEN_SCOPES } = await import('../../src/extension/services/forge/github/github-constants');

beforeEach(() => {
  authenticationMocks.getSession.mockReset();
});

function build(api: Partial<Record<'getJson' | 'getText' | 'getPaged' | 'post' | 'put' | 'del', unknown>> = {}) {
  const stub = {
    getJson: vi.fn().mockResolvedValue(detailFixture),
    getText: vi.fn().mockResolvedValue('diff --git a/a b/a\n'),
    getPaged: vi.fn().mockImplementation((path: string) => {
      if (path.includes('/reviews')) return Promise.resolve(reviewsFixture);
      if (path.includes('/files')) return Promise.resolve(filesFixture);
      if (path.includes('/issues/')) return Promise.resolve(issueCommentsFixture);
      if (path.includes('/pulls/') && path.includes('/comments')) return Promise.resolve(reviewCommentsFixture);
      return Promise.resolve(listFixture);
    }),
    post: vi.fn().mockResolvedValue(detailFixture),
    put: vi.fn().mockResolvedValue(detailFixture),
    del: vi.fn().mockResolvedValue(undefined),
    ...api,
  };
  const provider = new GitHubCloudProvider({ api: stub as never });
  return { provider, stub };
}

const repo = { host: 'github.com', owner: 'acme', name: 'mpos' };

describe('GitHubCloudProvider', () => {
  it('claims github.com and nothing else', () => {
    const { provider } = build();
    expect(provider.canHandle({ host: 'github.com', owner: 'a', name: 'b' })).toBe(true);
    expect(provider.canHandle({ host: 'bitbucket.org', owner: 'a', name: 'b' })).toBe(false);
  });

  it('declares its merge strategies without fast-forward', () => {
    const { provider } = build();
    expect(provider.capabilities.mergeStrategies).toEqual(['merge-commit', 'squash', 'rebase']);
  });

  // The whole point of the optional-signOut amendment (phase 3.7): a
  // consumer of VS Code's built-in `github` provider has no API to remove a
  // session, so this provider must not even carry the member.
  it('has no signOut member at all', () => {
    const { provider } = build();
    expect((provider as ForgeProvider).signOut).toBeUndefined();
    expect('signOut' in provider).toBe(false);
  });

  it('lists open pull requests through the paged endpoint', async () => {
    const { provider, stub } = build();
    const prs = await provider.listPullRequests(repo, { state: 'open' });
    expect(stub.getPaged).toHaveBeenCalledWith('/repos/acme/mpos/pulls?state=open&per_page=100');
    expect(prs.map((p) => p.number)).toEqual([118, 100, 99]);
  });

  // GitHub's `state` query has only open/closed — 'merged' and 'closed'
  // both query state=closed and are told apart afterwards by merged_at.
  it('filters a closed-state query down to genuinely closed (unmerged) pull requests', async () => {
    const { provider, stub } = build();
    const prs = await provider.listPullRequests(repo, { state: 'closed' });
    expect(stub.getPaged).toHaveBeenCalledWith('/repos/acme/mpos/pulls?state=closed&per_page=100');
    expect(prs.map((p) => p.number)).toEqual([99]);
  });

  it('filters a closed-state query down to merged pull requests when asked for merged', async () => {
    const { provider, stub } = build();
    const prs = await provider.listPullRequests(repo, { state: 'merged' });
    expect(stub.getPaged).toHaveBeenCalledWith('/repos/acme/mpos/pulls?state=closed&per_page=100');
    expect(prs.map((p) => p.number)).toEqual([100]);
  });

  it('fetches one pull request and its reviews to build the authoritative reviewer list', async () => {
    const { provider, stub } = build();
    const pr = await provider.getPullRequest(repo, '118');
    expect(stub.getJson).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118');
    expect(stub.getPaged).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118/reviews?per_page=100');
    expect(pr.sourceCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(pr.reviewers.find((r) => r.user.accountId === 'an-tran')?.status).toBe('approved');
  });

  it('fetches the diff as text with the diff media type', async () => {
    const { provider, stub } = build();
    expect(await provider.getPullRequestDiff(repo, '118')).toBe('diff --git a/a b/a\n');
    expect(stub.getText).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118', { Accept: 'application/vnd.github.v3.diff' });
  });

  it('lists changed files through the files endpoint', async () => {
    const { provider, stub } = build();
    const files = await provider.getPullRequestFiles(repo, '118');
    expect(stub.getPaged).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118/files?per_page=100');
    expect(files.map((f) => f.status)).toEqual(['added', 'deleted', 'renamed', 'modified']);
  });

  it('fetches the default branch from the repository resource', async () => {
    const { provider, stub } = build({ getJson: vi.fn().mockResolvedValue({ default_branch: 'develop' }) });
    const info = await provider.getRepoInfo(repo);
    expect(stub.getJson).toHaveBeenCalledWith('/repos/acme/mpos');
    expect(info).toEqual({ defaultBranch: 'develop' });
  });

  it('lists reviewer candidates through the collaborators endpoint', async () => {
    const { provider, stub } = build({
      getPaged: vi.fn().mockResolvedValue([{ login: 'minh-le', id: 1002, avatar_url: 'https://a.example/m.png' }]),
    });
    const candidates = await provider.listReviewerCandidates(repo);
    expect(stub.getPaged).toHaveBeenCalledWith('/repos/acme/mpos/collaborators?per_page=100');
    expect(candidates).toEqual([{ displayName: 'minh-le', accountId: 'minh-le', avatarUrl: 'https://a.example/m.png' }]);
  });

  it('creates a pull request via POST, mapping head/base', async () => {
    const { provider, stub } = build();
    await provider.createPullRequest(repo, {
      title: 'fix(auth): refresh token race', description: 'body',
      sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
    });
    expect(stub.post).toHaveBeenCalledWith(
      '/repos/acme/mpos/pulls',
      { title: 'fix(auth): refresh token race', body: 'body', head: 'feature/RMS-1027', base: 'develop' },
      { detectDuplicate: true },
    );
  });

  // GitHub's create endpoint has no reviewers field; requesting reviewers is
  // a second call whose response (the updated PR) supersedes the create
  // response.
  it('requests reviewers via a second call when given, using the create response for the PR number', async () => {
    const created = { ...detailFixture, number: 118 };
    const withReviewers = { ...detailFixture, requested_reviewers: [{ login: 'minh-le', id: 1002 }] };
    const post = vi.fn().mockResolvedValueOnce(created).mockResolvedValueOnce(withReviewers);
    const { provider } = build({ post });
    const result = await provider.createPullRequest(repo, {
      title: 't', description: '', sourceBranch: 'a', targetBranch: 'b', reviewers: ['minh-le'],
    });
    expect(post).toHaveBeenNthCalledWith(2, '/repos/acme/mpos/pulls/118/requested_reviewers', { reviewers: ['minh-le'] });
    expect(result.reviewers.some((r) => r.user.accountId === 'minh-le')).toBe(true);
  });

  it('does not call the reviewers endpoint when no reviewers are given', async () => {
    const { provider, stub } = build();
    await provider.createPullRequest(repo, { title: 't', description: '', sourceBranch: 'a', targetBranch: 'b' });
    expect(stub.post).toHaveBeenCalledTimes(1);
  });

  it('lets a duplicate ForgeError from the host reach the caller with kind duplicate', async () => {
    const duplicate = new ForgeError('duplicate', 422, 'A pull request already exists for acme:a.');
    const { provider } = build({ post: vi.fn().mockRejectedValue(duplicate) });
    await expect(provider.createPullRequest(repo, {
      title: 't', description: '', sourceBranch: 'a', targetBranch: 'b',
    })).rejects.toBe(duplicate);
  });

  it('lists comments merged from issue and review comment endpoints', async () => {
    const { provider } = build();
    const comments = await provider.listComments(repo, '118');
    expect(comments.map((c) => c.id)).toEqual(['5001', '6001', '6002', '6003']);
  });

  it('approves a pull request via POST with event APPROVE', async () => {
    const { provider, stub } = build();
    await provider.setReviewStatus(repo, '118', 'approved');
    expect(stub.post).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118/reviews', { event: 'APPROVE' });
  });

  it('passes the body through on approve when one is supplied', async () => {
    const { provider, stub } = build();
    await provider.setReviewStatus(repo, '118', 'approved', { body: 'LGTM' });
    expect(stub.post).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118/reviews', { event: 'APPROVE', body: 'LGTM' });
  });

  it('requests changes with the supplied body', async () => {
    const { provider, stub } = build();
    await provider.setReviewStatus(repo, '118', 'changes_requested', { body: 'Please add a test' });
    expect(stub.post).toHaveBeenCalledWith(
      '/repos/acme/mpos/pulls/118/reviews', { event: 'REQUEST_CHANGES', body: 'Please add a test' });
  });

  // GitHub rejects REQUEST_CHANGES with an empty body; the webview does not
  // currently collect one for this action, so the provider must supply a
  // fallback rather than letting every "request changes" click 422.
  it('falls back to a fixed body when requesting changes with no body supplied', async () => {
    const post = vi.fn().mockResolvedValue({});
    const { provider } = build({ post });
    await provider.setReviewStatus(repo, '118', 'changes_requested');
    expect(post).toHaveBeenCalledWith(
      '/repos/acme/mpos/pulls/118/reviews', { event: 'REQUEST_CHANGES', body: expect.any(String) });
    const [, body] = post.mock.calls[0];
    expect((body as { body: string }).body.length).toBeGreaterThan(0);
  });

  it('merges with the mapped strategy', async () => {
    const { provider, stub } = build();
    await provider.merge(repo, '118', { strategy: 'squash' });
    expect(stub.put).toHaveBeenCalledWith('/repos/acme/mpos/pulls/118/merge', { merge_method: 'squash' });
  });

  it('refuses to merge with a strategy this provider does not support', async () => {
    const { provider, stub } = build();
    await expect(provider.merge(repo, '118', { strategy: 'fast-forward' })).rejects.toBeInstanceOf(ForgeError);
    expect(stub.put).not.toHaveBeenCalled();
  });

  it('deletes the source branch after merging when closeSourceBranch is set and the branch is in this repo', async () => {
    const { provider, stub } = build();
    await provider.merge(repo, '118', { strategy: 'squash', closeSourceBranch: true });
    expect(stub.del).toHaveBeenCalledWith('/repos/acme/mpos/git/refs/heads/feature%2FRMS-1027');
  });

  it('does not delete the source branch when it lives in a fork', async () => {
    const { provider, stub } = build({
      getJson: vi.fn().mockResolvedValue({
        ...detailFixture, head: { ...detailFixture.head, repo: { full_name: 'someone-else/mpos' } },
      }),
    });
    await provider.merge(repo, '118', { strategy: 'squash', closeSourceBranch: true });
    expect(stub.del).not.toHaveBeenCalled();
  });

  it('does not delete the source branch when closeSourceBranch is not set', async () => {
    const { provider, stub } = build();
    await provider.merge(repo, '118', { strategy: 'squash' });
    expect(stub.del).not.toHaveBeenCalled();
  });

  it('a merge succeeds even when the best-effort branch deletion afterwards fails', async () => {
    const { provider, stub } = build({ del: vi.fn().mockRejectedValue(new Error('branch protected')) });
    await expect(provider.merge(repo, '118', { strategy: 'squash', closeSourceBranch: true })).resolves.toBeUndefined();
  });

  it("surfaces a blocked merge's host message verbatim", async () => {
    const blocked = new ForgeError('other', 405, 'Pull Request is not mergeable');
    const { provider } = build({ put: vi.fn().mockRejectedValue(blocked) });
    await expect(provider.merge(repo, '118', { strategy: 'squash' }))
      .rejects.toMatchObject({ hostMessage: 'Pull Request is not mergeable' });
  });

  it('explains a forbidden error in GitHub-specific terms via describeError', () => {
    const { provider } = build();
    expect(provider.describeError(new ForgeError('forbidden', 403, 'Resource not accessible')))
      .toMatch(/github/i);
    expect(provider.describeError(new ForgeError('forbidden', 403, 'Resource not accessible')))
      .toContain(GITHUB_TOKEN_SCOPES[0]);
  });

  it('explains a not-found in GitHub-specific terms via describeError', () => {
    const { provider } = build();
    expect(provider.describeError(new ForgeError('not-found', 404, 'Not Found'))).toMatch(/github/i);
  });

  it('passes other error kinds through verbatim via describeError', () => {
    const { provider } = build();
    const error = new ForgeError('other', 500, 'Internal error');
    expect(provider.describeError(error)).toBe('Internal error');
  });

  it.each([
    { host: 'github.com', owner: '..', name: 'evil' },
    { host: 'github.com', owner: 'acme', name: '../evil' },
    { host: 'github.com', owner: '.', name: 'evil' },
  ])('rejects a ForgeRepoRef with a traversal segment (%j) rather than requesting it', async (unsafeRepo) => {
    const { provider, stub } = build();
    await expect(provider.getPullRequest(unsafeRepo, '118')).rejects.toBeInstanceOf(Error);
    expect(stub.getJson).not.toHaveBeenCalled();
  });
});

describe('GitHubCloudProvider auth routing', () => {
  it('routes getSession through vscode.authentication.getSession, mapping the account label', async () => {
    authenticationMocks.getSession.mockResolvedValue({
      id: 'sid', accessToken: 'tok', account: { id: 'an-tran', label: 'An Tran' }, scopes: [...GITHUB_TOKEN_SCOPES],
    });
    const { provider } = build();

    const session = await provider.getSession();

    expect(authenticationMocks.getSession).toHaveBeenCalledWith(
      GITHUB_AUTH_ID, [...GITHUB_TOKEN_SCOPES], { createIfNone: false });
    expect(session).toEqual({ providerId: GITHUB_AUTH_ID, accountLabel: 'An Tran' });
  });

  // forge.status runs on every panel load and must never trigger a prompt.
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
});

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
];

const pullRequestSummary = {
  id: 'pr-1', number: 42, title: 'Add widgets', state: 'open',
  sourceBranch: 'feature/widgets', targetBranch: 'main',
  reviewers: [], commentCount: 0,
};
const pullRequestDetail = {
  ...pullRequestSummary,
  description: 'desc', sourceCommit: 'c'.repeat(40), targetCommit: 'd'.repeat(40),
  mergeable: 'clean', webUrl: 'https://example.test/pr/42',
};
const prFiles = [
  { path: 'src/widget.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
];
// A pull request whose head has never been fetched locally has no local
// commits at all — the diff text is the only source of truth this test path
// is allowed to touch.
const prDiffText = [
  'diff --git a/src/widget.ts b/src/widget.ts',
  '--- a/src/widget.ts',
  '+++ b/src/widget.ts',
  '@@ -1,2 +1,2 @@',
  ' context',
  '-old line',
  '+new line',
].join('\n');

function stubApp() {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'git.isOnCurrentBranch': return { onBranch: false };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getRow': return { row: null };
      case 'forge.status': return {
        available: true, providerName: 'Bitbucket', signedIn: true,
        capabilities: { createPullRequest: false, approve: false, requestChanges: false, merge: false, mergeStrategies: [] },
      };
      case 'forge.pr.list': return { pullRequests: [pullRequestSummary], stale: false };
      case 'forge.pr.get': return pullRequestDetail;
      case 'forge.pr.comments': return { comments: [] };
      case 'forge.pr.files': return { files: prFiles };
      case 'forge.pr.diff': return { diff: prDiffText };
      case 'review.setTarget': return { success: true };
      case 'ui.openTextDiff': return { success: true };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

async function selectPullRequest(rendered: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(rendered.getByText('PULL REQUESTS')).toBeInTheDocument());
  await fireEvent.click(rendered.getByText('PULL REQUESTS'));
  const row = await waitFor(() => rendered.getByText('Add widgets'));
  await fireEvent.click(row.closest('button')!);
  await waitFor(() => expect(rendered.getByRole('button', { name: /review with ai/i })).toBeInTheDocument());
}

describe('Review with AI from the pull request detail panel', () => {
  it('hands the pull request off to the review panel without any git-derived ref', async () => {
    stubApp();
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /review with ai/i }));

    // Only the pull request's own id and title cross the boundary — no
    // baseRef/headRef the webview resolved itself, which is what would leak
    // in if this reused the git-based review.setTarget path.
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'pr', prId: 'pr-1', subject: 'Add widgets',
    }));
  });
});

describe('opening a file diff from the pull request detail panel', () => {
  it('opens the file diff from the cached forge diff, without any local git call', async () => {
    stubApp();
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByText('src/widget.ts'));

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.diff', { id: 'pr-1' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openTextDiff', {
      path: 'src/widget.ts', oldPath: null, status: 'modified',
      oldContent: 'context\nold line',
      newContent: 'context\nnew line',
    }));
    expect(send).not.toHaveBeenCalledWith('ui.openDiff', expect.anything());
  });

  it('reuses the already-fetched diff text for a second file instead of refetching', async () => {
    stubApp();
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByText('src/widget.ts'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.diff', { id: 'pr-1' }));
    send.mockClear();

    await fireEvent.click(rendered.getByText('src/widget.ts'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openTextDiff', expect.anything()));
    expect(send).not.toHaveBeenCalledWith('forge.pr.diff', expect.anything());
  });
});

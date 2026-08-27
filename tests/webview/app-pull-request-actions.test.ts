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
  reviewers: [{ user: { displayName: 'An Tran', accountId: 'a' }, status: 'pending' }],
  commentCount: 0,
};
const pullRequestDetail = {
  ...pullRequestSummary,
  description: 'desc', sourceCommit: 'c'.repeat(40), targetCommit: 'd'.repeat(40),
  mergeable: 'clean', webUrl: 'https://example.test/pr/42',
};
const approvedDetail = {
  ...pullRequestDetail,
  reviewers: [{ user: { displayName: 'An Tran', accountId: 'a' }, status: 'approved' }],
};
const changesRequestedDetail = {
  ...pullRequestDetail,
  reviewers: [{ user: { displayName: 'An Tran', accountId: 'a' }, status: 'changes_requested' }],
};

function stubApp(overrides: Partial<Record<string, unknown>> = {}) {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    if (method in overrides) return (overrides[method] as (params?: unknown) => unknown)(params);
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
        capabilities: {
          createPullRequest: false, approve: true, requestChanges: true, merge: true,
          mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
        },
      };
      case 'forge.pr.list': return { pullRequests: [pullRequestSummary], stale: false };
      case 'forge.pr.get': return pullRequestDetail;
      case 'forge.pr.comments': return { comments: [] };
      case 'forge.pr.files': return { files: [] };
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
  await waitFor(() => expect(rendered.getByRole('button', { name: /^approve$/i })).toBeInTheDocument());
}

describe('Approving a pull request from the detail panel', () => {
  it('sends forge.pr.approve and reflects the update with no confirmation dialog', async () => {
    stubApp({ 'forge.pr.approve': () => approvedDetail });
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /^approve$/i }));

    // Approving is undoable — no ui.confirm round trip, unlike merge.
    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.approve', { id: 'pr-1' }));
    expect(send).not.toHaveBeenCalledWith('ui.confirm', expect.anything());
    await waitFor(() => expect(rendered.getByLabelText('An Tran approved')).toBeInTheDocument());
  });
});

describe('Requesting changes from the detail panel', () => {
  it('sends forge.pr.requestChanges and reflects the update', async () => {
    stubApp({ 'forge.pr.requestChanges': () => changesRequestedDetail });
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /request changes/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.requestChanges', { id: 'pr-1' }));
    await waitFor(() => expect(rendered.getByLabelText('An Tran changes_requested')).toBeInTheDocument());
  });
});

describe('Merging a pull request from the detail panel', () => {
  it('confirms first, naming the pull request, its strategy and target branch, offering only declared strategies', async () => {
    stubApp();
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /^merge$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.confirm', {
      message: 'Merge pull request #42 "Add widgets" into main?',
      choices: ['Merge commit', 'Squash', 'Fast-forward'],
    }));
    // Cancelling (ui.confirm resolves null, the default stub's fallback)
    // must not have sent a merge request.
    expect(send).not.toHaveBeenCalledWith('forge.pr.merge', expect.anything());
  });

  it('performs no request when the confirmation is cancelled', async () => {
    stubApp({ 'ui.confirm': () => null });
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /^merge$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.confirm', expect.anything()));
    expect(send).not.toHaveBeenCalledWith('forge.pr.merge', expect.anything());
  });

  it('merges with the chosen strategy once confirmed', async () => {
    let mergeCall: unknown;
    stubApp({
      'ui.confirm': () => 'Squash',
      'forge.pr.merge': (params: unknown) => { mergeCall = params; return { success: true }; },
    });
    const rendered = render(App);
    await selectPullRequest(rendered);
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /^merge$/i }));

    await waitFor(() => expect(mergeCall).toEqual({ id: 'pr-1', strategy: 'squash' }));
  });
});

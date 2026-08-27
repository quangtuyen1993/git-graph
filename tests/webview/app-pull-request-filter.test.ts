import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
];

const openPr = {
  id: 'pr-open', number: 10, title: 'Open one', state: 'open',
  sourceBranch: 'feature/open', targetBranch: 'main', reviewers: [], commentCount: 0,
  updatedAt: '2026-08-20T10:00:00Z',
};
const mergedPr = {
  id: 'pr-merged', number: 11, title: 'Merged one', state: 'merged',
  sourceBranch: 'feature/merged', targetBranch: 'main', reviewers: [], commentCount: 0,
  updatedAt: '2026-08-25T10:00:00Z', // most recent of the three
};
const closedPr = {
  id: 'pr-closed', number: 12, title: 'Closed one', state: 'closed',
  sourceBranch: 'feature/closed', targetBranch: 'main', reviewers: [], commentCount: 0,
  updatedAt: '2026-08-22T10:00:00Z',
};

const PR_BY_STATE: Record<string, unknown[]> = {
  open: [openPr],
  merged: [mergedPr],
  closed: [closedPr],
};

function stubApp(overrides: Partial<Record<string, (params?: unknown) => unknown>> = {}) {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    if (method in overrides) return overrides[method]!(params);
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
      case 'forge.pr.list': {
        const state = (params as { state?: string } | undefined)?.state ?? 'open';
        return { pullRequests: PR_BY_STATE[state] ?? [], stale: false };
      }
      case 'ui.getState': return null;
      case 'ui.setState': return undefined;
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

async function openPullRequestsSection(rendered: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(rendered.getByText('PULL REQUESTS')).toBeInTheDocument());
  await fireEvent.click(rendered.getByText('PULL REQUESTS'));
}

describe('Pull request status filter', () => {
  it('defaults to Open on first use', async () => {
    stubApp();
    const rendered = render(App);
    await openPullRequestsSection(rendered);

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.list', { state: 'open' }));
    expect(send).not.toHaveBeenCalledWith('forge.pr.list', { state: 'merged' });
    expect(send).not.toHaveBeenCalledWith('forge.pr.list', { state: 'closed' });
    await waitFor(() => expect(rendered.getByText('Open one')).toBeInTheDocument());

    const select = rendered.getByRole('combobox', { name: /filter pull requests/i }) as HTMLSelectElement;
    expect(select.value).toBe('open');
  });

  it('refetches with the right state when the filter is switched', async () => {
    stubApp();
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await waitFor(() => expect(rendered.getByText('Open one')).toBeInTheDocument());
    send.mockClear();

    const select = rendered.getByRole('combobox', { name: /filter pull requests/i });
    await fireEvent.change(select, { target: { value: 'merged' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.list', { state: 'merged' }));
    await waitFor(() => expect(rendered.getByText('Merged one')).toBeInTheDocument());
    expect(rendered.queryByText('Open one')).not.toBeInTheDocument();
  });

  it('follows the filter in the section count badge', async () => {
    stubApp();
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await waitFor(() => expect(rendered.getByRole('button', { name: /pull requests.*1/i })).toBeInTheDocument());

    const select = rendered.getByRole('combobox', { name: /filter pull requests/i });
    await fireEvent.change(select, { target: { value: 'all' } });

    // All three fixtures together: three rows, badge follows.
    await waitFor(() => expect(rendered.getByRole('button', { name: /pull requests.*3/i })).toBeInTheDocument());
  });

  it("'All' merges the three states and orders by most recently updated", async () => {
    stubApp();
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await waitFor(() => expect(rendered.getByText('Open one')).toBeInTheDocument());
    send.mockClear();

    const select = rendered.getByRole('combobox', { name: /filter pull requests/i });
    await fireEvent.change(select, { target: { value: 'all' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.list', { state: 'open' }));
    expect(send).toHaveBeenCalledWith('forge.pr.list', { state: 'merged' });
    expect(send).toHaveBeenCalledWith('forge.pr.list', { state: 'closed' });

    await waitFor(() => expect(rendered.getByText('Merged one')).toBeInTheDocument());
    const titles = [...rendered.container.querySelectorAll('.pr-title')].map((el) => el.textContent);
    // merged (Aug 25) > closed (Aug 22) > open (Aug 20)
    expect(titles).toEqual(['Merged one', 'Closed one', 'Open one']);
  });

  it('keeps the search box narrowing whatever the filter returned', async () => {
    stubApp();
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    const select = rendered.getByRole('combobox', { name: /filter pull requests/i });
    await fireEvent.change(select, { target: { value: 'all' } });
    await waitFor(() => expect(rendered.getByText('Merged one')).toBeInTheDocument());

    const searchInput = rendered.container.querySelector('.sidebar-search input') as HTMLInputElement;
    await fireEvent.input(searchInput, { target: { value: 'closed' } });

    expect(rendered.getByText('Closed one')).toBeInTheDocument();
    expect(rendered.queryByText('Merged one')).not.toBeInTheDocument();
    expect(rendered.queryByText('Open one')).not.toBeInTheDocument();
  });

  it('survives a reload: a persisted filter is restored and fetched on load', async () => {
    stubApp({
      'ui.getState': (params) => {
        const key = (params as { key: string }).key;
        if (key.startsWith('sidebarState:')) {
          return {
            sections: {
              local: true, remote: false, tags: false, stashes: false,
              worktrees: false, submodules: false, pullRequests: true,
            },
            expandedRemotes: {},
            expandedGroups: {},
            pullRequestsFilter: 'closed',
          };
        }
        return null;
      },
    });
    const rendered = render(App);

    await waitFor(() => expect(rendered.getByText('Closed one')).toBeInTheDocument());
    await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.list', { state: 'closed' }));
    expect(rendered.queryByText('Open one')).not.toBeInTheDocument();

    const select = rendered.getByRole('combobox', { name: /filter pull requests/i }) as HTMLSelectElement;
    expect(select.value).toBe('closed');
  });
});

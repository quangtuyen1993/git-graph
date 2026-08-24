import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

const branch = {
  name: 'main',
  current: true,
  hash: 'a'.repeat(40),
  remote: null,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
};

const branchHeadNode = {
  hash: branch.hash,
  abbreviatedHash: branch.hash.slice(0, 7),
  subject: 'branch head',
  author: 'A',
  authorEmail: 'a@example.test',
  authorDate: '2026-08-24T00:00:00Z',
  refs: ['main'],
  parents: [],
  lane: 0,
  row: 50,
  color: 0,
};

describe('App sidebar primary actions', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  async function renderApp({
    repos = [{ name: 'repo', path: '/repo', active: true }],
    branchRow = 50,
  }: {
    repos?: { name: string; path: string; active: boolean }[];
    branchRow?: number | null;
  } = {}) {
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    send.mockImplementation(async (method: string, params?: unknown) => {
      switch (method) {
        case 'ping.hello': return { ok: true };
        case 'repo.list': return { repos };
        case 'repo.switch': {
          const path = (params as { path: string }).path;
          return { name: repos.find(repo => repo.path === path)?.name ?? '', path };
        }
        case 'ui.openSubmodule': {
          const path = (params as { path: string }).path;
          return { success: true, name: path.split('/').pop() ?? path, path };
        }
        case 'git.branches': return [branch];
        case 'git.tags': return [{ name: 'v1.0.0', hash: 'b'.repeat(40), message: null, taggerDate: null }];
        case 'git.stashList': return [{ index: 2, message: 'save work', date: '2026-08-23', branch: 'main', hash: 'c'.repeat(40) }];
        case 'git.worktreeList': return [
          { path: '/repo', head: 'd'.repeat(40), branch: 'main', bare: false, isMain: true },
          { path: '/repo/feature', head: 'e'.repeat(40), branch: 'feature', bare: false, isMain: false },
        ];
        case 'git.submoduleList': return [
          { name: 'sdk', path: 'packages/sdk', head: 'f'.repeat(40), state: 'initialized' },
        ];
        case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
        case 'graph.build': return { totalRows: 100, maxLane: 0, layoutVersion: 1 };
        case 'graph.getWindow': {
          const startRow = (params as { startRow: number }).startRow;
          const endRow = Math.min(startRow + 59, 100);
          return {
            nodes: startRow <= branchHeadNode.row && branchHeadNode.row < endRow
              ? [branchHeadNode]
              : [],
            edges: [],
            startRow,
            endRow,
            totalRows: 100,
            maxLane: 0,
          };
        }
        case 'graph.getRow': return { row: branchRow };
        default: return undefined;
      }
    });
    vi.resetModules();
    const { default: App } = await import('../../src/webview/App.svelte');
    const rendered = render(App);
    await waitFor(() => expect(rendered.getByRole('button', { name: 'main' })).toBeInTheDocument());
    return rendered;
  }

  it('routes tag checkout, stash apply, worktree opening, and submodule opening through their established RPCs', async () => {
    const { container, getByRole } = await renderApp();

    // Only LOCAL opens by default, so these sections need the same click a
    // user makes before their rows exist.
    for (const title of ['TAGS', 'STASHES', 'WORKTREES', 'SUBMODULES']) {
      const header = [...container.querySelectorAll('.section-header')]
        .find((candidate) => candidate.textContent?.includes(title));
      if (header) await fireEvent.click(header);
    }

    await fireEvent.click(getByRole('button', { name: /v1\.0\.0/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('git.checkout', { ref: 'v1.0.0' }));
    await waitFor(() => expect(container.querySelector('.mutation-progress')).toBeNull());

    await fireEvent.click(getByRole('button', { name: /save work/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('git.stashApply', { index: 2 }));
    await waitFor(() => expect(container.querySelector('.mutation-progress')).toBeNull());

    await fireEvent.click(getByRole('button', { name: /worktree feature/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openFolder', { path: '/repo/feature' }));

    await fireEvent.click(getByRole('button', { name: /submodule sdk.*packages\/sdk.*initialized/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openSubmodule', { path: 'packages/sdk' }));
  });

  it('filters from the header and treats an empty selection as all branches', async () => {
    const { getByRole } = await renderApp();
    const filter = getByRole('combobox', { name: 'Filter graph by branch' });

    expect(send).toHaveBeenCalledWith('graph.build', { all: true });

    await fireEvent.change(filter, { target: { value: 'main' } });
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'graph.build',
      { branch: 'main', all: false },
    ));

    const buildCountAfterFiltering = send.mock.calls.filter(([method]) => method === 'graph.build').length;
    await fireEvent.change(filter, { target: { value: '' } });

    await waitFor(() => {
      const buildCalls = send.mock.calls.filter(([method]) => method === 'graph.build');
      expect(buildCalls.length).toBeGreaterThan(buildCountAfterFiltering);
      expect(buildCalls.at(-1)).toEqual(['graph.build', { all: true }]);
    });
  });

  it('moves to a branch HEAD, brightly highlights it for 300ms, and does not rebuild', async () => {
    const { container, getByRole } = await renderApp();
    const buildCount = send.mock.calls.filter(([method]) => method === 'graph.build').length;
    const headRow = container.querySelector('.commit-row') as HTMLElement;

    expect(headRow).not.toHaveClass('branch-focused');

    await fireEvent.click(getByRole('button', { name: 'main' }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('graph.getRow', {
        hash: branch.hash,
        layoutVersion: 1,
      });
      expect((container.querySelector('.scroll-area') as HTMLElement).scrollTop).toBeGreaterThan(0);
      expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'true');
      expect(headRow).toHaveClass('branch-focused');
    });
    expect(send.mock.calls.filter(([method]) => method === 'graph.build')).toHaveLength(buildCount);
    expect(send).not.toHaveBeenCalledWith('git.show', expect.anything());

    await new Promise(resolve => setTimeout(resolve, 350));
    expect(headRow).not.toHaveClass('branch-focused');
    expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reloads the graph after double-click checkout switches the active branch', async () => {
    const { getByRole } = await renderApp();
    const buildCount = send.mock.calls.filter(([method]) => method === 'graph.build').length;

    await fireEvent.dblClick(getByRole('button', { name: 'main' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.checkout', { ref: 'main' }));
    await waitFor(() => expect(
      send.mock.calls.filter(([method]) => method === 'graph.build').length,
    ).toBeGreaterThan(buildCount));
  });

  it('ignores a branch HEAD that is absent from the current graph', async () => {
    const { container, getByRole } = await renderApp({ branchRow: null });
    const scrollArea = container.querySelector('.scroll-area') as HTMLElement;
    scrollArea.scrollTop = 64;

    await fireEvent.click(getByRole('button', { name: 'main' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getRow', {
      hash: branch.hash,
      layoutVersion: 1,
    }));

    expect(scrollArea.scrollTop).toBe(64);
    expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears the branch filter when switching repositories', async () => {
    const repos = [
      { name: 'repo', path: '/repo', active: true },
      { name: 'repo-two', path: '/repo-two', active: false },
    ];
    const { getByRole } = await renderApp({ repos });

    await fireEvent.change(
      getByRole('combobox', { name: 'Filter graph by branch' }),
      { target: { value: 'main' } },
    );
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'graph.build',
      { branch: 'main', all: false },
    ));

    const buildCount = send.mock.calls.filter(([method]) => method === 'graph.build').length;
    await fireEvent.change(
      getByRole('combobox', { name: 'Repository' }),
      { target: { value: 'repo:/repo-two' } },
    );

    await waitFor(() => {
      const buildCalls = send.mock.calls.filter(([method]) => method === 'graph.build');
      expect(send).toHaveBeenCalledWith('repo.switch', { path: '/repo-two' });
      expect(buildCalls.length).toBeGreaterThan(buildCount);
      expect(buildCalls.at(-1)).toEqual(['graph.build', { all: true }]);
      expect(getByRole('combobox', { name: 'Filter graph by branch' })).toHaveValue('');
    });
  });
});

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

describe('App sidebar primary actions', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  async function renderApp(repos = [{ name: 'repo', path: '/repo', active: true }]) {
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    send.mockImplementation(async (method: string, params?: unknown) => {
      switch (method) {
        case 'ping.hello': return { ok: true };
        case 'repo.list': return { repos };
        case 'repo.switch': {
          const path = (params as { path: string }).path;
          return { name: repos.find(repo => repo.path === path)?.name ?? '' };
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
        case 'graph.build': return { totalRows: 1, maxLane: 0, layoutVersion: 1 };
        case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 1, maxLane: 0 };
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

  it('filters the graph by a clicked branch and clears the filter when clicked again', async () => {
    const { getByRole } = await renderApp();
    const branchRow = getByRole('button', { name: 'main' });

    expect(send).toHaveBeenCalledWith('graph.build', { all: true });

    await fireEvent.click(branchRow);
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('graph.build', { branch: 'main', all: false });
      expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'true');
    });

    const buildCountAfterFiltering = send.mock.calls.filter(([method]) => method === 'graph.build').length;
    await fireEvent.click(getByRole('button', { name: 'main' }));

    await waitFor(() => {
      const buildCalls = send.mock.calls.filter(([method]) => method === 'graph.build');
      expect(buildCalls.length).toBeGreaterThan(buildCountAfterFiltering);
      expect(buildCalls.at(-1)).toEqual(['graph.build', { all: true }]);
      expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('clears the branch filter when switching repositories', async () => {
    const repos = [
      { name: 'repo', path: '/repo', active: true },
      { name: 'repo-two', path: '/repo-two', active: false },
    ];
    const { getByRole } = await renderApp(repos);

    await fireEvent.click(getByRole('button', { name: 'main' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'graph.build',
      { branch: 'main', all: false },
    ));

    const buildCount = send.mock.calls.filter(([method]) => method === 'graph.build').length;
    await fireEvent.change(getByRole('combobox'), { target: { value: '/repo-two' } });

    await waitFor(() => {
      const buildCalls = send.mock.calls.filter(([method]) => method === 'graph.build');
      expect(send).toHaveBeenCalledWith('repo.switch', { path: '/repo-two' });
      expect(buildCalls.length).toBeGreaterThan(buildCount);
      expect(buildCalls.at(-1)).toEqual(['graph.build', { all: true }]);
      expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-pressed', 'false');
    });
  });
});

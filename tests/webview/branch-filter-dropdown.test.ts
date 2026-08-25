import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function branchEntry(name: string, index: number) {
  return {
    name,
    current: index === 0,
    hash: String(index).repeat(40),
    remote: name.includes('/') && name.startsWith('origin/') ? 'origin' : null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}

interface RenderOptions {
  branches?: string[];
  totalRows?: number;
  /** Runs before every `graph.build` reply; throw to fail that build. */
  onBuild?: (params: unknown) => void;
}

function stubBridge(options: RenderOptions = {}) {
  const names = options.branches ?? ['main'];
  const totalRows = options.totalRows ?? 7;

  send.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return names.map(branchEntry);
      case 'git.tags':
      case 'git.stashList':
      case 'git.worktreeList':
      case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build':
        options.onBuild?.(params);
        return { totalRows, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow':
        return { nodes: [], edges: [], startRow: 0, endRow: 0, totalRows, maxLane: 0 };
      default: return null;
    }
  });
}

async function renderApp(options: RenderOptions = {}) {
  stubBridge(options);
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  const result = render(App);
  await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', expect.anything()));
  await waitFor(() => expect(result.getByLabelText('Filter graph by branch')).toBeTruthy());
  return { ...result, send };
}

/** Opens the dropdown and ticks each name, leaving the menu open. */
async function selectBranches(names: string[], options: RenderOptions = {}) {
  const result = await renderApp({
    branches: options.branches ?? ['main', 'develop', 'feature/x'],
    ...options,
  });

  await fireEvent.click(result.getByLabelText('Filter graph by branch'));
  for (const name of names) {
    await fireEvent.click(result.getByRole('checkbox', { name }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      'graph.build',
      expect.objectContaining({ all: false }),
    ));
  }
  return result;
}

describe('branch filter dropdown', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('starts on All branches and builds the graph unfiltered', async () => {
    const { getByLabelText } = await renderApp();
    expect(getByLabelText('Filter graph by branch').textContent).toContain('All branches');
    expect(send).toHaveBeenCalledWith('graph.build', { all: true });
  });

  it('sends every checked branch to graph.build', async () => {
    const { getByLabelText, getByRole } = await renderApp({
      branches: ['main', 'develop', 'feature/x'],
    });

    await fireEvent.click(getByLabelText('Filter graph by branch'));
    await fireEvent.click(getByRole('checkbox', { name: 'develop' }));
    await fireEvent.click(getByRole('checkbox', { name: 'feature/x' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', {
      branches: ['develop', 'feature/x'], all: false,
    }));
  });

  it('summarises a multi-branch selection on the trigger and in the status', async () => {
    const { getByLabelText, container } = await selectBranches(['develop', 'feature/x']);
    expect(getByLabelText('Filter graph by branch').textContent).toContain('2 branches');
    // The status is painted after the follow-up window request settles, so it
    // lands a tick or two behind the trigger label.
    await waitFor(() => expect(container.querySelector('.status')!.textContent)
      .toContain('commits on 2 branches'));
  });

  it('clears back to all branches', async () => {
    const { getByRole } = await selectBranches(['develop']);
    await fireEvent.click(getByRole('button', { name: 'Clear All' }));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith('graph.build', { all: true }));
  });

  it('filters the branch list inside the dropdown', async () => {
    const { getByLabelText, getByPlaceholderText, queryByRole } = await renderApp({
      branches: ['main', 'develop', 'feature/x'],
    });

    await fireEvent.click(getByLabelText('Filter graph by branch'));
    await fireEvent.input(getByPlaceholderText('Filter branches'), { target: { value: 'feat' } });

    expect(queryByRole('checkbox', { name: 'feature/x' })).not.toBeNull();
    expect(queryByRole('checkbox', { name: 'main' })).toBeNull();
  });

  it('closes on Escape', async () => {
    const { getByLabelText, queryByPlaceholderText } = await renderApp();
    const trigger = getByLabelText('Filter graph by branch');

    await fireEvent.click(trigger);
    await fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(queryByPlaceholderText('Filter branches')).toBeNull();
  });

  it('keeps a remote branch as a real ref and titles the trigger with it', async () => {
    // The checkbox list stores names exactly as `branches` reports them, because
    // that is what `graph.build` has to resolve. A long remote ref would blow
    // out the toolbar, so the trigger ellipsises and carries the full text in
    // its tooltip instead of being shortened.
    const { getByLabelText } = await selectBranches(['origin/feature/x'], {
      branches: ['main', 'origin/feature/x'],
    });
    const trigger = getByLabelText('Filter graph by branch');

    expect(send).toHaveBeenCalledWith('graph.build', {
      branches: ['origin/feature/x'], all: false,
    });
    expect(trigger.textContent).toContain('origin/feature/x');
    expect(trigger.querySelector('.branch-filter-label')).toHaveAttribute('title', 'origin/feature/x');
  });

  it('falls back to all branches when the filtered refs stop resolving', async () => {
    // Deleting the branch you filtered by used to leave a stale graph and a
    // console warning; the user needs the graph back plus a reason.
    let filterIsDead = false;
    const { container, getByLabelText, getByRole } = await selectBranches(['develop'], {
      branches: ['main', 'develop'],
      onBuild: (params) => {
        if (filterIsDead && (params as { all?: boolean }).all === false) {
          throw Object.assign(
            new Error('None of the requested branches could be resolved: develop'),
            { kind: 'BRANCH_FILTER_UNRESOLVED' },
          );
        }
      },
    });

    filterIsDead = true;
    await fireEvent.click(getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(send).toHaveBeenLastCalledWith('graph.build', { all: true }));
    expect(container.querySelector('.error-banner')!.textContent).toContain('showing all branches');
    expect(getByLabelText('Filter graph by branch').textContent).toContain('All branches');
  });
});

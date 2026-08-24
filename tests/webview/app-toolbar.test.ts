import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branch = {
  name: 'main',
  current: true,
  hash: 'a'.repeat(40),
  remote: null,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
};

function stubBridge(overrides: Record<string, unknown> = {}) {
  send.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'git-graph', path: '/repo', active: true }] };
      case 'git.branches': return [branch];
      case 'git.tags': return [];
      case 'git.stashList': return [];
      case 'git.worktreeList': return [];
      case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      default: return null;
    }
  });
}

async function renderApp(overrides: Record<string, unknown> = {}) {
  stubBridge(overrides);
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  const result = render(App);
  await waitFor(() => expect(send).toHaveBeenCalledWith('repo.list'));
  return result;
}

describe('App toolbar', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('drops the redundant title heading', async () => {
    const { queryByRole } = await renderApp();

    expect(queryByRole('heading')).toBeNull();
  });

  it('draws the sidebar toggle as an icon button reflecting its pressed state', async () => {
    const { getByRole } = await renderApp();
    const toggle = getByRole('button', { name: 'Toggle branches panel' });

    expect(toggle.querySelector('svg')).toBeTruthy();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers a refresh action in the toolbar', async () => {
    const { getByRole } = await renderApp();
    const refresh = getByRole('button', { name: 'Refresh' });

    expect(refresh.querySelector('svg')).toBeTruthy();
  });

  it('keeps the repository name and branch filter reachable', async () => {
    const { getByLabelText, findByText } = await renderApp();

    expect(await findByText('git-graph')).toBeTruthy();
    expect(getByLabelText('Filter graph by branch')).toBeTruthy();
  });

  it('sizes toolbar glyphs on the 16px grid', async () => {
    const { container } = await renderApp();
    const glyphs = [...container.querySelectorAll('.toolbar svg')];

    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute('width')).toBe('16');
    }
  });

  it('offers submodules alongside repositories and opens them by switching', async () => {
    const { getByRole } = await renderApp({
      'git.submoduleList': [
        { name: 'sdk', path: 'packages/sdk', head: 'b'.repeat(40), state: 'initialized' },
        { name: 'legacy', path: 'vendor/legacy', head: null, state: 'uninitialized' },
      ],
    });

    const select = await waitFor(() => getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement);
    const values = Array.from(select.options).map((option) => option.value);

    expect(values).toEqual(['repo:/repo', 'submodule:packages/sdk']);

    await fireEvent.change(select, { target: { value: 'submodule:packages/sdk' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openSubmodule', { path: 'packages/sdk' }));
  });
});

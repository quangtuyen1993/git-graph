import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

const branch = {
  name: 'main', current: true, hash: 'a'.repeat(40),
  remote: null, upstream: null, ahead: 0, behind: 0,
};

async function renderApp(stored: string[] | null = null) {
  const state = new Map<string, unknown>();
  if (stored) state.set('favourites:/repo', stored);

  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    const p = (params ?? {}) as { key?: string; value?: unknown };
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }], submodules: [] };
      case 'git.branches': return [branch];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      case 'ui.getState': return state.get(p.key as string) ?? null;
      case 'ui.setState': state.set(p.key as string, p.value); return { success: true };
      default: return null;
    }
  });

  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  const rendered = render(App);
  await waitFor(() => expect(rendered.container.querySelector('.branch-item')).toBeTruthy(), { timeout: 5000 });
  return { ...rendered, state };
}

describe('App branch favourites', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

  it('persists a star under a key scoped to the active repository', async () => {
    const { container, state } = await renderApp();

    await fireEvent.click(container.querySelector('.favourite')!);

    await waitFor(() => expect(state.get('favourites:/repo')).toEqual(['main']));
  });

  it('restores stars saved for that repository on load', async () => {
    const { container } = await renderApp(['main']);

    await waitFor(() => expect(container.querySelector('.favourite.is-favourite')).toBeTruthy());
  });

  it('does not read another repository\'s starred list', async () => {
    const { container } = await renderApp();
    // Only `favourites:/repo` was ever written; a global key would leak here.
    expect(send).not.toHaveBeenCalledWith('ui.getState', { key: 'favourites' });
    expect(container.querySelector('.favourite.is-favourite')).toBeNull();
  });

  it('removes the star again on a second click', async () => {
    const { container, state } = await renderApp(['main']);
    await waitFor(() => expect(container.querySelector('.favourite.is-favourite')).toBeTruthy());

    await fireEvent.click(container.querySelector('.favourite')!);

    await waitFor(() => expect(state.get('favourites:/repo')).toEqual([]));
  });
});

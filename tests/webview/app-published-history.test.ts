import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/webview/App.svelte';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

describe('App published-history confirmation flow', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it.skip('cancels rewording of a published commit when confirmation is declined', async () => {
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    send.mockImplementation(async (method: string) => {
      switch (method) {
        case 'ping.hello': return { ok: true };
        case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
        case 'git.branches': case 'git.tags': case 'git.stashList': case 'git.worktreeList': return [];
        case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
        case 'graph.build': return { totalRows: 1, maxLane: 0 };
        case 'graph.getWindow': return { nodes: [{ hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'old', author: 'A', authorEmail: 'a@e', authorDate: new Date().toISOString(), refs: [], parents: [], lane: 0, row: 0, color: 0 }], edges: [], startRow: 0, endRow: 1, totalRows: 1, maxLane: 0 };
        case 'git.isOnCurrentBranch': return { onBranch: true };
        case 'git.show': return { commit: { message: 'old', subject: 'old' }, files: [] };
        case 'ui.inputBox': return 'new message';
        case 'git.isPublished': return { published: true };
        case 'ui.confirm': return false;
        default: return undefined;
      }
    });
    const { container, getByRole } = render(App);
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getWindow', expect.anything()));
    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy(), { timeout: 5000 });
    await fireEvent.contextMenu(container.querySelector('.commit-row')!, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(getByRole('menuitem', { name: 'Reword message...' })).toBeEnabled());
    await fireEvent.click(getByRole('menuitem', { name: 'Reword message...' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.confirm', expect.anything()));
    expect(send).not.toHaveBeenCalledWith('git.reword', expect.anything());
  });
});

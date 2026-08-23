import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('App mutation progress', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  async function renderRewordApp() {
    const input = deferred<string | null>();
    const confirm = deferred<boolean>();
    const reword = deferred<void>();
    const postMutationBranches = deferred<[]>();
    let branchRequests = 0;

    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    send.mockImplementation((method: string) => {
      switch (method) {
        case 'ping.hello': return Promise.resolve({ ok: true });
        case 'repo.list': return Promise.resolve({ repos: [{ name: 'repo', path: '/repo', active: true }] });
        case 'git.branches':
          branchRequests += 1;
          return branchRequests > 1 ? postMutationBranches.promise : Promise.resolve([]);
        case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return Promise.resolve([]);
        case 'git.status': return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
        case 'graph.build': return Promise.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });
        case 'graph.getWindow': return Promise.resolve({
          nodes: [{ hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'old', author: 'A', authorEmail: 'a@e', authorDate: new Date().toISOString(), refs: [], parents: [], lane: 0, row: 0, color: 0 }],
          edges: [], startRow: 0, endRow: 1, totalRows: 1, maxLane: 0,
        });
        case 'git.isOnCurrentBranch': return Promise.resolve({ onBranch: true });
        case 'git.show': return Promise.resolve({ commit: { message: 'old', subject: 'old' }, files: [] });
        case 'ui.inputBox': return input.promise;
        case 'git.isPublished': return Promise.resolve({ published: true });
        case 'ui.confirm': return confirm.promise;
        case 'git.reword': return reword.promise;
        default: return Promise.resolve(undefined);
      }
    });

    vi.resetModules();
    const { default: App } = await import('../../src/webview/App.svelte');
    const rendered = render(App);
    await waitFor(() => expect(rendered.container.querySelector('.commit-row')).toBeTruthy());
    await fireEvent.contextMenu(rendered.container.querySelector('.commit-row')!, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Reword message...' })).toBeEnabled());
    await fireEvent.click(rendered.getByRole('menuitem', { name: 'Reword message...' }));
    return { ...rendered, input, confirm, reword, postMutationBranches, branchRequests: () => branchRequests };
  }

  function progress(container: HTMLElement) {
    return container.querySelector<HTMLElement>('[aria-live="polite"]');
  }

  it('announces preparation and confirmation without announcing a cancelled reword as running', async () => {
    const app = await renderRewordApp();

    await waitFor(() => expect(progress(app.container)).toHaveTextContent('Preparing…'));
    app.input.resolve('new message');
    await waitFor(() => expect(progress(app.container)).toHaveTextContent('Awaiting confirmation…'));
    app.confirm.resolve(false);

    await waitFor(() => expect(progress(app.container)).toBeNull());
    expect(send).not.toHaveBeenCalledWith('git.reword', expect.anything());
  });

  it('switches to the mutation label only for the Git RPC and clears it before refresh completes', async () => {
    const app = await renderRewordApp();

    await waitFor(() => expect(progress(app.container)).toHaveTextContent('Preparing…'));
    app.input.resolve('new message');
    await waitFor(() => expect(progress(app.container)).toHaveTextContent('Awaiting confirmation…'));
    app.confirm.resolve(true);
    await waitFor(() => expect(progress(app.container)).toHaveTextContent('Rewording commit…'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('git.reword', {
      hash: 'a'.repeat(40),
      message: 'new message',
    }));

    app.reword.resolve();
    await waitFor(() => expect(app.branchRequests()).toBeGreaterThan(1));
    await waitFor(() => expect(progress(app.container)).toBeNull());
    app.postMutationBranches.resolve([]);
  });
});

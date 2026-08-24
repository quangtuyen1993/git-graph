import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

const branch = {
  name: 'crea',
  current: false,
  hash: 'a'.repeat(40),
  remote: null,
  upstream: null as string | null,
  ahead: 0,
  behind: 0,
};

function notFullyMerged(): Error & { kind: string } {
  const error = new Error('Branch "crea" is not fully merged') as Error & { kind: string };
  error.kind = 'BRANCH_NOT_FULLY_MERGED';
  return error;
}

/**
 * @param upstream  whether the branch tracks a remote
 * @param answers   queued replies for successive ui.confirm dialogs
 * @param deleteFails whether the first git.deleteBranch rejects as unmerged
 */
async function renderApp(
  { upstream = null as string | null, answers = [] as unknown[], deleteFails = false } = {},
) {
  const queued = [...answers];
  let deleteCalls = 0;

  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }], submodules: [] };
      case 'git.branches': return [{ ...branch, upstream }];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      case 'ui.confirm': return queued.shift() ?? null;
      case 'git.deleteBranch': {
        deleteCalls += 1;
        const force = (params as { force?: boolean }).force;
        if (deleteFails && !force) throw notFullyMerged();
        return { success: true };
      }
      default: return null;
    }
  });

  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  const rendered = render(App);
  const { container, getByRole } = rendered;

  await waitFor(() => expect(container.querySelector('.branch-item')).toBeTruthy(), { timeout: 5000 });
  await fireEvent.contextMenu(container.querySelector('.branch-item')!, { clientX: 10, clientY: 10 });
  await waitFor(() => expect(getByRole('menuitem', { name: 'Delete branch...' })).toBeEnabled());
  await fireEvent.click(getByRole('menuitem', { name: 'Delete branch...' }));

  return { ...rendered, deleteCalls: () => deleteCalls };
}

describe('App delete branch flow', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

  it('offers a single delete entry rather than a separate remote variant', async () => {
    const { queryByRole } = await renderApp({ upstream: 'origin/crea', answers: [null] });

    expect(queryByRole('menuitem', { name: 'Delete branch + remote' })).toBeNull();
  });

  it('asks whether to delete the remote when the branch tracks one', async () => {
    await renderApp({ upstream: 'origin/crea', answers: ['Delete local'] });

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.confirm', expect.objectContaining({
      choices: ['Delete local', 'Delete local + remote'],
    })));
  });

  it('does not offer the remote choice for a branch that tracks nothing', async () => {
    await renderApp({ upstream: null, answers: [true] });

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.deleteBranch', { name: 'crea' }));
    const confirmCalls = send.mock.calls.filter(([method]) => method === 'ui.confirm');
    expect(confirmCalls.every(([, params]) => !(params as { choices?: unknown }).choices)).toBe(true);
  });

  it('deletes the remote too when that choice is taken', async () => {
    await renderApp({ upstream: 'origin/crea', answers: ['Delete local + remote'] });

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.push', { remote: 'origin', branch: ':crea' }));
  });

  it('offers a force delete instead of dead-ending on an unmerged branch', async () => {
    await renderApp({ upstream: null, answers: [true, 'Force delete'], deleteFails: true });

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.deleteBranch', { name: 'crea', force: true }));
  });

  it('leaves the branch alone when the force prompt is declined', async () => {
    const { deleteCalls } = await renderApp({ upstream: null, answers: [true, null], deleteFails: true });

    await waitFor(() => expect(deleteCalls()).toBe(1));
    expect(send).not.toHaveBeenCalledWith('git.deleteBranch', { name: 'crea', force: true });
  });

  it('does not push a remote deletion when the forced local delete is declined', async () => {
    await renderApp({ upstream: 'origin/crea', answers: ['Delete local + remote', null], deleteFails: true });

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.confirm', expect.objectContaining({
      choices: ['Force delete'],
    })));
    expect(send).not.toHaveBeenCalledWith('git.push', expect.anything());
  });
});

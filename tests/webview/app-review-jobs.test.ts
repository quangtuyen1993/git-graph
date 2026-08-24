import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function stub() {
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      case 'review.start': return { id: 'rev-1', cached: false };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('App review jobs', () => {
  it('never calls the removed blocking ai.review method', async () => {
    stub();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    render(App);
    await waitFor(() => expect(send).toHaveBeenCalledWith('repo.list'));

    expect(send.mock.calls.map(c => c[0])).not.toContain('ai.review');
  });

  it('subscribes to review.changed so a finished run can surface', async () => {
    stub();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    render(App);

    await waitFor(() => expect(on.mock.calls.map(c => c[0])).toContain('review.changed'));
  });
});

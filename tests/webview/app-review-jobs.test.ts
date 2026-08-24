import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
  { name: 'feature', current: false, hash: 'b'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
];
const nodes = [
  { hash: SHA_1, abbreviatedHash: SHA_1.slice(0, 7), subject: 'first', author: 'a', authorEmail: '',
    authorDate: '2026-08-24T00:00:00.000Z', refs: [], row: 0, lane: 0, color: 0, parents: [] },
  { hash: SHA_2, abbreviatedHash: SHA_2.slice(0, 7), subject: 'second', author: 'a', authorEmail: '',
    authorDate: '2026-08-24T00:00:00.000Z', refs: [], row: 1, lane: 0, color: 0, parents: [] },
];

function stubApp() {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'git.isOnCurrentBranch': return { onBranch: false };
      case 'graph.build': return { totalRows: 2, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes, edges: [], startRow: 0, endRow: 2, maxLane: 0, layoutVersion: 1 };
      case 'review.setTarget': return { success: true };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

async function contextMenuOnCommit(rendered: ReturnType<typeof render>, subject: string) {
  await waitFor(() => expect(rendered.getByText(subject)).toBeInTheDocument());
  await fireEvent.contextMenu(rendered.getByText(subject));
}

describe('review entry points from the graph', () => {
  it('branch context "Compare with..." sends review.setTarget with base=clicked, head=current', async () => {
    stubApp();
    const rendered = render(App);
    await waitFor(() => expect(rendered.getByRole('button', { name: 'feature' })).toBeInTheDocument());

    // Shift+F10 opens the context menu via keyboard — the suite's established
    // pattern for branch rows (see tests/webview/app-sidebar-actions.test.ts).
    await fireEvent.keyDown(rendered.getByRole('button', { name: 'feature' }), { key: 'F10', shiftKey: true });
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Compare with...' })).toBeInTheDocument());
    await fireEvent.click(rendered.getByRole('menuitem', { name: 'Compare with...' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'branch', baseRef: 'feature', headRef: 'main',
    }));
  });

  it('"Review this commit" sends a commit target', async () => {
    stubApp();
    const rendered = render(App);
    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Review this commit' })).toBeInTheDocument());

    await fireEvent.click(rendered.getByRole('menuitem', { name: 'Review this commit' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'commit', headRef: SHA_1,
    }));
  });

  it('select-then-compare sends a range target and clears the selection', async () => {
    stubApp();
    const rendered = render(App);

    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Select for compare' })).toBeInTheDocument());
    await fireEvent.click(rendered.getByRole('menuitem', { name: 'Select for compare' }));

    await contextMenuOnCommit(rendered, 'second');
    const label = `Compare with selected ${SHA_1.slice(0, 7)}`;
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: label })).toBeInTheDocument());
    await fireEvent.click(rendered.getByRole('menuitem', { name: label }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'range', baseRef: SHA_1, headRef: SHA_2,
    }));

    // Once the pair has been sent the marker is cleared: the commit menu goes
    // back to offering "Select for compare".
    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Select for compare' })).toBeInTheDocument());
  });

  it('"Review with selected" sends a range target using the previously selected commit', async () => {
    stubApp();
    const rendered = render(App);

    // First: select a commit for compare via right-click
    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Select for compare' })).toBeInTheDocument());
    await fireEvent.click(rendered.getByRole('menuitem', { name: 'Select for compare' }));

    // Second: right-click another commit — "Review with selected" should appear
    await contextMenuOnCommit(rendered, 'second');
    const label = `Review with selected ${SHA_1.slice(0, 7)}`;
    await waitFor(() => expect(rendered.getByRole('menuitem', { name: label })).toBeInTheDocument());
    await fireEvent.click(rendered.getByRole('menuitem', { name: label }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'range', baseRef: SHA_1, headRef: SHA_2,
    }));
  });
});

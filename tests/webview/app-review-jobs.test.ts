import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
  { name: 'feature', current: false, hash: 'b'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
];

function stub(reviewStartResult: { id: string; cached: boolean } = { id: 'rev-1', cached: false }) {
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      case 'ai.compare': return { files: [] };
      case 'review.start': return reviewStartResult;
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

// Drives the real path a user takes to reach the review button: right-click a
// non-current branch (Shift+F10, same as the existing branch-sidebar keyboard
// context-menu tests), choose "Compare with...", then wait for the review
// panel to mount with both branches wired up and a provider auto-selected so
// the "Review Changes" button is actually clickable. No internals are reached
// into — every step goes through a real DOM event, the same way BranchSidebar
// and ContextMenu are already exercised elsewhere in this suite.
async function openReviewPanel() {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  const rendered = render(App);
  await waitFor(() => expect(rendered.getByRole('button', { name: 'feature' })).toBeInTheDocument());

  await fireEvent.keyDown(rendered.getByRole('button', { name: 'feature' }), { key: 'F10', shiftKey: true });
  await waitFor(() => expect(rendered.getByRole('menuitem', { name: 'Compare with...' })).toBeInTheDocument());
  await fireEvent.click(rendered.getByRole('menuitem', { name: 'Compare with...' }));

  await waitFor(() => expect(rendered.getByRole('button', { name: /Review Changes/ })).toBeEnabled());
  return rendered;
}

describe('App review jobs', () => {
  it('drives the real review UI flow into review.start and never the removed blocking ai.review', async () => {
    stub({ id: 'rev-1', cached: false });
    const { getByRole } = await openReviewPanel();
    const reviewButton = getByRole('button', { name: /Review Changes/ });

    await fireEvent.click(reviewButton);

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.start', {
      kind: 'branch',
      baseRef: 'feature',
      headRef: 'main',
      provider: 'claude',
      model: 'default',
    }));
    expect(send.mock.calls.map(c => c[0])).not.toContain('ai.review');
    expect(send.mock.calls.map(c => c[0])).not.toContain('ai.reviewDiff');
    // Loading kicked in for the still-running job (proves the click actually
    // did something rather than the assertion above being vacuously true).
    expect(reviewButton).toHaveTextContent(/Reviewing/);
  });

  it('subscribes to review.changed so a finished run can surface', async () => {
    stub();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    render(App);

    await waitFor(() => expect(on.mock.calls.map(c => c[0])).toContain('review.changed'));
  });

  it('clears loading immediately on a cache hit, since no review.changed will ever fire for it', async () => {
    stub({ id: 'rev-cached', cached: true });
    const { getByRole } = await openReviewPanel();
    const reviewButton = getByRole('button', { name: /Review Changes/ });

    await fireEvent.click(reviewButton);

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.start', expect.objectContaining({
      kind: 'branch',
      baseRef: 'feature',
      headRef: 'main',
    })));
    // A cache hit short-circuits on the host with no status transition, so
    // review.changed is never emitted for this id (the mocked `on` here never
    // invokes its callback either way). If aiReviewLoading could only be
    // cleared by that event, the button would say "Reviewing..." forever.
    await waitFor(() => expect(reviewButton).toHaveTextContent('🤖 Review Changes'));
    expect(reviewButton).toBeEnabled();
  });
});

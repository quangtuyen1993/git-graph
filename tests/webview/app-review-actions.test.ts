import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
];

const commitNode = {
  hash: 'f'.repeat(40), abbreviatedHash: 'fffffff', subject: 'Fix bug',
  author: 'A', authorEmail: 'a@e', authorDate: new Date().toISOString(),
  refs: [], parents: [], lane: 0, row: 0, color: 0,
};

const reviewEntry = {
  id: 'branch..develop..feature-x.claude.claude-opus-5',
  kind: 'branch' as const,
  baseRef: 'develop', baseSha: 'b'.repeat(40),
  headRef: 'feature/x', headSha: 'c'.repeat(40),
  provider: 'Claude', model: 'claude-opus-5',
  status: 'done' as const,
  startedAt: '2026-08-25T09:00:00.000Z', finishedAt: '2026-08-25T09:02:00.000Z',
};

function stubApp(overrides: Partial<Record<string, unknown>> = {}) {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    if (method in overrides) return (overrides[method] as (params?: unknown) => unknown)(params);
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 1, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return {
        nodes: [commitNode], edges: [], startRow: 0, endRow: 1, totalRows: 1, maxLane: 0,
      };
      case 'git.show': return { commit: { ...commitNode, message: 'Fix bug' }, files: [] };
      case 'forge.status': return { available: false, signedIn: false };
      case 'review.list': return [reviewEntry];
      case 'review.get': return reviewEntry;
      case 'review.body': return 'Looks good overall.';
      case 'review.compare': return { files: [] };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

// Startup settles (activeRepoName, branches, the graph) before the sidebar
// is touched: the REVIEWS header renders unconditionally on the very first
// tick, before any bridge round trip resolves, and `{#key activeRepoName}`
// remounts BranchSidebar — discarding its expand state — once repo.list
// lands. Waiting for the graph's first commit row first guarantees that
// remount has already happened.
async function waitForAppReady(rendered: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(rendered.container.querySelector('.commit-row')).toBeTruthy());
}

async function selectReview(rendered: ReturnType<typeof render>): Promise<void> {
  await waitForAppReady(rendered);
  await waitFor(() => expect(rendered.getByText('REVIEWS')).toBeInTheDocument());
  // The section may already be expanded from an earlier selection in the
  // same test — clicking the header again would collapse it back.
  if (!rendered.queryByText('develop ← feature/x')) {
    await fireEvent.click(rendered.getByText('REVIEWS'));
  }
  const row = await waitFor(() => rendered.getByText('develop ← feature/x'));
  await fireEvent.click(row.closest('button')!);
}

async function selectCommit(rendered: ReturnType<typeof render>): Promise<void> {
  await waitForAppReady(rendered);
  const row = rendered.container.querySelector('.commit-row');
  await fireEvent.click(row!);
}

describe('Selecting a review in the sidebar', () => {
  it('renders it in the detail panel', async () => {
    stubApp();
    const rendered = render(App);

    await selectReview(rendered);

    await waitFor(() => expect(rendered.getByText('Looks good overall.')).toBeInTheDocument());
    expect(rendered.getAllByText(/claude-opus-5/).length).toBeGreaterThan(0);
  });

  it('is replaced by a commit selected afterwards, and vice versa', async () => {
    stubApp();
    const rendered = render(App);

    await selectReview(rendered);
    await waitFor(() => expect(rendered.getByText('Looks good overall.')).toBeInTheDocument());

    await selectCommit(rendered);
    const panel = () => within(rendered.container.querySelector('.right-panel')!);
    await waitFor(() => expect(panel().getByText('Fix bug')).toBeInTheDocument());
    expect(rendered.queryByText('Looks good overall.')).not.toBeInTheDocument();

    await selectReview(rendered);
    await waitFor(() => expect(rendered.getByText('Looks good overall.')).toBeInTheDocument());
    expect(panel().queryByText('Fix bug')).not.toBeInTheDocument();
  });

  it('leaves a dismissible state, not a blank panel, when review.get fails', async () => {
    stubApp({ 'review.get': () => { throw new Error('Review not found on disk.'); } });
    const rendered = render(App);

    await selectReview(rendered);

    await waitFor(() => expect(
      rendered.container.querySelector('.error-banner')?.textContent,
    ).toContain('Review not found on disk.'));
    // The panel itself is left in a state the user can leave, not an empty
    // frame with no way out — CommitDetail's own empty state, with its close
    // button, is what the right panel falls back to.
    expect(rendered.getByText('Select a commit to view details')).toBeInTheDocument();
    expect(rendered.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });
});

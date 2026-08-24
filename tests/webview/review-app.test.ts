import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import ReviewApp from '../../src/webview/ReviewApp.svelte';

const SHA_B = 'b'.repeat(40);
const branches = [
  { name: 'main', current: false },
  { name: 'feat/x', current: true },
];
const doneEntry = {
  id: 'aaaaaaa..bbbbbbb.claude.default',
  kind: 'branch', baseRef: 'main', baseSha: 'a'.repeat(40),
  headRef: 'feat/x', headSha: SHA_B,
  provider: 'claude', model: 'default', status: 'done',
  startedAt: '2026-08-24T00:00:00.000Z', finishedAt: '2026-08-24T00:01:00.000Z',
};

function stub(overrides: Record<string, unknown> = {}) {
  send.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'git.branches': return branches;
      case 'ai.providers': return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      case 'ui.getState': return null;
      case 'ui.setState': return { success: true };
      case 'review.getTarget': return null;
      case 'review.list': return [];
      case 'review.compare': return { files: [
        { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
      ] };
      case 'review.start': return { id: 'new-id', cached: false };
      default: return null;
    }
  });
}

function eventHandler(name: string): (data: unknown) => void {
  const call = on.mock.calls.find(c => c[0] === name);
  expect(call, `no listener for ${name}`).toBeDefined();
  return call![1] as (data: unknown) => void;
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('ReviewApp', () => {
  it('defaults head to the current branch and base to main, then compares', async () => {
    stub();
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    const base = rendered.getByLabelText('Base branch') as HTMLSelectElement;
    const head = rendered.getByLabelText('Head branch') as HTMLSelectElement;
    expect(base.value).toBe('main');
    expect(head.value).toBe('feat/x');
    expect(send).toHaveBeenCalledWith('review.compare',
      expect.objectContaining({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' }));
  });

  it('changing a picker re-compares with the new pair', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
    send.mockClear();

    await fireEvent.change(rendered.getByLabelText('Base branch'), { target: { value: 'feat/x' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.compare',
      expect.objectContaining({ baseRef: 'feat/x' })));
  });

  it('clicking a changed file opens the diff editor', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    await fireEvent.click(rendered.getByText('src/a.ts'));

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.compareDiff', {
      sourceBranch: 'main', targetBranch: 'feat/x',
      path: 'src/a.ts', oldPath: null, status: 'modified',
    }));
  });

  it('Review button starts a review with the current target', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    await fireEvent.click(rendered.getByRole('button', { name: 'Review' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: '',
    }));
  });

  it('a review.target event for a commit swaps the pickers for a chip', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());

    eventHandler('review.target')({
      kind: 'commit', baseRef: 'c'.repeat(40), headRef: SHA_B, subject: 'fix: y',
    });

    await waitFor(() => expect(rendered.getByText(`${SHA_B.slice(0, 7)} "fix: y"`)).toBeInTheDocument());
    expect(rendered.queryByLabelText('Base branch')).toBeNull();
    // ✕ quay về chế độ branch
    await fireEvent.click(rendered.getByRole('button', { name: 'Back to branch compare' }));
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());
  });

  it('renders review rows with kind-aware labels and a cancel button while running', async () => {
    stub({ 'review.list': [
      { ...doneEntry, id: 'r1', kind: 'commit', subject: 'fix: y', status: 'running', finishedAt: undefined },
      { ...doneEntry, id: 'r2', kind: 'range' },
    ] });
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByText(`${SHA_B.slice(0, 7)} "fix: y"`)).toBeInTheDocument());
    expect(rendered.getByText(`${'a'.repeat(7)}..${'b'.repeat(7)}`)).toBeInTheDocument();

    await fireEvent.click(rendered.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.cancel', { id: 'r1' }));
  });

  it('a review.changed event refreshes the list', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());
    stub({ 'review.list': [doneEntry] });

    eventHandler('review.changed')({ id: doneEntry.id });

    await waitFor(() => expect(rendered.getByText('main ← feat/x')).toBeInTheDocument());
  });

  it('a repo.changed event re-inits against the new repo', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
    send.mockClear();

    const newBranches = [
      { name: 'main', current: false },
      { name: 'feature/new', current: true },
    ];
    send.mockImplementation(async (method: string) => {
      switch (method) {
        case 'git.branches': return newBranches;
        case 'ai.providers': return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
        case 'ui.getState': return null;
        case 'review.getTarget': return null;
        case 'review.list': return [doneEntry];
        case 'review.compare': return { files: [
          { path: 'src/b.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false },
        ] };
        default: return null;
      }
    });

    eventHandler('repo.changed')({});

    await waitFor(() => expect(rendered.getByText('src/b.ts')).toBeInTheDocument());
    expect(send).toHaveBeenCalledWith('git.branches');
    expect(send).toHaveBeenCalledWith('review.list');
    expect(send).toHaveBeenCalledWith('review.compare',
      expect.objectContaining({ kind: 'branch', baseRef: 'main', headRef: 'feature/new' }));
    const base = rendered.getByLabelText('Base branch') as HTMLSelectElement;
    const head = rendered.getByLabelText('Head branch') as HTMLSelectElement;
    expect(head.value).toBe('feature/new');
    expect(base.value).toBe('main');
  });

  it('a range chip renders a swap button that reverses base and head', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());

    eventHandler('review.target')({ kind: 'range', baseRef: 'main', headRef: 'feat/x' });

    await waitFor(() => expect(rendered.getByText('main..feat/x')).toBeInTheDocument());
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: 'Swap base and head' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.compare',
      expect.objectContaining({ kind: 'range', baseRef: 'feat/x', headRef: 'main' })));
    await waitFor(() => expect(rendered.getByText('feat/x..main')).toBeInTheDocument());
  });

  it('a commit chip does not render a swap button', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());

    eventHandler('review.target')({
      kind: 'commit', baseRef: 'c'.repeat(40), headRef: SHA_B, subject: 'fix: y',
    });

    await waitFor(() => expect(rendered.getByText(`${SHA_B.slice(0, 7)} "fix: y"`)).toBeInTheDocument());
    expect(rendered.queryByRole('button', { name: 'Swap base and head' })).toBeNull();
  });

  it('a failed compare shows the error instead of dying silently', async () => {
    stub();
    send.mockImplementation(async (method: string) => {
      if (method === 'review.compare') throw new Error('Cannot resolve "gone"');
      if (method === 'git.branches') return branches;
      if (method === 'ai.providers') return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      if (method === 'review.list') return [];
      return null;
    });
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByRole('alert')).toHaveTextContent('Cannot resolve "gone"'));
  });
});

describe('persisted UI state', () => {
  it('saves the target when a picker changes', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
    send.mockClear();

    await fireEvent.change(rendered.getByLabelText('Base branch'), { target: { value: 'feat/x' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.saveTarget',
      expect.objectContaining({ kind: 'branch', baseRef: 'feat/x', headRef: 'feat/x' })));
  });

  it('saves the swapped pair when swap is clicked', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: 'Swap base and head' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.saveTarget',
      expect.objectContaining({ baseRef: 'feat/x', headRef: 'main' })));
  });

  it('renders the changed files as a tree when the stored view mode says so', async () => {
    stub();
    send.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'ui.getState' && (params as { key: string }).key === 'detail.viewMode') return 'tree';
      if (method === 'ui.getState') return null;
      if (method === 'git.branches') return branches;
      if (method === 'ai.providers') return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      if (method === 'review.getTarget') return null;
      if (method === 'review.list') return [];
      if (method === 'review.compare') return { files: [
        { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
      ] };
      return null;
    });
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByLabelText('Folder src')).toBeInTheDocument());
    expect(rendered.getByText('a.ts')).toBeInTheDocument();
    expect(rendered.queryByText('src/a.ts')).toBeNull(); // no flat row

    // leaf click still opens the diff editor
    await fireEvent.click(rendered.getByText('a.ts'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.compareDiff',
      expect.objectContaining({ path: 'src/a.ts' })));
  });

  it('persists a view-mode toggle to the shared detail.viewMode key', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: 'View as tree' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.setState',
      { key: 'detail.viewMode', value: 'tree' }));
    await waitFor(() => expect(rendered.getByLabelText('Folder src')).toBeInTheDocument());
  });
});

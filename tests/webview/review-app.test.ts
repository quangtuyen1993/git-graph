import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import ReviewApp from '../../src/webview/ReviewApp.svelte';

const branches = [
  { name: 'main', current: false },
  { name: 'feat/x', current: true },
];
const commits = [
  { hash: 'a'.repeat(40), abbreviatedHash: 'aaaaaaa', subject: 'First commit', authorDate: '2026-08-24T00:00:00Z' },
  { hash: 'b'.repeat(40), abbreviatedHash: 'bbbbbbb', subject: 'Second commit', authorDate: '2026-08-24T01:00:00Z' },
];
const repos = [
  { path: '/repo/one', name: 'one', active: true },
  { path: '/repo/two', name: 'two', active: false },
];
const pullRequests = [
  {
    id: 'pr-1', number: 42, title: 'Add widgets', state: 'open',
    sourceBranch: 'feat/widgets', targetBranch: 'main',
    reviewers: [
      { user: { displayName: 'Ada', accountId: 'ada' }, status: 'approved' },
      { user: { displayName: 'Bo', accountId: 'bo' }, status: 'changes_requested' },
    ],
    commentCount: 2, webUrl: 'https://example.test/pr/42', updatedAt: '2026-08-24T00:00:00Z',
  },
];

function stub(overrides: Record<string, unknown> = {}) {
  send.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'review.getRepos': return repos;
      case 'review.getCommits': return commits;
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
      case 'review.saveTarget': return { success: true };
      // No forge remote is the default fixture repo shape: absent provider,
      // no pull requests. Individual tests override to exercise PR mode.
      case 'forge.status': return { available: false };
      case 'forge.pr.list': return { pullRequests: [] };
      case 'forge.pr.files': return { files: [
        { path: 'src/widget.ts', oldPath: null, status: 'added', additions: 10, deletions: 0, binary: false },
      ] };
      default: return null;
    }
  });
}

function eventHandler(name: string): (data: unknown) => void {
  const call = on.mock.calls.find((c: unknown[]) => c[0] === name);
  expect(call, `no listener for ${name}`).toBeDefined();
  return call![1] as (data: unknown) => void;
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('ReviewApp redesign', () => {
  it('renders repo picker with repos from host', async () => {
    stub();
    const { getByLabelText } = render(ReviewApp);
    await waitFor(() => {
      const select = getByLabelText('Repository') as HTMLSelectElement;
      expect(select.options.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders mode tabs and defaults to Branches mode', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => {
      expect(getByRole('tab', { name: '1 Commit' })).toBeInTheDocument();
      expect(getByRole('tab', { name: '2 Commits' })).toBeInTheDocument();
      expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument();
      expect(getByRole('tab', { name: '2 Branches' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('Branches mode shows two comboboxes for base and head branch', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Base branch' })).toBeInTheDocument();
      expect(getByRole('combobox', { name: 'Head branch' })).toBeInTheDocument();
    });
  });

  it('switching to 1 Commit mode shows one commit combobox', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '1 Commit' })).toBeInTheDocument());
    await fireEvent.click(getByRole('tab', { name: '1 Commit' }));
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Commit' })).toBeInTheDocument();
    });
  });

  it('switching to 2 Commits mode shows two commit comboboxes', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Commits' })).toBeInTheDocument());
    await fireEvent.click(getByRole('tab', { name: '2 Commits' }));
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Base commit' })).toBeInTheDocument();
      expect(getByRole('combobox', { name: 'Head commit' })).toBeInTheDocument();
    });
  });

  it('review.target event with kind=commit switches to 1 Commit mode', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
    const targetHandler = eventHandler('review.target');
    targetHandler({ kind: 'commit', baseRef: '', headRef: 'a'.repeat(40), subject: 'First commit' });
    await waitFor(() => {
      expect(getByRole('tab', { name: '1 Commit' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('review.target event with kind=range switches to 2 Commits mode', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
    const targetHandler = eventHandler('review.target');
    targetHandler({ kind: 'range', baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40) });
    await waitFor(() => {
      expect(getByRole('tab', { name: '2 Commits' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('starts a review with current mode and inputs', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    // Default mode is branch, head=feat/x, base=main → can review
    await waitFor(() => expect(getByRole('button', { name: 'Review' })).toBeInTheDocument());
    // Wait for auto-compare to finish so button is enabled
    await waitFor(() => expect(getByRole('button', { name: 'Review' })).not.toBeDisabled());
    await fireEvent.click(getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.start', expect.objectContaining({
      kind: 'branch',
      provider: 'claude',
    })));
  });

  it('switching mode clears input values and files', async () => {
    stub();
    const { getByRole, queryByText } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
    // Wait for files to load
    await waitFor(() => expect(queryByText('src/a.ts')).toBeInTheDocument());
    // Switch to commit mode
    await fireEvent.click(getByRole('tab', { name: '1 Commit' }));
    await waitFor(() => {
      expect(getByRole('combobox', { name: 'Commit' })).toBeInTheDocument();
      // Files should be cleared
      expect(queryByText('src/a.ts')).toBeNull();
    });
  });

  it('repo picker defaults to active repo', async () => {
    stub();
    const { getByLabelText } = render(ReviewApp);
    await waitFor(() => {
      const select = getByLabelText('Repository') as HTMLSelectElement;
      expect(select.value).toBe('/repo/one');
    });
  });

  it('review.changed event refreshes the list', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
    send.mockClear();
    stub({ 'review.list': [
      { id: 'r1', kind: 'branch', baseRef: 'main', baseSha: 'a'.repeat(40), headRef: 'feat/x', headSha: 'b'.repeat(40), provider: 'claude', model: 'default', status: 'done', startedAt: '2026-08-24T00:00:00Z', finishedAt: '2026-08-24T00:01:00Z' },
    ] });
    const handler = eventHandler('review.changed');
    handler({});
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.list'));
  });

  it('repo.changed event re-inits against the new repo', async () => {
    stub();
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
    send.mockClear();
    stub();
    const handler = eventHandler('repo.changed');
    handler({});
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.getRepos'));
  });

  it('changed files pane shows file from compare results', async () => {
    stub();
    const { getByText } = render(ReviewApp);
    await waitFor(() => expect(getByText('src/a.ts')).toBeInTheDocument());
  });

  it('Review button is disabled when inputs are incomplete', async () => {
    stub({ 'git.branches': [{ name: 'main', current: false }] });
    const { getByRole } = render(ReviewApp);
    await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
    // With only one branch and no current, head should be empty
    // The button should be disabled
    await waitFor(() => {
      const btn = getByRole('button', { name: 'Review' });
      // base=main, head='' → incomplete
      expect(btn).toBeDisabled();
    });
  });

  describe('Pull Request mode', () => {
    it('does not render the mode tab when the repository has no forge provider', async () => {
      stub({ 'forge.status': { available: false } });
      const { getByRole, queryByRole } = render(ReviewApp);
      await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toBeInTheDocument());
      expect(queryByRole('tab', { name: 'Pull Request' })).toBeNull();
    });

    it('renders the mode tab and lists pull requests via forge.pr.list when a provider is present', async () => {
      stub({ 'forge.status': { available: true }, 'forge.pr.list': { pullRequests } });
      const { getByRole } = render(ReviewApp);
      await waitFor(() => expect(getByRole('tab', { name: 'Pull Request' })).toBeInTheDocument());
      await fireEvent.click(getByRole('tab', { name: 'Pull Request' }));
      await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.list'));
      const combobox = getByRole('combobox', { name: 'Pull request' });
      await fireEvent.focus(combobox);
      await waitFor(() => expect(getByRole('option', { name: /Add widgets/ })).toBeInTheDocument());
    });

    it('selecting a pull request populates the file list and reviewer chips from forge methods, not git', async () => {
      stub({ 'forge.status': { available: true }, 'forge.pr.list': { pullRequests } });
      const { getByRole, getByText } = render(ReviewApp);
      await waitFor(() => expect(getByRole('tab', { name: 'Pull Request' })).toBeInTheDocument());
      await fireEvent.click(getByRole('tab', { name: 'Pull Request' }));
      const combobox = await waitFor(() => getByRole('combobox', { name: 'Pull request' }));
      await fireEvent.focus(combobox);
      const option = await waitFor(() => getByRole('option', { name: /Add widgets/ }));
      send.mockClear();
      await fireEvent.click(option);

      await waitFor(() => expect(send).toHaveBeenCalledWith('forge.pr.files', { id: 'pr-1' }));
      expect(send).not.toHaveBeenCalledWith('review.compare', expect.anything());
      expect(send).not.toHaveBeenCalledWith('git.diff', expect.anything());

      await waitFor(() => expect(getByText('src/widget.ts')).toBeInTheDocument());
      await waitFor(() => {
        expect(getByText('✓1')).toBeInTheDocument();
        expect(getByText('✗1')).toBeInTheDocument();
      });
    });

    it('renders a pr history entry by its number and title, not a sha pair', async () => {
      stub({
        'forge.status': { available: true },
        'review.list': [{
          id: 'r-pr', kind: 'pr',
          baseRef: 'main', baseSha: 'a'.repeat(40), headRef: 'feat/widgets', headSha: 'b'.repeat(40),
          subject: 'Add widgets', prId: 'pr-1', prNumber: 42, providerId: 'bitbucket',
          provider: 'claude', model: 'default', status: 'done',
          startedAt: '2026-08-24T00:00:00Z', finishedAt: '2026-08-24T00:01:00Z',
        }],
      });
      const { getByText, queryByText } = render(ReviewApp);
      await waitFor(() => expect(getByText(/PR #42/)).toBeInTheDocument());
      expect(getByText(/Add widgets/)).toBeInTheDocument();
      expect(queryByText(/aaaaaaa/)).toBeNull();
    });

    it('switching away from and back to Pull Request mode keeps the selection', async () => {
      stub({ 'forge.status': { available: true }, 'forge.pr.list': { pullRequests } });
      const { getByRole } = render(ReviewApp);
      await waitFor(() => expect(getByRole('tab', { name: 'Pull Request' })).toBeInTheDocument());
      await fireEvent.click(getByRole('tab', { name: 'Pull Request' }));
      const combobox = await waitFor(() => getByRole('combobox', { name: 'Pull request' }));
      await fireEvent.focus(combobox);
      const option = await waitFor(() => getByRole('option', { name: /Add widgets/ }));
      await fireEvent.click(option);
      await waitFor(() => expect((getByRole('combobox', { name: 'Pull request' }) as HTMLInputElement).value).toBe('pr-1'));

      await fireEvent.click(getByRole('tab', { name: '2 Branches' }));
      await waitFor(() => expect(getByRole('tab', { name: '2 Branches' })).toHaveAttribute('aria-selected', 'true'));

      await fireEvent.click(getByRole('tab', { name: 'Pull Request' }));
      await waitFor(() => {
        const restored = getByRole('combobox', { name: 'Pull request' }) as HTMLInputElement;
        expect(restored.value).toBe('pr-1');
      });
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import PullRequestDetail from '../../src/webview/components/detail/PullRequestDetail.svelte';

const capabilities = {
  createPullRequest: true, approve: true, requestChanges: true, merge: true,
  mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
};

const pullRequest = {
  id: '123', number: 123, title: 'fix(auth): refresh token race', state: 'open',
  author: { displayName: 'An Tran', accountId: 'a' },
  sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
  reviewers: [
    { user: { displayName: 'An Tran', accountId: 'a' }, status: 'approved' },
    { user: { displayName: 'Hoa Pham', accountId: 'h' }, status: 'pending' },
  ],
  commentCount: 2, webUrl: 'https://example.test/123', updatedAt: '2026-08-25T09:30:00Z',
  description: 'Single-flight the refresh.', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  mergeable: 'conflicted',
};

const comments = [
  { id: '1', author: { displayName: 'Minh Le', accountId: 'm' }, body: 'This drops the mutex.', createdAt: '2026-08-21T03:00:00Z', path: 'src/auth.ts', line: 42 },
  { id: '2', author: { displayName: 'An Tran', accountId: 'a' }, body: 'Fixed.', createdAt: '2026-08-21T04:00:00Z', parentId: '1' },
];

const props = { pullRequest, comments, files: [], capabilities };

describe('PullRequestDetail', () => {
  afterEach(cleanup);

  it('renders the header, branches and description', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText('#123')).toBeInTheDocument();
    expect(screen.getByText('fix(auth): refresh token race')).toBeInTheDocument();
    expect(screen.getByText('feature/RMS-1027')).toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('Single-flight the refresh.')).toBeInTheDocument();
  });

  it('warns when the pull request is conflicted', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText(/conflicted/i)).toBeInTheDocument();
  });

  it('lists reviewers with their status as accessible labels', () => {
    render(PullRequestDetail, props);
    expect(screen.getByLabelText('An Tran approved')).toBeInTheDocument();
    expect(screen.getByLabelText('Hoa Pham pending')).toBeInTheDocument();
  });

  it('shows an inline comment with its file and line', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText('src/auth.ts:42')).toBeInTheDocument();
    expect(screen.getByText('This drops the mutex.')).toBeInTheDocument();
  });

  it('marks a reply as belonging to its thread', () => {
    render(PullRequestDetail, props);
    expect(screen.getByTestId('comment-2')).toHaveAttribute('data-parent', '1');
  });

  it('emits reviewWithAi', async () => {
    const { component } = render(PullRequestDetail, props);
    let fired = false;
    component.$on('reviewWithAi', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /review with ai/i }));
    expect(fired).toBe(true);
  });

  it('emits openExternal', async () => {
    const { component } = render(PullRequestDetail, props);
    let fired = false;
    component.$on('openExternal', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /open in browser/i }));
    expect(fired).toBe(true);
  });

  // An unsupported action is absent, never disabled.
  it('omits actions the provider does not support', () => {
    render(PullRequestDetail, {
      ...props,
      capabilities: { ...capabilities, approve: false, merge: false },
    });
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^merge/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request changes/i })).toBeInTheDocument();
  });

  it('renders nothing when no pull request is selected', () => {
    const { container } = render(PullRequestDetail, { ...props, pullRequest: null });
    expect(container.textContent?.trim()).toBe('');
  });
});

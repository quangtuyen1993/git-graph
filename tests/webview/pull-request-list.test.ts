import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import PullRequestList from '../../src/webview/components/sidebar/PullRequestList.svelte';

const pr = (overrides: Record<string, unknown> = {}) => ({
  id: '123', number: 123, title: 'fix(auth): refresh token race', state: 'open',
  author: { displayName: 'An Tran', accountId: 'a' },
  sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
  reviewers: [
    { user: { displayName: 'An Tran', accountId: 'a' }, status: 'approved' },
    { user: { displayName: 'Minh Le', accountId: 'm' }, status: 'changes_requested' },
  ],
  commentCount: 8, webUrl: 'https://example.test/123', updatedAt: '2026-08-25T09:30:00Z',
  ...overrides,
});

describe('PullRequestList', () => {
  afterEach(cleanup);

  it('shows a single sign-in row when signed out, naming the provider', () => {
    render(PullRequestList, { pullRequests: [], stale: false, signedIn: false, query: '', providerName: 'Bitbucket' });
    expect(screen.getByRole('button', { name: /sign in to bitbucket/i })).toBeInTheDocument();
    expect(screen.queryByText(/#123/)).not.toBeInTheDocument();
  });

  // Finding 10: no provider vocabulary belongs above forge/bitbucket/ — the
  // component must not hardcode a host name, it must render whatever
  // `forge.status` named.
  it('names whichever provider it is given, not a hardcoded host', () => {
    render(PullRequestList, { pullRequests: [], stale: false, signedIn: false, query: '', providerName: 'Acme Forge' });
    expect(screen.getByRole('button', { name: /sign in to acme forge/i })).toBeInTheDocument();
  });

  it('emits signIn when that row is clicked', async () => {
    const { component } = render(PullRequestList, { pullRequests: [], stale: false, signedIn: false, query: '', providerName: 'Bitbucket' });
    let fired = false;
    component.$on('signIn', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /sign in to bitbucket/i }));
    expect(fired).toBe(true);
  });

  it('renders number, title and approval counts', () => {
    render(PullRequestList, { pullRequests: [pr()], stale: false, signedIn: true, query: '' });
    expect(screen.getByText('#123')).toBeInTheDocument();
    expect(screen.getByText('fix(auth): refresh token race')).toBeInTheDocument();
    expect(screen.getByLabelText('1 approved')).toBeInTheDocument();
    expect(screen.getByLabelText('1 requested changes')).toBeInTheDocument();
  });

  it('marks a draft', () => {
    render(PullRequestList, { pullRequests: [pr({ state: 'draft' })], stale: false, signedIn: true, query: '' });
    expect(screen.getByLabelText('Draft')).toBeInTheDocument();
  });

  it('emits select with the pull request id', async () => {
    const { component } = render(PullRequestList, { pullRequests: [pr()], stale: false, signedIn: true, query: '' });
    let selected = '';
    component.$on('select', (event) => { selected = (event as CustomEvent<{ id: string }>).detail.id; });
    await fireEvent.click(screen.getByRole('button', { name: /#123/ }));
    expect(selected).toBe('123');
  });

  it.each([
    ['123', 1],
    ['refresh', 1],
    ['RMS-1027', 1],
    ['nothing', 0],
  ])('filters on %j', (query, expected) => {
    render(PullRequestList, { pullRequests: [pr()], stale: false, signedIn: true, query });
    expect(screen.queryAllByRole('button', { name: /#123/ })).toHaveLength(expected);
  });

  // The screen must not empty out because the network blinked.
  it('shows a stale marker without hiding the rows', () => {
    render(PullRequestList, { pullRequests: [pr()], stale: true, signedIn: true, query: '' });
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    expect(screen.getByText('#123')).toBeInTheDocument();
  });

  it('says so when there is nothing open', () => {
    render(PullRequestList, { pullRequests: [], stale: false, signedIn: true, query: '' });
    expect(screen.getByText(/no open pull requests/i)).toBeInTheDocument();
  });
});

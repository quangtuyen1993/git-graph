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

  // data-parent is invisible to assistive tech; the relationship must also be
  // conveyed as real text so a screen reader can follow the thread.
  it('names who a reply answers, as visible text a screen reader can read', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText(/in reply to minh le/i)).toBeInTheDocument();
  });

  // No capability backs this yet (it arrives in a later phase), so it is a
  // separate opt-in prop rather than one of the `capabilities.*` gates below.
  it('hides Review with AI unless explicitly enabled', () => {
    render(PullRequestDetail, props);
    expect(screen.queryByRole('button', { name: /review with ai/i })).not.toBeInTheDocument();
  });

  it('emits reviewWithAi when enabled', async () => {
    const { component } = render(PullRequestDetail, { ...props, reviewWithAiEnabled: true });
    let fired = false;
    component.$on('reviewWithAi', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /review with ai/i }));
    expect(fired).toBe(true);
  });

  // Phase 6, task 2: merging cannot be undone, so this panel does not
  // confirm or pick a strategy itself — it only signals intent, with no
  // payload, and leaves App.svelte to confirm (naming the pull request, the
  // target branch and the strategy) before calling forge.pr.merge.
  it('emits merge with no payload — confirmation and strategy choice belong to the parent', async () => {
    const { component } = render(PullRequestDetail, props);
    let fired = false;
    let detail: unknown;
    component.$on('merge', (event) => { fired = true; detail = event.detail; });

    await fireEvent.click(screen.getByRole('button', { name: /^merge$/i }));

    expect(fired).toBe(true);
    expect(detail).toBeNull();
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

  // Finding 6: a failed forge.pr.get used to leave this panel rendering
  // nothing — an empty pane the user had no way to dismiss, unlike its
  // sibling CommitDetail, which always has a close button.
  it('shows an error line and a close button when no pull request is loaded', () => {
    render(PullRequestDetail, { ...props, pullRequest: null });
    expect(screen.getByText(/couldn.t load this pull request/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('emits close from the error state', async () => {
    const { component } = render(PullRequestDetail, { ...props, pullRequest: null });
    let fired = false;
    component.$on('close', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(fired).toBe(true);
  });

  // Finding 7: `mapUser` defaults a missing account_id to '' (deactivated or
  // anonymised Atlassian accounts return this), and Svelte throws on
  // duplicate keys in a keyed `{#each}`. Two reviewers with a blank
  // account_id must not throw.
  it('renders two reviewers that both have a blank account id without throwing', () => {
    const blankIdReviewers = [
      { user: { displayName: 'Ghost One', accountId: '' }, status: 'pending' as const },
      { user: { displayName: 'Ghost Two', accountId: '' }, status: 'pending' as const },
    ];
    expect(() => render(PullRequestDetail, {
      ...props,
      pullRequest: { ...pullRequest, reviewers: blankIdReviewers },
    })).not.toThrow();
    expect(screen.getByText('Ghost One')).toBeInTheDocument();
    expect(screen.getByText('Ghost Two')).toBeInTheDocument();
  });

  it('renders two comments that both resolve to a blank id without throwing', () => {
    const blankIdComments = [
      { id: '', author: { displayName: 'A', accountId: 'a' }, body: 'first', createdAt: '2026-08-21T03:00:00Z' },
      { id: '', author: { displayName: 'B', accountId: 'b' }, body: 'second', createdAt: '2026-08-21T04:00:00Z' },
    ];
    expect(() => render(PullRequestDetail, { ...props, comments: blankIdComments })).not.toThrow();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  // Stretch requirement: the full pull request diff is now sha-key cached and
  // parseable in the webview, so a file row no longer needs a locally fetched
  // commit to open a diff — it just asks the parent to render the file it
  // was given.
  it('opens a diff when a file row is clicked', async () => {
    const files = [
      { path: 'src/auth.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
    ];
    const { component, getByText } = render(PullRequestDetail, { ...props, files });
    let opened: unknown;
    component.$on('openFile', (event) => { opened = event.detail; });

    await fireEvent.click(getByText('src/auth.ts'));

    expect(opened).toEqual(files[0]);
  });

  it('renders two files that resolve to the same path (rename plus mode change) without throwing', () => {
    const duplicatePathFiles = [
      { path: 'src/a.ts', oldPath: 'src/old-a.ts', status: 'renamed', additions: 1, deletions: 1, binary: false },
      { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: false },
    ];
    expect(() => render(PullRequestDetail, { ...props, files: duplicatePathFiles })).not.toThrow();
    expect(screen.getAllByTitle('src/a.ts')).toHaveLength(2);
  });
});

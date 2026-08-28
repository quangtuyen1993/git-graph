import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import ReviewDetail from '../../src/webview/components/detail/ReviewDetail.svelte';

const branchTarget = {
  kind: 'branch' as const,
  baseRef: 'develop', baseSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  headRef: 'feature/RMS-1027', headSha: 'e4f5g6h4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
};

const doneRun = {
  id: 'a1b2c3d..e4f5g6h.claude.claude-opus-5',
  provider: 'Claude', model: 'claude-opus-5',
  status: 'done' as const,
  startedAt: '2026-08-25T09:00:00.000Z',
  finishedAt: '2026-08-25T09:02:00.000Z',
};

describe('ReviewDetail', () => {
  afterEach(cleanup);

  // Acceptance 5: rendering with no review selected produces nothing, not a
  // broken frame.
  it('renders nothing when no target is selected', () => {
    // Svelte leaves an empty text-node anchor for the `{#if}` block, so this
    // checks for the absence of the panel itself rather than a literal
    // zero-child container (toBeEmptyDOMElement trips on that anchor node).
    const { container } = render(ReviewDetail, { reviewTarget: null, run: null });
    expect(container.querySelector('.review-detail')).toBeNull();
    expect(container.textContent).toBe('');
  });

  // Acceptance 1: a stored review renders its body, provider, model and time.
  it('renders the body, provider, model and time for a stored review', () => {
    render(ReviewDetail, { reviewTarget: branchTarget, run: doneRun, body: 'Looks good overall.' });

    expect(screen.getByText('Looks good overall.')).toBeInTheDocument();
    expect(screen.getByText(/claude/i)).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-5/)).toBeInTheDocument();
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });

  // Acceptance 2 (case 1/3): a pull request's target branch.
  it('renders base and head with sha and name for a pull request target branch', () => {
    const prTarget = {
      kind: 'pr' as const,
      baseRef: 'develop', baseSha: 'b'.repeat(40),
      headRef: 'feature/x', headSha: 'c'.repeat(40),
      prNumber: 42,
    };
    render(ReviewDetail, { reviewTarget: prTarget, run: doneRun, body: 'ok' });

    expect(screen.getByText('bbbbbbb')).toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('ccccccc')).toBeInTheDocument();
    expect(screen.getByText('feature/x')).toBeInTheDocument();
  });

  // Acceptance 2 (case 2/3): a commit's derived parent.
  it('renders base and head with sha and name for a commit reviewed against its parent', () => {
    const parentSha = 'd'.repeat(40);
    const commitSha = 'e'.repeat(40);
    const commitTarget = {
      kind: 'commit' as const,
      baseRef: parentSha, baseSha: parentSha,
      headRef: commitSha, headSha: commitSha,
      subject: 'fix: race condition',
    };
    render(ReviewDetail, { reviewTarget: commitTarget, run: doneRun, body: 'ok' });

    expect(screen.getAllByText('ddddddd').length).toBeGreaterThan(0);
    expect(screen.getAllByText('eeeeeee').length).toBeGreaterThan(0);
  });

  // Acceptance 2 (case 3/3): the working tree's HEAD as a derived base.
  it('renders base and head with sha and name when the base is the working tree HEAD', () => {
    const headTarget = {
      kind: 'branch' as const,
      baseRef: 'HEAD', baseSha: 'f'.repeat(40),
      headRef: 'working tree', headSha: 'g'.repeat(40),
    };
    render(ReviewDetail, { reviewTarget: headTarget, run: doneRun, body: 'ok' });

    expect(screen.getByText('fffffff')).toBeInTheDocument();
    expect(screen.getByText('HEAD')).toBeInTheDocument();
    expect(screen.getByText('ggggggg')).toBeInTheDocument();
    expect(screen.getByText('working tree')).toBeInTheDocument();
  });

  // Acceptance 3: a failed review shows its reason without opening the file.
  it('shows the failure reason in full and does not dispatch openAsFile', () => {
    const failedRun = { ...doneRun, status: 'failed' as const, error: 'codex exited with status 1: rate limited' };
    const { component } = render(ReviewDetail, { reviewTarget: branchTarget, run: failedRun, body: '' });
    let openedAsFile = false;
    component.$on('openAsFile', () => { openedAsFile = true; });

    expect(screen.getByText('codex exited with status 1: rate limited')).toBeInTheDocument();
    expect(openedAsFile).toBe(false);
  });

  // Acceptance 4: Open as file still opens the markdown.
  it('dispatches openAsFile when the button is clicked', async () => {
    const { component } = render(ReviewDetail, { reviewTarget: branchTarget, run: doneRun, body: 'ok' });
    let fired = false;
    component.$on('openAsFile', () => { fired = true; });

    await fireEvent.click(screen.getByRole('button', { name: /open as file/i }));

    expect(fired).toBe(true);
  });

  it('dispatches rerun when the button is clicked', async () => {
    const { component } = render(ReviewDetail, { reviewTarget: branchTarget, run: doneRun, body: 'ok' });
    let fired = false;
    component.$on('rerun', () => { fired = true; });

    await fireEvent.click(screen.getByRole('button', { name: /re-run/i }));

    expect(fired).toBe(true);
  });

  it('dispatches delete when the button is clicked', async () => {
    const { component } = render(ReviewDetail, { reviewTarget: branchTarget, run: doneRun, body: 'ok' });
    let fired = false;
    component.$on('delete', () => { fired = true; });

    await fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(fired).toBe(true);
  });

  // Acceptance 6: the changed-file list renders and a row dispatches a diff-open.
  it('renders changed files and dispatches openFile from a row', async () => {
    const files = [
      { path: 'src/auth.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
    ];
    const { component } = render(ReviewDetail, { reviewTarget: branchTarget, run: doneRun, body: 'ok', files });
    let opened: unknown;
    component.$on('openFile', (event) => { opened = event.detail; });

    await fireEvent.click(screen.getByText('src/auth.ts'));

    expect(opened).toEqual(files[0]);
  });

  // Acceptance 7: the diff-only state renders base, head and files, with no
  // AI body and no progress affordance.
  it('renders the diff-only state with base, head and files but no body or progress', () => {
    const files = [
      { path: 'src/auth.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
    ];
    render(ReviewDetail, { reviewTarget: branchTarget, run: null, files });

    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('feature/RMS-1027')).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-run/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open as file/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
  });

  // A running review renders the streamed-so-far body rather than a static
  // spinner — the review-runner appends chunks to the same body the host
  // polls, so re-rendering with a growing `body` prop is the progress signal.
  it('renders the streamed body while a review is running, growing as body grows', async () => {
    const runningRun = { ...doneRun, status: 'running' as const, finishedAt: undefined };
    const { rerender } = render(ReviewDetail, { reviewTarget: branchTarget, run: runningRun, body: 'First chunk.' });
    expect(screen.getByText('First chunk.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /spinner/i })).not.toBeInTheDocument();

    await rerender({ reviewTarget: branchTarget, run: runningRun, body: 'First chunk. Second chunk.' });
    expect(screen.getByText('First chunk. Second chunk.')).toBeInTheDocument();
  });

  // Trap named in the brief: PullRequestDetail once keyed an {#each} on a
  // field the store can leave empty, which collided and threw. Two files
  // that would collide on path alone must not throw here.
  it('renders two files that resolve to the same path without throwing', () => {
    const duplicatePathFiles = [
      { path: 'src/a.ts', oldPath: 'src/old-a.ts', status: 'renamed', additions: 1, deletions: 1, binary: false },
      { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: false },
    ];
    expect(() => render(ReviewDetail, {
      reviewTarget: branchTarget, run: doneRun, body: 'ok', files: duplicatePathFiles,
    })).not.toThrow();
    expect(screen.getAllByText('src/a.ts')).toHaveLength(2);
  });
});

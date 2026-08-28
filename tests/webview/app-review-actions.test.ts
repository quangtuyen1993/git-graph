import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

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

const prReviewEntry = {
  id: 'pr..pr-77.claude.claude-opus-5',
  kind: 'pr' as const,
  baseRef: 'main', baseSha: 'd'.repeat(40),
  headRef: 'feature/y', headSha: 'e'.repeat(40),
  prId: 'pr-77', prNumber: 77, subject: 'Add widgets',
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
      case 'review.rerun': return { id: reviewEntry.id };
      case 'review.delete': return { success: true };
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

async function selectReviewByLabel(rendered: ReturnType<typeof render>, label: string): Promise<void> {
  await waitForAppReady(rendered);
  await waitFor(() => expect(rendered.getByText('REVIEWS')).toBeInTheDocument());
  // The section may already be expanded from an earlier selection in the
  // same test — clicking the header again would collapse it back.
  if (!rendered.queryByText(label)) {
    await fireEvent.click(rendered.getByText('REVIEWS'));
  }
  const row = await waitFor(() => rendered.getByText(label));
  await fireEvent.click(row.closest('button')!);
}

async function selectReview(rendered: ReturnType<typeof render>): Promise<void> {
  await selectReviewByLabel(rendered, 'develop ← feature/x');
}

async function selectCommit(rendered: ReturnType<typeof render>): Promise<void> {
  await waitForAppReady(rendered);
  const row = rendered.container.querySelector('.commit-row');
  await fireEvent.click(row!);
}

// Base/head names (e.g. 'main') collide with the branch sidebar's own rows,
// so assertions about the review panel's own content are scoped to it.
function rightPanel(rendered: ReturnType<typeof render>) {
  return within(rendered.container.querySelector('.right-panel')!);
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

// Fix round 1: ReviewDetail's Re-run and Delete buttons rendered and did
// nothing when clicked — no handler was ever registered for either event.
// These tests click the buttons through App, the same way selectReview()
// above drives the sidebar, so a handler being silently absent (or wired to
// the wrong method/id) fails here instead of shipping unnoticed again.
describe('Re-running and deleting a review from the detail panel', () => {
  it('sends review.rerun with the selected review\'s id when Re-run is clicked', async () => {
    stubApp();
    const rendered = render(App);
    await selectReview(rendered);
    await waitFor(() => expect(rendered.getByRole('button', { name: /re-run/i })).toBeInTheDocument());
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /re-run/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.rerun', { id: reviewEntry.id }));
  });

  it('sends review.delete with the selected review\'s id and clears the panel when Delete is clicked', async () => {
    stubApp();
    const rendered = render(App);
    await selectReview(rendered);
    await waitFor(() => expect(rendered.getByRole('button', { name: /delete/i })).toBeInTheDocument());
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.delete', { id: reviewEntry.id }));
    // Deleting the review currently on screen must also clear the
    // selection — the panel falls back to CommitDetail's dismissible empty
    // state, the same as a failed load does.
    await waitFor(() => expect(rendered.getByText('Select a commit to view details')).toBeInTheDocument());
    expect(rendered.queryByText('Looks good overall.')).not.toBeInTheDocument();
  });
});

// Critical finding (final pre-merge review): the action bar was gated on
// `{#if run}` (whether a run exists at all), not on its status, so a review
// that was still `running` offered the same Re-run/Delete buttons as a
// settled one. Re-run deletes the store entry and restarts — but
// ReviewRunner.start's in-flight dedup means the entry is never recreated,
// so the running child process becomes unreachable and its eventual
// `finish()` is a silent no-op (review-store.ts's `if (index === -1)
// return;`). Delete orphans the same way. The old panel
// (ReviewApp.svelte:807-818) gets this right: Cancel while running,
// Re-run/Delete only once settled — mirrored here.
describe('Live review actions are gated on run status, not on run presence', () => {
  const runningEntry = { ...reviewEntry, status: 'running' as const, finishedAt: undefined };

  it('offers Cancel, not Re-run or Delete, while the review is running', async () => {
    stubApp({
      'review.list': () => [runningEntry],
      'review.get': () => runningEntry,
    });
    const rendered = render(App);
    await selectReview(rendered);

    await waitFor(() => expect(rendered.getByRole('button', { name: /cancel/i })).toBeInTheDocument());
    expect(rendered.queryByRole('button', { name: /re-run/i })).not.toBeInTheDocument();
    expect(rendered.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('offers Re-run and Delete, not Cancel, once the review has settled', async () => {
    stubApp();
    const rendered = render(App);
    await selectReview(rendered);

    await waitFor(() => expect(rendered.getByRole('button', { name: /re-run/i })).toBeInTheDocument());
    expect(rendered.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    expect(rendered.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('sends review.cancel with the selected review\'s id when Cancel is clicked', async () => {
    stubApp({
      'review.list': () => [runningEntry],
      'review.get': () => runningEntry,
      'review.cancel': () => ({ cancelled: true }),
    });
    const rendered = render(App);
    await selectReview(rendered);
    await waitFor(() => expect(rendered.getByRole('button', { name: /cancel/i })).toBeInTheDocument());
    send.mockClear();

    await fireEvent.click(rendered.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.cancel', { id: reviewEntry.id }));
  });
});

// Fix round 2 (Critical): loadReview shared a Promise.all and a catch block
// between the entry/body fetch and the changed-file-list fetch, so a stale
// ref (a deleted or GC'd branch) or a gone forge provider took the whole
// review down — clearReviewSelection() nulled selectedReviewId, which also
// made "Open as file" unreachable (it early-returns on !selectedReviewId).
// This is the constraints.md guarantee that predates this task: a stored
// review must keep loading and opening in all four kinds, even one whose
// ref or forge provider is now gone.
describe('A stale changed-file list does not take the review down', () => {
  it('still renders the review, its body and Open as file when review.compare rejects (a git-based kind)', async () => {
    stubApp({
      'review.compare': () => { throw new Error("fatal: bad revision 'feature/x'"); },
    });
    const rendered = render(App);

    await selectReview(rendered);

    await waitFor(() => expect(rendered.getByText('Looks good overall.')).toBeInTheDocument());
    expect(rightPanel(rendered).getByText('develop')).toBeInTheDocument();
    expect(rightPanel(rendered).getByText('feature/x')).toBeInTheDocument();
    await waitFor(() => expect(
      rendered.container.querySelector('.error-banner')?.textContent,
    ).toContain("fatal: bad revision 'feature/x'"));
    // The review itself is still selected and open — a degraded file list
    // must not be indistinguishable from the load having failed outright.
    expect(rendered.queryByText('Select a commit to view details')).not.toBeInTheDocument();

    send.mockClear();
    await fireEvent.click(rendered.getByRole('button', { name: /open as file/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.open', { id: reviewEntry.id }));
  });

  it('still renders the review and Open as file when forge.pr.files rejects (kind pr)', async () => {
    stubApp({
      'review.list': () => [prReviewEntry],
      'review.get': () => prReviewEntry,
      'forge.pr.files': () => { throw new Error('Not signed in to Bitbucket.'); },
    });
    const rendered = render(App);

    await selectReviewByLabel(rendered, 'PR #77 Add widgets');

    await waitFor(() => expect(rendered.getByText('Looks good overall.')).toBeInTheDocument());
    expect(rightPanel(rendered).getByText('main')).toBeInTheDocument();
    expect(rightPanel(rendered).getByText('feature/y')).toBeInTheDocument();
    await waitFor(() => expect(
      rendered.container.querySelector('.error-banner')?.textContent,
    ).toContain('Not signed in to Bitbucket.'));
    expect(rendered.queryByText('Select a commit to view details')).not.toBeInTheDocument();

    send.mockClear();
    await fireEvent.click(rendered.getByRole('button', { name: /open as file/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.open', { id: prReviewEntry.id }));
  });
});

// Important finding: the only test near the poll loop re-rendered
// ReviewDetail directly with a bigger `body` prop, which proves Svelte
// re-renders and nothing about whether App.svelte itself re-fetches on a
// timer, at what interval, or stops once the status settles. This drives it
// through real timers (short enough to keep the file fast) rather than fake
// ones, since the polling interacts with several chained bridge round trips
// that are awkward to keep in lockstep with a faked clock.
describe('Polling a running review', () => {
  it('re-fetches on a timer while running, and stops once the status settles', async () => {
    let getCalls = 0;
    const runningEntry = { ...reviewEntry, status: 'running' as const, finishedAt: undefined };
    const doneEntry = { ...reviewEntry, status: 'done' as const };
    stubApp({
      // Calls 1 and 2 ('running') prove the timer fires and re-fetches;
      // call 3 onward ('done') proves the loop stops once settled — not
      // just once, since a loop that fires exactly one poll and then always
      // stops regardless of status would also pass a weaker assertion.
      'review.get': () => { getCalls += 1; return getCalls <= 2 ? runningEntry : doneEntry; },
    });
    const rendered = render(App);

    await selectReview(rendered);
    await waitFor(() => expect(rendered.getAllByText(/claude-opus-5/).length).toBeGreaterThan(0));
    expect(getCalls).toBe(1);

    // The first poll tick: still running, so a second review.get lands.
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // The second poll tick: now done, so a third review.get lands and no
    // further timer is armed.
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(3), { timeout: 3000 });

    const callsAtSettle = getCalls;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(getCalls).toBe(callsAtSettle);
  }, 10000);
});

// Important finding: loadReview's file-list assignment
// (`reviewFiles = await fetchReviewFiles(entry)`) had no
// `selectedReviewId !== id` guard, unlike every other assignment in the same
// function (the catch branch even guards before assigning). Selecting review
// A, then B before A's slow file fetch resolves, let A's file list land on
// top of B's once selected — B renders with A's changed files. A deferred
// promise makes the interleaving deterministic rather than timing-dependent.
describe('A slow file-list fetch cannot land after a newer review is selected', () => {
  it('does not let review A\'s superseded file list overwrite review B\'s', async () => {
    const reviewEntryB = {
      ...reviewEntry,
      id: 'branch..develop..feature-b.claude.claude-opus-5',
      baseRef: 'develop', headRef: 'feature/b',
    };
    const filesA = deferred<{ files: unknown[] }>();
    const fileOf = (path: string) => ({
      path, oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false,
    });
    stubApp({
      'review.list': () => [reviewEntry, reviewEntryB],
      'review.get': (params?: unknown) => {
        const id = (params as { id: string }).id;
        return id === reviewEntryB.id ? reviewEntryB : reviewEntry;
      },
      'review.compare': (params?: unknown) => {
        const { headRef } = params as { headRef: string };
        return headRef === 'feature/x' ? filesA.promise : Promise.resolve({ files: [fileOf('b-only.ts')] });
      },
    });
    const rendered = render(App);

    // Review A ('feature/x'): its file fetch is left pending.
    await selectReviewByLabel(rendered, 'develop ← feature/x');
    // Review B ('feature/b'): its own file fetch resolves immediately.
    await selectReviewByLabel(rendered, 'develop ← feature/b');
    await waitFor(() => expect(rightPanel(rendered).getByText('b-only.ts')).toBeInTheDocument());

    // A's fetch finally lands, after B is already on screen.
    filesA.resolve({ files: [fileOf('a-only.ts')] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rightPanel(rendered).getByText('b-only.ts')).toBeInTheDocument();
    expect(rightPanel(rendered).queryByText('a-only.ts')).not.toBeInTheDocument();
  });
});

// Important finding: `extension.ts` broadcasts `review.changed` on every
// ReviewRunner start/finish, and router-registry.ts documents that this
// event exists precisely for "every attached webview (graph and the review
// tab)" — but App.svelte only ever subscribed to `graph.invalidated` and
// `forge.changed`. Without this, the REVIEWS sidebar list only refreshes via
// refreshGraph(), which the `.git` watcher drives and a review run never
// touches — so a review started elsewhere never appears, and a `Running` row
// never updates until something unrelated (a branch filter change, a repo
// switch) happens to trigger a full graph refresh.
describe('review.changed refreshes the reviews list', () => {
  afterEach(() => {
    // Restore the generic default so later tests in this file (and this
    // suite's own module-scoped `on` mock) aren't left wired to this test's
    // handler-capturing implementation.
    on.mockImplementation(() => vi.fn());
  });

  it('re-fetches review.list when a review.changed event arrives', async () => {
    const handlers = new Map<string, (data?: unknown) => void>();
    on.mockImplementation((event: string, handler: (data?: unknown) => void) => {
      handlers.set(event, handler);
      return vi.fn();
    });
    let listCalls = 0;
    const failedEntry = { ...reviewEntry, status: 'failed' as const, error: 'It broke' };
    stubApp({
      'review.list': () => {
        listCalls += 1;
        return listCalls === 1 ? [reviewEntry] : [failedEntry];
      },
    });
    const rendered = render(App);

    await waitForAppReady(rendered);
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(handlers.has('review.changed')).toBe(true));

    handlers.get('review.changed')!({ id: reviewEntry.id });

    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(rendered.getByText('REVIEWS')).toBeInTheDocument());
    if (!rendered.queryByLabelText('Failed')) {
      await fireEvent.click(rendered.getByText('REVIEWS'));
    }
    await waitFor(() => expect(rendered.getByLabelText('Failed')).toBeInTheDocument());
  });
});

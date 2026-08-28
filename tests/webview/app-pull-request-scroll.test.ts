import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const pullRequestSummary = {
  id: 'pr-1', number: 42, title: 'Add widgets', state: 'open',
  sourceBranch: 'feature/widgets', targetBranch: 'main',
  reviewers: [], commentCount: 0,
};
const secondPullRequestSummary = {
  id: 'pr-2', number: 43, title: 'Fix gizmos', state: 'open',
  sourceBranch: 'feature/gizmos', targetBranch: 'main',
  reviewers: [], commentCount: 0,
};
const pullRequestDetail = {
  ...pullRequestSummary,
  description: 'desc', sourceCommit: 'c'.repeat(40), targetCommit: 'd'.repeat(40),
  mergeable: 'clean', webUrl: 'https://example.test/pr/42',
};
const secondPullRequestDetail = {
  ...secondPullRequestSummary,
  description: 'desc2', sourceCommit: 'e'.repeat(40), targetCommit: 'd'.repeat(40),
  mergeable: 'clean', webUrl: 'https://example.test/pr/43',
};

const forgeStatus = {
  available: true, providerName: 'Bitbucket', signedIn: true,
  capabilities: {
    createPullRequest: false, approve: true, requestChanges: true, merge: true,
    mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
  },
};

/**
 * `graph.build` and `graph.getWindow` are deferred so a test can hold the
 * graph "still building" for as long as it needs, then resolve it and
 * inspect what happens next. Everything else resolves immediately, matching
 * the fixtures other pull-request tests use.
 */
function stubApp(options: {
  graphBuild?: ReturnType<typeof deferred<{ totalRows: number; maxLane: number; layoutVersion: number }>>;
  getRow?: (params: { hash: string; layoutVersion: number }) =>
    { row: number | null } | Promise<{ row: number | null }>;
  overrides?: Partial<Record<string, (params?: unknown) => unknown>>;
} = {}) {
  const graphBuild = options.graphBuild ?? deferred<{ totalRows: number; maxLane: number; layoutVersion: number }>();
  let buildCount = 0;
  let latestLayoutVersion = 0;

  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    if (options.overrides && method in options.overrides) {
      return options.overrides[method]!(params);
    }
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [
        { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
      ];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': {
        buildCount += 1;
        if (buildCount === 1) return graphBuild.promise.then((result) => {
          latestLayoutVersion = result.layoutVersion;
          return result;
        });
        latestLayoutVersion += 1;
        return { totalRows: 500, maxLane: 0, layoutVersion: latestLayoutVersion };
      }
      case 'graph.getWindow': return {
        nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0,
      };
      case 'graph.getRow': {
        const { hash, layoutVersion } = params as { hash: string; layoutVersion: number };
        if (options.getRow) return options.getRow({ hash, layoutVersion });
        return { row: null };
      }
      case 'forge.status': return forgeStatus;
      case 'forge.pr.list': return { pullRequests: [pullRequestSummary, secondPullRequestSummary], stale: false };
      case 'forge.pr.get': return (params as { id: string }).id === 'pr-2' ? secondPullRequestDetail : pullRequestDetail;
      case 'forge.pr.comments': return { comments: [] };
      case 'forge.pr.files': return { files: [] };
      default: return null;
    }
  });
  return { graphBuild };
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function bannerText(container: HTMLElement): string {
  return container.querySelector('.error-banner')?.textContent?.trim() ?? '';
}

function pendingText(container: HTMLElement): string {
  return container.querySelector('.mutation-progress')?.textContent?.trim() ?? '';
}

async function openPullRequestsSection(rendered: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(rendered.getByText('PULL REQUESTS')).toBeInTheDocument());
  await fireEvent.click(rendered.getByText('PULL REQUESTS'));
}

async function clickPullRequest(rendered: ReturnType<typeof render>, title: string): Promise<void> {
  const row = await waitFor(() => rendered.getByText(title));
  await fireEvent.click(row.closest('button')!);
}

/** Filters the graph down to `main` through the toolbar dropdown a user uses. */
async function filterGraphToMain(rendered: ReturnType<typeof render>): Promise<void> {
  // The dropdown lists whatever `git.branches` last delivered, which lands
  // with the first graph refresh -- opening it earlier shows an empty list.
  await waitFor(() => expect(rendered.getByRole('button', { name: 'main' })).toBeInTheDocument());
  await fireEvent.click(rendered.getByLabelText('Filter graph by branch'));
  await fireEvent.click(rendered.getByRole('checkbox', { name: 'main' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(
    'graph.build', { branches: ['main'], all: false },
  ));
}

function resolvedBuild(layoutVersion = 1) {
  const d = deferred<{ totalRows: number; maxLane: number; layoutVersion: number }>();
  d.resolve({ totalRows: 500, maxLane: 0, layoutVersion });
  return d;
}

describe('Pull request head-commit scroll: graph still building', () => {
  it('does not show the not-fetched message while the graph build is in flight', async () => {
    const { graphBuild } = stubApp({ getRow: () => ({ row: null }) });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    // Give any (incorrect) synchronous banner a chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bannerText(rendered.container)).toBe('');
    expect(send).not.toHaveBeenCalledWith('graph.getRow', expect.anything());

    graphBuild.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });
  });

  it('shows a loading indicator while waiting, not the not-fetched claim', async () => {
    const { graphBuild } = stubApp({ getRow: () => ({ row: null }) });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(pendingText(rendered.container)).not.toBe(''));
    expect(bannerText(rendered.container)).toBe('');
    expect(pendingText(rendered.container).toLowerCase()).not.toContain('not fetched');

    graphBuild.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });
  });

  it('retries the lookup and scrolls once the build completes and the commit is present', async () => {
    const { graphBuild } = stubApp({
      getRow: ({ hash }) => ({ row: hash === 'c'.repeat(40) ? 42 : null }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(pendingText(rendered.container)).not.toBe(''));

    graphBuild.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });

    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getRow', {
      hash: 'c'.repeat(40), layoutVersion: 1,
    }));
    await waitFor(() => expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBeGreaterThan(0));
    expect(bannerText(rendered.container)).toBe('');
  });

  it('a pending lookup invalidated by selecting a different pull request does not scroll afterwards', async () => {
    const { graphBuild } = stubApp({
      getRow: ({ hash }) => ({ row: hash === 'c'.repeat(40) ? 42 : null }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(pendingText(rendered.container)).not.toBe(''));

    // Switch to a different pull request while the first lookup is still
    // waiting for the build.
    await clickPullRequest(rendered, 'Fix gizmos');

    graphBuild.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });

    // The first PR's commit (row 42) must never be scrolled to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBe(0);
    expect(send).not.toHaveBeenCalledWith('graph.getRow', { hash: 'c'.repeat(40), layoutVersion: 1 });
  });

  it('a pending lookup invalidated by an unrelated rebuild does not scroll afterwards', async () => {
    // The build the lookup is waiting on completes normally, but the
    // `graph.getRow` round trip that follows is held open — long enough for
    // an unrelated rebuild (e.g. the user hitting Refresh) to land and move
    // the layout on before that lookup's answer arrives.
    const rowLookup = deferred<{ row: number | null }>();
    const { graphBuild } = stubApp({
      getRow: ({ hash, layoutVersion }) => {
        if (hash === 'c'.repeat(40) && layoutVersion === 1) return rowLookup.promise;
        return { row: null };
      },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(pendingText(rendered.container)).not.toBe(''));

    graphBuild.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getRow', {
      hash: 'c'.repeat(40), layoutVersion: 1,
    }));

    // An unrelated rebuild (a different `graph.build` round trip) lands and
    // supersedes layoutVersion 1 before the held lookup answers.
    const refreshButton = rendered.container.querySelector('[aria-label="Refresh"]') as HTMLElement;
    await fireEvent.click(refreshButton);
    await waitFor(() => expect(
      send.mock.calls.filter(([method]) => method === 'graph.build'),
    ).toHaveLength(2));

    // Now the stale lookup's answer arrives, for a layout that is no longer current.
    rowLookup.resolve({ row: 42 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBe(0);
  });

  it('shows a definite "not finished loading" state instead of spinning forever when the build never completes', async () => {
    vi.useFakeTimers();
    stubApp({ getRow: () => ({ row: null }) });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await vi.waitFor(() => expect(pendingText(rendered.container)).not.toBe(''));

    // The build never resolves. Advance just past the wait bound — but
    // short of the banner's own auto-clear window, so this checks the
    // message actually landed rather than merely that it eventually clears.
    await vi.advanceTimersByTimeAsync(20_500);

    expect(pendingText(rendered.container)).toBe('');
    expect(bannerText(rendered.container)).not.toBe('');
    expect(bannerText(rendered.container).toLowerCase()).not.toContain('branch may not be fetched');
  });
});

describe('Pull request head-commit scroll: build already completed', () => {
  it('shows the not-fetched message, with a Fetch action, when a completed build genuinely lacks the commit', async () => {
    stubApp({
      graphBuild: (() => {
        const d = deferred<{ totalRows: number; maxLane: number; layoutVersion: number }>();
        d.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });
        return d;
      })(),
      getRow: () => ({ row: null }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(bannerText(rendered.container)).toContain(
      "isn't in the loaded graph",
    ));
    expect(rendered.getByRole('button', { name: /fetch/i })).toBeInTheDocument();
  });

  it('fetches and retries the scroll when the Fetch action is used', async () => {
    let fetchCalled = false;
    stubApp({
      graphBuild: (() => {
        const d = deferred<{ totalRows: number; maxLane: number; layoutVersion: number }>();
        d.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });
        return d;
      })(),
      getRow: ({ layoutVersion }) => {
        if (layoutVersion === 1) return { row: null };
        return { row: 42 };
      },
      overrides: {
        'git.fetch': () => { fetchCalled = true; return undefined; },
      },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(bannerText(rendered.container)).toContain("isn't in the loaded graph"));

    await fireEvent.click(rendered.getByRole('button', { name: /fetch/i }));

    await waitFor(() => expect(fetchCalled).toBe(true));
    await waitFor(() => expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBeGreaterThan(0));
    expect(bannerText(rendered.container)).toBe('');
  });
});

describe('Pull request head-commit scroll: a branch filter is hiding the row', () => {
  it('names the filter and offers Clear filter, not Fetch, when a filter is active', async () => {
    stubApp({ graphBuild: resolvedBuild(), getRow: () => ({ row: null }) });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await filterGraphToMain(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(bannerText(rendered.container)).toContain(
      'outside the current branch filter',
    ));
    expect(bannerText(rendered.container)).not.toContain('fetched locally');
    expect(rendered.getByRole('button', { name: /clear filter/i })).toBeInTheDocument();
    expect(rendered.queryByRole('button', { name: /^fetch$/i })).toBeNull();
    // Fetching cannot help when the commit is already local, so it must not
    // even be offered.
    expect(send).not.toHaveBeenCalledWith('git.fetch', expect.anything());
  });

  it('clears the filter and retries the scroll when the Clear filter action is used', async () => {
    stubApp({
      graphBuild: resolvedBuild(),
      // The filtered layout (version 2) has no row for the head commit; the
      // unfiltered rebuild that Clear filter triggers does.
      getRow: ({ layoutVersion }) => ({ row: layoutVersion >= 3 ? 42 : null }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await filterGraphToMain(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(bannerText(rendered.container)).toContain(
      'outside the current branch filter',
    ));

    await fireEvent.click(rendered.getByRole('button', { name: /clear filter/i }));

    await waitFor(() => expect(
      send.mock.calls.filter(([method]) => method === 'graph.build').at(-1),
    ).toEqual(['graph.build', { all: true }]));
    await waitFor(() => expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBeGreaterThan(0));
    expect(bannerText(rendered.container)).toBe('');
    expect(send).not.toHaveBeenCalledWith('git.fetch', expect.anything());
  });
});

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
  let fetchCount = 0;

  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'git.fetch') {
      fetchCount += 1;
      // Capped ahead of any override, so no test can escape it. A jump that
      // fetches and still finds the commit missing retries in pure microtasks:
      // that starves `waitFor`'s timer, so without this cap a lost terminator
      // in `scrollToPullRequestHead` hangs the run — or exhausts the heap —
      // instead of failing a test that names the cause.
      if (fetchCount > 2) throw new Error(`runaway fetch: git.fetch called ${fetchCount} times`);
    }
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
      case 'git.fetch': return undefined;
      case 'forge.status': return forgeStatus;
      case 'forge.pr.list': return { pullRequests: [pullRequestSummary, secondPullRequestSummary], stale: false };
      case 'forge.pr.get': return (params as { id: string }).id === 'pr-2' ? secondPullRequestDetail : pullRequestDetail;
      case 'forge.pr.comments': return { comments: [] };
      case 'forge.pr.files': return { files: [] };
      default: return null;
    }
  });
  return { graphBuild, fetchCalls: () => fetchCount };
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function bannerText(container: HTMLElement): string {
  return container.querySelector('.error-banner')?.textContent?.trim() ?? '';
}

/**
 * The ambient "work is in flight" bar under the toolbar — the one visible
 * state every wait in this file resolves to, whether the wait is a graph
 * build or the fetch a missing head commit now triggers on its own.
 */
function busyBar(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.background-progress-bar');
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

    await waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());
    expect(bannerText(rendered.container)).toBe('');
    // Ambient, not labelled: it says "working", never what the work is.
    expect(busyBar(rendered.container)!.textContent).toBe('');

    graphBuild.resolve({ totalRows: 500, maxLane: 0, layoutVersion: 1 });
  });

  it('retries the lookup and scrolls once the build completes and the commit is present', async () => {
    const { graphBuild } = stubApp({
      getRow: ({ hash }) => ({ row: hash === 'c'.repeat(40) ? 42 : null }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());

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
    await waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());

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
    await waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());

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

  it('shows the bar while a jump waits even though no build is running', async () => {
    // Every build so far has failed, so nothing is in flight and the graph
    // will never be ready on its own — but the jump IS waiting, and the bar
    // is the one thing telling the user so.
    const { graphBuild } = stubApp({ getRow: () => ({ row: null }) });
    graphBuild.reject(new Error('git log failed'));
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await waitFor(() => expect(bannerText(rendered.container)).toContain('git log failed'));
    expect(busyBar(rendered.container)).toBeNull();

    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());
    expect(send).not.toHaveBeenCalledWith('git.fetch', expect.anything());
  });

  it('shows a definite "not finished loading" state instead of spinning forever when the build never completes', async () => {
    vi.useFakeTimers();
    stubApp({ getRow: () => ({ row: null }) });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await vi.waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());

    // The build never resolves. Advance just past the wait bound — but
    // short of the banner's own auto-clear window, so this checks the
    // message actually landed rather than merely that it eventually clears.
    await vi.advanceTimersByTimeAsync(20_500);

    // The bar legitimately stays up — the build really is still running; what
    // has to change is that the jump stops waiting and says something definite.
    expect(bannerText(rendered.container)).toContain("hasn't finished loading");
    expect(bannerText(rendered.container).toLowerCase()).not.toContain('branch may not be fetched');
  });
});

describe('Pull request selection: the forge round trips', () => {
  it('shows the bar from the first forge request, not only from the row lookup', async () => {
    // Clicking a pull request starts three network round trips before the
    // graph is touched at all. The bar staying dark through them is exactly
    // the gap it exists to close.
    const detail = deferred<typeof pullRequestDetail>();
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: () => ({ row: 42 }),
      overrides: { 'forge.pr.get': () => detail.promise },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    // Let the startup build finish first, or its own bar would be mistaken
    // for the one these three requests are supposed to raise.
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getWindow', expect.anything()));
    await waitFor(() => expect(busyBar(rendered.container)).toBeNull());

    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(busyBar(rendered.container)).not.toBeNull());
    expect(send).not.toHaveBeenCalledWith('graph.getRow', expect.anything());

    detail.resolve(pullRequestDetail);
    await waitFor(() => expect(busyBar(rendered.container)).toBeNull());
  });
});

describe('Pull request head-commit scroll: the commit is genuinely absent', () => {
  it('fetches on its own, with no button to press, and scrolls when the fetch lands', async () => {
    const { fetchCalls } = stubApp({
      graphBuild: resolvedBuild(),
      // The commit only appears once the fetch has run and the graph rebuilt.
      getRow: ({ layoutVersion }) => ({ row: layoutVersion === 1 ? null : 42 }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(fetchCalls()).toBe(1));
    expect(send).toHaveBeenCalledWith('git.fetch', { remote: 'origin' });
    await waitFor(() => expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBeGreaterThan(0));
    // Nothing was explained and nothing was offered: the tool just did it.
    expect(bannerText(rendered.container)).toBe('');
    expect(rendered.queryByRole('button', { name: /^fetch$/i })).toBeNull();
  });

  it('shows the ambient bar while that fetch is in flight', async () => {
    const fetch = deferred<void>();
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: ({ layoutVersion }) => ({ row: layoutVersion === 1 ? null : 42 }),
      overrides: { 'git.fetch': () => fetch.promise },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.fetch', { remote: 'origin' }));
    expect(busyBar(rendered.container)).not.toBeNull();

    fetch.resolve(undefined);
    await waitFor(() => expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBeGreaterThan(0));
    await waitFor(() => expect(busyBar(rendered.container)).toBeNull());
  });

  it('keeps the bar up across the row lookup, not just the build and the fetch', async () => {
    // The gap between a build settling and the fetch starting is a real host
    // round trip; a bar that blinked off in it would read as "finished".
    const rowLookup = deferred<{ row: number | null }>();
    stubApp({ graphBuild: resolvedBuild(), getRow: () => rowLookup.promise });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getRow', {
      hash: 'c'.repeat(40), layoutVersion: 1,
    }));
    expect(busyBar(rendered.container)).not.toBeNull();

    rowLookup.resolve({ row: 42 });
    await waitFor(() => expect(busyBar(rendered.container)).toBeNull());
  });

  it('shows no labelled banner during the fetch — one indicator, and no layout shift', async () => {
    // `.mutation-progress` is an in-flow element above the toolbar with no
    // reserved height: rendering it here would both duplicate the ambient bar
    // and push the graph down and back for the length of the round trip.
    const fetch = deferred<void>();
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: ({ layoutVersion }) => ({ row: layoutVersion === 1 ? null : 42 }),
      overrides: { 'git.fetch': () => fetch.promise },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.fetch', { remote: 'origin' }));
    expect(busyBar(rendered.container)).not.toBeNull();
    expect(rendered.container.querySelector('.mutation-progress')).toBeNull();

    fetch.resolve(undefined);
    await waitFor(() => expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBeGreaterThan(0));
    expect(rendered.container.querySelector('.mutation-progress')).toBeNull();
  });

  it('does not hold the mutation gate, so a checkout during the fetch still runs', async () => {
    // `MutationGate.run` throws when busy rather than queueing. A fetch the
    // user never asked for — and cannot see, the bar being unlabelled — must
    // not be what rejects the action they do ask for.
    const fetch = deferred<void>();
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: ({ layoutVersion }) => ({ row: layoutVersion === 1 ? null : 42 }),
      overrides: { 'git.fetch': () => fetch.promise },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(send).toHaveBeenCalledWith('git.fetch', { remote: 'origin' }));

    await fireEvent.dblClick(rendered.getByRole('button', { name: 'main' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.checkout', { ref: 'main' }));
    expect(bannerText(rendered.container)).toBe('');
    fetch.resolve(undefined);
    await waitFor(() => expect(busyBar(rendered.container)).toBeNull());
    expect(bannerText(rendered.container)).toBe('');
  });

  it('says so when the fetch fails, rather than failing silently', async () => {
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: () => ({ row: null }),
      overrides: { 'git.fetch': () => Promise.reject(new Error('could not read from origin')) },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(bannerText(rendered.container)).toContain('could not read from origin'));
  });

  it('fetches once and then says the commit is still missing, rather than fetching forever', async () => {
    const { fetchCalls } = stubApp({
      graphBuild: resolvedBuild(),
      // The fetch brings nothing new down: the commit stays missing.
      getRow: () => ({ row: null }),
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');

    await waitFor(() => expect(bannerText(rendered.container)).not.toBe(''));
    expect(fetchCalls()).toBe(1);
    expect(bannerText(rendered.container).toLowerCase()).toContain('still');
    // Give a runaway retry loop room to show itself; `stubApp`'s cap turns one
    // into a thrown error and a failed assertion rather than a hung suite.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCalls()).toBe(1);
  });

  it('does not scroll when the panel was closed while the fetch was in flight', async () => {
    // The PR-to-PR case above is caught by the wait guard, because the second
    // selection is still loading when the fetch lands. Closing the panel
    // leaves nothing else in flight, so the graph is ready the moment the
    // fetch returns and the post-fetch guard is the only thing left.
    const fetch = deferred<void>();
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: ({ layoutVersion }) => ({ row: layoutVersion === 1 ? null : 42 }),
      overrides: { 'git.fetch': () => fetch.promise },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(send).toHaveBeenCalledWith('git.fetch', { remote: 'origin' }));

    await fireEvent.click(rendered.getByLabelText('Toggle detail panel'));
    fetch.resolve(undefined);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBe(0);
    expect(send).not.toHaveBeenCalledWith('graph.getRow', { hash: 'c'.repeat(40), layoutVersion: 2 });
  });

  it('does not scroll to a pull request that was superseded while its fetch was in flight', async () => {
    const fetch = deferred<void>();
    stubApp({
      graphBuild: resolvedBuild(),
      getRow: ({ hash, layoutVersion }) => {
        if (layoutVersion === 1) return { row: null };
        return { row: hash === 'c'.repeat(40) ? 42 : null };
      },
      overrides: { 'git.fetch': () => fetch.promise },
    });
    const rendered = render(App);
    await openPullRequestsSection(rendered);
    await clickPullRequest(rendered, 'Add widgets');
    await waitFor(() => expect(send).toHaveBeenCalledWith('git.fetch', { remote: 'origin' }));

    // The user moves on while the fetch is still running.
    await clickPullRequest(rendered, 'Fix gizmos');
    fetch.resolve(undefined);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (rendered.container.querySelector('.scroll-area') as HTMLElement).scrollTop,
    ).toBe(0);
    expect(send).not.toHaveBeenCalledWith('graph.getRow', { hash: 'c'.repeat(40), layoutVersion: 2 });
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

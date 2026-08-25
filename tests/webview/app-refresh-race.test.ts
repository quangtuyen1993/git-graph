import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/webview/App.svelte';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
}));

vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function branch(name: string) {
  return {
    name,
    current: true,
    hash: name.padEnd(40, '0'),
    remote: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}

function windowResult(subject: string, totalRows: number, startRow = 0) {
  const hash = subject.replaceAll(' ', '-').padEnd(40, '0');
  return {
    nodes: [{
      hash,
      abbreviatedHash: hash.slice(0, 7),
      subject,
      author: 'A',
      authorEmail: 'a@example.test',
      authorDate: '2026-08-23T00:00:00Z',
      refs: [],
      parents: [],
      lane: 0,
      row: startRow,
      color: 0,
    }],
    edges: [],
    startRow,
    endRow: startRow + 1,
    totalRows,
    maxLane: 0,
  };
}

// The happy-path fixtures every test starts from. Tests that care about one
// method override just that one and delegate the rest here.
function defaultSend(method: string): Promise<unknown> {
  switch (method) {
    case 'ping.hello':
      return Promise.resolve({ ok: true });
    case 'repo.list':
      return Promise.resolve({ repos: [{ name: 'repo', path: '/repo', active: true }] });
    case 'git.branches':
      return Promise.resolve([branch('initial-branch')]);
    case 'git.tags':
    case 'git.stashList':
    case 'git.worktreeList':
    case 'git.submoduleList':
      return Promise.resolve([]);
    case 'git.status':
      return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
    case 'graph.build':
      return Promise.resolve({ totalRows: 1, maxLane: 0, layoutVersion: 1 });
    case 'graph.getWindow':
      return Promise.resolve(windowResult('initial window', 1));
    default:
      return Promise.resolve(undefined);
  }
}

describe('App graph refresh ordering', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockReset();
  });

  it('does not let stale metadata dispatch a late build or an old window apply after refresh starts', async () => {
    const eventHandlers = new Map<string, () => void>();
    const slowMetadata = {
      branches: deferred<ReturnType<typeof branch>[]>(),
      tags: deferred<[]>(),
      stashes: deferred<[]>(),
      worktrees: deferred<[]>(),
      submodules: deferred<{ name: string; path: string; head: string | null; state: 'initialized' }[]>(),
      status: deferred<{ staged: []; unstaged: []; untracked: []; conflicted: [] }>(),
    };
    const awayWindow = deferred<ReturnType<typeof windowResult>>();
    let metadataRound = 0;
    let slowMetadataSettled = false;
    let buildCount = 0;

    on.mockImplementation((event: string, handler: () => void) => {
      eventHandlers.set(event, handler);
      return vi.fn();
    });
    send.mockImplementation((method: string, params?: unknown) => {
      switch (method) {
        case 'ping.hello':
          return Promise.resolve({ ok: true });
        case 'repo.list':
          return Promise.resolve({ repos: [{ name: 'repo', path: '/repo', active: true }] });
        case 'git.branches':
          metadataRound += 1;
          if (metadataRound === 2) return slowMetadata.branches.promise;
          return Promise.resolve([branch(metadataRound === 1 ? 'initial-branch' : 'new-branch')]);
        case 'git.tags':
          return metadataRound === 2 ? slowMetadata.tags.promise : Promise.resolve([]);
        case 'git.stashList':
          return metadataRound === 2 ? slowMetadata.stashes.promise : Promise.resolve([]);
        case 'git.worktreeList':
          return metadataRound === 2 ? slowMetadata.worktrees.promise : Promise.resolve([]);
        case 'git.submoduleList':
          return metadataRound === 2
            ? slowMetadata.submodules.promise
            : Promise.resolve(metadataRound === 1 ? [] : [{
              name: 'new-sdk', path: 'packages/new-sdk', head: 'f'.repeat(40), state: 'initialized',
            }]);
        case 'git.status':
          return metadataRound === 2
            ? slowMetadata.status.promise
            : Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
        case 'graph.build': {
          buildCount += 1;
          return Promise.resolve({
            totalRows: buildCount === 1 ? 1_000 : 2,
            maxLane: 0,
            layoutVersion: buildCount,
          });
        }
        case 'graph.getWindow': {
          const { startRow, layoutVersion } = params as { startRow: number; layoutVersion: number };
          if (layoutVersion === 1 && startRow > 0) return awayWindow.promise;
          if (layoutVersion === 1) return Promise.resolve(windowResult('initial window', 1_000));
          return Promise.resolve(windowResult(
            slowMetadataSettled ? 'stale refresh window' : 'new atomic window',
            2,
          ));
        }
        default:
          return Promise.resolve(undefined);
      }
    });

    vi.resetModules();
    const { default: App } = await import('../../src/webview/App.svelte');
    const { container } = render(App);
    await waitFor(() => expect(container.textContent).toContain('initial window'));
    await waitFor(() => expect(eventHandlers.has('graph.invalidated')).toBe(true));

    const scrollArea = container.querySelector('.scroll-area') as HTMLDivElement;
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 600 });
    scrollArea.scrollTop = 3_000;
    await fireEvent.scroll(scrollArea);
    await waitFor(() => expect(
      send.mock.calls.filter(([method]) => method === 'graph.getWindow'),
    ).toHaveLength(2));
    expect(send).toHaveBeenLastCalledWith(
      'graph.getWindow',
      expect.objectContaining({ layoutVersion: 1, startRow: expect.any(Number) }),
    );

    eventHandlers.get('graph.invalidated')!();
    await waitFor(() => expect(metadataRound).toBe(2));
    awayWindow.resolve(windowResult('stale scroll window', 1_000, 75));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain('initial window');
    expect(container.textContent).not.toContain('stale scroll window');

    eventHandlers.get('graph.invalidated')!();
    await waitFor(() => expect(metadataRound).toBe(3));
    await waitFor(() => expect(container.textContent).toContain('new atomic window'));
    expect(container.textContent).toContain('new-branch');
    const buildCountAfterLatestRefresh = buildCount;
    const windowCountAfterLatestRefresh = send.mock.calls
      .filter(([method]) => method === 'graph.getWindow').length;

    slowMetadataSettled = true;
    slowMetadata.branches.resolve([branch('stale-branch')]);
    slowMetadata.tags.resolve([]);
    slowMetadata.stashes.resolve([]);
    slowMetadata.worktrees.resolve([]);
    slowMetadata.submodules.resolve([{ name: 'stale-sdk', path: 'packages/stale-sdk', head: 'e'.repeat(40), state: 'initialized' }]);
    slowMetadata.status.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // SUBMODULES is collapsed by default; open it so the submodule metadata
    // this test tracks is observable in the DOM.
    const submodulesHeader = [...container.querySelectorAll('.section-header')]
      .find((candidate) => candidate.textContent?.includes('SUBMODULES'));
    if (submodulesHeader) await fireEvent.click(submodulesHeader);

    expect(buildCount).toBe(buildCountAfterLatestRefresh);
    expect(send.mock.calls.filter(([method]) => method === 'graph.getWindow'))
      .toHaveLength(windowCountAfterLatestRefresh);
    expect(container.textContent).toContain('new atomic window');
    expect(container.textContent).toContain('new-branch');
    expect(container.textContent).toContain('new-sdk');
    expect(container.textContent).not.toContain('stale refresh window');
    expect(container.textContent).not.toContain('stale-branch');
    expect(container.textContent).not.toContain('stale-sdk');
  });

  it('does not surface a superseded build as a startup error', async () => {
    // invalidate() bumps the generation before the event is sent, so the very
    // first build can lose the race. That must not paint an error banner.
    send.mockImplementation((method: string) => {
      if (method === 'graph.build') {
        return Promise.reject(Object.assign(new Error('Graph build superseded'), {
          kind: 'GRAPH_BUILD_SUPERSEDED',
        }));
      }
      return defaultSend(method);
    });

    const { container } = render(App);
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', expect.anything()));

    expect(container.querySelector('.error')).toBeNull();
    expect(container.textContent).not.toContain('Error');
  });

  it('subscribes to graph.invalidated before the first refresh', async () => {
    // An invalidation during startup must not be dropped, or the graph stays
    // stale until the next unrelated event.
    const order: string[] = [];
    on.mockImplementation((event: string) => { order.push(`on:${event}`); return () => {}; });
    send.mockImplementation((method: string) => {
      order.push(`send:${method}`);
      return defaultSend(method);
    });

    render(App);
    await waitFor(() => expect(order).toContain('send:graph.build'));

    // Without this the assertion below is vacuous: indexOf returns -1 for an
    // unregistered listener, which is trivially less than the build index.
    expect(order).toContain('on:graph.invalidated');
    expect(order.indexOf('on:graph.invalidated')).toBeLessThan(order.indexOf('send:graph.build'));
  });

  it('collapses a burst of invalidations into a single refresh', async () => {
    vi.useFakeTimers();
    try {
      let invalidate!: () => void;
      on.mockImplementation((event: string, handler: () => void) => {
        if (event === 'graph.invalidated') invalidate = handler;
        return () => {};
      });
      send.mockImplementation((method: string) => defaultSend(method));

      render(App);
      await vi.waitFor(() => expect(invalidate).toBeTypeOf('function'));
      // The listener is now registered synchronously, so wait for startup's own
      // build to land before counting; otherwise it lands inside the window
      // below and is misread as a second refresh.
      await vi.waitFor(() => expect(
        send.mock.calls.some(([m]) => m === 'graph.build'),
      ).toBe(true));
      const before = send.mock.calls.filter(([m]) => m === 'graph.build').length;

      invalidate(); invalidate(); invalidate();
      await vi.advanceTimersByTimeAsync(200);

      const after = send.mock.calls.filter(([m]) => m === 'graph.build').length;
      expect(after - before).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

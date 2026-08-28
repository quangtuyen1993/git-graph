import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

const TOTAL_ROWS = 1_000;
/** jsdom reports clientHeight 0, so the component keeps its own default. */
const VIEWPORT_HEIGHT = 600;

interface ShortStat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

function node(hash: string, row: number) {
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    subject: `commit ${hash.slice(0, 1)}`,
    author: 'A',
    authorEmail: 'a@example.test',
    authorDate: '2026-08-25T00:00:00Z',
    refs: [],
    parents: [],
    lane: 0,
    row,
    color: 0,
    filesChanged: null,
    additions: null,
    deletions: null,
  };
}

/**
 * Two overlapping windows, so scrolling from one to the other re-renders a row
 * (`HASH_B`) the webview has already asked about — the shape requirement 3 is
 * about.
 */
function nearWindow() {
  return {
    nodes: [node(HASH_A, 0), node(HASH_B, 39)],
    edges: [],
    startRow: 0,
    endRow: 40,
    totalRows: TOTAL_ROWS,
    maxLane: 0,
  };
}

function farWindow() {
  return {
    nodes: [node(HASH_B, 39), node(HASH_C, 60)],
    edges: [],
    startRow: 30,
    endRow: 70,
    totalRows: TOTAL_ROWS,
    maxLane: 0,
  };
}

const branch = {
  name: 'main',
  current: true,
  hash: 'f'.repeat(40),
  remote: null,
  upstream: null,
  ahead: 0,
  behind: 0,
};

type StatsResponder = (hashes: string[], call: number) => Promise<Record<string, ShortStat | null>>;

function statsCalls(): string[][] {
  return send.mock.calls
    .filter(([method]) => method === 'graph.getStats')
    .map(([, params]) => (params as { hashes: string[] }).hashes);
}

async function renderApp(statsResponder: StatsResponder) {
  let statsCall = 0;
  send.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [branch];
      case 'git.tags':
      case 'git.stashList':
      case 'git.worktreeList':
      case 'git.submoduleList': return [];
      case 'review.list': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: TOTAL_ROWS, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow':
        return (params as { startRow: number }).startRow === 0 ? nearWindow() : farWindow();
      case 'graph.getStats': {
        statsCall += 1;
        return statsResponder((params as { hashes: string[] }).hashes, statsCall);
      }
      default: return null;
    }
  });
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));

  const rendered = render(App);
  await waitFor(() => expect(rendered.container.textContent).toContain('commit a'));
  return rendered;
}

function rowFor(container: HTMLElement, letter: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.commit-row'))
    .find((row) => row.textContent?.includes(`commit ${letter}`));
}

async function scrollTo(container: HTMLElement, scrollTop: number) {
  const scrollArea = container.querySelector('.scroll-area') as HTMLDivElement;
  Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT });
  scrollArea.scrollTop = scrollTop;
  await fireEvent.scroll(scrollArea);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('App commit stats', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockReset();
    on.mockImplementation(() => vi.fn());
  });

  it('asks graph.getStats for the hashes of the window it has just rendered', async () => {
    await renderApp(async () => ({}));

    await waitFor(() => expect(statsCalls()).toHaveLength(1));
    expect(statsCalls()[0]).toEqual([HASH_A, HASH_B]);
  });

  it('carries a resolved stat onto the rendered row, and leaves an unanswered hash alone', async () => {
    const { container } = await renderApp(async () => ({
      [HASH_A]: { filesChanged: 3, additions: 10, deletions: 2 },
      [HASH_B]: null,
    }));

    await waitFor(() => {
      expect(rowFor(container, 'a')?.getAttribute('data-files-changed')).toBe('3');
    });
    expect(rowFor(container, 'a')?.getAttribute('data-additions')).toBe('10');
    expect(rowFor(container, 'a')?.getAttribute('data-deletions')).toBe('2');
    // `null` from the host is "git printed no stat line", not "zero files".
    expect(rowFor(container, 'b')?.hasAttribute('data-files-changed')).toBe(false);
  });

  it('does not ask again for a hash it already has stats for', async () => {
    const { container } = await renderApp(async (hashes) => Object.fromEntries(
      hashes.map((hash) => [hash, { filesChanged: 1, additions: 1, deletions: 0 }]),
    ));

    await waitFor(() => expect(statsCalls()).toHaveLength(1));

    await scrollTo(container, 1_600);
    await waitFor(() => expect(rowFor(container, 'c')).toBeTruthy());
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
    // HASH_B was in the first call and is on screen again; only HASH_C is new.
    expect(statsCalls()[1]).toEqual([HASH_C]);

    // Scrolling back over rows whose stats are all known asks for nothing, and
    // the freshly delivered nodes still carry the stats from the cache.
    await scrollTo(container, 0);
    await waitFor(() => expect(rowFor(container, 'a')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statsCalls()).toHaveLength(2);
    expect(rowFor(container, 'a')?.getAttribute('data-files-changed')).toBe('1');
  });

  it('does not put the same hash in flight twice while a request is outstanding', async () => {
    const pending = deferred<Record<string, ShortStat | null>>();
    const { container } = await renderApp(async (_hashes, call) => (
      call === 1 ? pending.promise : {}
    ));

    await waitFor(() => expect(statsCalls()).toHaveLength(1));

    await scrollTo(container, 1_600);
    await waitFor(() => expect(rowFor(container, 'c')).toBeTruthy());
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
    // HASH_B is still in flight from call 1 — a second git spawn for it would
    // queue behind the first inside GitCLI and delay every later git call.
    expect(statsCalls()[1]).toEqual([HASH_C]);

    pending.resolve({ [HASH_A]: { filesChanged: 4, additions: 1, deletions: 1 }, [HASH_B]: null });
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
  });

  it('leaves the rows at their default when graph.getStats rejects, surfacing nothing', async () => {
    const { container } = await renderApp(async () => { throw new Error('git exploded'); });

    await waitFor(() => expect(statsCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rowFor(container, 'a')).toBeTruthy();
    expect(rowFor(container, 'a')?.hasAttribute('data-files-changed')).toBe(false);
    expect(container.textContent).not.toContain('git exploded');
  });
});

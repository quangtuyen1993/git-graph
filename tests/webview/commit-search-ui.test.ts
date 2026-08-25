import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';
import { ROW_HEIGHT } from '../../src/webview/lib/virtual-scroll';

const PLACEHOLDER = 'Search commit message or hash...';
const DEBOUNCE_MS = 300;

/*
 * The graph centres a row on its own viewport height, which starts at 600 and
 * only tracks the scroll container once a scroll event lands — jsdom reports a
 * clientHeight of 0, so the render keeps that default. Pinning
 * window.innerHeight to the same number keeps the expected scroll arithmetic
 * readable instead of mixing two heights.
 */
const DEFAULT_VIEWPORT_HEIGHT = 600;

const branch = {
  name: 'main',
  current: true,
  hash: 'f'.repeat(40),
  remote: null,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
};

const TOTAL_ROWS = 100;

interface SearchFixtures {
  hashes?: string[];
  rows?: Record<string, number | null>;
}

/** Drains pending microtasks — timer-free, so it also works under fake timers. */
async function settle(iterations = 100): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function nodesFor(rows: Record<string, number | null>) {
  return Object.entries(rows)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([hash, row]) => ({
      hash,
      abbreviatedHash: hash.slice(0, 7),
      subject: `commit ${hash.slice(0, 4)}`,
      author: 'A',
      authorEmail: 'a@example.test',
      authorDate: '2026-08-25T00:00:00Z',
      refs: [],
      parents: [],
      lane: 0,
      row,
      color: 0,
    }));
}

async function renderApp(fixtures: SearchFixtures = {}) {
  const rows = fixtures.rows ?? {};
  const nodes = nodesFor(rows);

  send.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [branch];
      case 'git.tags': return [];
      case 'git.stashList': return [];
      case 'git.worktreeList': return [];
      case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: TOTAL_ROWS, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return {
        nodes,
        edges: [],
        startRow: 0,
        endRow: TOTAL_ROWS,
        totalRows: TOTAL_ROWS,
        maxLane: 0,
      };
      case 'git.searchCommits': return fixtures.hashes ?? [];
      case 'graph.getRow': return { row: rows[(params as { hash: string }).hash] ?? null };
      default: return null;
    }
  });
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  Object.defineProperty(window, 'innerHeight', {
    value: DEFAULT_VIEWPORT_HEIGHT,
    configurable: true,
    writable: true,
  });

  const rendered = render(App);
  await settle();
  return { ...rendered, send };
}

async function searchFor(query: string, fixtures: SearchFixtures) {
  const rendered = await renderApp(fixtures);
  await fireEvent.click(rendered.getByLabelText('Search commits'));
  await settle();

  await fireEvent.input(rendered.getByPlaceholderText(PLACEHOLDER), { target: { value: query } });
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));
  await waitFor(() => expect(send).toHaveBeenCalledWith('git.searchCommits', { query }));
  await settle();

  const search = rendered.container.querySelector('.commit-search') as HTMLElement;
  return { ...rendered, search, send };
}

describe('Commit search in the graph toolbar', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('stays collapsed until the search button is pressed', async () => {
    const { getByLabelText, queryByPlaceholderText } = await renderApp();
    expect(queryByPlaceholderText('Search commit message or hash...')).toBeNull();

    await fireEvent.click(getByLabelText('Search commits'));
    expect(queryByPlaceholderText('Search commit message or hash...')).not.toBeNull();
  });

  it('debounces typing into a single search request', async () => {
    vi.useFakeTimers();
    try {
      const { getByLabelText, getByPlaceholderText, send } = await renderApp();
      await fireEvent.click(getByLabelText('Search commits'));
      const input = getByPlaceholderText('Search commit message or hash...');

      await fireEvent.input(input, { target: { value: 'fi' } });
      await fireEvent.input(input, { target: { value: 'fix' } });
      await fireEvent.input(input, { target: { value: 'fix l' } });
      await vi.advanceTimersByTimeAsync(300);

      const searches = send.mock.calls.filter(([m]) => m === 'git.searchCommits');
      expect(searches).toHaveLength(1);
      expect(searches[0][1]).toEqual({ query: 'fix l' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolls to the matched row and shows the match counter', async () => {
    const { search, send, container } = await searchFor('fix', {
      hashes: ['a'.repeat(40), 'b'.repeat(40)],
      rows: { ['a'.repeat(40)]: 12, ['b'.repeat(40)]: 40 },
    });

    expect(send).toHaveBeenCalledWith('graph.getRow', { hash: 'a'.repeat(40), layoutVersion: 1 });
    expect(search.textContent).toContain('1/2');
    // The row is centred, matching the existing sidebar branch-select behaviour.
    expect((container.querySelector('.scroll-area') as HTMLElement).scrollTop)
      .toBe(Math.max(0, 12 * ROW_HEIGHT - Math.floor(DEFAULT_VIEWPORT_HEIGHT / 2)));
  });

  it('cycles to the next match and wraps', async () => {
    const { getByLabelText, send } = await searchFor('fix', {
      hashes: ['a'.repeat(40), 'b'.repeat(40)],
      rows: { ['a'.repeat(40)]: 12, ['b'.repeat(40)]: 40 },
    });

    await fireEvent.click(getByLabelText('Next match'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getRow', { hash: 'b'.repeat(40), layoutVersion: 1 }));

    await fireEvent.click(getByLabelText('Next match'));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith('graph.getRow', { hash: 'a'.repeat(40), layoutVersion: 1 }));
  });

  it('reports when nothing matches', async () => {
    const { search } = await searchFor('nothing', { hashes: [], rows: {} });
    expect(search.textContent).toContain('No commits found');
  });

  it('explains when the match is filtered out of the graph', async () => {
    const { search } = await searchFor('fix', {
      hashes: ['a'.repeat(40)],
      rows: { ['a'.repeat(40)]: null },
    });
    expect(search.textContent).toContain('outside the current branch filter');
  });

  it('clears results and highlight on Escape', async () => {
    const { getByPlaceholderText, container } = await searchFor('fix', {
      hashes: ['a'.repeat(40)],
      rows: { ['a'.repeat(40)]: 0 },
    });
    expect(container.querySelector('.search-match')).not.toBeNull();

    await fireEvent.keyDown(getByPlaceholderText('Search commit message or hash...'), { key: 'Escape' });
    expect(container.querySelector('.search-match')).toBeNull();
  });
});

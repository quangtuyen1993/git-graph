import { readFileSync } from 'fs';
import { resolve } from 'path';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const PARENT = 'f'.repeat(40);
const OTHER_PARENT = 'e'.repeat(40);

/** One parent, no files changed — the only shape that dims. */
const HASH_EMPTY = 'a'.repeat(40);
/** Two parents. git prints no stat line for a merge, so its numbers say nothing. */
const HASH_MERGE = 'b'.repeat(40);
/** The host answered `null`: not known, which is not the same as empty. */
const HASH_UNKNOWN = 'c'.repeat(40);
/** No parents. A root commit is an ordinary single-parent commit for this rule. */
const HASH_ROOT = 'd'.repeat(40);

const SEARCH_PLACEHOLDER = 'Search commit message or hash...';
const SEARCH_DEBOUNCE_MS = 300;

interface ShortStat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

const NO_FILES: ShortStat = { filesChanged: 0, additions: 0, deletions: 0 };

function node(hash: string, row: number, parents: string[]) {
  return {
    hash,
    abbreviatedHash: hash.slice(0, 7),
    subject: `commit ${hash.slice(0, 1)}`,
    author: 'A',
    authorEmail: 'a@example.test',
    authorDate: '2026-08-25T00:00:00Z',
    refs: [],
    parents,
    lane: 0,
    row,
    color: 0,
    filesChanged: null,
    additions: null,
    deletions: null,
  };
}

function graphWindow() {
  return {
    nodes: [
      node(HASH_EMPTY, 0, [PARENT]),
      node(HASH_MERGE, 1, [PARENT, OTHER_PARENT]),
      node(HASH_UNKNOWN, 2, [PARENT]),
      node(HASH_ROOT, 3, []),
    ],
    edges: [],
    startRow: 0,
    endRow: 4,
    totalRows: 4,
    maxLane: 0,
  };
}

// The branch HEAD is the empty commit, so jumping to the branch focuses the
// very row this rule would otherwise dim.
const branch = {
  name: 'main',
  current: true,
  hash: HASH_EMPTY,
  remote: null,
  upstream: null,
  ahead: 0,
  behind: 0,
};

const STATS: Record<string, ShortStat | null> = {
  [HASH_EMPTY]: NO_FILES,
  [HASH_MERGE]: NO_FILES,
  [HASH_UNKNOWN]: null,
  [HASH_ROOT]: NO_FILES,
};

async function renderApp(options: {
  stats?: () => Promise<Record<string, ShortStat | null>>;
  searchHits?: string[];
} = {}) {
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [branch];
      case 'git.tags':
      case 'git.stashList':
      case 'git.worktreeList':
      case 'git.submoduleList':
      case 'review.list': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 4, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return graphWindow();
      case 'graph.getRow': return { row: 0 };
      case 'graph.getStats': return options.stats ? options.stats() : STATS;
      case 'git.searchCommits': return options.searchHits ?? [];
      default: return null;
    }
  });
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));

  const rendered = render(App);
  await waitFor(() => expect(rendered.container.textContent).toContain('commit a'));
  return rendered;
}

function rowFor(container: HTMLElement, letter: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.commit-row'))
    .find((candidate) => candidate.textContent?.includes(`commit ${letter}`));
  if (!row) throw new Error(`no row rendered for commit ${letter}`);
  return row;
}

describe('Dimming a commit that changed no files', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockReset();
    on.mockImplementation(() => vi.fn());
  });

  it('dims a single-parent commit once its stats say no files changed', async () => {
    const { container } = await renderApp();

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));
  });

  it('dims a root commit like any other single-parent commit', async () => {
    const { container } = await renderApp();

    await waitFor(() => expect(rowFor(container, 'd')).toHaveClass('dimmed'));
  });

  it('never dims a merge, whatever its stats report', async () => {
    const { container } = await renderApp();

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));
    expect(rowFor(container, 'b')).not.toHaveClass('dimmed');
  });

  it('never dims a row whose stats are unknown', async () => {
    const { container } = await renderApp();

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));
    // `null` is "not known yet", not "known to be empty".
    expect(rowFor(container, 'c')).not.toHaveClass('dimmed');
  });

  it('leaves every row undimmed until the stats arrive', async () => {
    let releaseStats!: (stats: Record<string, ShortStat | null>) => void;
    const pending = new Promise<Record<string, ShortStat | null>>((res) => { releaseStats = res; });
    const { container } = await renderApp({ stats: () => pending });

    // The rule must not fire off the default `null`, or a row flashes dim
    // between render and the stats landing.
    expect(container.querySelectorAll('.commit-row.dimmed')).toHaveLength(0);

    releaseStats(STATS);
    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));
  });

  it('does not dim the selected row', async () => {
    const { container } = await renderApp();
    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));

    await fireEvent.click(rowFor(container, 'a'));

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('selected'));
    expect(rowFor(container, 'a')).not.toHaveClass('dimmed');
  });

  it('does not dim a search match', async () => {
    const { container, getByLabelText, getByPlaceholderText } = await renderApp({
      searchHits: [HASH_EMPTY],
    });
    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));

    await fireEvent.click(getByLabelText('Search commits'));
    await fireEvent.input(getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'anything' } });
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('search-match'));
    expect(rowFor(container, 'a')).not.toHaveClass('dimmed');
  });

  it('does not dim the row picked as the compare base', async () => {
    // A pending compare base is a live user pick whose only affordance is a
    // 1px dashed outline. Fading its subject and sha underneath that breaks the
    // same rule the other three exclusions exist for: whatever the user is
    // currently looking at does not quietly fade.
    const { container, getByRole } = await renderApp();
    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));

    await fireEvent.contextMenu(rowFor(container, 'a'));
    await waitFor(() => expect(getByRole('menuitem', { name: 'Select for compare' })).toBeInTheDocument());
    await fireEvent.click(getByRole('menuitem', { name: 'Select for compare' }));

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('compare-selected'));
    // Not merely undimmed because the right-click selected it.
    expect(rowFor(container, 'a')).not.toHaveClass('selected');
    expect(rowFor(container, 'a')).not.toHaveClass('dimmed');
  });

  it('does not dim the branch-focused row', async () => {
    const { container, getByRole } = await renderApp();
    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('dimmed'));

    await fireEvent.click(getByRole('button', { name: 'main' }));

    await waitFor(() => expect(rowFor(container, 'a')).toHaveClass('branch-focused'));
    expect(rowFor(container, 'a')).not.toHaveClass('dimmed');
  });
});

describe('The dim rule itself', () => {
  /*
   * jsdom resolves no scoped <style> and performs no layout, so
   * getComputedStyle reports nothing for these rules and any assertion on the
   * opacity would pass whatever the stylesheet said. The source is read
   * instead. The 0.55 value's legibility is unverifiable by test either way and
   * is checked by eye, per the spec.
   */
  const source = readFileSync(resolve(__dirname, '../../src/webview/App.svelte'), 'utf8');
  const ruleStart = source.indexOf('.commit-row.dimmed .col-');
  const rule = ruleStart === -1 ? '' : source.slice(ruleStart);
  const selectors = rule.slice(0, rule.indexOf('{'));

  it('fades the four text columns', () => {
    for (const column of ['.col-message', '.col-date', '.col-sha', '.col-author']) {
      expect(selectors).toContain(`.commit-row.dimmed ${column}`);
    }
  });

  it('leaves the graph column at full strength', () => {
    // Without this the assertion below would also pass when there is no rule
    // at all, which is the one way it must not pass.
    expect(selectors).toContain('.commit-row.dimmed');
    // The lane and its edges must stay readable through an empty commit.
    expect(selectors).not.toContain('.col-graph');
  });

  /** The rules, comments stripped, of the component's own <style> block. */
  const styleBlock = source
    .slice(source.lastIndexOf('<style>'), source.lastIndexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * The opacity declared by the last rule whose selector list contains exactly
   * `selector`, or `null` when no rule declares one for it.
   */
  function declaredOpacity(selector: string): number | null {
    let found: number | null = null;
    for (const [, selectors, body] of styleBlock.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (!selectors.split(',').map((one) => one.trim()).includes(selector)) continue;
      const declaration = /(?:^|[;\s])opacity:\s*([\d.]+)/.exec(body);
      if (declaration) found = Number(declaration[1]);
    }
    return found;
  }

  it('lands a dimmed row author at 0.55 rather than compounding two fades', () => {
    // `.author-name` carries its own 0.7 so the name recedes behind the
    // subject. Opacity composes multiplicatively, so without an override the
    // dimmed row renders it at 0.385 — a value nobody chose, and one the manual
    // legibility check would sign off believing it saw 0.55.
    const column = declaredOpacity('.commit-row.dimmed .col-author');
    expect(column).toBe(0.55);
    expect(declaredOpacity('.author-name')).toBe(0.7);

    const name = declaredOpacity('.commit-row.dimmed .col-author .author-name');
    expect(name).not.toBeNull();
    expect((column as number) * (name as number)).toBeCloseTo(0.55, 5);
  });

  it('fades with opacity rather than repainting the text colour', () => {
    const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
    expect(body).toContain('opacity: 0.55');
    expect(body).not.toContain('color:');
    expect(body).not.toContain('filter:');
  });
});

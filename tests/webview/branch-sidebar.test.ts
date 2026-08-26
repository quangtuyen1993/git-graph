import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BranchSidebar from '../../src/webview/components/sidebar/BranchSidebar.svelte';

const branches = [
  {
    name: 'main',
    current: true,
    hash: 'a'.repeat(40),
    remote: null,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
  },
];

const groupedBranches = [
  { ...branches[0], name: 'fix/abc/abcd', current: true },
  { ...branches[0], name: 'fix/abc/abce', current: false },
  { ...branches[0], name: 'fix/other/one', current: false },
  { ...branches[0], name: 'feat/team/two', current: false },
  { ...branches[0], name: 'origin/fix/abc/remote', current: false, remote: 'origin' },
];

const tags = [{ name: 'v1.0.0', hash: 'b'.repeat(40), message: null, taggerDate: null }];
const stashes = [{ index: 0, message: 'save work', date: '2026-08-23', branch: 'main', hash: 'c'.repeat(40) }];
const worktrees = [
  { path: '/repo', head: 'd'.repeat(40), branch: 'main', bare: false, isMain: true },
  { path: '/repo/feature', head: 'e'.repeat(40), branch: 'feature', bare: false, isMain: false },
];
const submodules = [
  { name: 'sdk', path: 'packages/sdk', head: 'f'.repeat(40), state: 'initialized' as const },
  { name: 'ui-kit', path: 'packages/ui-kit', head: '1234567890abcdef'.repeat(2) + '12345678', state: 'modified' as const },
  { name: 'legacy', path: 'vendor/legacy', head: null, state: 'uninitialized' as const },
];

const pullRequests = [
  {
    id: 'pr-1', number: 42, title: 'Add feature', state: 'open' as const,
    sourceBranch: 'feature/x', reviewers: [], commentCount: 0,
  },
];

/**
 * Only LOCAL is expanded by default, so any test that reaches into another
 * section has to open it first — the same click a user makes.
 */
async function expandSections(container: HTMLElement, ...titles: string[]): Promise<void> {
  for (const title of titles) {
    const header = [...container.querySelectorAll('.section-header')]
      .find((candidate) => candidate.textContent?.includes(title));
    if (header) await fireEvent.click(header);
  }
}

const ALL_SECTIONS = ['REMOTE', 'TAGS', 'STASHES', 'WORKTREES', 'SUBMODULES'];

/** Render with every section open, matching the pre-collapse default. */
async function renderExpanded(props: Record<string, unknown>) {
  const rendered = render(BranchSidebar, props);
  await expandSections(rendered.container, ...ALL_SECTIONS);
  return rendered;
}

describe('BranchSidebar', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 120,
      height: 24,
      top: 40,
      right: 130,
      bottom: 64,
      left: 10,
      x: 10,
      y: 40,
      toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  it('opens only LOCAL by default, leaving the other sections collapsed', () => {
    const { container, getByRole, queryByRole } = render(BranchSidebar, {
      branches, tags, stashes, worktrees, submodules,
    });

    // LOCAL's contents are reachable without any interaction.
    expect(getByRole('button', { name: 'main' })).toBeEnabled();

    // The rest cost vertical space the branch list needs, so they start closed.
    expect(queryByRole('button', { name: /v1\.0\.0/ })).toBeNull();
    expect(queryByRole('button', { name: /save work/ })).toBeNull();
    expect(container.querySelector('.remote-header')).toBeNull();
  });

  it('still expands the active branch ancestors inside LOCAL', () => {
    const { getByRole } = render(BranchSidebar, { branches: groupedBranches, tags, stashes, worktrees });

    expect(getByRole('button', { name: 'fix/abc/abcd' })).toHaveAttribute('aria-current', 'true');
  });

  it('uses focusable semantic buttons for local branches, tags, stashes, and worktrees', async () => {
    const { getByRole } = await renderExpanded({ branches, tags, stashes, worktrees });

    expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-current', 'true');
    expect(getByRole('button', { name: /v1\.0\.0/ })).toBeEnabled();
    expect(getByRole('button', { name: /save work/ })).toBeEnabled();
  });

  it.each(['Enter', ' '])('selects a local branch when %s activates it', async (key) => {
    const { component, getByRole } = await renderExpanded({ branches, tags, stashes, worktrees });
    const onSelect = vi.fn();
    component.$on('branchSelect', onSelect);

    await fireEvent.keyDown(getByRole('button', { name: 'main' }), { key });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
  });

  it('nests branch path segments and expands only the active branch ancestors', async () => {
    const { getByRole, queryByRole } = await renderExpanded({
      branches: groupedBranches,
      tags,
      stashes,
      worktrees,
    });

    expect(getByRole('button', { name: 'Branch group fix' })).toHaveAttribute('aria-expanded', 'true');
    const nestedGroup = getByRole('button', { name: 'Branch group fix/abc' });
    expect(nestedGroup).toHaveAttribute('aria-expanded', 'true');
    expect(nestedGroup).toHaveStyle('--tree-indent: 32px');
    const activeBranch = getByRole('button', { name: 'fix/abc/abcd' });
    expect(activeBranch).toHaveAttribute('aria-current', 'true');
    expect(activeBranch).toHaveStyle('--tree-indent: 48px');
    expect(activeBranch.querySelector('.branch-name')).toHaveTextContent(/^abcd$/);
    expect(getByRole('button', { name: 'fix/abc/abce' })).toBeEnabled();
    expect(getByRole('button', { name: 'Branch group fix/other' })).toHaveAttribute('aria-expanded', 'false');
    expect(queryByRole('button', { name: 'fix/other/one' })).toBeNull();
    expect(getByRole('button', { name: 'Branch group feat' })).toHaveAttribute('aria-expanded', 'false');
    expect(queryByRole('button', { name: 'feat/team/two' })).toBeNull();
    expect(getByRole('button', { name: 'Remote group origin' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('nests remote branch paths after the collapsed remote group is opened', async () => {
    const remoteOnly = groupedBranches.filter(branch => branch.remote);
    const { getByRole, queryByRole } = await renderExpanded({
      branches: remoteOnly,
      tags,
      stashes,
      worktrees,
    });

    await fireEvent.click(getByRole('button', { name: 'Remote group origin' }));
    expect(getByRole('button', { name: 'Branch group fix' })).toHaveAttribute('aria-expanded', 'false');
    expect(queryByRole('button', { name: 'origin/fix/abc/remote' })).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Branch group fix' }));
    await fireEvent.click(getByRole('button', { name: 'Branch group fix/abc' }));
    expect(getByRole('button', { name: 'origin/fix/abc/remote' })).toHaveTextContent('remote');
  });

  it('keeps manual expand and collapse choices when the active branch changes', async () => {
    const { component, getByRole, queryByRole } = await renderExpanded({
      branches: groupedBranches,
      tags,
      stashes,
      worktrees,
    });

    await fireEvent.click(getByRole('button', { name: 'Branch group fix' }));
    await fireEvent.click(getByRole('button', { name: 'Branch group feat' }));
    await fireEvent.click(getByRole('button', { name: 'Branch group feat/team' }));

    component.$set({
      branches: groupedBranches.map(branch => ({
        ...branch,
        current: branch.name === 'feat/team/two',
      })),
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Branch group fix' })).toHaveAttribute('aria-expanded', 'false');
      expect(getByRole('button', { name: 'Branch group feat' })).toHaveAttribute('aria-expanded', 'true');
      expect(getByRole('button', { name: 'Branch group feat/team' })).toHaveAttribute('aria-expanded', 'true');
      expect(getByRole('button', { name: 'feat/team/two' })).toHaveAttribute('aria-current', 'true');
      expect(queryByRole('button', { name: 'fix/abc/abcd' })).toBeNull();
    });
  });

  it('selects on a single click and marks the selected branch', async () => {
    vi.useFakeTimers();
    const { component, getByRole } = await renderExpanded({
      branches,
      tags,
      stashes,
      worktrees,
      selectedBranch: 'main',
    });
    const onSelect = vi.fn();
    component.$on('branchSelect', onSelect);
    const row = getByRole('button', { name: 'main' });

    expect(row).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(row);
    await vi.advanceTimersByTimeAsync(250);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
  });

  it('keeps double-click checkout from also selecting', async () => {
    vi.useFakeTimers();
    const { component, getByRole } = await renderExpanded({ branches, tags, stashes, worktrees });
    const onCheckout = vi.fn();
    const onSelect = vi.fn();
    component.$on('checkout', onCheckout);
    component.$on('branchSelect', onSelect);

    await fireEvent.dblClick(getByRole('button', { name: 'main' }));
    await vi.advanceTimersByTimeAsync(250);

    expect(onCheckout).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['click', 'Enter', ' '])('dispatches tag checkout, stash apply, and non-main worktree open on %s', async (activation) => {
    const { component, getByRole } = await renderExpanded({ branches, tags, stashes, worktrees });
    const onCheckout = vi.fn();
    const onStashApply = vi.fn();
    const onWorktreeOpen = vi.fn();
    component.$on('checkout', onCheckout);
    component.$on('stashApply', onStashApply);
    component.$on('worktreeOpen', onWorktreeOpen);

    const activate = async (element: HTMLElement) => {
      if (activation === 'click') {
        await fireEvent.click(element);
      } else {
        await fireEvent.keyDown(element, { key: activation });
      }
    };

    await activate(getByRole('button', { name: /v1\.0\.0/ }));
    await activate(getByRole('button', { name: /save work/ }));
    await activate(getByRole('button', { name: /worktree feature/i }));

    expect(onCheckout).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'v1.0.0' } }));
    expect(onStashApply).toHaveBeenCalledWith(expect.objectContaining({ detail: { index: 0 } }));
    expect(onWorktreeOpen).toHaveBeenCalledWith(expect.objectContaining({ detail: { path: '/repo/feature' } }));
  });

  it('does not open the main worktree as a primary action', async () => {
    const { component, getByRole } = await renderExpanded({ branches, tags, stashes, worktrees });
    const onWorktreeOpen = vi.fn();
    component.$on('worktreeOpen', onWorktreeOpen);

    await fireEvent.click(getByRole('button', { name: /worktree main/i }));

    expect(onWorktreeOpen).not.toHaveBeenCalled();
  });

  it.each(['click', 'Enter', ' '])('requests a submodule tab on %s', async (activation) => {
    const { component, getByRole } = await renderExpanded({ branches, tags, stashes, worktrees, submodules });
    const open = vi.fn();
    component.$on('submoduleOpen', open);
    const row = getByRole('button', { name: /submodule sdk.*packages\/sdk.*initialized/i });
    if (activation === 'click') await fireEvent.click(row);
    else await fireEvent.keyDown(row, { key: activation });

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { path: 'packages/sdk' } }));
  });

  it('shows the submodule count, can collapse rows, and labels uninitialized entries', async () => {
    const { getByRole, queryByRole } = await renderExpanded({ branches, tags, stashes, worktrees, submodules });
    const header = getByRole('button', { name: /submodules.*3/i });

    expect(getByRole('button', { name: /submodule legacy.*vendor\/legacy.*uninitialized/i })).toBeEnabled();
    await fireEvent.click(header);
    expect(queryByRole('button', { name: /submodule sdk.*packages\/sdk.*initialized/i })).toBeNull();
  });

  it.each([
    {
      name: 'sdk',
      state: 'initialized',
      shortHead: 'fffffff',
      accessibleName: 'Submodule sdk, packages/sdk, fffffff, initialized',
    },
    {
      name: 'ui-kit',
      state: 'modified',
      shortHead: '1234567',
      accessibleName: 'Submodule ui-kit, packages/ui-kit, 1234567, modified',
    },
  ])('shows and exposes the abbreviated head for $state submodule $name', async ({ accessibleName, shortHead }) => {
    const { getByRole } = await renderExpanded({ branches, tags, stashes, worktrees, submodules });

    const row = getByRole('button', { name: accessibleName });
    expect(row.querySelector('.submodule-head')).toHaveTextContent(new RegExp(`^${shortHead}$`));
  });

  it('does not show a head for an uninitialized submodule with a null head', async () => {
    const { getByRole } = await renderExpanded({ branches, tags, stashes, worktrees, submodules });

    const row = getByRole('button', { name: /submodule legacy.*vendor\/legacy.*uninitialized/i });
    expect(row.querySelector('.submodule-head')).toBeNull();
    expect(row).not.toHaveAccessibleName(/[0-9a-f]{7}/i);
  });

  it('opens context menus from Shift+F10 at the focused entry bounding box', async () => {
    const { component, getByRole } = await renderExpanded({ branches, tags, stashes, worktrees });
    const branchMenu = vi.fn();
    const tagMenu = vi.fn();
    const stashMenu = vi.fn();
    const worktreeMenu = vi.fn();
    component.$on('branchContextMenu', branchMenu);
    component.$on('tagContextMenu', tagMenu);
    component.$on('stashContextMenu', stashMenu);
    component.$on('worktreeContextMenu', worktreeMenu);

    await fireEvent.keyDown(getByRole('button', { name: 'main' }), { key: 'F10', shiftKey: true });
    await fireEvent.keyDown(getByRole('button', { name: /v1\.0\.0/ }), { key: 'F10', shiftKey: true });
    await fireEvent.keyDown(getByRole('button', { name: /save work/ }), { key: 'F10', shiftKey: true });
    await fireEvent.keyDown(getByRole('button', { name: /worktree main/i }), { key: 'F10', shiftKey: true });

    for (const listener of [branchMenu, tagMenu, stashMenu, worktreeMenu]) {
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail.event).toEqual(expect.objectContaining({ clientX: 10, clientY: 64 }));
    }
  });
});

describe('sidebar state persistence contract', () => {
  it('applies the sections named by initialState', () => {
    const { container } = render(BranchSidebar, {
      branches: groupedBranches, tags, stashes, worktrees, submodules,
      initialState: {
        sections: { local: false, remote: false, tags: true, stashes: false, worktrees: false, submodules: false },
        expandedRemotes: {},
        expandedGroups: {},
      },
    });

    // TAGS mở nên tag row hiện; LOCAL đóng nên branch (không phải HEAD row) không hiện
    expect(container.textContent).toContain('v1.0.0');
    expect(container.textContent).not.toContain('abce');
  });

  it('applies stored group expansion instead of the active-branch default', () => {
    const { container } = render(BranchSidebar, {
      branches: groupedBranches, tags: [], stashes: [], worktrees: [], submodules: [],
      initialState: {
        sections: { local: true, remote: false, tags: false, stashes: false, worktrees: false, submodules: false },
        expandedRemotes: {},
        expandedGroups: { 'local:feat': true, 'local:feat/team': true },
      },
    });

    expect(container.textContent).toContain('two');       // feat/team mở theo stored
    expect(container.textContent).not.toContain('abce');  // fix/abc KHÔNG auto-mở theo current branch (HEAD row vẫn hiện tên branch hiện tại)
  });

  it('dispatches stateChange with the full snapshot when a section toggles', async () => {
    const rendered = render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });
    const seen: unknown[] = [];
    rendered.component.$on('stateChange', (event: CustomEvent) => { seen.push(event.detail); });

    await expandSections(rendered.container, 'REMOTE');

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toMatchObject({
      sections: expect.objectContaining({ local: true, remote: true }),
      expandedGroups: expect.any(Object),
      expandedRemotes: expect.any(Object),
    });
  });

  it('dispatches stateChange when a branch group is toggled', async () => {
    const rendered = render(BranchSidebar, {
      branches: groupedBranches, tags: [], stashes: [], worktrees: [], submodules: [],
    });
    const seen: CustomEvent[] = [];
    rendered.component.$on('stateChange', (event: CustomEvent) => { seen.push(event); });

    const group = [...rendered.container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('other'));
    expect(group).toBeDefined();
    await fireEvent.click(group!);

    const last = seen[seen.length - 1]?.detail as { expandedGroups: Record<string, boolean> };
    expect(last.expandedGroups['local:fix/other']).toBe(true);
  });
});

describe('PULL REQUESTS section', () => {
  afterEach(cleanup);

  it('renders no PULL REQUESTS header at all when the repo has no forge provider', () => {
    const { queryByRole, container } = render(BranchSidebar, {
      branches, tags, stashes, worktrees, submodules,
    });

    expect(queryByRole('button', { name: /pull requests/i })).toBeNull();
    expect(container.textContent).not.toContain('PULL REQUESTS');
  });

  it('renders the header collapsed on first render, with no pull request rows in the DOM', async () => {
    const { getByRole, queryByText } = render(BranchSidebar, {
      branches, tags, stashes, worktrees, submodules,
      forgeAvailable: true, forgeSignedIn: true, pullRequests,
    });

    expect(getByRole('button', { name: /pull requests/i })).toBeInTheDocument();
    expect(queryByText('#42')).toBeNull();

    // The header is real, not decorative: toggling it reveals the row.
    await fireEvent.click(getByRole('button', { name: /pull requests/i }));
    expect(queryByText('#42')).toBeInTheDocument();
  });

  it('shows exactly one row, the sign-in affordance, when signed out', async () => {
    const { getByRole, container } = render(BranchSidebar, {
      branches, tags, stashes, worktrees, submodules,
      forgeAvailable: true, forgeSignedIn: false, pullRequests: [],
    });

    await fireEvent.click(getByRole('button', { name: /pull requests/i }));

    expect(getByRole('button', { name: /sign in to bitbucket/i })).toBeInTheDocument();
    expect(container.querySelectorAll('.pr-row')).toHaveLength(0);
  });

  it('keeps the sign-in row reachable while the branch search box has a query', async () => {
    const { getByRole, container } = render(BranchSidebar, {
      branches, tags, stashes, worktrees, submodules,
      forgeAvailable: true, forgeSignedIn: false, pullRequests: [],
    });

    const input = container.querySelector('.sidebar-search input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'main' } });

    expect(getByRole('button', { name: /sign in to bitbucket/i })).toBeInTheDocument();
  });
});

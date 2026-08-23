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

  it('uses focusable semantic buttons for local branches, tags, stashes, and worktrees', () => {
    const { getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });

    expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-current', 'true');
    expect(getByRole('button', { name: /v1\.0\.0/ })).toBeEnabled();
    expect(getByRole('button', { name: /save work/ })).toBeEnabled();
  });

  it.each(['Enter', ' '])('filters by a local branch when %s activates it', async (key) => {
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });
    const onFilter = vi.fn();
    component.$on('branchFilter', onFilter);

    await fireEvent.keyDown(getByRole('button', { name: 'main' }), { key });

    expect(onFilter).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
  });

  it('nests branch path segments and expands only the active branch ancestors', () => {
    const { getByRole, queryByRole } = render(BranchSidebar, {
      branches: groupedBranches,
      tags,
      stashes,
      worktrees,
    });

    expect(getByRole('button', { name: 'Branch group fix' })).toHaveAttribute('aria-expanded', 'true');
    expect(getByRole('button', { name: 'Branch group fix/abc' })).toHaveAttribute('aria-expanded', 'true');
    const activeBranch = getByRole('button', { name: 'fix/abc/abcd' });
    expect(activeBranch).toHaveAttribute('aria-current', 'true');
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
    const { getByRole, queryByRole } = render(BranchSidebar, {
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
    const { component, getByRole, queryByRole } = render(BranchSidebar, {
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

  it('filters on a single click and marks the selected branch', async () => {
    vi.useFakeTimers();
    const { component, getByRole } = render(BranchSidebar, {
      branches,
      tags,
      stashes,
      worktrees,
      selectedBranch: 'main',
    });
    const onFilter = vi.fn();
    component.$on('branchFilter', onFilter);
    const row = getByRole('button', { name: 'main' });

    expect(row).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(row);
    await vi.advanceTimersByTimeAsync(250);

    expect(onFilter).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
  });

  it('keeps double-click checkout from also filtering', async () => {
    vi.useFakeTimers();
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });
    const onCheckout = vi.fn();
    const onFilter = vi.fn();
    component.$on('checkout', onCheckout);
    component.$on('branchFilter', onFilter);

    await fireEvent.dblClick(getByRole('button', { name: 'main' }));
    await vi.advanceTimersByTimeAsync(250);

    expect(onCheckout).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
    expect(onFilter).not.toHaveBeenCalled();
  });

  it.each(['click', 'Enter', ' '])('dispatches tag checkout, stash apply, and non-main worktree open on %s', async (activation) => {
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });
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
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });
    const onWorktreeOpen = vi.fn();
    component.$on('worktreeOpen', onWorktreeOpen);

    await fireEvent.click(getByRole('button', { name: /worktree main/i }));

    expect(onWorktreeOpen).not.toHaveBeenCalled();
  });

  it.each(['click', 'Enter', ' '])('requests a submodule tab on %s', async (activation) => {
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });
    const open = vi.fn();
    component.$on('submoduleOpen', open);
    const row = getByRole('button', { name: /submodule sdk.*packages\/sdk.*initialized/i });
    if (activation === 'click') await fireEvent.click(row);
    else await fireEvent.keyDown(row, { key: activation });

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ detail: { path: 'packages/sdk' } }));
  });

  it('shows the submodule count, can collapse rows, and labels uninitialized entries', async () => {
    const { getByRole, queryByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });
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
  ])('shows and exposes the abbreviated head for $state submodule $name', ({ accessibleName, shortHead }) => {
    const { getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });

    const row = getByRole('button', { name: accessibleName });
    expect(row.querySelector('.submodule-head')).toHaveTextContent(new RegExp(`^${shortHead}$`));
  });

  it('does not show a head for an uninitialized submodule with a null head', () => {
    const { getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });

    const row = getByRole('button', { name: /submodule legacy.*vendor\/legacy.*uninitialized/i });
    expect(row.querySelector('.submodule-head')).toBeNull();
    expect(row).not.toHaveAccessibleName(/[0-9a-f]{7}/i);
  });

  it('opens context menus from Shift+F10 at the focused entry bounding box', async () => {
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });
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

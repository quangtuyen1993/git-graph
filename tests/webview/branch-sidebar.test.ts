import { cleanup, fireEvent, render } from '@testing-library/svelte';
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

const tags = [{ name: 'v1.0.0', hash: 'b'.repeat(40), message: null, taggerDate: null }];
const stashes = [{ index: 0, message: 'save work', date: '2026-08-23', branch: 'main', hash: 'c'.repeat(40) }];
const worktrees = [
  { path: '/repo', head: 'd'.repeat(40), branch: 'main', bare: false, isMain: true },
  { path: '/repo/feature', head: 'e'.repeat(40), branch: 'feature', bare: false, isMain: false },
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
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  it('uses focusable semantic buttons for local branches, tags, stashes, and worktrees', () => {
    const { getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });

    expect(getByRole('button', { name: 'main' })).toHaveAttribute('aria-current', 'true');
    expect(getByRole('button', { name: /v1\.0\.0/ })).toBeEnabled();
    expect(getByRole('button', { name: /save work/ })).toBeEnabled();
  });

  it.each(['Enter', ' '])('checks out a local branch when %s activates it', async (key) => {
    const { component, getByRole } = render(BranchSidebar, { branches, tags, stashes, worktrees });
    const onCheckout = vi.fn();
    component.$on('checkout', onCheckout);

    await fireEvent.keyDown(getByRole('button', { name: 'main' }), { key });

    expect(onCheckout).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: 'main' } }));
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

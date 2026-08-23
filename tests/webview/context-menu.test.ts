import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import ContextMenu from '../../src/webview/components/actions/ContextMenu.svelte';

const items = [
  { label: 'First action', action: 'first' },
  { label: 'Unavailable action', action: 'disabled', disabled: true },
  { label: '', action: '', divider: true },
  { label: 'Last action', action: 'last' },
];

describe('ContextMenu', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 200,
      height: 100,
      top: 0,
      right: 200,
      bottom: 100,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
  });

  afterEach(() => {
    cleanup();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
  });

  it('focuses the first enabled item and gives separators separator semantics', async () => {
    const { getByRole } = render(ContextMenu, { items, visible: true });

    await tick();

    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'First action' }));
    expect(getByRole('separator')).toBeInTheDocument();
  });

  it('moves focus between enabled menu items with Arrow, Home, and End keys', async () => {
    const { getByRole } = render(ContextMenu, { items, visible: true });
    const first = getByRole('menuitem', { name: 'First action' });
    const last = getByRole('menuitem', { name: 'Last action' });

    await tick();
    await fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);

    await fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(last);

    await fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(last);
  });

  it.each(['Enter', ' '])('dispatches its action when %s activates a focused item', async (key) => {
    const { component, getByRole } = render(ContextMenu, { items, visible: true });
    const onAction = vi.fn();
    component.$on('action', onAction);

    await tick();
    await fireEvent.keyDown(getByRole('menuitem', { name: 'First action' }), { key });

    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ detail: { action: 'first' } }));
  });

  it('dispatches close on Escape and restores the prior focused element after closing', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const result = render(ContextMenu, { items, visible: true });
    const onClose = vi.fn();
    result.component.$on('close', onClose);

    await tick();
    await fireEvent.keyDown(result.getByRole('menuitem', { name: 'First action' }), { key: 'Escape' });
    await result.rerender({ visible: false });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('clamps its visible coordinates after measuring its size', async () => {
    const { getByRole } = render(ContextMenu, { items, visible: true, x: 790, y: 590 });

    await tick();

    const menu = getByRole('menu');
    expect(menu).toHaveStyle({ left: '596px', top: '496px' });
  });
});

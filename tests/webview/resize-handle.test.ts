import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResizeHandle from '../../src/webview/components/layout/ResizeHandle.svelte';

describe('ResizeHandle', () => {
  afterEach(() => {
    cleanup();
  });

  it('adjusts a left panel with Arrow keys and exposes its current ARIA value', async () => {
    const { component, getByRole } = render(ResizeHandle, {
      side: 'left',
      currentWidth: 200,
      minWidth: 150,
      maxWidth: 400,
    });
    const onResize = vi.fn();
    component.$on('resize', onResize);
    const handle = getByRole('separator', { name: 'Resize left panel' });

    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '210');
    expect(onResize).toHaveBeenLastCalledWith(expect.objectContaining({ detail: { width: 210 } }));

    await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '200');
  });

  it('reverses Arrow key direction for a right panel', async () => {
    const { getByRole } = render(ResizeHandle, {
      side: 'right',
      currentWidth: 200,
      minWidth: 150,
      maxWidth: 400,
    });
    const handle = getByRole('separator', { name: 'Resize right panel' });

    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '190');

    await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '200');
  });

  it('clamps keyboard resizing and maps Home and End to the allowed range', async () => {
    const { getByRole } = render(ResizeHandle, {
      side: 'left',
      currentWidth: 200,
      minWidth: 150,
      maxWidth: 400,
    });
    const handle = getByRole('separator', { name: 'Resize left panel' });

    await fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', '150');

    await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '150');

    await fireEvent.keyDown(handle, { key: 'End' });
    expect(handle).toHaveAttribute('aria-valuenow', '400');

    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '400');
  });
});

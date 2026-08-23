<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';

  /** Which side of the handle the resizable panel is on */
  export let side: 'left' | 'right' = 'left';

  const dispatch = createEventDispatcher();

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  export let currentWidth: number = 200;
  export let minWidth: number = 150;
  export let maxWidth: number = 600;

  const keyboardStep = 10;

  function setWidth(width: number) {
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, width));
    currentWidth = nextWidth;
    dispatch('resize', { width: nextWidth });
  }

  function onMouseDown(event: MouseEvent) {
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startWidth = currentWidth;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onMouseMove(event: MouseEvent) {
    if (!dragging) return;
    const delta = event.clientX - startX;
    let newWidth: number;

    if (side === 'left') {
      newWidth = startWidth + delta;
    } else {
      newWidth = startWidth - delta;
    }

    setWidth(newWidth);
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function onKeydown(event: KeyboardEvent) {
    let nextWidth: number | null = null;

    switch (event.key) {
      case 'ArrowRight':
        nextWidth = currentWidth + (side === 'left' ? keyboardStep : -keyboardStep);
        break;
      case 'ArrowLeft':
        nextWidth = currentWidth + (side === 'left' ? -keyboardStep : keyboardStep);
        break;
      case 'Home':
        nextWidth = minWidth;
        break;
      case 'End':
        nextWidth = maxWidth;
        break;
    }

    if (nextWidth !== null) {
      event.preventDefault();
      setWidth(nextWidth);
    }
  }

  onDestroy(() => {
    if (dragging) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
<div
  class="resize-handle"
  class:dragging
  on:mousedown={onMouseDown}
  on:keydown={onKeydown}
  role="separator"
  tabindex="0"
  aria-label={`Resize ${side} panel`}
  aria-orientation="vertical"
  aria-valuenow={currentWidth}
  aria-valuemin={minWidth}
  aria-valuemax={maxWidth}
></div>

<style>
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    position: relative;
    z-index: 10;
    transition: background 0.15s ease;
  }

  .resize-handle:hover,
  .resize-handle.dragging {
    background: var(--vscode-focusBorder, #007acc);
  }

  .resize-handle:focus-visible {
    background: var(--vscode-focusBorder, #007acc);
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }
</style>

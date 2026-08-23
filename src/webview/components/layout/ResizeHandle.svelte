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

    newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
    currentWidth = newWidth;
    dispatch('resize', { width: newWidth });
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
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

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<div
  class="resize-handle"
  class:dragging
  on:mousedown={onMouseDown}
  role="separator"
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
</style>

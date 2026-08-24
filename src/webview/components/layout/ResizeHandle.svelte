<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';

  /** Which side of the handle the resizable panel is on */
  export let side: 'left' | 'right' | 'top' | 'bottom' = 'left';
  /**
   * Drag direction. 'x' resizes width (the panel splitters); 'y' resizes
   * height (the commit detail's files/message split). Defaults to 'x' so
   * every existing caller behaves exactly as before.
   */
  export let axis: 'x' | 'y' = 'x';

  $: vertical = axis === 'y';
  $: resizeCursor = vertical ? 'row-resize' : 'col-resize';
  /** A leading panel grows as the pointer moves away from the origin. */
  $: leading = side === 'left' || side === 'top';

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

  function onDoubleClick(event: MouseEvent) {
    event.preventDefault();
    dispatch('reset');
  }

  function onMouseDown(event: MouseEvent) {
    event.preventDefault();
    dragging = true;
    startX = vertical ? event.clientY : event.clientX;
    startWidth = currentWidth;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = resizeCursor;
    document.body.style.userSelect = 'none';
  }

  function onMouseMove(event: MouseEvent) {
    if (!dragging) return;
    const delta = (vertical ? event.clientY : event.clientX) - startX;

    setWidth(leading ? startWidth + delta : startWidth - delta);
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
      case 'ArrowDown':
        nextWidth = currentWidth + (leading ? keyboardStep : -keyboardStep);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextWidth = currentWidth + (leading ? -keyboardStep : keyboardStep);
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
  class:vertical
  on:mousedown={onMouseDown}
  on:dblclick={onDoubleClick}
  on:keydown={onKeydown}
  role="separator"
  tabindex="0"
  aria-label={`Resize ${side} panel`}
  aria-orientation={vertical ? 'horizontal' : 'vertical'}
  aria-valuenow={currentWidth}
  aria-valuemin={minWidth}
  aria-valuemax={maxWidth}
></div>

<style>
  /*
   * The element keeps a 4px footprint so the layout maths stay honest, while
   * ::before widens the grab zone past its own box and ::after draws the 1px
   * divider that makes the handle findable at rest.
   */
  .resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
    position: relative;
    z-index: 10;
  }

  .resize-handle::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    right: -3px;
    cursor: col-resize;
  }

  .resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 1px;
    width: 2px;
    border-radius: 1px;
    background: var(--vscode-panel-border, #2b2b2b);
    transition: background 0.15s ease;
  }

  .resize-handle:hover::after,
  .resize-handle.dragging::after,
  .resize-handle:focus-visible::after {
    background: var(--vscode-focusBorder, #007acc);
  }

  .resize-handle:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  /* Same handle turned on its side: full width, 4px tall, dragged up/down. */
  .resize-handle.vertical {
    width: auto;
    height: 4px;
    cursor: row-resize;
  }

  .resize-handle.vertical::before {
    top: -3px;
    bottom: -3px;
    left: 0;
    right: 0;
    cursor: row-resize;
  }

  .resize-handle.vertical::after {
    top: 1px;
    bottom: auto;
    left: 0;
    right: 0;
    width: auto;
    height: 2px;
  }
</style>

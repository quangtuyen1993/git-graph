<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import type { MenuItem } from '../../types/menu.types';
  import { clampMenuPosition } from '../../lib/context-menu-position';

  export let items: MenuItem[] = [];
  export let x: number = 0;
  export let y: number = 0;
  export let visible: boolean = false;

  const dispatch = createEventDispatcher();
  let menuEl: HTMLDivElement;
  let positionedX = x;
  let positionedY = y;
  let wasVisible = false;
  let previouslyFocusedElement: HTMLElement | null = null;
  let restoreFocusOnClose = false;

  function close({ restoreFocus = false }: { restoreFocus?: boolean } = {}) {
    restoreFocusOnClose = restoreFocus;
    dispatch('close');
  }

  function enabledMenuItems(): HTMLButtonElement[] {
    return menuEl
      ? [...menuEl.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')]
      : [];
  }

  function focusMenuItem(index: number) {
    const enabledItems = enabledMenuItems();
    if (enabledItems.length === 0) return;

    const nextIndex = (index + enabledItems.length) % enabledItems.length;
    enabledItems.forEach((item, itemIndex) => {
      item.tabIndex = itemIndex === nextIndex ? 0 : -1;
    });
    enabledItems[nextIndex].focus();
  }

  async function openMenu() {
    previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    await tick();
    if (!visible || !menuEl) return;

    const bounds = menuEl.getBoundingClientRect();
    const position = clampMenuPosition(
      { x, y },
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    positionedX = position.x;
    positionedY = position.y;
    focusMenuItem(0);
  }

  function restoreFocus() {
    if (previouslyFocusedElement?.isConnected) {
      previouslyFocusedElement.focus();
    }
    previouslyFocusedElement = null;
  }

  function handleItemClick(item: MenuItem) {
    if (item.disabled || item.divider) return;
    close({ restoreFocus: true });
    dispatch('action', { action: item.action });
  }

  function handleClickOutside(event: MouseEvent) {
    if (visible && menuEl && !menuEl.contains(event.target as Node)) {
      close();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    const enabledItems = enabledMenuItems();
    if (!visible || enabledItems.length === 0) return;

    const currentIndex = Math.max(0, enabledItems.indexOf(document.activeElement as HTMLButtonElement));
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusMenuItem(currentIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusMenuItem(currentIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusMenuItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusMenuItem(enabledItems.length - 1);
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        enabledItems[currentIndex].click();
        break;
      case 'Escape':
        event.preventDefault();
        close({ restoreFocus: true });
        break;
    }
  }

  function handleContextMenu(event: MouseEvent) {
    // Prevent browser default context menu when right-clicking inside our menu
    if (visible && menuEl && menuEl.contains(event.target as Node)) {
      event.preventDefault();
    }
  }

  $: if (visible && !wasVisible) {
    wasVisible = true;
    void openMenu();
  } else if (!visible && wasVisible) {
    wasVisible = false;
    if (restoreFocusOnClose) restoreFocus();
    restoreFocusOnClose = false;
  }
</script>

<svelte:window
  on:mousedown|capture={handleClickOutside}
  on:contextmenu|capture={handleContextMenu}
/>

{#if visible}
  <div
    class="context-menu"
    bind:this={menuEl}
    style="left: {positionedX}px; top: {positionedY}px;"
    role="menu"
    tabindex="-1"
    on:keydown={handleKeydown}
  >
    {#each items as item}
      {#if item.divider}
        <div class="divider" role="separator"></div>
      {:else}
        <button
          class="menu-item"
          class:disabled={item.disabled}
          class:danger={item.danger}
          role="menuitem"
          disabled={item.disabled}
          tabindex="-1"
          on:click={() => handleItemClick(item)}
        >
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .context-menu {
    position: fixed;
    z-index: 1000;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    border-radius: 4px;
    padding: 4px 0;
    min-width: 160px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .menu-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: none;
    color: var(--vscode-menu-foreground, #cccccc);
    font-size: 13px;
    font-family: var(--vscode-font-family);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .menu-item:hover:not(.disabled) {
    background: var(--vscode-menu-selectionBackground, #094771);
    color: var(--vscode-menu-selectionForeground, #ffffff);
  }

  .menu-item:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .menu-item.disabled {
    opacity: 0.4;
    cursor: default;
  }

  .menu-item.danger {
    color: var(--vscode-errorForeground, #f44747);
  }

  .menu-item.danger:hover:not(.disabled) {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f44747);
  }

  .divider {
    height: 1px;
    margin: 4px 8px;
    background: var(--vscode-menu-separatorBackground, #454545);
  }
</style>

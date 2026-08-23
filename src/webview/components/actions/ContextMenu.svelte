<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import type { MenuItem } from '../../types/menu.types';

  export let items: MenuItem[] = [];
  export let x: number = 0;
  export let y: number = 0;
  export let visible: boolean = false;

  const dispatch = createEventDispatcher();
  let menuEl: HTMLDivElement;

  function close() {
    dispatch('close');
  }

  function handleItemClick(item: MenuItem) {
    if (item.disabled || item.divider) return;
    close();
    dispatch('action', { action: item.action });
  }

  function handleClickOutside(event: MouseEvent) {
    if (visible && menuEl && !menuEl.contains(event.target as Node)) {
      close();
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (visible && event.key === 'Escape') {
      close();
    }
  }

  function handleContextMenu(event: MouseEvent) {
    // Prevent browser default context menu when right-clicking inside our menu
    if (visible && menuEl && menuEl.contains(event.target as Node)) {
      event.preventDefault();
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('contextmenu', handleContextMenu, true);
  });

  onDestroy(() => {
    document.removeEventListener('mousedown', handleClickOutside, true);
    document.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('contextmenu', handleContextMenu, true);
  });
</script>

{#if visible}
  <div
    class="context-menu"
    bind:this={menuEl}
    style="left: {x}px; top: {y}px;"
    role="menu"
  >
    {#each items as item}
      {#if item.divider}
        <div class="divider"></div>
      {:else}
        <button
          class="menu-item"
          class:disabled={item.disabled}
          class:danger={item.danger}
          role="menuitem"
          disabled={item.disabled}
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

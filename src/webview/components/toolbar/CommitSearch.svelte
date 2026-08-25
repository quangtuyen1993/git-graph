<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import LoadingSpinner from '../common/LoadingSpinner.svelte';
  import { formatMatchCounter } from '../../lib/commit-search';

  export let expanded = false;
  export let searching = false;
  export let total = 0;
  export let activeIndex = 0;
  export let message = '';

  const dispatch = createEventDispatcher<{
    search: { query: string };
    navigate: { direction: 1 | -1 };
    clear: void;
  }>();

  let query = '';
  let input: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Typing a commit message is a burst of keystrokes, not a burst of searches:
  // only the pause at the end is worth a `git log` on the host.
  const DEBOUNCE_MS = 300;

  $: counter = formatMatchCounter(total, activeIndex);

  export function focusInput(): void {
    input?.focus();
    input?.select();
  }

  function onInput(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => dispatch('search', { query }), DEBOUNCE_MS);
  }

  function reset(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    query = '';
    dispatch('clear');
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); reset(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      dispatch('navigate', { direction: event.shiftKey ? -1 : 1 });
    }
  }

  onDestroy(() => { if (debounceTimer !== undefined) clearTimeout(debounceTimer); });
</script>

{#if expanded}
  <div class="commit-search" role="search">
    <span class="search-glyph">
      {#if searching}<LoadingSpinner label="Searching commits…" />{:else}<Icon name="search" />{/if}
    </span>
    <input
      bind:this={input}
      bind:value={query}
      type="text"
      placeholder="Search commit message or hash..."
      aria-label="Search commits by message or hash"
      on:input={onInput}
      on:keydown={onKeydown}
    />
    <!--
      One live region around both readouts: the counter and the message are
      alternatives, so announcing them together turns "nothing" → "No commits
      found" or "nothing" → "1/2" into a single polite update.
    -->
    <span class="search-status" aria-live="polite">
      {#if counter}<span class="search-counter">{counter}</span>{/if}
      {#if message}<span class="search-message">{message}</span>{/if}
    </span>
    <button type="button" aria-label="Previous match" disabled={total < 2}
            on:click={() => dispatch('navigate', { direction: -1 })}
    ><Icon name="arrow-small-up" /></button>
    <button type="button" aria-label="Next match" disabled={total < 2}
            on:click={() => dispatch('navigate', { direction: 1 })}
    ><Icon name="arrow-small-down" /></button>
    <button type="button" aria-label="Clear search" on:click={reset}><Icon name="close" /></button>
  </div>
{/if}

<style>
  /* Same 24px-tall pill as .toolbar-group in the graph toolbar. */
  .commit-search {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 5px;
    min-width: 0;
    background: var(--vscode-input-background, #313131);
  }

  .commit-search:focus-within {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .search-glyph {
    display: flex;
    align-items: center;
    color: var(--vscode-icon-foreground, #cccccc);
    opacity: 0.7;
  }

  input {
    width: 180px;
    min-width: 0;
    padding: 0 2px;
    border: none;
    background: none;
    color: var(--vscode-input-foreground, #cccccc);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }

  .search-status {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .search-counter,
  .search-message {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #767676);
    white-space: nowrap;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--vscode-icon-foreground, #cccccc);
    cursor: pointer;
    opacity: 0.85;
  }

  button:hover:not(:disabled) {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }
</style>

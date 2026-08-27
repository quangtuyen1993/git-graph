<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface Item {
    label: string;
    value: string;
    detail?: string;
  }

  export let items: Item[] = [];
  export let value: string = '';
  export let placeholder: string = '';

  // aria-label is passed via $$restProps since hyphens aren't valid JS identifiers

  const dispatch = createEventDispatcher<{
    select: { value: string };
    input: undefined;
    blur: undefined;
  }>();

  let open = false;
  let highlightIndex = -1;
  let inputEl: HTMLInputElement;
  let query = value;

  // Ledger item: `query` (the input's displayed text) used to be seeded
  // from `value` only once at mount, and re-synced only on focus. A second
  // handoff to a different pull request while the panel is already open
  // (see App.svelte's review.target handling) sets `value` externally
  // without the input ever losing and regaining focus — the summary and
  // file list, which read `value` directly, updated correctly, but the
  // input kept showing the *previous* pull request's text. Track every
  // externally-driven change to `value` here; `lastSyncedValue` is updated
  // in lockstep by every internal write to `value` too (handleInput,
  // selectItem, handleBlur), so typing does not fight this sync — it only
  // fires for a change this component did not itself just make.
  let lastSyncedValue = value;
  $: if (value !== lastSyncedValue) {
    query = value;
    lastSyncedValue = value;
  }

  const listboxId = `combobox-listbox-${Math.random().toString(36).slice(2, 9)}`;

  $: filteredItems = open
    ? items.filter(
        (item) =>
          item.label.toLowerCase().includes(query.toLowerCase()) ||
          item.value.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 50)
    : [];

  $: activeDescendant =
    highlightIndex >= 0 && highlightIndex < filteredItems.length
      ? `${listboxId}-option-${highlightIndex}`
      : '';

  function handleFocus() {
    query = value;
    open = true;
    highlightIndex = -1;
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    query = target.value;
    value = query;
    open = true;
    highlightIndex = -1;
    dispatch('input');
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        open = true;
      }
      if (highlightIndex < filteredItems.length - 1) {
        highlightIndex++;
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (highlightIndex > 0) {
        highlightIndex--;
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && highlightIndex >= 0 && highlightIndex < filteredItems.length) {
        selectItem(filteredItems[highlightIndex]);
      } else {
        open = false;
        dispatch('select', { value });
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      open = false;
      highlightIndex = -1;
    }
  }

  function selectItem(item: Item) {
    value = item.value;
    query = item.value;
    open = false;
    highlightIndex = -1;
    dispatch('select', { value: item.value });
  }

  function handleBlur() {
    open = false;
    highlightIndex = -1;
    value = query;
    dispatch('blur');
  }

  function handleMouseDown(e: Event) {
    // Prevent blur from firing before click handler
    e.preventDefault();
  }
</script>

<div class="combobox-wrapper">
  <input
    bind:this={inputEl}
    type="text"
    role="combobox"
    aria-label={$$restProps['aria-label'] || ''}
    aria-expanded={open ? 'true' : 'false'}
    aria-autocomplete="list"
    aria-controls={listboxId}
    aria-activedescendant={activeDescendant || undefined}
    {placeholder}
    value={query}
    on:focus={handleFocus}
    on:input={handleInput}
    on:keydown={handleKeyDown}
    on:blur={handleBlur}
  />
  {#if open && filteredItems.length > 0}
    <ul
      id={listboxId}
      role="listbox"
      class="combobox-listbox"
      on:mousedown={handleMouseDown}
    >
      {#each filteredItems as item, i}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <li
          id="{listboxId}-option-{i}"
          role="option"
          class="combobox-option"
          class:highlighted={i === highlightIndex}
          aria-selected={i === highlightIndex}
          on:click={() => selectItem(item)}
        >
          <span class="combobox-option-label">{item.label}</span>
          {#if item.detail}
            <span class="combobox-option-detail">{item.detail}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combobox-wrapper {
    position: relative;
    width: 100%;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    outline: none;
    font-family: inherit;
    font-size: inherit;
  }

  input:focus {
    border-color: var(--vscode-focusBorder);
  }

  .combobox-listbox {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-input-border, transparent);
    max-height: 200px;
    overflow-y: auto;
    z-index: 100;
  }

  .combobox-option {
    padding: 4px 8px;
    cursor: pointer;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .combobox-option:hover,
  .combobox-option.highlighted {
    background: var(--vscode-list-hoverBackground);
  }

  .combobox-option-detail {
    opacity: 0.7;
    font-size: 0.9em;
  }
</style>

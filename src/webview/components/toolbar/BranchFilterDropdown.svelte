<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import { formatBranchFilterLabel } from '../../lib/branch-menu';

  /**
   * Selections are stored as the full branch name exactly as `git.branches`
   * reports it (`origin/feature/x`, not `feature/x`), because `graph.build`
   * has to resolve each entry as a real ref. A remote ref therefore reads
   * verbatim on the trigger; the label ellipsises and keeps the whole name in
   * its tooltip rather than being shortened into something ambiguous.
   */
  export let branches: Array<{ name: string }> = [];
  export let selected: string[] = [];

  const dispatch = createEventDispatcher<{ change: { selected: string[] } }>();

  let open = false;
  let filter = '';

  $: label = formatBranchFilterLabel(selected);
  $: visible = filter.trim() === ''
    ? branches
    : branches.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(name: string): void {
    const next = selected.includes(name)
      ? selected.filter((entry) => entry !== name)
      : [...selected, name];
    dispatch('change', { selected: next });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open) { event.preventDefault(); open = false; }
  }

  // TypeScript casts are not allowed in markup expressions, so the outside-click
  // test lives in the script block.
  function onWindowClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (open && !target?.closest('.branch-filter')) open = false;
  }
</script>

<svelte:window on:click={onWindowClick} />

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="branch-filter" on:keydown={onKeydown}>
  <button
    type="button"
    class="toolbar-select branch-filter-trigger"
    aria-label="Filter graph by branch"
    aria-expanded={open}
    on:click|stopPropagation={() => { open = !open; }}
  >
    <Icon name="filter" />
    <span class="branch-filter-label" title={label}>{label}</span>
  </button>

  {#if open}
    <div class="branch-filter-menu" role="group" aria-label="Branches">
      <input
        type="text"
        class="branch-filter-search"
        placeholder="Filter branches"
        aria-label="Filter branches"
        bind:value={filter}
      />
      <div class="branch-filter-actions">
        <button
          type="button"
          on:click={() => dispatch('change', { selected: visible.map((b) => b.name) })}
        >Select All</button>
        <button type="button" on:click={() => dispatch('change', { selected: [] })}>Clear All</button>
      </div>
      <ul>
        {#each visible as branch (branch.name)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(branch.name)}
                on:change={() => toggle(branch.name)}
              />
              <span class="branch-filter-name">{branch.name}</span>
            </label>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .branch-filter {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  /* Matches the quiet .toolbar-select look: the toolbar group owns the chrome. */
  .branch-filter-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 220px;
    min-width: 110px;
    height: 20px;
    padding: 0 2px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--vscode-foreground, #cccccc);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .branch-filter-trigger:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  .branch-filter-trigger:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .branch-filter-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch-filter-menu {
    position: absolute;
    z-index: 1000;
    top: calc(100% + 4px);
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 220px;
    max-height: 320px;
    overflow: auto;
    padding: 4px;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .branch-filter-search {
    padding: 3px 6px;
    background: var(--vscode-input-background, #313131);
    color: var(--vscode-input-foreground, #cccccc);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }

  .branch-filter-search:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .branch-filter-actions {
    display: flex;
    gap: 4px;
  }

  .branch-filter-actions button {
    padding: 2px 6px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--vscode-textLink-foreground, #3794ff);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .branch-filter-actions button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  .branch-filter-actions button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    border-radius: 4px;
    color: var(--vscode-menu-foreground, #cccccc);
    font-size: 12px;
    cursor: pointer;
  }

  label:hover {
    background: var(--vscode-menu-selectionBackground, #094771);
  }

  input[type='checkbox'] {
    margin: 0;
    flex-shrink: 0;
    accent-color: var(--vscode-checkbox-background, #313131);
  }

  .branch-filter-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

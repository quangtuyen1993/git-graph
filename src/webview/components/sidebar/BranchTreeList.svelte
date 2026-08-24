<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { BranchTreeNode } from '../../lib/branch-tree';
  import Icon from '../common/Icon.svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
    remote: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  }

  export let nodes: BranchTreeNode<Branch>[] = [];
  export let expandedGroups: Record<string, boolean> = {};
  export let groupPrefix = 'local';
  export let selectedBranch: string | null = null;
  export let depth = 0;
  export let favourites: string[] = [];

  /** Past this the exact number stops mattering and starts stretching the row. */
  const COUNT_CAP = 99;
  const formatCount = (value: number): string => (value > COUNT_CAP ? `${COUNT_CAP}+` : `${value}`);

  const dispatch = createEventDispatcher();
  let clickTimer: ReturnType<typeof setTimeout> | undefined;

  function groupKey(path: string): string {
    return `${groupPrefix}:${path}`;
  }

  function scheduleSelect(branch: Branch) {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = undefined;
      dispatch('select', { name: branch.name });
    }, 180);
  }

  function checkout(branch: Branch) {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = undefined;
    dispatch('checkout', { name: branch.name });
  }

  function keyboardContextMenuEvent(event: KeyboardEvent): MouseEvent {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    });
  }

  function handleKeydown(event: KeyboardEvent, branch: Branch) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      dispatch('contextMenu', { event: keyboardContextMenuEvent(event), branch });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dispatch('select', { name: branch.name });
    }
  }

  onDestroy(() => {
    if (clickTimer) clearTimeout(clickTimer);
  });
</script>

<ul class="branch-tree" class:nested={depth > 0}>
  {#each nodes as node (node.path)}
    <li>
      {#if node.children.length > 0}
        <button
          type="button"
          class="branch-group"
          style={`--tree-indent: ${(depth + 1) * 16}px`}
          aria-label={`Branch group ${node.path}`}
          aria-expanded={expandedGroups[groupKey(node.path)] === true}
          on:click={() => dispatch('groupToggle', { key: groupKey(node.path) })}
        >
          <span class="chevron" class:collapsed={expandedGroups[groupKey(node.path)] !== true}><Icon name="chevron-right" /></span>
          <span class="group-icon"><Icon name={expandedGroups[groupKey(node.path)] === true ? 'folder-opened' : 'folder'} size={14} /></span>
          <span class="group-name">{node.label}</span>
        </button>
      {/if}

      {#if node.branch && (node.children.length === 0 || expandedGroups[groupKey(node.path)] === true)}
        <button
          type="button"
          class="branch-item"
          class:current={node.branch.current}
          class:selected={selectedBranch === node.branch.name}
          style={`--tree-indent: ${(depth + 1) * 16}px`}
          aria-current={node.branch.current ? 'true' : undefined}
          aria-pressed={selectedBranch === node.branch.name}
          aria-label={node.branch.name}
          title={node.branch.name}
          on:click={() => scheduleSelect(node.branch)}
          on:contextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dispatch('contextMenu', { event, branch: node.branch });
          }}
          on:dblclick={() => checkout(node.branch)}
          on:keydown={(event) => handleKeydown(event, node.branch)}
        >
          <span class="branch-icon"><Icon name={node.branch.current ? 'check' : 'git-branch'} size={14} /></span>
          <span class="branch-name">{node.label}</span>
          <span
            class="favourite"
            class:is-favourite={favourites.includes(node.branch.name)}
            role="button"
            tabindex="-1"
            aria-label={`${favourites.includes(node.branch.name) ? 'Unstar' : 'Star'} ${node.branch.name}`}
            on:click|stopPropagation={() => dispatch('favouriteToggle', { name: node.branch.name })}
            on:keydown|stopPropagation={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                dispatch('favouriteToggle', { name: node.branch.name });
              }
            }}
          ><Icon name="star-full" size={12} /></span>
          {#if node.branch.ahead > 0 || node.branch.behind > 0}
            <span class="ahead-behind">
              {#if node.branch.ahead > 0}
                <span class="ahead" title={`${node.branch.ahead} commit(s) to push`}>
                  <Icon name="arrow-small-up" size={12} />{formatCount(node.branch.ahead)}
                </span>
              {/if}
              {#if node.branch.behind > 0}
                <span class="behind" title={`${node.branch.behind} commit(s) to pull`}>
                  <Icon name="arrow-small-down" size={12} />{formatCount(node.branch.behind)}
                </span>
              {/if}
            </span>
          {/if}
        </button>
      {/if}

      {#if node.children.length > 0 && expandedGroups[groupKey(node.path)] === true}
        <svelte:self
          nodes={node.children}
          {expandedGroups}
          {groupPrefix}
          {selectedBranch}
          {favourites}
          depth={depth + 1}
          on:groupToggle
          on:select
          on:checkout
          on:contextMenu
          on:favouriteToggle
        />
      {/if}
    </li>
  {/each}
</ul>

<style>
  .branch-tree {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .branch-group,
  .branch-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: 1px 0;
    border: none;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .branch-group {
    min-height: 30px;
    padding: 6px 12px 6px calc(var(--sidebar-gutter, 12px) + var(--tree-indent));
    color: var(--vscode-descriptionForeground, #767676);
    cursor: pointer;
  }

  .branch-item {
    min-height: 30px;
    padding: 6px 12px 6px calc(var(--sidebar-gutter, 12px) + var(--tree-indent));
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }

  .branch-group:hover,
  .branch-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .branch-group:focus-visible,
  .branch-item:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    opacity: 0.8;
    transform: rotate(90deg);
    transition: transform 0.15s ease;
  }

  .chevron.collapsed {
    transform: rotate(0deg);
  }

  .group-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    line-height: 18px;
    font-weight: 600;
  }

  .branch-item.current {
    color: var(--vscode-testing-iconPassed, #6a9955);
    font-weight: 600;
  }

  .branch-item.selected {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  .branch-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #767676);
    opacity: 0.8;
  }

  .branch-item.current .branch-icon,
  .branch-item.selected .branch-icon {
    opacity: 1;
  }

  .branch-item.current .branch-icon {
    color: var(--vscode-testing-iconPassed, #6a9955);
  }

  /* Explicit rather than inherited, so the branch name is the clearest thing
     in the row and does not pick up a dimmed colour from its surroundings. */
  .branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    line-height: 18px;
    color: var(--vscode-foreground, #cccccc);
  }

  .branch-item.current .branch-name {
    font-weight: 600;
  }

  .branch-item.selected .branch-name {
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  /* Dim until set, so a row of unstarred branches stays quiet. */
  .favourite {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    cursor: pointer;
    opacity: 0;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .branch-item:hover .favourite {
    opacity: 0.5;
  }

  .favourite:hover {
    opacity: 1 !important;
  }

  .favourite.is-favourite {
    opacity: 1;
    color: var(--vscode-charts-yellow, #d7ba7d);
  }

  .ahead-behind {
    display: flex;
    gap: 3px;
    margin-left: auto;
    font-size: 11px;
  }

  /*
   * Diagonal, because ahead/behind is movement relative to the remote rather
   * than plain up/down. Codicon ships no diagonal arrow, so the small vertical
   * one is rotated; that stays crisp where a Unicode glyph varies by font.
   */
  .ahead,
  .behind {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }

  .ahead :global(svg),
  .behind :global(svg) {
    transform: rotate(45deg);
  }

  .behind :global(svg) {
    transform: rotate(-45deg);
  }

  /* Ahead is work you have; behind is work you need. Neither is an error, so
     nothing here is red. */
  .ahead {
    color: var(--vscode-gitDecoration-addedResourceForeground, #6a9955);
  }

  .behind {
    color: var(--vscode-editorWarning-foreground, #bf8803);
  }
</style>

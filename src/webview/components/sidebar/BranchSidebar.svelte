<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
    remote: string | null;
    upstream: string | null;
  }

  interface Tag {
    name: string;
    hash: string;
    message: string | null;
    taggerDate: string | null;
  }

  export let branches: Branch[] = [];
  export let tags: Tag[] = [];

  const dispatch = createEventDispatcher();

  $: localBranches = branches.filter(b => !b.remote);
  $: remoteBranches = branches.filter(b => !!b.remote);

  // Group remote branches by remote name
  $: remoteGroups = (() => {
    const groups: Record<string, Branch[]> = {};
    for (const b of remoteBranches) {
      const remote = b.name.split('/')[0] ?? 'origin';
      if (!groups[remote]) groups[remote] = [];
      groups[remote].push(b);
    }
    return groups;
  })();

  let localExpanded = true;
  let remoteExpanded = true;
  let tagsExpanded = true;
  let expandedRemotes: Record<string, boolean> = {};

  function isRemoteExpanded(remote: string): boolean {
    return expandedRemotes[remote] !== false; // default true
  }

  function toggleRemote(remote: string) {
    expandedRemotes[remote] = !isRemoteExpanded(remote);
    expandedRemotes = expandedRemotes; // trigger reactivity
  }

  function handleBranchContextMenu(event: MouseEvent, branch: Branch) {
    event.preventDefault();
    event.stopPropagation();
    dispatch('branchContextMenu', { event, branch });
  }

  function handleBranchDblClick(branch: Branch) {
    dispatch('checkout', { name: branch.name });
  }

  function handleTagContextMenu(event: MouseEvent, tag: Tag) {
    event.preventDefault();
    event.stopPropagation();
    dispatch('tagContextMenu', { event, tag });
  }

  function getShortName(branch: Branch): string {
    if (branch.remote) {
      // Remove remote prefix: "origin/feature" → "feature"
      const parts = branch.name.split('/');
      return parts.slice(1).join('/');
    }
    return branch.name;
  }
</script>

<div class="branch-sidebar">
  <!-- LOCAL section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { localExpanded = !localExpanded; }}
    >
      <span class="chevron" class:collapsed={!localExpanded}>▶</span>
      <span class="section-title">LOCAL</span>
      <span class="section-count">{localBranches.length}</span>
    </button>

    {#if localExpanded}
      <ul class="branch-list">
        {#each localBranches as branch (branch.name)}
          <li
            class="branch-item"
            class:current={branch.current}
            on:contextmenu={(e) => handleBranchContextMenu(e, branch)}
            on:dblclick={() => handleBranchDblClick(branch)}
            role="treeitem"
            aria-selected={branch.current}
          >
            <span class="branch-icon">{branch.current ? '●' : '○'}</span>
            <span class="branch-name">{branch.name}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- REMOTE section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { remoteExpanded = !remoteExpanded; }}
    >
      <span class="chevron" class:collapsed={!remoteExpanded}>▶</span>
      <span class="section-title">REMOTE</span>
      <span class="section-count">{remoteBranches.length}</span>
    </button>

    {#if remoteExpanded}
      {#each Object.entries(remoteGroups) as [remote, rBranches] (remote)}
        <div class="remote-group">
          <button
            class="remote-header"
            on:click={() => toggleRemote(remote)}
          >
            <span class="chevron" class:collapsed={!isRemoteExpanded(remote)}>▶</span>
            <span class="remote-name">{remote}</span>
            <span class="section-count">{rBranches.length}</span>
          </button>

          {#if isRemoteExpanded(remote)}
            <ul class="branch-list nested">
              {#each rBranches as branch (branch.name)}
                <li
                  class="branch-item remote"
                  on:contextmenu={(e) => handleBranchContextMenu(e, branch)}
                  on:dblclick={() => handleBranchDblClick(branch)}
                  role="treeitem"
                  aria-selected={false}
                >
                  <span class="branch-icon">↙</span>
                  <span class="branch-name">{getShortName(branch)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <!-- TAGS section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { tagsExpanded = !tagsExpanded; }}
    >
      <span class="chevron" class:collapsed={!tagsExpanded}>▶</span>
      <span class="section-title">TAGS</span>
      <span class="section-count">{tags.length}</span>
    </button>

    {#if tagsExpanded}
      <ul class="branch-list">
        {#each tags as tag (tag.name)}
          <li
            class="branch-item tag"
            on:contextmenu={(e) => handleTagContextMenu(e, tag)}
            role="treeitem"
            aria-selected={false}
          >
            <span class="branch-icon">🏷</span>
            <span class="branch-name">{tag.name}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .branch-sidebar {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px 0;
    user-select: none;
    font-size: 13px;
  }

  .section {
    margin-bottom: 4px;
  }

  .section-header,
  .remote-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 12px;
    border: none;
    background: none;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
    text-align: left;
  }

  .section-header:hover,
  .remote-header:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .chevron {
    display: inline-block;
    font-size: 9px;
    transition: transform 0.15s ease;
    transform: rotate(90deg);
    width: 10px;
    text-align: center;
  }

  .chevron.collapsed {
    transform: rotate(0deg);
  }

  .section-count {
    margin-left: auto;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    min-width: 16px;
    text-align: center;
  }

  .remote-group {
    margin-left: 4px;
  }

  .remote-name {
    font-size: 11px;
    font-weight: 600;
  }

  .branch-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .branch-list.nested {
    margin-left: 8px;
  }

  .branch-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px 3px 24px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 3px;
    margin: 0 4px;
  }

  .branch-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .branch-item.current {
    color: var(--vscode-testing-iconPassed, #6a9955);
    font-weight: 600;
  }

  .branch-item.current .branch-icon {
    color: var(--vscode-testing-iconPassed, #6a9955);
  }

  .branch-icon {
    font-size: 10px;
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    color: var(--vscode-descriptionForeground, #888);
  }

  .branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-foreground, #cccccc);
  }

  .branch-item.remote .branch-name {
    color: var(--vscode-descriptionForeground, #aaaaaa);
  }

  .branch-item.tag .branch-icon {
    font-size: 11px;
  }

  .branch-item.tag .branch-name {
    color: var(--vscode-editorWarning-foreground, #d7ba7d);
  }
</style>

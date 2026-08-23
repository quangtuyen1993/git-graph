<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
    remote: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  }

  interface Tag {
    name: string;
    hash: string;
    message: string | null;
    taggerDate: string | null;
  }

  interface StashEntry {
    index: number;
    message: string;
    date: string;
    branch: string;
    hash: string;
  }

  interface WorktreeEntry {
    path: string;
    head: string;
    branch: string | null;
    bare: boolean;
    isMain: boolean;
  }

  export let branches: Branch[] = [];
  export let tags: Tag[] = [];
  export let stashes: StashEntry[] = [];
  export let worktrees: WorktreeEntry[] = [];

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
  let stashesExpanded = true;
  let worktreesExpanded = true;
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

  function handleTagActivate(tag: Tag) {
    dispatch('checkout', { name: tag.name });
  }

  function handleStashContextMenu(event: MouseEvent, stash: StashEntry) {
    event.preventDefault();
    event.stopPropagation();
    dispatch('stashContextMenu', { event, stash });
  }

  function handleStashActivate(stash: StashEntry) {
    dispatch('stashApply', { index: stash.index });
  }

  function handleWorktreeContextMenu(event: MouseEvent, worktree: WorktreeEntry) {
    event.preventDefault();
    event.stopPropagation();
    dispatch('worktreeContextMenu', { event, worktree });
  }

  function handleWorktreeActivate(worktree: WorktreeEntry) {
    if (!worktree.isMain) {
      dispatch('worktreeOpen', { path: worktree.path });
    }
  }

  function isContextMenuShortcut(event: KeyboardEvent): boolean {
    return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
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

  function handleBranchKeydown(event: KeyboardEvent, branch: Branch) {
    if (isContextMenuShortcut(event)) {
      event.preventDefault();
      handleBranchContextMenu(keyboardContextMenuEvent(event), branch);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleBranchDblClick(branch);
    }
  }

  function handleTagKeydown(event: KeyboardEvent, tag: Tag) {
    if (isContextMenuShortcut(event)) {
      event.preventDefault();
      handleTagContextMenu(keyboardContextMenuEvent(event), tag);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleTagActivate(tag);
    }
  }

  function handleStashKeydown(event: KeyboardEvent, stash: StashEntry) {
    if (isContextMenuShortcut(event)) {
      event.preventDefault();
      handleStashContextMenu(keyboardContextMenuEvent(event), stash);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleStashActivate(stash);
    }
  }

  function handleWorktreeKeydown(event: KeyboardEvent, worktree: WorktreeEntry) {
    if (isContextMenuShortcut(event)) {
      event.preventDefault();
      handleWorktreeContextMenu(keyboardContextMenuEvent(event), worktree);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleWorktreeActivate(worktree);
    }
  }

  function getShortName(branch: Branch): string {
    if (branch.remote) {
      const parts = branch.name.split('/');
      const short = parts.slice(1).join('/');
      return short || branch.name; // fallback to full name if short is empty
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
          <li>
            <button
              type="button"
              class="branch-item"
              class:current={branch.current}
              aria-current={branch.current ? 'true' : undefined}
              aria-label={branch.name}
              on:contextmenu={(e) => handleBranchContextMenu(e, branch)}
              on:dblclick={() => handleBranchDblClick(branch)}
              on:keydown={(e) => handleBranchKeydown(e, branch)}
            >
              <span class="branch-icon">{branch.current ? '●' : '○'}</span>
              <span class="branch-name">{branch.name}</span>
              {#if branch.ahead > 0 || branch.behind > 0}
                <span class="ahead-behind">
                  {#if branch.ahead > 0}<span class="ahead">↑{branch.ahead}</span>{/if}
                  {#if branch.behind > 0}<span class="behind">↓{branch.behind}</span>{/if}
                </span>
              {/if}
            </button>
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
                <li>
                  <button
                    type="button"
                    class="branch-item remote"
                    aria-label={getShortName(branch)}
                    on:contextmenu={(e) => handleBranchContextMenu(e, branch)}
                    on:dblclick={() => handleBranchDblClick(branch)}
                    on:keydown={(e) => handleBranchKeydown(e, branch)}
                  >
                    <span class="branch-name">{getShortName(branch)}</span>
                  </button>
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
          <li>
            <button
              type="button"
              class="branch-item tag"
              aria-label={tag.name}
              on:click={() => handleTagActivate(tag)}
              on:contextmenu={(e) => handleTagContextMenu(e, tag)}
              on:keydown={(e) => handleTagKeydown(e, tag)}
            >
              <span class="branch-icon">🏷</span>
              <span class="branch-name">{tag.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- STASHES section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { stashesExpanded = !stashesExpanded; }}
    >
      <span class="chevron" class:collapsed={!stashesExpanded}>▶</span>
      <span class="section-title">STASHES</span>
      <span class="section-count">{stashes.length}</span>
    </button>

    {#if stashesExpanded}
      <ul class="branch-list">
        {#each stashes as stash (stash.index)}
          <li>
            <button
              type="button"
              class="branch-item stash"
              aria-label={stash.message || `stash@{${stash.index}}`}
              on:click={() => handleStashActivate(stash)}
              on:contextmenu={(e) => handleStashContextMenu(e, stash)}
              on:keydown={(e) => handleStashKeydown(e, stash)}
            >
              <span class="branch-icon">📦</span>
              <span class="branch-name" title={stash.message}>
                {stash.message || `stash@{${stash.index}}`}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- WORKTREES section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { worktreesExpanded = !worktreesExpanded; }}
    >
      <span class="chevron" class:collapsed={!worktreesExpanded}>▶</span>
      <span class="section-title">WORKTREES</span>
      <span class="section-count">{worktrees.length}</span>
    </button>

    {#if worktreesExpanded}
      <ul class="branch-list">
        {#each worktrees as wt (wt.path)}
          <li>
            <button
              type="button"
              class="branch-item worktree"
              class:main={wt.isMain}
              aria-label={`Worktree ${wt.branch ?? wt.head?.substring(0, 7) ?? 'unknown'}`}
              on:click={() => handleWorktreeActivate(wt)}
              on:contextmenu={(e) => handleWorktreeContextMenu(e, wt)}
              on:keydown={(e) => handleWorktreeKeydown(e, wt)}
            >
              <span class="branch-icon">{wt.isMain ? '🏠' : '📂'}</span>
              <span class="branch-name" title={wt.path}>
                {wt.branch ?? wt.head?.substring(0, 7) ?? '???'}
              </span>
            </button>
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
    width: calc(100% - 8px);
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .branch-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
  }

  .branch-item:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
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

  .branch-item.stash .branch-name {
    color: var(--vscode-descriptionForeground, #aaaaaa);
    font-style: italic;
  }

  .branch-item.worktree .branch-name {
    color: var(--vscode-textLink-foreground, #4fc1ff);
  }

  .branch-item.worktree.main .branch-name {
    font-weight: 600;
  }

  .ahead-behind {
    margin-left: auto;
    display: flex;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    padding-right: 8px;
  }

  .ahead {
    color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
  }

  .behind {
    color: var(--vscode-editorWarning-foreground, #d7ba7d);
  }
</style>

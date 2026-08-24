<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import BranchTreeList from './BranchTreeList.svelte';
  import Icon from '../common/Icon.svelte';
  import { activeBranchGroupPaths, buildBranchTree, type BranchTreeNode } from '../../lib/branch-tree';

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

  interface SubmoduleEntry {
    name: string;
    path: string;
    head: string | null;
    state: 'initialized' | 'uninitialized' | 'modified' | 'conflicted';
  }

  export let branches: Branch[] = [];
  export let tags: Tag[] = [];
  export let stashes: StashEntry[] = [];
  export let worktrees: WorktreeEntry[] = [];
  export let submodules: SubmoduleEntry[] = [];
  export let selectedBranch: string | null = null;

  const dispatch = createEventDispatcher();

  $: localBranches = branches.filter(b => !b.remote);
  $: remoteBranches = branches.filter(b => !!b.remote);
  $: localTree = buildBranchTree(localBranches);

  // Group remote branches by remote name
  $: remoteGroups = (() => {
    const groups: Record<string, { branches: Branch[]; tree: BranchTreeNode<Branch>[] }> = {};
    for (const b of remoteBranches) {
      const remote = b.name.split('/')[0] ?? 'origin';
      if (!groups[remote]) groups[remote] = { branches: [], tree: [] };
      groups[remote].branches.push(b);
    }
    for (const group of Object.values(groups)) {
      group.tree = buildBranchTree(group.branches, getShortName);
    }
    return groups;
  })();

  let localExpanded = true;
  let remoteExpanded = true;
  let tagsExpanded = true;
  let stashesExpanded = true;
  let worktreesExpanded = true;
  let submodulesExpanded = true;
  let expandedRemotes: Record<string, boolean> = {};
  let expandedGroups: Record<string, boolean> = {};
  let branchGroupsInitialized = false;

  $: if (!branchGroupsInitialized && localBranches.length > 0) {
    const activeBranch = localBranches.find(branch => branch.current)?.name;
    expandedGroups = Object.fromEntries(
      activeBranchGroupPaths(activeBranch ?? '').map(path => [`local:${path}`, true]),
    );
    branchGroupsInitialized = true;
  }

  function toggleRemote(remote: string) {
    expandedRemotes = { ...expandedRemotes, [remote]: !expandedRemotes[remote] };
  }

  function toggleBranchGroup(key: string) {
    expandedGroups = { ...expandedGroups, [key]: !expandedGroups[key] };
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

  function handleSubmoduleKeydown(event: KeyboardEvent, submodule: SubmoduleEntry) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dispatch('submoduleOpen', { path: submodule.path });
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
      <span class="chevron" class:collapsed={!localExpanded}><Icon name="chevron-right" /></span>
      <span class="section-title">LOCAL</span>
      <span class="section-count">{localBranches.length}</span>
    </button>

    {#if localExpanded}
      <BranchTreeList
        nodes={localTree}
        {expandedGroups}
        groupPrefix="local"
        {selectedBranch}
        on:groupToggle={(event) => toggleBranchGroup(event.detail.key)}
        on:select={(event) => dispatch('branchSelect', event.detail)}
        on:checkout={(event) => dispatch('checkout', event.detail)}
        on:contextMenu={(event) => dispatch('branchContextMenu', event.detail)}
      />
    {/if}
  </div>

  <!-- REMOTE section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { remoteExpanded = !remoteExpanded; }}
    >
      <span class="chevron" class:collapsed={!remoteExpanded}><Icon name="chevron-right" /></span>
      <span class="section-title">REMOTE</span>
      <span class="section-count">{remoteBranches.length}</span>
    </button>

    {#if remoteExpanded}
      {#each Object.entries(remoteGroups) as [remote, group] (remote)}
        <div class="remote-group">
          <button
            class="remote-header nested-header"
            aria-label={`Remote group ${remote}`}
            aria-expanded={expandedRemotes[remote] === true}
            on:click={() => toggleRemote(remote)}
          >
            <span class="chevron" class:collapsed={expandedRemotes[remote] !== true}><Icon name="chevron-right" /></span>
            <span class="remote-name">{remote}</span>
            <span class="section-count">{group.branches.length}</span>
          </button>

          {#if expandedRemotes[remote] === true}
            <BranchTreeList
              nodes={group.tree}
              {expandedGroups}
              groupPrefix={`remote:${remote}`}
              {selectedBranch}
              depth={1}
              on:groupToggle={(event) => toggleBranchGroup(event.detail.key)}
              on:select={(event) => dispatch('branchSelect', event.detail)}
              on:checkout={(event) => dispatch('checkout', event.detail)}
              on:contextMenu={(event) => dispatch('branchContextMenu', event.detail)}
            />
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
      <span class="chevron" class:collapsed={!tagsExpanded}><Icon name="chevron-right" /></span>
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
              <span class="branch-icon"><Icon name="tag" /></span>
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
      <span class="chevron" class:collapsed={!stashesExpanded}><Icon name="chevron-right" /></span>
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
              <span class="branch-icon"><Icon name="archive" /></span>
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
      <span class="chevron" class:collapsed={!worktreesExpanded}><Icon name="chevron-right" /></span>
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
              <span class="branch-icon"><Icon name={wt.isMain ? 'root-folder' : 'folder'} /></span>
              <span class="branch-name" title={wt.path}>
                {wt.branch ?? wt.head?.substring(0, 7) ?? '???'}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- SUBMODULES section -->
  <div class="section">
    <button
      class="section-header"
      on:click={() => { submodulesExpanded = !submodulesExpanded; }}
    >
      <span class="chevron" class:collapsed={!submodulesExpanded}><Icon name="chevron-right" /></span>
      <span class="section-title">SUBMODULES</span>
      <span class="section-count">{submodules.length}</span>
    </button>

    {#if submodulesExpanded}
      <ul class="branch-list">
        {#each submodules as submodule (submodule.path)}
          <li>
            <button
              type="button"
              class="branch-item submodule {submodule.state}"
              aria-label={`Submodule ${submodule.name}, ${submodule.path}, ${submodule.head ? `${submodule.head.substring(0, 7)}, ` : ''}${submodule.state}`}
              title={submodule.path}
              on:click={() => dispatch('submoduleOpen', { path: submodule.path })}
              on:keydown={(event) => handleSubmoduleKeydown(event, submodule)}
            >
              <span class="branch-icon"><Icon name="file-submodule" /></span>
              <span class="branch-name">{submodule.name}</span>
              {#if submodule.head}
                <span class="submodule-head">{submodule.head.substring(0, 7)}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .branch-sidebar {
    --sidebar-gutter: 12px;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px 0;
    user-select: none;
    font-size: 13px;
    background: linear-gradient(180deg, 
      var(--vscode-sideBar-background, #1e1e1e) 0%, 
      rgba(255, 255, 255, 0.01) 50%, 
      var(--vscode-sideBar-background, #1e1e1e) 100%
    );
  }

  .section {
    margin-bottom: 4px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 22px;
    padding: 0 12px;
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
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    opacity: 0.8;
    transition: transform 0.15s ease;
    transform: rotate(90deg);
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

  /*
   * A remote group sits INSIDE the REMOTE section, so it must not repeat the
   * section header's treatment. Sharing one rule made `origin` and `REMOTE`
   * pixel-identical and therefore read as siblings.
   */
  .remote-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 26px;
    padding: 0 12px 0 24px;
    border: none;
    background: none;
    color: var(--vscode-foreground, #cccccc);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
  }

  .remote-group {
    margin-left: 0;
  }

  /* Branches under a remote sit one level deeper again. */
  .remote-group :global(.branch-tree) {
    --sidebar-gutter: 32px;
  }

  .remote-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    min-height: 26px;
    padding: 4px 12px 4px 20px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 3px;
    margin: 1px 0;
    width: 100%;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
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
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
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

  .branch-item.submodule.uninitialized .branch-name {
    color: var(--vscode-descriptionForeground, #aaaaaa);
  }

  .branch-item.submodule.modified .branch-name {
    color: var(--vscode-editorWarning-foreground, #d7ba7d);
  }

  .branch-item.submodule.conflicted .branch-name {
    color: var(--vscode-editorError-foreground, #f14c4c);
  }

  .submodule-head {
    margin-left: auto;
    padding-right: 8px;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #aaaaaa);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
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

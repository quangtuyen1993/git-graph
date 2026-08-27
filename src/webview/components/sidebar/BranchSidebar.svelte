<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import BranchTreeList from './BranchTreeList.svelte';
  import PullRequestList from './PullRequestList.svelte';
  import Icon from '../common/Icon.svelte';
  import type { SidebarPersistedState } from '../../lib/sidebar-state';
  import { activeBranchGroupPaths, buildBranchTree, type BranchTreeNode } from '../../lib/branch-tree';
  import { matchesPullRequestQuery } from '../../lib/branch-pull-requests';

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

  interface PullRequestReviewer {
    user: { displayName: string; accountId: string };
    status: 'approved' | 'changes_requested' | 'pending';
  }

  interface PullRequestRow {
    id: string;
    number: number;
    title: string;
    state: 'open' | 'merged' | 'closed' | 'draft';
    sourceBranch: string;
    reviewers: PullRequestReviewer[];
    commentCount: number;
  }

  export let branches: Branch[] = [];
  export let tags: Tag[] = [];
  export let stashes: StashEntry[] = [];
  export let worktrees: WorktreeEntry[] = [];
  export let submodules: SubmoduleEntry[] = [];
  export let selectedBranch: string | null = null;
  export let favourites: string[] = [];

  /*
   * PULL REQUESTS is invisible unless the active repository has a matching
   * forge provider. A plain local repo must never show a trace of this
   * feature, so `forgeAvailable` gates the section, not just its contents.
   */
  export let forgeAvailable = false;
  export let forgeSignedIn = false;
  /** From `forge.status`. No provider vocabulary belongs above forge/bitbucket/ — this is what lets the sign-in row read "Sign in to {provider}" instead of a hardcoded host name. */
  export let forgeProviderName = '';
  export let pullRequests: PullRequestRow[] = [];
  export let pullRequestsStale = false;
  /** Source branch name → live pull request number, for the `#123` badge on a branch row — LOCAL or remote. */
  export let branchPullRequests: Map<string, number> = new Map();

  const dispatch = createEventDispatcher();

  let query = '';
  $: needle = query.trim().toLowerCase();
  $: searching = needle.length > 0;
  const matches = (value: string): boolean => value.toLowerCase().includes(needle);

  $: visibleBranches = searching ? branches.filter((b) => matches(b.name)) : branches;
  $: visibleTags = searching ? tags.filter((t) => matches(t.name)) : tags;
  $: visibleStashes = searching ? stashes.filter((s) => matches(s.message ?? '')) : stashes;
  $: visibleWorktrees = searching
    ? worktrees.filter((w) => matches(w.branch ?? w.path))
    : worktrees;
  $: visibleSubmodules = searching
    ? submodules.filter((m) => matches(m.name) || matches(m.path))
    : submodules;
  $: visiblePullRequests = searching
    ? pullRequests.filter((pr) => matchesPullRequestQuery(pr, needle))
    : pullRequests;

  $: currentBranch = branches.find((b) => b.current) ?? null;

  $: localBranches = visibleBranches.filter(b => !b.remote);
  $: remoteBranches = visibleBranches.filter(b => !!b.remote);
  /*
   * A starred branch is lifted out of its folder and shown at the top of LOCAL
   * under its full name. Sorting inside the tree would not work — the builder
   * sorts by path, and a favourite buried in a collapsed group is exactly the
   * one you starred to stop hunting for.
   */
  $: favouriteNodes = localBranches
    .filter((branch) => favourites.includes(branch.name))
    .map((branch) => ({ label: branch.name, path: branch.name, branch, children: [] }));
  $: localTree = [
    ...favouriteNodes,
    ...buildBranchTree(localBranches.filter((branch) => !favourites.includes(branch.name))),
  ];

  /*
   * A search must reach matches inside collapsed groups, but expanding them for
   * real would rewrite preferences the user set deliberately. So while a query
   * is active the tree renders against a derived expansion, and clearing the
   * query drops straight back to the stored one.
   */
  $: searchExpandedGroups = searching
    ? Object.fromEntries(
      localBranches.flatMap((branch) => activeBranchGroupPaths(branch.name)
        .map((path) => [`local:${path}`, true]))
        .concat(remoteBranches.flatMap((branch) => activeBranchGroupPaths(getShortName(branch))
          .map((path) => [`remote:${branch.name.split('/')[0]}:${path}`, true]))),
    )
    : {};
  $: effectiveGroups = searching
    ? { ...expandedGroups, ...searchExpandedGroups }
    : expandedGroups;
  $: sectionOpen = {
    local: searching ? localBranches.length > 0 : localExpanded,
    remote: searching ? remoteBranches.length > 0 : remoteExpanded,
    tags: searching ? visibleTags.length > 0 : tagsExpanded,
    stashes: searching ? visibleStashes.length > 0 : stashesExpanded,
    worktrees: searching ? visibleWorktrees.length > 0 : worktreesExpanded,
    submodules: searching ? visibleSubmodules.length > 0 : submodulesExpanded,
    /*
     * Signed-out has nothing to filter — its one CTA row isn't a search
     * result, so a branch-name search must not fold it away.
     */
    pullRequests: searching ? (!forgeSignedIn || visiblePullRequests.length > 0) : pullRequestsExpanded,
  };
  /* An empty section during a search is noise, so its header goes too. */
  $: sectionVisible = {
    local: !searching || localBranches.length > 0,
    remote: !searching || remoteBranches.length > 0,
    tags: !searching || visibleTags.length > 0,
    stashes: !searching || visibleStashes.length > 0,
    worktrees: !searching || visibleWorktrees.length > 0,
    submodules: !searching || visibleSubmodules.length > 0,
    pullRequests: forgeAvailable && (!searching || !forgeSignedIn || visiblePullRequests.length > 0),
  };

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

  /*
   * Only LOCAL opens by default. The sidebar lives in a short bottom panel, so
   * six expanded sections push the branch list — the thing you actually came
   * for — off screen. The active branch's group path is still expanded below.
   */
  let localExpanded = true;
  let remoteExpanded = false;
  let tagsExpanded = false;
  let stashesExpanded = false;
  let worktreesExpanded = false;
  let submodulesExpanded = false;
  let pullRequestsExpanded = false;
  let expandedRemotes: Record<string, boolean> = {};
  let expandedGroups: Record<string, boolean> = {};
  let branchGroupsInitialized = false;

  /**
   * Last persisted expand/collapse snapshot, injected by the shell that owns
   * storage. Applied whenever a new object arrives (repo switch included);
   * null resets to the defaults above. While applied state stands, the
   * active-branch auto-expansion below is skipped — the user's own layout
   * outranks the heuristic.
   */
  export let initialState: SidebarPersistedState | null = null;

  let appliedState: SidebarPersistedState | null = null;
  $: if (initialState !== appliedState) {
    appliedState = initialState;
    if (initialState) {
      localExpanded = initialState.sections.local ?? true;
      remoteExpanded = initialState.sections.remote ?? false;
      tagsExpanded = initialState.sections.tags ?? false;
      stashesExpanded = initialState.sections.stashes ?? false;
      worktreesExpanded = initialState.sections.worktrees ?? false;
      submodulesExpanded = initialState.sections.submodules ?? false;
      pullRequestsExpanded = initialState.sections.pullRequests ?? false;
      expandedRemotes = { ...initialState.expandedRemotes };
      expandedGroups = { ...initialState.expandedGroups };
      branchGroupsInitialized = true;
    } else {
      localExpanded = true;
      remoteExpanded = false;
      tagsExpanded = false;
      stashesExpanded = false;
      worktreesExpanded = false;
      submodulesExpanded = false;
      pullRequestsExpanded = false;
      expandedRemotes = {};
      expandedGroups = {};
      branchGroupsInitialized = false;
    }
  }

  function emitState() {
    dispatch('stateChange', {
      sections: {
        local: localExpanded,
        remote: remoteExpanded,
        tags: tagsExpanded,
        stashes: stashesExpanded,
        worktrees: worktreesExpanded,
        submodules: submodulesExpanded,
        pullRequests: pullRequestsExpanded,
      },
      expandedRemotes,
      expandedGroups,
    } satisfies SidebarPersistedState);
  }

  $: if (!branchGroupsInitialized && localBranches.length > 0) {
    const activeBranch = localBranches.find(branch => branch.current)?.name;
    expandedGroups = Object.fromEntries(
      activeBranchGroupPaths(activeBranch ?? '').map(path => [`local:${path}`, true]),
    );
    branchGroupsInitialized = true;
  }

  function toggleRemote(remote: string) {
    expandedRemotes = { ...expandedRemotes, [remote]: !expandedRemotes[remote] };
    emitState();
  }

  function toggleBranchGroup(key: string) {
    expandedGroups = { ...expandedGroups, [key]: !expandedGroups[key] };
    emitState();
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
  <div class="sidebar-search">
    <span class="search-icon"><Icon name="search" size={14} /></span>
    <input
      type="text"
      placeholder="Branch or tag"
      aria-label="Filter branches and tags"
      bind:value={query}
      on:keydown={(event) => { if (event.key === 'Escape') query = ''; }}
    />
    {#if searching}
      <button type="button" class="search-clear" aria-label="Clear filter" on:click={() => { query = ''; }}>
        <Icon name="close" size={12} />
      </button>
    {/if}
  </div>

  {#if currentBranch}
    <button
      type="button"
      class="head-row"
      aria-label={`HEAD, current branch ${currentBranch.name}`}
      on:click={() => dispatch('branchSelect', { name: currentBranch.name })}
      on:contextmenu|preventDefault|stopPropagation={(event) => dispatch('branchContextMenu', { event, branch: currentBranch })}
    >
      <span class="head-icon"><Icon name="check" size={14} /></span>
      <span class="head-label">HEAD</span>
      <span class="head-branch">{currentBranch.name}</span>
    </button>
  {/if}

  <!-- LOCAL section -->
  {#if sectionVisible.local}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { localExpanded = !localExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.local}><Icon name="chevron-right" /></span>
      <span class="section-title">LOCAL</span>
      <span class="section-count">{localBranches.length}</span>
    </button>

    {#if sectionOpen.local}
      <BranchTreeList
        nodes={localTree}
        expandedGroups={effectiveGroups}
        groupPrefix="local"
        {selectedBranch}
        {favourites}
        {branchPullRequests}
        on:groupToggle={(event) => toggleBranchGroup(event.detail.key)}
        on:select={(event) => dispatch('branchSelect', event.detail)}
        on:checkout={(event) => dispatch('checkout', event.detail)}
        on:contextMenu={(event) => dispatch('branchContextMenu', event.detail)}
        on:favouriteToggle={(event) => dispatch('favouriteToggle', event.detail)}
      />
    {/if}
  </div>
  {/if}

  <!-- REMOTE section -->
  {#if sectionVisible.remote}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { remoteExpanded = !remoteExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.remote}><Icon name="chevron-right" /></span>
      <span class="section-title">REMOTE</span>
      <span class="section-count">{remoteBranches.length}</span>
    </button>

    {#if sectionOpen.remote}
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
              expandedGroups={effectiveGroups}
              groupPrefix={`remote:${remote}`}
              {selectedBranch}
              {branchPullRequests}
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
  {/if}

  <!-- TAGS section -->
  {#if sectionVisible.tags}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { tagsExpanded = !tagsExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.tags}><Icon name="chevron-right" /></span>
      <span class="section-title">TAGS</span>
      <span class="section-count">{visibleTags.length}</span>
    </button>

    {#if sectionOpen.tags}
      <ul class="branch-list">
        {#each visibleTags as tag (tag.name)}
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
  {/if}

  <!-- STASHES section -->
  {#if sectionVisible.stashes}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { stashesExpanded = !stashesExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.stashes}><Icon name="chevron-right" /></span>
      <span class="section-title">STASHES</span>
      <span class="section-count">{visibleStashes.length}</span>
    </button>

    {#if sectionOpen.stashes}
      <ul class="branch-list">
        {#each visibleStashes as stash (stash.index)}
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
  {/if}

  <!-- WORKTREES section -->
  {#if sectionVisible.worktrees}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { worktreesExpanded = !worktreesExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.worktrees}><Icon name="chevron-right" /></span>
      <span class="section-title">WORKTREES</span>
      <span class="section-count">{visibleWorktrees.length}</span>
    </button>

    {#if sectionOpen.worktrees}
      <ul class="branch-list">
        {#each visibleWorktrees as wt (wt.path)}
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
  {/if}

  <!-- SUBMODULES section -->
  {#if sectionVisible.submodules}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { submodulesExpanded = !submodulesExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.submodules}><Icon name="chevron-right" /></span>
      <span class="section-title">SUBMODULES</span>
      <span class="section-count">{visibleSubmodules.length}</span>
    </button>

    {#if sectionOpen.submodules}
      <ul class="branch-list">
        {#each visibleSubmodules as submodule (submodule.path)}
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
  {/if}

  <!-- PULL REQUESTS section -->
  {#if sectionVisible.pullRequests}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { pullRequestsExpanded = !pullRequestsExpanded; emitState(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.pullRequests}><Icon name="chevron-right" /></span>
      <span class="section-title">PULL REQUESTS</span>
      <span class="section-count">{visiblePullRequests.length}</span>
    </button>

    {#if sectionOpen.pullRequests}
      <PullRequestList
        {pullRequests}
        stale={pullRequestsStale}
        signedIn={forgeSignedIn}
        providerName={forgeProviderName || 'your forge'}
        {query}
        on:select
        on:signIn
      />
    {/if}
  </div>
  {/if}
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
    /* Flat, not a gradient: the old middle stop was raw white, which washed
       out the panel on light themes and belonged to no theme token. */
    background: var(--vscode-sideBar-background, #1e1e1e);
  }

  .sidebar-search {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 12px 8px;
    padding: 0 6px;
    height: 26px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    background: var(--vscode-input-background, rgba(128, 128, 128, 0.1));
  }

  .sidebar-search:focus-within {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .search-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .sidebar-search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    outline: none;
    color: var(--vscode-input-foreground, inherit);
    font-family: inherit;
    font-size: 13px;
  }

  .search-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--vscode-descriptionForeground, #767676);
    cursor: pointer;
  }

  .search-clear:hover {
    color: var(--vscode-foreground, inherit);
  }

  /* Always reachable, whatever LOCAL is doing or the filter is hiding. */
  .head-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 30px;
    padding: 4px 12px;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .head-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
  }

  .head-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
  }

  .head-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--vscode-testing-iconPassed, #6a9955);
  }

  .head-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground, #767676);
  }

  .head-branch {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    font-size: 11px;
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
    height: 30px;
    padding: 0 12px 0 28px;
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
    min-height: 30px;
    padding: 6px 12px 6px 20px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 3px;
    margin: 1px 0;
    width: 100%;
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
    font-size: 11px;
  }

</style>

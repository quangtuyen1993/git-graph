<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount, tick } from 'svelte';
  import { calculateVisibleRange, getTotalHeight, ROW_HEIGHT, BUFFER_ROWS } from './lib/virtual-scroll';
  import GraphCanvas from './components/graph/GraphCanvas.svelte';
  import ContextMenu from './components/actions/ContextMenu.svelte';
  import type { MenuItem } from './types/menu.types';
  import { getGravatarUrl } from './lib/gravatar';
  import CommitDetail from './components/detail/CommitDetail.svelte';
  import BranchSidebar from './components/sidebar/BranchSidebar.svelte';
  import ResizeHandle from './components/layout/ResizeHandle.svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
    remote: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  }

  interface GraphNode {
    hash: string;
    abbreviatedHash: string;
    subject: string;
    author: string;
    authorDate: string;
    refs: string[];
    parents: string[];
    lane: number;
    row: number;
    color: number;
  }

  interface GraphEdge {
    fromHash: string;
    toHash: string;
    fromRow: number;
    fromLane: number;
    toRow: number;
    toLane: number;
    color: number;
  }

  interface GraphWindow {
    nodes: GraphNode[];
    edges: GraphEdge[];
    startRow: number;
    endRow: number;
    totalRows: number;
    maxLane: number;
  }

  let status = 'Loading...';
  let branches: Branch[] = [];
  let tags: { name: string; hash: string; message: string | null; taggerDate: string | null }[] = [];
  let stashes: { index: number; message: string; date: string; branch: string; hash: string }[] = [];
  let worktrees: { path: string; head: string; branch: string | null; bare: boolean; isMain: boolean }[] = [];
  let error = '';

  // Multi-repo state
  interface RepoEntry {
    name: string;
    path: string;
    active: boolean;
  }
  let repos: RepoEntry[] = [];
  let activeRepoName = '';

  // Graph state
  let totalRows = 0;
  let maxLane = 0;
  let graphWindow: GraphWindow | null = null;
  let selectedHash: string | null = null;
  let selectedHashes: Set<string> = new Set();
  let lastClickedHash: string | null = null;
  let hasWorkingChanges = false;

  // Virtual scroll state
  let scrollContainer: HTMLDivElement;
  let viewportHeight = 600;
  let scrollTop = 0;
  let currentStartRow = 0;
  let loading = false;

  // Commit detail state
  let detailCommit: {
    hash: string;
    abbreviatedHash: string;
    subject: string;
    message: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    refs: string[];
  } | null = null;
  let detailFiles: {
    path: string;
    oldPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }[] | null = null;
  let detailLoading = false;

  // Panel state
  let leftSidebarOpen = true;
  let rightPanelOpen = false;
  let leftSidebarWidth = 200;
  let rightPanelWidth = 340;

  // Context menu state
  let contextMenuVisible = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let contextMenuItems: MenuItem[] = [];
  let contextMenuTarget: { type: 'commit' | 'branch'; value: string } | null = null;

  // Computed graph column width
  $: graphColWidth = (maxLane + 1) * 16 + 24;

  onMount(async () => {
    try {
      await bridge.send('ping.hello');
      // Load repos list
      const repoResult = await bridge.send('repo.list') as { repos: RepoEntry[] };
      repos = repoResult.repos;
      const active = repos.find(r => r.active);
      activeRepoName = active?.name ?? repos[0]?.name ?? '';
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }

    bridge.on('graph.invalidated', () => {
      refreshGraph();
    });
  });

  async function switchRepo(path: string) {
    try {
      const result = await bridge.send('repo.switch', { path }) as { name: string };
      activeRepoName = result.name;
      repos = repos.map(r => ({ ...r, active: r.path === path }));
      selectedHash = null;
      selectedHashes = new Set();
      rightPanelOpen = false;
      detailCommit = null;
      detailFiles = null;
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function refreshGraph() {
    branches = await bridge.send('git.branches') as Branch[];
    tags = await bridge.send('git.tags') as typeof tags;
    stashes = await bridge.send('git.stashList') as typeof stashes;
    worktrees = await bridge.send('git.worktreeList') as typeof worktrees;

    try {
      const st = await bridge.send('git.status') as { files?: unknown[] };
      hasWorkingChanges = Array.isArray(st?.files) && st.files.length > 0;
    } catch {
      hasWorkingChanges = false;
    }

    const result = await bridge.send('graph.build', { all: true, maxCount: 500 }) as { totalRows: number; maxLane: number };
    totalRows = result.totalRows;
    maxLane = result.maxLane;

    const range = calculateVisibleRange({ scrollTop, viewportHeight, totalRows });
    await fetchWindow(range.startRow);

    status = `${branches.length} branches, ${totalRows} commits`;
  }

  async function fetchWindow(startRow: number) {
    if (loading) return;
    loading = true;
    try {
      const count = Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
      graphWindow = await bridge.send('graph.getWindow', { startRow, count }) as GraphWindow;
      currentStartRow = startRow;
    } finally {
      loading = false;
    }
  }

  function handleScroll() {
    if (!scrollContainer) return;
    scrollTop = scrollContainer.scrollTop;
    viewportHeight = scrollContainer.clientHeight;

    const range = calculateVisibleRange({ scrollTop, viewportHeight, totalRows });

    if (graphWindow) {
      const needsFetch =
        range.startRow < graphWindow.startRow ||
        range.endRow > graphWindow.endRow;

      if (needsFetch) {
        fetchWindow(range.startRow);
      }
    }
  }

  function handleRowClick(hash: string, event?: MouseEvent) {
    if (event?.shiftKey && lastClickedHash && graphWindow) {
      const allNodes = graphWindow.nodes;
      const lastIdx = allNodes.findIndex(n => n.hash === lastClickedHash);
      const currIdx = allNodes.findIndex(n => n.hash === hash);

      if (lastIdx !== -1 && currIdx !== -1) {
        const start = Math.min(lastIdx, currIdx);
        const end = Math.max(lastIdx, currIdx);
        selectedHashes = new Set(allNodes.slice(start, end + 1).map(n => n.hash));
        selectedHash = hash;
        if (selectedHashes.size > 1) {
          detailCommit = null;
          detailFiles = null;
          return;
        }
      }
    } else {
      selectedHashes = new Set(hash !== 'WORKING' ? [hash] : []);
      lastClickedHash = hash !== 'WORKING' ? hash : null;
      selectedHash = hash;
    }

    if (hash && hash !== 'WORKING') {
      rightPanelOpen = true;
      fetchCommitDetail(hash);
    } else {
      detailCommit = null;
      detailFiles = null;
    }
  }

  function closeRightPanel() {
    rightPanelOpen = false;
    selectedHash = null;
    selectedHashes = new Set();
    detailCommit = null;
    detailFiles = null;
  }

  async function fetchCommitDetail(hash: string) {
    detailLoading = true;
    detailFiles = null;
    try {
      const result = await bridge.send('git.show', { hash }) as {
        commit: {
          hash: string;
          abbreviatedHash: string;
          subject: string;
          message: string;
          author: string;
          authorEmail: string;
          authorDate: string;
          refs: string[];
        };
        files: {
          path: string;
          oldPath: string | null;
          status: string;
          additions: number;
          deletions: number;
          binary: boolean;
        }[];
      };
      if (selectedHash === hash) {
        detailCommit = result.commit;
        detailFiles = result.files;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    } finally {
      detailLoading = false;
    }
  }

  async function handleRowContextMenu(event: MouseEvent, hash: string) {
    event.preventDefault();
    contextMenuVisible = false;
    await tick();

    if (selectedHashes.size > 1 && selectedHashes.has(hash)) {
      contextMenuTarget = { type: 'commit', value: hash };
      contextMenuX = event.clientX;
      contextMenuY = event.clientY;
      const count = selectedHashes.size;

      const hashes = graphWindow
        ? graphWindow.nodes.filter(n => selectedHashes.has(n.hash)).map(n => n.hash)
        : [...selectedHashes];

      let canSquash = false;
      try {
        const result = await bridge.send('git.canSquash', { hashes }) as { ok: boolean; reason?: string };
        canSquash = result.ok;
      } catch {
        canSquash = false;
      }

      contextMenuItems = [
        ...(canSquash
          ? [{ label: `Squash ${count} commits...`, action: 'squash' }]
          : [{ label: `Squash (not available)`, action: '', disabled: true }]
        ),
        { label: '', action: '', divider: true },
        { label: 'Copy SHAs', action: 'copyShas' },
      ];
      contextMenuVisible = true;
      return;
    }

    contextMenuTarget = { type: 'commit', value: hash };
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;

    let onCurrentBranch = false;
    try {
      const result = await bridge.send('git.isOnCurrentBranch', { hash }) as { onBranch: boolean };
      onCurrentBranch = result.onBranch;
    } catch {
      onCurrentBranch = false;
    }

    contextMenuItems = [
      { label: 'Checkout this commit', action: 'checkout' },
      { label: 'Create branch here...', action: 'createBranch' },
      { label: 'Create tag here...', action: 'createTag' },
      { label: '', action: '', divider: true },
      { label: 'Reword message...', action: 'reword', disabled: !onCurrentBranch },
      { label: 'Cherry-pick', action: 'cherryPick', disabled: onCurrentBranch },
      { label: 'Revert', action: 'revert', disabled: !onCurrentBranch },
      { label: '', action: '', divider: true },
      { label: 'Reset soft to here', action: 'resetSoft', disabled: !onCurrentBranch },
      { label: 'Reset mixed to here', action: 'resetMixed', disabled: !onCurrentBranch },
      { label: 'Reset hard to here', action: 'resetHard', danger: true, disabled: !onCurrentBranch },
      { label: '', action: '', divider: true },
      { label: 'Copy SHA', action: 'copySha' },
    ];
    contextMenuVisible = true;
  }

  async function handleBranchContextMenu(event: CustomEvent<{ event: MouseEvent; branch: Branch }>) {
    const { event: mouseEvent, branch } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: branch.name };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;

    if (branch.remote) {
      // Remote branch menu
      contextMenuItems = [
        { label: 'Checkout', action: 'checkout' },
        { label: 'Merge into current branch', action: 'merge' },
        { label: '', action: '', divider: true },
        { label: 'Delete remote branch', action: 'deleteRemoteBranch', danger: true },
      ];
    } else if (branch.current) {
      // Current branch menu (can't delete or checkout)
      const hasUpstream = !!branch.upstream;
      contextMenuItems = [
        { label: hasUpstream ? 'Push' : 'Publish', action: hasUpstream ? 'push' : 'publish' },
        ...(hasUpstream ? [{ label: 'Pull', action: 'pull' }] : []),
        { label: 'Fetch', action: 'fetch' },
        { label: '', action: '', divider: true },
        { label: 'Rename branch...', action: 'renameBranch' },
      ];
    } else {
      // Local branch menu
      const hasUpstream = !!branch.upstream;
      contextMenuItems = [
        { label: 'Checkout', action: 'checkout' },
        { label: 'Merge into current branch', action: 'merge' },
        { label: 'Rebase current onto this', action: 'rebase' },
        { label: '', action: '', divider: true },
        { label: hasUpstream ? 'Push' : 'Publish', action: hasUpstream ? 'push' : 'publish' },
        ...(hasUpstream ? [{ label: 'Pull', action: 'pull' }] : []),
        { label: 'Fetch', action: 'fetch' },
        { label: '', action: '', divider: true },
        { label: 'Rename branch...', action: 'renameBranch' },
        { label: 'Delete branch', action: 'deleteBranch', danger: true },
        ...(hasUpstream ? [{ label: 'Delete branch + remote', action: 'deleteBranchAndRemote', danger: true }] : []),
      ];
    }
    contextMenuVisible = true;
  }

  async function handleTagContextMenu(event: CustomEvent<{ event: MouseEvent; tag: { name: string; hash: string } }>) {
    const { event: mouseEvent, tag } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: tag.name };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;
    contextMenuItems = [
      { label: 'Checkout tag', action: 'checkout' },
      { label: 'Create branch from tag...', action: 'createBranchFromTag' },
      { label: '', action: '', divider: true },
      { label: 'Push tag to remote', action: 'pushTag' },
      { label: '', action: '', divider: true },
      { label: 'Delete tag', action: 'deleteTag', danger: true },
      { label: 'Delete tag (local + remote)', action: 'deleteTagAndRemote', danger: true },
    ];
    contextMenuVisible = true;
  }

  async function handleStashContextMenu(event: CustomEvent<{ event: MouseEvent; stash: { index: number; message: string } }>) {
    const { event: mouseEvent, stash } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: String(stash.index) };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;
    contextMenuItems = [
      { label: 'Apply', action: 'stashApply' },
      { label: 'Pop (apply + delete)', action: 'stashPop' },
      { label: '', action: '', divider: true },
      { label: 'Drop', action: 'stashDrop', danger: true },
    ];
    contextMenuVisible = true;
  }

  async function handleWorktreeContextMenu(event: CustomEvent<{ event: MouseEvent; worktree: { path: string; isMain: boolean; branch: string | null } }>) {
    const { event: mouseEvent, worktree } = event.detail;
    contextMenuVisible = false;
    await tick();

    contextMenuTarget = { type: 'branch', value: worktree.path };
    contextMenuX = mouseEvent.clientX;
    contextMenuY = mouseEvent.clientY;

    if (worktree.isMain) {
      contextMenuItems = [
        { label: 'Add new worktree...', action: 'worktreeAdd' },
      ];
    } else {
      contextMenuItems = [
        { label: 'Open in new window', action: 'worktreeOpen' },
        { label: '', action: '', divider: true },
        { label: 'Add new worktree...', action: 'worktreeAdd' },
        { label: 'Remove worktree', action: 'worktreeRemove', danger: true },
      ];
    }
    contextMenuVisible = true;
  }

  async function handleBranchCheckout(event: CustomEvent<{ name: string }>) {
    try {
      await bridge.send('git.checkout', { ref: event.detail.name });
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleContextMenuAction(event: CustomEvent<{ action: string }>) {
    const action = event.detail.action;
    if (!contextMenuTarget) return;

    try {
      if (contextMenuTarget.type === 'commit') {
        const hash = contextMenuTarget.value;
        switch (action) {
          case 'checkout':
            await bridge.send('git.checkout', { ref: hash });
            break;
          case 'createBranch': {
            const name = await bridge.send('ui.inputBox', { prompt: 'Branch name:', placeholder: 'new-branch' }) as string | null;
            if (name) await bridge.send('git.createBranch', { name, startPoint: hash });
            break;
          }
          case 'createTag': {
            const name = await bridge.send('ui.inputBox', { prompt: 'Tag name:', placeholder: 'v1.0.0' }) as string | null;
            if (name) await bridge.send('git.createTag', { name, hash });
            break;
          }
          case 'cherryPick':
            await bridge.send('git.cherryPick', { hash });
            break;
          case 'revert':
            await bridge.send('git.revert', { hash });
            break;
          case 'reword': {
            // Get current commit message
            const commitInfo = await bridge.send('git.show', { hash }) as { commit: { message: string; subject: string } };
            const currentMsg = commitInfo.commit.message || commitInfo.commit.subject;
            const newMsg = await bridge.send('ui.inputBox', {
              prompt: 'Edit commit message:',
              placeholder: currentMsg,
              value: currentMsg
            }) as string | null;
            if (newMsg && newMsg !== currentMsg) {
              const { published } = await bridge.send('git.isPublished', { hash }) as { published: boolean };
              if (published) {
                const confirmed = await bridge.send('ui.confirm', {
                  message: 'Rewording this published commit changes descendant hashes and may require a force-push. Continue?'
                }) as boolean;
                if (!confirmed) break;
              }
              await bridge.send('git.reword', { hash, message: newMsg });
            }
            break;
          }
          case 'resetSoft':
            await bridge.send('git.reset', { mode: 'soft', ref: hash });
            break;
          case 'resetMixed':
            await bridge.send('git.reset', { mode: 'mixed', ref: hash });
            break;
          case 'resetHard': {
            const confirmed = await bridge.send('ui.confirm', { message: 'Reset HARD will discard all uncommitted changes. Continue?' }) as boolean;
            if (confirmed) {
              await bridge.send('git.reset', { mode: 'hard', ref: hash });
            }
            break;
          }
          case 'copySha':
            await navigator.clipboard.writeText(hash);
            break;
          case 'squash': {
            const hashes = graphWindow
              ? graphWindow.nodes.filter(n => selectedHashes.has(n.hash)).map(n => n.hash)
              : [...selectedHashes];

            const oldestHash = hashes[hashes.length - 1];
            const defaultMsg = graphWindow?.nodes.find(n => n.hash === oldestHash)?.subject ?? '';

            const message = await bridge.send('ui.inputBox', {
              prompt: `Squash ${hashes.length} commits into one. Enter commit message:`,
              placeholder: defaultMsg,
              value: defaultMsg
            }) as string | null;

            if (message) {
              const published = (await Promise.all(
                hashes.map(async (selectedHash) => {
                  const result = await bridge.send('git.isPublished', { hash: selectedHash }) as { published: boolean };
                  return result.published;
                })
              )).some(Boolean);
              if (published) {
                const confirmed = await bridge.send('ui.confirm', {
                  message: 'Squashing published commits changes descendant hashes and may require a force-push. Continue?'
                }) as boolean;
                if (!confirmed) break;
              }
              await bridge.send('git.squash', { hashes, message });
              selectedHashes = new Set();
              selectedHash = null;
            }
            break;
          }
          case 'copyShas': {
            const shas = graphWindow
              ? graphWindow.nodes.filter(n => selectedHashes.has(n.hash)).map(n => n.hash)
              : [...selectedHashes];
            await navigator.clipboard.writeText(shas.join('\n'));
            break;
          }
        }
      } else if (contextMenuTarget.type === 'branch') {
        const branchName = contextMenuTarget.value;
        switch (action) {
          case 'checkout':
            await bridge.send('git.checkout', { ref: branchName });
            break;
          case 'merge':
            await bridge.send('git.merge', { branch: branchName });
            break;
          case 'rebase':
            await bridge.send('git.rebase', { onto: branchName });
            break;
          case 'push':
            await bridge.send('git.push', { remote: 'origin', branch: branchName });
            break;
          case 'publish':
            await bridge.send('git.push', { remote: 'origin', branch: branchName, options: { setUpstream: true } });
            break;
          case 'pull':
            await bridge.send('git.pull', { remote: 'origin', branch: branchName });
            break;
          case 'fetch':
            await bridge.send('git.fetch', { remote: 'origin' });
            break;
          case 'renameBranch': {
            const newName = await bridge.send('ui.inputBox', { prompt: 'New branch name:', placeholder: branchName, value: branchName }) as string | null;
            if (newName && newName !== branchName) {
              await bridge.send('git.renameBranch', { oldName: branchName, newName });
            }
            break;
          }
          case 'deleteBranch': {
            const confirmed = await bridge.send('ui.confirm', { message: `Delete branch "${branchName}"?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.deleteBranch', { name: branchName });
            }
            break;
          }
          case 'deleteBranchAndRemote': {
            const confirmed = await bridge.send('ui.confirm', { message: `Delete branch "${branchName}" locally AND from remote?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.deleteBranch', { name: branchName });
              await bridge.send('git.push', { remote: 'origin', branch: `:${branchName}` });
            }
            break;
          }
          case 'deleteRemoteBranch': {
            const shortName = branchName.replace(/^[^/]+\//, '');
            const remote = branchName.split('/')[0] || 'origin';
            const confirmed = await bridge.send('ui.confirm', { message: `Delete remote branch "${branchName}"?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.push', { remote, branch: `:${shortName}` });
            }
            break;
          }
          // Tag actions
          case 'createBranchFromTag': {
            const name = await bridge.send('ui.inputBox', { prompt: 'Branch name from tag:', placeholder: `branch-from-${branchName}` }) as string | null;
            if (name) await bridge.send('git.createBranch', { name, startPoint: branchName });
            break;
          }
          case 'pushTag':
            await bridge.send('git.push', { remote: 'origin', branch: `refs/tags/${branchName}` });
            break;
          case 'deleteTag': {
            const confirmed = await bridge.send('ui.confirm', { message: `Delete tag "${branchName}"?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.deleteTag', { name: branchName });
            }
            break;
          }
          case 'deleteTagAndRemote': {
            const confirmed = await bridge.send('ui.confirm', { message: `Delete tag "${branchName}" locally and from remote?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.deleteTag', { name: branchName });
              await bridge.send('git.push', { remote: 'origin', branch: `:refs/tags/${branchName}` });
            }
            break;
          }
          // Stash actions
          case 'stashApply':
            await bridge.send('git.stashApply', { index: parseInt(branchName) });
            break;
          case 'stashPop':
            await bridge.send('git.stashPop', { index: parseInt(branchName) });
            break;
          case 'stashDrop': {
            const confirmed = await bridge.send('ui.confirm', { message: `Drop stash@{${branchName}}?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.stashDrop', { index: parseInt(branchName) });
            }
            break;
          }
          // Worktree actions
          case 'worktreeAdd': {
            const wtPath = await bridge.send('ui.inputBox', { prompt: 'Worktree path:', placeholder: '../my-worktree' }) as string | null;
            if (wtPath) {
              const wtBranch = await bridge.send('ui.inputBox', { prompt: 'New branch name (leave empty for detached):', placeholder: '' }) as string | null;
              await bridge.send('git.worktreeAdd', { path: wtPath, newBranch: wtBranch || undefined });
            }
            break;
          }
          case 'worktreeRemove': {
            const confirmed = await bridge.send('ui.confirm', { message: `Remove worktree at "${branchName}"?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.worktreeRemove', { path: branchName });
            }
            break;
          }
          case 'worktreeOpen':
            await bridge.send('ui.openFolder', { path: branchName });
            break;
        }
      }

      if (action !== 'copySha' && action !== 'copyShas') {
        await refreshGraph();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }

    contextMenuTarget = null;
  }

  function formatRelativeTime(dateStr: string): string {
    const now = Date.now();
    const date = new Date(dateStr).getTime();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(months / 12);
    return `${years}y ago`;
  }

  function getRefType(ref: string): 'head' | 'tag' | 'branch' {
    if (ref.includes('HEAD')) return 'head';
    if (ref.startsWith('tag:')) return 'tag';
    return 'branch';
  }

  function getRefDisplayName(ref: string): string {
    return ref.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
  }
</script>

<div class="container">
  <header class="toolbar">
    <button
      class="toolbar-icon-btn"
      class:active={leftSidebarOpen}
      on:click={() => { leftSidebarOpen = !leftSidebarOpen; }}
      title="Toggle branches panel"
    >☰</button>
    <h1>Git Graph</h1>
    {#if repos.length > 1}
      <select
        class="repo-selector"
        on:change={(e) => switchRepo(e.currentTarget.value)}
      >
        {#each repos as repo}
          <option value={repo.path} selected={repo.active}>{repo.name}</option>
        {/each}
      </select>
    {:else if activeRepoName}
      <span class="repo-name">{activeRepoName}</span>
    {/if}
    <span class="status">{status}</span>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <div class="content-area">
    <!-- Left sidebar: Branches -->
    {#if leftSidebarOpen}
      <aside class="left-sidebar" style="width: {leftSidebarWidth}px;">
        <BranchSidebar
          {branches}
          {tags}
          {stashes}
          {worktrees}
          on:branchContextMenu={handleBranchContextMenu}
          on:tagContextMenu={handleTagContextMenu}
          on:stashContextMenu={handleStashContextMenu}
          on:worktreeContextMenu={handleWorktreeContextMenu}
          on:checkout={handleBranchCheckout}
        />
      </aside>
      <ResizeHandle
        side="left"
        bind:currentWidth={leftSidebarWidth}
        minWidth={150}
        maxWidth={400}
      />
    {/if}

    <!-- Center: Graph -->
    <div class="center-panel">
      <div class="table-header" style="--graph-col-width: {graphColWidth}px">
        <div class="col-graph">&#160;</div>
        <div class="col-message">MESSAGE</div>
        <div class="col-date">DATE</div>
        <div class="col-sha">SHA</div>
        <div class="col-author">AUTHOR</div>
      </div>

      <section class="scroll-area" bind:this={scrollContainer} on:scroll={handleScroll}>
        <div class="scroll-content" style="height: {getTotalHeight(totalRows + (hasWorkingChanges ? 1 : 0))}px;">
          {#if graphWindow}
            <div
              class="graph-svg-overlay"
              style="top: {currentStartRow * ROW_HEIGHT + (hasWorkingChanges ? ROW_HEIGHT : 0)}px; width: {graphColWidth}px;"
            >
              <GraphCanvas
                nodes={graphWindow.nodes}
                edges={graphWindow.edges}
                startRow={graphWindow.startRow}
                maxLane={graphWindow.maxLane}
              />
            </div>
          {/if}

          {#if hasWorkingChanges}
            <div
              class="commit-row working-changes"
              style="top: 0; --graph-col-width: {graphColWidth}px"
              class:selected={selectedHash === 'WORKING'}
              on:click={() => handleRowClick('WORKING')}
              on:keydown={(e) => { if (e.key === 'Enter') handleRowClick('WORKING'); }}
              on:contextmenu={(e) => handleRowContextMenu(e, 'WORKING')}
              role="row"
              tabindex="0"
            >
              <div class="col-graph"></div>
              <div class="col-message">
                <span class="working-label">● Working Changes</span>
              </div>
              <div class="col-date"></div>
              <div class="col-sha"></div>
              <div class="col-author"></div>
            </div>
          {/if}

          {#if graphWindow}
            {#each graphWindow.nodes as node (node.hash)}
              <div
                class="commit-row"
                style="top: {(node.row - graphWindow.startRow + currentStartRow) * ROW_HEIGHT + (hasWorkingChanges ? ROW_HEIGHT : 0)}px; --graph-col-width: {graphColWidth}px"
                class:selected={selectedHash === node.hash || selectedHashes.has(node.hash)}
                on:click={(e) => handleRowClick(node.hash, e)}
                on:keydown={(e) => { if (e.key === 'Enter') handleRowClick(node.hash); }}
                on:contextmenu={(e) => handleRowContextMenu(e, node.hash)}
                role="row"
                tabindex="0"
              >
                <div class="col-graph"></div>
                <div class="col-message">
                  {#each node.refs as ref}
                    <span class="ref-badge ref-{getRefType(ref)}">{getRefDisplayName(ref)}</span>
                  {/each}
                  <span class="commit-subject">{node.subject}</span>
                </div>
                <div class="col-date">{formatRelativeTime(node.authorDate)}</div>
                <div class="col-sha">{node.abbreviatedHash}</div>
                <div class="col-author">
                  <img
                    src={getGravatarUrl(node.authorEmail || '')}
                    alt={node.author}
                    title={node.author}
                    class="avatar"
                    width="18"
                    height="18"
                  />
                  <span class="author-name">{node.author}</span>
                </div>
              </div>
            {/each}
          {:else}
            <div class="loading">Loading graph...</div>
          {/if}
        </div>
      </section>
    </div>

    <!-- Right panel: Commit Detail -->
    {#if rightPanelOpen}
      <ResizeHandle
        side="right"
        bind:currentWidth={rightPanelWidth}
        minWidth={280}
        maxWidth={600}
      />
      <aside class="right-panel" style="width: {rightPanelWidth}px;">
        <div class="right-panel-header">
          <span class="right-panel-title">COMMIT</span>
          <button class="close-btn" on:click={closeRightPanel} title="Close panel">×</button>
        </div>
        <CommitDetail
          commit={detailCommit}
          files={detailFiles}
          loading={detailLoading}
          on:openFile={(e) => bridge.send('ui.openDiff', e.detail)}
        />
      </aside>
    {/if}
  </div>

  <ContextMenu
    items={contextMenuItems}
    x={contextMenuX}
    y={contextMenuY}
    visible={contextMenuVisible}
    on:action={handleContextMenuAction}
    on:close={() => { contextMenuVisible = false; }}
  />
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
  }

  /* Toolbar */
  .toolbar {
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    background: var(--vscode-titleBar-activeBackground, #1e1e1e);
  }

  .toolbar h1 {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }

  .toolbar-icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground, #cccccc);
    font-size: 16px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    opacity: 0.7;
  }

  .toolbar-icon-btn:hover,
  .toolbar-icon-btn.active {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  .status {
    font-size: 11px;
    opacity: 0.6;
    margin-left: auto;
  }

  .repo-selector {
    padding: 2px 6px;
    border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
    background: var(--vscode-dropdown-background, #1e1e1e);
    color: var(--vscode-dropdown-foreground, #cccccc);
    font-size: 12px;
    border-radius: 3px;
    outline: none;
    cursor: pointer;
  }

  .repo-selector:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .repo-name {
    font-size: 12px;
    opacity: 0.8;
    font-weight: 500;
  }

  .error-banner {
    padding: 6px 12px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f44747);
    font-size: 12px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  }

  /* Content area: 3-panel layout */
  .content-area {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  /* Left sidebar */
  .left-sidebar {
    flex-shrink: 0;
    border-right: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-sideBar-background, #1e1e1e);
    overflow: hidden;
  }

  /* Center panel */
  .center-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 300px;
  }

  /* Right panel */
  .right-panel {
    flex-shrink: 0;
    border-left: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-sideBar-background, #1e1e1e);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .right-panel-header {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    flex-shrink: 0;
  }

  .right-panel-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
  }

  .close-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--vscode-foreground, #cccccc);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    border-radius: 3px;
    opacity: 0.6;
  }

  .close-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }

  /* Table header */
  .table-header {
    display: flex;
    align-items: center;
    height: 28px;
    padding: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.5;
    flex-shrink: 0;
    user-select: none;
  }

  .table-header .col-graph {
    width: var(--graph-col-width);
    min-width: var(--graph-col-width);
    flex-shrink: 0;
  }

  .table-header .col-message {
    flex: 1;
    padding-left: 8px;
  }

  .table-header .col-date {
    width: 80px;
    min-width: 80px;
    padding-left: 8px;
  }

  .table-header .col-sha {
    width: 70px;
    min-width: 70px;
    padding-left: 8px;
  }

  .table-header .col-author {
    width: 140px;
    min-width: 140px;
    padding-left: 8px;
    padding-right: 8px;
  }

  /* Scroll area */
  .scroll-area {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
  }

  .scroll-content {
    position: relative;
    min-width: 100%;
  }

  .graph-svg-overlay {
    position: absolute;
    left: 0;
    z-index: 1;
    pointer-events: none;
  }

  /* Commit rows */
  .commit-row {
    position: absolute;
    left: 0;
    right: 0;
    height: 32px;
    display: flex;
    align-items: center;
    cursor: pointer;
    user-select: none;
    border-bottom: 1px solid transparent;
  }

  .commit-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.03));
  }

  .commit-row.selected {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  .commit-row .col-graph {
    width: var(--graph-col-width);
    min-width: var(--graph-col-width);
    flex-shrink: 0;
    height: 100%;
  }

  .commit-row .col-message {
    flex: 1;
    padding-left: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .commit-row .col-date {
    width: 80px;
    min-width: 80px;
    padding-left: 8px;
    font-size: 11px;
    opacity: 0.6;
    white-space: nowrap;
  }

  .commit-row .col-sha {
    width: 70px;
    min-width: 70px;
    padding-left: 8px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-textLink-foreground, #4fc1ff);
    white-space: nowrap;
  }

  .commit-row .col-author {
    width: 140px;
    min-width: 140px;
    padding-left: 8px;
    padding-right: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }

  .avatar {
    border-radius: 50%;
    opacity: 0.85;
    flex-shrink: 0;
  }

  .author-name {
    font-size: 11px;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .working-changes .working-label {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
    font-weight: 600;
    font-size: 13px;
  }

  /* Ref badges */
  .ref-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .ref-branch {
    background: rgba(0, 122, 204, 0.2);
    color: var(--vscode-textLink-foreground, #4fc1ff);
    border: 1px solid rgba(0, 122, 204, 0.4);
  }

  .ref-tag {
    background: rgba(215, 186, 125, 0.15);
    color: var(--vscode-editorWarning-foreground, #d7ba7d);
    border: 1px solid rgba(215, 186, 125, 0.4);
  }

  .ref-head {
    background: rgba(106, 153, 85, 0.2);
    color: var(--vscode-testing-iconPassed, #6a9955);
    border: 1px solid rgba(106, 153, 85, 0.5);
  }

  .commit-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loading {
    padding: 32px;
    text-align: center;
    opacity: 0.5;
  }
</style>

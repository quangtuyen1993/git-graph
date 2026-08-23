<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount, tick } from 'svelte';
  import { calculateVisibleRange, getTotalHeight, ROW_HEIGHT, BUFFER_ROWS } from './lib/virtual-scroll';
  import GraphCanvas from './components/graph/GraphCanvas.svelte';
  import ContextMenu from './components/actions/ContextMenu.svelte';
  import type { MenuItem } from './types/menu.types';
  import { getGravatarUrl } from './lib/gravatar';
  import CommitDetail from './components/detail/CommitDetail.svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
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
  let error = '';

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

  // Context menu state
  let contextMenuVisible = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let contextMenuItems: MenuItem[] = [];
  let contextMenuTarget: { type: 'commit' | 'branch'; value: string } | null = null;

  // Computed graph column width
  $: graphColWidth = (maxLane + 1) * 16 + 24; // LANE_WIDTH * lanes + padding

  onMount(async () => {
    try {
      await bridge.send('ping.hello');
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }

    bridge.on('graph.invalidated', () => {
      refreshGraph();
    });
  });

  async function refreshGraph() {
    branches = await bridge.send('git.branches') as Branch[];

    // Check for working changes
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
      // Shift+click: range select between lastClickedHash and this hash
      const allNodes = graphWindow.nodes;
      const lastIdx = allNodes.findIndex(n => n.hash === lastClickedHash);
      const currIdx = allNodes.findIndex(n => n.hash === hash);

      if (lastIdx !== -1 && currIdx !== -1) {
        const start = Math.min(lastIdx, currIdx);
        const end = Math.max(lastIdx, currIdx);
        selectedHashes = new Set(allNodes.slice(start, end + 1).map(n => n.hash));
        selectedHash = hash;
        // Don't fetch detail for multi-select
        if (selectedHashes.size > 1) {
          detailCommit = null;
          detailFiles = null;
          return;
        }
      }
    } else {
      // Normal click: single select
      selectedHashes = new Set(hash !== 'WORKING' ? [hash] : []);
      lastClickedHash = hash !== 'WORKING' ? hash : null;
      selectedHash = hash;
    }

    if (hash && hash !== 'WORKING') {
      fetchCommitDetail(hash);
    } else {
      detailCommit = null;
      detailFiles = null;
    }
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
      // Only update if still selected (user may have clicked another)
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

    // If right-clicking a hash that's part of multi-selection, show multi-commit menu
    if (selectedHashes.size > 1 && selectedHashes.has(hash)) {
      contextMenuTarget = { type: 'commit', value: hash };
      contextMenuX = event.clientX;
      contextMenuY = event.clientY;
      const count = selectedHashes.size;

      // Get hashes in display order
      const hashes = graphWindow
        ? graphWindow.nodes
            .filter(n => selectedHashes.has(n.hash))
            .map(n => n.hash)
        : [...selectedHashes];

      // Check if squash is possible (all commits on current branch, consecutive)
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

    // Single commit context menu
    contextMenuTarget = { type: 'commit', value: hash };
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;

    // Check if commit is on current branch (needed for reset, revert, cherry-pick)
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
            // Get hashes in topological order (newest first as displayed)
            const hashes = graphWindow
              ? graphWindow.nodes
                  .filter(n => selectedHashes.has(n.hash))
                  .map(n => n.hash)
              : [...selectedHashes];

            // Default message: oldest commit's subject
            const oldestHash = hashes[hashes.length - 1];
            const defaultMsg = graphWindow?.nodes.find(n => n.hash === oldestHash)?.subject ?? '';

            const message = await bridge.send('ui.inputBox', {
              prompt: `Squash ${hashes.length} commits into one. Enter commit message:`,
              placeholder: defaultMsg,
              value: defaultMsg
            }) as string | null;

            if (message) {
              await bridge.send('git.squash', { hashes, message });
              selectedHashes = new Set();
              selectedHash = null;
            }
            break;
          }
          case 'copyShas': {
            const shas = graphWindow
              ? graphWindow.nodes
                  .filter(n => selectedHashes.has(n.hash))
                  .map(n => n.hash)
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
          case 'pull':
            await bridge.send('git.pull', { remote: 'origin', branch: branchName });
            break;
          case 'fetch':
            await bridge.send('git.fetch', { remote: 'origin' });
            break;
          case 'deleteBranch': {
            const confirmed = await bridge.send('ui.confirm', { message: `Delete branch "${branchName}"?` }) as boolean;
            if (confirmed) {
              await bridge.send('git.deleteBranch', { name: branchName });
            }
            break;
          }
        }
      }

      if (action !== 'copySha') {
        await refreshGraph();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }

    contextMenuTarget = null;
  }

  async function handleToolbarFetch() {
    try {
      await bridge.send('git.fetch', { remote: 'origin' });
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleToolbarPull() {
    try {
      await bridge.send('git.pull', { remote: 'origin' });
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleToolbarPush() {
    try {
      await bridge.send('git.push', { remote: 'origin' });
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function handleToolbarStash() {
    try {
      await bridge.send('git.stash', { action: 'push' });
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  function formatRelativeTime(dateStr: string): string {
    const now = Date.now();
    const date = new Date(dateStr).getTime();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? '' : 's'} ago`;
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
    <h1>Git Graph Pro</h1>
    <span class="status">{status}</span>
    <div class="toolbar-actions">
      <button class="toolbar-btn" on:click={handleToolbarFetch} title="Fetch All">⬇ Fetch</button>
      <button class="toolbar-btn" on:click={handleToolbarPull} title="Pull">↓ Pull</button>
      <button class="toolbar-btn" on:click={handleToolbarPush} title="Push">↑ Push</button>
      <button class="toolbar-btn" on:click={handleToolbarStash} title="Stash">📦 Stash</button>
    </div>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <div class="content-split" class:has-detail={selectedHash && selectedHash !== 'WORKING'}>
    <div class="main-panel">
      <div class="table-header" style="--graph-col-width: {graphColWidth}px">
        <div class="col-graph">&#160;</div>
        <div class="col-message">MESSAGE</div>
        <div class="col-files">&#160;</div>
        <div class="col-date">DATE</div>
        <div class="col-sha">SHA</div>
        <div class="col-avatar">&#160;</div>
      </div>

      <section class="scroll-area" bind:this={scrollContainer} on:scroll={handleScroll}>
        <div class="scroll-content" style="height: {getTotalHeight(totalRows + (hasWorkingChanges ? 1 : 0))}px;">
          <!-- SVG graph column overlay -->
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

          <!-- Working Changes row -->
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
            </div>
          {/if}

          <!-- Commit rows -->
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
                <div class="col-files">
                  {#if node.filesChanged > 0}
                    <span class="files-badge" title="{node.filesChanged} files changed">{node.filesChanged}</span>
                  {/if}
                </div>
                <div class="col-date">{formatRelativeTime(node.authorDate)}</div>
                <div class="col-sha">{node.abbreviatedHash}</div>
                <div class="col-avatar">
                  <img
                    src={getGravatarUrl(node.authorEmail || '')}
                    alt={node.author}
                    title={node.author}
                    class="avatar"
                    width="20"
                    height="20"
                  />
                </div>
              </div>
            {/each}
          {:else}
            <div class="loading">Loading graph...</div>
          {/if}
        </div>
      </section>
    </div>

    {#if selectedHash && selectedHash !== 'WORKING'}
      <aside class="detail-panel-container">
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
  }

  .toolbar {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }

  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
  }

  .status {
    font-size: 12px;
    opacity: 0.7;
  }

  .toolbar-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }

  .toolbar-btn {
    padding: 4px 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #cccccc);
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
  }

  .toolbar-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }

  .error-banner {
    padding: 8px 16px;
    background: var(--error);
    color: var(--bg);
    font-size: 12px;
    flex-shrink: 0;
  }

  /* Table header */
  .table-header {
    display: flex;
    align-items: center;
    height: 28px;
    padding: 0;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.6;
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
    width: 140px;
    min-width: 140px;
    padding-left: 8px;
  }

  .table-header .col-sha {
    width: 80px;
    min-width: 80px;
    padding-left: 8px;
    padding-right: 12px;
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

  /* SVG graph overlay */
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
  }

  .commit-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
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
    width: 140px;
    min-width: 140px;
    padding-left: 8px;
    font-size: 12px;
    opacity: 0.7;
    white-space: nowrap;
  }

  .commit-row .col-sha {
    width: 80px;
    min-width: 80px;
    padding-left: 8px;
    padding-right: 8px;
    font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-textLink-foreground, #007acc);
    white-space: nowrap;
  }

  .commit-row .col-files, .table-header .col-files {
    width: 36px;
    min-width: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .files-badge {
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #ffffff);
    padding: 1px 5px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
  }

  .commit-row .col-avatar {
    width: 32px;
    min-width: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-right: 8px;
  }

  .avatar {
    border-radius: 50%;
    opacity: 0.9;
  }

  /* Working changes row */
  .working-changes .working-label {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
    font-weight: 600;
    font-size: 13px;
  }

  /* Ref badges (inline) */
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
    background: var(--vscode-badge-background, #007acc);
    color: var(--vscode-badge-foreground, #ffffff);
  }

  .ref-tag {
    background: var(--vscode-editorWarning-foreground, #d7ba7d);
    color: #1e1e1e;
  }

  .ref-head {
    background: var(--vscode-testing-iconPassed, #6a9955);
    color: #ffffff;
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

  /* Split layout */
  .content-split {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .main-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  .detail-panel-container {
    width: 340px;
    min-width: 280px;
    border-left: 1px solid var(--border);
    overflow-y: auto;
    flex-shrink: 0;
  }
</style>

<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount } from 'svelte';
  import { calculateVisibleRange, getTotalHeight, ROW_HEIGHT, BUFFER_ROWS } from './lib/virtual-scroll';
  import GraphCanvas from './components/graph/GraphCanvas.svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
  }

  interface GraphWindow {
    nodes: any[];
    edges: any[];
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

  // Virtual scroll state
  let scrollContainer: HTMLDivElement;
  let viewportHeight = 600;
  let scrollTop = 0;
  let currentStartRow = 0;
  let loading = false;

  onMount(async () => {
    try {
      await bridge.send('ping.hello');
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }

    // Listen for refresh events from host (file watcher)
    bridge.on('graph.invalidated', () => {
      refreshGraph();
    });
  });

  async function refreshGraph() {
    // Load branches
    branches = await bridge.send('git.branches') as Branch[];

    // Build graph layout
    const result = await bridge.send('graph.build', { all: true, maxCount: 500 }) as { totalRows: number; maxLane: number };
    totalRows = result.totalRows;
    maxLane = result.maxLane;

    // Get window at current scroll position
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

    // Fetch new window if we've scrolled beyond current buffer
    if (graphWindow) {
      const needsFetch =
        range.startRow < graphWindow.startRow ||
        range.endRow > graphWindow.endRow;

      if (needsFetch) {
        fetchWindow(range.startRow);
      }
    }
  }

  function handleSelectCommit(event: CustomEvent<{ hash: string }>) {
    selectedHash = event.detail.hash;
  }
</script>

<div class="container">
  <header class="toolbar">
    <h1>Git Graph Pro</h1>
    <span class="status">{status}</span>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <main class="content">
    <aside class="sidebar">
      <h2>Branches ({branches.length})</h2>
      <ul class="branch-list">
        {#each branches as branch}
          <li class:current={branch.current}>
            {#if branch.current}<span class="indicator">●</span>{/if}
            {branch.name}
          </li>
        {/each}
      </ul>
    </aside>

    <section class="graph-area" bind:this={scrollContainer} on:scroll={handleScroll}>
      <div class="scroll-content" style="height: {getTotalHeight(totalRows)}px; position: relative;">
        {#if graphWindow}
          <div
            class="graph-viewport"
            style="position: absolute; top: {currentStartRow * ROW_HEIGHT}px; left: 0; right: 0;"
          >
            <GraphCanvas
              nodes={graphWindow.nodes}
              edges={graphWindow.edges}
              startRow={graphWindow.startRow}
              {totalRows}
              maxLane={graphWindow.maxLane}
              on:selectCommit={handleSelectCommit}
            />
          </div>
        {:else}
          <div class="loading">Loading graph...</div>
        {/if}
      </div>
    </section>
  </main>

  {#if selectedHash}
    <footer class="detail-bar">
      Selected: {selectedHash}
    </footer>
  {/if}
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
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

  .error-banner {
    padding: 8px 16px;
    background: var(--error);
    color: var(--bg);
    font-size: 12px;
    flex-shrink: 0;
  }

  .content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .sidebar {
    width: 200px;
    border-right: 1px solid var(--border);
    padding: 8px;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .sidebar h2 {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .branch-list {
    list-style: none;
    font-size: 13px;
  }

  .branch-list li {
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }

  .branch-list li:hover {
    background: var(--hover-bg);
  }

  .branch-list li.current {
    font-weight: 600;
  }

  .indicator {
    color: var(--success);
    margin-right: 4px;
  }

  .graph-area {
    flex: 1;
    overflow: auto;
  }

  .scroll-content {
    min-width: 100%;
  }

  .loading {
    padding: 32px;
    text-align: center;
    opacity: 0.5;
  }

  .detail-bar {
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    font-family: monospace;
    flex-shrink: 0;
  }
</style>

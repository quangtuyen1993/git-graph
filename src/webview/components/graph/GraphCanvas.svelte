<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import CommitNode from './CommitNode.svelte';
  import BranchLine from './BranchLine.svelte';
  import RefBadge from './RefBadge.svelte';

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

  export let nodes: GraphNode[] = [];
  export let edges: GraphEdge[] = [];
  export let startRow: number = 0;
  export let totalRows: number = 0;
  export let maxLane: number = 0;

  const ROW_HEIGHT = 32;
  const LANE_WIDTH = 16;
  const PADDING_LEFT = 12;
  const GRAPH_TO_REFS_GAP = 12;
  const REFS_TO_TEXT_GAP = 8;
  const HASH_WIDTH = 60;
  const MESSAGE_WIDTH = 350;

  const dispatch = createEventDispatcher();

  // Graph lanes end here
  $: lanesEnd = PADDING_LEFT + (maxLane + 1) * LANE_WIDTH;
  // Ref badges start after graph lanes
  $: refBadgeStart = lanesEnd + GRAPH_TO_REFS_GAP;
  // Calculate max ref badge width across all visible nodes
  $: maxRefWidth = nodes.reduce((max, node) => {
    const totalRefWidth = node.refs.reduce((sum, ref) => {
      const name = ref.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
      return sum + name.length * 7 + 10 + 6;
    }, 0);
    return Math.max(max, totalRefWidth);
  }, 0);
  // Text starts after ref badges
  $: textStart = refBadgeStart + maxRefWidth + REFS_TO_TEXT_GAP;
  $: visibleHeight = nodes.length * ROW_HEIGHT;
  $: totalWidth = textStart + HASH_WIDTH + MESSAGE_WIDTH + 150;

  function handleNodeSelect(event: CustomEvent<{ hash: string }>) {
    dispatch('selectCommit', event.detail);
  }
</script>

<div class="graph-canvas">
  <svg
    width={totalWidth}
    height={visibleHeight}
    class="graph-svg"
  >
    <!-- Edges (drawn first, behind nodes) -->
    {#each edges as edge (edge.fromHash + '-' + edge.toHash)}
      <BranchLine
        fromRow={edge.fromRow}
        fromLane={edge.fromLane}
        toRow={edge.toRow}
        toLane={edge.toLane}
        color={edge.color}
        rowHeight={ROW_HEIGHT}
        laneWidth={LANE_WIDTH}
        paddingLeft={PADDING_LEFT}
        {startRow}
      />
    {/each}

    <!-- Nodes -->
    {#each nodes as node (node.hash)}
      <CommitNode
        hash={node.hash}
        lane={node.lane}
        row={node.row}
        color={node.color}
        parents={node.parents}
        rowHeight={ROW_HEIGHT}
        laneWidth={LANE_WIDTH}
        paddingLeft={PADDING_LEFT}
        {startRow}
        on:select={handleNodeSelect}
      />
    {/each}

    <!-- Ref badges (after graph lanes, before text) -->
    {#each nodes as node (node.hash + '-refs')}
      {#each node.refs as ref, ri}
        {@const prevRefsWidth = node.refs.slice(0, ri).reduce((sum, r) => {
          const n = r.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
          return sum + n.length * 7 + 10 + 6;
        }, 0)}
        <RefBadge
          name={ref}
          x={refBadgeStart + prevRefsWidth}
          y={(node.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2}
        />
      {/each}
    {/each}

    <!-- Commit info text (hash + message + author) -->
    {#each nodes as node (node.hash + '-text')}
      <text
        x={textStart}
        y={(node.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2 + 4}
        font-size="13"
        class="commit-text"
      >
        <tspan class="commit-hash">{node.abbreviatedHash}</tspan>
        <tspan dx="8" class="commit-message">{node.subject.length > 50 ? node.subject.slice(0, 50) + '…' : node.subject}</tspan>
        <tspan dx="8" class="commit-author">{node.author}</tspan>
        <tspan dx="8" class="commit-date">{new Date(node.authorDate).toLocaleDateString()}</tspan>
      </text>
    {/each}
  </svg>
</div>

<style>
  .graph-canvas {
    width: 100%;
    height: 100%;
    overflow-x: auto;
  }

  .graph-svg {
    display: block;
  }

  .commit-text {
    fill: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', monospace);
    font-size: 13px;
  }

  .commit-hash {
    fill: var(--vscode-textLink-foreground, #007acc);
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', monospace);
    font-size: 12px;
  }

  .commit-message {
    fill: var(--vscode-foreground, #cccccc);
  }

  .commit-author {
    fill: var(--vscode-foreground, #cccccc);
    opacity: 0.6;
    font-size: 12px;
  }

  .commit-date {
    fill: var(--vscode-foreground, #cccccc);
    opacity: 0.4;
    font-size: 11px;
  }
</style>

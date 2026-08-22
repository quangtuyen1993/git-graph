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
  const TEXT_OFFSET = 20;

  const dispatch = createEventDispatcher();

  $: graphWidth = PADDING_LEFT + (maxLane + 1) * LANE_WIDTH + TEXT_OFFSET;
  $: visibleHeight = nodes.length * ROW_HEIGHT;

  function handleNodeSelect(event: CustomEvent<{ hash: string }>) {
    dispatch('selectCommit', event.detail);
  }

  function getRefBadgeX(_lane: number): number {
    return PADDING_LEFT + (maxLane + 1) * LANE_WIDTH + 8;
  }
</script>

<div class="graph-canvas">
  <svg
    width={Math.max(graphWidth + 400, 200)}
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

    <!-- Ref badges -->
    {#each nodes as node (node.hash + '-refs')}
      {#each node.refs as ref, ri}
        <RefBadge
          name={ref}
          x={getRefBadgeX(node.lane) + ri * 80}
          y={(node.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2}
        />
      {/each}
    {/each}

    <!-- Commit messages (text after graph lanes) -->
    {#each nodes as node (node.hash + '-text')}
      <text
        x={graphWidth}
        y={(node.row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2 + 4}
        font-size="13"
        class="commit-text"
      >
        <tspan class="commit-hash">{node.abbreviatedHash}</tspan>
        <tspan dx="8">{node.subject.slice(0, 60)}</tspan>
        <tspan dx="8" class="commit-author">{node.author}</tspan>
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
    font-family: var(--vscode-font-family, monospace);
  }

  .commit-hash {
    fill: var(--vscode-textLink-foreground, #007acc);
    font-family: monospace;
    font-size: 12px;
  }

  .commit-author {
    fill: var(--vscode-foreground, #cccccc);
    opacity: 0.5;
    font-size: 11px;
  }
</style>

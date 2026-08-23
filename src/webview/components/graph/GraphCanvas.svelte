<script lang="ts">
  import { getColor } from '../../lib/graph-colors';

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
  export let maxLane: number = 0;

  const ROW_HEIGHT = 32;
  const LANE_WIDTH = 16;
  const PADDING_LEFT = 12;
  const NODE_RADIUS = 5;

  $: svgWidth = (maxLane + 1) * LANE_WIDTH + PADDING_LEFT + 8;
  $: svgHeight = nodes.length * ROW_HEIGHT;

  function computeEdgePath(edge: GraphEdge): string {
    const x1 = PADDING_LEFT + edge.fromLane * LANE_WIDTH;
    const y1 = (edge.fromRow - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x2 = PADDING_LEFT + edge.toLane * LANE_WIDTH;
    const y2 = (edge.toRow - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;

    if (x1 === x2) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    // Curved path: go down a bit, curve to target lane, then go straight down
    const midY = y1 + ROW_HEIGHT / 2;
    return `M ${x1} ${y1} L ${x1} ${midY} C ${x1} ${midY + ROW_HEIGHT / 4} ${x2} ${midY + ROW_HEIGHT / 4} ${x2} ${midY + ROW_HEIGHT / 2} L ${x2} ${y2}`;
  }

  function getNodeCx(lane: number): number {
    return PADDING_LEFT + lane * LANE_WIDTH;
  }

  function getNodeCy(row: number): number {
    return (row - startRow) * ROW_HEIGHT + ROW_HEIGHT / 2;
  }
</script>

<svg
  width={svgWidth}
  height={svgHeight}
  class="graph-lines-svg"
>
  <!-- Edges (drawn first, behind nodes) -->
  {#each edges as edge (edge.fromHash + '-' + edge.toHash)}
    <path
      d={computeEdgePath(edge)}
      stroke={getColor(edge.color)}
      stroke-width="2"
      fill="none"
      stroke-linecap="round"
    />
  {/each}

  <!-- Nodes (circles) -->
  {#each nodes as node (node.hash)}
    {@const isMerge = node.parents.length > 1}
    <circle
      cx={getNodeCx(node.lane)}
      cy={getNodeCy(node.row)}
      r={isMerge ? NODE_RADIUS + 1 : NODE_RADIUS}
      fill={isMerge ? 'var(--vscode-editor-background, #1e1e1e)' : getColor(node.color)}
      stroke={getColor(node.color)}
      stroke-width={isMerge ? 2 : 0}
    />
  {/each}
</svg>

<style>
  .graph-lines-svg {
    display: block;
  }
</style>

<script lang="ts">
  import { getColor } from '../../lib/graph-colors';
  import { createEventDispatcher } from 'svelte';

  export let hash: string;
  export let lane: number;
  export let row: number;
  export let color: number;
  export let parents: string[];
  export let rowHeight: number = 32;
  export let laneWidth: number = 16;
  export let paddingLeft: number = 12;
  export let startRow: number = 0;

  const dispatch = createEventDispatcher();
  const NODE_RADIUS = 3.5;
  const HIT_RADIUS = 14; // larger invisible hit target

  $: cx = paddingLeft + lane * laneWidth;
  $: cy = (row - startRow) * rowHeight + rowHeight / 2;
  $: fillColor = getColor(color);
  $: isMerge = parents.length > 1;
</script>

<g
  class="commit-node"
  on:click={() => dispatch('select', { hash })}
  on:contextmenu|preventDefault={(e) => dispatch('contextmenu', { hash, x: e.clientX, y: e.clientY })}
  on:keydown={(e) => { if (e.key === 'Enter') dispatch('select', { hash }); }}
  role="button"
  tabindex="0"
>
  <!-- Invisible larger hit area for easier clicking -->
  <circle
    {cx}
    {cy}
    r={HIT_RADIUS}
    fill="transparent"
    stroke="none"
  />
  <!-- Visible node -->
  <circle
    {cx}
    {cy}
    r={isMerge ? NODE_RADIUS + 1 : NODE_RADIUS}
    fill={isMerge ? 'var(--vscode-editor-background, #1e1e1e)' : fillColor}
    stroke={fillColor}
    stroke-width={isMerge ? 1.25 : 0}
    class="node-circle"
  />
</g>

<style>
  .commit-node {
    cursor: pointer;
  }
  .commit-node:hover .node-circle {
    filter: brightness(1.3);
  }
</style>

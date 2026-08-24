<script lang="ts">
  import { getColor } from '../../lib/graph-colors';

  export let fromRow: number;
  export let fromLane: number;
  export let toRow: number;
  export let toLane: number;
  export let color: number;
  export let rowHeight: number = 32;
  export let laneWidth: number = 16;
  export let paddingLeft: number = 12;
  export let startRow: number = 0;

  $: x1 = paddingLeft + fromLane * laneWidth;
  $: y1 = (fromRow - startRow) * rowHeight + rowHeight / 2;
  $: x2 = paddingLeft + toLane * laneWidth;
  $: y2 = (toRow - startRow) * rowHeight + rowHeight / 2;
  $: strokeColor = getColor(color);

  $: pathD = computePath(x1, y1, x2, y2);

  function computePath(x1: number, y1: number, x2: number, y2: number): string {
    if (x1 === x2) {
      // Straight vertical line
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }
    // Curved path: go down a bit, curve to target lane, then go straight down
    const midY = y1 + rowHeight / 2;
    return `M ${x1} ${y1} L ${x1} ${midY} C ${x1} ${midY + rowHeight / 4} ${x2} ${midY + rowHeight / 4} ${x2} ${midY + rowHeight / 2} L ${x2} ${y2}`;
  }
</script>

<path
  d={pathD}
  stroke={strokeColor}
  stroke-width="1.25"
  fill="none"
  stroke-linecap="round"
/>

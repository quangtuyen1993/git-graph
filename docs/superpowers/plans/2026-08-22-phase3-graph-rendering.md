# Phase 3: Graph Rendering — Layout + SVG + Virtual Scrolling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat commit table with an interactive SVG commit graph showing branch lines, merge paths, and commit nodes — with virtual scrolling for unlimited repo size. This is the visual heart of the extension.

**Architecture:** GraphService (host) computes layout positions using a custom lane-assignment algorithm. Sends windowed graph data to webview on scroll. Webview renders SVG with only visible nodes + buffer. Each branch gets a distinct color. Commit nodes are clickable.

**Tech Stack:** TypeScript, dagre (available but using custom lane algorithm for git-specific topology), SVG rendering in Svelte, existing MessageRouter + MessageBridge

## Global Constraints

- Node.js >= 18, VS Code engine >= 1.85.0
- All source in `src/extension/` (host) and `src/webview/` (webview)
- Build output: `dist/extension.js` (host), `dist/webview/` (webview assets)
- No runtime dependencies (dagre already installed as dev dep, bundled by esbuild)
- Virtual scrolling: max ~90 DOM nodes rendered at any time
- ROW_HEIGHT = 32px, NODE_RADIUS = 5px, LANE_WIDTH = 16px
- Branch colors: cycle through 10 predefined colors matching VS Code theme

---

### Task 1: Graph type definitions

**Files:**
- Create: `src/extension/types/graph.types.ts`

**Interfaces:**
- Consumes: `Commit` from `git.types.ts`
- Produces: `GraphNode`, `GraphEdge`, `GraphLayout`, `GraphWindow`, `LaneAssignment` types

- [ ] **Step 1: Create graph type definitions**

Create `src/extension/types/graph.types.ts`:

```typescript
export interface GraphNode {
  hash: string;
  abbreviatedHash: string;
  subject: string;
  author: string;
  authorDate: string;
  refs: string[];
  parents: string[];
  lane: number;        // X column (0-based)
  row: number;         // Y position (0-based, index in commit list)
  color: number;       // color index (0-9)
}

export interface GraphEdge {
  fromHash: string;
  toHash: string;
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  color: number;       // same color as the branch it belongs to
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalRows: number;
  maxLane: number;     // widest point (number of parallel lanes)
}

export interface GraphWindow {
  nodes: GraphNode[];
  edges: GraphEdge[];
  startRow: number;
  endRow: number;
  totalRows: number;
  maxLane: number;
}

export interface GraphOptions {
  maxCount?: number;
  skip?: number;
  branch?: string;
  all?: boolean;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx esbuild src/extension/extension.ts --bundle --outfile=/dev/null --external:vscode --format=cjs --platform=node`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/types/graph.types.ts
git commit -m "feat: add graph type definitions (GraphNode, GraphEdge, GraphLayout, GraphWindow)"
```

---

### Task 2: Lane assignment algorithm

**Files:**
- Create: `src/extension/services/graph.service.ts`

**Interfaces:**
- Consumes: `Commit` from `git.types.ts`, types from `graph.types.ts`
- Produces:
  - `GraphService` class:
    - `constructor()`
    - `buildLayout(commits: Commit[]): GraphLayout`
    - `getWindow(startRow: number, count: number): GraphWindow`
    - `getTotalRows(): number`
    - `getMaxLane(): number`

The lane assignment algorithm:

```
Algorithm: Git Graph Lane Assignment
─────────────────────────────────────
Input: commits[] sorted newest-first (git log order)
Output: lane assignment for each commit + edges

State:
  - activeLanes: Map<hash, lane> — commits that have a lane reserved (waiting for their row)
  - freeLanes: number[] — lanes that have been freed and can be reused

For each commit (in order):
  1. If commit.hash is in activeLanes → use that lane (it was reserved by a child)
     Else → assign next free lane (pop from freeLanes, or use maxLane++)
  
  2. For each parent of this commit:
     - If parent is NOT in activeLanes → assign parent to this commit's lane 
       (first parent continues straight down) or a new/free lane (other parents)
     - First parent: same lane as current commit (main line continues)
     - Other parents: get/assign a different lane (merge source)
  
  3. If this commit has no children that reserved its lane, 
     free the lane after this row (add to freeLanes)

  4. Create edges from this commit to each parent:
     - Same lane: straight vertical line
     - Different lane: curved path (from commit lane to parent lane)
```

- [ ] **Step 1: Create GraphService with lane assignment**

Create `src/extension/services/graph.service.ts`:

```typescript
import type { Commit } from '../types/git.types';
import type { GraphNode, GraphEdge, GraphLayout, GraphWindow } from '../types/graph.types';

const BRANCH_COLORS = 10; // number of colors in the palette

export class GraphService {
  private layout: GraphLayout | null = null;

  public buildLayout(commits: Commit[]): GraphLayout {
    if (commits.length === 0) {
      this.layout = { nodes: [], edges: [], totalRows: 0, maxLane: 0 };
      return this.layout;
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Maps commit hash → assigned lane
    const commitLane = new Map<string, number>();
    // Maps commit hash → color
    const commitColor = new Map<string, number>();
    // Active lanes: which hash is expected at each lane
    // lane index → hash of the commit that will occupy it
    const activeLanes: (string | null)[] = [];

    let colorCounter = 0;

    for (let row = 0; row < commits.length; row++) {
      const commit = commits[row];

      // 1. Find or assign lane for this commit
      let lane: number;
      let color: number;

      const reservedLane = activeLanes.indexOf(commit.hash);
      if (reservedLane !== -1) {
        // This commit was expected in this lane (reserved by a child)
        lane = reservedLane;
        color = commitColor.get(commit.hash) ?? (colorCounter++ % BRANCH_COLORS);
        activeLanes[lane] = null; // free it temporarily
      } else {
        // New branch — find first free lane
        lane = this.findFreeLane(activeLanes);
        color = colorCounter++ % BRANCH_COLORS;
      }

      commitLane.set(commit.hash, lane);
      commitColor.set(commit.hash, color);

      // 2. Process parents
      for (let pi = 0; pi < commit.parents.length; pi++) {
        const parentHash = commit.parents[pi];

        if (pi === 0) {
          // First parent: continues in the same lane (straight line down)
          const existingParentLane = activeLanes.indexOf(parentHash);
          if (existingParentLane === -1) {
            // Parent not yet reserved — put it in our lane
            activeLanes[lane] = parentHash;
            commitColor.set(parentHash, color);
          }
          // If parent already reserved elsewhere, that's a merge — edge will be drawn
        } else {
          // Additional parents (merge sources): assign them a lane
          const existingParentLane = activeLanes.indexOf(parentHash);
          if (existingParentLane === -1) {
            const mergeLane = this.findFreeLane(activeLanes);
            activeLanes[mergeLane] = parentHash;
            const mergeColor = colorCounter++ % BRANCH_COLORS;
            commitColor.set(parentHash, mergeColor);
          }
        }
      }

      // 3. If no parents → free the lane
      if (commit.parents.length === 0) {
        activeLanes[lane] = null;
      }

      // Build node
      nodes.push({
        hash: commit.hash,
        abbreviatedHash: commit.abbreviatedHash,
        subject: commit.subject,
        author: commit.author,
        authorDate: commit.authorDate,
        refs: commit.refs,
        parents: commit.parents,
        lane,
        row,
        color
      });
    }

    // Build edges (after all nodes positioned)
    const nodeRowMap = new Map<string, number>();
    const nodeLaneMap = new Map<string, number>();
    const nodeColorMap = new Map<string, number>();

    for (const node of nodes) {
      nodeRowMap.set(node.hash, node.row);
      nodeLaneMap.set(node.hash, node.lane);
      nodeColorMap.set(node.hash, node.color);
    }

    for (const node of nodes) {
      for (const parentHash of node.parents) {
        const parentRow = nodeRowMap.get(parentHash);
        const parentLane = nodeLaneMap.get(parentHash);

        if (parentRow !== undefined && parentLane !== undefined) {
          edges.push({
            fromHash: node.hash,
            toHash: parentHash,
            fromRow: node.row,
            fromLane: node.lane,
            toRow: parentRow,
            toLane: parentLane,
            color: node.color
          });
        }
      }
    }

    const maxLane = nodes.reduce((max, n) => Math.max(max, n.lane), 0);

    this.layout = { nodes, edges, totalRows: nodes.length, maxLane };
    return this.layout;
  }

  public getWindow(startRow: number, count: number): GraphWindow {
    if (!this.layout) {
      return { nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 0, maxLane: 0 };
    }

    const endRow = Math.min(startRow + count, this.layout.totalRows);
    const actualStart = Math.max(0, startRow);

    // Get nodes in window
    const nodes = this.layout.nodes.slice(actualStart, endRow);

    // Get edges that are visible (either endpoint in window, or crossing through)
    const edges = this.layout.edges.filter(edge => {
      const minRow = Math.min(edge.fromRow, edge.toRow);
      const maxRow = Math.max(edge.fromRow, edge.toRow);
      // Edge is visible if it overlaps with [actualStart, endRow)
      return maxRow >= actualStart && minRow < endRow;
    });

    return {
      nodes,
      edges,
      startRow: actualStart,
      endRow,
      totalRows: this.layout.totalRows,
      maxLane: this.layout.maxLane
    };
  }

  public getTotalRows(): number {
    return this.layout?.totalRows ?? 0;
  }

  public getMaxLane(): number {
    return this.layout?.maxLane ?? 0;
  }

  private findFreeLane(activeLanes: (string | null)[]): number {
    // Find first null slot
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) return i;
    }
    // No free slot — expand
    activeLanes.push(null);
    return activeLanes.length - 1;
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx esbuild src/extension/extension.ts --bundle --outfile=/dev/null --external:vscode --format=cjs --platform=node`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/services/graph.service.ts
git commit -m "feat: add GraphService with lane assignment algorithm and windowed access"
```

---

### Task 3: Wire GraphService into MessageRouter

**Files:**
- Modify: `src/extension/extension.ts` (add GraphService, register `graph` namespace, build layout on git.log)

**Interfaces:**
- Consumes: `GraphService`, `GitService`, `MessageRouter`
- Produces: `graph.getWindow`, `graph.build`, `graph.getLayout` methods registered on router

- [ ] **Step 1: Update extension.ts**

Replace `src/extension/extension.ts` with:

```typescript
import * as vscode from 'vscode';
import { GitGraphWebviewProvider } from './providers/webview-provider';
import { MessageRouter } from './controllers/message-router';
import { GitService } from './services/git.service';
import { GraphService } from './services/graph.service';
import type { GitLogOptions } from './types/git.types';
import type { GraphOptions } from './types/graph.types';

let webviewProvider: GitGraphWebviewProvider;

export function activate(context: vscode.ExtensionContext): void {
  const router = new MessageRouter();

  // Determine repo path from workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  let gitService: GitService | null = null;
  const graphService = new GraphService();

  if (workspaceFolders && workspaceFolders.length > 0) {
    const rootPath = workspaceFolders[0].uri.fsPath;
    gitService = new GitService(rootPath);
  }

  // Register git namespace handler
  router.register('git', async (method: string, params: unknown) => {
    if (!gitService) {
      throw new Error('No git repository found in workspace');
    }

    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'git.log':
        return gitService.log(p as GitLogOptions);
      case 'git.branches':
        return gitService.branches();
      case 'git.tags':
        return gitService.tags();
      case 'git.status':
        return gitService.status();
      case 'git.show':
        return gitService.show(p.hash as string);
      case 'git.diff':
        return gitService.diff(p.ref1 as string, p.ref2 as string);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // Register graph namespace handler
  router.register('graph', async (method: string, params: unknown) => {
    if (!gitService) {
      throw new Error('No git repository found in workspace');
    }

    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'graph.build': {
        const options = p as GraphOptions;
        const logOptions: GitLogOptions = {
          maxCount: options.maxCount ?? 500,
          skip: options.skip,
          branch: options.branch,
          all: options.all ?? true
        };
        const commits = await gitService.log(logOptions);
        const layout = graphService.buildLayout(commits);
        return { totalRows: layout.totalRows, maxLane: layout.maxLane };
      }
      case 'graph.getWindow': {
        const startRow = (p.startRow as number) ?? 0;
        const count = (p.count as number) ?? 50;
        return graphService.getWindow(startRow, count);
      }
      case 'graph.getLayout': {
        return {
          totalRows: graphService.getTotalRows(),
          maxLane: graphService.getMaxLane()
        };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // Keep ping for testing
  router.register('ping', async () => {
    return { pong: true, timestamp: Date.now() };
  });

  webviewProvider = new GitGraphWebviewProvider(context.extensionUri, router);

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    webviewProvider.openPanel();
  });

  context.subscriptions.push(openCommand);
}

export function deactivate(): void {
  // cleanup
}
```

- [ ] **Step 2: Verify compilation**

Run: `npm run build:host`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/extension.ts
git commit -m "feat: register graph namespace in MessageRouter (build, getWindow, getLayout)"
```

---

### Task 4: SVG Graph Components (Svelte)

**Files:**
- Create: `src/webview/components/graph/GraphCanvas.svelte`
- Create: `src/webview/components/graph/CommitNode.svelte`
- Create: `src/webview/components/graph/BranchLine.svelte`
- Create: `src/webview/components/graph/RefBadge.svelte`
- Create: `src/webview/lib/graph-colors.ts`

**Interfaces:**
- Consumes: `GraphWindow` data from bridge, `GraphNode` and `GraphEdge` structures
- Produces: Interactive SVG graph rendering with:
  - Commit dots (colored by lane)
  - Branch lines (SVG paths with curves at lane changes)
  - Ref badges (branch/tag labels)
  - Click handler on nodes (dispatches `select` event)

Constants:
- ROW_HEIGHT = 32
- NODE_RADIUS = 5
- LANE_WIDTH = 16
- GRAPH_PADDING_LEFT = 12

- [ ] **Step 1: Create graph-colors.ts**

Create `src/webview/lib/graph-colors.ts`:

```typescript
// 10 distinct colors that work in both dark and light themes
export const BRANCH_COLORS = [
  '#4ec9b0', // teal
  '#569cd6', // blue
  '#c586c0', // purple
  '#ce9178', // orange
  '#6a9955', // green
  '#d7ba7d', // gold
  '#9cdcfe', // light blue
  '#f44747', // red
  '#b5cea8', // lime
  '#dcdcaa', // yellow
];

export function getColor(index: number): string {
  return BRANCH_COLORS[index % BRANCH_COLORS.length];
}
```

- [ ] **Step 2: Create BranchLine.svelte**

Create `src/webview/components/graph/BranchLine.svelte`:

```svelte
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
  stroke-width="2"
  fill="none"
  stroke-linecap="round"
/>
```

- [ ] **Step 3: Create CommitNode.svelte**

Create `src/webview/components/graph/CommitNode.svelte`:

```svelte
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
  const NODE_RADIUS = 5;

  $: cx = paddingLeft + lane * laneWidth;
  $: cy = (row - startRow) * rowHeight + rowHeight / 2;
  $: fillColor = getColor(color);
  $: isMerge = parents.length > 1;
</script>

<g class="commit-node" on:click={() => dispatch('select', { hash })} role="button" tabindex="0">
  <circle
    {cx}
    {cy}
    r={isMerge ? NODE_RADIUS + 1 : NODE_RADIUS}
    fill={fillColor}
    stroke={fillColor}
    stroke-width={isMerge ? 2 : 0}
    class:merge={isMerge}
  />
</g>

<style>
  .commit-node {
    cursor: pointer;
  }
  .commit-node:hover circle {
    filter: brightness(1.3);
  }
  circle.merge {
    fill: var(--bg, #1e1e1e);
  }
</style>
```

- [ ] **Step 4: Create RefBadge.svelte**

Create `src/webview/components/graph/RefBadge.svelte`:

```svelte
<script lang="ts">
  export let name: string;
  export let x: number;
  export let y: number;

  $: isTag = name.startsWith('tag:');
  $: displayName = name.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
  $: isHead = name.includes('HEAD');
</script>

<g class="ref-badge" transform="translate({x}, {y})">
  <rect
    rx="3"
    ry="3"
    width={displayName.length * 7 + 10}
    height="16"
    y="-8"
    class:tag={isTag}
    class:head={isHead}
    class:branch={!isTag && !isHead}
  />
  <text
    x="5"
    dy="4"
    font-size="11"
    class:tag={isTag}
    class:head={isHead}
  >
    {displayName}
  </text>
</g>

<style>
  rect.branch {
    fill: var(--accent, #007acc);
    opacity: 0.9;
  }
  rect.tag {
    fill: var(--warning, #d7ba7d);
    opacity: 0.9;
  }
  rect.head {
    fill: var(--success, #6a9955);
    opacity: 0.9;
  }
  text {
    fill: var(--bg, #1e1e1e);
    font-family: var(--vscode-font-family, monospace);
    font-weight: 600;
  }
</style>
```

- [ ] **Step 5: Create GraphCanvas.svelte (main container with virtual scroll)**

Create `src/webview/components/graph/GraphCanvas.svelte`:

```svelte
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import CommitNode from './CommitNode.svelte';
  import BranchLine from './BranchLine.svelte';
  import RefBadge from './RefBadge.svelte';

  export let nodes: GraphNode[] = [];
  export let edges: GraphEdge[] = [];
  export let startRow: number = 0;
  export let totalRows: number = 0;
  export let maxLane: number = 0;

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

  const ROW_HEIGHT = 32;
  const LANE_WIDTH = 16;
  const PADDING_LEFT = 12;
  const GRAPH_WIDTH_BASE = 200;
  const TEXT_OFFSET = 20; // extra space after last lane for text

  const dispatch = createEventDispatcher();

  $: graphWidth = PADDING_LEFT + (maxLane + 1) * LANE_WIDTH + TEXT_OFFSET;
  $: visibleHeight = nodes.length * ROW_HEIGHT;

  function handleNodeSelect(event: CustomEvent<{ hash: string }>) {
    dispatch('selectCommit', event.detail);
  }

  function getRefBadgeX(lane: number): number {
    return PADDING_LEFT + (maxLane + 1) * LANE_WIDTH + 8;
  }
</script>

<div class="graph-canvas">
  <svg
    width={Math.max(graphWidth + 400, GRAPH_WIDTH_BASE)}
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
        fill="var(--fg, #cccccc)"
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
  }

  .graph-svg {
    display: block;
  }

  .commit-text {
    font-family: var(--vscode-font-family, monospace);
  }

  .commit-hash {
    fill: var(--accent, #007acc);
    font-family: monospace;
    font-size: 12px;
  }

  .commit-author {
    fill: var(--fg, #cccccc);
    opacity: 0.5;
    font-size: 11px;
  }
</style>
```

- [ ] **Step 6: Verify webview builds**

Run: `npm run build:webview`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/ src/webview/lib/graph-colors.ts
git commit -m "feat: add SVG graph components (CommitNode, BranchLine, RefBadge, GraphCanvas)"
```

---

### Task 5: Virtual scrolling integration in App.svelte

**Files:**
- Modify: `src/webview/App.svelte` (replace commit table with GraphCanvas + virtual scroll container)
- Create: `src/webview/lib/virtual-scroll.ts`

**Interfaces:**
- Consumes: `MessageBridge.send('graph.build')`, `MessageBridge.send('graph.getWindow')`, `GraphCanvas` component
- Produces: Full virtual-scrolling graph view that:
  - Builds graph layout on mount
  - Renders only visible window (~50 rows + buffer)
  - On scroll: recalculates window, fetches new data if needed
  - Emits `selectCommit` event for detail panel (future)

- [ ] **Step 1: Create virtual-scroll.ts helper**

Create `src/webview/lib/virtual-scroll.ts`:

```typescript
export const ROW_HEIGHT = 32;
export const BUFFER_ROWS = 20; // extra rows above/below viewport

export interface ScrollState {
  scrollTop: number;
  viewportHeight: number;
  totalRows: number;
}

export interface VisibleRange {
  startRow: number;
  endRow: number;
  count: number;
}

export function calculateVisibleRange(state: ScrollState): VisibleRange {
  const firstVisible = Math.floor(state.scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(state.viewportHeight / ROW_HEIGHT);

  const startRow = Math.max(0, firstVisible - BUFFER_ROWS);
  const endRow = Math.min(state.totalRows, firstVisible + visibleCount + BUFFER_ROWS);

  return {
    startRow,
    endRow,
    count: endRow - startRow
  };
}

export function getTotalHeight(totalRows: number): number {
  return totalRows * ROW_HEIGHT;
}
```

- [ ] **Step 2: Update App.svelte with virtual scrolling graph**

Replace `src/webview/App.svelte`:

```svelte
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

      // Load branches
      branches = await bridge.send('git.branches') as Branch[];

      // Build graph layout
      const result = await bridge.send('graph.build', { all: true, maxCount: 500 }) as { totalRows: number; maxLane: number };
      totalRows = result.totalRows;
      maxLane = result.maxLane;

      // Get initial window
      await fetchWindow(0);

      status = `${branches.length} branches, ${totalRows} commits`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }
  });

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
```

- [ ] **Step 3: Verify full build**

Run: `npm run build`
Expected: Both host and webview build without errors.

- [ ] **Step 4: Commit**

```bash
git add src/webview/
git commit -m "feat: integrate virtual scrolling with SVG graph rendering in webview"
```

---

## Verification Checklist (Phase 3 Complete When:)

- [ ] `npm run build` succeeds with no errors
- [ ] Extension opens and shows SVG commit graph (not flat table)
- [ ] Branch lines drawn with distinct colors per branch
- [ ] Merge commits shown as hollow circles with multiple incoming edges
- [ ] Branch lines curve properly when crossing lanes
- [ ] Ref badges (branch/tag names) displayed next to relevant commits
- [ ] Virtual scrolling works: scrolling loads more commits smoothly
- [ ] Only ~90 SVG nodes rendered at any time (check DOM inspector)
- [ ] Clicking a commit node highlights/selects it
- [ ] Graph handles repos with 500+ commits without lag
- [ ] Branch sidebar still shows correctly alongside graph

import type { Commit } from '../types/git.types';
import type { GraphNode, GraphEdge, GraphLayout, GraphWindow } from '../types/graph.types';
import { EdgeRangeIndex } from './edge-range-index';

const BRANCH_COLORS = 10; // number of colors in the palette

export class GraphService {
  private layout: GraphLayout | null = null;
  private layoutVersion = 0;
  private edgeRangeIndex: EdgeRangeIndex | null = null;

  /**
   * Build a full graph layout from commits sorted newest-first (git log order).
   *
   * Algorithm:
   * - Each commit gets a lane (X column) and row (Y = index in array).
   * - First parent continues in the same lane (straight line down).
   * - Additional parents (merge sources) get their own lanes.
   * - Free lanes are reused when branches merge back.
   */
  public buildLayout(commits: Commit[]): GraphLayout {
    const layout = this.createLayout(commits);
    this.publishLayout(layout, this.layoutVersion + 1);
    return layout;
  }

  public createLayout(commits: Commit[]): GraphLayout {
    if (commits.length === 0) {
      return { nodes: [], edges: [], totalRows: 0, maxLane: 0 };
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Active lanes: index → hash of the commit expected at that lane position.
    // null means the lane is free for reuse.
    const activeLanes: (string | null)[] = [];

    // Track colors per commit hash
    const commitColor = new Map<string, number>();
    let colorCounter = 0;

    for (let row = 0; row < commits.length; row++) {
      const commit = commits[row];

      // 1. Find or assign lane for this commit
      let lane: number;
      let color: number;

      const reservedLane = activeLanes.indexOf(commit.hash);
      if (reservedLane !== -1) {
        // This commit was expected in this lane (reserved by a child's parent pointer)
        lane = reservedLane;
        color = commitColor.get(commit.hash) ?? (colorCounter++ % BRANCH_COLORS);
        activeLanes[lane] = null; // temporarily free; will be reassigned below if it has parents
      } else {
        // New branch head — find first free lane
        lane = this.findFreeLane(activeLanes);
        color = colorCounter++ % BRANCH_COLORS;
      }

      commitColor.set(commit.hash, color);

      // 2. Process parents — reserve lanes for them
      for (let pi = 0; pi < commit.parents.length; pi++) {
        const parentHash = commit.parents[pi];

        if (pi === 0) {
          // First parent: continues in the same lane (main line / straight down)
          const existingParentLane = activeLanes.indexOf(parentHash);
          if (existingParentLane === -1) {
            // Parent not yet reserved — put it in our lane
            activeLanes[lane] = parentHash;
            if (!commitColor.has(parentHash)) {
              commitColor.set(parentHash, color);
            }
          }
          // If parent already reserved elsewhere by another child, we just draw an edge to it
        } else {
          // Additional parents (merge sources): assign them a separate lane
          const existingParentLane = activeLanes.indexOf(parentHash);
          if (existingParentLane === -1) {
            const mergeLane = this.findFreeLane(activeLanes);
            activeLanes[mergeLane] = parentHash;
            if (!commitColor.has(parentHash)) {
              const mergeColor = colorCounter++ % BRANCH_COLORS;
              commitColor.set(parentHash, mergeColor);
            }
          }
        }
      }

      // 3. If no parents (root commit) → lane stays free (already null from step 1)
      //    Nothing extra needed since activeLanes[lane] was set to null above
      //    and only gets reassigned if parent[0] occupies it.

      // Build node
      nodes.push({
        hash: commit.hash,
        abbreviatedHash: commit.abbreviatedHash,
        subject: commit.subject,
        author: commit.author,
        authorEmail: commit.authorEmail,
        authorDate: commit.authorDate,
        refs: commit.refs,
        parents: commit.parents,
        lane,
        row,
        color,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      });
    }

    // Build edges (after all nodes are positioned so we know parent positions)
    const nodeMap = new Map<string, { row: number; lane: number; color: number }>();
    for (const node of nodes) {
      nodeMap.set(node.hash, { row: node.row, lane: node.lane, color: node.color });
    }

    for (const node of nodes) {
      for (const parentHash of node.parents) {
        const parent = nodeMap.get(parentHash);
        if (parent !== undefined) {
          edges.push({
            fromHash: node.hash,
            toHash: parentHash,
            fromRow: node.row,
            fromLane: node.lane,
            toRow: parent.row,
            toLane: parent.lane,
            color: node.color,
          });
        }
        // Parents outside the loaded commit range are silently skipped
      }
    }

    const maxLane = nodes.reduce((max, n) => Math.max(max, n.lane), 0);

    return { nodes, edges, totalRows: nodes.length, maxLane };
  }

  public publishLayout(layout: GraphLayout, layoutVersion: number): void {
    this.layout = layout;
    this.layoutVersion = layoutVersion;
    this.edgeRangeIndex = new EdgeRangeIndex(layout.edges);
  }

  public invalidateLayout(layoutVersion: number): void {
    this.layout = null;
    this.layoutVersion = layoutVersion;
    this.edgeRangeIndex = null;
  }

  /**
   * Return a window (slice) of the layout for virtual scrolling.
   * Includes all nodes in [startRow, startRow+count) and all edges
   * that are visible within or cross through that range.
   */
  public getWindow(startRow: number, count: number, layoutVersion?: number): GraphWindow {
    if (layoutVersion !== undefined && layoutVersion !== this.layoutVersion) {
      throw new Error(`Graph layout version mismatch: expected ${this.layoutVersion}, received ${layoutVersion}`);
    }

    if (!this.layout) {
      return { nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 0, maxLane: 0 };
    }

    const actualStart = Math.max(0, startRow);
    const endRow = Math.min(actualStart + count, this.layout.totalRows);

    // Nodes in the window
    const nodes = this.layout.nodes.slice(actualStart, endRow);

    // Edges visible in the window: either endpoint in range, or crossing through
    const edges = this.edgeRangeIndex?.query(actualStart, endRow).edges ?? [];

    return {
      nodes,
      edges,
      startRow: actualStart,
      endRow,
      totalRows: this.layout.totalRows,
      maxLane: this.layout.maxLane,
    };
  }

  /** Total number of rows in the current layout. */
  public getTotalRows(): number {
    return this.layout?.totalRows ?? 0;
  }

  /** Maximum lane index (width of the graph). */
  public getMaxLane(): number {
    return this.layout?.maxLane ?? 0;
  }

  public getLayoutVersion(): number {
    return this.layoutVersion;
  }

  /** Find the first free (null) lane, or expand the array. */
  private findFreeLane(activeLanes: (string | null)[]): number {
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) {
        return i;
      }
    }
    // No free slot — expand
    activeLanes.push(null);
    return activeLanes.length - 1;
  }
}

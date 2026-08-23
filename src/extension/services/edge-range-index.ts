import type { GraphEdge } from '../types/graph.types';

interface IndexedEdge {
  edge: GraphEdge;
  minRow: number;
  maxRow: number;
}

interface IntervalNode {
  center: number;
  crossingByStart: IndexedEdge[];
  crossingByEnd: IndexedEdge[];
  left: IntervalNode | null;
  right: IntervalNode | null;
}

export interface EdgeRangeQuery {
  edges: GraphEdge[];
  inspected: number;
}

export class EdgeRangeIndex {
  private readonly root: IntervalNode | null;

  constructor(edges: GraphEdge[]) {
    this.root = this.build(edges.map((edge) => ({
      edge,
      minRow: Math.min(edge.fromRow, edge.toRow),
      maxRow: Math.max(edge.fromRow, edge.toRow),
    })));
  }

  public query(startRow: number, endRow: number): EdgeRangeQuery {
    const edges: GraphEdge[] = [];
    const inspected = { count: 0 };
    this.queryNode(this.root, startRow, endRow, edges, inspected);
    return { edges, inspected: inspected.count };
  }

  private build(intervals: IndexedEdge[]): IntervalNode | null {
    if (intervals.length === 0) return null;

    const midpoints = intervals
      .map(({ minRow, maxRow }) => (minRow + maxRow) / 2)
      .sort((a, b) => a - b);
    const center = midpoints[Math.floor(midpoints.length / 2)];
    const left: IndexedEdge[] = [];
    const right: IndexedEdge[] = [];
    const crossing: IndexedEdge[] = [];

    for (const interval of intervals) {
      if (interval.maxRow < center) {
        left.push(interval);
      } else if (interval.minRow > center) {
        right.push(interval);
      } else {
        crossing.push(interval);
      }
    }

    return {
      center,
      crossingByStart: [...crossing].sort((a, b) => a.minRow - b.minRow),
      crossingByEnd: [...crossing].sort((a, b) => b.maxRow - a.maxRow),
      left: this.build(left),
      right: this.build(right),
    };
  }

  private queryNode(
    node: IntervalNode | null,
    startRow: number,
    endRow: number,
    edges: GraphEdge[],
    inspected: { count: number },
  ): void {
    if (!node) return;
    inspected.count += 1;

    if (endRow <= node.center) {
      for (const interval of node.crossingByStart) {
        inspected.count += 1;
        if (interval.minRow >= endRow) break;
        edges.push(interval.edge);
      }
      this.queryNode(node.left, startRow, endRow, edges, inspected);
      return;
    }

    if (startRow > node.center) {
      for (const interval of node.crossingByEnd) {
        inspected.count += 1;
        if (interval.maxRow < startRow) break;
        edges.push(interval.edge);
      }
      this.queryNode(node.right, startRow, endRow, edges, inspected);
      return;
    }

    inspected.count += node.crossingByStart.length;
    edges.push(...node.crossingByStart.map(({ edge }) => edge));
    this.queryNode(node.left, startRow, endRow, edges, inspected);
    this.queryNode(node.right, startRow, endRow, edges, inspected);
  }
}

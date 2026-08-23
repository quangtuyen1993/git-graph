import { describe, expect, it } from 'vitest';
import { EdgeRangeIndex } from '../../src/extension/services/edge-range-index';
import type { GraphEdge } from '../../src/extension/types/graph.types';

function edge(id: number, fromRow: number, toRow: number): GraphEdge {
  return {
    fromHash: `from-${id}`,
    toHash: `to-${id}`,
    fromRow,
    fromLane: 0,
    toRow,
    toLane: 0,
    color: 0,
  };
}

describe('EdgeRangeIndex', () => {
  it('queries a large history proportionally to visible and crossing edges', () => {
    const localEdges = Array.from(
      { length: 100_000 },
      (_, row) => edge(row, row, row + 1),
    );
    const longEdge = edge(100_001, 0, 100_000);
    const edges = [...localEdges, longEdge];
    const index = new EdgeRangeIndex(edges);
    const startRow = 50_000;
    const endRow = 50_050;

    const result = index.query(startRow, endRow);
    const expected = edges.filter((candidate) => {
      const minRow = Math.min(candidate.fromRow, candidate.toRow);
      const maxRow = Math.max(candidate.fromRow, candidate.toRow);
      return maxRow >= startRow && minRow < endRow;
    });

    expect(new Set(result.edges)).toEqual(new Set(expected));
    expect(result.edges).toContain(longEdge);
    expect(result.inspected).toBeLessThan(500);
  });
});

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

  it('matches multiplicities for randomized reverse, zero-length, duplicate, and boundary edges', () => {
    let randomState = 0x5eed1234;
    const random = () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 0x1_0000_0000;
    };
    const edges: GraphEdge[] = [
      edge(1, 0, 10),
      edge(2, 10, 0),
      edge(3, 10, 10),
      edge(4, 20, 20),
      edge(5, 20, 30),
      edge(6, 30, 20),
      edge(7, 0, 20_000),
      edge(8, 20_000, 0),
    ];
    const duplicate = edge(9, 9_000, 11_000);
    edges.push(duplicate, { ...duplicate });

    for (let index = 0; index < 5_000; index += 1) {
      const start = Math.floor(random() * 20_000);
      const end = start + Math.floor(random() * 120);
      const generated = index % 2 === 0
        ? edge(100 + index, start, end)
        : edge(100 + index, end, start);
      edges.push(generated);
      if (index < 25) edges.push({ ...generated });
    }

    const index = new EdgeRangeIndex(edges);
    const windows = [
      { startRow: 10, endRow: 20 },
      { startRow: 20, endRow: 30 },
      { startRow: 0, endRow: 10 },
      ...Array.from({ length: 100 }, () => {
        const startRow = Math.floor(random() * 19_900);
        return { startRow, endRow: startRow + 1 + Math.floor(random() * 100) };
      }),
    ];
    const edgeKey = (candidate: GraphEdge) => [
      candidate.fromHash,
      candidate.toHash,
      candidate.fromRow,
      candidate.toRow,
    ].join(':');

    for (const { startRow, endRow } of windows) {
      const result = index.query(startRow, endRow);
      const expected = edges.filter((candidate) => {
        const minRow = Math.min(candidate.fromRow, candidate.toRow);
        const maxRow = Math.max(candidate.fromRow, candidate.toRow);
        return maxRow >= startRow && minRow < endRow;
      });

      expect(result.edges.map(edgeKey).sort()).toEqual(expected.map(edgeKey).sort());
      expect(result.inspected).toBeLessThanOrEqual(result.edges.length + 128);
    }
  });
});

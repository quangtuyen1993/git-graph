import { describe, expect, it } from 'vitest';
import {
  autoGraphColumnWidth,
  clampColumnWidth,
  columnBounds,
  columnResizeDirection,
  defaultColumnWidths,
  readStoredColumnWidths,
} from '../../src/webview/lib/column-layout';

describe('column layout', () => {
  it('sizes the graph column from the lane count when nobody has dragged it', () => {
    expect(autoGraphColumnWidth(0)).toBe(40);
    expect(autoGraphColumnWidth(3)).toBe(88);
    expect(autoGraphColumnWidth(-2)).toBe(40);
  });

  it('keeps a dragged width inside its column bounds', () => {
    expect(clampColumnWidth('date', 5)).toBe(columnBounds.date.min);
    expect(clampColumnWidth('date', 9999)).toBe(columnBounds.date.max);
    expect(clampColumnWidth('date', 120.4)).toBe(120);
    expect(clampColumnWidth('sha', Number.NaN)).toBe(columnBounds.sha.min);
  });

  it('drags every divider with the pointer', () => {
    // GRAPH grows rightwards, the rest grow leftwards into the message column,
    // so in both cases the divider under the pointer is the one that moves.
    expect(columnResizeDirection.graph).toBe(1);
    expect(columnResizeDirection.date).toBe(-1);
    expect(columnResizeDirection.sha).toBe(-1);
    expect(columnResizeDirection.author).toBe(-1);
  });

  it('restores stored widths and clamps stale ones', () => {
    expect(readStoredColumnWidths({ graph: 200, date: 90, sha: 60, author: 180 }))
      .toEqual({ graph: 200, date: 90, sha: 60, author: 180 });
    expect(readStoredColumnWidths({ date: 10_000 }).date).toBe(columnBounds.date.max);
    expect(readStoredColumnWidths({ graph: null }).graph).toBeNull();
  });

  it('falls back to defaults for anything it cannot read', () => {
    expect(readStoredColumnWidths(null)).toEqual(defaultColumnWidths);
    expect(readStoredColumnWidths('80,70,140')).toEqual(defaultColumnWidths);
    expect(readStoredColumnWidths({ date: 'wide' })).toEqual(defaultColumnWidths);
  });
});

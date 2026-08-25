/**
 * Widths for the commit table's fixed columns.
 *
 * MESSAGE has no entry on purpose: it takes whatever the fixed columns leave,
 * so dragging any divider reads as the message column giving way rather than
 * the table growing past the panel it lives in.
 */
export type ColumnKey = 'graph' | 'date' | 'sha' | 'author';

export interface ColumnBounds {
  min: number;
  max: number;
}

export const columnKeys: ColumnKey[] = ['graph', 'date', 'sha', 'author'];

export const columnBounds: Record<ColumnKey, ColumnBounds> = {
  graph: { min: 32, max: 640 },
  date: { min: 48, max: 240 },
  sha: { min: 44, max: 200 },
  author: { min: 56, max: 400 },
};

/**
 * Which way the divider a column is dragged by lies. GRAPH is dragged by the
 * divider on its right, every other column by the one on its left, so in each
 * case the divider follows the pointer instead of moving against it.
 */
export const columnResizeDirection: Record<ColumnKey, 1 | -1> = {
  graph: 1,
  date: -1,
  sha: -1,
  author: -1,
};

/** `null` for GRAPH means "follow the lane count" — the width before anyone dragged it. */
export type ColumnWidths = Record<ColumnKey, number | null>;

export const defaultColumnWidths: ColumnWidths = {
  graph: null,
  date: 80,
  sha: 70,
  author: 140,
};

const LANE_WIDTH = 16;
const GRAPH_PADDING = 24;

/** The width the graph column takes when the user has not sized it themselves. */
export function autoGraphColumnWidth(maxLane: number): number {
  return (Math.max(0, maxLane) + 1) * LANE_WIDTH + GRAPH_PADDING;
}

export function clampColumnWidth(key: ColumnKey, width: number): number {
  const { min, max } = columnBounds[key];
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.max(min, Math.min(max, width)));
}

/**
 * Reads persisted widths back, keeping only what still makes sense. A stored
 * value from an older layout — a missing key, a width outside today's bounds —
 * falls back to the default rather than laying the table out wrong.
 */
export function readStoredColumnWidths(value: unknown): ColumnWidths {
  if (!value || typeof value !== 'object') return { ...defaultColumnWidths };
  const stored = value as Record<string, unknown>;
  const widths: ColumnWidths = { ...defaultColumnWidths };

  for (const key of columnKeys) {
    const raw = stored[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      widths[key] = clampColumnWidth(key, raw);
    } else if (raw === null && key === 'graph') {
      widths.graph = null;
    }
  }

  return widths;
}

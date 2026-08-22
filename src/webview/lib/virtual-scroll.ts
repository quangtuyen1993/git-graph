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
    count: endRow - startRow,
  };
}

export function getTotalHeight(totalRows: number): number {
  return totalRows * ROW_HEIGHT;
}

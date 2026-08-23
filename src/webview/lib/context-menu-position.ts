export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PanelWidthOptions {
  leftWidth: number;
  rightWidth: number;
  viewportWidth: number;
  minimumCenterWidth?: number;
  leftOpen?: boolean;
  rightOpen?: boolean;
}

export function clampMenuPosition(
  requested: Point,
  menu: Size,
  viewport: Size,
  margin = 4,
): Point {
  const maxX = Math.max(margin, viewport.width - menu.width - margin);
  const maxY = Math.max(margin, viewport.height - menu.height - margin);

  return {
    x: Math.min(Math.max(requested.x, margin), maxX),
    y: Math.min(Math.max(requested.y, margin), maxY),
  };
}

export function clampPanelWidths({
  leftWidth,
  rightWidth,
  viewportWidth,
  minimumCenterWidth = 300,
  leftOpen = true,
  rightOpen = true,
}: PanelWidthOptions): { leftWidth: number; rightWidth: number } {
  const currentLeftWidth = Math.max(0, leftWidth);
  const currentRightWidth = Math.max(0, rightWidth);
  const activeLeftWidth = leftOpen ? currentLeftWidth : 0;
  const activeRightWidth = rightOpen ? currentRightWidth : 0;
  const activeTotalWidth = activeLeftWidth + activeRightWidth;
  const availablePanelWidth = Math.max(0, viewportWidth - minimumCenterWidth);

  if (activeTotalWidth <= availablePanelWidth || activeTotalWidth === 0) {
    return { leftWidth: currentLeftWidth, rightWidth: currentRightWidth };
  }

  const nextLeftWidth = leftOpen
    ? Math.round((activeLeftWidth / activeTotalWidth) * availablePanelWidth)
    : currentLeftWidth;
  const nextRightWidth = rightOpen
    ? availablePanelWidth - (leftOpen ? nextLeftWidth : 0)
    : currentRightWidth;

  return { leftWidth: nextLeftWidth, rightWidth: nextRightWidth };
}

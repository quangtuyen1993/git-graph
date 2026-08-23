import { clampPanelWidths } from './context-menu-position';

export type PanelSide = 'left' | 'right';

export interface PanelLayoutInput {
  viewportWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  minimumCenterWidth?: number;
  handleWidth?: number;
  leftMaximumWidth?: number;
  rightMaximumWidth?: number;
}

export interface PanelRange {
  width: number;
  minWidth: number;
  maxWidth: number;
}

export interface PanelLayout {
  left: PanelRange;
  right: PanelRange;
}

const defaultMinimumCenterWidth = 300;
const defaultHandleWidth = 4;
const defaultLeftMinimumWidth = 150;
const defaultRightMinimumWidth = 280;
const defaultLeftMaximumWidth = 400;
const defaultRightMaximumWidth = 600;

export function calculatePanelLayout({
  viewportWidth,
  leftOpen,
  rightOpen,
  leftWidth,
  rightWidth,
  minimumCenterWidth = defaultMinimumCenterWidth,
  handleWidth = defaultHandleWidth,
  leftMaximumWidth = defaultLeftMaximumWidth,
  rightMaximumWidth = defaultRightMaximumWidth,
}: PanelLayoutInput): PanelLayout {
  const visibleHandleWidth = (leftOpen ? handleWidth : 0) + (rightOpen ? handleWidth : 0);
  const availablePanelWidth = Math.max(0, viewportWidth - minimumCenterWidth - visibleHandleWidth);
  const widths = clampPanelWidths({
    leftWidth,
    rightWidth,
    viewportWidth: viewportWidth - visibleHandleWidth,
    minimumCenterWidth,
    leftOpen,
    rightOpen,
  });
  const historicalMinimumWidth = (leftOpen ? defaultLeftMinimumWidth : 0)
    + (rightOpen ? defaultRightMinimumWidth : 0);
  const preservesHistoricalMinimums = availablePanelWidth >= historicalMinimumWidth;
  const leftMinimumWidth = leftOpen && preservesHistoricalMinimums ? defaultLeftMinimumWidth : 0;
  const rightMinimumWidth = rightOpen && preservesHistoricalMinimums ? defaultRightMinimumWidth : 0;
  const maximumLeftWidth = leftOpen ? Math.min(leftMaximumWidth, availablePanelWidth) : 0;
  const maximumRightWidth = rightOpen ? Math.min(rightMaximumWidth, availablePanelWidth) : 0;

  let visibleLeftWidth = leftOpen
    ? Math.min(maximumLeftWidth, Math.max(leftMinimumWidth, widths.leftWidth))
    : 0;
  let visibleRightWidth = rightOpen
    ? Math.min(maximumRightWidth, Math.max(rightMinimumWidth, widths.rightWidth))
    : 0;
  const overflow = visibleLeftWidth + visibleRightWidth - availablePanelWidth;

  if (overflow > 0) {
    const leftReduction = Math.min(overflow, visibleLeftWidth - leftMinimumWidth);
    visibleLeftWidth -= leftReduction;
    visibleRightWidth -= Math.min(
      overflow - leftReduction,
      visibleRightWidth - rightMinimumWidth,
    );
  }

  return {
    left: {
      width: leftOpen ? visibleLeftWidth : widths.leftWidth,
      minWidth: leftMinimumWidth,
      maxWidth: leftOpen
        ? Math.min(maximumLeftWidth, availablePanelWidth - visibleRightWidth)
        : 0,
    },
    right: {
      width: rightOpen ? visibleRightWidth : widths.rightWidth,
      minWidth: rightMinimumWidth,
      maxWidth: rightOpen
        ? Math.min(maximumRightWidth, availablePanelWidth - visibleLeftWidth)
        : 0,
    },
  };
}

export function resizePanel(input: PanelLayoutInput, side: PanelSide, requestedWidth: number): PanelLayout {
  const currentLayout = calculatePanelLayout(input);
  const selectedPanel = side === 'left' ? currentLayout.left : currentLayout.right;
  const width = Math.max(selectedPanel.minWidth, Math.min(selectedPanel.maxWidth, requestedWidth));

  return calculatePanelLayout({
    ...input,
    leftWidth: side === 'left' ? width : currentLayout.left.width,
    rightWidth: side === 'right' ? width : currentLayout.right.width,
  });
}

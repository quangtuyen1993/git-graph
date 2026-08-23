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
  const visibleLeftWidth = leftOpen ? widths.leftWidth : 0;
  const visibleRightWidth = rightOpen ? widths.rightWidth : 0;

  return {
    left: {
      width: widths.leftWidth,
      minWidth: 0,
      maxWidth: leftOpen
        ? Math.min(leftMaximumWidth, Math.max(0, availablePanelWidth - visibleRightWidth))
        : 0,
    },
    right: {
      width: widths.rightWidth,
      minWidth: 0,
      maxWidth: rightOpen
        ? Math.min(rightMaximumWidth, Math.max(0, availablePanelWidth - visibleLeftWidth))
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

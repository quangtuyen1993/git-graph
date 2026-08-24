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
const defaultLeftMinimumWidth = 180;
const defaultRightMinimumWidth = 280;
const defaultLeftMaximumWidth = 460;
const defaultRightMaximumWidth = 900;

/**
 * Widths a panel opens at, and returns to when its handle is double-clicked.
 * The right panel carries commit detail and diffs, so it starts wider.
 */
export const defaultPanelWidths = { left: 260, right: 480 };

/**
 * Derives the rendered panel widths from the widths the user asked for.
 *
 * This is a pure projection: the requested widths are never rewritten, so
 * toggling the sidebar or dragging the panel narrow squeezes the rendered
 * panels without destroying what the user dragged them to.
 */
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
  const requiredMinimumWidth = (leftOpen ? defaultLeftMinimumWidth : 0)
    + (rightOpen ? defaultRightMinimumWidth : 0);
  const fundsBothMinimums = availablePanelWidth >= requiredMinimumWidth;
  const leftMinimumWidth = leftOpen && fundsBothMinimums ? defaultLeftMinimumWidth : 0;
  const rightMinimumWidth = rightOpen && fundsBothMinimums ? defaultRightMinimumWidth : 0;
  const maximumLeftWidth = leftOpen ? Math.min(leftMaximumWidth, availablePanelWidth) : 0;
  const maximumRightWidth = rightOpen ? Math.min(rightMaximumWidth, availablePanelWidth) : 0;

  // Below both minimums there is nothing left to prioritise, so split what
  // remains proportionally rather than letting one open panel vanish.
  const widths = fundsBothMinimums
    ? { leftWidth, rightWidth }
    : clampPanelWidths({
      leftWidth,
      rightWidth,
      viewportWidth: viewportWidth - visibleHandleWidth,
      minimumCenterWidth,
      leftOpen,
      rightOpen,
    });

  let visibleLeftWidth = leftOpen
    ? Math.min(maximumLeftWidth, Math.max(leftMinimumWidth, widths.leftWidth))
    : 0;
  let visibleRightWidth = rightOpen
    ? Math.min(maximumRightWidth, Math.max(rightMinimumWidth, widths.rightWidth))
    : 0;

  // The right panel holds commit detail and diffs, so the left panel gives up
  // space first and the right only shrinks once the left is at its minimum.
  let overflow = visibleLeftWidth + visibleRightWidth - availablePanelWidth;

  if (overflow > 0) {
    const leftReduction = Math.min(overflow, visibleLeftWidth - leftMinimumWidth);
    visibleLeftWidth -= leftReduction;
    overflow -= leftReduction;
  }

  if (overflow > 0) {
    visibleRightWidth -= Math.min(overflow, visibleRightWidth - rightMinimumWidth);
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

export type PanelDensity = 'normal' | 'compact';

/**
 * Below this height the chrome costs more than it explains: in the bottom
 * Panel the toolbar and column header eat a third of the visible rows.
 */
const compactHeightThreshold = 320;

export function calculateDensity({ viewportHeight }: { viewportHeight: number }): PanelDensity {
  return viewportHeight < compactHeightThreshold ? 'compact' : 'normal';
}

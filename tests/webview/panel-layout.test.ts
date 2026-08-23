import { describe, expect, it } from 'vitest';
import { calculatePanelLayout, resizePanel } from '../../src/webview/lib/panel-layout';

const narrowLayout = {
  viewportWidth: 600,
  leftOpen: true,
  rightOpen: true,
  leftWidth: 200,
  rightWidth: 340,
};

function panelTotal(layout: ReturnType<typeof calculatePanelLayout>) {
  return layout.left.width + layout.right.width;
}

describe('panel layout coordinator', () => {
  it('keeps each separator value inside its advertised range in a narrow viewport', () => {
    const layout = calculatePanelLayout(narrowLayout);

    for (const panel of [layout.left, layout.right]) {
      expect(panel.width).toBeGreaterThanOrEqual(panel.minWidth);
      expect(panel.width).toBeLessThanOrEqual(panel.maxWidth);
    }
  });

  it('keeps a 300px center after a mouse-style resize request', () => {
    const layout = resizePanel(narrowLayout, 'left', 1000);

    expect(panelTotal(layout)).toBeLessThanOrEqual(292);
  });

  it('keeps a 300px center when Home is followed by keyboard End on the other panel', () => {
    const initial = calculatePanelLayout(narrowLayout);
    const afterHome = resizePanel({
      ...narrowLayout,
      leftWidth: initial.left.width,
      rightWidth: initial.right.width,
    }, 'left', initial.left.minWidth);
    const afterEnd = resizePanel({
      ...narrowLayout,
      leftWidth: afterHome.left.width,
      rightWidth: afterHome.right.width,
    }, 'right', 600);

    expect(panelTotal(afterEnd)).toBeLessThanOrEqual(292);
  });
});

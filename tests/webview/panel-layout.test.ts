import { describe, expect, it } from 'vitest';
import { calculatePanelLayout, resizePanel } from '../../src/webview/lib/panel-layout';

const narrowLayout = {
  viewportWidth: 600,
  leftOpen: true,
  rightOpen: true,
  leftWidth: 200,
  rightWidth: 340,
};

const wideLayout = {
  viewportWidth: 1400,
  leftOpen: true,
  rightOpen: true,
  leftWidth: 200,
  rightWidth: 340,
};

function panelTotal(layout: ReturnType<typeof calculatePanelLayout>) {
  return layout.left.width + layout.right.width;
}

describe('panel layout coordinator', () => {
  it('advertises a 300px left minimum when a wide viewport has enough panel budget', () => {
    const layout = calculatePanelLayout(wideLayout);

    expect(layout.left.minWidth).toBe(300);
    expect(layout.right.minWidth).toBe(280);
  });

  it('does not resize either wide panel below its historical minimum', () => {
    const afterLeftHome = resizePanel(wideLayout, 'left', 0);
    const afterRightMouseResize = resizePanel(wideLayout, 'right', 0);

    expect(afterLeftHome.left.width).toBe(300);
    expect(afterRightMouseResize.right.width).toBe(280);
  });

  it('keeps values valid at the smallest viewport that supports both panel minima', () => {
    const layout = calculatePanelLayout({ ...wideLayout, viewportWidth: 888 });

    expect(layout.left).toMatchObject({ width: 300, minWidth: 300, maxWidth: 300 });
    expect(layout.right).toMatchObject({ width: 280, minWidth: 280, maxWidth: 280 });
  });

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

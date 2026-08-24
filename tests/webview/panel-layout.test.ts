import { describe, expect, it } from 'vitest';
import { calculateDensity, calculatePanelLayout, defaultPanelWidths, resizePanel } from '../../src/webview/lib/panel-layout';

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
  it('opens the right panel wider than the left by default', () => {
    expect(defaultPanelWidths.right).toBeGreaterThan(defaultPanelWidths.left);
    expect(defaultPanelWidths).toEqual({ left: 260, right: 480 });
  });

  it('advertises the panel minimums when a wide viewport has enough panel budget', () => {
    const layout = calculatePanelLayout(wideLayout);

    expect(layout.left.minWidth).toBe(180);
    expect(layout.right.minWidth).toBe(280);
  });

  it('gives the right panel a higher ceiling than the left', () => {
    const layout = calculatePanelLayout({ ...wideLayout, viewportWidth: 2000 });

    expect(layout.left.maxWidth).toBe(460);
    expect(layout.right.maxWidth).toBe(900);
  });

  it('does not resize either wide panel below its minimum', () => {
    const afterLeftHome = resizePanel(wideLayout, 'left', 0);
    const afterRightMouseResize = resizePanel(wideLayout, 'right', 0);

    expect(afterLeftHome.left.width).toBe(180);
    expect(afterRightMouseResize.right.width).toBe(280);
  });

  it('drains the left panel before the right when both cannot keep their width', () => {
    const layout = calculatePanelLayout({
      ...wideLayout,
      viewportWidth: 1200,
      leftWidth: 400,
      rightWidth: 700,
    });

    expect(layout.right.width).toBe(700);
    expect(layout.left.width).toBe(192);
  });

  it('keeps both panels visible when the viewport cannot fund either minimum', () => {
    const layout = calculatePanelLayout(narrowLayout);

    expect(layout.left.width).toBeGreaterThan(0);
    expect(layout.right.width).toBeGreaterThan(0);
    expect(panelTotal(layout)).toBeLessThanOrEqual(292);
  });

  it('shrinks the advertised maximums to fit the remaining budget', () => {
    const layout = calculatePanelLayout({ ...wideLayout, viewportWidth: 888 });

    expect(layout.left).toMatchObject({ width: 200, minWidth: 180, maxWidth: 240 });
    expect(layout.right).toMatchObject({ width: 340, minWidth: 280, maxWidth: 380 });
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
    }, 'right', 900);

    expect(panelTotal(afterEnd)).toBeLessThanOrEqual(292);
  });

  it('restores the requested width once a transient narrow viewport widens again', () => {
    const desired = { leftWidth: 380, rightWidth: 640 };

    const squeezed = calculatePanelLayout({ ...wideLayout, ...desired, viewportWidth: 760 });
    const restored = calculatePanelLayout({ ...wideLayout, ...desired, viewportWidth: 1400 });

    expect(squeezed.left.width).toBeLessThan(380);
    expect(restored.left.width).toBe(380);
    expect(restored.right.width).toBe(640);
  });
});

describe('calculateDensity', () => {
  it('switches to compact only below the threshold', () => {
    expect(calculateDensity({ viewportHeight: 319 })).toBe('compact');
    expect(calculateDensity({ viewportHeight: 320 })).toBe('normal');
    expect(calculateDensity({ viewportHeight: 321 })).toBe('normal');
  });
});

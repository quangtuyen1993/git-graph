import { describe, expect, it } from 'vitest';
import { clampMenuPosition, clampPanelWidths } from '../../src/webview/lib/context-menu-position';

describe('clampMenuPosition', () => {
  const viewport = { width: 800, height: 600 };
  const menu = { width: 160, height: 200 };

  it('keeps a menu requested above and left of the viewport margin inside the viewport', () => {
    expect(clampMenuPosition({ x: -20, y: -10 }, menu, viewport)).toEqual({ x: 4, y: 4 });
  });

  it('keeps a menu that overflows the right edge inside the viewport', () => {
    expect(clampMenuPosition({ x: 760, y: 20 }, menu, viewport)).toEqual({ x: 636, y: 20 });
  });

  it('keeps a menu that overflows the bottom edge inside the viewport', () => {
    expect(clampMenuPosition({ x: 20, y: 580 }, menu, viewport)).toEqual({ x: 20, y: 396 });
  });

  it('never returns coordinates below the margin when the menu is larger than the viewport', () => {
    const position = clampMenuPosition(
      { x: 0, y: 0 },
      { width: 1000, height: 1000 },
      { width: 600, height: 400 },
    );

    expect(position.x).toBeGreaterThanOrEqual(4);
    expect(position.y).toBeGreaterThanOrEqual(4);
  });
});

describe('clampPanelWidths', () => {
  it('preserves a 300px center panel in a narrow 600px viewport', () => {
    expect(clampPanelWidths({
      leftWidth: 200,
      rightWidth: 340,
      viewportWidth: 600,
    })).toEqual({ leftWidth: 111, rightWidth: 189 });
  });

  it('retains configured panel widths in a normal 1400px viewport', () => {
    expect(clampPanelWidths({
      leftWidth: 200,
      rightWidth: 340,
      viewportWidth: 1400,
    })).toEqual({ leftWidth: 200, rightWidth: 340 });
  });
});

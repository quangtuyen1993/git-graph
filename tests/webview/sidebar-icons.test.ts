import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BranchSidebar from '../../src/webview/components/sidebar/BranchSidebar.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: 'origin/main', ahead: 0, behind: 0 },
  { name: 'feat/graph', current: false, hash: 'b'.repeat(40), remote: null, upstream: null, ahead: 1, behind: 0 },
];
const tags = [{ name: 'v1.0.0', hash: 'b'.repeat(40), message: null, taggerDate: null }];
const stashes = [{ index: 0, message: 'save work', date: '2026-08-23', branch: 'main', hash: 'c'.repeat(40) }];
const worktrees = [
  { path: '/repo', head: 'd'.repeat(40), branch: 'main', bare: false, isMain: true },
  { path: '/repo/feature', head: 'e'.repeat(40), branch: 'feature', bare: false, isMain: false },
];
const submodules = [{ name: 'sdk', path: 'packages/sdk', head: 'f'.repeat(40), state: 'initialized' as const }];

function renderSidebar() {
  return render(BranchSidebar, { branches, tags, stashes, worktrees, submodules });
}

describe('BranchSidebar iconography', () => {
  afterEach(cleanup);

  it('draws section collapse controls as SVG glyphs, not text arrows', () => {
    const { container } = renderSidebar();
    const header = container.querySelector('.section-header') as HTMLElement;

    expect(header.querySelector('svg')).toBeTruthy();
    expect(header.textContent).not.toContain('▶');
  });

  it('uses no emoji anywhere in the sidebar', () => {
    const { container } = renderSidebar();

    expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
  });

  it('sizes every row glyph on the same 16px grid', () => {
    const { container } = renderSidebar();
    const glyphs = [...container.querySelectorAll('svg')];

    expect(glyphs.length).toBeGreaterThan(5);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute('viewBox')).toBe('0 0 16 16');
      expect(Number(glyph.getAttribute('width'))).toBeLessThanOrEqual(16);
    }
  });
});

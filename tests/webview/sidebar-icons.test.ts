import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BranchSidebar from '../../src/webview/components/sidebar/BranchSidebar.svelte';

const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: 'origin/main', ahead: 0, behind: 0 },
  { name: 'feat/graph', current: false, hash: 'b'.repeat(40), remote: null, upstream: null, ahead: 1, behind: 0 },
  { name: 'origin/main', current: false, hash: 'a'.repeat(40), remote: 'origin', upstream: null, ahead: 0, behind: 0 },
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

describe('BranchSidebar hierarchy', () => {
  afterEach(cleanup);

  it('marks a remote group as a child row rather than a second section header', async () => {
    const { container } = renderSidebar();
    // REMOTE is collapsed by default, so open it before reaching inside.
    const remoteSection = [...container.querySelectorAll('.section-header')]
      .find((candidate) => candidate.textContent?.includes('REMOTE'))!;
    await fireEvent.click(remoteSection);
    const remoteHeader = container.querySelector('.remote-header') as HTMLElement;

    expect(remoteHeader).toBeTruthy();
    // The remote name is nested under REMOTE, so it must not carry the
    // section-header class that styles top-level rows.
    expect(remoteHeader.classList.contains('section-header')).toBe(false);
    expect(remoteHeader.classList.contains('nested-header')).toBe(true);
  });

  it('keeps REMOTE itself a top-level section header', () => {
    const { container } = renderSidebar();
    const headers = [...container.querySelectorAll('.section-header')];
    const remoteSection = headers.find(h => h.textContent?.includes('REMOTE'));

    expect(remoteSection).toBeTruthy();
    expect(remoteSection?.classList.contains('nested-header')).toBe(false);
  });
});

describe('BranchSidebar ahead/behind indicators', () => {
  afterEach(cleanup);

  const diverged = [
    { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: 'origin/main', ahead: 2, behind: 5 },
  ];

  it('renders ahead and behind as rotated arrow glyphs, not text characters', () => {
    const { container } = render(BranchSidebar, {
      branches: diverged, tags: [], stashes: [], worktrees: [], submodules: [],
    });

    const ahead = container.querySelector('.ahead') as HTMLElement;
    const behind = container.querySelector('.behind') as HTMLElement;

    expect(ahead.querySelector('svg')).toBeTruthy();
    expect(behind.querySelector('svg')).toBeTruthy();
    expect(ahead.textContent).toContain('2');
    expect(behind.textContent).toContain('5');
    // The old implementation used literal arrow characters.
    expect(container.textContent).not.toContain('↑');
    expect(container.textContent).not.toContain('↓');
  });

  it('shows neither indicator when the branch is level with its remote', () => {
    const level = [{ ...diverged[0], ahead: 0, behind: 0 }];
    const { container } = render(BranchSidebar, {
      branches: level, tags: [], stashes: [], worktrees: [], submodules: [],
    });

    expect(container.querySelector('.ahead')).toBeNull();
    expect(container.querySelector('.behind')).toBeNull();
  });
});

describe('BranchSidebar indentation', () => {
  afterEach(cleanup);

  const nested = [
    { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
    { name: 'chore/deps/bump', current: false, hash: 'b'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
    { name: 'chore/deps/lock', current: false, hash: 'c'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
  ];

  /** The --tree-indent each row carries, in px. */
  function indentOf(el: Element | null): number {
    return Number.parseInt((el as HTMLElement).style.getPropertyValue('--tree-indent'), 10);
  }

  it('steps every level by the same amount', async () => {
    const { container, getByRole } = render(BranchSidebar, {
      branches: nested, tags: [], stashes: [], worktrees: [], submodules: [],
    });

    const chore = getByRole('button', { name: 'Branch group chore' });
    await fireEvent.click(chore);
    const deps = getByRole('button', { name: 'Branch group chore/deps' });
    await fireEvent.click(deps);

    const level1 = indentOf(chore);
    const level2 = indentOf(deps);
    const level3 = indentOf(container.querySelector('[aria-label="chore/deps/bump"]'));

    // The step from group to subgroup must equal the step from subgroup to leaf.
    expect(level2 - level1).toBe(level3 - level2);
    expect(level1).toBeGreaterThan(0);
  });

  it('indents a top-level group past its section header', () => {
    const { getByRole } = render(BranchSidebar, {
      branches: nested, tags: [], stashes: [], worktrees: [], submodules: [],
    });

    // A section header sits at the sidebar gutter with no tree indent; a group
    // directly beneath it must not land on the same left edge.
    expect(indentOf(getByRole('button', { name: 'Branch group chore' }))).toBeGreaterThan(0);
  });
});

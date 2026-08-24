import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BranchSidebar from '../../src/webview/components/sidebar/BranchSidebar.svelte';

const branch = (over: Record<string, unknown> = {}) => ({
  name: 'main',
  current: false,
  hash: 'a'.repeat(40),
  remote: null,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  ...over,
});

function renderSidebar(props: Record<string, unknown> = {}) {
  return render(BranchSidebar, {
    branches: [branch()], tags: [], stashes: [], worktrees: [], submodules: [], ...props,
  });
}

describe('branch row counts', () => {
  afterEach(cleanup);

  it('shows a two-digit count as-is', () => {
    const { container } = renderSidebar({ branches: [branch({ ahead: 99, behind: 12 })] });

    expect(container.querySelector('.ahead')).toHaveTextContent('99');
    expect(container.querySelector('.behind')).toHaveTextContent('12');
  });

  it('caps a count past 99 so a long-diverged branch cannot stretch the row', () => {
    const { container } = renderSidebar({ branches: [branch({ ahead: 100, behind: 4213 })] });

    expect(container.querySelector('.ahead')).toHaveTextContent('99+');
    expect(container.querySelector('.behind')).toHaveTextContent('99+');
  });
});

describe('branch favourites', () => {
  afterEach(cleanup);

  it('marks a favourite branch and leaves the others unmarked', () => {
    const { container } = renderSidebar({
      branches: [branch({ name: 'main' }), branch({ name: 'other' })],
      favourites: ['main'],
    });

    const stars = [...container.querySelectorAll('.branch-item')].map(
      (row) => row.querySelector('.favourite.is-favourite') !== null,
    );
    expect(stars).toEqual([true, false]);
  });

  it('asks to toggle rather than deciding for itself', async () => {
    const { component, container } = renderSidebar({ branches: [branch({ name: 'main' })] });
    const onToggle = vi.fn();
    component.$on('favouriteToggle', onToggle);

    await fireEvent.click(container.querySelector('.favourite')!);

    expect(onToggle).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { name: 'main' } }),
    );
  });

  it('sorts favourites above everything else in LOCAL', () => {
    const { container } = renderSidebar({
      branches: [branch({ name: 'aaa' }), branch({ name: 'zzz' })],
      favourites: ['zzz'],
    });

    const names = [...container.querySelectorAll('.branch-item .branch-name')]
      .map((el) => el.textContent?.trim());
    expect(names[0]).toBe('zzz');
  });

  it('does not let a favourite click also select the branch', async () => {
    const { component, container } = renderSidebar({ branches: [branch({ name: 'main' })] });
    const onSelect = vi.fn();
    component.$on('branchSelect', onSelect);

    await fireEvent.click(container.querySelector('.favourite')!);

    expect(onSelect).not.toHaveBeenCalled();
  });
});


import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BranchSidebar from '../../src/webview/components/sidebar/BranchSidebar.svelte';

const branch = (name: string, over: Record<string, unknown> = {}) => ({
  name, current: false, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0, ...over,
});

const props = {
  branches: [branch('main', { current: true }), branch('feat/deep/thing'), branch('chore/deps')],
  tags: [{ name: 'v1.0.0', hash: 'b'.repeat(40), message: null, taggerDate: null }],
  stashes: [{ index: 0, message: 'save work', date: '2026-08-23', branch: 'main', hash: 'c'.repeat(40) }],
  worktrees: [],
  submodules: [],
};

const search = (c: HTMLElement) => c.querySelector('.sidebar-search input') as HTMLInputElement;

describe('sidebar search', () => {
  afterEach(cleanup);

  it('offers a search field for branches and tags', () => {
    const { container } = render(BranchSidebar, props);

    expect(search(container)).toHaveAttribute('placeholder', 'Branch or tag');
  });

  it('hides rows that do not match', async () => {
    const { container, queryByRole } = render(BranchSidebar, props);

    await fireEvent.input(search(container), { target: { value: 'chore' } });

    expect(queryByRole('button', { name: 'chore/deps' })).toBeTruthy();
    expect(queryByRole('button', { name: 'main' })).toBeNull();
  });

  it('reveals a match buried inside a collapsed group', async () => {
    const { container, queryByRole } = render(BranchSidebar, props);
    // feat/deep/thing is nested and its groups start collapsed.
    expect(queryByRole('button', { name: 'feat/deep/thing' })).toBeNull();

    await fireEvent.input(search(container), { target: { value: 'thing' } });

    expect(queryByRole('button', { name: 'feat/deep/thing' })).toBeTruthy();
  });

  it('searches tags and stashes too, opening their collapsed sections', async () => {
    const { container, queryByRole } = render(BranchSidebar, props);
    expect(queryByRole('button', { name: /v1\.0\.0/ })).toBeNull();

    await fireEvent.input(search(container), { target: { value: 'v1.0' } });

    expect(queryByRole('button', { name: /v1\.0\.0/ })).toBeTruthy();
  });

  it('hides a section that has no matches rather than leaving an empty header', async () => {
    const { container } = render(BranchSidebar, props);

    await fireEvent.input(search(container), { target: { value: 'chore' } });

    const titles = [...container.querySelectorAll('.section-title')].map((el) => el.textContent);
    expect(titles).toContain('LOCAL');
    expect(titles).not.toContain('TAGS');
  });

  it('restores the expand state you had before searching', async () => {
    const { container, queryByRole } = render(BranchSidebar, props);

    await fireEvent.input(search(container), { target: { value: 'thing' } });
    expect(queryByRole('button', { name: 'feat/deep/thing' })).toBeTruthy();

    await fireEvent.input(search(container), { target: { value: '' } });

    // The auto-expansion was a view of the search, not a change to preferences.
    expect(queryByRole('button', { name: 'feat/deep/thing' })).toBeNull();
  });

  it('clears on Escape', async () => {
    const { container, queryByRole } = render(BranchSidebar, props);
    await fireEvent.input(search(container), { target: { value: 'chore' } });
    expect(queryByRole('button', { name: 'main' })).toBeNull();

    await fireEvent.keyDown(search(container), { key: 'Escape' });

    expect(queryByRole('button', { name: 'main' })).toBeTruthy();
  });
});

describe('sidebar HEAD row', () => {
  afterEach(cleanup);

  it('names the current branch above the sections', () => {
    const { container } = render(BranchSidebar, props);

    expect(container.querySelector('.head-row')).toHaveTextContent('main');
  });

  it('stays visible when LOCAL is collapsed', async () => {
    const { container, getByRole } = render(BranchSidebar, props);

    const local = [...container.querySelectorAll('.section-header')]
      .find((h) => h.textContent?.includes('LOCAL'))!;
    await fireEvent.click(local);

    expect(container.querySelector('.head-row')).toHaveTextContent('main');
  });

  it('is absent on a detached head with no current branch', () => {
    const { container } = render(BranchSidebar, {
      ...props,
      branches: [branch('main'), branch('other')],
    });

    expect(container.querySelector('.head-row')).toBeNull();
  });
});

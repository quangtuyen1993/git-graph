import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import CommitDetail from '../../src/webview/components/detail/CommitDetail.svelte';

const commit = {
  hash: 'a'.repeat(40),
  abbreviatedHash: 'aaaaaaa',
  subject: 'Add the thing',
  message: 'Add the thing\n\nWith a longer body explaining why.',
  author: 'Tuyen',
  authorEmail: 'tuyen@example.test',
  authorDate: '2026-08-24T00:00:00Z',
  refs: [],
};

const files = [
  { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
  { path: 'src/b.ts', oldPath: null, status: 'added', additions: 9, deletions: 0, binary: false },
];

function renderDetail() {
  return render(CommitDetail, { commit, files, loading: false });
}

describe('CommitDetail layout', () => {
  afterEach(cleanup);

  it('puts the changed files above the author, refs and message', () => {
    const { container } = renderDetail();
    const filesHeader = container.querySelector('.detail-files-header')!;
    const message = container.querySelector('.detail-message')!;

    // compareDocumentPosition: FOLLOWING means message comes after the files.
    expect(filesHeader.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('offers a vertical splitter between the two', () => {
    const { getByRole } = renderDetail();
    const handle = getByRole('separator');

    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('resizes the message and refuses to shrink it past its minimum', async () => {
    const { getByRole, container } = renderDetail();
    const handle = getByRole('separator');
    const message = container.querySelector('.detail-meta') as HTMLElement;
    const startingHeight = Number.parseInt(message.style.height, 10);

    // Dragging up grows the message, since it sits below the handle.
    await fireEvent.mouseDown(handle, { clientY: 0 });
    await fireEvent.mouseMove(document, { clientY: -40 });
    await fireEvent.mouseUp(document);
    expect(Number.parseInt(message.style.height, 10)).toBe(startingHeight + 40);

    // Dragging far the other way stops at the floor rather than collapsing.
    await fireEvent.mouseDown(handle, { clientY: 0 });
    await fireEvent.mouseMove(document, { clientY: 5000 });
    await fireEvent.mouseUp(document);
    expect(Number.parseInt(message.style.height, 10)).toBe(96);
  });

  it('restores the default split on a double-click', async () => {
    const { getByRole, container } = renderDetail();
    const handle = getByRole('separator');
    const message = container.querySelector('.detail-meta') as HTMLElement;

    await fireEvent.mouseDown(handle, { clientY: 0 });
    await fireEvent.mouseMove(document, { clientY: -60 });
    await fireEvent.mouseUp(document);
    expect(Number.parseInt(message.style.height, 10)).not.toBe(160);

    await fireEvent.dblClick(handle);

    expect(Number.parseInt(message.style.height, 10)).toBe(160);
  });
});

describe('CommitDetail grouping', () => {
  afterEach(cleanup);

  it('keeps author, sha and message together in the lower pane', () => {
    const { container } = render(CommitDetail, { commit, files, loading: false });
    const meta = container.querySelector('.detail-meta')!;

    expect(meta.querySelector('.detail-author')).toBeTruthy();
    expect(meta.querySelector('.detail-refs')).toBeTruthy();
    expect(meta.querySelector('.detail-message')).toBeTruthy();
  });

  it('leaves the files header as the very first row of the panel', () => {
    const { container } = render(CommitDetail, { commit, files, loading: false });
    const panel = container.querySelector('.detail-panel')!;

    expect(panel.firstElementChild).toHaveClass('detail-files-header');
  });
});

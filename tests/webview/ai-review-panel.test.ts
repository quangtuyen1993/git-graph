import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AIReviewPanel from '../../src/webview/components/review/AIReviewPanel.svelte';

const providers = [
  { id: 'claude', name: 'Claude', available: true, group: 'cli' as const },
  { id: 'deepseek', name: 'DeepSeek', available: false, group: 'api' as const },
];
const branches = [
  { name: 'main', current: false },
  { name: 'feature', current: true },
];
const compareFiles = [
  { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
  { path: 'src/b.ts', oldPath: null, status: 'added', additions: 9, deletions: 0, binary: false },
];

function renderPanel(props: Record<string, unknown> = {}) {
  return render(AIReviewPanel, {
    providers,
    branches,
    compareFiles,
    initialSource: 'main',
    initialTarget: 'feature',
    ...props,
  });
}

describe('AIReviewPanel', () => {
  afterEach(() => cleanup());

  it('holds no review result markup — a finished review lives only in the Code Review panel', () => {
    const { container } = renderPanel();
    expect(container.querySelector('.review-result')).toBeNull();
  });

  it('collapses and expands the files section', async () => {
    const { container, getByRole } = renderPanel();

    const filesToggle = getByRole('button', { name: /files changed/i });
    expect(container.querySelector('.file-list')).not.toBeNull();

    await fireEvent.click(filesToggle);
    expect(container.querySelector('.file-list')).toBeNull();
    expect(filesToggle.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(filesToggle);
    expect(container.querySelector('.file-list')).not.toBeNull();
    expect(filesToggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('dispatches review with the selected branches, provider and model, then hints where to find the result', async () => {
    const { getByRole, container, component } = renderPanel({ initialProvider: 'claude', initialModel: 'sonnet' });
    const onReview = vi.fn();
    component.$on('review', onReview);

    expect(container.querySelector('.review-started-hint')).toBeNull();

    await fireEvent.click(getByRole('button', { name: /Review Changes/ }));

    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview.mock.calls[0][0].detail).toEqual({
      sourceBranch: 'main',
      targetBranch: 'feature',
      provider: 'claude',
      model: 'sonnet',
    });
    expect(container.querySelector('.review-started-hint')?.textContent)
      .toContain('Started — see the Code Review panel.');
  });

  it('explains an empty comparison instead of showing a blank list', () => {
    const { container } = renderPanel({ compareFiles: [] });
    expect(container.querySelector('.files-empty')?.textContent)
      .toContain('No differences between these branches.');
  });
});

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

  it('renders no review-result surface even if a reviewResult-shaped value is forced onto the instance', () => {
    // The component no longer declares a `reviewResult` prop, so this value is
    // inert — but forcing it onto the instance is exactly what would have hit
    // the old `{#if reviewResult}` block if the removal were incomplete. A
    // plain `renderPanel()` with nothing forced would pass whether or not the
    // markup was actually removed (App itself never passes a truthy
    // reviewResult, before or after this task), so it proves nothing on its
    // own — this is the one that is actually sensitive to the removal.
    const { container } = renderPanel({
      reviewResult: { content: 'Looks good.', provider: 'claude', model: 'sonnet', timestamp: '2026-08-24T00:00:00.000Z' },
    });
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

  it('hides the started hint once a review.start failure surfaces as an error', async () => {
    const { getByRole, container, component } = renderPanel({ initialProvider: 'claude' });

    await fireEvent.click(getByRole('button', { name: /Review Changes/ }));
    expect(container.querySelector('.review-started-hint')).not.toBeNull();

    // Mirrors what App.svelte does on a review.start rejection: it sets
    // aiReviewError, which flows into this prop. Nothing was actually queued,
    // so pointing the user at the Code Review panel would be wrong.
    component.$set({ error: 'Nothing to review — no changes between these branches' });
    await Promise.resolve();

    expect(container.querySelector('.review-started-hint')).toBeNull();
  });

  it('clears the started hint once a new comparison begins', async () => {
    const { getByRole, container } = renderPanel({ initialProvider: 'claude' });

    await fireEvent.click(getByRole('button', { name: /Review Changes/ }));
    expect(container.querySelector('.review-started-hint')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: /Compare/ }));
    expect(container.querySelector('.review-started-hint')).toBeNull();
  });

  it('explains an empty comparison instead of showing a blank list', () => {
    const { container } = renderPanel({ compareFiles: [] });
    expect(container.querySelector('.files-empty')?.textContent)
      .toContain('No differences between these branches.');
  });
});

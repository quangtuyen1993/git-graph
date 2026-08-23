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
const reviewResult = {
  content: '## Summary\n\nLooks good.',
  provider: 'claude',
  model: 'sonnet',
  timestamp: '2026-08-24T00:00:00.000Z',
};

function renderPanel(props: Record<string, unknown> = {}) {
  return render(AIReviewPanel, {
    providers,
    branches,
    compareFiles,
    initialSource: 'main',
    initialTarget: 'feature',
    reviewResult,
    ...props,
  });
}

describe('AIReviewPanel', () => {
  afterEach(() => cleanup());

  it('renders the review as markdown rather than raw text', () => {
    const { container } = renderPanel();
    const heading = container.querySelector('.result-content h2');
    expect(heading?.textContent).toBe('Summary');
    expect(container.querySelector('.result-content')?.textContent).not.toContain('##');
  });

  it('collapses and expands the files and review sections independently', async () => {
    const { container, getByRole } = renderPanel();

    const filesToggle = getByRole('button', { name: /files changed/i });
    const reviewToggle = getByRole('button', { name: /^\s*▶?\s*review/i });

    expect(container.querySelector('.file-list')).not.toBeNull();
    expect(container.querySelector('.result-content')).not.toBeNull();

    await fireEvent.click(filesToggle);
    expect(container.querySelector('.file-list')).toBeNull();
    // Collapsing files must not affect the review section.
    expect(container.querySelector('.result-content')).not.toBeNull();
    expect(filesToggle.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(reviewToggle);
    expect(container.querySelector('.result-content')).toBeNull();
    expect(reviewToggle.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(filesToggle);
    expect(container.querySelector('.file-list')).not.toBeNull();
    expect(filesToggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('re-expands the review section when a newer review arrives', async () => {
    const { container, getByRole, component } = renderPanel();

    await fireEvent.click(getByRole('button', { name: /^\s*▶?\s*review/i }));
    expect(container.querySelector('.result-content')).toBeNull();

    component.$set({
      reviewResult: { ...reviewResult, content: '## Next\n\nOther.', timestamp: '2026-08-24T01:00:00.000Z' },
    });
    await Promise.resolve();

    expect(container.querySelector('.result-content')?.textContent).toContain('Other.');
  });

  it('emits a markdown document with comparison context when opening in the editor', async () => {
    const { getByTitle, component } = renderPanel();
    const onOpenReview = vi.fn();
    component.$on('openReview', onOpenReview);

    await fireEvent.click(getByTitle('Open review in editor'));

    expect(onOpenReview).toHaveBeenCalledTimes(1);
    const { content, label } = onOpenReview.mock.calls[0][0].detail;
    expect(label).toBe('review-main-to-feature');
    expect(content).toContain('# Code review: main → feature');
    expect(content).toContain('- Base: `main`');
    expect(content).toContain('- Head: `feature`');
    expect(content).toContain('- Reviewer: claude/sonnet');
    expect(content).toContain('- Files changed: 2');
    expect(content).toContain('Looks good.');
  });

  it('explains an empty comparison instead of showing a blank list', () => {
    const { container } = renderPanel({ compareFiles: [] });
    expect(container.querySelector('.files-empty')?.textContent)
      .toContain('No differences between these branches.');
  });
});

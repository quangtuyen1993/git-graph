import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';

const contributes = pkg.contributes as Record<string, never>;

describe('review contributions', () => {
  it('keeps the Code Review container in the bottom Panel', () => {
    const panel = (contributes.viewsContainers as unknown as { panel: { id: string; icon: string }[] }).panel;
    expect(panel.find(c => c.id === 'gitGraphProReview')).toBeDefined();
  });

  it('registers the reviews view as a webview that survives hiding', () => {
    const views = contributes.views as unknown as Record<string, {
      id: string; type?: string; webviewOptions?: { retainContextWhenHidden?: boolean };
    }[]>;
    const review = views.gitGraphProReview?.[0];

    expect(review?.id).toBe('gitGraphPro.reviews');
    expect(review?.type).toBe('webview');
    expect(review?.webviewOptions?.retainContextWhenHidden).toBe(true);
  });

  it('has no tree commands left — row actions live inside the webview', () => {
    const ids = (contributes.commands as unknown as { command: string }[]).map(c => c.command);
    expect(ids).not.toContain('gitGraphPro.review.cancel');
    expect(ids).not.toContain('gitGraphPro.review.rerun');
    expect(ids).not.toContain('gitGraphPro.review.delete');
    const menus = contributes.menus as unknown as Record<string, unknown> | undefined;
    expect(menus?.['view/item/context']).toBeUndefined();
  });
});

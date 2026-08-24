import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';

const contributes = pkg.contributes as Record<string, never>;

describe('review contributions', () => {
  it('adds a Code Review container to the bottom Panel', () => {
    const panel = (contributes.viewsContainers as unknown as { panel: { id: string; icon: string }[] }).panel;
    const review = panel.find(c => c.id === 'gitGraphProReview');

    expect(review).toBeDefined();
    expect(review?.icon).toBe('resources/review.svg');
  });

  it('registers the reviews tree view in that container', () => {
    const views = contributes.views as unknown as Record<string, { id: string; type?: string }[]>;

    expect(views.gitGraphProReview?.[0]?.id).toBe('gitGraphPro.reviews');
    expect(views.gitGraphProReview?.[0]?.type).toBeUndefined(); // a tree, not a webview
  });

  it('declares cancel, rerun and delete commands', () => {
    const ids = (contributes.commands as unknown as { command: string }[]).map(c => c.command);

    expect(ids).toEqual(expect.arrayContaining([
      'gitGraphPro.review.cancel',
      'gitGraphPro.review.rerun',
      'gitGraphPro.review.delete',
    ]));
  });

  it('shows cancel only on a running row and rerun/delete only on finished rows', () => {
    const menus = (contributes.menus as unknown as Record<string, { command: string; when: string }[]>);
    const items = menus['view/item/context'];
    const find = (command: string) => items.find(i => i.command === command);

    expect(find('gitGraphPro.review.cancel')?.when).toContain('viewItem == running');
    expect(find('gitGraphPro.review.rerun')?.when).toContain('viewItem != running');
    expect(find('gitGraphPro.review.delete')?.when).toContain('viewItem != running');
  });

  it('keeps activationEvents empty so VS Code infers onView', () => {
    expect(pkg.activationEvents).toEqual([]);
  });
});

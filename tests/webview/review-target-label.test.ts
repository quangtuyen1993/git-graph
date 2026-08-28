import { describe, expect, it } from 'vitest';
import { reviewTargetLabel } from '../../src/webview/lib/review-target-label';

// Important finding 4: every webview type mirror of the review target kind
// still said 'branch' | 'commit' | 'range' | 'pr' — the extension side was
// widened to include 'worktree', but every hop into the webview goes through
// an `as` cast, so tsc/svelte-check can't flag the mismatch. This is the
// `reviewTargetLabel` half: the fallback `baseRef ← headRef` form would
// render 'HEAD ← Working Tree' for a resolved worktree target, which is
// technically not wrong but is exactly the generic form the fix asks this
// kind to have a deliberate label instead of.
describe('reviewTargetLabel', () => {
  it('gives kind "worktree" a deliberate label rather than the generic base ← head form', () => {
    const label = reviewTargetLabel({
      kind: 'worktree',
      baseRef: 'HEAD',
      baseSha: 'a'.repeat(40),
      headRef: 'Working Tree',
      headSha: '',
    });

    expect(label).not.toContain('←');
    expect(label).toBe('Uncommitted changes');
  });
});

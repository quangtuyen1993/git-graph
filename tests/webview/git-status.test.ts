import { describe, expect, it } from 'vitest';
import { hasWorkingTreeChanges } from '../../src/webview/lib/git-status';

describe('hasWorkingTreeChanges', () => {
  const emptyStatus = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  it.each([
    ['staged', { staged: ['src/app.ts'] }],
    ['unstaged', { unstaged: ['src/app.ts'] }],
    ['untracked', { untracked: ['src/app.ts'] }],
    ['conflicted', { conflicted: ['src/app.ts'] }],
  ])('returns true when %s changes exist', (_kind, changes) => {
    expect(hasWorkingTreeChanges({ ...emptyStatus, ...changes })).toBe(true);
  });

  it('returns false when every working-tree collection is empty', () => {
    expect(hasWorkingTreeChanges(emptyStatus)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { refDisplayName, refType, sortRefsForRow } from '../../src/webview/lib/ref-chips';

describe('sortRefsForRow', () => {
  it('puts HEAD first, then local branches, then tags, then remotes', () => {
    expect(sortRefsForRow([
      'origin/develop', 'tag: v1.2.0', 'develop', 'HEAD -> develop',
    ])).toEqual([
      'HEAD -> develop', 'develop', 'tag: v1.2.0', 'origin/develop',
    ]);
  });

  it('keeps a stable order inside a group', () => {
    expect(sortRefsForRow(['feature/b', 'feature/a'])).toEqual(['feature/b', 'feature/a']);
  });

  it('leaves an empty list alone', () => {
    expect(sortRefsForRow([])).toEqual([]);
  });
});

describe('refType', () => {
  it('classifies each ref shape', () => {
    expect(refType('HEAD -> develop')).toBe('head');
    expect(refType('HEAD')).toBe('head');
    expect(refType('tag: v1.0.0')).toBe('tag');
    expect(refType('origin/develop')).toBe('remote');
    expect(refType('develop')).toBe('branch');
  });

  it("reads git's own origin/HEAD decoration as a remote, not as HEAD", () => {
    // `origin/HEAD -> origin/main` is a remote's default branch pointer. Called
    // HEAD it took the leftmost, truncation-protected chip slot from the branch
    // actually checked out, and rendered in the HEAD style.
    expect(refType('origin/HEAD -> origin/main')).toBe('remote');
    expect(refType('upstream/HEAD')).toBe('remote');
    expect(refType('feature/HEAD-refactor')).toBe('branch');
  });
});

describe('sortRefsForRow with a remote HEAD pointer present', () => {
  it('still leads with the real HEAD', () => {
    expect(sortRefsForRow(['origin/HEAD -> origin/main', 'main', 'HEAD -> main']))
      .toEqual(['HEAD -> main', 'main', 'origin/HEAD -> origin/main']);
  });
});

describe('refDisplayName', () => {
  it('strips the tag and HEAD prefixes', () => {
    expect(refDisplayName('tag: v1.0.0')).toBe('v1.0.0');
    expect(refDisplayName('HEAD -> develop')).toBe('develop');
    expect(refDisplayName('origin/develop')).toBe('origin/develop');
  });
});

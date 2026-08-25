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
    expect(refType('tag: v1.0.0')).toBe('tag');
    expect(refType('origin/develop')).toBe('remote');
    expect(refType('develop')).toBe('branch');
  });
});

describe('refDisplayName', () => {
  it('strips the tag and HEAD prefixes', () => {
    expect(refDisplayName('tag: v1.0.0')).toBe('v1.0.0');
    expect(refDisplayName('HEAD -> develop')).toBe('develop');
    expect(refDisplayName('origin/develop')).toBe('origin/develop');
  });
});

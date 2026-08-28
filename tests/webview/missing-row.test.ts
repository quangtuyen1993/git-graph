import { describe, expect, it } from 'vitest';
import { missingRowReason } from '../../src/webview/lib/missing-row';

describe('missingRowReason', () => {
  it('blames the branch filter when one is active', () => {
    expect(missingRowReason({ branchFilterActive: true })).toBe('filtered');
  });

  it('blames the commit being absent when no filter is active', () => {
    expect(missingRowReason({ branchFilterActive: false })).toBe('absent');
  });
});

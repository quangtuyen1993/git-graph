import { describe, expect, it } from 'vitest';
import { classifyQuery, formatMatchCounter, nextMatchIndex } from '../../src/webview/lib/commit-search';

describe('classifyQuery', () => {
  it('treats blank input as empty', () => {
    expect(classifyQuery('   ')).toBe('empty');
    expect(classifyQuery('')).toBe('empty');
  });

  it('recognises hash-shaped input of 7 to 40 hex characters', () => {
    expect(classifyQuery('a1b2c3d')).toBe('hash');
    expect(classifyQuery('A1B2C3D')).toBe('hash');
    expect(classifyQuery('f'.repeat(40))).toBe('hash');
  });

  it('treats short or non-hex input as text', () => {
    expect(classifyQuery('a1b2c3')).toBe('text');       // 6 chars
    expect(classifyQuery('f'.repeat(41))).toBe('text'); // too long
    expect(classifyQuery('fix login')).toBe('text');
  });
});

describe('nextMatchIndex', () => {
  it('wraps forward past the end', () => {
    expect(nextMatchIndex(3, 2, 1)).toBe(0);
    expect(nextMatchIndex(3, 0, 1)).toBe(1);
  });

  it('wraps backward past the start', () => {
    expect(nextMatchIndex(3, 0, -1)).toBe(2);
    expect(nextMatchIndex(3, 2, -1)).toBe(1);
  });

  it('stays at zero when there is nothing to cycle', () => {
    expect(nextMatchIndex(0, 0, 1)).toBe(0);
  });
});

describe('formatMatchCounter', () => {
  it('shows a one-based position', () => {
    expect(formatMatchCounter(5, 0)).toBe('1/5');
    expect(formatMatchCounter(5, 4)).toBe('5/5');
  });

  it('shows nothing when there are no matches', () => {
    expect(formatMatchCounter(0, 0)).toBe('');
  });
});

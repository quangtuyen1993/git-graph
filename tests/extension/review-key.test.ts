import { describe, expect, it } from 'vitest';
import { buildReviewId, isSafeReviewId, repoIdFor, slugSegment } from '../../src/extension/services/review-key';

describe('slugSegment', () => {
  it('keeps word characters, dots and dashes untouched', () => {
    expect(slugSegment('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
  });

  it('replaces path separators so an id cannot escape its directory', () => {
    expect(slugSegment('anthropic/claude-sonnet-4')).toBe('anthropic-claude-sonnet-4');
    expect(slugSegment('../../etc/passwd')).toBe('etc-passwd');
  });

  it('collapses runs of unsafe characters into a single dash', () => {
    expect(slugSegment('gpt  4o::turbo')).toBe('gpt-4o-turbo');
  });
});

describe('buildReviewId', () => {
  const shas = { sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) };

  it('joins abbreviated shas with the provider and model', () => {
    expect(buildReviewId({ ...shas, provider: 'claude', model: 'sonnet' }))
      .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
  });

  it('falls back to "default" when no model was chosen', () => {
    expect(buildReviewId({ ...shas, provider: 'claude' }))
      .toBe('aaaaaaa..bbbbbbb.claude.default');
    expect(buildReviewId({ ...shas, provider: 'claude', model: '' }))
      .toBe('aaaaaaa..bbbbbbb.claude.default');
  });

  it('sanitises the model so the id is always a safe filename', () => {
    expect(buildReviewId({ ...shas, provider: 'openai', model: 'anthropic/claude' }))
      .toBe('aaaaaaa..bbbbbbb.openai.anthropic-claude');
  });

  it('distinguishes two models reviewing the same commits', () => {
    const a = buildReviewId({ ...shas, provider: 'claude', model: 'sonnet' });
    const b = buildReviewId({ ...shas, provider: 'claude', model: 'opus' });
    expect(a).not.toBe(b);
  });
});

describe('repoIdFor', () => {
  it('is stable for the same path', () => {
    expect(repoIdFor('/repo')).toBe(repoIdFor('/repo'));
  });

  it('differs for different paths', () => {
    expect(repoIdFor('/repo')).not.toBe(repoIdFor('/other'));
  });

  it('is a short filesystem-safe token', () => {
    expect(repoIdFor('/repo/with spaces/and#hash')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('isSafeReviewId', () => {
  it('accepts an id built by buildReviewId', () => {
    expect(isSafeReviewId(buildReviewId({
      sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), provider: 'claude', model: 'anthropic/sonnet-4',
    }))).toBe(true);
  });

  it('refuses anything that could escape the store directory', () => {
    // These become filenames: `remove()` on a traversing id deletes a file
    // outside the store entirely.
    expect(isSafeReviewId('../../../../etc/passwd')).toBe(false);
    expect(isSafeReviewId('..%2f..%2fx')).toBe(false);
    expect(isSafeReviewId('a/b')).toBe(false);
    expect(isSafeReviewId('a\\b')).toBe(false);
    expect(isSafeReviewId('/absolute')).toBe(false);
    expect(isSafeReviewId('')).toBe(false);
    expect(isSafeReviewId(undefined)).toBe(false);
    expect(isSafeReviewId({ toString: () => 'ok' })).toBe(false);
    expect(isSafeReviewId('x'.repeat(201))).toBe(false);
  });
});

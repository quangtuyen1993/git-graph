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
  const shas = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

  it('joins abbreviated shas with the provider and model', () => {
    expect(buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet' }))
      .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
  });

  it('falls back to "default" when no model was chosen', () => {
    expect(buildReviewId({ ...shas, kind: 'branch', provider: 'claude' }))
      .toBe('aaaaaaa..bbbbbbb.claude.default');
    expect(buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: '' }))
      .toBe('aaaaaaa..bbbbbbb.claude.default');
  });

  it('sanitises the model so the id is always a safe filename', () => {
    expect(buildReviewId({ ...shas, kind: 'branch', provider: 'openai', model: 'anthropic/claude' }))
      .toBe('aaaaaaa..bbbbbbb.openai.anthropic-claude');
  });

  it('distinguishes two models reviewing the same commits', () => {
    const a = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet' });
    const b = buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'opus' });
    expect(a).not.toBe(b);
  });

  it('keeps branch, commit and range ids byte-for-byte unchanged — every review stored before this change must still load', () => {
    expect(buildReviewId({ ...shas, kind: 'branch', provider: 'claude', model: 'sonnet' }))
      .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
    expect(buildReviewId({ ...shas, kind: 'commit', provider: 'claude', model: 'sonnet' }))
      .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
    expect(buildReviewId({ ...shas, kind: 'range', provider: 'claude', model: 'sonnet' }))
      .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
  });

  it('distinguishes a pull request review from a "range" review of the same sha pair', () => {
    // Before this, a PR review and a 'range' review of the same pair produced
    // the same id — the entry's kind was whichever ran first, and rerun would
    // rerun it as that kind.
    const range = buildReviewId({ ...shas, kind: 'range', provider: 'claude', model: 'sonnet' });
    const pr = buildReviewId({ ...shas, kind: 'pr', provider: 'claude', model: 'sonnet' });
    expect(pr).not.toBe(range);
    expect(pr).toBe('aaaaaaa..bbbbbbb.pr.claude.sonnet');
  });

  it('distinguishes a worktree review from a "range" review sharing the same shas — the second exception, sibling of "pr"', () => {
    // 'worktree's headSha is a content hash, not a commit sha (the caller
    // computes it from the diff before this id is known — see
    // review-method-handler.ts's review.start). The marker keeps it out of
    // the same namespace as a 'range'/'branch' review that happens to land on
    // the same seven hex characters, exactly as '.pr' does for 'pr'.
    const range = buildReviewId({ ...shas, kind: 'range', provider: 'claude', model: 'sonnet' });
    const worktree = buildReviewId({ ...shas, kind: 'worktree', provider: 'claude', model: 'sonnet' });
    expect(worktree).not.toBe(range);
    expect(worktree).toBe('aaaaaaa..bbbbbbb.worktree.claude.sonnet');
  });

  it('the working tree — edit a file, review again — produces a different id because headSha (the diff hash) changed', () => {
    // This is the requirement the whole phase turns on: buildReviewId itself
    // has no notion of "the working tree changed", it only ever sees
    // whatever headSha its caller passes. Watch this fail against a headSha
    // that never varies (e.g. always HEAD's own sha) — if it passes with a
    // fixed headSha, the test is wrong, not the code.
    const firstEditHash = 'd'.repeat(64);
    const secondEditHash = 'e'.repeat(64);
    const first = buildReviewId({
      kind: 'worktree', baseSha: shas.baseSha, headSha: firstEditHash, provider: 'claude', model: 'sonnet',
    });
    const second = buildReviewId({
      kind: 'worktree', baseSha: shas.baseSha, headSha: secondEditHash, provider: 'claude', model: 'sonnet',
    });
    expect(first).not.toBe(second);
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
      kind: 'branch', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), provider: 'claude', model: 'anthropic/sonnet-4',
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

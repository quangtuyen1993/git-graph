import { createHash } from 'crypto';
import type { ReviewTargetKind } from './review-store';

/**
 * Reduce one id segment to characters that are safe in a filename. Model names
 * legitimately contain slashes (`anthropic/claude-sonnet-4`), and ids are used
 * directly as filenames, so skipping this writes outside the repo directory.
 */
export function slugSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '');
}

/**
 * Review ids become filenames under the store root, so anything that is not a
 * single path segment of word characters, dots and dashes is refused. Without
 * this an id of `../../../../some/file` makes `remove()` delete an arbitrary
 * `.md` outside the store. Ids built by `buildReviewId` always pass; only ids
 * arriving from outside (a webview message) can fail.
 */
export function isSafeReviewId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && /^[\w.-]+$/.test(id);
}

export function assertSafeReviewId(id: unknown): string {
  if (!isSafeReviewId(id)) throw new Error(`Invalid review id: ${String(id)}`);
  return id;
}

/**
 * `kind` is required so every call site states it deliberately, but it only
 * ever changes the id for two kinds. `'pr'` was the first: a pull-request
 * review and a `'range'` review of the same sha pair must not collide (they
 * used to — the entry's kind was whichever ran first, and rerun would rerun
 * it as that kind), so it gets its own suffix.
 *
 * `'worktree'` is the second, sibling exception. The working tree has no sha
 * of its own — `headSha` here is the content hash of its diff, computed by
 * the caller (review-method-handler.ts's `review.start`) before this id is
 * known, since that is what makes *review → edit a file → review again*
 * produce two different ids instead of silently replaying the first result.
 * A content hash could in principle land on the same seven hex characters as
 * some unrelated commit's sha, so it gets the same kind of suffix `'pr'` has,
 * for the same reason: two different things that happen to share a sha pair
 * must not share an id.
 *
 * `'branch' | 'commit' | 'range'` ids must stay byte-for-byte what they
 * always were, so every review stored before this change still loads under
 * the same id it was written with.
 */
export function buildReviewId(input: {
  kind: ReviewTargetKind;
  baseSha: string;
  headSha: string;
  provider: string;
  model?: string;
}): string {
  const source = input.baseSha.slice(0, 7);
  const target = input.headSha.slice(0, 7);
  const provider = slugSegment(input.provider);
  const model = slugSegment(input.model || 'default') || 'default';
  const kindSegment = input.kind === 'pr' ? '.pr' : input.kind === 'worktree' ? '.worktree' : '';
  return `${source}..${target}${kindSegment}.${provider}.${model}`;
}

/** Stable, filesystem-safe token for a repository, derived from its real path. */
export function repoIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath).digest('hex').slice(0, 12);
}

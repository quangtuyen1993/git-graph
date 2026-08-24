import { createHash } from 'crypto';

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

export function buildReviewId(input: {
  baseSha: string;
  headSha: string;
  provider: string;
  model?: string;
}): string {
  const source = input.baseSha.slice(0, 7);
  const target = input.headSha.slice(0, 7);
  const provider = slugSegment(input.provider);
  const model = slugSegment(input.model || 'default') || 'default';
  return `${source}..${target}.${provider}.${model}`;
}

/** Stable, filesystem-safe token for a repository, derived from its real path. */
export function repoIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath).digest('hex').slice(0, 12);
}

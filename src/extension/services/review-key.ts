import { createHash } from 'crypto';

/**
 * Reduce one id segment to characters that are safe in a filename. Model names
 * legitimately contain slashes (`anthropic/claude-sonnet-4`), and ids are used
 * directly as filenames, so skipping this writes outside the repo directory.
 */
export function slugSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '');
}

export function buildReviewId(input: {
  sourceSha: string;
  targetSha: string;
  provider: string;
  model?: string;
}): string {
  const source = input.sourceSha.slice(0, 7);
  const target = input.targetSha.slice(0, 7);
  const provider = slugSegment(input.provider);
  const model = slugSegment(input.model || 'default') || 'default';
  return `${source}..${target}.${provider}.${model}`;
}

/** Stable, filesystem-safe token for a repository, derived from its real path. */
export function repoIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath).digest('hex').slice(0, 12);
}

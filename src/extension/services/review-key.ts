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
 *
 * `outputLanguage` is the third and newest input, and the ruling on
 * `gitGraphPro.aiReview.outputLanguage`'s cache trap. `review.start` serves a
 * stored review when the target, provider and model match; the language is
 * none of those, so without it here a user who changes the setting and
 * re-runs is handed the old review in the old language and nothing says why.
 * Putting it in the id makes a new language an ordinary cache miss and
 * a return to the old one an ordinary cache hit — each language keeps its own
 * stored review, and none of them is ever retranslated.
 *
 * Absent, empty or whitespace-only adds nothing, which is what keeps every
 * id written before the setting existed byte-for-byte valid.
 */
export function buildReviewId(input: {
  kind: ReviewTargetKind;
  baseSha: string;
  headSha: string;
  provider: string;
  model?: string;
  outputLanguage?: string;
}): string {
  const source = input.baseSha.slice(0, 7);
  const target = input.headSha.slice(0, 7);
  const provider = slugSegment(input.provider);
  const model = slugSegment(input.model || 'default') || 'default';
  const kindSegment = input.kind === 'pr' ? '.pr' : input.kind === 'worktree' ? '.worktree' : '';
  return `${source}..${target}${kindSegment}.${provider}.${model}${languageSegment(input.outputLanguage)}`;
}

/**
 * The language's contribution to an id: nothing, or `.lang-` and eight hex
 * characters.
 *
 * Hashed rather than slugged because the setting is free text and ids are
 * filenames. `slugSegment` is built for provider and model names — ASCII, and
 * already short. Run `Tiếng Việt` through it and you get `Ti-ng-Vi-t`, which
 * throws away exactly the characters that distinguish one language from
 * another and can collide with a different string that slugs the same way; run
 * a pasted paragraph through it and the id blows `isSafeReviewId`'s 200
 * character cap. A hash is fixed-width, always filename-safe, and collides
 * only by accident rather than by design.
 *
 * Normalised case-insensitively and on internal whitespace first, so
 * `Vietnamese`, `vietnamese` and ` Vietnamese ` are one language with one
 * stored review rather than three.
 */
function languageSegment(language: string | undefined): string {
  const normalised = (language ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalised) return '';
  return `.lang-${createHash('sha256').update(normalised).digest('hex').slice(0, 8)}`;
}

/** Stable, filesystem-safe token for a repository, derived from its real path. */
export function repoIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath).digest('hex').slice(0, 12);
}

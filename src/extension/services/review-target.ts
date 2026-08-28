import type { ReviewTargetKind } from './review-store';
import type { PullRequestDetail } from './forge/forge.types';

/** git's well-known empty tree — the base a root commit diffs against. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface ReviewTarget {
  kind: ReviewTargetKind;
  /** Branch name or sha. Empty for kind 'commit', 'pr' and 'worktree' — computed or fetched instead. */
  baseRef: string;
  headRef: string;
  subject?: string;
  /** The pull request's provider-local id. Required for, and only meaningful on, kind 'pr'. */
  prId?: string;
  /** Which forge provider the pull request came from. Optional even for kind 'pr'. */
  providerId?: string;
}

export interface ResolvedTarget {
  kind: ReviewTargetKind;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  subject?: string;
  /** Present only for kind 'pr'. */
  prId?: string;
  prNumber?: number;
  providerId?: string;
  /**
   * Whether both `baseSha` and `headSha` already exist as objects in the
   * local repository. Present only for kind 'pr' — it is what decides the
   * local-vs-forge diff path. `undefined` for every other kind, which never
   * has to ask: their refs are always resolved locally by definition.
   */
  localBothPresent?: boolean;
}

export interface TargetGit {
  revParse(ref: string): Promise<string>;
  getParents(hash: string): Promise<string[]>;
  log(options: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]>;
}

/** The slice of the forge stack a pull request target needs: fetch its detail. */
export interface ForgePrLookup {
  getPullRequest(id: string): Promise<PullRequestDetail>;
}

/**
 * A real existence check for a sha that may never have been fetched. Plain
 * `revParse` is not this — it echoes back any syntactically valid object name
 * whether or not the object exists locally (see `GitService.searchCommits`'s
 * comment on the same trap), which is exactly wrong for a pull request whose
 * branch may never have been fetched.
 */
export interface PrExistenceGit {
  commitExists(sha: string): Promise<boolean>;
}

async function revParseNamed(git: TargetGit, ref: string): Promise<string> {
  try {
    return await git.revParse(ref);
  } catch {
    // The original git error names neither the ref nor the operation the user
    // attempted; the row this surfaces on must say which ref went stale.
    throw new Error(`Cannot resolve "${ref}" — it may have been deleted or garbage-collected`);
  }
}

/**
 * Turns a user-facing target into the sha pair a review runs on. For a commit
 * the base is derived, never supplied: first parent, or the empty tree for a
 * root commit. A merge commit reviews against its first parent — the change it
 * brought into the mainline — and says so in the subject.
 *
 * For a `'worktree'` target the base is derived too — always `HEAD` — but
 * there is no head *commit* at all: the head is whatever is on disk right
 * now, so it is never rev-parsed. `headSha` comes back empty here; the real
 * identity of a worktree review is the content hash of its diff, computed by
 * the caller once the diff is known (`buildReviewId`'s comment explains why).
 */
export async function resolveReviewTarget(git: TargetGit, target: ReviewTarget): Promise<ResolvedTarget> {
  if (target.kind === 'worktree') {
    const baseSha = await revParseNamed(git, 'HEAD');
    return {
      kind: 'worktree',
      baseRef: 'HEAD', baseSha,
      headRef: 'Working Tree', headSha: '',
    };
  }

  const headSha = await revParseNamed(git, target.headRef);

  if (target.kind === 'commit') {
    const parents = await git.getParents(headSha);
    const baseSha = parents[0] ?? EMPTY_TREE_SHA;
    let subject = target.subject
      ?? (await git.log({ revisions: [headSha], maxCount: 1 }).catch(() => []))[0]?.subject;
    if (subject && parents.length > 1 && !subject.endsWith('(merge)')) subject = `${subject} (merge)`;
    return {
      kind: 'commit', baseRef: baseSha, baseSha, headRef: headSha, headSha,
      ...(subject ? { subject } : {}),
    };
  }

  const baseSha = await revParseNamed(git, target.baseRef);
  return {
    kind: target.kind, baseRef: target.baseRef, baseSha,
    headRef: target.headRef, headSha,
    ...(target.subject ? { subject: target.subject } : {}),
  };
}

/**
 * Resolves a pull request into the sha pair a review runs on — never through
 * `revParse`. A pull request's branch frequently has never been fetched, so
 * the pair comes straight from `PullRequestDetail.sourceCommit` /
 * `targetCommit`, and locality is established with a real existence check
 * (`PrExistenceGit.commitExists`), not a resolve-and-hope.
 *
 * The pull request's title stands in for `subject` — the same field a commit
 * review's subject rides on — so it flows through the existing `subject`
 * plumbing in `review-method-handler.ts` and `ReviewRunner` without a second,
 * parallel "title" field.
 */
export async function resolvePullRequestTarget(
  git: PrExistenceGit,
  forge: ForgePrLookup,
  prId: string,
): Promise<ResolvedTarget> {
  const detail = await forge.getPullRequest(prId);

  const [baseLocal, headLocal] = await Promise.all([
    git.commitExists(detail.targetCommit),
    git.commitExists(detail.sourceCommit),
  ]);

  return {
    kind: 'pr',
    baseRef: detail.targetBranch, baseSha: detail.targetCommit,
    headRef: detail.sourceBranch, headSha: detail.sourceCommit,
    subject: detail.title,
    prId,
    prNumber: detail.number,
    localBothPresent: baseLocal && headLocal,
  };
}

/** The slice of vscode.Memento this state needs — injectable for tests. */
export interface TargetStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/**
 * Every valid `ReviewTargetKind`. Exported so the two other places that must
 * agree with it — `review-method-handler.ts`'s params parser and its
 * `review.saveTarget` case — import this instead of restating the literal
 * list, which is how a new kind silently stops being rejected in one of them
 * and starts being rejected in another.
 */
export const REVIEW_TARGET_KINDS: ReadonlySet<string> = new Set(['branch', 'commit', 'range', 'pr', 'worktree']);

function isReviewTarget(value: unknown): value is ReviewTarget {
  const t = value as ReviewTarget | null;
  return !!t
    && typeof t === 'object'
    && REVIEW_TARGET_KINDS.has(t.kind as string)
    && typeof t.baseRef === 'string'
    && typeof t.headRef === 'string';
}

/**
 * The compare pair currently on the pickers. Host-owned, memory-first, and —
 * when storage is provided — persisted per repo so a window reload reopens on
 * the pair the user was comparing. A storage write failure only costs the
 * next session its default; it must never break the current one.
 */
export class ReviewTargetState {
  private readonly targets = new Map<string, ReviewTarget>();

  constructor(private readonly storage?: TargetStorage) {}

  public set(repoId: string, target: ReviewTarget): void {
    this.targets.set(repoId, target);
    void Promise.resolve(this.storage?.update(this.storageKey(repoId), target)).catch(() => {});
  }

  public get(repoId: string): ReviewTarget | null {
    const inMemory = this.targets.get(repoId);
    if (inMemory) return inMemory;

    const stored = this.storage?.get(this.storageKey(repoId));
    if (!isReviewTarget(stored)) return null;
    this.targets.set(repoId, stored);
    return stored;
  }

  private storageKey(repoId: string): string {
    return `review.target.${repoId}`;
  }
}

import type { ReviewTargetKind } from './review-store';

/** git's well-known empty tree — the base a root commit diffs against. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface ReviewTarget {
  kind: ReviewTargetKind;
  /** Branch name or sha. Empty for kind 'commit' — the base is computed. */
  baseRef: string;
  headRef: string;
  subject?: string;
}

export interface ResolvedTarget {
  kind: ReviewTargetKind;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  subject?: string;
}

export interface TargetGit {
  revParse(ref: string): Promise<string>;
  getParents(hash: string): Promise<string[]>;
  log(options: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]>;
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
 */
export async function resolveReviewTarget(git: TargetGit, target: ReviewTarget): Promise<ResolvedTarget> {
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
 * The compare pair currently on the pickers. Host-owned and in-memory: a
 * webview rebuilt by hide/show asks for it back; a new window starts fresh by
 * design.
 */
export class ReviewTargetState {
  private readonly targets = new Map<string, ReviewTarget>();

  public set(repoId: string, target: ReviewTarget): void {
    this.targets.set(repoId, target);
  }

  public get(repoId: string): ReviewTarget | null {
    return this.targets.get(repoId) ?? null;
  }
}

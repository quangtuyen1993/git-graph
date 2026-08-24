import { assertSafeReviewId, buildReviewId } from '../services/review-key';
import { buildReviewPayload } from '../services/review-payload';
import type { ReviewRunner } from '../services/review-runner';
import type { ReviewStore } from '../services/review-store';

interface GitLike {
  revParse(ref: string): Promise<string>;
  getDiff(source: string, target: string): Promise<string>;
  diff(source: string, target: string): Promise<{ files: unknown[] }>;
  log(options: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]>;
}

export interface ReviewHandlerDeps {
  store: ReviewStore;
  runner: ReviewRunner;
  getGitService: () => GitLike | undefined;
  getRepoId: () => string | undefined;
  getMaxDiffChars: () => number;
  openBody: (repoId: string, id: string) => Promise<void>;
}

export function createReviewHandler(deps: ReviewHandlerDeps) {
  return async function handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const repoId = deps.getRepoId();
    if (!repoId) throw new Error('No git repository found');

    switch (method) {
      case 'review.list':
        return deps.store.list(repoId);

      // Every id below arrives in a message and ends up as a filename, so it is
      // validated at the boundary rather than trusted because today's only
      // sender happens to be our own bundled webview.
      case 'review.get':
        return (await deps.store.get(repoId, assertSafeReviewId(p.id))) ?? null;

      case 'review.cancel':
        return { cancelled: deps.runner.cancel(repoId, assertSafeReviewId(p.id)) };

      case 'review.delete':
        await deps.store.remove(repoId, assertSafeReviewId(p.id));
        return { success: true };

      case 'review.open':
        await deps.openBody(repoId, assertSafeReviewId(p.id));
        return { success: true };

      case 'review.start': {
        const git = deps.getGitService();
        if (!git) throw new Error('No git repository found');

        const sourceBranch = p.sourceBranch as string;
        const targetBranch = p.targetBranch as string;
        const provider = p.provider as string;
        const model = (p.model as string) || '';

        const [sourceSha, targetSha] = await Promise.all([
          git.revParse(sourceBranch),
          git.revParse(targetBranch),
        ]);

        // Same commits, same model: serve the stored answer. A completed review
        // is reusable as-is; a review still running is reusable too, but only
        // by pointing the caller at the same id — recomputing the diff and
        // rebuilding the payload here would be wasted work that ReviewRunner
        // would just deduplicate again. Only a finished, successful entry may
        // be opened; a failure or a cancellation must be retried, not served.
        const id = buildReviewId({ sourceSha, targetSha, provider, model });
        const existing = await deps.store.get(repoId, id);
        if (existing?.status === 'done') {
          await deps.openBody(repoId, id);
          return { id, cached: true };
        }
        if (existing?.status === 'running') {
          return { id, cached: false };
        }

        const diff = await git.getDiff(sourceBranch, targetBranch);
        if (!diff.trim()) {
          throw new Error(`No differences between ${sourceBranch} and ${targetBranch}`);
        }

        const [changed, commits] = await Promise.all([
          git.diff(sourceBranch, targetBranch).then(d => d.files).catch(() => undefined),
          git.log({ revisions: [`${sourceBranch}..${targetBranch}`], maxCount: 100 })
            .then(cs => cs.map(c => c.subject))
            .catch(() => undefined),
        ]);

        const payload = buildReviewPayload({
          baseBranch: sourceBranch,
          headBranch: targetBranch,
          diff,
          files: changed as never,
          commits,
          budget: deps.getMaxDiffChars(),
        });

        const startedId = await deps.runner.start({
          repoId,
          sourceBranch, sourceSha,
          targetBranch, targetSha,
          provider, model,
          payloadText: payload.text,
        });
        return { id: startedId, cached: false };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  };
}

import { assertSafeReviewId, buildReviewId } from '../services/review-key';
import { buildReviewPayload } from '../services/review-payload';
import type { ReviewRunner } from '../services/review-runner';
import type { ReviewStore } from '../services/review-store';
import { resolveReviewTarget } from '../services/review-target';
import type { ReviewTarget, ReviewTargetState } from '../services/review-target';
import type { ReviewTargetKind } from '../services/review-store';

interface GitLike {
  revParse(ref: string): Promise<string>;
  getDiff(source: string, target: string): Promise<string>;
  diff(source: string, target: string): Promise<{ files: unknown[] }>;
  log(options: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]>;
  getParents(hash: string): Promise<string[]>;
}

export interface ReviewHandlerDeps {
  store: ReviewStore;
  runner: ReviewRunner;
  getGitService: () => GitLike | undefined;
  getRepoId: () => string | undefined;
  getMaxDiffChars: () => number;
  openBody: (repoId: string, id: string) => Promise<void>;
  targets: ReviewTargetState;
  focusReviewView: () => Promise<void>;
  broadcast: (event: string, data?: unknown) => void;
}

export function createReviewHandler(deps: ReviewHandlerDeps) {
  function targetFromParams(p: Record<string, unknown>): ReviewTarget {
    const kind = (p.kind as ReviewTargetKind) ?? 'branch';
    const baseRef = (p.baseRef as string) ?? '';
    const headRef = p.headRef as string;
    if (typeof headRef !== 'string' || !headRef) throw new Error('Missing head ref');
    if (kind !== 'commit' && !baseRef) throw new Error('Missing base ref');
    return { kind, baseRef, headRef };
  }

  async function handle(method: string, params: unknown): Promise<unknown> {
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
        const provider = p.provider as string;
        const model = (p.model as string) || '';

        const resolved = await resolveReviewTarget(git, targetFromParams(p));

        // Same commits, same model: serve the stored answer. A completed review
        // is reusable as-is; a review still running is reusable too, but only
        // by pointing the caller at the same id — recomputing the diff and
        // rebuilding the payload here would be wasted work that ReviewRunner
        // would just deduplicate again. Only a finished, successful entry may
        // be opened; a failure or a cancellation must be retried, not served.
        const id = buildReviewId({ baseSha: resolved.baseSha, headSha: resolved.headSha, provider, model });
        const existing = await deps.store.get(repoId, id);
        if (existing?.status === 'done') {
          await deps.openBody(repoId, id);
          return { id, cached: true };
        }
        // Only if the runner really is working on it. A `running` row whose run
        // died with the previous window (or was never reconciled) would
        // otherwise be handed back forever: the row spins, the 1 Hz tree ticker
        // never stops, and the user cannot restart that review at all.
        if (existing?.status === 'running' && deps.runner.isRunning(id)) {
          return { id, cached: false };
        }

        const diff = await git.getDiff(resolved.baseRef, resolved.headRef);
        if (!diff.trim()) {
          throw new Error(`No differences between ${resolved.baseRef} and ${resolved.headRef}`);
        }

        const [changed, commits] = await Promise.all([
          git.diff(resolved.baseRef, resolved.headRef).then(d => d.files).catch(() => undefined),
          resolved.kind === 'commit'
            ? Promise.resolve(resolved.subject ? [resolved.subject] : undefined)
            : git.log({ revisions: [`${resolved.baseRef}..${resolved.headRef}`], maxCount: 100 })
                .then(cs => cs.map(c => c.subject))
                .catch(() => undefined),
        ]);

        const payload = buildReviewPayload({
          baseBranch: resolved.baseRef,
          headBranch: resolved.headRef,
          diff,
          files: changed as never,
          commits,
          budget: deps.getMaxDiffChars(),
        });

        const startedId = await deps.runner.start({
          repoId,
          kind: resolved.kind,
          baseRef: resolved.baseRef, baseSha: resolved.baseSha,
          headRef: resolved.headRef, headSha: resolved.headSha,
          ...(resolved.subject ? { subject: resolved.subject } : {}),
          provider, model,
          payloadText: payload.text,
        });
        return { id: startedId, cached: false };
      }

      case 'review.setTarget': {
        const git = deps.getGitService();
        if (!git) throw new Error('No git repository found');
        const resolved = await resolveReviewTarget(git, targetFromParams(p));
        const stored: ReviewTarget = {
          kind: resolved.kind,
          baseRef: resolved.baseRef,
          headRef: resolved.headRef,
          ...(resolved.subject ? { subject: resolved.subject } : {}),
        };
        deps.targets.set(repoId, stored);
        await deps.focusReviewView();
        deps.broadcast('review.target', stored);
        return { success: true };
      }

      case 'review.getTarget':
        return deps.targets.get(repoId);

      case 'review.rerun': {
        const id = assertSafeReviewId(p.id);
        const entry = await deps.store.get(repoId, id);
        if (!entry) throw new Error(`No review with id ${id}`);
        await deps.store.remove(repoId, id);
        return handle('review.start', {
          kind: entry.kind,
          // kind 'commit' tự tính lại base; kind khác dùng ref đã lưu
          ...(entry.kind === 'commit' ? {} : { baseRef: entry.baseRef }),
          headRef: entry.headRef,
          provider: entry.provider,
          model: entry.model === 'default' ? '' : entry.model,
        });
      }

      case 'review.compare': {
        const git = deps.getGitService();
        if (!git) throw new Error('No git repository found');
        const resolved = await resolveReviewTarget(git, targetFromParams(p));
        const result = await git.diff(resolved.baseRef, resolved.headRef);
        return { files: result.files };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  return handle;
}

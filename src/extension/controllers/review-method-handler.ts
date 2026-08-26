import { assertSafeReviewId, buildReviewId } from '../services/review-key';
import { buildReviewPayload } from '../services/review-payload';
import type { PriorDiscussionEntry } from '../services/review-payload';
import type { ReviewRunner } from '../services/review-runner';
import type { ReviewStore } from '../services/review-store';
import { REVIEW_TARGET_KINDS, resolvePullRequestTarget, resolveReviewTarget } from '../services/review-target';
import type { ReviewTarget, ReviewTargetState } from '../services/review-target';
import type { ReviewTargetKind } from '../services/review-store';
// forge.types.ts is the shared contract, not a provider — importing it here
// does not violate "no forge/bitbucket/ vocabulary above the forge layer".
import type { ForgeComment, PullRequestDetail, PullRequestFile } from '../services/forge/forge.types';

interface GitLike {
  revParse(ref: string): Promise<string>;
  getDiff(source: string, target: string): Promise<string>;
  diff(source: string, target: string): Promise<{ files: unknown[] }>;
  log(options: { revisions?: string[]; maxCount: number }): Promise<{ hash: string; abbreviatedHash: string; subject: string; authorDate: string }[]>;
  getParents(hash: string): Promise<string[]>;
  commitExists(sha: string): Promise<boolean>;
}

/**
 * The narrow slice of the forge stack a `'pr'` review needs — closures over
 * the already-resolved provider, cache and repository, injected from
 * extension.ts the same way `getRemoteUrl` reaches the forge handler today.
 * Never a direct dependency on anything under `forge/bitbucket/`: these
 * closures are expected to be built on top of the same translated
 * `forgeHandler`, so a forge failure reaching `review.start` is already the
 * translated message, not a raw `ForgeError`.
 */
export interface ReviewForgeDeps {
  getPullRequest(id: string): Promise<PullRequestDetail>;
  /** The full pull request diff — sha-keyed and immutably cached upstream. */
  getDiff(id: string): Promise<string>;
  /** Diffstat-derived file list — cheap even for a huge pull request. */
  getFiles(id: string): Promise<PullRequestFile[]>;
  getComments(id: string): Promise<ForgeComment[]>;
  /** The id of whichever forge provider currently serves this repository. */
  getProviderId(): Promise<string | undefined>;
}

export interface ReviewHandlerDeps {
  store: ReviewStore;
  runner: ReviewRunner;
  getGitService: () => GitLike | undefined;
  getRepoId: () => string | undefined;
  getRepos: () => Array<{ path: string; name: string; active: boolean }>;
  getMaxDiffChars: () => number;
  openBody: (repoId: string, id: string) => Promise<void>;
  targets: ReviewTargetState;
  focusReviewView: () => Promise<void>;
  broadcast: (event: string, data?: unknown) => void;
  forge: ReviewForgeDeps;
}

function toPriorDiscussion(comments: ForgeComment[]): PriorDiscussionEntry[] {
  return comments.map((c) => ({
    author: c.author.displayName,
    body: c.body,
    ...(c.path ? { path: c.path } : {}),
    ...(typeof c.line === 'number' ? { line: c.line } : {}),
    ...(c.side ? { side: c.side } : {}),
  }));
}

export function createReviewHandler(deps: ReviewHandlerDeps) {
  function targetFromParams(p: Record<string, unknown>): ReviewTarget {
    const kind = (p.kind as ReviewTargetKind) ?? 'branch';
    if (!REVIEW_TARGET_KINDS.has(kind)) throw new Error(`Unknown review kind: ${String(kind)}`);

    if (kind === 'pr') {
      const prId = p.prId as string;
      if (typeof prId !== 'string' || !prId) throw new Error('Missing pull request id');
      const providerId = typeof p.providerId === 'string' && p.providerId ? p.providerId : undefined;
      return { kind, baseRef: '', headRef: '', prId, ...(providerId ? { providerId } : {}) };
    }

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
        const target = targetFromParams(p);

        // A pull request's sha pair comes from PullRequestDetail, never from
        // revParse — its branch frequently has never been fetched. Every
        // other kind resolves exactly as it always has.
        const resolved = target.kind === 'pr'
          ? await resolvePullRequestTarget(git, deps.forge, target.prId as string)
          : await resolveReviewTarget(git, target);

        // Same commits, same model, same kind: serve the stored answer. A
        // completed review is reusable as-is; a review still running is
        // reusable too, but only by pointing the caller at the same id —
        // recomputing the diff and rebuilding the payload here would be
        // wasted work that ReviewRunner would just deduplicate again. Only a
        // finished, successful entry may be opened; a failure or a
        // cancellation must be retried, not served.
        const id = buildReviewId({ kind: resolved.kind, baseSha: resolved.baseSha, headSha: resolved.headSha, provider, model });
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

        let diff: string;
        let changed: unknown;
        let commits: string[] | undefined;
        let priorDiscussion: PriorDiscussionEntry[] | undefined;
        let providerId: string | undefined;

        if (resolved.kind === 'pr') {
          const prId = resolved.prId as string;

          // Local-first: when both shas are genuinely present locally, the
          // local `...` diff already matches how a host builds a pull
          // request diff. Otherwise fall back to the forge diff, which is
          // sha-keyed and immutably cached.
          diff = resolved.localBothPresent
            ? await git.getDiff(resolved.baseSha, resolved.headSha)
            : await deps.forge.getDiff(prId);

          if (!diff.trim()) {
            throw new Error(`No differences between ${resolved.baseRef} and ${resolved.headRef}`);
          }

          const [files, comments, commitSubjects, resolvedProviderId] = await Promise.all([
            deps.forge.getFiles(prId),
            deps.forge.getComments(prId),
            // Commit subjects have no forge interface support — omit them on
            // the API path rather than widen the interface for garnish.
            resolved.localBothPresent
              ? git.log({ revisions: [`${resolved.baseSha}..${resolved.headSha}`], maxCount: 100 })
                  .then(cs => cs.map(c => c.subject))
                  .catch(() => undefined)
              : Promise.resolve(undefined),
            deps.forge.getProviderId(),
          ]);
          changed = files;
          commits = commitSubjects;
          priorDiscussion = toPriorDiscussion(comments);
          providerId = resolvedProviderId;
        } else {
          diff = await git.getDiff(resolved.baseRef, resolved.headRef);
          if (!diff.trim()) {
            throw new Error(`No differences between ${resolved.baseRef} and ${resolved.headRef}`);
          }

          const [files, commitSubjects] = await Promise.all([
            git.diff(resolved.baseRef, resolved.headRef).then(d => d.files).catch(() => undefined),
            resolved.kind === 'commit'
              ? Promise.resolve(resolved.subject ? [resolved.subject] : undefined)
              : git.log({ revisions: [`${resolved.baseRef}..${resolved.headRef}`], maxCount: 100 })
                  .then(cs => cs.map(c => c.subject))
                  .catch(() => undefined),
          ]);
          changed = files;
          commits = commitSubjects;
        }

        const payload = buildReviewPayload({
          baseBranch: resolved.baseRef,
          headBranch: resolved.headRef,
          diff,
          files: changed as never,
          commits,
          priorDiscussion,
          budget: deps.getMaxDiffChars(),
        });

        const startedId = await deps.runner.start({
          repoId,
          kind: resolved.kind,
          baseRef: resolved.baseRef, baseSha: resolved.baseSha,
          headRef: resolved.headRef, headSha: resolved.headSha,
          ...(resolved.subject ? { subject: resolved.subject } : {}),
          ...(resolved.prId ? { prId: resolved.prId } : {}),
          ...(resolved.prNumber !== undefined ? { prNumber: resolved.prNumber } : {}),
          ...(providerId ? { providerId } : {}),
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

      // The pickers save every change so a window reload reopens on the same
      // pair. Unlike setTarget this neither resolves refs (the branch may be
      // half-typed state), nor focuses the view, nor broadcasts — it is a
      // write-behind, not a navigation.
      case 'review.saveTarget': {
        const kind = p.kind as ReviewTargetKind;
        if (!REVIEW_TARGET_KINDS.has(kind)) {
          throw new Error('Invalid review target');
        }

        if (kind === 'pr') {
          const prId = p.prId as string;
          if (typeof prId !== 'string' || !prId) throw new Error('Invalid review target');
          const headRef = typeof p.headRef === 'string' ? p.headRef : '';
          deps.targets.set(repoId, {
            kind, baseRef: '', headRef, prId,
            ...(typeof p.subject === 'string' && p.subject ? { subject: p.subject } : {}),
          });
          return { success: true };
        }

        const baseRef = (p.baseRef as string) ?? '';
        const headRef = p.headRef as string;
        if (typeof headRef !== 'string' || !headRef) {
          throw new Error('Invalid review target');
        }
        deps.targets.set(repoId, {
          kind, baseRef, headRef,
          ...(typeof p.subject === 'string' && p.subject ? { subject: p.subject } : {}),
        });
        return { success: true };
      }

      case 'review.getTarget':
        return deps.targets.get(repoId);

      case 'review.rerun': {
        const id = assertSafeReviewId(p.id);
        const entry = await deps.store.get(repoId, id);
        if (!entry) throw new Error(`No review with id ${id}`);
        await deps.store.remove(repoId, id);

        // A pull request re-resolves through its stored id, not its stored
        // sha pair — a rerun reviews the pull request as it is now, picking
        // up any commit pushed since the first run.
        if (entry.kind === 'pr') {
          if (!entry.prId) throw new Error(`Pull request review ${id} is missing its pull request id`);
          return handle('review.start', {
            kind: 'pr',
            prId: entry.prId,
            ...(entry.providerId ? { providerId: entry.providerId } : {}),
            provider: entry.provider,
            model: entry.model === 'default' ? '' : entry.model,
          });
        }

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

      case 'review.getRepos':
        return deps.getRepos();

      case 'review.getCommits': {
        const git = deps.getGitService();
        if (!git) throw new Error('No git repository found');
        const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : 100;
        const commits = await git.log({ maxCount: limit });
        return commits.map(c => ({
          hash: c.hash,
          abbreviatedHash: c.abbreviatedHash,
          subject: c.subject,
          authorDate: c.authorDate,
        }));
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  return handle;
}

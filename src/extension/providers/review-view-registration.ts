import type { ReviewEntry, ReviewStore } from '../services/review-store';
import type { ReviewRunner } from '../services/review-runner';
import type { ReviewTreeProvider } from './review-tree-provider';

export interface ReviewViewDeps {
  tree: ReviewTreeProvider;
  runner: Pick<ReviewRunner, 'cancel'>;
  store: Pick<ReviewStore, 'remove'>;
  getRepoId: () => string | undefined;
  openBody: (repoId: string, id: string) => Promise<void>;
  rerun: (entry: ReviewEntry) => Promise<void>;
  registerCommand: (id: string, fn: (...args: never[]) => unknown) => { dispose(): void };
  registerTreeView: (id: string, tree: ReviewTreeProvider) => { dispose(): void };
  subscribe: (disposable: { dispose(): void }) => void;
}

/**
 * Split out of extension.ts so the command wiring is testable without a real
 * vscode module — the registration functions arrive as plain callbacks.
 */
export function registerReviewView(deps: ReviewViewDeps): void {
  deps.subscribe(deps.registerTreeView('gitGraphPro.reviews', deps.tree));

  const withRepo = (fn: (repoId: string, entry: ReviewEntry) => Promise<void> | void) =>
    async (entry: ReviewEntry) => {
      let repoId: string | undefined;
      try {
        // getRepoId() resolves the real filesystem path (realpathSync) under
        // the hood — a repo deleted, renamed or unmounted while its row is
        // still on screen makes this throw. A row command must be a no-op in
        // that case, not an unhandled rejection on a routine click.
        repoId = deps.getRepoId();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[review-view] Failed to resolve active repository: ${message}`);
        return;
      }
      if (!repoId) return;
      await fn(repoId, entry);
      deps.tree.refresh();
    };

  deps.subscribe(deps.registerCommand('gitGraphPro.review.cancel',
    withRepo((repoId, entry) => { deps.runner.cancel(repoId, entry.id); }) as never));

  deps.subscribe(deps.registerCommand('gitGraphPro.review.delete',
    withRepo(async (repoId, entry) => { await deps.store.remove(repoId, entry.id); }) as never));

  deps.subscribe(deps.registerCommand('gitGraphPro.review.open',
    withRepo(async (repoId, entry) => { await deps.openBody(repoId, entry.id); }) as never));

  deps.subscribe(deps.registerCommand('gitGraphPro.review.rerun',
    withRepo(async (_repoId, entry) => { await deps.rerun(entry); }) as never));
}

import { realpathSync } from 'fs';
import { repoIdFor } from './review-key';

/** The slice of RepositorySession the review side needs. */
export interface SessionLike<Git> {
  getActiveRepositoryPath(): string | undefined;
  getGitService(): Git | null;
}

export interface ActiveRepoDeps<Git> {
  /** The live webview session, when there is one. */
  getSession: () => SessionLike<Git> | undefined;
  /** The workspace's first repository, known at activation. */
  initialPath?: string;
  createGitService: (path: string) => Git;
  realpath?: (path: string) => string;
}

export interface ActiveRepo<Git> {
  getPath(): string | undefined;
  getRepoId(): string | undefined;
  getGitService(): Git | undefined;
}

/**
 * Repository identity for consumers that have no webview to ask: the reviews
 * tree view, the tree's clock, and the rerun command.
 *
 * Resolving this from the live graph session alone made the whole review view
 * hostage to that webview — before the graph is resolved, or after it is
 * disposed, there was no repo id, so the view listed nothing despite reviews
 * being on disk and every row command silently no-opped. The active session
 * still wins when there is one (it knows about repo switches and submodules);
 * otherwise the last repo it reported, falling back to the workspace's first
 * repository, stands in.
 *
 * getRepoId() calls realpathSync and can therefore throw if the repository has
 * been deleted or unmounted. Callers guard it; it is deliberately not swallowed
 * here, because "repo is gone" and "no repo configured" are different states.
 */
export function createActiveRepo<Git>(deps: ActiveRepoDeps<Git>): ActiveRepo<Git> {
  const realpath = deps.realpath ?? realpathSync;
  let lastKnownPath = deps.initialPath;
  let fallbackGit: { path: string; service: Git } | undefined;

  const getPath = (): string | undefined => {
    const active = deps.getSession()?.getActiveRepositoryPath();
    if (active) lastKnownPath = active;
    return active ?? lastKnownPath;
  };

  return {
    getPath,

    getRepoId(): string | undefined {
      const path = getPath();
      return path ? repoIdFor(realpath(path)) : undefined;
    },

    /**
     * The session's git service when a webview is attached, otherwise one built
     * for the same path — so a review can be started (or re-run) from the tree
     * view with no webview in sight. Cached, and rebuilt when the path changes.
     */
    getGitService(): Git | undefined {
      // getPath() first, so the last-known path keeps tracking the session even
      // on the branch that returns the session's own service.
      const path = getPath();
      const live = deps.getSession()?.getGitService();
      if (live) return live;
      if (!path) return undefined;
      if (fallbackGit?.path !== path) {
        fallbackGit = { path, service: deps.createGitService(path) };
      }
      return fallbackGit.service;
    },
  };
}

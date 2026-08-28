import type { GitService } from '../services/git.service';
import { loadAllCommits } from '../services/graph-loader';
import { GraphService } from '../services/graph.service';
import type { ShortStat } from '../types/git.types';
import type { GraphOptions } from '../types/graph.types';

type GraphGitService = Pick<
  GitService,
  'getRepoPath' | 'snapshotLogOptions' | 'log' | 'shortStatsFor'
>;

export class GraphMethodHandler {
  private buildGeneration = 0;
  private nextLayoutVersion = 0;

  // A commit's shortstat is immutable — the hash pins the tree, so the diff
  // against its parent cannot change. The only thing that invalidates an entry
  // is the hash meaning something else, i.e. a different repository; hence the
  // identity fields below rather than layout-version invalidation.
  // `null` is a real cached answer: "git listed nothing for this hash at all",
  // which `parseShortStats` reports by leaving it out of the map. (A merge is
  // not this case: git lists it, prints no stat line, and it maps to {0,0,0}.)
  // Without the negative entry such a hash would be re-requested on every
  // window, forever.
  private readonly statsCache = new Map<string, ShortStat | null>();
  private statsCacheGitService: GraphGitService | null = null;
  private statsCacheRepoPath: string | null = null;

  constructor(
    private readonly graphService: GraphService,
    private readonly getGitService: () => GraphGitService | null,
  ) {}

  public invalidate(): void {
    this.buildGeneration += 1;
    this.graphService.invalidateLayout(++this.nextLayoutVersion);
  }

  public async handle(method: string, params: unknown): Promise<unknown> {
    const gitService = this.getGitService();
    if (!gitService) {
      throw new Error('No git repository found in workspace');
    }
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'graph.build':
        return this.build(gitService, p as GraphOptions);
      case 'graph.getWindow': {
        if (typeof p.layoutVersion !== 'number') {
          throw new Error('graph.getWindow layoutVersion is required');
        }
        const startRow = (p.startRow as number) ?? 0;
        const count = (p.count as number) ?? 50;
        return this.graphService.getWindow(startRow, count, p.layoutVersion);
      }
      case 'graph.getRow': {
        if (typeof p.layoutVersion !== 'number') {
          throw new Error('graph.getRow layoutVersion is required');
        }
        if (typeof p.hash !== 'string') {
          throw new Error('graph.getRow hash is required');
        }
        return {
          row: this.graphService.getRow(p.hash, p.layoutVersion),
        };
      }
      case 'graph.getStats': {
        if (!Array.isArray(p.hashes) || p.hashes.some((hash) => typeof hash !== 'string')) {
          throw new Error('graph.getStats hashes is required');
        }
        return this.getStats(gitService, p.hashes as string[]);
      }
      case 'graph.getLayout':
        return {
          totalRows: this.graphService.getTotalRows(),
          maxLane: this.graphService.getMaxLane(),
          layoutVersion: this.graphService.getLayoutVersion(),
        };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async build(gitService: GraphGitService, options: GraphOptions): Promise<unknown> {
    const generation = ++this.buildGeneration;
    const repoPath = gitService.getRepoPath();
    const logOptions = {
      branch: options.branch,
      branches: options.branches,
      all: options.all ?? true,
    };
    const commits = await loadAllCommits(gitService, logOptions);
    this.assertCurrent(generation, gitService, repoPath);

    const layout = this.graphService.createLayout(commits);

    this.assertCurrent(generation, gitService, repoPath);
    const layoutVersion = ++this.nextLayoutVersion;
    this.graphService.publishLayout(layout, layoutVersion);
    return {
      totalRows: layout.totalRows,
      maxLane: layout.maxLane,
      layoutVersion,
    };
  }

  /**
   * Shortstats for the given hashes, hash-addressed and cached.
   *
   * A value is a `ShortStat` or `null`, and the two mean different things:
   *
   * - **`ShortStat`** — git answered. `filesChanged: 0` is a real answer: git
   *   listed the commit and reported nothing changed, which is an empty commit
   *   or a merge (`--no-walk` prints no stat line for a merge whether or not it
   *   touched anything). A caller that must not treat a merge as empty excludes
   *   it by its parent count, never by these numbers.
   * - **`null`** — git answered the batch and listed nothing for this hash.
   *   Callers render it as "unknown" and must not read it as "nothing changed".
   *   It is a settled answer and is cached as one.
   * - **absent from the record** — no answer yet, because the fetch covering
   *   that hash failed. The distinction from `null` is the whole point of the
   *   record's shape: the host leaves a failed hash out of its cache so a later
   *   call retries, and a caller that cannot see which hashes those were caches
   *   the failure itself and puts that retry out of reach.
   *
   * Failure is silent by contract: stats are decoration and the graph is the
   * feature, so a rejected git call omits the hashes it covered rather than
   * surfacing an error. Omission, not `null`, because one unresolvable revision
   * makes git reject the whole batch (`fatal: bad object`, exit 128), so a
   * single pruned hash in a window fails every hash beside it — answering
   * `null` there would turn one transient failure into a screen of commits
   * permanently "known to have no stats".
   *
   * `shortStatsFor`'s preconditions are inherited and matter more here, because
   * the cache makes a violation permanent rather than merely repeated:
   *
   * - Hashes must be full and lowercase — the layout's `%H`, which is what the
   *   webview sends back. An abbreviation git resolves fine still comes back
   *   under a key nobody asked for, so it caches as `null` — "git gave no
   *   answer" — for the rest of the session, for a commit git answered in full.
   * - A call should cover a window's worth of hashes (tens), not a whole
   *   repository: they all go onto one `git log` argv, which stops being
   *   spawnable somewhere near 780 hashes on Windows.
   */
  private async getStats(
    gitService: GraphGitService,
    hashes: string[],
  ): Promise<Record<string, ShortStat | null>> {
    const repoPath = gitService.getRepoPath();
    this.syncStatsCacheIdentity(gitService, repoPath);

    const missing = [...new Set(hashes.filter((hash) => !this.statsCache.has(hash)))];
    if (missing.length > 0) {
      try {
        const fetched = await gitService.shortStatsFor(missing);
        // A repository switch during the await would make these answers belong
        // to a repository the cache no longer represents.
        if (this.statsCacheGitService === gitService && this.statsCacheRepoPath === repoPath) {
          // Cache every hash that was asked for, not every hash git answered
          // for: only a negative entry stops a hash git never lists being
          // re-requested for the rest of the session.
          for (const hash of missing) {
            this.statsCache.set(hash, fetched.get(hash) ?? null);
          }
        }
      } catch {
        // Left uncached, so the next call retries.
      }
    }

    // Keyed off `has`, not off the value: a hash the fetch failed for is
    // absent from the cache and must stay absent from the response, so the
    // caller re-asks for it instead of recording the failure as an answer.
    const stats: Record<string, ShortStat | null> = {};
    for (const hash of hashes) {
      if (this.statsCache.has(hash)) stats[hash] = this.statsCache.get(hash) ?? null;
    }
    return stats;
  }

  /**
   * Clears the stats cache when the repository behind it has changed.
   *
   * Checked lazily, where the cache is used, rather than in `invalidate()`:
   * `invalidate()` also runs from the git file watcher's 500ms-debounced
   * callback (`extension.ts`), i.e. on every ordinary commit, checkout and
   * index change. Clearing there would throw the cache away after every git
   * operation and leave it worthless. The identity compared is the pair
   * `assertCurrent` already treats as "the repository this result belongs to".
   */
  private syncStatsCacheIdentity(gitService: GraphGitService, repoPath: string): void {
    if (this.statsCacheGitService === gitService && this.statsCacheRepoPath === repoPath) {
      return;
    }
    this.statsCache.clear();
    this.statsCacheGitService = gitService;
    this.statsCacheRepoPath = repoPath;
  }

  private assertCurrent(
    generation: number,
    gitService: GraphGitService,
    repoPath: string,
  ): void {
    const current = this.getGitService();
    if (
      generation !== this.buildGeneration
      || current !== gitService
      || current?.getRepoPath() !== repoPath
    ) {
      // Superseded is routine, not a fault: invalidate() bumps the generation
      // before the event goes out, so any in-flight build is expected to lose.
      // The code lets the webview drop it instead of surfacing an error.
      const error = new Error('Graph build superseded') as Error & { code: string };
      error.code = 'GRAPH_BUILD_SUPERSEDED';
      throw error;
    }
  }
}

import type { GitService } from '../services/git.service';
import { loadAllCommits } from '../services/graph-loader';
import { GraphService } from '../services/graph.service';
import type { GraphOptions } from '../types/graph.types';

type GraphGitService = Pick<
  GitService,
  'getRepoPath' | 'snapshotLogOptions' | 'log' | 'getShortStats'
>;

export class GraphMethodHandler {
  private buildGeneration = 0;
  private nextLayoutVersion = 0;

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
      all: options.all ?? true,
    };
    const commits = await loadAllCommits(gitService, logOptions);
    this.assertCurrent(generation, gitService, repoPath);

    const layout = this.graphService.createLayout(commits);
    try {
      const stats = await gitService.getShortStats(500, logOptions.all);
      for (const node of layout.nodes) {
        const stat = stats.get(node.hash);
        if (stat) {
          node.filesChanged = stat.filesChanged;
          node.additions = stat.additions;
          node.deletions = stat.deletions;
        }
      }
    } catch {
      // Stats are optional — don't fail the build if this errors.
    }

    this.assertCurrent(generation, gitService, repoPath);
    const layoutVersion = ++this.nextLayoutVersion;
    this.graphService.publishLayout(layout, layoutVersion);
    return {
      totalRows: layout.totalRows,
      maxLane: layout.maxLane,
      layoutVersion,
    };
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

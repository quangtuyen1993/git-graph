import { handleGitMethod } from './git-method-handler';
import { GraphMethodHandler } from './graph-method-handler';
import { GitService } from '../services/git.service';
import { GraphService } from '../services/graph.service';

export interface RepositoryInfo {
  name: string;
  path: string;
}

export interface RepositorySessionOptions {
  initialRepository: RepositoryInfo | null;
  repositories: readonly RepositoryInfo[];
  allowRepositorySwitch: boolean;
  createGitService?: (path: string) => GitService;
}

export class RepositorySession {
  private gitService: GitService | null;
  private currentRepository: RepositoryInfo | null;
  private readonly graphMethodHandler: GraphMethodHandler;
  private readonly createGitService: (path: string) => GitService;

  constructor(private readonly options: RepositorySessionOptions) {
    this.createGitService = options.createGitService ?? ((path) => new GitService(path));
    this.currentRepository = options.initialRepository;
    this.gitService = this.currentRepository
      ? this.createGitService(this.currentRepository.path)
      : null;
    this.graphMethodHandler = new GraphMethodHandler(
      new GraphService(),
      () => this.gitService,
    );
  }

  public getGitService(): GitService | null {
    return this.gitService;
  }

  public getCurrentRepository(): RepositoryInfo | null {
    return this.currentRepository;
  }

  public async handleRepo(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'repo.list':
        return {
          repos: this.options.repositories.map((repository) => ({
            ...repository,
            active: repository.path === this.currentRepository?.path,
          })),
        };
      case 'repo.switch': {
        if (!this.options.allowRepositorySwitch) {
          throw new Error('Cannot switch a fixed repository session');
        }

        const targetPath = p.path as string;
        const repository = this.options.repositories.find((candidate) => candidate.path === targetPath);
        if (!repository) {
          throw new Error(`Repo not found: ${targetPath}`);
        }

        this.graphMethodHandler.invalidate();
        this.currentRepository = repository;
        this.gitService = this.createGitService(repository.path);
        return { success: true, name: repository.name, path: repository.path };
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  public async handleGit(method: string, params: unknown): Promise<unknown> {
    if (!this.gitService) {
      throw new Error('No git repository found in workspace');
    }
    return handleGitMethod(this.gitService, method, params);
  }

  public handleGraph(method: string, params: unknown): Promise<unknown> {
    return this.graphMethodHandler.handle(method, params);
  }

  public invalidate(): void {
    this.graphMethodHandler.invalidate();
  }
}

import { realpath } from 'fs/promises';
import { handleGitMethod } from './git-method-handler';
import { GraphMethodHandler } from './graph-method-handler';
import { GitService } from '../services/git.service';
import { GraphService } from '../services/graph.service';
import type { SubmoduleEntry } from '../types/git.types';

/** A submodule plus the repository it belongs to, so the picker can open it. */
export type WorkspaceSubmodule = SubmoduleEntry & { repoPath: string; repoName: string };

export interface RepositoryInfo {
  name: string;
  path: string;
}

export interface RepositorySessionOptions {
  initialRepository: RepositoryInfo | null;
  repositories: readonly RepositoryInfo[];
  createGitService?: (path: string) => GitService;
  canonicalizePath?: (path: string) => Promise<string>;
}

export class RepositorySession {
  private gitService: GitService | null;
  private currentRepository: RepositoryInfo | null;
  private readonly repositories: RepositoryInfo[];
  private readonly graphMethodHandler: GraphMethodHandler;
  private readonly createGitService: (path: string) => GitService;
  private readonly canonicalizePath: (path: string) => Promise<string>;

  constructor(options: RepositorySessionOptions) {
    this.createGitService = options.createGitService ?? ((path) => new GitService(path));
    this.canonicalizePath = options.canonicalizePath ?? realpath;
    this.repositories = [...options.repositories];
    this.currentRepository = options.initialRepository;
    this.gitService = this.currentRepository
      ? this.createGitService(this.currentRepository.path)
      : null;
    this.graphMethodHandler = new GraphMethodHandler(
      new GraphService(),
      () => this.gitService,
    );
  }

  /**
   * Makes a repository selectable without reopening anything. Submodules arrive
   * this way, so the path is canonicalised first: the same submodule reached
   * through a symlink must not enter the list twice.
   */
  public async addRepository(repository: RepositoryInfo): Promise<RepositoryInfo> {
    const canonicalPath = await this.canonicalizePath(repository.path);
    const existing = this.repositories.find((candidate) => candidate.path === canonicalPath);
    if (existing) return existing;

    const entry: RepositoryInfo = { name: repository.name, path: canonicalPath };
    this.repositories.push(entry);
    return entry;
  }

  public getGitService(): GitService | null {
    return this.gitService;
  }

  /** The active repo root, for consumers that have no webview to ask. */
  public getActiveRepositoryPath(): string | undefined {
    return this.getGitService()?.getRepoPath();
  }

  public getCurrentRepository(): RepositoryInfo | null {
    return this.currentRepository;
  }

  public async handleRepo(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'repo.list':
        return {
          repos: this.repositories.map((repository) => ({
            ...repository,
            active: repository.path === this.currentRepository?.path,
          })),
          submodules: await this.listWorkspaceSubmodules(),
        };
      case 'repo.switch': {
        const targetPath = p.path as string;
        const repository = this.repositories.find((candidate) => candidate.path === targetPath);
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

  /**
   * Submodules across every known repository, each tagged with its owner.
   *
   * Scoping this to the active repository would make the picker's contents
   * depend on the current selection, so a submodule of a non-selected repo
   * could never be reached. One repository failing to enumerate contributes
   * nothing rather than emptying the whole list.
   */
  private async listWorkspaceSubmodules(): Promise<WorkspaceSubmodule[]> {
    const perRepository = await Promise.all(
      this.repositories.map(async (repository) => {
        // Wrapped rather than chained off .catch(): a service that throws
        // synchronously — or has no submoduleList at all — would otherwise
        // escape before a rejection handler could attach and take the whole
        // repository list down with it.
        const entries = await Promise.resolve()
          .then(() => this.createGitService(repository.path).submoduleList())
          .catch(() => []);
        return entries.map((entry) => ({
          ...entry,
          repoPath: repository.path,
          repoName: repository.name,
        }));
      }),
    );
    return perRepository.flat();
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

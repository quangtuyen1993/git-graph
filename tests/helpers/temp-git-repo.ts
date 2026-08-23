import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const TEMP_REPO_PREFIX = path.join(os.tmpdir(), 'git-graph-test-');

export class TempGitRepo {
  private constructor(public readonly path: string) {}

  public static async create(): Promise<TempGitRepo> {
    const repoPath = await mkdtemp(TEMP_REPO_PREFIX);
    const repo = new TempGitRepo(repoPath);
    await repo.execGit(['init', '-b', 'main']);
    await repo.execGit(['config', 'user.name', 'Git Graph Test']);
    await repo.execGit(['config', 'user.email', 'git-graph@example.test']);
    return repo;
  }

  public async execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd: this.path },
    );
    return stdout;
  }

  public async commitSeries(subjects: string[]): Promise<string[]> {
    const hashes: string[] = [];
    for (const subject of subjects) {
      await this.execGit(['commit', '--allow-empty', '-m', subject]);
      hashes.push((await this.execGit(['rev-parse', 'HEAD'])).trim());
    }
    return hashes;
  }

  public async subjects(): Promise<string[]> {
    const output = await this.execGit(['log', '--format=%s']);
    return output.trim().split('\n').filter(Boolean);
  }

  public async commitCount(): Promise<number> {
    return Number.parseInt((await this.execGit(['rev-list', '--count', 'HEAD'])).trim(), 10);
  }

  public async treeOf(ref: string): Promise<string> {
    return (await this.execGit(['rev-parse', `${ref}^{tree}`])).trim();
  }

  public async publishCurrentBranch(): Promise<void> {
    const remotePath = path.join(this.path, 'remote.git');
    await this.execGit(['init', '--bare', remotePath]);
    await this.execGit(['remote', 'add', 'origin', remotePath]);
    await this.execGit(['push', '--set-upstream', 'origin', 'main']);
  }

  public async cleanup(): Promise<void> {
    if (!this.path.startsWith(TEMP_REPO_PREFIX)) {
      throw new Error(`Refusing to remove unsafe test path: ${this.path}`);
    }
    await rm(this.path, { recursive: true, force: true });
  }
}

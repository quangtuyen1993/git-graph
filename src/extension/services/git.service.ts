import { GitCLI } from './git-cli';
import {
  parseLog, parseBranches, parseTags, parseStatus, parseFileChanges,
  LOG_FORMAT, BRANCH_FORMAT, TAG_FORMAT
} from '../utils/git-parser';
import type { Commit, Branch, Tag, FileChange, GitStatus, GitLogOptions, DiffResult } from '../types/git.types';

export class GitService {
  private cli: GitCLI;

  constructor(repoPath: string) {
    this.cli = new GitCLI(repoPath);
  }

  public getRepoPath(): string {
    return this.cli.getRepoPath();
  }

  public setRepoPath(path: string): void {
    this.cli.setRepoPath(path);
  }

  public async log(options: GitLogOptions = {}): Promise<Commit[]> {
    const args = ['log', `--format=${LOG_FORMAT}`];

    if (options.maxCount) args.push(`--max-count=${options.maxCount}`);
    if (options.skip) args.push(`--skip=${options.skip}`);
    if (options.author) args.push(`--author=${options.author}`);
    if (options.grep) args.push(`--grep=${options.grep}`);
    if (options.after) args.push(`--after=${options.after}`);
    if (options.before) args.push(`--before=${options.before}`);
    if (options.all) args.push('--all');
    if (options.branch) args.push(options.branch);

    const output = await this.cli.exec(args);
    return parseLog(output);
  }

  public async branches(): Promise<Branch[]> {
    const args = ['branch', '-a', `--format=${BRANCH_FORMAT}`];
    const output = await this.cli.exec(args);
    return parseBranches(output);
  }

  public async tags(): Promise<Tag[]> {
    const args = ['tag', '-l', `--format=${TAG_FORMAT}`];
    const output = await this.cli.exec(args);
    return parseTags(output);
  }

  public async show(hash: string): Promise<{ commit: Commit; files: FileChange[] }> {
    // Get commit info
    const commitOutput = await this.cli.exec(['log', '-1', `--format=${LOG_FORMAT}`, hash]);
    const commits = parseLog(commitOutput);
    if (commits.length === 0) {
      throw new Error(`Commit not found: ${hash}`);
    }

    // Get file changes
    const filesOutput = await this.cli.exec(['diff-tree', '--numstat', '-r', '--root', hash]);
    const files = parseFileChanges(filesOutput);

    return { commit: commits[0], files };
  }

  public async status(): Promise<GitStatus> {
    const output = await this.cli.exec(['status', '--porcelain=v2', '--branch', '-z']);
    return parseStatus(output);
  }

  public async diff(ref1: string, ref2: string): Promise<DiffResult> {
    const [numstatOutput, rawOutput] = await Promise.all([
      this.cli.exec(['diff', '--numstat', `${ref1}...${ref2}`]),
      this.cli.exec(['diff', `${ref1}...${ref2}`])
    ]);

    return {
      files: parseFileChanges(numstatOutput),
      raw: rawOutput
    };
  }

  // --- Write Operations ---

  public async checkout(ref: string): Promise<void> {
    await this.cli.exec(['checkout', ref]);
  }

  public async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ['branch', name];
    if (startPoint) args.push(startPoint);
    await this.cli.exec(args);
  }

  public async deleteBranch(name: string, force?: boolean): Promise<void> {
    const flag = force ? '-D' : '-d';
    await this.cli.exec(['branch', flag, name]);
  }

  public async merge(branch: string, options?: { noFF?: boolean; message?: string }): Promise<void> {
    const args = ['merge', branch];
    if (options?.noFF) args.push('--no-ff');
    if (options?.message) args.push('-m', options.message);
    await this.cli.exec(args);
  }

  public async rebase(onto: string): Promise<void> {
    await this.cli.exec(['rebase', onto]);
  }

  public async cherryPick(hash: string): Promise<void> {
    await this.cli.exec(['cherry-pick', hash]);
  }

  public async stash(action: 'push' | 'pop' | 'drop' | 'list', options?: { message?: string; index?: number }): Promise<unknown> {
    const args = ['stash', action];
    if (action === 'push' && options?.message) {
      args.push('-m', options.message);
    }
    if ((action === 'pop' || action === 'drop') && options?.index !== undefined) {
      args.push(`stash@{${options.index}}`);
    }
    const output = await this.cli.exec(args);
    if (action === 'list') {
      return output.trim().split('\n').filter(Boolean);
    }
    return undefined;
  }

  public async push(remote?: string, branch?: string, options?: { force?: boolean; setUpstream?: boolean }): Promise<void> {
    const args = ['push'];
    if (options?.force) args.push('--force-with-lease');
    if (options?.setUpstream) args.push('-u');
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.cli.exec(args, { timeout: 60000 });
  }

  public async pull(remote?: string, branch?: string, options?: { rebase?: boolean }): Promise<void> {
    const args = ['pull'];
    if (options?.rebase) args.push('--rebase');
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.cli.exec(args, { timeout: 60000 });
  }

  public async fetch(remote?: string): Promise<void> {
    const args = ['fetch'];
    if (remote) args.push(remote);
    else args.push('--all');
    await this.cli.exec(args, { timeout: 60000 });
  }

  public async reset(mode: 'soft' | 'mixed' | 'hard', ref: string): Promise<void> {
    await this.cli.exec(['reset', `--${mode}`, ref]);
  }

  public async createTag(name: string, hash?: string, message?: string): Promise<void> {
    const args = ['tag'];
    if (message) args.push('-a', name, '-m', message);
    else args.push(name);
    if (hash) args.push(hash);
    await this.cli.exec(args);
  }

  public async deleteTag(name: string): Promise<void> {
    await this.cli.exec(['tag', '-d', name]);
  }

  public async abortMerge(): Promise<void> {
    await this.cli.exec(['merge', '--abort']);
  }

  public async abortRebase(): Promise<void> {
    await this.cli.exec(['rebase', '--abort']);
  }

  /**
   * Get shortstat (files changed, additions, deletions) for commits.
   * Returns a map of hash → { filesChanged, additions, deletions }
   */
  public async getShortStats(maxCount: number = 500, all: boolean = true): Promise<Map<string, { filesChanged: number; additions: number; deletions: number }>> {
    const args = ['log', '--shortstat', '--format=%H'];
    if (all) args.push('--all');
    args.push(`--max-count=${maxCount}`);

    const output = await this.cli.exec(args);
    const stats = new Map<string, { filesChanged: number; additions: number; deletions: number }>();

    const lines = output.split('\n');
    let currentHash = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Hash line (40 hex chars)
      if (/^[0-9a-f]{40}$/.test(trimmed)) {
        currentHash = trimmed;
        continue;
      }

      // Shortstat line: " 3 files changed, 10 insertions(+), 5 deletions(-)"
      if (currentHash && trimmed.includes('changed')) {
        const filesMatch = trimmed.match(/(\d+) file/);
        const addMatch = trimmed.match(/(\d+) insertion/);
        const delMatch = trimmed.match(/(\d+) deletion/);

        stats.set(currentHash, {
          filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
          additions: addMatch ? parseInt(addMatch[1], 10) : 0,
          deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
        });
        currentHash = '';
      }
    }

    return stats;
  }

  /**
   * Get file content at a specific commit.
   * Returns null if the file doesn't exist at that commit (e.g. added/deleted).
   */
  public async showFile(hash: string, path: string): Promise<string | null> {
    try {
      const output = await this.cli.exec(['show', `${hash}:${path}`]);
      return output;
    } catch {
      return null;
    }
  }

  /**
   * Get parent hash(es) of a commit.
   */
  public async getParents(hash: string): Promise<string[]> {
    const output = await this.cli.exec(['rev-parse', `${hash}^`]).catch(() => '');
    return output.trim().split('\n').filter(Boolean);
  }

  public static async findRepo(startPath: string): Promise<string | null> {
    try {
      const cli = new GitCLI(startPath);
      const output = await cli.exec(['rev-parse', '--show-toplevel']);
      return output.trim();
    } catch {
      return null;
    }
  }
}

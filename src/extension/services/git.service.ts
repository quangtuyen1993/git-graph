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

import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { GitCLI } from './git-cli';
import {
  parseLog, parseBranches, parseTags, parseStatus, parseFileChanges,
  LOG_FORMAT, BRANCH_FORMAT, TAG_FORMAT
} from '../utils/git-parser';
import { transformRebaseTodo, type RebaseTodoPlan } from '../utils/rebase-todo';
import type { Commit, Branch, Tag, FileChange, GitStatus, GitLogOptions, DiffResult, StashEntry, WorktreeEntry } from '../types/git.types';

const REBASE_TIMEOUT_MS = 120000;
const REBASE_TEMP_PREFIX = path.join(os.tmpdir(), 'git-graph-rebase-');

function quoteEditorArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sequenceEditorSource(): string {
  return [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    `const transformRebaseTodo = ${transformRebaseTodo.toString()};`,
    "const todoPath = process.argv[2];",
    "const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'rewrite-plan.json'), 'utf8'));",
    "const todo = fs.readFileSync(todoPath, 'utf8');",
    "fs.writeFileSync(todoPath, transformRebaseTodo(todo, plan), 'utf8');",
    '',
  ].join('\n');
}

function messageEditorSource(): string {
  return [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const message = fs.readFileSync(path.join(__dirname, 'message.txt'), 'utf8');",
    "fs.writeFileSync(process.argv[2], message, 'utf8');",
    '',
  ].join('\n');
}

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

  public async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.cli.exec(['branch', '-m', oldName, newName]);
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

  public async revert(hash: string): Promise<void> {
    await this.cli.exec(['revert', '--no-edit', hash]);
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

  // --- Stash Operations ---

  public async stashList(): Promise<StashEntry[]> {
    const output = await this.cli.exec([
      'stash', 'list',
      '--format=%gd%x1f%gs%x1f%ai%x1f%H'
    ]);
    if (!output.trim()) return [];

    return output.trim().split('\n').filter(Boolean).map(line => {
      const [ref, message, date, hash] = line.split('\x1f');
      const indexMatch = ref?.match(/\{(\d+)\}/);
      const branchMatch = message?.match(/on (.+?):/);
      return {
        index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
        message: message?.replace(/^[^:]+:\s*/, '') ?? '',
        date: date ?? '',
        branch: branchMatch?.[1] ?? '',
        hash: hash ?? '',
      };
    });
  }

  public async stashApply(index?: number): Promise<void> {
    const args = ['stash', 'apply'];
    if (index !== undefined) args.push(`stash@{${index}}`);
    await this.cli.exec(args);
  }

  // --- Worktree Operations ---

  public async worktreeList(): Promise<WorktreeEntry[]> {
    const output = await this.cli.exec(['worktree', 'list', '--porcelain']);
    if (!output.trim()) return [];

    const entries: WorktreeEntry[] = [];
    let current: Partial<WorktreeEntry> = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current as WorktreeEntry);
        current = { path: line.slice(9), bare: false, isMain: entries.length === 0 };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        current.bare = true;
      } else if (line === 'detached') {
        current.branch = null;
      }
    }
    if (current.path) entries.push(current as WorktreeEntry);

    return entries;
  }

  public async worktreeAdd(path: string, branch?: string, newBranch?: string): Promise<void> {
    const args = ['worktree', 'add'];
    if (newBranch) {
      args.push('-b', newBranch, path);
    } else if (branch) {
      args.push(path, branch);
    } else {
      args.push(path);
    }
    await this.cli.exec(args);
  }

  public async worktreeRemove(path: string, force?: boolean): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(path);
    await this.cli.exec(args);
  }

  /**
   * Check if commits can be squashed:
   * - All must be on the current branch (ancestors of HEAD)
   * - Must be consecutive in the branch history
   */
  public async canSquash(hashes: string[]): Promise<{ ok: boolean; reason?: string }> {
    if (hashes.length < 2) {
      return { ok: false, reason: 'Need at least 2 commits to squash' };
    }

    // Check all commits are ancestors of HEAD (on current branch)
    for (const hash of hashes) {
      try {
        await this.cli.exec(['merge-base', '--is-ancestor', hash, 'HEAD']);
      } catch {
        return { ok: false, reason: `Commit ${hash.substring(0, 7)} is not on the current branch` };
      }
    }

    // Check they are consecutive: the oldest's parent should not be one of the selected hashes,
    // and there should be no gaps (no unselected commits between them)
    // Get the rev-list between oldest and newest, verify count matches selection
    const oldestHash = hashes[hashes.length - 1];
    const newestHash = hashes[0];
    try {
      const oldestParent = await this.cli.exec(['rev-parse', '--verify', `${oldestHash}^`])
        .catch(() => '');
      const range = oldestParent.trim() ? `${oldestHash}^..${newestHash}` : newestHash;
      const output = await this.cli.exec(['rev-list', range]);
      const commitsInRange = output.trim().split('\n').filter(Boolean);
      if (commitsInRange.length !== hashes.length) {
        return { ok: false, reason: 'Selected commits are not consecutive' };
      }
    } catch {
      return { ok: false, reason: 'Could not verify commit range' };
    }

    return { ok: true };
  }

  /**
   * Check if a commit is on the current branch (ancestor of HEAD).
   */
  public async isOnCurrentBranch(hash: string): Promise<boolean> {
    try {
      await this.cli.exec(['merge-base', '--is-ancestor', hash, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a commit is reachable from the current branch's upstream.
   */
  public async isPublished(hash: string): Promise<boolean> {
    try {
      await this.cli.exec(['merge-base', '--is-ancestor', hash, '@{upstream}']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reword a commit message using interactive rebase.
   * Only works for commits on the current branch.
   */
  public async reword(hash: string, newMessage: string): Promise<void> {
    await this.runHistoryRewrite(hash, { kind: 'reword', hash }, newMessage);
  }

  /**
   * Squash consecutive commits into one.
   * Hashes should be in topological order (newest first).
   * Uses interactive rebase with automated sequence editor.
   */
  public async squash(hashes: string[], message: string): Promise<void> {
    if (hashes.length < 2) {
      throw new Error('Need at least 2 commits to squash');
    }

    const oldestHash = hashes[hashes.length - 1];
    await this.runHistoryRewrite(oldestHash, { kind: 'squash', hashes }, message);
  }

  private async runHistoryRewrite(
    oldestHash: string,
    plan: RebaseTodoPlan,
    message: string,
  ): Promise<void> {
    const oldestParent = await this.cli.exec(['rev-parse', '--verify', `${oldestHash}^`])
      .catch(() => '');
    const rebaseArgs = oldestParent.trim()
      ? ['rebase', '-i', '--rebase-merges', `${oldestHash}^`]
      : ['rebase', '-i', '--rebase-merges', '--root'];
    const tempDir = await mkdtemp(REBASE_TEMP_PREFIX);

    try {
      const sequenceEditorPath = path.join(tempDir, 'sequence-editor.cjs');
      const messageEditorPath = path.join(tempDir, 'message-editor.cjs');
      await Promise.all([
        writeFile(sequenceEditorPath, sequenceEditorSource(), 'utf8'),
        writeFile(messageEditorPath, messageEditorSource(), 'utf8'),
        writeFile(path.join(tempDir, 'rewrite-plan.json'), JSON.stringify(plan), 'utf8'),
        writeFile(path.join(tempDir, 'message.txt'), message, 'utf8'),
      ]);

      await this.cli.exec(rebaseArgs, {
        timeout: REBASE_TIMEOUT_MS,
        env: {
          GIT_SEQUENCE_EDITOR: `${quoteEditorArgument(process.execPath)} ${quoteEditorArgument(sequenceEditorPath)}`,
          GIT_EDITOR: `${quoteEditorArgument(process.execPath)} ${quoteEditorArgument(messageEditorPath)}`,
        },
      });
    } finally {
      if (!tempDir.startsWith(REBASE_TEMP_PREFIX)) {
        throw new Error(`Refusing to remove unsafe rebase path: ${tempDir}`);
      }
      await rm(tempDir, { recursive: true, force: true });
    }
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

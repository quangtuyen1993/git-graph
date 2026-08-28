import { mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { GitCLI } from './git-cli';
import {
  parseLog, parseBranches, parseTags, parseStatus, parseFileChanges, parseSubmoduleConfig, parseSubmoduleStatus,
  LOG_FORMAT, BRANCH_FORMAT, TAG_FORMAT
} from '../utils/git-parser';
import { transformRebaseTodo, type RebaseTodoPlan } from '../utils/rebase-todo';
import type { Commit, Branch, Tag, FileChange, GitStatus, GitLogOptions, DiffResult, ShortStat, StashEntry, SubmoduleEntry, WorktreeEntry } from '../types/git.types';

const REBASE_TIMEOUT_MS = 120000;
const REBASE_TEMP_PREFIX = path.join(os.tmpdir(), 'git-graph-rebase-');

function quoteEditorArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Parses `git log --shortstat --format=%H` output into hash → ShortStat.
 *
 * Keyed off the `%H` line rather than the position of the revision in argv:
 * `--no-walk` defaults to `--no-walk=sorted`, so git may emit the commits in
 * an order other than the one they were asked for. Reading the hash back out
 * of the output is what makes that reordering harmless.
 *
 * `%H` is the full lowercase object name — 40 hex in a SHA-1 repository, 64
 * in a SHA-256 one — so the hash line matches either length rather than
 * hard-coding SHA-1's. Matching only 40 would silently yield an empty map for
 * every commit in a SHA-256 repository.
 *
 * The stat line that follows a commit reads
 * " 3 files changed, 10 insertions(+), 5 deletions(-)", with either the
 * insertions or the deletions clause omitted when it is zero.
 *
 * The output distinguishes three states, and so does this map:
 *
 * - **Hash line, then a stat line** — a real change; the parsed numbers.
 * - **Hash line, no stat line** — git listed the commit and had nothing to
 *   report: an empty commit, or a merge. Mapped to `{0, 0, 0}`, because "git
 *   says nothing changed" is an answer. Callers that must not treat a merge as
 *   empty exclude it by its parent count, which is the only correct test — git
 *   prints no stat line for a merge whether or not it touched anything.
 * - **Hash never listed** — git did not answer for it at all (an unresolvable
 *   or garbage-collected revision). Absent from the map, so a caller can tell
 *   "no answer" apart from "nothing changed".
 *
 * Zeroing the middle state used to be conflated with the third, which made a
 * genuinely empty commit indistinguishable from one git never answered for.
 */
function parseShortStats(output: string): Map<string, ShortStat> {
  const stats = new Map<string, ShortStat>();
  // The hash whose stat line has not been seen yet. Still keyed off `%H`, never
  // off the revision's position in argv.
  let pendingHash = '';
  const nothingChanged = (): ShortStat => ({ filesChanged: 0, additions: 0, deletions: 0 });

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Hash line: full object name, 40 hex (SHA-1) or 64 hex (SHA-256)
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(trimmed)) {
      // The previous commit was listed and no stat line ever followed it, so
      // git reported nothing changed for it.
      if (pendingHash) stats.set(pendingHash, nothingChanged());
      pendingHash = trimmed;
      continue;
    }

    // Shortstat line: " 3 files changed, 10 insertions(+), 5 deletions(-)"
    if (pendingHash && trimmed.includes('changed')) {
      const filesMatch = trimmed.match(/(\d+) file/);
      const addMatch = trimmed.match(/(\d+) insertion/);
      const delMatch = trimmed.match(/(\d+) deletion/);

      stats.set(pendingHash, {
        filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
        additions: addMatch ? parseInt(addMatch[1], 10) : 0,
        deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
      });
      pendingHash = '';
    }
  }

  // The last commit listed, if no stat line followed it.
  if (pendingHash) stats.set(pendingHash, nothingChanged());

  return stats;
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

/**
 * `git branch -d` refused because the branch holds commits reachable from
 * nowhere else. Typed rather than a stderr match so the UI can offer a force
 * delete without depending on git's message language.
 */
export const BRANCH_NOT_FULLY_MERGED = 'BRANCH_NOT_FULLY_MERGED';

export class BranchNotFullyMergedError extends Error {
  public readonly code = BRANCH_NOT_FULLY_MERGED;

  constructor(public readonly branchName: string) {
    super(`Branch "${branchName}" is not fully merged`);
    this.name = 'BranchNotFullyMergedError';
  }
}

/**
 * Every ref in the requested branch filter failed `rev-parse --verify`, so the
 * filter resolved to nothing. Typed rather than a stderr match so the webview
 * can tell a dead filter apart from a branch that genuinely has no commits.
 */
export const BRANCH_FILTER_UNRESOLVED = 'BRANCH_FILTER_UNRESOLVED';

export class BranchFilterUnresolvedError extends Error {
  public readonly code = BRANCH_FILTER_UNRESOLVED;

  constructor(public readonly branches: string[]) {
    super(`None of the requested branches could be resolved: ${branches.join(', ')}`);
    this.name = 'BranchFilterUnresolvedError';
  }
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
    if (options.revisions !== undefined) {
      if (options.revisions.length === 0) return [];
      args.push(...options.revisions);
    } else {
      if (options.all) args.push('--all');
      if (options.branch) args.push(options.branch);
    }

    const output = await this.cli.exec(args);
    return parseLog(output);
  }

  public async snapshotLogOptions(
    options: Omit<GitLogOptions, 'maxCount' | 'skip'>,
  ): Promise<Omit<GitLogOptions, 'maxCount' | 'skip'>> {
    let revisions: string[];

    const requestedBranches = options.branches?.length
      ? options.branches
      : (options.branch ? [options.branch] : []);

    if (requestedBranches.length > 0) {
      const resolved = await Promise.all(requestedBranches.map((branch) => this.cli
        // A branch can vanish between the branch list and the build; a stale
        // entry must not fail the whole graph.
        .exec(['rev-parse', '--verify', branch])
        .then((output) => output.trim())
        .catch(() => '')));
      revisions = [...new Set(resolved.filter(Boolean))];
      if (revisions.length === 0) {
        // A partially stale list still yields a real, if smaller, graph. When
        // *nothing* resolves the filter is entirely dead and an empty graph is
        // indistinguishable from "these branches have no commits", so fail
        // loudly instead — this is what the single-branch path did before it
        // gained skip-on-failure.
        throw new BranchFilterUnresolvedError(requestedBranches);
      }
    } else if (options.all) {
      const refs = await this.cli.exec(['for-each-ref', '--format=%(objectname)']);
      const head = await this.cli.exec(['rev-parse', '--verify', 'HEAD']).catch(() => '');
      revisions = [...new Set([...refs.split('\n'), head.trim()].filter(Boolean))];
    } else {
      const head = await this.cli.exec(['rev-parse', '--verify', 'HEAD']);
      revisions = [head.trim()];
    }

    return {
      ...options,
      branch: undefined,
      branches: undefined,
      all: false,
      revisions,
    };
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
    const [numstatOutput, nameStatusOutput] = await Promise.all([
      this.cli.exec(['diff-tree', '--numstat', '-z', '-M', '-C', '-r', '--root', hash]),
      this.cli.exec(['diff-tree', '--name-status', '-z', '-M', '-C', '-r', '--root', hash]),
    ]);
    const files = parseFileChanges(numstatOutput, nameStatusOutput);

    return { commit: commits[0], files };
  }

  public async status(): Promise<GitStatus> {
    const output = await this.cli.exec(['status', '--porcelain=v2', '--branch', '-z']);
    return parseStatus(output);
  }

  public async submoduleList(): Promise<SubmoduleEntry[]> {
    const [statusOutput, configOutput] = await Promise.all([
      this.cli.exec(['submodule', 'status']),
      this.cli.exec(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']).catch(() => ''),
    ]);
    return parseSubmoduleStatus(statusOutput, this.getRepoPath(), parseSubmoduleConfig(configOutput));
  }

  public async resolveSubmodule(relativePath: string): Promise<SubmoduleEntry> {
    const entry = (await this.submoduleList()).find(submodule => submodule.path === relativePath);
    if (!entry) throw new Error(`Submodule not found: ${relativePath}`);
    if (entry.state === 'uninitialized') throw new Error(`Submodule is not initialized: ${relativePath}`);

    const canonicalize = async (candidatePath: string): Promise<string> => {
      try {
        return await realpath(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Submodule directory is missing: ${relativePath}`);
        }
        throw error;
      }
    };

    const configuredPath = await canonicalize(entry.absolutePath);
    const repoPath = await GitService.findRepo(configuredPath);
    if (!repoPath) throw new Error(`Submodule not found: ${relativePath}`);
    const canonicalRepoPath = await canonicalize(repoPath);
    if (configuredPath !== canonicalRepoPath) throw new Error(`Submodule not found: ${relativePath}`);

    return { ...entry, absolutePath: configuredPath };
  }

  public async gitDirectory(): Promise<string> {
    return (await this.cli.exec(['rev-parse', '--absolute-git-dir'])).trim();
  }

  public async diff(ref1: string, ref2: string): Promise<DiffResult> {
    const [numstatOutput, nameStatusOutput, rawOutput] = await Promise.all([
      this.cli.exec(['diff', '--numstat', '-z', '-M', '-C', `${ref1}...${ref2}`]),
      this.cli.exec(['diff', '--name-status', '-z', '-M', '-C', `${ref1}...${ref2}`]),
      this.cli.exec(['diff', '-M', '-C', `${ref1}...${ref2}`])
    ]);

    return {
      files: parseFileChanges(numstatOutput, nameStatusOutput),
      raw: rawOutput
    };
  }

  /**
   * Compares `ref` against the working tree. Unlike `diff()` there is no
   * second revision and no three-dot range — `git diff <ref>` already means
   * "ref versus what is on disk right now".
   *
   * The raw diff text is opt-in. Its only caller reads `files` and nothing
   * else, and on a wide branch delta the raw text is megabytes serialised
   * across `postMessage` to be dropped. `DiffResult.raw` stays a string so
   * every other consumer of the shape is unaffected; it is empty unless asked
   * for, which also saves a whole `git diff` invocation.
   */
  public async diffWorkingTree(ref: string, options?: { includeRaw?: boolean }): Promise<DiffResult> {
    const [numstatOutput, nameStatusOutput, rawOutput] = await Promise.all([
      this.cli.exec(['diff', '--numstat', '-z', '-M', '-C', ref]),
      this.cli.exec(['diff', '--name-status', '-z', '-M', '-C', ref]),
      options?.includeRaw ? this.cli.exec(['diff', '-M', '-C', ref]) : Promise.resolve(''),
    ]);

    return {
      files: parseFileChanges(numstatOutput, nameStatusOutput),
      raw: rawOutput,
    };
  }

  /**
   * Get raw diff text between two refs (three-dot, like PR/MR diff).
   * Shows changes introduced by ref2 since it diverged from ref1.
   */
  public async getDiff(ref1: string, ref2: string): Promise<string> {
    const output = await this.cli.exec(['diff', `${ref1}...${ref2}`]);
    // Strip null bytes and control chars that break JSON serialization
    return output.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  /**
   * Raw diff text for `ref` versus the working tree — `getDiff`'s sibling for
   * a comparison with no second revision (see `diffWorkingTree` above for why
   * there is no three-dot range here). A review of uncommitted changes needs
   * this text verbatim, the same way a review of two refs needs `getDiff`'s;
   * stripped identically, for the same reason — this is what a review's diff
   * payload is built from, and it is serialised across `postMessage` on the
   * way there.
   */
  public async getWorkingTreeDiff(ref: string): Promise<string> {
    const output = await this.cli.exec(['diff', '-M', '-C', ref]);
    return output.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  public async revParse(ref: string): Promise<string> {
    return (await this.cli.exec(['rev-parse', ref])).trim();
  }

  /**
   * A real existence check, unlike `revParse` above: plain `rev-parse` echoes
   * any syntactically valid object name back successfully whether or not the
   * object exists (see `searchCommits`'s comment below for the same trap).
   * `cat-file -e` asks git to actually look the object up and dereference it
   * as a commit, so a sha a pull request names but this repository has never
   * fetched — the exact case a review of an unfetched pull request has to
   * detect — correctly reports `false` instead of a false "yes".
   */
  public async commitExists(sha: string): Promise<boolean> {
    return this.cli.exec(['cat-file', '-e', `${sha}^{commit}`])
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Finds commits by abbreviated/full hash or by message text.
   *
   * `rev-parse --verify <q>^{commit}` is the only reliable existence check —
   * plain `rev-parse` echoes syntactically valid object names back even when
   * the object is absent. A hash-shaped query that does not resolve falls
   * through to the message grep, because `deadbeef` is also a real word.
   */
  public async searchCommits(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];

    if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
      const resolved = await this.cli
        .exec(['rev-parse', '--verify', `${trimmed}^{commit}`])
        .then((output) => output.trim())
        .catch(() => '');
      if (resolved !== '') return [resolved];
    }

    const output = await this.cli.exec([
      'log', `--grep=${trimmed}`, '-i', '--max-count=50', '--format=%H', '--all',
    ]);
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
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
    if (force) {
      await this.cli.exec(['branch', '-D', name]);
      return;
    }

    try {
      await this.cli.exec(['branch', '-d', name]);
    } catch (error) {
      // git's refusal is a localised stderr string, so matching its text breaks
      // on a translated git. Ask git itself instead: if the branch still exists
      // and is absent from the merged list, that is why -d refused.
      if (await this.isUnmerged(name)) {
        throw new BranchNotFullyMergedError(name);
      }
      throw error;
    }
  }

  private async isUnmerged(name: string): Promise<boolean> {
    // A branch that does not exist is also absent from the merged list, so
    // check existence first or every unrelated failure looks like an unmerged
    // branch.
    const exists = await this.cli.exec(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
      .then((output) => output.trim().length > 0)
      .catch(() => false);
    if (!exists) return false;

    const merged = await this.cli.exec(['branch', '--merged', 'HEAD', '--format=%(refname:short)'])
      .catch(() => null);
    if (merged === null) return false;

    const mergedNames = merged.split('\n').map((line) => line.trim()).filter(Boolean);
    return !mergedNames.includes(name);
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

  public async pull(remote?: string, branch?: string, options?: { rebase?: boolean; ffOnly?: boolean }): Promise<void> {
    const args = ['pull'];
    // `rebase: false` has to say so out loud: with nothing on the command line
    // git falls back to the user's `pull.rebase`, which would turn the "Using
    // Merge" menu item into a rebase. An absent key still means "no opinion",
    // which is what the plain Pull item wants.
    if (options?.rebase === true) args.push('--rebase');
    else if (options?.rebase === false) args.push('--no-rebase');
    if (options?.ffOnly) args.push('--ff-only');
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

  /**
   * The configured fetch URL of a remote, or undefined when it is not
   * configured. Uses `git remote get-url`, the porcelain for this, rather
   * than `git config --get remote.<name>.url`: `remote.<name>.url` is
   * legitimately multi-valued (e.g. `git remote set-url --add` for a push
   * mirror), and `git config --get` returns the *last* value where the fetch
   * URL is always the first. `git remote get-url` exits non-zero both when
   * the remote does not exist and, per its own semantics, when the resolved
   * URL is empty, which GitCLI surfaces as a rejection; a repository with no
   * such remote is an ordinary state here, not a failure, so both are folded
   * into undefined.
   */
  public async getRemoteUrl(remote = 'origin'): Promise<string | undefined> {
    try {
      const url = await this.cli.exec(['remote', 'get-url', remote]);
      return url.trim() || undefined;
    } catch {
      return undefined;
    }
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
   * Aggregate diff size for a specific set of commits.
   *
   * The hashes are passed as revisions, so the answer is pinned to exactly the
   * commits asked about — unlike a walk, it cannot drift with `--all` or the
   * branch filter. `--no-walk` stops git following parents from each one.
   *
   * Three states, and the map distinguishes all three (see `parseShortStats`):
   * a hash git listed with a stat line carries its numbers; a hash git listed
   * without one — an empty commit, or a merge, for which `--no-walk` prints no
   * stat line either way — maps to `{0, 0, 0}`; a hash git never listed is
   * absent, so "git did not answer" stays distinguishable from "git says
   * nothing changed". Callers that must not treat a merge as empty exclude it
   * by its parent count, the only test that is correct for a merge.
   *
   * Preconditions the caller owns:
   *
   * - **Full, lowercase hashes.** The map is keyed by the `%H` git prints back,
   *   which is always the full lowercase object name. Git resolves an
   *   abbreviated or uppercase revision happily, but the answer then comes back
   *   under a key the caller did not ask for, so its lookup misses and a commit
   *   git answered for in full reads as one git never listed. Callers that
   *   cache a miss make that permanent.
   * - **Bounded batches.** Every hash goes onto one `git log` argv at ~41 bytes
   *   each, so Windows' 32767-character command line is reached near 780
   *   hashes. Request a window's worth (tens), not a whole repository; this
   *   method deliberately does not chunk, because the argv it builds is part of
   *   its contract.
   */
  public async shortStatsFor(hashes: string[]): Promise<Map<string, ShortStat>> {
    if (hashes.length === 0) return new Map();
    const output = await this.cli.exec(['log', '--no-walk', '--shortstat', '--format=%H', ...hashes]);
    return parseShortStats(output);
  }

  /**
   * Get file content at a specific commit.
   * Returns null if the file doesn't exist at that commit (e.g. added/deleted).
   * Binary files return a placeholder instead of raw bytes.
   */
  public async showFile(hash: string, path: string): Promise<string | null> {
    try {
      const output = await this.cli.exec(['show', `${hash}:${path}`]);
      // Detect binary content (null bytes or high ratio of replacement chars)
      if (output.includes('\u0000')) {
        return '(binary file)';
      }
      const replacementCount = (output.match(/\ufffd/g) || []).length;
      if (replacementCount > 0 && replacementCount / output.length > 0.01) {
        return '(binary file)';
      }
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

  /**
   * Get the full hash HEAD currently points at.
   */
  public async getHeadHash(): Promise<string> {
    const output = await this.cli.exec(['rev-parse', 'HEAD']);
    return output.trim();
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

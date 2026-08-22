# Phase 2: GitService & Git Parser

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitService that spawns git CLI commands, parses output into typed data structures, and wires into the MessageRouter so the webview can request git data.

**Architecture:** GitCLI helper handles process spawning with command queuing. GitParser converts raw git output into typed objects. GitService orchestrates both and exposes methods matching the `git.*` message namespace. All registered on the existing MessageRouter.

**Tech Stack:** TypeScript, Node.js child_process (spawn), existing MessageRouter from Phase 1

## Global Constraints

- Node.js >= 18, VS Code engine >= 1.85.0
- All source in `src/extension/` (host) and `src/webview/` (webview)
- Build output: `dist/extension.js` (host), `dist/webview/` (webview assets)
- No runtime dependencies (all bundled by esbuild)
- Git CLI must be available on PATH (extension shows error if not found)
- All git commands use `spawn('git', [args...])` — never string interpolation
- Command queue prevents concurrent git operations on same repo

---

### Task 1: Git type definitions

**Files:**
- Create: `src/extension/types/git.types.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Commit`, `Branch`, `Tag`, `FileChange`, `GitStatus`, `GitLogOptions`, `DiffResult` interfaces used by all subsequent tasks

- [ ] **Step 1: Create git type definitions**

Create `src/extension/types/git.types.ts`:

```typescript
export interface Commit {
  hash: string;
  abbreviatedHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string;       // ISO 8601
  committer: string;
  committerEmail: string;
  committerDate: string;    // ISO 8601
  message: string;
  subject: string;          // first line of message
  refs: string[];           // branch/tag names pointing here
}

export interface Branch {
  name: string;
  current: boolean;
  remote: string | null;    // e.g. "origin/main"
  upstream: string | null;  // tracking branch
  hash: string;             // tip commit
  lastCommitDate: string;   // ISO 8601
}

export interface Tag {
  name: string;
  hash: string;             // tagged commit
  message: string | null;   // annotated tag message, null for lightweight
  taggerDate: string | null;
}

export interface FileChange {
  path: string;
  oldPath: string | null;   // non-null if renamed
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitStatus {
  staged: FileStatusEntry[];
  unstaged: FileStatusEntry[];
  untracked: string[];
  conflicted: string[];
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface FileStatusEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  oldPath: string | null;
}

export interface GitLogOptions {
  maxCount?: number;
  skip?: number;
  branch?: string;          // filter to specific branch
  author?: string;          // filter by author
  grep?: string;            // search commit messages
  after?: string;           // date string
  before?: string;          // date string
  all?: boolean;            // --all (all branches)
}

export interface DiffResult {
  files: FileChange[];
  raw: string;              // full diff text
}

export interface GitError {
  code: GitErrorCode;
  message: string;
  details?: string;
}

export enum GitErrorCode {
  NOT_A_REPO = 1,
  MERGE_CONFLICT = 2,
  REBASE_CONFLICT = 3,
  PUSH_REJECTED = 4,
  BRANCH_EXISTS = 5,
  BRANCH_NOT_FOUND = 6,
  DIRTY_WORKING_TREE = 7,
  DETACHED_HEAD = 8,
  LOCK_FILE_EXISTS = 9,
  AUTH_FAILED = 10,
  TIMEOUT = 11,
  GIT_NOT_FOUND = 12,
  UNKNOWN = 99
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx esbuild src/extension/types/git.types.ts --bundle --format=cjs --platform=node --outfile=/dev/null`
Expected: No errors (types-only file, but validates syntax)

- [ ] **Step 3: Commit**

```bash
git add src/extension/types/git.types.ts
git commit -m "feat: add Git type definitions (Commit, Branch, Tag, Status, etc.)"
```

---

### Task 2: GitCLI helper — process spawning and command queue

**Files:**
- Create: `src/extension/services/git-cli.ts`

**Interfaces:**
- Consumes: Node.js `child_process.spawn`
- Produces:
  - `GitCLI` class:
    - `constructor(repoPath: string)`
    - `exec(args: string[], options?: GitCLIOptions): Promise<string>`
    - `getRepoPath(): string`
    - `setRepoPath(path: string): void`
  - `GitCLIOptions`: `{ timeout?: number; stdin?: string }`
  - Throws typed errors with `GitErrorCode` on failure

- [ ] **Step 1: Create GitCLI class**

Create `src/extension/services/git-cli.ts`:

```typescript
import { spawn } from 'child_process';
import { GitErrorCode } from '../types/git.types';

export interface GitCLIOptions {
  timeout?: number;    // ms, default 30000
  stdin?: string;      // input to pipe to git process
  cwd?: string;        // override repo path for this call
}

export class GitCLIError extends Error {
  constructor(
    public readonly code: GitErrorCode,
    message: string,
    public readonly stderr: string = ''
  ) {
    super(message);
    this.name = 'GitCLIError';
  }
}

export class GitCLI {
  private repoPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  public getRepoPath(): string {
    return this.repoPath;
  }

  public setRepoPath(path: string): void {
    this.repoPath = path;
  }

  public exec(args: string[], options: GitCLIOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      // Queue to prevent concurrent git operations
      this.queue = this.queue.then(() =>
        this.execImmediate(args, options).then(resolve).catch(reject)
      );
    });
  }

  private execImmediate(args: string[], options: GitCLIOptions): Promise<string> {
    const timeout = options.timeout ?? 30000;
    const cwd = options.cwd ?? this.repoPath;

    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        reject(new GitCLIError(
          GitErrorCode.TIMEOUT,
          `Git command timed out after ${timeout}ms: git ${args.join(' ')}`,
          stderr
        ));
      }, timeout);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      if (options.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      } else {
        proc.stdin.end();
      }

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return;

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new GitCLIError(
            this.classifyError(stderr, code ?? 1),
            `git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`,
            stderr
          ));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (killed) return;

        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new GitCLIError(
            GitErrorCode.GIT_NOT_FOUND,
            'Git executable not found. Please install git.',
            ''
          ));
        } else {
          reject(new GitCLIError(
            GitErrorCode.UNKNOWN,
            `Failed to spawn git: ${err.message}`,
            ''
          ));
        }
      });
    });
  }

  private classifyError(stderr: string, _code: number): GitErrorCode {
    const msg = stderr.toLowerCase();
    if (msg.includes('not a git repository')) return GitErrorCode.NOT_A_REPO;
    if (msg.includes('merge conflict') || msg.includes('fix conflicts')) return GitErrorCode.MERGE_CONFLICT;
    if (msg.includes('rebase') && msg.includes('conflict')) return GitErrorCode.REBASE_CONFLICT;
    if (msg.includes('rejected') || msg.includes('non-fast-forward')) return GitErrorCode.PUSH_REJECTED;
    if (msg.includes('already exists')) return GitErrorCode.BRANCH_EXISTS;
    if (msg.includes('not found') || msg.includes('did not match')) return GitErrorCode.BRANCH_NOT_FOUND;
    if (msg.includes('uncommitted changes') || msg.includes('dirty')) return GitErrorCode.DIRTY_WORKING_TREE;
    if (msg.includes('lock') && msg.includes('exists')) return GitErrorCode.LOCK_FILE_EXISTS;
    if (msg.includes('authentication') || msg.includes('permission denied')) return GitErrorCode.AUTH_FAILED;
    return GitErrorCode.UNKNOWN;
  }
}
```

- [ ] **Step 2: Verify it compiles in the host bundle**

Run: `npx esbuild src/extension/extension.ts --bundle --outfile=/dev/null --external:vscode --format=cjs --platform=node`
Expected: No errors (GitCLI is standalone, no vscode dep)

- [ ] **Step 3: Commit**

```bash
git add src/extension/services/git-cli.ts
git commit -m "feat: add GitCLI helper with process spawning and command queue"
```

---

### Task 3: Git parser — convert git output to typed objects

**Files:**
- Create: `src/extension/utils/git-parser.ts`

**Interfaces:**
- Consumes: `Commit`, `Branch`, `Tag`, `FileChange`, `GitStatus`, `FileStatusEntry` from `git.types.ts`
- Produces:
  - `parseLog(output: string): Commit[]`
  - `parseBranches(output: string): Branch[]`
  - `parseTags(output: string): Tag[]`
  - `parseStatus(output: string): GitStatus`
  - `parseFileChanges(output: string): FileChange[]`
  - `LOG_FORMAT: string` (the --format string to use with git log)

- [ ] **Step 1: Create git-parser.ts**

Create `src/extension/utils/git-parser.ts`:

```typescript
import type { Commit, Branch, Tag, FileChange, GitStatus, FileStatusEntry } from '../types/git.types';

// Delimiter that won't appear in commit messages
const FIELD_SEP = '\x1f'; // ASCII Unit Separator
const RECORD_SEP = '\x1e'; // ASCII Record Separator

// git log --format string that produces parseable output
export const LOG_FORMAT = [
  '%H',    // hash
  '%h',    // abbreviated hash
  '%P',    // parent hashes (space-separated)
  '%an',   // author name
  '%ae',   // author email
  '%aI',   // author date ISO 8601
  '%cn',   // committer name
  '%ce',   // committer email
  '%cI',   // committer date ISO 8601
  '%s',    // subject (first line)
  '%b',    // body
  '%D'     // ref names
].join(FIELD_SEP) + RECORD_SEP;

export function parseLog(output: string): Commit[] {
  if (!output.trim()) return [];

  const records = output.split(RECORD_SEP).filter(r => r.trim());
  return records.map(record => {
    const fields = record.trim().split(FIELD_SEP);
    const [
      hash, abbreviatedHash, parentStr,
      author, authorEmail, authorDate,
      committer, committerEmail, committerDate,
      subject, body, refStr
    ] = fields;

    const parents = parentStr ? parentStr.split(' ').filter(Boolean) : [];
    const refs = refStr ? refStr.split(',').map(r => r.trim()).filter(Boolean) : [];
    const message = body ? `${subject}\n\n${body}`.trim() : subject;

    return {
      hash,
      abbreviatedHash,
      parents,
      author,
      authorEmail,
      authorDate,
      committer,
      committerEmail,
      committerDate,
      message,
      subject,
      refs
    };
  });
}

export function parseBranches(output: string): Branch[] {
  if (!output.trim()) return [];

  return output.trim().split('\n').map(line => {
    // Format from: git branch -a --format='%(HEAD)%(refname:short)FIELD_SEP%(objectname:short)FIELD_SEP%(upstream:short)FIELD_SEP%(committerdate:iso8601)'
    const parts = line.split(FIELD_SEP);
    const rawName = parts[0] ?? '';
    const current = rawName.startsWith('*');
    const name = rawName.replace(/^\*\s*/, '').trim();
    const hash = (parts[1] ?? '').trim();
    const upstream = (parts[2] ?? '').trim() || null;
    const lastCommitDate = (parts[3] ?? '').trim();

    const isRemote = name.startsWith('remotes/') || name.includes('/');
    const remote = isRemote ? name : null;

    return {
      name,
      current,
      remote,
      upstream,
      hash,
      lastCommitDate
    };
  });
}

export const BRANCH_FORMAT = `%(HEAD)%(refname:short)${FIELD_SEP}%(objectname:short)${FIELD_SEP}%(upstream:short)${FIELD_SEP}%(committerdate:iso8601)`;

export function parseTags(output: string): Tag[] {
  if (!output.trim()) return [];

  return output.trim().split('\n').map(line => {
    // Format from: git tag -l --format='%(refname:short)FIELD_SEP%(objectname:short)FIELD_SEP%(contents:subject)FIELD_SEP%(creatordate:iso8601)'
    const parts = line.split(FIELD_SEP);
    const name = (parts[0] ?? '').trim();
    const hash = (parts[1] ?? '').trim();
    const message = (parts[2] ?? '').trim() || null;
    const taggerDate = (parts[3] ?? '').trim() || null;

    return { name, hash, message, taggerDate };
  });
}

export const TAG_FORMAT = `%(refname:short)${FIELD_SEP}%(objectname:short)${FIELD_SEP}%(contents:subject)${FIELD_SEP}%(creatordate:iso8601)`;

export function parseStatus(output: string): GitStatus {
  const staged: FileStatusEntry[] = [];
  const unstaged: FileStatusEntry[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (!output.trim()) {
    return { staged, unstaged, untracked, conflicted, branch, upstream, ahead, behind };
  }

  const lines = output.split('\0').filter(Boolean);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Branch header lines from --branch -z
    if (line.startsWith('# branch.oid')) {
      i++;
      continue;
    }
    if (line.startsWith('# branch.head')) {
      branch = line.replace('# branch.head ', '');
      i++;
      continue;
    }
    if (line.startsWith('# branch.upstream')) {
      upstream = line.replace('# branch.upstream ', '');
      i++;
      continue;
    }
    if (line.startsWith('# branch.ab')) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
      i++;
      continue;
    }

    // Ordinary entries: "1 XY sub mH mI mW hH hI path"
    // Renamed entries: "2 XY sub mH mI mW hH hI X\tscore path\torigPath"
    // Untracked: "? path"
    // Conflict: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.substring(2, 4);
      const stagedCode = xy[0];
      const unstagedCode = xy[1];

      let path: string;
      let oldPath: string | null = null;

      if (line.startsWith('2 ')) {
        // Renamed entry — next field in NUL-separated output is the original path
        const parts = line.split(' ');
        path = parts.slice(8).join(' ');
        i++;
        oldPath = lines[i] ?? null;
      } else {
        const parts = line.split(' ');
        path = parts.slice(8).join(' ');
      }

      if (stagedCode !== '.') {
        staged.push({ path, status: statusCodeToString(stagedCode), oldPath });
      }
      if (unstagedCode !== '.') {
        unstaged.push({ path, status: statusCodeToString(unstagedCode), oldPath: null });
      }
    } else if (line.startsWith('? ')) {
      untracked.push(line.substring(2));
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      conflicted.push(parts.slice(8).join(' '));
    }

    i++;
  }

  return { staged, unstaged, untracked, conflicted, branch, upstream, ahead, behind };
}

function statusCodeToString(code: string): FileStatusEntry['status'] {
  switch (code) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return 'modified';
  }
}

export function parseFileChanges(output: string): FileChange[] {
  if (!output.trim()) return [];

  // Parse output from git diff --numstat -z combined with --name-status
  // We use --numstat format: "additions\tdeletions\tpath"
  const lines = output.trim().split('\n');
  return lines.map(line => {
    const parts = line.split('\t');
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0] ?? '0', 10);
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1] ?? '0', 10);
    const binary = parts[0] === '-' && parts[1] === '-';

    let path: string;
    let oldPath: string | null = null;
    let status: FileChange['status'] = 'modified';

    if (parts.length >= 4) {
      // Renamed: "additions\tdeletions\toldPath\tnewPath"
      oldPath = parts[2] ?? null;
      path = parts[3] ?? '';
      status = 'renamed';
    } else {
      path = parts[2] ?? '';
    }

    return { path, oldPath, status, additions, deletions, binary };
  });
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx esbuild src/extension/extension.ts --bundle --outfile=/dev/null --external:vscode --format=cjs --platform=node`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/utils/git-parser.ts
git commit -m "feat: add git output parser (log, branches, tags, status, file changes)"
```

---

### Task 4: GitService — orchestrate CLI + parser + expose methods

**Files:**
- Create: `src/extension/services/git.service.ts`

**Interfaces:**
- Consumes: `GitCLI` from `git-cli.ts`, parser functions from `git-parser.ts`, types from `git.types.ts`
- Produces:
  - `GitService` class:
    - `constructor(repoPath: string)`
    - `log(options?: GitLogOptions): Promise<Commit[]>`
    - `branches(): Promise<Branch[]>`
    - `tags(): Promise<Tag[]>`
    - `show(hash: string): Promise<{ commit: Commit; files: FileChange[] }>`
    - `status(): Promise<GitStatus>`
    - `diff(ref1: string, ref2: string): Promise<DiffResult>`
    - `getRepoPath(): string`
    - `setRepoPath(path: string): void`
  - Static `findRepo(startPath: string): Promise<string | null>`

- [ ] **Step 1: Create GitService**

Create `src/extension/services/git.service.ts`:

```typescript
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
```

- [ ] **Step 2: Verify compilation**

Run: `npx esbuild src/extension/extension.ts --bundle --outfile=/dev/null --external:vscode --format=cjs --platform=node`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/services/git.service.ts
git commit -m "feat: add GitService orchestrating CLI + parser for log, branches, tags, status, diff"
```

---

### Task 5: Wire GitService into MessageRouter + update webview

**Files:**
- Modify: `src/extension/extension.ts` (create GitService, register `git` namespace handler)
- Modify: `src/webview/App.svelte` (fetch and display branch list + recent commits on mount)

**Interfaces:**
- Consumes: `GitService` from `git.service.ts`, `MessageRouter.register` from Phase 1, `MessageBridge.send` from webview
- Produces:
  - `git.*` namespace handler that routes `git.log`, `git.branches`, `git.tags`, `git.status`, `git.show`, `git.diff` to GitService methods
  - Webview shows branch list and last 10 commits on open

- [ ] **Step 1: Update extension.ts to create and register GitService**

Replace the content of `src/extension/extension.ts`:

```typescript
import * as vscode from 'vscode';
import { GitGraphWebviewProvider } from './providers/webview-provider';
import { MessageRouter } from './controllers/message-router';
import { GitService } from './services/git.service';
import type { GitLogOptions } from './types/git.types';

let webviewProvider: GitGraphWebviewProvider;

export function activate(context: vscode.ExtensionContext): void {
  const router = new MessageRouter();

  // Determine repo path from workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  let gitService: GitService | null = null;

  if (workspaceFolders && workspaceFolders.length > 0) {
    const rootPath = workspaceFolders[0].uri.fsPath;
    gitService = new GitService(rootPath);
  }

  // Register git namespace handler
  router.register('git', async (method: string, params: unknown) => {
    if (!gitService) {
      throw new Error('No git repository found in workspace');
    }

    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'git.log':
        return gitService.log(p as GitLogOptions);
      case 'git.branches':
        return gitService.branches();
      case 'git.tags':
        return gitService.tags();
      case 'git.status':
        return gitService.status();
      case 'git.show':
        return gitService.show(p.hash as string);
      case 'git.diff':
        return gitService.diff(p.ref1 as string, p.ref2 as string);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  // Keep ping for testing
  router.register('ping', async () => {
    return { pong: true, timestamp: Date.now() };
  });

  webviewProvider = new GitGraphWebviewProvider(context.extensionUri, router);

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    webviewProvider.openPanel();
  });

  context.subscriptions.push(openCommand);
}

export function deactivate(): void {
  // cleanup
}
```

- [ ] **Step 2: Update App.svelte to display git data**

Replace `src/webview/App.svelte`:

```svelte
<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount } from 'svelte';

  interface Branch {
    name: string;
    current: boolean;
    hash: string;
  }

  interface Commit {
    abbreviatedHash: string;
    subject: string;
    author: string;
    authorDate: string;
    refs: string[];
  }

  let status = 'Connecting...';
  let branches: Branch[] = [];
  let commits: Commit[] = [];
  let error = '';

  onMount(async () => {
    try {
      // Test connection
      await bridge.send('ping.hello');
      status = 'Connected';

      // Load git data
      const [branchData, logData] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('git.log', { maxCount: 20, all: true }) as Promise<Commit[]>
      ]);

      branches = branchData;
      commits = logData;
      status = `Connected — ${branches.length} branches, ${commits.length} commits loaded`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'Error';
    }
  });
</script>

<div class="container">
  <header class="toolbar">
    <h1>Git Graph Pro</h1>
    <span class="status">{status}</span>
  </header>

  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <main class="content">
    <aside class="sidebar">
      <h2>Branches ({branches.length})</h2>
      <ul class="branch-list">
        {#each branches as branch}
          <li class:current={branch.current}>
            {#if branch.current}<span class="indicator">●</span>{/if}
            {branch.name}
          </li>
        {/each}
      </ul>
    </aside>

    <section class="graph-area">
      <h2>Recent Commits</h2>
      <table class="commit-table">
        <thead>
          <tr>
            <th>Hash</th>
            <th>Message</th>
            <th>Author</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {#each commits as commit}
            <tr>
              <td class="hash">{commit.abbreviatedHash}</td>
              <td class="message">
                {#each commit.refs as ref}
                  <span class="ref-badge">{ref}</span>
                {/each}
                {commit.subject}
              </td>
              <td class="author">{commit.author}</td>
              <td class="date">{new Date(commit.authorDate).toLocaleDateString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  </main>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
  }

  .status {
    font-size: 12px;
    opacity: 0.7;
  }

  .error-banner {
    padding: 8px 16px;
    background: var(--error);
    color: var(--bg);
    font-size: 12px;
  }

  .content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .sidebar {
    width: 200px;
    border-right: 1px solid var(--border);
    padding: 8px;
    overflow-y: auto;
  }

  .sidebar h2 {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .branch-list {
    list-style: none;
    font-size: 13px;
  }

  .branch-list li {
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }

  .branch-list li:hover {
    background: var(--hover-bg);
  }

  .branch-list li.current {
    font-weight: 600;
  }

  .indicator {
    color: var(--success);
    margin-right: 4px;
  }

  .graph-area {
    flex: 1;
    padding: 8px 16px;
    overflow: auto;
  }

  .graph-area h2 {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .commit-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .commit-table th {
    text-align: left;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    opacity: 0.7;
  }

  .commit-table td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hash {
    font-family: monospace;
    color: var(--accent);
    width: 70px;
  }

  .message {
    max-width: 400px;
  }

  .author {
    opacity: 0.7;
    width: 120px;
  }

  .date {
    opacity: 0.5;
    width: 90px;
  }

  .ref-badge {
    display: inline-block;
    background: var(--accent);
    color: var(--bg);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    margin-right: 4px;
  }
</style>
```

- [ ] **Step 3: Verify full build**

Run: `npm run build`
Expected: Both host and webview build without errors.

- [ ] **Step 4: Commit**

```bash
git add src/extension/extension.ts src/webview/App.svelte
git commit -m "feat: wire GitService into MessageRouter, webview shows branches and commits"
```

---

## Verification Checklist (Phase 2 Complete When:)

- [ ] `npm run build` succeeds with no errors
- [ ] Extension loads in Extension Development Host
- [ ] Opening "Git Graph Pro" in a git repo shows branch list in sidebar
- [ ] Shows last 20 commits in a table (hash, message, author, date)
- [ ] Ref badges (branch/tag names) display on relevant commits
- [ ] Current branch highlighted in sidebar
- [ ] Opening in a non-git folder shows appropriate error message
- [ ] GitCLI queues commands (no concurrent git processes)
- [ ] GitCLI handles timeout and missing git gracefully

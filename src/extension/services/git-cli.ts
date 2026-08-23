import { spawn } from 'child_process';
import { GitErrorCode } from '../types/git.types';

export interface GitCLIOptions {
  timeout?: number;    // ms, default 30000
  stdin?: string;      // input to pipe to git process
  cwd?: string;        // override repo path for this call
  env?: Record<string, string>;  // additional env vars
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
      const proc = spawn('git', ['-c', 'core.quotePath=false', ...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
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

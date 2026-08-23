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
  ahead: number;            // commits ahead of upstream
  behind: number;           // commits behind upstream
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
  revisions?: string[];     // resolved commit OIDs for a stable history snapshot
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


export interface StashEntry {
  index: number;
  message: string;
  date: string;       // ISO 8601
  branch: string;     // branch where stash was created
  hash: string;       // stash commit hash
}

export interface WorktreeEntry {
  path: string;
  head: string;       // commit hash HEAD points to
  branch: string | null; // null if detached HEAD
  bare: boolean;
  isMain: boolean;    // true for the main worktree
}

export type SubmoduleState = 'initialized' | 'uninitialized' | 'modified' | 'conflicted';

export interface SubmoduleEntry {
  name: string;
  path: string;
  absolutePath: string;
  head: string | null;
  state: SubmoduleState;
}

export type SubmoduleListEntry = Omit<SubmoduleEntry, 'absolutePath'>;

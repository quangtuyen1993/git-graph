# Merge & Rebase Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make merge and rebase usable end-to-end — full option surface (no-ff / ff-only / squash / `--onto` / autostash), rebase onto remote branches and arbitrary commits, and a persistent conflict banner with Continue / Skip / Abort backed by a filesystem-derived operation state.

**Architecture:** A new `operation-state.ts` reads `.git` (`MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) and is the single source of truth for "an operation is in progress". `GitService.merge`/`rebase` stop throwing on conflict and return an `OperationOutcome` carrying that state. The existing `.git` FileSystemWatcher gains the operation files and emits `git.operationChanged`, so the webview banner stays correct even when the conflict was created from a terminal. Conflict resolution delegates to VS Code's built-in merge editor.

**Tech Stack:** TypeScript (strict), Svelte 4, Vitest, @testing-library/svelte, VS Code Extension API

**Spec:** `docs/superpowers/specs/2026-08-25-merge-rebase-workflow-design.md`

## Global Constraints

- `npm test` (vitest run) must pass; `npm run typecheck` (`tsc --noEmit`) must pass; `npm run build` must succeed. `npm run check` runs all of these plus coverage.
- Coverage thresholds from `vitest.config.ts` apply to files in its `include` list: statements 80, lines 80, functions 80, branches 70. **`src/extension/services/operation-state.ts` must be added to that list** (Task 2) and must meet the thresholds.
- Git commands must never open an interactive editor. Any `--continue` invocation runs with `GIT_EDITOR=true` and `GIT_SEQUENCE_EDITOR=true`.
- Never parse human-readable `git status` / stderr text to detect state — it is locale-dependent. Read `.git` files or ask git a machine-readable question. (Precedent: `src/extension/services/git.service.ts:238`.)
- Long-running git operations use `REBASE_TIMEOUT_MS` (120000), not the 30s `GitCLI` default.
- Every new `git.*` / `ui.*` mutation method must be added to `MUTATION_REQUEST_METHODS` in `src/webview/lib/message-bridge.ts:29` so the webview does not impose its own 30s deadline.
- Minimum supported git is 2.14 (the `--autostash` floor for `git merge`).

**Spec refinement made explicit here:** the spec suggested `git name-rev --name-only MERGE_HEAD` for the merge `incoming` label. This plan reads `.git/MERGE_MSG` instead, so `readOperationState` stays pure-filesystem (no git spawn), which makes it directly unit-testable and avoids a subprocess on every watcher tick. Behaviour is equivalent for the UI label.

---

### Task 1: Typed error kind reaches the webview

Today `GitCLIError.code` is a **numeric** enum (`src/extension/types/git.types.ts:83`) while `MessageRouter` only forwards `kind` when the thrown error's `code` is a **string** (`src/extension/controllers/message-router.ts:57`). Result: the webview cannot tell a merge conflict from an auth failure. Everything later in this plan depends on that channel working.

**Files:**
- Modify: `src/extension/services/git-cli.ts` (add `kind` to `GitCLIError`, add `classifyKind`)
- Modify: `src/extension/controllers/message-router.ts:53-60`
- Create: `tests/extension/git-cli-error-kind.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type GitErrorKind = 'NOT_A_REPO' | 'MERGE_CONFLICT' | 'REBASE_CONFLICT' | 'PUSH_REJECTED' | 'BRANCH_EXISTS' | 'BRANCH_NOT_FOUND' | 'DIRTY_WORKING_TREE' | 'DETACHED_HEAD' | 'LOCK_FILE_EXISTS' | 'AUTH_FAILED' | 'TIMEOUT' | 'GIT_NOT_FOUND' | 'UNKNOWN'`
  - `GitCLIError` gains `public readonly kind: GitErrorKind`.

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-cli-error-kind.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GitCLIError } from '../../src/extension/services/git-cli';
import { GitErrorCode } from '../../src/extension/types/git.types';
import { MessageRouter } from '../../src/extension/controllers/message-router';
import type { Request, Response } from '../../src/extension/types/messages.types';

function fakeHost() {
  let receive: ((message: Request) => void) | undefined;
  const postMessage = vi.fn();
  return {
    host: {
      webview: {
        postMessage,
        onDidReceiveMessage: (callback: (message: Request) => void) => {
          receive = callback;
          return { dispose: vi.fn() };
        },
      },
    },
    postMessage,
    send: (message: Request) => receive?.(message),
  };
}

describe('GitCLIError.kind', () => {
  it('carries a string kind alongside the numeric code', () => {
    const error = new GitCLIError(GitErrorCode.MERGE_CONFLICT, 'boom', 'CONFLICT (content): Merge conflict in a.txt');
    expect(error.code).toBe(GitErrorCode.MERGE_CONFLICT);
    expect(error.kind).toBe('MERGE_CONFLICT');
  });

  it('defaults to UNKNOWN for an unclassified code', () => {
    expect(new GitCLIError(GitErrorCode.UNKNOWN, 'boom').kind).toBe('UNKNOWN');
  });

  it('forwards the kind through MessageRouter so the webview can branch on it', async () => {
    const { host, postMessage, send } = fakeHost();
    const router = new MessageRouter();
    router.setHost(host as never);
    router.register('git', async () => {
      throw new GitCLIError(GitErrorCode.AUTH_FAILED, 'auth failed', '');
    });

    send({ id: '1', type: 'request', method: 'git.push' });

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    const response = postMessage.mock.calls[0][0] as Response;
    expect(response.error?.kind).toBe('AUTH_FAILED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/git-cli-error-kind.test.ts`
Expected: FAIL — `error.kind` is `undefined`.

- [ ] **Step 3: Implement**

In `src/extension/types/git.types.ts`, after the `GitErrorCode` enum, add:

```ts
export type GitErrorKind =
  | 'NOT_A_REPO' | 'MERGE_CONFLICT' | 'REBASE_CONFLICT' | 'PUSH_REJECTED'
  | 'BRANCH_EXISTS' | 'BRANCH_NOT_FOUND' | 'DIRTY_WORKING_TREE' | 'DETACHED_HEAD'
  | 'LOCK_FILE_EXISTS' | 'AUTH_FAILED' | 'TIMEOUT' | 'GIT_NOT_FOUND' | 'UNKNOWN';
```

In `src/extension/services/git-cli.ts`, replace the `GitCLIError` class:

```ts
import { GitErrorCode, type GitErrorKind } from '../types/git.types';

const KIND_BY_CODE: Record<GitErrorCode, GitErrorKind> = {
  [GitErrorCode.NOT_A_REPO]: 'NOT_A_REPO',
  [GitErrorCode.MERGE_CONFLICT]: 'MERGE_CONFLICT',
  [GitErrorCode.REBASE_CONFLICT]: 'REBASE_CONFLICT',
  [GitErrorCode.PUSH_REJECTED]: 'PUSH_REJECTED',
  [GitErrorCode.BRANCH_EXISTS]: 'BRANCH_EXISTS',
  [GitErrorCode.BRANCH_NOT_FOUND]: 'BRANCH_NOT_FOUND',
  [GitErrorCode.DIRTY_WORKING_TREE]: 'DIRTY_WORKING_TREE',
  [GitErrorCode.DETACHED_HEAD]: 'DETACHED_HEAD',
  [GitErrorCode.LOCK_FILE_EXISTS]: 'LOCK_FILE_EXISTS',
  [GitErrorCode.AUTH_FAILED]: 'AUTH_FAILED',
  [GitErrorCode.TIMEOUT]: 'TIMEOUT',
  [GitErrorCode.GIT_NOT_FOUND]: 'GIT_NOT_FOUND',
  [GitErrorCode.UNKNOWN]: 'UNKNOWN',
};

export class GitCLIError extends Error {
  /**
   * `code` is a numeric enum, and MessageRouter only forwards a string `code`
   * or `kind` to the webview. Without this string twin every git failure
   * reaches the UI as prose, so the UI cannot tell a conflict from an auth
   * failure.
   */
  public readonly kind: GitErrorKind;

  constructor(
    public readonly code: GitErrorCode,
    message: string,
    public readonly stderr: string = ''
  ) {
    super(message);
    this.name = 'GitCLIError';
    this.kind = KIND_BY_CODE[code] ?? 'UNKNOWN';
  }
}
```

In `src/extension/controllers/message-router.ts`, replace the `kind` derivation inside `handleMessage`'s catch block:

```ts
        // A thrown error may carry a stable string discriminator, either as a
        // string `code` (see BranchNotFullyMergedError) or as `kind`
        // (GitCLIError, whose `code` is a numeric enum). Pass it through so the
        // webview reacts to the kind of failure, not to message text.
        const candidate = (err as { kind?: unknown; code?: unknown }) ?? {};
        const kind = typeof candidate.kind === 'string'
          ? candidate.kind
          : typeof candidate.code === 'string'
            ? candidate.code
            : undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/git-cli-error-kind.test.ts tests/extension/message-router.test.ts tests/webview/app-delete-branch.test.ts`
Expected: PASS (the delete-branch test proves the existing string-`code` path still works).

- [ ] **Step 5: Commit**

```bash
git add src/extension/types/git.types.ts src/extension/services/git-cli.ts src/extension/controllers/message-router.ts tests/extension/git-cli-error-kind.test.ts
git commit -m "fix(git): give GitCLIError a string kind so the webview can branch on failures"
```

---

### Task 2: Read merge state from `.git`

**Files:**
- Create: `src/extension/services/operation-state.ts`
- Modify: `tests/helpers/temp-git-repo.ts` (add `execGitAllowFailure`, `gitDir`)
- Create: `tests/extension/operation-state.integration.test.ts`
- Modify: `vitest.config.ts` (add the new service to `coverage.include`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type OperationKind = 'merge' | 'rebase' | 'rebase-interactive' | 'cherry-pick' | 'revert' | null`
  - `export interface OperationState { kind: OperationKind; incoming: string | null; onto: string | null; headName: string | null; step: number | null; total: number | null; conflicted: string[]; canContinue: boolean }`
  - `export async function readOperationState(gitDir: string, conflicted: string[]): Promise<OperationState>`
  - Test helper: `repo.execGitAllowFailure(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>` and `repo.gitDir: string`.

- [ ] **Step 1: Add the test helper**

`TempGitRepo.execGit` uses `execFile`, which rejects on a non-zero exit. Creating a conflict *requires* running a git command that fails, so add a tolerant twin. In `tests/helpers/temp-git-repo.ts`, add these methods to the class:

```ts
  public get gitDir(): string {
    return path.join(this.path, '.git');
  }

  /**
   * Creating a conflict means running a git command that exits non-zero.
   * `execGit` rejects on that, so conflict setup needs a tolerant twin.
   */
  public async execGitAllowFailure(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'git',
        ['-c', 'core.quotePath=false', ...args],
        { cwd: this.path },
      );
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
    }
  }

  /** Two branches that both edit the same line, so any integration conflicts. */
  public async createConflictingBranches(): Promise<void> {
    await this.commitFile('Base', 'conflict.txt', 'base\n');
    await this.execGit(['checkout', '-b', 'feature']);
    await this.commitFile('Feature edit', 'conflict.txt', 'feature\n');
    await this.execGit(['checkout', 'main']);
    await this.commitFile('Main edit', 'conflict.txt', 'main\n');
  }
```

- [ ] **Step 2: Write the failing test**

Create `tests/extension/operation-state.integration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOperationState } from '../../src/extension/services/operation-state';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('readOperationState — merge', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports no operation in a clean repository', async () => {
    await repo.commitFile('Base', 'a.txt', 'a\n');

    const state = await readOperationState(repo.gitDir, []);

    expect(state.kind).toBeNull();
    expect(state.canContinue).toBe(false);
    expect(state.step).toBeNull();
    expect(state.total).toBeNull();
  });

  it('reports a conflicted merge with the incoming branch name', async () => {
    await repo.createConflictingBranches();
    const merge = await repo.execGitAllowFailure(['merge', 'feature']);
    expect(merge.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['conflict.txt']);

    expect(state.kind).toBe('merge');
    expect(state.incoming).toContain('feature');
    expect(state.conflicted).toEqual(['conflict.txt']);
    expect(state.canContinue).toBe(false);
  });

  it('allows continue once no conflicted paths remain', async () => {
    await repo.createConflictingBranches();
    await repo.execGitAllowFailure(['merge', 'feature']);

    const state = await readOperationState(repo.gitDir, []);

    expect(state.kind).toBe('merge');
    expect(state.canContinue).toBe(true);
  });

  it('returns a null operation instead of throwing when the git dir is unreadable', async () => {
    const state = await readOperationState('/no/such/git/dir', []);

    expect(state.kind).toBeNull();
    expect(state.conflicted).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/extension/operation-state.integration.test.ts`
Expected: FAIL — cannot resolve `../../src/extension/services/operation-state`.

- [ ] **Step 4: Implement**

Create `src/extension/services/operation-state.ts`:

```ts
import { readFile, stat } from 'fs/promises';
import path from 'path';

export type OperationKind =
  | 'merge' | 'rebase' | 'rebase-interactive' | 'cherry-pick' | 'revert' | null;

export interface OperationState {
  kind: OperationKind;
  /** Ref or subject being applied: "feature", or the subject of the commit being rebased. */
  incoming: string | null;
  /** Commit the branch is being rebased onto. Rebase only. */
  onto: string | null;
  /** Branch being rebased, from rebase-merge/head-name. */
  headName: string | null;
  step: number | null;
  total: number | null;
  conflicted: string[];
  /** No conflicted paths left, so `--continue` can run. */
  canContinue: boolean;
}

const IDLE: Omit<OperationState, 'conflicted' | 'canContinue'> = {
  kind: null, incoming: null, onto: null, headName: null, step: null, total: null,
};

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readTrimmed(file: string): Promise<string | null> {
  try {
    const value = (await readFile(file, 'utf8')).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function readNumber(file: string): Promise<number | null> {
  const raw = await readTrimmed(file);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readFirstLine(file: string): Promise<string | null> {
  const raw = await readTrimmed(file);
  return raw === null ? null : (raw.split('\n')[0] ?? null);
}

function shortenRef(ref: string | null): string | null {
  return ref === null ? null : ref.replace(/^refs\/heads\//, '');
}

/**
 * The single source of truth for "an operation is in progress". Reads `.git`
 * rather than parsing `git status`, whose output is translated and would break
 * under a non-English locale (same reason as GitService.deleteBranch).
 *
 * Never throws: a panel without a banner beats a panel that crashes.
 */
export async function readOperationState(
  gitDir: string,
  conflicted: string[],
): Promise<OperationState> {
  const detected = await detect(gitDir);
  return {
    ...detected,
    conflicted,
    canContinue: detected.kind !== null && conflicted.length === 0,
  };
}

async function detect(gitDir: string): Promise<Omit<OperationState, 'conflicted' | 'canContinue'>> {
  const at = (...parts: string[]) => path.join(gitDir, ...parts);

  if (await exists(at('rebase-merge'))) {
    return {
      kind: (await exists(at('rebase-merge', 'interactive'))) ? 'rebase-interactive' : 'rebase',
      incoming: await readFirstLine(at('rebase-merge', 'message')),
      onto: await readTrimmed(at('rebase-merge', 'onto')),
      headName: shortenRef(await readTrimmed(at('rebase-merge', 'head-name'))),
      step: await readNumber(at('rebase-merge', 'msgnum')),
      total: await readNumber(at('rebase-merge', 'end')),
    };
  }

  if (await exists(at('rebase-apply'))) {
    // `git am` shares this directory with rebase. `applying` tells them apart,
    // and an am session is not a rebase the UI can continue as one.
    if (await exists(at('rebase-apply', 'applying'))) return { ...IDLE };
    return {
      kind: 'rebase',
      incoming: null,
      onto: await readTrimmed(at('rebase-apply', 'onto')),
      headName: shortenRef(await readTrimmed(at('rebase-apply', 'head-name'))),
      step: await readNumber(at('rebase-apply', 'next')),
      total: await readNumber(at('rebase-apply', 'last')),
    };
  }

  if (await exists(at('MERGE_HEAD'))) {
    return {
      ...IDLE,
      kind: 'merge',
      incoming: await readFirstLine(at('MERGE_MSG')) ?? await readTrimmed(at('MERGE_HEAD')),
    };
  }

  if (await exists(at('CHERRY_PICK_HEAD'))) {
    return {
      ...IDLE,
      kind: 'cherry-pick',
      incoming: await readFirstLine(at('MERGE_MSG')) ?? await readTrimmed(at('CHERRY_PICK_HEAD')),
    };
  }

  if (await exists(at('REVERT_HEAD'))) {
    return {
      ...IDLE,
      kind: 'revert',
      incoming: await readFirstLine(at('MERGE_MSG')) ?? await readTrimmed(at('REVERT_HEAD')),
    };
  }

  return { ...IDLE };
}
```

- [ ] **Step 5: Add the file to coverage tracking**

In `vitest.config.ts`, add to `coverage.include`, immediately after `'src/extension/services/graph.service.ts',`:

```ts
        'src/extension/services/operation-state.ts',
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/extension/operation-state.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/extension/services/operation-state.ts tests/helpers/temp-git-repo.ts tests/extension/operation-state.integration.test.ts vitest.config.ts
git commit -m "feat(git): read in-progress merge state from .git"
```

---

### Task 3: Detect rebase, interactive rebase, cherry-pick and revert

Task 2 implemented the whole detector; this task proves the remaining branches and locks them with tests. If a branch is wrong, fix it here.

**Files:**
- Modify: `src/extension/services/operation-state.ts` (only if a test exposes a defect)
- Modify: `tests/extension/operation-state.integration.test.ts`

**Interfaces:**
- Consumes: `readOperationState(gitDir, conflicted)` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `tests/extension/operation-state.integration.test.ts`:

```ts
describe('readOperationState — rebase, cherry-pick, revert', () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports a conflicted rebase with step, total, head-name and onto', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);
    const rebase = await repo.execGitAllowFailure(['rebase', 'main']);
    expect(rebase.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['conflict.txt']);

    expect(state.kind).toBe('rebase');
    expect(state.headName).toBe('feature');
    expect(state.onto).toMatch(/^[0-9a-f]{40}$/);
    expect(state.step).toBe(1);
    expect(state.total).toBe(1);
    expect(state.canContinue).toBe(false);
  });

  it('distinguishes an interactive rebase from a plain one', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);
    const rebase = await repo.execGitAllowFailure([
      '-c', 'sequence.editor=true', 'rebase', '--interactive', 'main',
    ]);
    expect(rebase.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['conflict.txt']);

    expect(state.kind).toBe('rebase-interactive');
  });

  it('reports a conflicted cherry-pick', async () => {
    await repo.createConflictingBranches();
    const featureHash = (await repo.execGit(['rev-parse', 'feature'])).trim();
    const pick = await repo.execGitAllowFailure(['cherry-pick', featureHash]);
    expect(pick.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['conflict.txt']);

    expect(state.kind).toBe('cherry-pick');
  });

  it('reports a conflicted revert', async () => {
    await repo.commitFile('Base', 'r.txt', 'one\n');
    const target = await repo.commitFile('Second', 'r.txt', 'two\n');
    await repo.commitFile('Third', 'r.txt', 'three\n');
    const revert = await repo.execGitAllowFailure(['revert', '--no-edit', target]);
    expect(revert.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['r.txt']);

    expect(state.kind).toBe('revert');
  });

  it('reads next/last when the rebase backend is rebase-apply', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);
    const rebase = await repo.execGitAllowFailure(['rebase', '--apply', 'main']);
    expect(rebase.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['conflict.txt']);

    expect(state.kind).toBe('rebase');
    expect(state.headName).toBe('feature');
    expect(state.step).toBe(1);
    expect(state.total).toBe(1);
  });

  it('does not mistake a git am session for a rebase', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');
    await repo.execGit(['checkout', '-b', 'patched']);
    await repo.commitFile('Patch', 'a.txt', 'patched\n');
    const patch = await repo.execGit(['format-patch', '-1', '--stdout']);
    await repo.execGit(['checkout', 'main']);
    await repo.commitFile('Diverge', 'a.txt', 'diverged\n');
    await repo.writeFile('change.patch', patch);
    const am = await repo.execGitAllowFailure(['am', '--3way', 'change.patch']);
    expect(am.code).not.toBe(0);

    const state = await readOperationState(repo.gitDir, ['a.txt']);

    expect(state.kind).toBeNull();
  });
});
```

This needs one more helper. Add to `tests/helpers/temp-git-repo.ts`:

```ts
  public async writeFile(filePath: string, contents: string): Promise<void> {
    await writeFile(path.join(this.path, filePath), contents, 'utf8');
  }
```

- [ ] **Step 2: Run tests to see which branches are wrong**

Run: `npx vitest run tests/extension/operation-state.integration.test.ts`
Expected: all 10 tests PASS if Task 2 was implemented exactly as written. If any fail, fix `detect()` in `operation-state.ts` — do **not** weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/extension/operation-state.integration.test.ts tests/helpers/temp-git-repo.ts src/extension/services/operation-state.ts
git commit -m "test(git): lock rebase, cherry-pick, revert and am detection"
```

---

### Task 4: Expose the state to the webview

**Files:**
- Modify: `src/extension/services/git.service.ts` (add `operationState()`)
- Modify: `src/extension/controllers/git-method-handler.ts` (add `git.operationState`)
- Modify: `src/extension/extension.ts:219-232` (watcher pattern + `git.operationChanged`)
- Modify: `tests/extension/extension-view-session.test.ts:316` (existing pattern assertion)
- Modify: `tests/extension/git-method-handler.test.ts`

**Interfaces:**
- Consumes: `readOperationState` (Task 2).
- Produces:
  - `GitService.operationState(): Promise<OperationState>`
  - Host method `git.operationState` → `OperationState`
  - Event `git.operationChanged` (no payload)

- [ ] **Step 1: Write the failing tests**

Append to `tests/extension/git-method-handler.test.ts` (inside its existing top-level `describe`):

```ts
  it('routes git.operationState to the service', async () => {
    const state = {
      kind: 'rebase', incoming: 'x', onto: 'abc', headName: 'feature',
      step: 2, total: 5, conflicted: ['a.txt'], canContinue: false,
    };
    const service = { operationState: vi.fn(async () => state) };

    await expect(handleGitMethod(service as never, 'git.operationState', {})).resolves.toBe(state);
    expect(service.operationState).toHaveBeenCalledTimes(1);
  });
```

In `tests/extension/extension-view-session.test.ts`, update the existing assertion at line 316 and add a new test after the watcher test:

```ts
    expect(hostMocks.createFileSystemWatcher.mock.calls[0][0]).toMatchObject({
      base: '/git/root',
      pattern: '{HEAD,refs/**,index,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}',
    });
```

```ts
  it('emits git.operationChanged alongside git.refsChanged when the git dir changes', async () => {
    const view = await activateAndResolveView();
    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    const watcher = hostMocks.createFileSystemWatcher.mock.results[0].value;
    view.webview.postMessage.mockClear();

    watcher.fireChange();
    await vi.advanceTimersByTimeAsync(500);

    const events = view.webview.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; event?: string })
      .filter((message) => message.type === 'event')
      .map((message) => message.event);
    expect(events).toContain('git.refsChanged');
    expect(events).toContain('git.operationChanged');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/git-method-handler.test.ts tests/extension/extension-view-session.test.ts`
Expected: FAIL — unknown method `git.operationState`; watcher pattern mismatch; no `git.operationChanged`.

- [ ] **Step 3: Implement the service method**

In `src/extension/services/git.service.ts`, add the import and a method next to `status()`:

```ts
import { readOperationState, type OperationState } from './operation-state';
```

```ts
  public async operationState(): Promise<OperationState> {
    const [gitDir, status] = await Promise.all([
      this.gitDirectory().catch(() => ''),
      this.status().catch(() => ({ conflicted: [] as string[] })),
    ]);
    if (!gitDir) return readOperationState('', []);
    return readOperationState(gitDir, status.conflicted);
  }
```

- [ ] **Step 4: Implement the host method**

In `src/extension/controllers/git-method-handler.ts`, add before `case 'git.show':`:

```ts
    case 'git.operationState':
      return gitService.operationState();
```

- [ ] **Step 5: Implement the watcher change**

In `src/extension/extension.ts`, replace the `createFileSystemWatcher` pattern and extend `requestRefresh`:

```ts
        gitWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            gitDirectory,
            '{HEAD,refs/**,index,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}',
          ),
        );
```

```ts
    function requestRefresh(): void {
      if (!isVisible()) {
        refreshPending = true;
        return;
      }
      router.sendEvent('git.refsChanged');
      router.sendEvent('graph.invalidated');
      // A conflict created from a terminal never passes through this webview.
      // Watching the operation files is the only way the banner learns about it.
      router.sendEvent('git.operationChanged');
    }
```

- [ ] **Step 6: Allow the method through the bridge**

In `src/webview/lib/message-bridge.ts`, `git.operationState` is a read, so it keeps the default 30s deadline — **no allowlist change needed for this task**. Verify no change was made.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/extension/git-method-handler.test.ts tests/extension/extension-view-session.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts src/extension/extension.ts tests/extension/git-method-handler.test.ts tests/extension/extension-view-session.test.ts
git commit -m "feat(git): expose operation state and watch the operation files"
```

---

### Task 5: Merge options, with conflict as a result

**Files:**
- Modify: `src/extension/services/git.service.ts:265-270`
- Modify: `src/extension/controllers/git-method-handler.ts:47-49`
- Modify: `src/webview/App.svelte:1215` (call-site keeps compiling)
- Create: `tests/extension/git-merge.integration.test.ts`

**Interfaces:**
- Consumes: `GitService.operationState()` (Task 4), `OperationState` (Task 2).
- Produces:
  - `export type MergeMode = 'default' | 'noFF' | 'ffOnly' | 'squash'`
  - `export interface MergeOptions { mode?: MergeMode; noCommit?: boolean; message?: string; autostash?: boolean }`
  - `export type OperationOutcome = { status: 'ok' } | { status: 'conflict'; state: OperationState }`
  - `GitService.merge(ref: string, options?: MergeOptions): Promise<OperationOutcome>`
  - Host method `git.merge` params become `{ ref: string; options?: MergeOptions }`

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-merge.integration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.merge', () => {
  let repo: TempGitRepo;
  let git: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    git = new GitService(repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function divergentBranches(): Promise<void> {
    await repo.commitFile('Base', 'a.txt', 'base\n');
    await repo.execGit(['checkout', '-b', 'feature']);
    await repo.commitFile('Feature', 'feature.txt', 'feature\n');
    await repo.execGit(['checkout', 'main']);
    await repo.commitFile('Main', 'main.txt', 'main\n');
  }

  it('fast-forwards by default and reports ok', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');
    await repo.execGit(['checkout', '-b', 'feature']);
    await repo.commitFile('Feature', 'a.txt', 'feature\n');
    await repo.execGit(['checkout', 'main']);

    expect(await git.merge('feature')).toEqual({ status: 'ok' });
    expect(await repo.parentCount('HEAD')).toBe(1);
  });

  it('creates a merge commit with mode noFF', async () => {
    await divergentBranches();

    expect(await git.merge('feature', { mode: 'noFF' })).toEqual({ status: 'ok' });
    expect(await repo.parentCount('HEAD')).toBe(2);
  });

  it('throws with mode ffOnly when the histories diverged', async () => {
    await divergentBranches();

    await expect(git.merge('feature', { mode: 'ffOnly' })).rejects.toThrow();
  });

  it('stages the squashed result without committing with mode squash', async () => {
    await divergentBranches();
    const before = await repo.commitCount();

    expect(await git.merge('feature', { mode: 'squash' })).toEqual({ status: 'ok' });
    expect(await repo.commitCount()).toBe(before);
    expect(await repo.execGit(['diff', '--cached', '--name-only'])).toContain('feature.txt');
  });

  it('returns a conflict outcome carrying the operation state instead of throwing', async () => {
    await repo.createConflictingBranches();

    const outcome = await git.merge('feature');

    expect(outcome.status).toBe('conflict');
    if (outcome.status !== 'conflict') throw new Error('expected conflict');
    expect(outcome.state.kind).toBe('merge');
    expect(outcome.state.conflicted).toEqual(['conflict.txt']);
    expect(outcome.state.canContinue).toBe(false);
  });

  it('merges over a dirty working tree with autostash and restores the change', async () => {
    await divergentBranches();
    await repo.writeFile('a.txt', 'dirty\n');

    expect(await git.merge('feature', { mode: 'noFF', autostash: true })).toEqual({ status: 'ok' });
    expect(await repo.readFile('a.txt')).toBe('dirty\n');
  });
});
```

Add the last helper to `tests/helpers/temp-git-repo.ts`:

```ts
  public async readFile(filePath: string): Promise<string> {
    return readFile(path.join(this.path, filePath), 'utf8');
  }
```

and extend its import to `import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/git-merge.integration.test.ts`
Expected: FAIL — `merge` resolves to `undefined`, and the conflict case rejects.

- [ ] **Step 3: Implement**

In `src/extension/services/git.service.ts`, replace `merge` and add the shared runner:

```ts
export type MergeMode = 'default' | 'noFF' | 'ffOnly' | 'squash';

export interface MergeOptions {
  mode?: MergeMode;
  noCommit?: boolean;
  /** Ignored when mode is 'squash' — git rejects -m for a merge that will not commit. */
  message?: string;
  autostash?: boolean;
}

export type OperationOutcome =
  | { status: 'ok' }
  | { status: 'conflict'; state: OperationState };
```

```ts
  public async merge(ref: string, options: MergeOptions = {}): Promise<OperationOutcome> {
    const args = ['merge'];
    if (options.autostash) args.push('--autostash');
    if (options.mode === 'noFF') args.push('--no-ff');
    if (options.mode === 'ffOnly') args.push('--ff-only');
    if (options.mode === 'squash') args.push('--squash');
    if (options.noCommit) args.push('--no-commit');
    if (options.message && options.mode !== 'squash') args.push('-m', options.message);
    args.push(ref);
    return this.runOperation(args);
  }

  /**
   * A conflict is a valid result, not a failure: throwing it would push every
   * caller down its error path, and the error path's default is a toast that
   * vanishes — which is how the repo used to end up mid-merge with a silent UI.
   * Genuine failures (bad ref, no network, dirty tree without autostash) still
   * throw.
   */
  private async runOperation(
    args: string[],
    env?: Record<string, string>,
  ): Promise<OperationOutcome> {
    try {
      await this.cli.exec(args, { timeout: REBASE_TIMEOUT_MS, ...(env ? { env } : {}) });
    } catch (error) {
      const state = await this.operationState();
      if (state.kind !== null || state.conflicted.length > 0) return { status: 'conflict', state };
      throw error;
    }

    // `merge --squash` conflicts without writing MERGE_HEAD, so kind stays null
    // while the tree is unmergeable. Conflicted paths are the broader signal.
    const state = await this.operationState();
    if (state.conflicted.length > 0) return { status: 'conflict', state };
    return { status: 'ok' };
  }
```

In `src/extension/controllers/git-method-handler.ts`, replace the `git.merge` case:

```ts
    case 'git.merge':
      return gitService.merge(p.ref as string, p.options as MergeOptions | undefined);
```

and import the type: `import type { MergeOptions } from '../services/git.service';`

In `src/webview/App.svelte:1215`, update the call-site so the build keeps passing:

```js
          case 'merge':
            await runMutation('git.merge', { ref: branchName });
            break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/git-merge.integration.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts src/webview/App.svelte tests/extension/git-merge.integration.test.ts tests/helpers/temp-git-repo.ts
git commit -m "feat(git): merge modes and conflict as an outcome"
```

---

### Task 6: Rebase options, including `--onto`

**Files:**
- Modify: `src/extension/services/git.service.ts:272-274`
- Modify: `src/extension/controllers/git-method-handler.ts:51-53`
- Modify: `src/webview/App.svelte:1218`
- Create: `tests/extension/git-rebase.integration.test.ts`

**Interfaces:**
- Consumes: `runOperation`, `OperationOutcome` (Task 5).
- Produces:
  - `export interface RebaseOptions { upstream: string; onto?: string; branch?: string; autostash?: boolean }`
  - `GitService.rebase(options: RebaseOptions): Promise<OperationOutcome>` — **replaces** `rebase(onto: string)`
  - Host method `git.rebase` params become `RebaseOptions`

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-rebase.integration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.rebase', () => {
  let repo: TempGitRepo;
  let git: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    git = new GitService(repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('replays the current branch onto the upstream', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');
    await repo.execGit(['checkout', '-b', 'feature']);
    await repo.commitFile('Feature', 'feature.txt', 'feature\n');
    await repo.execGit(['checkout', 'main']);
    await repo.commitFile('Main', 'main.txt', 'main\n');
    await repo.execGit(['checkout', 'feature']);

    expect(await git.rebase({ upstream: 'main' })).toEqual({ status: 'ok' });
    expect(await repo.subjects()).toEqual(['Feature', 'Main', 'Base']);
  });

  it('moves only the commits after upstream when onto is given', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');
    await repo.execGit(['checkout', '-b', 'release']);
    await repo.commitFile('Release', 'release.txt', 'release\n');
    await repo.execGit(['checkout', '-b', 'topic']);
    await repo.commitFile('Topic', 'topic.txt', 'topic\n');
    await repo.execGit(['checkout', 'main']);
    await repo.commitFile('Main', 'main.txt', 'main\n');
    await repo.execGit(['checkout', 'topic']);

    expect(await git.rebase({ upstream: 'release', onto: 'main' })).toEqual({ status: 'ok' });
    expect(await repo.subjects()).toEqual(['Topic', 'Main', 'Base']);
  });

  it('returns a conflict outcome with rebase progress instead of throwing', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);

    const outcome = await git.rebase({ upstream: 'main' });

    expect(outcome.status).toBe('conflict');
    if (outcome.status !== 'conflict') throw new Error('expected conflict');
    expect(outcome.state.kind).toBe('rebase');
    expect(outcome.state.headName).toBe('feature');
    expect(outcome.state.step).toBe(1);
    expect(outcome.state.total).toBe(1);
  });

  it('rebases over a dirty working tree with autostash', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');
    await repo.execGit(['checkout', '-b', 'feature']);
    await repo.commitFile('Feature', 'feature.txt', 'feature\n');
    await repo.execGit(['checkout', 'main']);
    await repo.commitFile('Main', 'main.txt', 'main\n');
    await repo.execGit(['checkout', 'feature']);
    await repo.writeFile('a.txt', 'dirty\n');

    expect(await git.rebase({ upstream: 'main', autostash: true })).toEqual({ status: 'ok' });
    expect(await repo.readFile('a.txt')).toBe('dirty\n');
  });

  it('throws for a ref that does not exist', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');

    await expect(git.rebase({ upstream: 'no-such-branch' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/git-rebase.integration.test.ts`
Expected: FAIL — `rebase` takes a string, so the object argument produces `git rebase [object Object]`.

- [ ] **Step 3: Implement**

In `src/extension/services/git.service.ts`, replace `rebase`:

```ts
export interface RebaseOptions {
  /** Replay commits that are on HEAD but not on this ref. */
  upstream: string;
  /** New base, for `git rebase --onto <onto> <upstream> [branch]`. */
  onto?: string;
  branch?: string;
  autostash?: boolean;
}
```

```ts
  public async rebase(options: RebaseOptions): Promise<OperationOutcome> {
    const args = ['rebase'];
    if (options.autostash) args.push('--autostash');
    if (options.onto) args.push('--onto', options.onto);
    args.push(options.upstream);
    if (options.branch) args.push(options.branch);
    return this.runOperation(args);
  }
```

In `src/extension/controllers/git-method-handler.ts`:

```ts
    case 'git.rebase':
      return gitService.rebase(p as unknown as RebaseOptions);
```

with `import type { MergeOptions, RebaseOptions } from '../services/git.service';`

In `src/webview/App.svelte:1218`:

```js
          case 'rebase':
            await runMutation('git.rebase', { upstream: branchName });
            break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/git-rebase.integration.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts src/webview/App.svelte tests/extension/git-rebase.integration.test.ts
git commit -m "feat(git): rebase with --onto, autostash and conflict outcome"
```

---

### Task 7: Continue, skip and abort

**Files:**
- Modify: `src/extension/services/git.service.ts` (remove `abortMerge`/`abortRebase`, add three methods)
- Modify: `src/extension/controllers/git-method-handler.ts` (remove two cases, add three)
- Modify: `src/webview/lib/message-bridge.ts:29-53` (allowlist)
- Create: `tests/extension/git-operation-control.integration.test.ts`

**Interfaces:**
- Consumes: `operationState()` (Task 4), `runOperation` (Task 5).
- Produces:
  - `GitService.continueOperation(): Promise<OperationOutcome>`
  - `GitService.skipOperation(): Promise<OperationOutcome>`
  - `GitService.abortOperation(): Promise<void>`
  - Host methods `git.continueOperation`, `git.skipOperation`, `git.abortOperation`
  - `git.abortMerge` and `git.abortRebase` are **removed**.

- [ ] **Step 1: Write the failing test**

Create `tests/extension/git-operation-control.integration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService operation control', () => {
  let repo: TempGitRepo;
  let git: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    git = new GitService(repo.path);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('rejects continue when nothing is in progress', async () => {
    await repo.commitFile('Base', 'a.txt', 'base\n');

    await expect(git.continueOperation()).rejects.toThrow(/no git operation/i);
  });

  it('finishes a conflicted merge after the conflict is resolved, without opening an editor', async () => {
    await repo.createConflictingBranches();
    expect((await git.merge('feature')).status).toBe('conflict');

    await repo.writeFile('conflict.txt', 'resolved\n');
    await repo.execGit(['add', 'conflict.txt']);

    // Fails by timing out (120s) rather than by assertion if GIT_EDITOR is unset.
    expect(await git.continueOperation()).toEqual({ status: 'ok' });
    expect((await git.operationState()).kind).toBeNull();
    expect(await repo.parentCount('HEAD')).toBe(2);
  }, 20000);

  it('finishes a conflicted rebase and clears the state', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);
    expect((await git.rebase({ upstream: 'main' })).status).toBe('conflict');

    await repo.writeFile('conflict.txt', 'resolved\n');
    await repo.execGit(['add', 'conflict.txt']);

    expect(await git.continueOperation()).toEqual({ status: 'ok' });
    expect((await git.operationState()).kind).toBeNull();
  }, 20000);

  it('drops the conflicting commit on skip', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);
    expect((await git.rebase({ upstream: 'main' })).status).toBe('conflict');

    expect(await git.skipOperation()).toEqual({ status: 'ok' });
    expect((await git.operationState()).kind).toBeNull();
    expect(await repo.subjects()).toEqual(['Main edit', 'Base']);
  }, 20000);

  it('refuses to skip a merge, which has no skip step', async () => {
    await repo.createConflictingBranches();
    expect((await git.merge('feature')).status).toBe('conflict');

    await expect(git.skipOperation()).rejects.toThrow(/skip/i);
  });

  it('restores the previous HEAD on abort', async () => {
    await repo.createConflictingBranches();
    await repo.execGit(['checkout', 'feature']);
    const before = (await repo.execGit(['rev-parse', 'HEAD'])).trim();
    expect((await git.rebase({ upstream: 'main' })).status).toBe('conflict');

    await git.abortOperation();

    expect((await repo.execGit(['rev-parse', 'HEAD'])).trim()).toBe(before);
    expect((await git.operationState()).kind).toBeNull();
  }, 20000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/git-operation-control.integration.test.ts`
Expected: FAIL — `continueOperation is not a function`.

- [ ] **Step 3: Implement**

In `src/extension/services/git.service.ts`, delete `abortMerge()` and `abortRebase()` and add:

```ts
const NON_INTERACTIVE_EDITOR_ENV = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
};

const GIT_COMMAND_BY_KIND: Record<Exclude<OperationKind, null>, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'rebase-interactive': 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
};
```

```ts
  /**
   * Every `--continue` opens $GIT_EDITOR to let you edit the commit message.
   * GitCLI spawns with piped stdio and no tty, so an unset editor leaves git
   * waiting for input until the timeout kills it mid-operation. Forcing `true`
   * keeps the default message and returns immediately.
   */
  public async continueOperation(): Promise<OperationOutcome> {
    const command = await this.requireOperationCommand();
    return this.runOperation([command, '--continue'], NON_INTERACTIVE_EDITOR_ENV);
  }

  public async skipOperation(): Promise<OperationOutcome> {
    const state = await this.operationState();
    if (state.kind === null) throw new Error('No Git operation is in progress');
    if (state.kind === 'merge') throw new Error('A merge cannot skip a commit; resolve or abort it');
    return this.runOperation([GIT_COMMAND_BY_KIND[state.kind], '--skip'], NON_INTERACTIVE_EDITOR_ENV);
  }

  public async abortOperation(): Promise<void> {
    const command = await this.requireOperationCommand();
    await this.cli.exec([command, '--abort'], { timeout: REBASE_TIMEOUT_MS });
  }

  private async requireOperationCommand(): Promise<string> {
    const state = await this.operationState();
    if (state.kind === null) throw new Error('No Git operation is in progress');
    return GIT_COMMAND_BY_KIND[state.kind];
  }
```

Import `OperationKind` alongside `OperationState` from `./operation-state`.

In `src/extension/controllers/git-method-handler.ts`, delete the `git.abortMerge` and `git.abortRebase` cases and add:

```ts
    case 'git.continueOperation':
      return gitService.continueOperation();
    case 'git.skipOperation':
      return gitService.skipOperation();
    case 'git.abortOperation':
      await gitService.abortOperation();
      return { success: true };
```

In `src/webview/lib/message-bridge.ts`, in `MUTATION_REQUEST_METHODS`, remove `'git.abortMerge'` and `'git.abortRebase'` and add:

```ts
  'git.continueOperation',
  'git.skipOperation',
  'git.abortOperation',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/extension/git-operation-control.integration.test.ts tests/webview/message-bridge.test.ts && npx tsc --noEmit`
Expected: PASS. Each conflict test finishes in seconds — a test that hangs to its 20s limit means `GIT_EDITOR` was not applied.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts src/webview/lib/message-bridge.ts tests/extension/git-operation-control.integration.test.ts
git commit -m "feat(git): continue, skip and abort dispatched by operation kind"
```

---

### Task 8: Resolve a single file, and open VS Code's merge editor

**Files:**
- Modify: `src/extension/services/git.service.ts` (add `resolveFile`)
- Modify: `src/extension/controllers/git-method-handler.ts` (add `git.resolveFile`)
- Modify: `src/extension/extension.ts` (add `ui.openMergeEditor` next to `ui.openFolder`)
- Modify: `src/webview/lib/message-bridge.ts` (allowlist `git.resolveFile`)
- Create: `tests/extension/git-resolve-file.integration.test.ts`
- Modify: `tests/extension/extension-view-session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export type ConflictResolution = 'ours' | 'theirs' | 'staged'`
  - `GitService.resolveFile(filePath: string, resolution: ConflictResolution): Promise<void>`
  - Host methods `git.resolveFile` (`{ path, resolution }`) and `ui.openMergeEditor` (`{ path }`)

- [ ] **Step 1: Write the failing tests**

Create `tests/extension/git-resolve-file.integration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.resolveFile', () => {
  let repo: TempGitRepo;
  let git: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    git = new GitService(repo.path);
    await repo.createConflictingBranches();
    expect((await git.merge('feature')).status).toBe('conflict');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('keeps our side and stages the file', async () => {
    await git.resolveFile('conflict.txt', 'ours');

    expect(await repo.readFile('conflict.txt')).toBe('main\n');
    expect((await git.operationState()).conflicted).toEqual([]);
  });

  it('keeps their side and stages the file', async () => {
    await git.resolveFile('conflict.txt', 'theirs');

    expect(await repo.readFile('conflict.txt')).toBe('feature\n');
    expect((await git.operationState()).conflicted).toEqual([]);
  });

  it('stages the working-tree content as resolved', async () => {
    await repo.writeFile('conflict.txt', 'hand written\n');

    await git.resolveFile('conflict.txt', 'staged');

    expect((await git.operationState()).conflicted).toEqual([]);
    expect(await repo.execGit(['show', ':conflict.txt'])).toBe('hand written\n');
  });
});
```

Append to `tests/extension/extension-view-session.test.ts` (inside the existing describe):

```ts
  it('opens the VS Code merge editor and falls back to a plain open', async () => {
    const view = await activateAndResolveView();
    hostMocks.executeCommand.mockReset();
    hostMocks.executeCommand.mockRejectedValueOnce(new Error('command not found'));

    view.receive({
      id: 'merge-editor',
      type: 'request',
      method: 'ui.openMergeEditor',
      params: { path: 'src/a.ts' },
    });

    await vi.waitFor(() => expect(hostMocks.executeCommand).toHaveBeenCalledTimes(2));
    expect(hostMocks.executeCommand.mock.calls[0][0]).toBe('git.openMergeEditor');
    expect(hostMocks.executeCommand.mock.calls[1][0]).toBe('vscode.open');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/extension/git-resolve-file.integration.test.ts tests/extension/extension-view-session.test.ts`
Expected: FAIL — `resolveFile is not a function`; unknown method `ui.openMergeEditor`.

- [ ] **Step 3: Implement the service method**

In `src/extension/services/git.service.ts`:

```ts
export type ConflictResolution = 'ours' | 'theirs' | 'staged';
```

```ts
  /**
   * `--` separates the path from anything git could read as a revision, so a
   * file literally named `HEAD` still resolves as a path.
   */
  public async resolveFile(filePath: string, resolution: ConflictResolution): Promise<void> {
    if (resolution !== 'staged') {
      await this.cli.exec(['checkout', `--${resolution}`, '--', filePath]);
    }
    await this.cli.exec(['add', '--', filePath]);
  }
```

- [ ] **Step 4: Implement the host methods**

In `src/extension/controllers/git-method-handler.ts`:

```ts
    case 'git.resolveFile':
      await gitService.resolveFile(p.path as string, p.resolution as ConflictResolution);
      return { success: true };
```

with `ConflictResolution` added to the type import from `../services/git.service`.

In `src/extension/extension.ts`, add a case next to `ui.openFolder`:

```ts
        case 'ui.openMergeEditor': {
          const { path: relativePath } = (params ?? {}) as { path?: string };
          const gitService = session.getGitService();
          if (!relativePath || !gitService) return { success: false };
          const uri = vscode.Uri.file(path.join(gitService.getRepoPath(), relativePath));
          try {
            // Owned by the built-in vscode.git extension, which the user may
            // have disabled. A missing neighbour must not break this feature.
            await vscode.commands.executeCommand('git.openMergeEditor', uri);
          } catch {
            await vscode.commands.executeCommand('vscode.open', uri);
          }
          return { success: true };
        }
```

Ensure `path` is imported in `extension.ts` (add `import path from 'path';` if absent).

In `src/webview/lib/message-bridge.ts`, add `'git.resolveFile'` to `MUTATION_REQUEST_METHODS`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/extension/git-resolve-file.integration.test.ts tests/extension/extension-view-session.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extension/services/git.service.ts src/extension/controllers/git-method-handler.ts src/extension/extension.ts src/webview/lib/message-bridge.ts tests/extension/git-resolve-file.integration.test.ts tests/extension/extension-view-session.test.ts
git commit -m "feat(git): per-file conflict resolution and VS Code merge editor handoff"
```

---

### Task 9: The operation banner

**Files:**
- Create: `src/webview/components/actions/OperationBanner.svelte`
- Create: `tests/webview/operation-banner.test.ts`
- Modify: `vitest.config.ts` (`coverage.include`)

**Interfaces:**
- Consumes: the `OperationState` shape (Task 2) as a plain prop — the component imports no host code, so it stays renderable in isolation.
- Produces:
  - `<OperationBanner {state} on:continue on:skip on:abort on:showConflicts />`
  - Props: `state: OperationState | null`, `busy: boolean`
  - Renders nothing when `state` is null, or when `state.kind` is null **and** `state.conflicted` is empty.

- [ ] **Step 1: Write the failing test**

Create `tests/webview/operation-banner.test.ts`:

```ts
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OperationBanner from '../../src/webview/components/actions/OperationBanner.svelte';

const base = {
  kind: null as string | null,
  incoming: null as string | null,
  onto: null as string | null,
  headName: null as string | null,
  step: null as number | null,
  total: null as number | null,
  conflicted: [] as string[],
  canContinue: false,
};

describe('OperationBanner', () => {
  afterEach(cleanup);

  it('renders nothing when the repository is idle', () => {
    const { container } = render(OperationBanner, { props: { state: { ...base }, busy: false } });

    expect(container.querySelector('.operation-banner')).toBeNull();
  });

  it('describes a rebase with its progress and disables continue while conflicted', () => {
    render(OperationBanner, {
      props: {
        state: { ...base, kind: 'rebase', headName: 'feature', onto: 'origin/main', step: 3, total: 7, conflicted: ['a.txt', 'b.txt'] },
        busy: false,
      },
    });

    expect(screen.getByRole('status').textContent).toContain('feature');
    expect(screen.getByRole('status').textContent).toContain('origin/main');
    expect(screen.getByRole('status').textContent).toContain('3/7');
    expect(screen.getByRole('status').textContent).toContain('2 files');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('enables continue and emits the event once conflicts are cleared', async () => {
    const onContinue = vi.fn();
    const { component } = render(OperationBanner, {
      props: { state: { ...base, kind: 'rebase', headName: 'feature', canContinue: true }, busy: false },
    });
    component.$on('continue', onContinue);

    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeEnabled();
    await fireEvent.click(button);

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('hides skip for a merge, which has no skip step', () => {
    render(OperationBanner, {
      props: { state: { ...base, kind: 'merge', incoming: "Merge branch 'feature'", canContinue: true }, busy: false },
    });

    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('shows skip for a rebase', () => {
    render(OperationBanner, {
      props: { state: { ...base, kind: 'rebase', headName: 'feature', conflicted: ['a.txt'] }, busy: false },
    });

    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });

  it('warns about leftover conflicts with no operation, offering no continue or abort', () => {
    render(OperationBanner, { props: { state: { ...base, conflicted: ['a.txt'] }, busy: false } });

    expect(screen.getByRole('status').textContent).toContain('Unresolved conflicts');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();
  });

  it('disables every control while a git command is running', () => {
    render(OperationBanner, {
      props: { state: { ...base, kind: 'rebase', headName: 'feature', canContinue: true }, busy: true },
    });

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/operation-banner.test.ts`
Expected: FAIL — cannot resolve `OperationBanner.svelte`.

- [ ] **Step 3: Implement**

Create `src/webview/components/actions/OperationBanner.svelte`:

```svelte
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Icon from '../common/Icon.svelte';

  interface BannerState {
    kind: string | null;
    incoming: string | null;
    onto: string | null;
    headName: string | null;
    step: number | null;
    total: number | null;
    conflicted: string[];
    canContinue: boolean;
  }

  export let state: BannerState | null = null;
  export let busy = false;

  const dispatch = createEventDispatcher();

  const VERBS: Record<string, string> = {
    merge: 'Merging',
    rebase: 'Rebasing',
    'rebase-interactive': 'Rebasing (interactive)',
    'cherry-pick': 'Cherry-picking',
    revert: 'Reverting',
  };

  $: kind = state?.kind ?? null;
  $: conflicted = state?.conflicted ?? [];
  // An operation-less conflict is real: `merge --squash` and a failed autostash
  // pop both leave conflicts with no MERGE_HEAD to continue from.
  $: orphanConflicts = kind === null && conflicted.length > 0;
  $: visible = kind !== null || orphanConflicts;
  $: skippable = kind !== null && kind !== 'merge';

  $: summary = (() => {
    if (orphanConflicts) return 'Unresolved conflicts';
    if (kind === null) return '';
    const target = state?.headName ?? state?.incoming ?? '';
    const onto = state?.onto ? ` onto ${state.onto}` : '';
    return `${VERBS[kind] ?? kind} ${target}${onto}`.trim();
  })();

  $: progress = state?.step !== null && state?.total !== null && state !== null
    ? `${state.step}/${state.total}`
    : '';

  $: conflictLabel = conflicted.length === 1
    ? '1 file conflicted'
    : `${conflicted.length} files conflicted`;
</script>

{#if visible}
  <div class="operation-banner" class:orphan={orphanConflicts}>
    <span class="operation-icon"><Icon name="warning" size={14} /></span>
    <span class="operation-summary" role="status" aria-live="polite">
      {summary}{#if progress} — {progress}{/if}{#if conflicted.length > 0} · {conflictLabel}{/if}
    </span>
    <div class="operation-actions">
      {#if conflicted.length > 0}
        <button type="button" on:click={() => dispatch('showConflicts')}>Show conflicts</button>
      {/if}
      {#if kind !== null}
        <button
          type="button"
          disabled={busy || !state?.canContinue}
          title={state?.canContinue ? '' : `Resolve first: ${conflicted.join(', ')}`}
          on:click={() => dispatch('continue')}
        >Continue</button>
        {#if skippable}
          <button type="button" disabled={busy} on:click={() => dispatch('skip')}>Skip</button>
        {/if}
        <button type="button" class="danger" disabled={busy} on:click={() => dispatch('abort')}>Abort</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .operation-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: 12px;
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    color: var(--vscode-foreground, #ccc);
  }

  .operation-summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .operation-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .operation-actions button {
    padding: 2px 10px;
    font-size: 12px;
    color: var(--vscode-button-secondaryForeground, #ccc);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }

  .operation-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .operation-actions button.danger {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  }
</style>
```

If `Icon.svelte` has no `warning` glyph, add one following the existing pattern in `src/webview/lib/icons.ts` rather than inventing a new icon mechanism.

- [ ] **Step 4: Add the component to coverage tracking**

In `vitest.config.ts`, add after `'src/webview/components/actions/ContextMenu.svelte',`:

```ts
        'src/webview/components/actions/OperationBanner.svelte',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/webview/operation-banner.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/actions/OperationBanner.svelte tests/webview/operation-banner.test.ts vitest.config.ts src/webview/lib/icons.ts
git commit -m "feat(webview): operation banner with continue, skip and abort"
```

---

### Task 10: Wire the banner into App.svelte

**Files:**
- Modify: `src/webview/App.svelte` (state, event subscription, handlers, markup, conflict list)
- Create: `tests/webview/app-operation-banner.test.ts`

**Interfaces:**
- Consumes: `OperationBanner` (Task 9); host methods `git.operationState`, `git.continueOperation`, `git.skipOperation`, `git.abortOperation`, `git.resolveFile`, `ui.openMergeEditor` (Tasks 4, 7, 8); event `git.operationChanged` (Task 4).
- Produces: `operationState` reactive variable consumed by Task 11 to disable menu items.

- [ ] **Step 1: Write the failing test**

Create `tests/webview/app-operation-banner.test.ts`:

```ts
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

const idleState = {
  kind: null, incoming: null, onto: null, headName: null,
  step: null, total: null, conflicted: [], canContinue: false,
};

const rebaseState = {
  kind: 'rebase', incoming: 'Feature edit', onto: 'origin/main', headName: 'feature',
  step: 1, total: 1, conflicted: ['conflict.txt'], canContinue: false,
};

function mockHost(operationState: unknown) {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation((method: string) => {
    switch (method) {
      case 'ping.hello': return Promise.resolve({ ok: true });
      case 'repo.list': return Promise.resolve({ repos: [{ name: 'repo', path: '/repo', active: true }] });
      case 'git.branches': case 'git.tags': case 'git.stashList':
      case 'git.worktreeList': case 'git.submoduleList': return Promise.resolve([]);
      case 'git.status': return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
      case 'git.operationState': return Promise.resolve(operationState);
      case 'graph.build': return Promise.resolve({ totalRows: 0, maxLane: 0, layoutVersion: 1 });
      case 'graph.getWindow': return Promise.resolve({ nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 0, maxLane: 0 });
      default: return Promise.resolve(undefined);
    }
  });
}

async function renderApp() {
  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  return render(App);
}

describe('App operation banner', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('shows no banner when the repository is idle', async () => {
    mockHost(idleState);
    const { container } = await renderApp();

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.operationState', expect.anything()));
    expect(container.querySelector('.operation-banner')).toBeNull();
  });

  it('shows the banner for an in-progress rebase', async () => {
    mockHost(rebaseState);
    await renderApp();

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('feature'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeEnabled();
  });

  it('re-reads the state when the host reports git.operationChanged', async () => {
    mockHost(idleState);
    await renderApp();
    await waitFor(() => expect(on).toHaveBeenCalledWith('git.operationChanged', expect.any(Function)));

    const handler = on.mock.calls.find((call) => call[0] === 'git.operationChanged')?.[1] as () => void;
    send.mockClear();
    send.mockImplementation((method: string) =>
      method === 'git.operationState' ? Promise.resolve(rebaseState) : Promise.resolve(undefined));
    handler();

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('feature'));
  });

  it('sends git.continueOperation when Continue is clicked', async () => {
    mockHost({ ...rebaseState, conflicted: [], canContinue: true });
    await renderApp();

    const button = await screen.findByRole('button', { name: 'Continue' });
    await fireEvent.click(button);

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.continueOperation', undefined));
  });

  it('confirms before aborting', async () => {
    mockHost(rebaseState);
    send.mockImplementation((method: string) => {
      if (method === 'git.operationState') return Promise.resolve(rebaseState);
      if (method === 'ui.confirm') return Promise.resolve(false);
      if (method === 'repo.list') return Promise.resolve({ repos: [{ name: 'repo', path: '/repo', active: true }] });
      if (method === 'ping.hello') return Promise.resolve({ ok: true });
      if (method === 'graph.build') return Promise.resolve({ totalRows: 0, maxLane: 0, layoutVersion: 1 });
      if (method === 'graph.getWindow') return Promise.resolve({ nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 0, maxLane: 0 });
      if (method === 'git.status') return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
      return Promise.resolve([]);
    });
    await renderApp();

    await fireEvent.click(await screen.findByRole('button', { name: 'Abort' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.confirm', expect.objectContaining({
      message: expect.stringContaining('Abort'),
    })));
    expect(send).not.toHaveBeenCalledWith('git.abortOperation', undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-operation-banner.test.ts`
Expected: FAIL — `git.operationState` is never requested and no banner renders.

- [ ] **Step 3: Implement**

In `src/webview/App.svelte`, add the import next to the other component imports:

```js
  import OperationBanner from './components/actions/OperationBanner.svelte';
```

Add state next to `mutationProgress` (around line 257):

```js
  let operationState: OperationState | null = null;
  let showConflictList = false;
```

with `import type { OperationState } from '../extension/services/operation-state';` alongside the existing type imports.

Add the loader and subscription. Put the loader next to `refreshGraph` and call it from the same places that refresh:

```js
  /**
   * Never derived from the last command's result: a conflict can be created in
   * a terminal, and the panel must still show it. The host is the only source.
   */
  async function refreshOperationState(): Promise<void> {
    try {
      operationState = await bridge.send('git.operationState', {}) as OperationState;
    } catch {
      operationState = null;
    }
  }
```

In the existing `onMount` block, after the initial refresh, add:

```js
    await refreshOperationState();
    const offOperationChanged = bridge.on('git.operationChanged', () => { void refreshOperationState(); });
```

and add `offOperationChanged();` to the same cleanup path that disposes the other `bridge.on` subscriptions.

Add the three handlers next to the other mutation handlers:

```js
  async function handleOperationContinue(): Promise<void> {
    await runDirectMutation('Continuing…', () => bridge.send('git.continueOperation') as Promise<void>);
    await refreshOperationState();
    await refreshGraph();
  }

  async function handleOperationSkip(): Promise<void> {
    await runDirectMutation('Skipping…', () => bridge.send('git.skipOperation') as Promise<void>);
    await refreshOperationState();
    await refreshGraph();
  }

  async function handleOperationAbort(): Promise<void> {
    const confirmed = await bridge.send('ui.confirm', {
      message: `Abort the in-progress ${operationState?.kind ?? 'operation'}? Work done during it is discarded.`,
    }) as boolean;
    if (!confirmed) return;
    await runDirectMutation('Aborting…', () => bridge.send('git.abortOperation') as Promise<void>);
    await refreshOperationState();
    await refreshGraph();
  }

  async function openConflict(conflictPath: string): Promise<void> {
    await bridge.send('ui.openMergeEditor', { path: conflictPath });
  }

  async function resolveConflict(
    conflictPath: string,
    resolution: 'ours' | 'theirs' | 'staged',
  ): Promise<void> {
    await runDirectMutation(
      'Resolving…',
      () => bridge.send('git.resolveFile', { path: conflictPath, resolution }) as Promise<void>,
    );
    await refreshOperationState();
  }
```

Wrap each of these five in the same `try/catch` that the neighbouring handlers use to set `error`.

In the markup, insert between `</header>` and `{#if error}` (around line 1462):

```svelte
  <OperationBanner
    state={operationState}
    busy={mutationProgress !== null}
    on:continue={handleOperationContinue}
    on:skip={handleOperationSkip}
    on:abort={handleOperationAbort}
    on:showConflicts={() => { showConflictList = !showConflictList; }}
  />
  {#if showConflictList && operationState && operationState.conflicted.length > 0}
    <ul class="conflict-list">
      {#each operationState.conflicted as conflictPath (conflictPath)}
        <li>
          <button type="button" class="conflict-path" on:click={() => openConflict(conflictPath)}>
            {conflictPath}
          </button>
          <button type="button" on:click={() => resolveConflict(conflictPath, 'ours')}>Ours</button>
          <button type="button" on:click={() => resolveConflict(conflictPath, 'theirs')}>Theirs</button>
          <button type="button" on:click={() => resolveConflict(conflictPath, 'staged')}>Mark resolved</button>
        </li>
      {/each}
    </ul>
  {/if}
```

Add matching styles in the component's `<style>` block, following the existing `.error-banner` rules for colours and spacing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/webview/app-operation-banner.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify the full suite still passes**

Run: `npx vitest run`
Expected: PASS. If an existing App test now fails because it does not stub `git.operationState`, add the stub to that test's `send.mockImplementation` — the App legitimately requests it now.

- [ ] **Step 6: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-operation-banner.test.ts tests/webview
git commit -m "feat(webview): wire the operation banner and conflict list into the graph panel"
```

---

### Task 11: Context menu entry points

**Files:**
- Modify: `src/webview/App.svelte:704-760` (`handleBranchContextMenu`), `:668-690` (commit menu), `:1214-1220` (actions), `:943` (`mutationLabels`)
- Create: `tests/webview/app-merge-rebase-menu.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–10.
- Produces: no new interfaces.

- [ ] **Step 1: Write the failing test**

Create `tests/webview/app-merge-rebase-menu.test.ts`:

```ts
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

const idleState = {
  kind: null, incoming: null, onto: null, headName: null,
  step: null, total: null, conflicted: [], canContinue: false,
};

const branches = [
  { name: 'main', current: true, remote: null, upstream: 'origin/main', hash: 'a'.repeat(40), lastCommitDate: '2026-01-01T00:00:00Z', ahead: 0, behind: 0 },
  { name: 'origin/main', current: false, remote: 'origin', upstream: null, hash: 'a'.repeat(40), lastCommitDate: '2026-01-01T00:00:00Z', ahead: 0, behind: 0 },
];

function mockHost(operationState: unknown = idleState) {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation((method: string) => {
    switch (method) {
      case 'ping.hello': return Promise.resolve({ ok: true });
      case 'repo.list': return Promise.resolve({ repos: [{ name: 'repo', path: '/repo', active: true }] });
      case 'git.branches': return Promise.resolve(branches);
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return Promise.resolve([]);
      case 'git.status': return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
      case 'git.operationState': return Promise.resolve(operationState);
      case 'graph.build': return Promise.resolve({ totalRows: 0, maxLane: 0, layoutVersion: 1 });
      case 'graph.getWindow': return Promise.resolve({ nodes: [], edges: [], startRow: 0, endRow: 0, totalRows: 0, maxLane: 0 });
      default: return Promise.resolve(undefined);
    }
  });
}

async function openRemoteBranchMenu(operationState: unknown = idleState) {
  mockHost(operationState);
  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  const rendered = render(App);

  const remoteSection = await screen.findByRole('button', { name: /Remote group origin/i });
  await fireEvent.click(remoteSection);
  const row = await screen.findByText('main', { selector: '.branch-name' });
  await fireEvent.contextMenu(row);
  await waitFor(() => expect(rendered.container.querySelector('.context-menu')).toBeTruthy());
  return rendered;
}

describe('merge and rebase menu entries', () => {
  afterEach(() => {
    cleanup();
    send.mockReset();
    on.mockClear();
  });

  it('offers rebase onto a remote branch', async () => {
    await openRemoteBranchMenu();

    expect(screen.getByText('Rebase')).toBeTruthy();
    expect(screen.getByText(/Rebase main onto origin\/main/)).toBeTruthy();
  });

  it('offers every merge mode for a remote branch', async () => {
    await openRemoteBranchMenu();

    await fireEvent.mouseEnter(screen.getByText('Merge'));
    expect(screen.getByText('Merge (no fast-forward)')).toBeTruthy();
    expect(screen.getByText('Merge (fast-forward only)')).toBeTruthy();
    expect(screen.getByText('Merge (squash)')).toBeTruthy();
  });

  it('sends the mode with git.merge', async () => {
    await openRemoteBranchMenu();

    await fireEvent.mouseEnter(screen.getByText('Merge'));
    await fireEvent.click(screen.getByText('Merge (squash)'));

    await waitFor(() => expect(send).toHaveBeenCalledWith('git.merge', {
      ref: 'origin/main',
      options: { mode: 'squash' },
    }));
  });

  it('disables merge and rebase while an operation is in progress', async () => {
    await openRemoteBranchMenu({ ...idleState, kind: 'rebase', headName: 'feature' });

    expect(screen.getByText('Merge').closest('[role="menuitem"]')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Rebase').closest('[role="menuitem"]')).toHaveAttribute('aria-disabled', 'true');
  });
});
```

Before writing assertions against `.branch-name` and `role="menuitem"`, read `src/webview/components/sidebar/BranchSidebar.svelte` and `src/webview/components/actions/ContextMenu.svelte` and match the selectors and ARIA attributes those components actually emit. Adjust the selectors in the test, never the components, unless a component genuinely lacks the ARIA it should have.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-merge-rebase-menu.test.ts`
Expected: FAIL — the remote branch menu has no Rebase entry.

- [ ] **Step 3: Implement the menus**

In `src/webview/App.svelte`, add a helper above `handleBranchContextMenu`:

```js
  $: operationBusy = operationState?.kind != null;
  $: operationBusyReason = operationBusy ? `A ${operationState?.kind} is in progress` : '';

  function mergeSubmenu(targetLabel) {
    return {
      label: 'Merge', action: '', disabled: operationBusy, title: operationBusyReason,
      children: [
        { label: `Merge into ${targetLabel}`, action: 'merge' },
        { label: 'Merge (no fast-forward)', action: 'mergeNoFF' },
        { label: 'Merge (fast-forward only)', action: 'mergeFFOnly' },
        { label: 'Merge (squash)', action: 'mergeSquash' },
      ],
    };
  }

  function rebaseSubmenu(currentName, targetName) {
    return {
      label: 'Rebase', action: '', disabled: operationBusy, title: operationBusyReason,
      children: [
        { label: `Rebase ${currentName} onto ${targetName}`, action: 'rebase' },
        { label: 'Rebase --onto…', action: 'rebaseOnto' },
      ],
    };
  }
```

Replace the remote-branch arm of `handleBranchContextMenu`:

```js
    if (branch.remote) {
      contextMenuItems = [
        { label: 'Checkout', action: 'checkout' },
        mergeSubmenu(currentBranchName),
        rebaseSubmenu(currentBranchName, branch.name),
        { label: '', action: '', divider: true },
        { label: 'Delete remote branch', action: 'deleteRemoteBranch', danger: true },
      ];
    }
```

where `currentBranchName` is `branches.find(b => b.current)?.name ?? 'HEAD'`, computed at the top of the function.

In the local-branch arm, replace the two flat entries:

```js
        { label: 'Merge into current branch', action: 'merge' },
        { label: 'Rebase current onto this', action: 'rebase' },
```

with:

```js
        mergeSubmenu(currentBranchName),
        rebaseSubmenu(currentBranchName, branch.name),
```

In the current-branch arm, add after the Fetch entry:

```js
        { label: '', action: '', divider: true },
        { label: 'Merge branch into this…', action: 'mergePick', disabled: operationBusy, title: operationBusyReason },
        { label: 'Rebase this onto…', action: 'rebasePick', disabled: operationBusy, title: operationBusyReason },
```

In the commit menu (around line 676), add after the Cherry-pick entry:

```js
      { label: 'Rebase current branch onto this commit', action: 'rebaseOntoCommit', disabled: onCurrentBranch || operationBusy },
```

- [ ] **Step 4: Implement the actions**

Add to `mutationLabels` (around line 943):

```js
    mergeNoFF: 'Merging…',
    mergeFFOnly: 'Merging…',
    mergeSquash: 'Squashing merge…',
    mergePick: 'Merging…',
    rebaseOnto: 'Rebasing…',
    rebasePick: 'Rebasing…',
    rebaseOntoCommit: 'Rebasing…',
```

Add a dirty-tree gate near the other helpers:

```js
  /**
   * Returns null when the user declines, so callers can abandon quietly.
   * Autostash is git's own flag, so git also restores the change on abort.
   */
  async function confirmAutostash(progress) {
    const status = await bridge.send('git.status', {}) as { staged: unknown[]; unstaged: unknown[] };
    if (status.staged.length === 0 && status.unstaged.length === 0) return false;
    progress?.awaitConfirmation();
    const confirmed = await bridge.send('ui.confirm', {
      message: 'You have uncommitted changes. Stash them, run the operation, then restore?',
    }) as boolean;
    return confirmed ? true : null;
  }
```

In the `contextMenuTarget.type === 'branch'` switch, replace `case 'merge':` and `case 'rebase':` with:

```js
          case 'merge':
          case 'mergeNoFF':
          case 'mergeFFOnly':
          case 'mergeSquash': {
            const mode = action === 'mergeNoFF' ? 'noFF'
              : action === 'mergeFFOnly' ? 'ffOnly'
              : action === 'mergeSquash' ? 'squash'
              : 'default';
            const autostash = await confirmAutostash(progress);
            if (autostash === null) break;
            await runMutation('git.merge', { ref: branchName, options: { mode, ...(autostash ? { autostash } : {}) } });
            await refreshOperationState();
            break;
          }
          case 'mergePick': {
            const picked = await bridge.send('ui.pickBranch', { prompt: 'Merge which branch into the current one?' }) as string | null;
            if (!picked) break;
            const autostash = await confirmAutostash(progress);
            if (autostash === null) break;
            await runMutation('git.merge', { ref: picked, options: { mode: 'default', ...(autostash ? { autostash } : {}) } });
            await refreshOperationState();
            break;
          }
          case 'rebase': {
            const autostash = await confirmAutostash(progress);
            if (autostash === null) break;
            await runMutation('git.rebase', { upstream: branchName, ...(autostash ? { autostash } : {}) });
            await refreshOperationState();
            break;
          }
          case 'rebaseOnto': {
            const newBase = await bridge.send('ui.pickBranch', { prompt: `Replay commits after ${branchName} onto which branch?` }) as string | null;
            if (!newBase) break;
            const autostash = await confirmAutostash(progress);
            if (autostash === null) break;
            await runMutation('git.rebase', { upstream: branchName, onto: newBase, ...(autostash ? { autostash } : {}) });
            await refreshOperationState();
            break;
          }
          case 'rebasePick': {
            const upstream = await bridge.send('ui.pickBranch', { prompt: 'Rebase the current branch onto which branch?' }) as string | null;
            if (!upstream) break;
            const autostash = await confirmAutostash(progress);
            if (autostash === null) break;
            await runMutation('git.rebase', { upstream, ...(autostash ? { autostash } : {}) });
            await refreshOperationState();
            break;
          }
```

In the commit arm of the same switch, add:

```js
          case 'rebaseOntoCommit': {
            const autostash = await confirmAutostash(progress);
            if (autostash === null) break;
            await runMutation('git.rebase', { upstream: hash, ...(autostash ? { autostash } : {}) });
            await refreshOperationState();
            break;
          }
```

`ui.pickBranch` already exists at `src/extension/extension.ts:357`; confirm its params before use and match them.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/webview/app-merge-rebase-menu.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the whole check**

Run: `npm run check`
Expected: tests pass, coverage thresholds met, typecheck clean, build succeeds. If `operation-state.ts` or `OperationBanner.svelte` falls under threshold, add the missing-branch tests rather than lowering the threshold.

- [ ] **Step 7: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-merge-rebase-menu.test.ts
git commit -m "feat(webview): merge and rebase entry points for remote, local, current branch and commits"
```

---

## Manual verification checklist

Run these in a real VS Code window (`npm run build`, then F5) after Task 11:

- [ ] Right-click `origin/main` in the sidebar → **Rebase ▸ Rebase main onto origin/main** exists and works.
- [ ] Right-click a local branch → **Merge ▸ Merge (squash)** stages without committing.
- [ ] Cause a real conflict → banner appears with the correct verb, branch, step count and file count.
- [ ] Click a conflicted file → VS Code's 3-way merge editor opens.
- [ ] Resolve in the merge editor and save → banner's **Continue** becomes enabled on its own, with no refresh.
- [ ] Click **Continue** → banner disappears, graph refreshes.
- [ ] Start a conflicting rebase **from a terminal**, then look at the panel → the banner is there.
- [ ] While the banner is up, right-click a branch → merge and rebase entries are disabled with a tooltip.
- [ ] **Abort** asks for confirmation and restores the previous HEAD.
- [ ] With uncommitted changes, start a merge → the stash prompt appears; accepting preserves the change afterwards.

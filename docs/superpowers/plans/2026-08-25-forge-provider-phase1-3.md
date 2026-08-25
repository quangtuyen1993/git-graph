# Forge Provider Layer — Phases 1-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a repository's Bitbucket Cloud pull requests inside the graph sidebar, tied to the branches they came from, behind a provider-neutral interface that a GitHub implementation can later satisfy without changes above it.

**Architecture:** A `ForgeProvider` interface plus a registry that maps a parsed git remote to an implementation. Bitbucket Cloud is the first implementation: REST API 2.0 over HTTP Basic with a scoped Atlassian API token, held in VS Code SecretStorage behind a `vscode.AuthenticationProvider`. A per-repository cache with TTLs sits between the provider and a `forge` message-router namespace consumed by both webviews.

**Tech Stack:** TypeScript, Svelte 4, VS Code Extension API ≥1.85, vitest (node + jsdom), global `fetch` (Node 18).

**Spec:** `docs/superpowers/specs/2026-08-25-forge-provider-bitbucket-design.md`

## Global Constraints

- The forge layer is **additive**: any forge failure is contained in the PR section and its detail panel. The graph, diff viewer and AI review must behave exactly as they do today.
- **Tokens never reach the webview.** All API calls run in the extension host; the webview receives mapped domain objects only. No token value is ever written to a log, including error logs.
- **No provider vocabulary above `forge/bitbucket/`.** Everything else speaks the neutral model in `forge.types.ts`.
- **No background polling.** Bitbucket Cloud allows roughly 1000 requests/hour.
- **No test contacts a live API.**
- Required Atlassian API token scopes, quoted verbatim in the sign-in prompt: `read:account`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`.
- Every new source file is added to the `coverage.include` list in `vitest.config.ts`; thresholds stay at statements 80 / lines 80 / functions 80 / branches 70.
- `vscode` is not importable under vitest. Every test touching it starts with `vi.mock('vscode', () => ({ ... }))`, following `tests/extension/review-runner.test.ts`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/extension/services/forge/forge.types.ts` | Neutral domain model, `ForgeProvider`, `ForgeCapabilities`, `ForgeSession`, `ForgeError` |
| `src/extension/services/forge/remote-url.ts` | `parseRemoteUrl(url) → ParsedRemote \| undefined` |
| `src/extension/services/forge/forge-registry.ts` | `ForgeRegistry.resolve(remote) → ForgeProvider \| undefined` |
| `src/extension/services/forge/forge-store.ts` | TTL cache returning `{ value, stale, fetchedAt }` |
| `src/extension/services/forge/bitbucket/bitbucket-auth.ts` | `BitbucketAuthProvider implements vscode.AuthenticationProvider` |
| `src/extension/services/forge/bitbucket/bitbucket-api.ts` | HTTP, concurrency cap of 4, 429 backoff, `ForgeError` translation |
| `src/extension/services/forge/bitbucket/bitbucket-mapper.ts` | Bitbucket JSON → neutral model |
| `src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts` | `ForgeProvider` implementation (read half in these phases) |
| `src/extension/controllers/forge-method-handler.ts` | `forge` namespace |
| `src/webview/components/sidebar/PullRequestList.svelte` | The `PULL REQUESTS` section body |
| `src/webview/components/detail/PullRequestDetail.svelte` | Right-hand detail panel for one PR |
| `tests/helpers/fake-forge-provider.ts` | `FakeForgeProvider` used by controller and UI tests |
| `tests/fixtures/bitbucket/*.json` | Captured Bitbucket responses |

**Modified**

| File | Change |
|---|---|
| `src/extension/services/git.service.ts` | `getRemoteUrl(remote?)` |
| `src/extension/extension.ts:263-268`, `:443` | Register the `forge` namespace on **both** hosts |
| `src/webview/components/sidebar/BranchSidebar.svelte` | Seventh section, collapsed by default |
| `src/webview/lib/sidebar-state.ts` | Persist the new section's expand state |
| `src/webview/App.svelte` | PR selection → detail panel, `#123` branch badge |
| `package.json` | `contributes.authentication`, `gitGraphPro.forge.remote` |
| `vitest.config.ts` | `coverage.include` additions |

---

## Task 1: Parse a git remote URL

**Files:**
- Create: `src/extension/services/forge/remote-url.ts`
- Test: `tests/extension/forge-remote-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface ParsedRemote { host: string; owner: string; name: string }` and `export function parseRemoteUrl(url: string): ParsedRemote | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/forge-remote-url.test.ts
import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../../src/extension/services/forge/remote-url';

describe('parseRemoteUrl', () => {
  it.each([
    ['git@bitbucket.org:acme/mpos.git',            { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['git@bitbucket.org:acme/mpos',                { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['https://tuyen@bitbucket.org/acme/mpos.git',  { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['https://bitbucket.org/acme/mpos',            { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['ssh://git@bitbucket.org/acme/mpos.git',      { host: 'bitbucket.org', owner: 'acme', name: 'mpos' }],
    ['https://github.com/acme/mpos.git',           { host: 'github.com',    owner: 'acme', name: 'mpos' }],
    ['git@bitbucket.org:acme/sub/mpos.git',        { host: 'bitbucket.org', owner: 'acme', name: 'sub/mpos' }],
  ])('parses %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected);
  });

  // Every repository in the workspace runs through this on load, so a bad
  // remote must yield "no provider", never an exception.
  it.each(['', '   ', 'not a url', '/local/path/repo.git', 'file:///srv/repo.git', 'git@host-with-no-path'])(
    'returns undefined for %j', (url) => {
      expect(parseRemoteUrl(url)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/forge-remote-url.test.ts`
Expected: FAIL — `Failed to resolve import ".../remote-url"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/forge/remote-url.ts

/** Host plus the two path segments every forge uses to address a repository. */
export interface ParsedRemote {
  host: string;
  owner: string;
  name: string;
}

// scp-style: git@host:path — the form git writes by default for ssh remotes.
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(.+)$/;

function splitOwnerAndName(rawPath: string): { owner: string; name: string } | undefined {
  const path = rawPath.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const firstSlash = path.indexOf('/');
  if (firstSlash <= 0) return undefined;

  const owner = path.slice(0, firstSlash);
  // Bitbucket project paths can nest, so everything after the workspace is the
  // repository's name — splitting on the last slash would drop those segments.
  const name = path.slice(firstSlash + 1);
  return name ? { owner, name } : undefined;
}

/**
 * Best-effort parse of a git remote. Returns undefined rather than throwing:
 * unparseable and non-forge remotes are the normal case, not an error.
 */
export function parseRemoteUrl(url: string): ParsedRemote | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    // A local clone has no host to attribute to any provider.
    if (!parsed.hostname || parsed.protocol === 'file:') return undefined;
    const split = splitOwnerAndName(parsed.pathname);
    return split ? { host: parsed.hostname, ...split } : undefined;
  }

  const scp = SCP_LIKE.exec(trimmed);
  if (!scp) return undefined;
  const [, , host, path] = scp;
  if (!host || host.includes(' ')) return undefined;
  const split = splitOwnerAndName(path);
  return split ? { host, ...split } : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/forge-remote-url.test.ts`
Expected: PASS, 13 assertions.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/forge/remote-url.ts tests/extension/forge-remote-url.test.ts
git commit -m "feat(forge): parse git remote URLs into host/owner/name"
```

---

## Task 2: Read the remote URL from git

**Files:**
- Modify: `src/extension/services/git.service.ts`
- Test: `tests/extension/git-remote-url.integration.test.ts`

**Interfaces:**
- Consumes: `GitCLI.exec` (already on `GitService` as `this.cli`).
- Produces: `GitService.getRemoteUrl(remote?: string): Promise<string | undefined>` — `undefined` when the remote does not exist.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/git-remote-url.integration.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../src/extension/services/git.service';
import { TempGitRepo } from '../helpers/temp-git-repo';

describe('GitService.getRemoteUrl', () => {
  let repo: TempGitRepo;
  let git: GitService;

  beforeEach(async () => {
    repo = await TempGitRepo.create();
    git = new GitService(repo.path);
  });
  afterEach(async () => { await repo.cleanup(); });

  it('returns undefined when the repository has no remote', async () => {
    expect(await git.getRemoteUrl()).toBeUndefined();
  });

  it('returns origin by default', async () => {
    await repo.execGit(['remote', 'add', 'origin', 'git@bitbucket.org:acme/mpos.git']);
    expect(await git.getRemoteUrl()).toBe('git@bitbucket.org:acme/mpos.git');
  });

  it('returns a named remote', async () => {
    await repo.execGit(['remote', 'add', 'origin', 'git@bitbucket.org:acme/mpos.git']);
    await repo.execGit(['remote', 'add', 'upstream', 'git@bitbucket.org:upstream/mpos.git']);
    expect(await git.getRemoteUrl('upstream')).toBe('git@bitbucket.org:upstream/mpos.git');
  });

  it('returns undefined for a remote that does not exist', async () => {
    expect(await git.getRemoteUrl('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/git-remote-url.integration.test.ts`
Expected: FAIL — `git.getRemoteUrl is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `GitService`, next to `push`/`pull`/`fetch`:

```ts
  /**
   * The configured URL of a remote, or undefined when it is not configured.
   * `git config --get` exits 1 for a missing key, which GitCLI surfaces as a
   * rejection; a repository with no remote is an ordinary state here, not a
   * failure, so it is folded into undefined.
   */
  public async getRemoteUrl(remote = 'origin'): Promise<string | undefined> {
    try {
      const url = await this.cli.exec(['config', '--get', `remote.${remote}.url`]);
      return url.trim() || undefined;
    } catch {
      return undefined;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/git-remote-url.integration.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/git.service.ts tests/extension/git-remote-url.integration.test.ts
git commit -m "feat(git): read a remote's configured URL"
```

---

## Task 3: The forge domain model, registry, and a fake provider

**Files:**
- Create: `src/extension/services/forge/forge.types.ts`, `src/extension/services/forge/forge-registry.ts`, `tests/helpers/fake-forge-provider.ts`
- Test: `tests/extension/forge-registry.test.ts`

**Interfaces:**
- Consumes: `ParsedRemote` from Task 1.
- Produces: the full model from the spec — `ForgeUser`, `ForgeRepoRef`, `PullRequestState`, `ReviewStatus`, `MergeStrategy`, `MergeableState`, `PullRequestSummary`, `PullRequestDetail`, `ForgeComment`, `CreatePullRequestInput`, `ForgeCapabilities`, `ForgeSession`, `ForgeError`, `ForgeProvider`; plus `ForgeRegistry` with `register(provider)` and `resolve(remote): ForgeProvider | undefined`; plus `FakeForgeProvider` for later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/forge-registry.test.ts
import { describe, expect, it } from 'vitest';
import { ForgeRegistry } from '../../src/extension/services/forge/forge-registry';
import { FakeForgeProvider } from '../helpers/fake-forge-provider';

const bitbucket = () => new FakeForgeProvider({ id: 'bitbucket-cloud', name: 'Bitbucket', host: 'bitbucket.org' });
const github = () => new FakeForgeProvider({ id: 'github', name: 'GitHub', host: 'github.com' });

describe('ForgeRegistry', () => {
  it('resolves the provider that claims the host', () => {
    const registry = new ForgeRegistry();
    registry.register(github());
    registry.register(bitbucket());

    const resolved = registry.resolve({ host: 'bitbucket.org', owner: 'acme', name: 'mpos' });
    expect(resolved?.id).toBe('bitbucket-cloud');
  });

  it('returns undefined when no provider claims the host', () => {
    const registry = new ForgeRegistry();
    registry.register(bitbucket());
    expect(registry.resolve({ host: 'gitlab.com', owner: 'acme', name: 'mpos' })).toBeUndefined();
  });

  it('keeps registration order so the first claimant wins', () => {
    const registry = new ForgeRegistry();
    const first = new FakeForgeProvider({ id: 'first', name: 'First', host: 'bitbucket.org' });
    registry.register(first);
    registry.register(bitbucket());
    expect(registry.resolve({ host: 'bitbucket.org', owner: 'a', name: 'b' })?.id).toBe('first');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/forge-registry.test.ts`
Expected: FAIL — cannot resolve `forge-registry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/forge/forge.types.ts
import type { ParsedRemote } from './remote-url';

export type { ParsedRemote };

export interface ForgeUser { displayName: string; accountId: string; avatarUrl?: string }
export interface ForgeRepoRef { owner: string; name: string }

export type PullRequestState = 'open' | 'merged' | 'closed' | 'draft';
export type ReviewStatus     = 'approved' | 'changes_requested' | 'pending';
export type MergeStrategy    = 'merge-commit' | 'squash' | 'fast-forward';
export type MergeableState   = 'clean' | 'conflicted' | 'blocked' | 'unknown';

/** The subset of states that can be asked for. A draft is an open PR. */
export type PullRequestListState = 'open' | 'merged' | 'closed';

export interface PullRequestSummary {
  id: string;
  number: number;
  title: string;
  state: PullRequestState;
  author: ForgeUser;
  sourceBranch: string;
  targetBranch: string;
  reviewers: { user: ForgeUser; status: ReviewStatus }[];
  commentCount: number;
  webUrl: string;
  updatedAt: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  sourceCommit: string;
  targetCommit: string;
  mergeable: MergeableState;
}

export interface ForgeComment {
  id: string;
  author: ForgeUser;
  body: string;
  createdAt: string;
  parentId?: string;
  path?: string;
  line?: number;
}

export interface CreatePullRequestInput {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers?: string[];
  closeSourceBranch?: boolean;
}

export interface ForgeCapabilities {
  createPullRequest: boolean;
  approve: boolean;
  requestChanges: boolean;
  merge: boolean;
  mergeStrategies: MergeStrategy[];
}

/** What a signed-in provider exposes upward. Never carries the credential. */
export interface ForgeSession {
  providerId: string;
  accountLabel: string;
}

/** Every non-2xx response becomes one of these. */
export class ForgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly hostMessage: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(hostMessage);
    this.name = 'ForgeError';
  }
}

export interface ForgeProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ForgeCapabilities;
  canHandle(remote: ParsedRemote): boolean;

  getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined>;
  signOut(): Promise<void>;

  listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]>;
  getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail>;
  getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string>;
  listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]>;

  createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail>;
  setReviewStatus(repo: ForgeRepoRef, id: string, status: 'approved' | 'changes_requested'): Promise<void>;
  merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void>;
}
```

```ts
// src/extension/services/forge/forge-registry.ts
import type { ForgeProvider, ParsedRemote } from './forge.types';

/**
 * Maps a remote to the provider that owns it. Registration order is the
 * resolution order, so a more specific provider can be registered ahead of a
 * catch-all one.
 */
export class ForgeRegistry {
  private readonly providers: ForgeProvider[] = [];

  public register(provider: ForgeProvider): void {
    this.providers.push(provider);
  }

  public resolve(remote: ParsedRemote): ForgeProvider | undefined {
    return this.providers.find((provider) => provider.canHandle(remote));
  }
}
```

```ts
// tests/helpers/fake-forge-provider.ts
import type {
  CreatePullRequestInput, ForgeCapabilities, ForgeComment, ForgeProvider, ForgeRepoRef,
  ForgeSession, MergeStrategy, ParsedRemote, PullRequestDetail, PullRequestListState,
  PullRequestSummary,
} from '../../src/extension/services/forge/forge.types';

export interface FakeForgeOptions {
  id?: string;
  name?: string;
  host?: string;
  session?: ForgeSession | undefined;
  pullRequests?: PullRequestDetail[];
  diff?: string;
  comments?: ForgeComment[];
  capabilities?: Partial<ForgeCapabilities>;
}

export const FAKE_USER = { displayName: 'An Tran', accountId: 'acc-1' };

/** A PullRequestDetail with every field populated, overridable per test. */
export function fakePullRequest(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    id: '123', number: 123, title: 'fix(auth): refresh token race',
    state: 'open', author: FAKE_USER,
    sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
    reviewers: [{ user: FAKE_USER, status: 'approved' }],
    commentCount: 2, webUrl: 'https://bitbucket.org/acme/mpos/pull-requests/123',
    updatedAt: '2026-08-25T10:00:00Z',
    description: 'body', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
    mergeable: 'clean',
    ...overrides,
  };
}

/**
 * An in-memory ForgeProvider. Every controller and UI test runs against this,
 * which is what keeps those tests off the network.
 */
export class FakeForgeProvider implements ForgeProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly capabilities: ForgeCapabilities;
  public readonly calls: { method: string; args: unknown[] }[] = [];

  private session: ForgeSession | undefined;
  private readonly host: string;
  private readonly pullRequests: PullRequestDetail[];
  private readonly diff: string;
  private readonly comments: ForgeComment[];

  constructor(options: FakeForgeOptions = {}) {
    this.id = options.id ?? 'fake';
    this.name = options.name ?? 'Fake';
    this.host = options.host ?? 'fake.test';
    this.session = options.session ?? { providerId: this.id, accountLabel: 'An Tran' };
    this.pullRequests = options.pullRequests ?? [fakePullRequest()];
    this.diff = options.diff ?? 'diff --git a/a.ts b/a.ts\n';
    this.comments = options.comments ?? [];
    this.capabilities = {
      createPullRequest: true, approve: true, requestChanges: true, merge: true,
      mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
      ...options.capabilities,
    };
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  public canHandle(remote: ParsedRemote): boolean { return remote.host === this.host; }

  public async getSession(): Promise<ForgeSession | undefined> { return this.session; }
  public async signOut(): Promise<void> { this.session = undefined; }

  public async listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]> {
    this.record('listPullRequests', repo, opts);
    return this.pullRequests.filter((pr) =>
      opts.state === 'open' ? pr.state === 'open' || pr.state === 'draft' : pr.state === opts.state);
  }

  public async getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail> {
    this.record('getPullRequest', repo, id);
    const found = this.pullRequests.find((pr) => pr.id === id);
    if (!found) throw new Error(`No such pull request: ${id}`);
    return found;
  }

  public async getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string> {
    this.record('getPullRequestDiff', repo, id);
    return this.diff;
  }

  public async listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]> {
    this.record('listComments', repo, id);
    return this.comments;
  }

  public async createPullRequest(repo: ForgeRepoRef, input: CreatePullRequestInput): Promise<PullRequestDetail> {
    this.record('createPullRequest', repo, input);
    return fakePullRequest({ title: input.title, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch });
  }

  public async setReviewStatus(repo: ForgeRepoRef, id: string, status: 'approved' | 'changes_requested'): Promise<void> {
    this.record('setReviewStatus', repo, id, status);
  }

  public async merge(repo: ForgeRepoRef, id: string, opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void> {
    this.record('merge', repo, id, opts);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/forge-registry.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/forge/ tests/helpers/fake-forge-provider.ts tests/extension/forge-registry.test.ts
git commit -m "feat(forge): neutral domain model, provider registry, and test fake"
```

---

## Task 4: The TTL cache

**Files:**
- Create: `src/extension/services/forge/forge-store.ts`
- Test: `tests/extension/forge-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CacheResult<T> = { value: T; stale: boolean; fetchedAt: number }`; `ForgeStore` with `fetch<T>(key, ttlMs, loader): Promise<CacheResult<T>>`, `invalidate(prefix: string): void`, `clear(): void`; and the constants `PR_LIST_TTL_MS = 60_000`, `PR_DETAIL_TTL_MS = 300_000`, `DIFF_TTL_MS = Number.POSITIVE_INFINITY`.

**Note on `stale`:** the spec requires cached data to stay on screen, labelled stale, when the network fails. `fetch` therefore resolves with the previous value on loader failure instead of rejecting — but only if there is one. With nothing cached, the error propagates.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/forge-store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFF_TTL_MS, ForgeStore, PR_LIST_TTL_MS } from '../../src/extension/services/forge/forge-store';

describe('ForgeStore', () => {
  let now = 1_000_000;
  let store: ForgeStore;

  beforeEach(() => {
    now = 1_000_000;
    store = new ForgeStore(() => now);
  });

  it('calls the loader once inside the TTL', async () => {
    const loader = vi.fn().mockResolvedValue('v1');
    expect((await store.fetch('k', PR_LIST_TTL_MS, loader)).value).toBe('v1');
    now += 59_000;
    const second = await store.fetch('k', PR_LIST_TTL_MS, loader);
    expect(second).toMatchObject({ value: 'v1', stale: false });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads once the TTL has passed', async () => {
    const loader = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
    await store.fetch('k', PR_LIST_TTL_MS, loader);
    now += 61_000;
    expect((await store.fetch('k', PR_LIST_TTL_MS, loader)).value).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('never reloads an infinite TTL', async () => {
    const loader = vi.fn().mockResolvedValue('diff');
    await store.fetch('d', DIFF_TTL_MS, loader);
    now += 10 ** 9;
    await store.fetch('d', DIFF_TTL_MS, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  // The screen must not empty out because the network blinked.
  it('returns the previous value marked stale when the loader fails', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce('v1')
      .mockRejectedValueOnce(new Error('offline'));
    await store.fetch('k', PR_LIST_TTL_MS, loader);
    now += 61_000;
    const result = await store.fetch('k', PR_LIST_TTL_MS, loader);
    expect(result).toMatchObject({ value: 'v1', stale: true, fetchedAt: 1_000_000 });
  });

  it('propagates the failure when nothing is cached', async () => {
    await expect(store.fetch('k', PR_LIST_TTL_MS, () => Promise.reject(new Error('offline'))))
      .rejects.toThrow('offline');
  });

  it('invalidates by key prefix', async () => {
    const loader = vi.fn().mockResolvedValue('v');
    await store.fetch('bb:acme/mpos:open', PR_LIST_TTL_MS, loader);
    await store.fetch('bb:other/repo:open', PR_LIST_TTL_MS, loader);
    store.invalidate('bb:acme/mpos');
    await store.fetch('bb:acme/mpos:open', PR_LIST_TTL_MS, loader);
    await store.fetch('bb:other/repo:open', PR_LIST_TTL_MS, loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const loader = vi.fn().mockResolvedValue('v');
    await Promise.all([
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
      store.fetch('k', PR_LIST_TTL_MS, loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/forge-store.test.ts`
Expected: FAIL — cannot resolve `forge-store`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/forge/forge-store.ts

export const PR_LIST_TTL_MS = 60_000;
export const PR_DETAIL_TTL_MS = 300_000;
/** A diff is keyed by its sha pair, so its content can never change. */
export const DIFF_TTL_MS = Number.POSITIVE_INFINITY;

export interface CacheResult<T> {
  value: T;
  /** True when the loader failed and this is the previous value. */
  stale: boolean;
  fetchedAt: number;
}

interface Entry {
  value: unknown;
  fetchedAt: number;
  inFlight?: Promise<unknown>;
}

/**
 * A small TTL cache with two behaviours the UI depends on:
 *
 *  - concurrent callers for the same key share one load, so opening the PR
 *    section does not fan out into duplicate requests against an hourly quota
 *  - a failed reload resolves with the last good value marked stale, so a
 *    network blink annotates the list instead of emptying it
 */
export class ForgeStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly clock: () => number = Date.now) {}

  public async fetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const existing = this.entries.get(key);

    if (existing?.inFlight) {
      const value = (await existing.inFlight) as T;
      return { value, stale: false, fetchedAt: this.entries.get(key)?.fetchedAt ?? this.clock() };
    }

    if (existing && this.clock() - existing.fetchedAt < ttlMs) {
      return { value: existing.value as T, stale: false, fetchedAt: existing.fetchedAt };
    }

    const inFlight = loader();
    this.entries.set(key, { value: existing?.value, fetchedAt: existing?.fetchedAt ?? 0, inFlight });

    try {
      const value = await inFlight;
      const fetchedAt = this.clock();
      this.entries.set(key, { value, fetchedAt });
      return { value, stale: false, fetchedAt };
    } catch (error) {
      if (existing && existing.fetchedAt > 0) {
        this.entries.set(key, { value: existing.value, fetchedAt: existing.fetchedAt });
        return { value: existing.value as T, stale: true, fetchedAt: existing.fetchedAt };
      }
      this.entries.delete(key);
      throw error;
    }
  }

  /** Drops every entry whose key starts with `prefix`. */
  public invalidate(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/forge-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/forge/forge-store.ts tests/extension/forge-store.test.ts
git commit -m "feat(forge): TTL cache with shared in-flight loads and stale fallback"
```

---

## Task 5: Bitbucket authentication

**Files:**
- Create: `src/extension/services/forge/bitbucket/bitbucket-auth.ts`
- Modify: `package.json` (`contributes.authentication`)
- Test: `tests/extension/bitbucket-auth.test.ts`

**Interfaces:**
- Consumes: `ForgeSession` from Task 3.
- Produces: `BITBUCKET_AUTH_ID = 'bitbucket-cloud'`; `BITBUCKET_TOKEN_SCOPES: readonly string[]`; `export interface BitbucketCredentials { email: string; token: string }`; `export interface BitbucketAuthDeps { secrets: SecretStorageLike; prompt: CredentialPrompt; verify: (c: BitbucketCredentials) => Promise<string> }`; and `BitbucketAuthProvider` with `getSession(opts?)`, `createSession()`, `signOut()`, `getCredentials()`, `onDidChangeSessions`.

**Note:** `verify` returns the account display name and is injected so this file never imports the API client — that keeps the dependency one-way and the test off the network.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/bitbucket-auth.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    public listeners: ((e: unknown) => void)[] = [];
    public event = (listener: (e: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    public fire(e: unknown) { this.listeners.forEach((l) => l(e)); }
    public dispose() {}
  },
}));

const { BitbucketAuthProvider, BITBUCKET_TOKEN_SCOPES } =
  await import('../../src/extension/services/forge/bitbucket/bitbucket-auth');

class MemorySecrets {
  private readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async store(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

const credentials = { email: 'tuyen@example.com', token: 'ATATT-secret-token' };

function build(overrides: Partial<{ prompt: unknown; verify: unknown }> = {}) {
  const secrets = new MemorySecrets();
  const prompt = overrides.prompt ?? vi.fn().mockResolvedValue(credentials);
  const verify = overrides.verify ?? vi.fn().mockResolvedValue('Tuyen Nguyen');
  const provider = new BitbucketAuthProvider({ secrets, prompt, verify } as never);
  return { provider, secrets, prompt, verify };
}

describe('BitbucketAuthProvider', () => {
  it('has no session before sign-in', async () => {
    const { provider } = build();
    expect(await provider.getSession()).toBeUndefined();
  });

  it('prompts, verifies, and stores on createIfNone', async () => {
    const { provider, prompt, verify } = build();
    const session = await provider.getSession({ createIfNone: true });
    expect(prompt).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith(credentials);
    expect(session).toEqual({ providerId: 'bitbucket-cloud', accountLabel: 'Tuyen Nguyen' });
  });

  // A mistyped or under-scoped token must fail where it was typed.
  it('stores nothing when verification fails', async () => {
    const { provider, secrets } = build({ verify: vi.fn().mockRejectedValue(new Error('401')) });
    await expect(provider.getSession({ createIfNone: true })).rejects.toThrow('401');
    expect(await provider.getCredentials()).toBeUndefined();
    expect(await secrets.get('forge:bitbucket-cloud:token')).toBeUndefined();
  });

  it('returns undefined without prompting when the user cancels', async () => {
    const { provider } = build({ prompt: vi.fn().mockResolvedValue(undefined) });
    expect(await provider.getSession({ createIfNone: true })).toBeUndefined();
  });

  it('reuses the stored credential on later calls', async () => {
    const { provider, prompt } = build();
    await provider.getSession({ createIfNone: true });
    const again = await provider.getSession({ createIfNone: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(again?.accountLabel).toBe('Tuyen Nguyen');
  });

  it('signOut clears the credential and fires the change event', async () => {
    const { provider } = build();
    await provider.getSession({ createIfNone: true });
    const fired: unknown[] = [];
    provider.onDidChangeSessions((e: unknown) => fired.push(e));
    await provider.signOut();
    expect(await provider.getSession()).toBeUndefined();
    expect(fired).toHaveLength(1);
  });

  it('names every required scope', () => {
    expect([...BITBUCKET_TOKEN_SCOPES]).toEqual([
      'read:account',
      'read:repository:bitbucket',
      'read:pullrequest:bitbucket',
      'write:pullrequest:bitbucket',
    ]);
  });

  // Global constraint: no token value is ever written to a log.
  it('never writes the token to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { provider } = build({ verify: vi.fn().mockRejectedValue(new Error('401 Unauthorized')) });
    await provider.getSession({ createIfNone: true }).catch(() => {});
    const written = spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n');
    expect(written).not.toContain(credentials.token);
    spies.forEach((spy) => spy.mockRestore());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/bitbucket-auth.test.ts`
Expected: FAIL — cannot resolve `bitbucket-auth`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/forge/bitbucket/bitbucket-auth.ts
import * as vscode from 'vscode';
import type { ForgeSession } from '../forge.types';

export const BITBUCKET_AUTH_ID = 'bitbucket-cloud';
export const BITBUCKET_AUTH_LABEL = 'Bitbucket';
const SECRET_KEY = `forge:${BITBUCKET_AUTH_ID}:token`;

/**
 * Bitbucket grants scopes to the token itself, not to the request, so a token
 * created without these can only fail later with a 403 that names nothing.
 * The sign-in prompt lists them verbatim.
 */
export const BITBUCKET_TOKEN_SCOPES = [
  'read:account',
  'read:repository:bitbucket',
  'read:pullrequest:bitbucket',
  'write:pullrequest:bitbucket',
] as const;

export interface BitbucketCredentials {
  email: string;
  token: string;
}

/** The slice of vscode.SecretStorage this needs — injectable for tests. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export type CredentialPrompt = () => Promise<BitbucketCredentials | undefined>;

export interface BitbucketAuthDeps {
  secrets: SecretStorageLike;
  prompt: CredentialPrompt;
  /** Resolves to the account display name, or rejects. Injected so this file never imports the API client. */
  verify: (credentials: BitbucketCredentials) => Promise<string>;
}

interface StoredCredentials extends BitbucketCredentials {
  accountLabel: string;
}

export class BitbucketAuthProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeSessions = this.changeEmitter.event;

  private cached: StoredCredentials | undefined;

  constructor(private readonly deps: BitbucketAuthDeps) {}

  public async getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined> {
    const stored = await this.load();
    if (stored) return { providerId: BITBUCKET_AUTH_ID, accountLabel: stored.accountLabel };
    if (!opts?.createIfNone) return undefined;
    return this.createSession();
  }

  public async createSession(): Promise<ForgeSession | undefined> {
    const entered = await this.deps.prompt();
    if (!entered) return undefined;

    // Verify before storing: a token that is mistyped or missing a scope must
    // fail at the moment it is entered, not on the first pull request request.
    const accountLabel = await this.deps.verify(entered);

    const stored: StoredCredentials = { ...entered, accountLabel };
    await this.deps.secrets.store(SECRET_KEY, JSON.stringify(stored));
    this.cached = stored;
    this.changeEmitter.fire();
    return { providerId: BITBUCKET_AUTH_ID, accountLabel };
  }

  public async getCredentials(): Promise<BitbucketCredentials | undefined> {
    const stored = await this.load();
    return stored ? { email: stored.email, token: stored.token } : undefined;
  }

  public async signOut(): Promise<void> {
    this.cached = undefined;
    await this.deps.secrets.delete(SECRET_KEY);
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private async load(): Promise<StoredCredentials | undefined> {
    if (this.cached) return this.cached;
    const raw = await this.deps.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredCredentials;
      if (!parsed?.email || !parsed?.token) return undefined;
      this.cached = parsed;
      return parsed;
    } catch {
      // Corrupt entry: treat as signed out rather than wedging every call.
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/bitbucket-auth.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Declare the authentication contribution**

Add to `package.json` under `contributes`, after `configuration`:

```json
    "authentication": [
      {
        "id": "bitbucket-cloud",
        "label": "Bitbucket"
      }
    ]
```

Add under `contributes.configuration.properties`:

```json
        "gitGraphPro.forge.remote": {
          "type": "string",
          "default": "origin",
          "description": "Which git remote identifies the hosting service for pull requests."
        }
```

Add under `contributes.commands`:

```json
      { "command": "gitGraphPro.forge.signIn",  "title": "Git Graph Pro: Sign in to Bitbucket" },
      { "command": "gitGraphPro.forge.signOut", "title": "Git Graph Pro: Sign out of Bitbucket" }
```

- [ ] **Step 6: Write the contribution test**

```ts
// append to tests/extension/bitbucket-auth.test.ts
import pkg from '../../package.json';

describe('forge contributions', () => {
  const contributes = pkg.contributes as Record<string, never>;

  it('declares the bitbucket authentication provider', () => {
    const auth = contributes.authentication as unknown as { id: string; label: string }[];
    expect(auth).toContainEqual({ id: 'bitbucket-cloud', label: 'Bitbucket' });
  });

  it('defaults the forge remote to origin', () => {
    const props = (contributes.configuration as unknown as { properties: Record<string, { default: string }> }).properties;
    expect(props['gitGraphPro.forge.remote'].default).toBe('origin');
  });

  it('registers sign-in and sign-out commands', () => {
    const ids = (contributes.commands as unknown as { command: string }[]).map((c) => c.command);
    expect(ids).toContain('gitGraphPro.forge.signIn');
    expect(ids).toContain('gitGraphPro.forge.signOut');
  });
});
```

- [ ] **Step 7: Run the whole file**

Run: `npx vitest run tests/extension/bitbucket-auth.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 8: Commit**

```bash
git add src/extension/services/forge/bitbucket/bitbucket-auth.ts package.json tests/extension/bitbucket-auth.test.ts
git commit -m "feat(forge): Bitbucket API token authentication with verify-before-store"
```

---

## Task 6: The Bitbucket HTTP client

**Files:**
- Create: `src/extension/services/forge/bitbucket/bitbucket-api.ts`
- Test: `tests/extension/bitbucket-api.test.ts`

**Interfaces:**
- Consumes: `ForgeError` (Task 3), `BitbucketCredentials` (Task 5).
- Produces: `BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0'`; `MAX_CONCURRENT_REQUESTS = 4`; `export interface BitbucketApiDeps { getCredentials: () => Promise<BitbucketCredentials | undefined>; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }`; `BitbucketApi` with `getJson<T>(path)`, `getText(path)`, `getPaged<T>(path)`, `post<T>(path, body)`, `postEmpty(path)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/bitbucket-api.test.ts
import { describe, expect, it, vi } from 'vitest';
import { BitbucketApi, MAX_CONCURRENT_REQUESTS } from '../../src/extension/services/forge/bitbucket/bitbucket-api';
import { ForgeError } from '../../src/extension/services/forge/forge.types';

const credentials = { email: 'tuyen@example.com', token: 'ATATT-secret-token' };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function build(fetchImpl: typeof fetch, sleep = vi.fn().mockResolvedValue(undefined)) {
  const api = new BitbucketApi({ getCredentials: async () => credentials, fetchImpl, sleep });
  return { api, sleep };
}

describe('BitbucketApi', () => {
  it('sends HTTP Basic with the email and token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const { api } = build(fetchImpl as never);
    await api.getJson('/user');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.bitbucket.org/2.0/user');
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`);
  });

  it('throws a signed-out ForgeError when there is no credential', async () => {
    const fetchImpl = vi.fn();
    const api = new BitbucketApi({ getCredentials: async () => undefined, fetchImpl: fetchImpl as never });
    await expect(api.getJson('/user')).rejects.toBeInstanceOf(ForgeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates a non-2xx body into ForgeError with the host message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Repository not found' } }, { status: 404 }));
    const { api } = build(fetchImpl as never);

    await expect(api.getJson('/repositories/acme/nope')).rejects.toMatchObject({
      name: 'ForgeError', status: 404, hostMessage: 'Repository not found',
    });
  });

  it('carries Retry-After on a 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '37' } }));
    const { api } = build(fetchImpl as never);
    await expect(api.getJson('/user')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 37 });
  });

  it('pauses the queue for Retry-After before the next request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Rate limit' } }, { status: 429, headers: { 'retry-after': '5' } }))
      .mockResolvedValue(jsonResponse({ ok: true }));
    const { api, sleep } = build(fetchImpl as never);

    await api.getJson('/a').catch(() => {});
    await api.getJson('/b');
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('never runs more than the concurrency cap at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse({ ok: true });
    });
    const { api } = build(fetchImpl as never);

    await Promise.all(Array.from({ length: 12 }, (_, i) => api.getJson(`/p/${i}`)));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
  });

  it('follows Bitbucket pagination until there is no next link', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 1 }], next: 'https://api.bitbucket.org/2.0/x?page=2' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: 2 }] }));
    const { api } = build(fetchImpl as never);

    expect(await api.getPaged<{ id: number }>('/x')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns a diff as text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('diff --git a/a b/a\n', { status: 200 }));
    const { api } = build(fetchImpl as never);
    expect(await api.getText('/pullrequests/1/diff')).toBe('diff --git a/a b/a\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/bitbucket-api.test.ts`
Expected: FAIL — cannot resolve `bitbucket-api`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/forge/bitbucket/bitbucket-api.ts
import { ForgeError } from '../forge.types';
import type { BitbucketCredentials } from './bitbucket-auth';

export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

/**
 * Opening the pull request section fires a list, a detail and a diffstat at
 * once, across every open repository. Bitbucket allows roughly 1000 requests
 * per hour, so the fan-out is capped rather than left to the event loop.
 */
export const MAX_CONCURRENT_REQUESTS = 4;

export interface BitbucketApiDeps {
  getCredentials: () => Promise<BitbucketCredentials | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface PagedResponse<T> {
  values?: T[];
  next?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BitbucketApi {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Epoch ms before which no request may start, set by a 429. */
  private pausedUntil = 0;

  constructor(private readonly deps: BitbucketApiDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  public async getJson<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' }, 'json');
  }

  public async getText(path: string): Promise<string> {
    return this.request<string>(path, { method: 'GET' }, 'text');
  }

  public async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'json');
  }

  public async postEmpty(path: string): Promise<void> {
    await this.request<unknown>(path, { method: 'POST' }, 'none');
  }

  /** Walks Bitbucket's `next` links and concatenates every `values` page. */
  public async getPaged<T>(path: string): Promise<T[]> {
    const collected: T[] = [];
    let next: string | undefined = path;

    while (next) {
      const page: PagedResponse<T> = await this.getJson<PagedResponse<T>>(next);
      collected.push(...(page.values ?? []));
      next = page.next;
    }
    return collected;
  }

  private async request<T>(path: string, init: RequestInit, parse: 'json' | 'text' | 'none'): Promise<T> {
    const credentials = await this.deps.getCredentials();
    // 401 is the same state the UI shows for an expired token, so a missing
    // credential reuses it rather than inventing a second signed-out path.
    if (!credentials) throw new ForgeError(401, 'Not signed in to Bitbucket');

    const url = path.startsWith('http') ? path : `${BITBUCKET_API_BASE}${path}`;
    const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;

    await this.acquire();
    try {
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await this.sleep(wait);

      const response = await this.fetchImpl(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers ?? {}), Authorization: authorization },
      });

      if (!response.ok) throw await this.toForgeError(response);
      if (parse === 'none') return undefined as T;
      return (parse === 'text' ? await response.text() : await response.json()) as T;
    } finally {
      this.release();
    }
  }

  private async toForgeError(response: Response): Promise<ForgeError> {
    let hostMessage = response.statusText || `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (body?.error?.message) hostMessage = body.error.message;
    } catch {
      // A non-JSON error body leaves the status line as the message.
    }

    let retryAfterSeconds: number | undefined;
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : 60;
      // Hold every queued request, not just this one: they would all hit the
      // same limit and turn one breach into a wall of identical failures.
      this.pausedUntil = Date.now() + retryAfterSeconds * 1000;
    }

    return new ForgeError(response.status, hostMessage, retryAfterSeconds);
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_REQUESTS) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => { this.active += 1; resolve(); });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/bitbucket-api.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/forge/bitbucket/bitbucket-api.ts tests/extension/bitbucket-api.test.ts
git commit -m "feat(forge): Bitbucket HTTP client with concurrency cap and 429 backoff"
```

---

## Task 7: Map Bitbucket JSON to the neutral model

**Files:**
- Create: `src/extension/services/forge/bitbucket/bitbucket-mapper.ts`, `tests/fixtures/bitbucket/pull-request.json`, `tests/fixtures/bitbucket/pull-request-list.json`, `tests/fixtures/bitbucket/comments.json`
- Test: `tests/extension/bitbucket-mapper.test.ts`

**Interfaces:**
- Consumes: the model from Task 3.
- Produces: `mapPullRequestSummary(raw): PullRequestSummary`, `mapPullRequestDetail(raw): PullRequestDetail`, `mapComment(raw): ForgeComment`, `mapComments(raw[]): ForgeComment[]`.

**Fixture note:** these are trimmed captures of real responses. Keep the field names exactly as Bitbucket sends them — that fidelity is the whole point of the fixture.

- [ ] **Step 1: Create the fixtures**

```json
// tests/fixtures/bitbucket/pull-request.json
{
  "id": 123,
  "title": "fix(auth): refresh token race",
  "description": "Single-flight the refresh.",
  "state": "OPEN",
  "draft": false,
  "comment_count": 8,
  "created_on": "2026-08-20T02:11:04.123456+00:00",
  "updated_on": "2026-08-25T09:30:00.000000+00:00",
  "links": { "html": { "href": "https://bitbucket.org/acme/mpos/pull-requests/123" } },
  "author": {
    "display_name": "An Tran",
    "account_id": "acc-an",
    "links": { "avatar": { "href": "https://avatar.example/an.png" } }
  },
  "source": { "branch": { "name": "feature/RMS-1027" }, "commit": { "hash": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" } },
  "destination": { "branch": { "name": "develop" }, "commit": { "hash": "b2c3d4e5f60718293a4b5c6d7e8f90123456789a" } },
  "participants": [
    { "role": "REVIEWER", "approved": true,  "state": "approved",         "user": { "display_name": "An Tran",  "account_id": "acc-an" } },
    { "role": "REVIEWER", "approved": false, "state": "changes_requested","user": { "display_name": "Minh Le",  "account_id": "acc-minh" } },
    { "role": "REVIEWER", "approved": false, "state": null,               "user": { "display_name": "Hoa Pham", "account_id": "acc-hoa" } },
    { "role": "PARTICIPANT", "approved": false, "state": null,            "user": { "display_name": "Bot",      "account_id": "acc-bot" } }
  ]
}
```

```json
// tests/fixtures/bitbucket/pull-request-list.json
{
  "values": [
    {
      "id": 118,
      "title": "chore: bump deps",
      "state": "OPEN",
      "draft": true,
      "comment_count": 0,
      "updated_on": "2026-08-24T08:00:00.000000+00:00",
      "links": { "html": { "href": "https://bitbucket.org/acme/mpos/pull-requests/118" } },
      "author": { "display_name": "Hoa Pham", "account_id": "acc-hoa" },
      "source": { "branch": { "name": "chore/deps" } },
      "destination": { "branch": { "name": "develop" } },
      "participants": []
    }
  ]
}
```

```json
// tests/fixtures/bitbucket/comments.json
{
  "values": [
    {
      "id": 9001,
      "created_on": "2026-08-21T03:00:00.000000+00:00",
      "content": { "raw": "This drops the mutex." },
      "user": { "display_name": "Minh Le", "account_id": "acc-minh" },
      "inline": { "path": "src/auth.ts", "to": 42 }
    },
    {
      "id": 9002,
      "created_on": "2026-08-21T04:00:00.000000+00:00",
      "content": { "raw": "Fixed." },
      "user": { "display_name": "An Tran", "account_id": "acc-an" },
      "parent": { "id": 9001 }
    },
    {
      "id": 9003,
      "created_on": "2026-08-21T05:00:00.000000+00:00",
      "deleted": true,
      "content": { "raw": "" },
      "user": { "display_name": "An Tran", "account_id": "acc-an" }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/extension/bitbucket-mapper.test.ts
import { describe, expect, it } from 'vitest';
import {
  mapComments, mapPullRequestDetail, mapPullRequestSummary,
} from '../../src/extension/services/forge/bitbucket/bitbucket-mapper';
import detailFixture from '../fixtures/bitbucket/pull-request.json';
import listFixture from '../fixtures/bitbucket/pull-request-list.json';
import commentsFixture from '../fixtures/bitbucket/comments.json';

describe('bitbucket-mapper', () => {
  it('maps a pull request detail', () => {
    const pr = mapPullRequestDetail(detailFixture as never);
    expect(pr).toMatchObject({
      id: '123', number: 123, state: 'open',
      title: 'fix(auth): refresh token race', description: 'Single-flight the refresh.',
      sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
      sourceCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      targetCommit: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a',
      commentCount: 8, webUrl: 'https://bitbucket.org/acme/mpos/pull-requests/123',
      mergeable: 'unknown',
    });
    expect(pr.author).toEqual({ displayName: 'An Tran', accountId: 'acc-an', avatarUrl: 'https://avatar.example/an.png' });
  });

  // Only reviewers count; a plain participant is not a reviewer.
  it('keeps reviewers only, with their status', () => {
    const pr = mapPullRequestDetail(detailFixture as never);
    expect(pr.reviewers).toEqual([
      { user: { displayName: 'An Tran',  accountId: 'acc-an' },   status: 'approved' },
      { user: { displayName: 'Minh Le',  accountId: 'acc-minh' }, status: 'changes_requested' },
      { user: { displayName: 'Hoa Pham', accountId: 'acc-hoa' },  status: 'pending' },
    ]);
  });

  // A draft is an open PR that reports itself as draft.
  it('reports a draft as state draft', () => {
    const summary = mapPullRequestSummary((listFixture as { values: unknown[] }).values[0] as never);
    expect(summary).toMatchObject({ id: '118', number: 118, state: 'draft', commentCount: 0 });
  });

  it.each([
    ['OPEN', false, 'open'],
    ['MERGED', false, 'merged'],
    ['DECLINED', false, 'closed'],
    ['SUPERSEDED', false, 'closed'],
    ['OPEN', true, 'draft'],
  ])('maps state %s draft=%s to %s', (state, draft, expected) => {
    const summary = mapPullRequestSummary({ ...(detailFixture as object), state, draft } as never);
    expect(summary.state).toBe(expected);
  });

  it('maps comments, threading and inline anchors, and drops deleted ones', () => {
    const comments = mapComments((commentsFixture as { values: unknown[] }).values as never);
    expect(comments).toEqual([
      {
        id: '9001', body: 'This drops the mutex.', createdAt: '2026-08-21T03:00:00.000000+00:00',
        author: { displayName: 'Minh Le', accountId: 'acc-minh' }, path: 'src/auth.ts', line: 42,
      },
      {
        id: '9002', body: 'Fixed.', createdAt: '2026-08-21T04:00:00.000000+00:00',
        author: { displayName: 'An Tran', accountId: 'acc-an' }, parentId: '9001',
      },
    ]);
  });

  // Bitbucket omits fields freely; a missing branch must not crash the sidebar.
  it('survives missing optional fields', () => {
    const summary = mapPullRequestSummary({ id: 7, state: 'OPEN' } as never);
    expect(summary).toMatchObject({
      id: '7', number: 7, title: '', sourceBranch: '', targetBranch: '',
      commentCount: 0, reviewers: [], webUrl: '',
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/extension/bitbucket-mapper.test.ts`
Expected: FAIL — cannot resolve `bitbucket-mapper`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/extension/services/forge/bitbucket/bitbucket-mapper.ts
import type {
  ForgeComment, ForgeUser, PullRequestDetail, PullRequestState, PullRequestSummary, ReviewStatus,
} from '../forge.types';

interface RawUser {
  display_name?: string;
  account_id?: string;
  links?: { avatar?: { href?: string } };
}

interface RawParticipant {
  role?: string;
  approved?: boolean;
  state?: string | null;
  user?: RawUser;
}

interface RawPullRequest {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  draft?: boolean;
  comment_count?: number;
  updated_on?: string;
  links?: { html?: { href?: string } };
  author?: RawUser;
  source?: { branch?: { name?: string }; commit?: { hash?: string } };
  destination?: { branch?: { name?: string }; commit?: { hash?: string } };
  participants?: RawParticipant[];
}

interface RawComment {
  id?: number;
  created_on?: string;
  deleted?: boolean;
  content?: { raw?: string };
  user?: RawUser;
  parent?: { id?: number };
  inline?: { path?: string; to?: number | null; from?: number | null };
}

function mapUser(raw: RawUser | undefined): ForgeUser {
  const user: ForgeUser = {
    displayName: raw?.display_name ?? '',
    accountId: raw?.account_id ?? '',
  };
  const avatarUrl = raw?.links?.avatar?.href;
  // Only set the key when there is a value: the tests compare whole objects,
  // and an explicit undefined is not the same shape as an absent key.
  return avatarUrl ? { ...user, avatarUrl } : user;
}

function mapState(raw: RawPullRequest): PullRequestState {
  if (raw.draft) return 'draft';
  switch ((raw.state ?? '').toUpperCase()) {
    case 'MERGED': return 'merged';
    case 'DECLINED':
    case 'SUPERSEDED': return 'closed';
    default: return 'open';
  }
}

function mapReviewStatus(participant: RawParticipant): ReviewStatus {
  if (participant.approved) return 'approved';
  return participant.state === 'changes_requested' ? 'changes_requested' : 'pending';
}

export function mapPullRequestSummary(raw: RawPullRequest): PullRequestSummary {
  const number = raw.id ?? 0;
  return {
    id: String(number),
    number,
    title: raw.title ?? '',
    state: mapState(raw),
    author: mapUser(raw.author),
    sourceBranch: raw.source?.branch?.name ?? '',
    targetBranch: raw.destination?.branch?.name ?? '',
    reviewers: (raw.participants ?? [])
      .filter((participant) => participant.role === 'REVIEWER')
      .map((participant) => ({ user: mapUser(participant.user), status: mapReviewStatus(participant) })),
    commentCount: raw.comment_count ?? 0,
    webUrl: raw.links?.html?.href ?? '',
    updatedAt: raw.updated_on ?? '',
  };
}

export function mapPullRequestDetail(raw: RawPullRequest): PullRequestDetail {
  return {
    ...mapPullRequestSummary(raw),
    description: raw.description ?? '',
    sourceCommit: raw.source?.commit?.hash ?? '',
    targetCommit: raw.destination?.commit?.hash ?? '',
    // The list and detail endpoints do not report mergeability; it comes from
    // a separate call this phase does not make.
    mergeable: 'unknown',
  };
}

export function mapComment(raw: RawComment): ForgeComment {
  const comment: ForgeComment = {
    id: String(raw.id ?? ''),
    author: mapUser(raw.user),
    body: raw.content?.raw ?? '',
    createdAt: raw.created_on ?? '',
  };
  if (raw.parent?.id !== undefined) comment.parentId = String(raw.parent.id);
  if (raw.inline?.path) {
    comment.path = raw.inline.path;
    const line = raw.inline.to ?? raw.inline.from;
    if (typeof line === 'number') comment.line = line;
  }
  return comment;
}

/** Deleted comments come back as tombstones with empty bodies; drop them. */
export function mapComments(raw: RawComment[]): ForgeComment[] {
  return raw.filter((comment) => !comment.deleted).map(mapComment);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/extension/bitbucket-mapper.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/extension/services/forge/bitbucket/bitbucket-mapper.ts tests/fixtures/bitbucket tests/extension/bitbucket-mapper.test.ts
git commit -m "feat(forge): map Bitbucket pull request and comment payloads"
```

---

## Task 8: The Bitbucket provider (read half)

**Files:**
- Create: `src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts`
- Test: `tests/extension/bitbucket-provider.test.ts`

**Interfaces:**
- Consumes: `BitbucketApi` (Task 6), the mappers (Task 7), `BitbucketAuthProvider` (Task 5).
- Produces: `BitbucketCloudProvider implements ForgeProvider`, constructed as `new BitbucketCloudProvider({ api, auth })`. The write methods (`createPullRequest`, `setReviewStatus`, `merge`) throw `ForgeError(501, ...)` in these phases and are implemented in Phases 5 and 6.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/bitbucket-provider.test.ts
import { describe, expect, it, vi } from 'vitest';
import { BitbucketCloudProvider } from '../../src/extension/services/forge/bitbucket/bitbucket-cloud.provider';
import detailFixture from '../fixtures/bitbucket/pull-request.json';
import listFixture from '../fixtures/bitbucket/pull-request-list.json';
import commentsFixture from '../fixtures/bitbucket/comments.json';

function build(api: Partial<Record<'getJson' | 'getText' | 'getPaged', unknown>> = {}) {
  const stub = {
    getJson: vi.fn().mockResolvedValue(detailFixture),
    getText: vi.fn().mockResolvedValue('diff --git a/a b/a\n'),
    getPaged: vi.fn().mockResolvedValue((listFixture as { values: unknown[] }).values),
    ...api,
  };
  const auth = { getSession: vi.fn().mockResolvedValue({ providerId: 'bitbucket-cloud', accountLabel: 'Tuyen' }), signOut: vi.fn() };
  const provider = new BitbucketCloudProvider({ api: stub as never, auth: auth as never });
  return { provider, stub, auth };
}

const repo = { owner: 'acme', name: 'mpos' };

describe('BitbucketCloudProvider', () => {
  it('claims bitbucket.org and nothing else', () => {
    const { provider } = build();
    expect(provider.canHandle({ host: 'bitbucket.org', owner: 'a', name: 'b' })).toBe(true);
    expect(provider.canHandle({ host: 'github.com', owner: 'a', name: 'b' })).toBe(false);
  });

  it('declares its merge strategies', () => {
    const { provider } = build();
    expect(provider.capabilities.mergeStrategies).toEqual(['merge-commit', 'squash', 'fast-forward']);
  });

  it('lists open pull requests through the paged endpoint', async () => {
    const { provider, stub } = build();
    const prs = await provider.listPullRequests(repo, { state: 'open' });

    expect(stub.getPaged).toHaveBeenCalledWith(
      '/repositories/acme/mpos/pullrequests?state=OPEN&pagelen=50');
    expect(prs[0]).toMatchObject({ id: '118', state: 'draft' });
  });

  it.each([
    ['open', 'OPEN'],
    ['merged', 'MERGED'],
    ['closed', 'DECLINED'],
  ])('asks for %s as %s', async (state, expected) => {
    const { provider, stub } = build();
    await provider.listPullRequests(repo, { state: state as never });
    expect(stub.getPaged).toHaveBeenCalledWith(expect.stringContaining(`state=${expected}`));
  });

  it('fetches one pull request', async () => {
    const { provider, stub } = build();
    const pr = await provider.getPullRequest(repo, '123');
    expect(stub.getJson).toHaveBeenCalledWith('/repositories/acme/mpos/pullrequests/123');
    expect(pr.sourceCommit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  });

  it('fetches the diff as text', async () => {
    const { provider, stub } = build();
    expect(await provider.getPullRequestDiff(repo, '123')).toBe('diff --git a/a b/a\n');
    expect(stub.getText).toHaveBeenCalledWith('/repositories/acme/mpos/pullrequests/123/diff');
  });

  it('lists comments without the deleted ones', async () => {
    const { provider } = build({
      getPaged: vi.fn().mockResolvedValue((commentsFixture as { values: unknown[] }).values),
    });
    const comments = await provider.listComments(repo, '123');
    expect(comments.map((c) => c.id)).toEqual(['9001', '9002']);
  });

  it('reports write methods as not implemented in this phase', async () => {
    const { provider } = build();
    await expect(provider.merge(repo, '1', { strategy: 'squash' })).rejects.toMatchObject({ status: 501 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/bitbucket-provider.test.ts`
Expected: FAIL — cannot resolve `bitbucket-cloud.provider`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts
import {
  ForgeError,
  type CreatePullRequestInput, type ForgeCapabilities, type ForgeComment, type ForgeProvider,
  type ForgeRepoRef, type ForgeSession, type MergeStrategy, type ParsedRemote,
  type PullRequestDetail, type PullRequestListState, type PullRequestSummary,
} from '../forge.types';
import type { BitbucketApi } from './bitbucket-api';
import type { BitbucketAuthProvider } from './bitbucket-auth';
import { BITBUCKET_AUTH_ID, BITBUCKET_AUTH_LABEL } from './bitbucket-auth';
import { mapComments, mapPullRequestDetail, mapPullRequestSummary } from './bitbucket-mapper';

const PAGE_LENGTH = 50;

const STATE_QUERY: Record<PullRequestListState, string> = {
  open: 'OPEN',
  merged: 'MERGED',
  closed: 'DECLINED',
};

export interface BitbucketProviderDeps {
  api: BitbucketApi;
  auth: BitbucketAuthProvider;
}

export class BitbucketCloudProvider implements ForgeProvider {
  public readonly id = BITBUCKET_AUTH_ID;
  public readonly name = BITBUCKET_AUTH_LABEL;

  public readonly capabilities: ForgeCapabilities = {
    createPullRequest: true,
    approve: true,
    requestChanges: true,
    merge: true,
    mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
  };

  constructor(private readonly deps: BitbucketProviderDeps) {}

  public canHandle(remote: ParsedRemote): boolean {
    return remote.host === 'bitbucket.org';
  }

  public getSession(opts?: { createIfNone?: boolean }): Promise<ForgeSession | undefined> {
    return this.deps.auth.getSession(opts);
  }

  public signOut(): Promise<void> {
    return this.deps.auth.signOut();
  }

  public async listPullRequests(repo: ForgeRepoRef, opts: { state: PullRequestListState }): Promise<PullRequestSummary[]> {
    const raw = await this.deps.api.getPaged<Parameters<typeof mapPullRequestSummary>[0]>(
      `${this.base(repo)}/pullrequests?state=${STATE_QUERY[opts.state]}&pagelen=${PAGE_LENGTH}`);
    return raw.map(mapPullRequestSummary);
  }

  public async getPullRequest(repo: ForgeRepoRef, id: string): Promise<PullRequestDetail> {
    const raw = await this.deps.api.getJson<Parameters<typeof mapPullRequestDetail>[0]>(
      `${this.base(repo)}/pullrequests/${encodeURIComponent(id)}`);
    return mapPullRequestDetail(raw);
  }

  public getPullRequestDiff(repo: ForgeRepoRef, id: string): Promise<string> {
    return this.deps.api.getText(`${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/diff`);
  }

  public async listComments(repo: ForgeRepoRef, id: string): Promise<ForgeComment[]> {
    const raw = await this.deps.api.getPaged<Parameters<typeof mapComments>[0][number]>(
      `${this.base(repo)}/pullrequests/${encodeURIComponent(id)}/comments?pagelen=${PAGE_LENGTH}`);
    return mapComments(raw);
  }

  public createPullRequest(_repo: ForgeRepoRef, _input: CreatePullRequestInput): Promise<PullRequestDetail> {
    return Promise.reject(new ForgeError(501, 'Creating pull requests arrives in phase 5'));
  }

  public setReviewStatus(_repo: ForgeRepoRef, _id: string, _status: 'approved' | 'changes_requested'): Promise<void> {
    return Promise.reject(new ForgeError(501, 'Approving pull requests arrives in phase 6'));
  }

  public merge(_repo: ForgeRepoRef, _id: string, _opts: { strategy: MergeStrategy; closeSourceBranch?: boolean }): Promise<void> {
    return Promise.reject(new ForgeError(501, 'Merging pull requests arrives in phase 6'));
  }

  private base(repo: ForgeRepoRef): string {
    return `/repositories/${encodeURIComponent(repo.owner)}/${repo.name.split('/').map(encodeURIComponent).join('/')}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/bitbucket-provider.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts tests/extension/bitbucket-provider.test.ts
git commit -m "feat(forge): Bitbucket Cloud provider, read operations"
```

---

## Task 9: The `forge` namespace

**Files:**
- Create: `src/extension/controllers/forge-method-handler.ts`
- Test: `tests/extension/forge-method-handler.test.ts`

**Interfaces:**
- Consumes: `ForgeRegistry` (Task 3), `ForgeStore` and its TTLs (Task 4), `parseRemoteUrl` (Task 1), `GitService.getRemoteUrl` (Task 2).
- Produces: `createForgeHandler(deps: ForgeHandlerDeps)` returning `(method: string, params: unknown) => Promise<unknown>`, where

```ts
export interface ForgeHandlerDeps {
  registry: ForgeRegistry;
  store: ForgeStore;
  getRemoteUrl: () => Promise<string | undefined>;
  broadcast: (event: string, data?: unknown) => void;
  openExternal: (url: string) => Promise<void>;
}
```

`forge.status` resolves to `ForgeStatus`:

```ts
export interface ForgeStatus {
  available: boolean;
  providerId?: string;
  providerName?: string;
  signedIn?: boolean;
  accountLabel?: string;
  repo?: ForgeRepoRef;
  capabilities?: ForgeCapabilities;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/forge-method-handler.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createForgeHandler } from '../../src/extension/controllers/forge-method-handler';
import { ForgeRegistry } from '../../src/extension/services/forge/forge-registry';
import { ForgeStore } from '../../src/extension/services/forge/forge-store';
import { FakeForgeProvider, fakePullRequest } from '../helpers/fake-forge-provider';

function build(options: {
  remoteUrl?: string | undefined;
  provider?: FakeForgeProvider;
} = {}) {
  const provider = options.provider ?? new FakeForgeProvider({ id: 'bitbucket-cloud', name: 'Bitbucket', host: 'bitbucket.org' });
  const registry = new ForgeRegistry();
  registry.register(provider);
  const store = new ForgeStore();
  const broadcast = vi.fn();
  const openExternal = vi.fn().mockResolvedValue(undefined);

  const handle = createForgeHandler({
    registry,
    store,
    getRemoteUrl: async () => ('remoteUrl' in options ? options.remoteUrl : 'git@bitbucket.org:acme/mpos.git'),
    broadcast,
    openExternal,
  });
  return { handle, provider, broadcast, openExternal, store };
}

describe('forge namespace', () => {
  it('reports unavailable when the repository has no remote', async () => {
    const { handle } = build({ remoteUrl: undefined });
    expect(await handle('forge.status', {})).toEqual({ available: false });
  });

  it('reports unavailable when no provider claims the host', async () => {
    const { handle } = build({ remoteUrl: 'git@gitlab.com:acme/mpos.git' });
    expect(await handle('forge.status', {})).toEqual({ available: false });
  });

  it('reports the provider, repo and session when available', async () => {
    const { handle } = build();
    expect(await handle('forge.status', {})).toMatchObject({
      available: true,
      providerId: 'bitbucket-cloud',
      providerName: 'Bitbucket',
      signedIn: true,
      accountLabel: 'An Tran',
      repo: { owner: 'acme', name: 'mpos' },
    });
  });

  it('reports signedIn false without prompting', async () => {
    const provider = new FakeForgeProvider({ host: 'bitbucket.org', session: undefined });
    const { handle } = build({ provider });
    expect(await handle('forge.status', {})).toMatchObject({ available: true, signedIn: false });
  });

  it('lists pull requests and caches within the TTL', async () => {
    const { handle, provider } = build();
    const first = await handle('forge.pr.list', { state: 'open' }) as { pullRequests: unknown[]; stale: boolean };
    await handle('forge.pr.list', { state: 'open' });

    expect(first.pullRequests).toHaveLength(1);
    expect(first.stale).toBe(false);
    expect(provider.calls.filter((c) => c.method === 'listPullRequests')).toHaveLength(1);
  });

  it('defaults the list state to open', async () => {
    const { handle, provider } = build();
    await handle('forge.pr.list', {});
    expect(provider.calls[0].args[1]).toEqual({ state: 'open' });
  });

  it('fetches a pull request, its diff and its comments', async () => {
    const { handle, provider } = build();
    expect(await handle('forge.pr.get', { id: '123' })).toMatchObject({ id: '123' });
    expect(await handle('forge.pr.diff', { id: '123' })).toMatchObject({ diff: expect.stringContaining('diff --git') });
    expect(await handle('forge.pr.comments', { id: '123' })).toEqual({ comments: [] });
    expect(provider.calls.map((c) => c.method)).toEqual(['getPullRequest', 'getPullRequestDiff', 'listComments']);
  });

  it('keys the diff cache by the sha pair, not the pull request id', async () => {
    const provider = new FakeForgeProvider({
      host: 'bitbucket.org',
      pullRequests: [fakePullRequest({ id: '1', sourceCommit: 'aaa', targetCommit: 'bbb' })],
    });
    const { handle } = build({ provider });

    await handle('forge.pr.diff', { id: '1' });
    await handle('forge.pr.diff', { id: '1' });
    expect(provider.calls.filter((c) => c.method === 'getPullRequestDiff')).toHaveLength(1);
  });

  it('refresh drops the cache and broadcasts', async () => {
    const { handle, provider, broadcast } = build();
    await handle('forge.pr.list', { state: 'open' });
    await handle('forge.refresh', {});
    await handle('forge.pr.list', { state: 'open' });

    expect(provider.calls.filter((c) => c.method === 'listPullRequests')).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledWith('forge.changed', {});
  });

  it('signs in on demand and broadcasts the change', async () => {
    const provider = new FakeForgeProvider({ host: 'bitbucket.org', session: undefined });
    const { handle, broadcast } = build({ provider });
    await handle('forge.signIn', {});
    expect(broadcast).toHaveBeenCalledWith('forge.changed', {});
  });

  it('signs out, clears the cache and broadcasts', async () => {
    const { handle, provider, broadcast } = build();
    await handle('forge.signOut', {});
    expect(await provider.getSession()).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith('forge.changed', {});
  });

  it('opens a pull request in the browser', async () => {
    const { handle, openExternal } = build();
    await handle('forge.pr.openExternal', { id: '123' });
    expect(openExternal).toHaveBeenCalledWith('https://bitbucket.org/acme/mpos/pull-requests/123');
  });

  it('rejects an unknown method', async () => {
    const { handle } = build();
    await expect(handle('forge.nope', {})).rejects.toThrow('Unknown method: forge.nope');
  });

  it('rejects a pull request call when the repository is not on a forge', async () => {
    const { handle } = build({ remoteUrl: undefined });
    await expect(handle('forge.pr.list', {})).rejects.toThrow('No pull request provider for this repository');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/forge-method-handler.test.ts`
Expected: FAIL — cannot resolve `forge-method-handler`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/controllers/forge-method-handler.ts
import { parseRemoteUrl } from '../services/forge/remote-url';
import { DIFF_TTL_MS, PR_DETAIL_TTL_MS, PR_LIST_TTL_MS } from '../services/forge/forge-store';
import type { ForgeStore } from '../services/forge/forge-store';
import type { ForgeRegistry } from '../services/forge/forge-registry';
import type {
  ForgeCapabilities, ForgeProvider, ForgeRepoRef, PullRequestListState,
} from '../services/forge/forge.types';

export interface ForgeStatus {
  available: boolean;
  providerId?: string;
  providerName?: string;
  signedIn?: boolean;
  accountLabel?: string;
  repo?: ForgeRepoRef;
  capabilities?: ForgeCapabilities;
}

export interface ForgeHandlerDeps {
  registry: ForgeRegistry;
  store: ForgeStore;
  getRemoteUrl: () => Promise<string | undefined>;
  broadcast: (event: string, data?: unknown) => void;
  openExternal: (url: string) => Promise<void>;
}

interface Resolved {
  provider: ForgeProvider;
  repo: ForgeRepoRef;
  /** Cache key prefix for everything belonging to this repository. */
  prefix: string;
}

const LIST_STATES: ReadonlySet<string> = new Set(['open', 'merged', 'closed']);

export function createForgeHandler(deps: ForgeHandlerDeps) {
  async function resolve(): Promise<Resolved | undefined> {
    const url = await deps.getRemoteUrl();
    if (!url) return undefined;

    const remote = parseRemoteUrl(url);
    if (!remote) return undefined;

    const provider = deps.registry.resolve(remote);
    if (!provider) return undefined;

    const repo = { owner: remote.owner, name: remote.name };
    return { provider, repo, prefix: `${provider.id}:${repo.owner}/${repo.name}` };
  }

  async function requireForge(): Promise<Resolved> {
    const resolved = await resolve();
    // The webview gates on forge.status, so reaching here means the repository
    // changed underneath an open panel rather than a caller misbehaving.
    if (!resolved) throw new Error('No pull request provider for this repository');
    return resolved;
  }

  async function status(): Promise<ForgeStatus> {
    const resolved = await resolve();
    if (!resolved) return { available: false };

    // Never createIfNone here: status runs on every panel load and must not
    // put an input box in front of someone who never asked to sign in.
    const session = await resolved.provider.getSession();
    return {
      available: true,
      providerId: resolved.provider.id,
      providerName: resolved.provider.name,
      signedIn: Boolean(session),
      accountLabel: session?.accountLabel,
      repo: resolved.repo,
      capabilities: resolved.provider.capabilities,
    };
  }

  function listState(params: Record<string, unknown>): PullRequestListState {
    const state = params.state as string | undefined;
    return (state && LIST_STATES.has(state) ? state : 'open') as PullRequestListState;
  }

  async function handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'forge.status':
        return status();

      case 'forge.signIn': {
        const { provider } = await requireForge();
        const session = await provider.getSession({ createIfNone: true });
        deps.broadcast('forge.changed', {});
        return { signedIn: Boolean(session), accountLabel: session?.accountLabel };
      }

      case 'forge.signOut': {
        const resolved = await requireForge();
        await resolved.provider.signOut();
        deps.store.invalidate(resolved.prefix);
        deps.broadcast('forge.changed', {});
        return { success: true };
      }

      case 'forge.refresh': {
        const resolved = await requireForge();
        deps.store.invalidate(resolved.prefix);
        deps.broadcast('forge.changed', {});
        return { success: true };
      }

      case 'forge.pr.list': {
        const { provider, repo, prefix } = await requireForge();
        const state = listState(p);
        const cached = await deps.store.fetch(
          `${prefix}:list:${state}`,
          PR_LIST_TTL_MS,
          () => provider.listPullRequests(repo, { state }),
        );
        return { pullRequests: cached.value, stale: cached.stale, fetchedAt: cached.fetchedAt };
      }

      case 'forge.pr.get': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}:pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));
        return cached.value;
      }

      case 'forge.pr.comments': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}:comments:${id}`, PR_DETAIL_TTL_MS, () => provider.listComments(repo, id));
        return { comments: cached.value };
      }

      case 'forge.pr.diff': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const detail = await deps.store.fetch(
          `${prefix}:pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));

        // Keyed by the sha pair rather than the id: new commits on the pull
        // request produce a different key, so this content can never go stale.
        const cached = await deps.store.fetch(
          `${prefix}:diff:${detail.value.targetCommit}..${detail.value.sourceCommit}`,
          DIFF_TTL_MS,
          () => provider.getPullRequestDiff(repo, id),
        );
        return { diff: cached.value };
      }

      case 'forge.pr.openExternal': {
        const { provider, repo, prefix } = await requireForge();
        const id = String(p.id ?? '');
        const cached = await deps.store.fetch(
          `${prefix}:pr:${id}`, PR_DETAIL_TTL_MS, () => provider.getPullRequest(repo, id));
        await deps.openExternal(cached.value.webUrl);
        return { success: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  return handle;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/forge-method-handler.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Write the failing test for the error messages**

The spec's error table is a product requirement, not incidental polish: a 403 is
almost always a missing scope, and telling someone to sign in again makes them
re-enter the same under-scoped token until they conclude the extension is broken.

```ts
// append to tests/extension/forge-method-handler.test.ts
import { forgeErrorMessage } from '../../src/extension/controllers/forge-method-handler';
import { ForgeError } from '../../src/extension/services/forge/forge.types';
import { BITBUCKET_TOKEN_SCOPES } from '../../src/extension/services/forge/bitbucket/bitbucket-auth';

describe('forgeErrorMessage', () => {
  it('tells an expired token from a missing scope', () => {
    expect(forgeErrorMessage(new ForgeError(401, 'Unauthorized')))
      .toMatch(/expired or (has been )?revoked/i);

    const forbidden = forgeErrorMessage(new ForgeError(403, 'Forbidden'));
    expect(forbidden).toMatch(/scope/i);
    for (const scope of BITBUCKET_TOKEN_SCOPES) expect(forbidden).toContain(scope);
    expect(forbidden).not.toMatch(/sign in again/i);
  });

  it('explains a 404 as access rather than absence', () => {
    expect(forgeErrorMessage(new ForgeError(404, 'Not found')))
      .toMatch(/private repository or insufficient token scope/i);
  });

  it('reports the retry delay on a 429', () => {
    expect(forgeErrorMessage(new ForgeError(429, 'Rate limit', 37))).toContain('37');
  });

  it('passes the host message through for anything else', () => {
    expect(forgeErrorMessage(new ForgeError(500, 'Bitbucket is having a moment')))
      .toBe('Bitbucket is having a moment');
  });

  it('handles a non-ForgeError', () => {
    expect(forgeErrorMessage(new Error('socket hang up'))).toBe('socket hang up');
    expect(forgeErrorMessage('nope')).toBe('nope');
  });
});

describe('forge namespace error translation', () => {
  it('translates a provider ForgeError before it reaches the webview', async () => {
    const provider = new FakeForgeProvider({ host: 'bitbucket.org' });
    provider.listPullRequests = () => Promise.reject(new ForgeError(403, 'Forbidden'));
    const { handle } = build({ provider });

    await expect(handle('forge.pr.list', {})).rejects.toThrow(/scope/i);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/extension/forge-method-handler.test.ts`
Expected: FAIL — `forgeErrorMessage` is not exported.

- [ ] **Step 7: Implement the error messages**

Add to `src/extension/controllers/forge-method-handler.ts`:

```ts
import { BITBUCKET_TOKEN_SCOPES } from '../services/forge/bitbucket/bitbucket-auth';
import { ForgeError } from '../services/forge/forge.types';

/**
 * Turns a host failure into something that tells the reader what to do.
 *
 * 401 and 403 are deliberately separate. A 403 means the token is valid but was
 * created without a scope, so "sign in again" sends the reader in a loop with
 * the same token; naming the scopes is the only thing that ends it.
 */
export function forgeErrorMessage(error: unknown): string {
  if (!(error instanceof ForgeError)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error.status) {
    case 401:
      return 'Bitbucket API token expired or revoked — sign in again.';
    case 403:
      return `Bitbucket refused the request. The API token is missing a scope. Required: ${BITBUCKET_TOKEN_SCOPES.join(', ')}.`;
    case 404:
      return 'Cannot access this repository — private repository or insufficient token scope.';
    case 429:
      return `Bitbucket rate limit reached. Retrying in ${error.retryAfterSeconds ?? 60}s.`;
    default:
      return error.hostMessage;
  }
}
```

Wrap the switch in `handle` so nothing reaches the webview untranslated:

```ts
  async function handle(method: string, params: unknown): Promise<unknown> {
    try {
      return await dispatch(method, params);
    } catch (error) {
      if (error instanceof ForgeError) throw new Error(forgeErrorMessage(error));
      throw error;
    }
  }
```

Rename the existing `handle` body to `async function dispatch(method, params)` and leave its contents unchanged.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/extension/forge-method-handler.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 9: Commit**

```bash
git add src/extension/controllers/forge-method-handler.ts tests/extension/forge-method-handler.test.ts
git commit -m "feat(forge): forge message namespace with per-repo caching"
```

---

## Task 10: Wire the namespace into the extension host

**Files:**
- Modify: `src/extension/extension.ts` (registration near `:263-268` and `:443`)
- Test: `tests/extension/forge-host-wiring.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: a module-level `forgeHandler` shared by both hosts, plus the commands `gitGraphPro.forge.signIn` and `gitGraphPro.forge.signOut`.

**Why both hosts:** `router.register('review', reviewHandler)` already appears twice — once for the graph webview and once for the review panel — because each host owns its own `MessageRouter`. The forge namespace must be registered in both places or the review panel's future `Pull Request` mode will get "No handler for namespace: forge".

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/forge-host-wiring.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const source = readFileSync(path.join(__dirname, '../../src/extension/extension.ts'), 'utf8');

describe('forge host wiring', () => {
  // Each webview host owns its own MessageRouter, so a namespace registered
  // once reaches only one of them.
  it('registers the forge namespace on both hosts', () => {
    const registrations = source.match(/router\.register\('forge'/g) ?? [];
    expect(registrations).toHaveLength(2);
  });

  it('builds the handler once, outside the per-host session factories', () => {
    expect(source).toMatch(/const forgeHandler = createForgeHandler\(/);
  });

  it('registers the sign-in and sign-out commands', () => {
    expect(source).toContain('gitGraphPro.forge.signIn');
    expect(source).toContain('gitGraphPro.forge.signOut');
  });

  it('resolves the remote through the configured setting', () => {
    expect(source).toContain('gitGraphPro.forge.remote');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/forge-host-wiring.test.ts`
Expected: FAIL — 0 registrations found.

- [ ] **Step 3: Build the forge stack at activation**

In `activate()`, alongside where `aiReview`, `reviewStore` and `activeRepo` are constructed, add:

```ts
  const forgeRegistry = new ForgeRegistry();
  const forgeStore = new ForgeStore();

  const bitbucketAuth = new BitbucketAuthProvider({
    secrets: context.secrets,
    prompt: promptForBitbucketCredentials,
    verify: async (credentials) => {
      // A throwaway client bound to the credentials being verified — the real
      // one reads from the auth provider, which has not stored them yet.
      const probe = new BitbucketApi({ getCredentials: async () => credentials });
      const user = await probe.getJson<{ display_name?: string }>('/user');
      return user.display_name ?? credentials.email;
    },
  });
  context.subscriptions.push({ dispose: () => bitbucketAuth.dispose() });

  forgeRegistry.register(new BitbucketCloudProvider({
    api: new BitbucketApi({ getCredentials: () => bitbucketAuth.getCredentials() }),
    auth: bitbucketAuth,
  }));

  const forgeHandler = createForgeHandler({
    registry: forgeRegistry,
    store: forgeStore,
    getRemoteUrl: async () => {
      const gitService = activeRepo.getGitService();
      if (!gitService) return undefined;
      const remote = vscode.workspace.getConfiguration().get<string>('gitGraphPro.forge.remote') ?? 'origin';
      return gitService.getRemoteUrl(remote);
    },
    broadcast: (event, data) => routers.broadcast(event, data),
    openExternal: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
  });
```

With this helper above `activate()`:

```ts
/**
 * Two input boxes rather than a browser flow. Bitbucket Cloud removed app
 * passwords in July 2026 and has no PKCE, so an OAuth consumer would need both
 * a client secret an extension cannot hide and workspace admin rights to
 * create. The scopes are listed verbatim because Bitbucket grants them to the
 * token, not to the request.
 */
async function promptForBitbucketCredentials(): Promise<BitbucketCredentials | undefined> {
  const email = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket (1 of 2)',
    prompt: 'Your Atlassian account email',
    ignoreFocusOut: true,
    validateInput: (value) => (value.includes('@') ? undefined : 'Enter the email address of your Atlassian account'),
  });
  if (!email) return undefined;

  const token = await vscode.window.showInputBox({
    title: 'Sign in to Bitbucket (2 of 2)',
    prompt: `API token with scopes: ${BITBUCKET_TOKEN_SCOPES.join(', ')}`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Paste the API token'),
  });
  if (!token) return undefined;

  return { email: email.trim(), token: token.trim() };
}
```

- [ ] **Step 4: Register on both hosts and add the commands**

In `createSession(host)`, after `router.register('graph', ...)`:

```ts
    router.register('forge', forgeHandler);
```

In `createReviewSession(host)`, after `router.register('review', reviewHandler)`:

```ts
    router.register('forge', forgeHandler);
```

Alongside the other `registerCommand` calls:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('gitGraphPro.forge.signIn', async () => {
      await forgeHandler('forge.signIn', {});
    }),
    vscode.commands.registerCommand('gitGraphPro.forge.signOut', async () => {
      await forgeHandler('forge.signOut', {});
    }),
  );
```

Add the imports at the top of `extension.ts`:

```ts
import { createForgeHandler } from './controllers/forge-method-handler';
import { ForgeRegistry } from './services/forge/forge-registry';
import { ForgeStore } from './services/forge/forge-store';
import { BitbucketApi } from './services/forge/bitbucket/bitbucket-api';
import { BitbucketAuthProvider, BITBUCKET_TOKEN_SCOPES, type BitbucketCredentials } from './services/forge/bitbucket/bitbucket-auth';
import { BitbucketCloudProvider } from './services/forge/bitbucket/bitbucket-cloud.provider';
```

- [ ] **Step 5: Invalidate the cache after a push or fetch**

The spec lists this as a refresh trigger, and it is the one the extension is
uniquely placed to catch: pushing to a pull request's source branch is the most
common reason its state changes, and nothing else will tell the panel.

`git.push`, `git.pull` and `git.fetch` already route through `session.handleGit`.
Wrap that registration rather than reaching into `GitService`:

```ts
    const MUTATING_REMOTE_METHODS = new Set(['git.push', 'git.pull', 'git.fetch']);

    router.register('git', async (method: string, params: unknown) => {
      const result = await session.handleGit(method, params);
      if (MUTATING_REMOTE_METHODS.has(method)) {
        // Cheap: drops cache entries, does not fetch. The next panel read pays.
        forgeStore.clear();
        routers.broadcast('forge.changed', {});
      }
      return result;
    });
```

Add to `tests/extension/forge-host-wiring.test.ts`:

```ts
  it('clears the forge cache after a push, pull or fetch', () => {
    expect(source).toContain('MUTATING_REMOTE_METHODS');
    expect(source).toMatch(/forgeStore\.clear\(\)/);
  });
```

- [ ] **Step 6: Run the wiring test and the full suite**

Run: `npx vitest run tests/extension/forge-host-wiring.test.ts`
Expected: PASS, 5 tests.

Run: `npx vitest run && npx tsc --noEmit`
Expected: the whole suite passes and the project type-checks.

- [ ] **Step 7: Commit**

```bash
git add src/extension/extension.ts tests/extension/forge-host-wiring.test.ts
git commit -m "feat(forge): register the forge namespace on both webview hosts"
```

---

## Task 11: The `PULL REQUESTS` sidebar section

**Files:**
- Create: `src/webview/components/sidebar/PullRequestList.svelte`
- Modify: `src/webview/components/sidebar/BranchSidebar.svelte`, `src/webview/lib/sidebar-state.ts`
- Test: `tests/webview/pull-request-list.test.ts`

**Interfaces:**
- Consumes: `forge.status` and `forge.pr.list` from Task 9, through `bridge` in `src/webview/lib/message-bridge.ts`.
- Produces: `PullRequestList.svelte` with props `{ pullRequests: PullRequestSummary[]; stale: boolean; signedIn: boolean; query: string }` and events `select` (`{ detail: { id: string } }`) and `signIn`.

**Placement:** the section renders after SUBMODULES in `BranchSidebar.svelte` and **defaults to collapsed** — the file's own comment at line 142 notes that six expanded sections already push the branch list off screen.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webview/pull-request-list.test.ts
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PullRequestList from '../../src/webview/components/sidebar/PullRequestList.svelte';

const pr = (overrides: Record<string, unknown> = {}) => ({
  id: '123', number: 123, title: 'fix(auth): refresh token race', state: 'open',
  author: { displayName: 'An Tran', accountId: 'a' },
  sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
  reviewers: [
    { user: { displayName: 'An Tran', accountId: 'a' }, status: 'approved' },
    { user: { displayName: 'Minh Le', accountId: 'm' }, status: 'changes_requested' },
  ],
  commentCount: 8, webUrl: 'https://example.test/123', updatedAt: '2026-08-25T09:30:00Z',
  ...overrides,
});

describe('PullRequestList', () => {
  it('shows a single sign-in row when signed out', () => {
    render(PullRequestList, { pullRequests: [], stale: false, signedIn: false, query: '' });
    expect(screen.getByRole('button', { name: /sign in to bitbucket/i })).toBeInTheDocument();
    expect(screen.queryByText(/#123/)).not.toBeInTheDocument();
  });

  it('emits signIn when that row is clicked', async () => {
    const { component } = render(PullRequestList, { pullRequests: [], stale: false, signedIn: false, query: '' });
    let fired = false;
    component.$on('signIn', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /sign in to bitbucket/i }));
    expect(fired).toBe(true);
  });

  it('renders number, title and approval counts', () => {
    render(PullRequestList, { pullRequests: [pr()], stale: false, signedIn: true, query: '' });
    expect(screen.getByText('#123')).toBeInTheDocument();
    expect(screen.getByText('fix(auth): refresh token race')).toBeInTheDocument();
    expect(screen.getByLabelText('1 approved')).toBeInTheDocument();
    expect(screen.getByLabelText('1 requested changes')).toBeInTheDocument();
  });

  it('marks a draft', () => {
    render(PullRequestList, { pullRequests: [pr({ state: 'draft' })], stale: false, signedIn: true, query: '' });
    expect(screen.getByLabelText('Draft')).toBeInTheDocument();
  });

  it('emits select with the pull request id', async () => {
    const { component } = render(PullRequestList, { pullRequests: [pr()], stale: false, signedIn: true, query: '' });
    let selected = '';
    component.$on('select', (event) => { selected = (event as CustomEvent<{ id: string }>).detail.id; });
    await fireEvent.click(screen.getByRole('button', { name: /#123/ }));
    expect(selected).toBe('123');
  });

  it.each([
    ['123', 1],
    ['refresh', 1],
    ['RMS-1027', 1],
    ['nothing', 0],
  ])('filters on %j', (query, expected) => {
    render(PullRequestList, { pullRequests: [pr()], stale: false, signedIn: true, query });
    expect(screen.queryAllByRole('button', { name: /#123/ })).toHaveLength(expected);
  });

  // The screen must not empty out because the network blinked.
  it('shows a stale marker without hiding the rows', () => {
    render(PullRequestList, { pullRequests: [pr()], stale: true, signedIn: true, query: '' });
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    expect(screen.getByText('#123')).toBeInTheDocument();
  });

  it('says so when there is nothing open', () => {
    render(PullRequestList, { pullRequests: [], stale: false, signedIn: true, query: '' });
    expect(screen.getByText(/no open pull requests/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/pull-request-list.test.ts`
Expected: FAIL — cannot resolve `PullRequestList.svelte`.

- [ ] **Step 3: Write minimal implementation**

```svelte
<!-- src/webview/components/sidebar/PullRequestList.svelte -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface ForgeUser { displayName: string; accountId: string }
  interface Reviewer { user: ForgeUser; status: 'approved' | 'changes_requested' | 'pending' }
  export interface PullRequestRow {
    id: string;
    number: number;
    title: string;
    state: 'open' | 'merged' | 'closed' | 'draft';
    sourceBranch: string;
    reviewers: Reviewer[];
    commentCount: number;
  }

  export let pullRequests: PullRequestRow[] = [];
  export let stale = false;
  export let signedIn = false;
  export let query = '';

  const dispatch = createEventDispatcher<{ select: { id: string }; signIn: void }>();

  /* Number, title and source branch are the three things someone searches by. */
  $: needle = query.trim().toLowerCase();
  $: visible = needle
    ? pullRequests.filter((pr) =>
        String(pr.number).includes(needle)
        || pr.title.toLowerCase().includes(needle)
        || pr.sourceBranch.toLowerCase().includes(needle))
    : pullRequests;

  const countBy = (pr: PullRequestRow, status: Reviewer['status']) =>
    pr.reviewers.filter((reviewer) => reviewer.status === status).length;
</script>

{#if !signedIn}
  <button type="button" class="pr-signin" on:click={() => dispatch('signIn')}>
    Sign in to Bitbucket
  </button>
{:else}
  {#if stale}
    <div class="pr-stale">Showing cached pull requests — stale</div>
  {/if}

  {#if visible.length === 0}
    <div class="pr-empty">{needle ? 'No matching pull requests' : 'No open pull requests'}</div>
  {:else}
    {#each visible as pr (pr.id)}
      <button type="button" class="pr-row" on:click={() => dispatch('select', { id: pr.id })}>
        <span class="pr-state" class:draft={pr.state === 'draft'}
              aria-label={pr.state === 'draft' ? 'Draft' : 'Open'}>●</span>
        <span class="pr-number">#{pr.number}</span>
        <span class="pr-title">{pr.title}</span>

        {#if countBy(pr, 'approved') > 0}
          <span class="pr-chip approved" aria-label="{countBy(pr, 'approved')} approved">
            ✓{countBy(pr, 'approved')}
          </span>
        {/if}
        {#if countBy(pr, 'changes_requested') > 0}
          <span class="pr-chip changes" aria-label="{countBy(pr, 'changes_requested')} requested changes">
            ✗{countBy(pr, 'changes_requested')}
          </span>
        {/if}
      </button>
    {/each}
  {/if}
{/if}

<style>
  .pr-signin,
  .pr-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 8px 3px 20px;
    border: none;
    background: none;
    color: var(--vscode-foreground);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .pr-signin:hover,
  .pr-row:hover { background: var(--vscode-list-hoverBackground); }
  .pr-signin { color: var(--vscode-textLink-foreground); }
  .pr-state { color: var(--vscode-gitDecoration-untrackedResourceForeground); font-size: 10px; }
  .pr-state.draft { opacity: 0.55; }
  .pr-number { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .pr-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-chip { margin-left: auto; flex-shrink: 0; font-size: 11px; }
  .pr-chip.approved { color: var(--vscode-testing-iconPassed); }
  .pr-chip.changes { color: var(--vscode-testing-iconFailed); }
  .pr-stale,
  .pr-empty {
    padding: 3px 8px 3px 20px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-style: italic;
  }
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/pull-request-list.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mount the section in the sidebar**

In `src/webview/lib/sidebar-state.ts`, add `pullRequests` to the persisted sections with a default of `false`.

In `BranchSidebar.svelte`:

- add `pullRequestsExpanded = initialState.sections.pullRequests ?? false;` beside the other section flags, and include `pullRequests: pullRequestsExpanded` in the object written back in `sections: { ... }`
- add `pullRequests: pullRequestsExpanded` to the `sectionOpen` reactive block and `pullRequests: forgeAvailable && (!searching || visiblePullRequests.length > 0)` to `sectionVisible`
- accept `export let forgeAvailable = false; export let forgeSignedIn = false; export let pullRequests: PullRequestRow[] = []; export let pullRequestsStale = false;`
- render after the SUBMODULES section:

```svelte
  <!-- PULL REQUESTS section -->
  {#if sectionVisible.pullRequests}
  <div class="section">
    <button
      class="section-header"
      on:click={() => { pullRequestsExpanded = !pullRequestsExpanded; persist(); }}
    >
      <span class="chevron" class:collapsed={!sectionOpen.pullRequests}><Icon name="chevron-right" /></span>
      <span class="section-title">PULL REQUESTS</span>
      <span class="section-count">{pullRequests.length}</span>
    </button>

    {#if sectionOpen.pullRequests}
      <PullRequestList
        {pullRequests}
        stale={pullRequestsStale}
        signedIn={forgeSignedIn}
        {query}
        on:select
        on:signIn
      />
    {/if}
  </div>
  {/if}
```

- [ ] **Step 6: Run the webview suite**

Run: `npx vitest run tests/webview`
Expected: PASS, including the existing `BranchSidebar` tests.

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/sidebar/PullRequestList.svelte src/webview/components/sidebar/BranchSidebar.svelte src/webview/lib/sidebar-state.ts tests/webview/pull-request-list.test.ts
git commit -m "feat(forge): PULL REQUESTS sidebar section, collapsed by default"
```

---

## Task 12: The pull request detail panel

**Files:**
- Create: `src/webview/components/detail/PullRequestDetail.svelte`
- Test: `tests/webview/pull-request-detail.test.ts`

**Interfaces:**
- Consumes: `forge.pr.get` and `forge.pr.comments` from Task 9; `FileTreeList.svelte`.
- Produces: `PullRequestDetail.svelte` with props `{ pullRequest: PullRequestDetailModel | null; comments: ForgeComment[]; files: ChangedFile[]; capabilities: ForgeCapabilities }` and events `openExternal`, `reviewWithAi`, `openFile`, `approve`, `requestChanges`, `merge`.

**`FileTreeList` contract — do not guess it.** It takes `nodes: PathTreeNode<ChangedFile>[]` and `collapsedFolders: Record<string, boolean>`, and dispatches `folderToggle` (`{ detail: { path } }`) and `openFile` (`{ detail: <the ChangedFile item> }`). Build `nodes` with `buildPathTree(files, (file) => file.path)` from `src/webview/lib/path-tree.ts` and own `collapsedFolders` locally, exactly as `CommitDetail.svelte:54-66,160-164` does.

**Capability gating:** an unsupported action is **absent**, not disabled. In these phases `Approve`, `Request changes` and `Merge` are rendered but the provider rejects them with 501 — so the buttons are wired to `capabilities` now and become live in Phase 6 with no UI change.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webview/pull-request-detail.test.ts
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PullRequestDetail from '../../src/webview/components/detail/PullRequestDetail.svelte';

const capabilities = {
  createPullRequest: true, approve: true, requestChanges: true, merge: true,
  mergeStrategies: ['merge-commit', 'squash', 'fast-forward'],
};

const pullRequest = {
  id: '123', number: 123, title: 'fix(auth): refresh token race', state: 'open',
  author: { displayName: 'An Tran', accountId: 'a' },
  sourceBranch: 'feature/RMS-1027', targetBranch: 'develop',
  reviewers: [
    { user: { displayName: 'An Tran', accountId: 'a' }, status: 'approved' },
    { user: { displayName: 'Hoa Pham', accountId: 'h' }, status: 'pending' },
  ],
  commentCount: 2, webUrl: 'https://example.test/123', updatedAt: '2026-08-25T09:30:00Z',
  description: 'Single-flight the refresh.', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
  mergeable: 'conflicted',
};

const comments = [
  { id: '1', author: { displayName: 'Minh Le', accountId: 'm' }, body: 'This drops the mutex.', createdAt: '2026-08-21T03:00:00Z', path: 'src/auth.ts', line: 42 },
  { id: '2', author: { displayName: 'An Tran', accountId: 'a' }, body: 'Fixed.', createdAt: '2026-08-21T04:00:00Z', parentId: '1' },
];

const props = { pullRequest, comments, files: [], capabilities };

describe('PullRequestDetail', () => {
  it('renders the header, branches and description', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText('#123')).toBeInTheDocument();
    expect(screen.getByText('fix(auth): refresh token race')).toBeInTheDocument();
    expect(screen.getByText('feature/RMS-1027')).toBeInTheDocument();
    expect(screen.getByText('develop')).toBeInTheDocument();
    expect(screen.getByText('Single-flight the refresh.')).toBeInTheDocument();
  });

  it('warns when the pull request is conflicted', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText(/conflicted/i)).toBeInTheDocument();
  });

  it('lists reviewers with their status as accessible labels', () => {
    render(PullRequestDetail, props);
    expect(screen.getByLabelText('An Tran approved')).toBeInTheDocument();
    expect(screen.getByLabelText('Hoa Pham pending')).toBeInTheDocument();
  });

  it('shows an inline comment with its file and line', () => {
    render(PullRequestDetail, props);
    expect(screen.getByText('src/auth.ts:42')).toBeInTheDocument();
    expect(screen.getByText('This drops the mutex.')).toBeInTheDocument();
  });

  it('marks a reply as belonging to its thread', () => {
    render(PullRequestDetail, props);
    expect(screen.getByTestId('comment-2')).toHaveAttribute('data-parent', '1');
  });

  it('emits reviewWithAi', async () => {
    const { component } = render(PullRequestDetail, props);
    let fired = false;
    component.$on('reviewWithAi', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /review with ai/i }));
    expect(fired).toBe(true);
  });

  it('emits openExternal', async () => {
    const { component } = render(PullRequestDetail, props);
    let fired = false;
    component.$on('openExternal', () => { fired = true; });
    await fireEvent.click(screen.getByRole('button', { name: /open in browser/i }));
    expect(fired).toBe(true);
  });

  // An unsupported action is absent, never disabled.
  it('omits actions the provider does not support', () => {
    render(PullRequestDetail, {
      ...props,
      capabilities: { ...capabilities, approve: false, merge: false },
    });
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^merge/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request changes/i })).toBeInTheDocument();
  });

  it('renders nothing when no pull request is selected', () => {
    const { container } = render(PullRequestDetail, { ...props, pullRequest: null });
    expect(container.textContent?.trim()).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/pull-request-detail.test.ts`
Expected: FAIL — cannot resolve `PullRequestDetail.svelte`.

- [ ] **Step 3: Write minimal implementation**

```svelte
<!-- src/webview/components/detail/PullRequestDetail.svelte -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import FileTreeList from './FileTreeList.svelte';
  import { buildPathTree } from '../../lib/path-tree';

  interface ForgeUser { displayName: string; accountId: string }
  interface Reviewer { user: ForgeUser; status: 'approved' | 'changes_requested' | 'pending' }
  interface Comment {
    id: string; author: ForgeUser; body: string; createdAt: string;
    parentId?: string; path?: string; line?: number;
  }
  interface Capabilities {
    createPullRequest: boolean; approve: boolean; requestChanges: boolean;
    merge: boolean; mergeStrategies: string[];
  }
  interface PullRequest {
    id: string; number: number; title: string; state: string;
    sourceBranch: string; targetBranch: string; description: string;
    reviewers: Reviewer[]; mergeable: string; webUrl: string;
  }

  export let pullRequest: PullRequest | null = null;
  export let comments: Comment[] = [];
  export let files: { path: string }[] = [];

  /* Same shape CommitDetail feeds FileTreeList; the component takes a tree,
     not a flat list, and owns no collapse state of its own. */
  let collapsedFolders: Record<string, boolean> = {};
  $: fileTree = buildPathTree(files, (file) => file.path);
  export let capabilities: Capabilities;

  const dispatch = createEventDispatcher<{
    openExternal: void; reviewWithAi: void; openFile: { path: string };
    approve: void; requestChanges: void; merge: { strategy: string };
  }>();

  const STATUS_MARK = { approved: '✓', changes_requested: '✗', pending: '⧗' } as const;
</script>

{#if pullRequest}
  <div class="pr-detail">
    <header class="pr-header">
      <span class="pr-number">#{pullRequest.number}</span>
      <h2 class="pr-title">{pullRequest.title}</h2>
      <button type="button" on:click={() => dispatch('openExternal')}>Open in browser</button>
    </header>

    <div class="pr-branches">
      <code>{pullRequest.sourceBranch}</code>
      <span aria-hidden="true">→</span>
      <code>{pullRequest.targetBranch}</code>
      <span class="pr-state">{pullRequest.state}</span>
      {#if pullRequest.mergeable === 'conflicted'}
        <span class="pr-conflict">⚠ conflicted</span>
      {/if}
    </div>

    {#if pullRequest.description}
      <p class="pr-description">{pullRequest.description}</p>
    {/if}

    <section class="pr-reviewers">
      <h3>Reviewers</h3>
      {#each pullRequest.reviewers as reviewer (reviewer.user.accountId)}
        <span class="reviewer {reviewer.status}" aria-label="{reviewer.user.displayName} {reviewer.status}">
          {STATUS_MARK[reviewer.status]} {reviewer.user.displayName}
        </span>
      {/each}
    </section>

    <section class="pr-files">
      <h3>Files ({files.length})</h3>
      <FileTreeList
        nodes={fileTree}
        {collapsedFolders}
        on:folderToggle={(event) => {
          collapsedFolders = { ...collapsedFolders, [event.detail.path]: !collapsedFolders[event.detail.path] };
        }}
        on:openFile={(event) => dispatch('openFile', event.detail)}
      />
    </section>

    <section class="pr-comments">
      <h3>Comments ({comments.length})</h3>
      {#each comments as comment (comment.id)}
        <article
          class="comment"
          class:reply={Boolean(comment.parentId)}
          data-testid="comment-{comment.id}"
          data-parent={comment.parentId ?? ''}
        >
          <span class="comment-author">{comment.author.displayName}</span>
          {#if comment.path}
            <span class="comment-anchor">{comment.path}{comment.line ? `:${comment.line}` : ''}</span>
          {/if}
          <p class="comment-body">{comment.body}</p>
        </article>
      {/each}
    </section>

    <footer class="pr-actions">
      <button type="button" on:click={() => dispatch('reviewWithAi')}>Review with AI</button>
      {#if capabilities.approve}
        <button type="button" on:click={() => dispatch('approve')}>Approve</button>
      {/if}
      {#if capabilities.requestChanges}
        <button type="button" on:click={() => dispatch('requestChanges')}>Request changes</button>
      {/if}
      {#if capabilities.merge}
        <button type="button" on:click={() => dispatch('merge', { strategy: capabilities.mergeStrategies[0] })}>
          Merge
        </button>
      {/if}
    </footer>
  </div>
{/if}

<style>
  .pr-detail { display: flex; flex-direction: column; gap: 12px; padding: 12px; font-size: 12px; }
  .pr-header { display: flex; align-items: baseline; gap: 8px; }
  .pr-title { margin: 0; font-size: 13px; font-weight: 600; }
  .pr-number { color: var(--vscode-descriptionForeground); }
  .pr-header button { margin-left: auto; }
  .pr-branches { display: flex; align-items: center; gap: 8px; }
  .pr-conflict { color: var(--vscode-editorWarning-foreground); }
  .pr-description { margin: 0; white-space: pre-wrap; }
  h3 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .pr-reviewers { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .reviewer.approved { color: var(--vscode-testing-iconPassed); }
  .reviewer.changes_requested { color: var(--vscode-testing-iconFailed); }
  .comment { padding: 4px 0; border-top: 1px solid var(--vscode-panel-border); }
  .comment.reply { padding-left: 16px; }
  .comment-anchor { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
  .comment-body { margin: 2px 0 0; white-space: pre-wrap; }
  .pr-actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/pull-request-detail.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/detail/PullRequestDetail.svelte tests/webview/pull-request-detail.test.ts
git commit -m "feat(forge): pull request detail panel with capability-gated actions"
```

---

## Task 13: Connect the sidebar to the graph, and close out coverage

**Files:**
- Modify: `src/webview/App.svelte`, `vitest.config.ts`, `README.md`
- Test: `tests/webview/forge-app-wiring.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `deriveBranchPullRequests(pullRequests): Map<string, number>` exported from `src/webview/lib/branch-pull-requests.ts` — source branch name to pull request number, for the `#123` badge on branch rows.

**Why a separate module:** `App.svelte` is already large, and a pure function is testable without mounting the whole app.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webview/forge-app-wiring.test.ts
import { describe, expect, it } from 'vitest';
import { deriveBranchPullRequests } from '../../src/webview/lib/branch-pull-requests';

const pr = (number: number, sourceBranch: string, state = 'open') => ({
  id: String(number), number, sourceBranch, state,
});

describe('deriveBranchPullRequests', () => {
  it('maps a source branch to its pull request number', () => {
    const map = deriveBranchPullRequests([pr(123, 'feature/RMS-1027')] as never);
    expect(map.get('feature/RMS-1027')).toBe(123);
  });

  it('ignores branches with no pull request', () => {
    const map = deriveBranchPullRequests([pr(123, 'feature/a')] as never);
    expect(map.get('feature/b')).toBeUndefined();
  });

  // Reopening a branch produces a second PR; the badge should name the live one.
  it('keeps the highest number when a branch has more than one', () => {
    const map = deriveBranchPullRequests([pr(101, 'feature/a'), pr(140, 'feature/a')] as never);
    expect(map.get('feature/a')).toBe(140);
  });

  it('skips merged and closed pull requests', () => {
    const map = deriveBranchPullRequests([
      pr(101, 'feature/a', 'merged'),
      pr(102, 'feature/b', 'closed'),
      pr(103, 'feature/c', 'draft'),
    ] as never);
    expect(map.has('feature/a')).toBe(false);
    expect(map.has('feature/b')).toBe(false);
    expect(map.get('feature/c')).toBe(103);
  });

  it('returns an empty map for no pull requests', () => {
    expect(deriveBranchPullRequests([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/forge-app-wiring.test.ts`
Expected: FAIL — cannot resolve `branch-pull-requests`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/webview/lib/branch-pull-requests.ts

interface PullRequestLike {
  number: number;
  sourceBranch: string;
  state: 'open' | 'merged' | 'closed' | 'draft';
}

/**
 * Source branch → pull request number, for the badge on a branch row.
 *
 * Only live pull requests count. A branch that was merged and reused would
 * otherwise carry a badge pointing at history. When a branch genuinely has two
 * open pull requests the higher number wins, since that is the newer one.
 */
export function deriveBranchPullRequests(pullRequests: PullRequestLike[]): Map<string, number> {
  const byBranch = new Map<string, number>();

  for (const pr of pullRequests) {
    if (pr.state !== 'open' && pr.state !== 'draft') continue;
    if (!pr.sourceBranch) continue;

    const existing = byBranch.get(pr.sourceBranch);
    if (existing === undefined || pr.number > existing) {
      byBranch.set(pr.sourceBranch, pr.number);
    }
  }
  return byBranch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/forge-app-wiring.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into `App.svelte`**

In `App.svelte`:

- on mount and on the `forge.changed` event, call `forge.status`; when `available`, call `forge.pr.list` and hold `{ pullRequests, stale }`
- pass `forgeAvailable`, `forgeSignedIn`, `pullRequests`, `pullRequestsStale` down to `BranchSidebar`
- handle `on:signIn` by calling `forge.signIn`, then re-running `forge.status`
- handle `on:select` by calling `forge.pr.get` and `forge.pr.comments`, showing `PullRequestDetail` in the right-hand panel, and scrolling the graph to `sourceCommit` through the existing `graph.getRow` path used by commit search
- compute `$: branchPullRequests = deriveBranchPullRequests(pullRequests);` and pass it to `BranchTreeList` so a branch row can render its `#123` badge

- [ ] **Step 6: Add the new files to coverage**

In `vitest.config.ts`, add to `coverage.include`:

```ts
        'src/extension/services/forge/remote-url.ts',
        'src/extension/services/forge/forge-registry.ts',
        'src/extension/services/forge/forge-store.ts',
        'src/extension/services/forge/bitbucket/bitbucket-auth.ts',
        'src/extension/services/forge/bitbucket/bitbucket-api.ts',
        'src/extension/services/forge/bitbucket/bitbucket-mapper.ts',
        'src/extension/services/forge/bitbucket/bitbucket-cloud.provider.ts',
        'src/extension/controllers/forge-method-handler.ts',
        'src/webview/components/sidebar/PullRequestList.svelte',
        'src/webview/components/detail/PullRequestDetail.svelte',
```

- [ ] **Step 7: Run everything**

Run: `npx vitest run --coverage && npx tsc --noEmit && npm run build`
Expected: all tests pass, coverage stays at or above statements 80 / lines 80 / functions 80 / branches 70, the project type-checks, and the bundle builds.

- [ ] **Step 8: Document the feature**

Add to `README.md` under Features:

```markdown
### 🔀 Pull Requests (Bitbucket Cloud)

- Open pull requests listed in the branch sidebar, tied to their source branch
- Reviewer approval state, comment threads and changed files in the detail panel
- Selecting a pull request jumps the graph to its head commit

Requires an Atlassian API token with scopes `read:account`, `read:repository:bitbucket`,
`read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`. Run
**Git Graph Pro: Sign in to Bitbucket** from the Command Palette. The token is stored in
VS Code's SecretStorage and never leaves the extension host.
```

- [ ] **Step 9: Commit**

```bash
git add src/webview/lib/branch-pull-requests.ts src/webview/App.svelte vitest.config.ts README.md tests/webview/forge-app-wiring.test.ts
git commit -m "feat(forge): tie pull requests to branches and the graph"
```

---

## Manual verification

Automated tests never touch Bitbucket, so run this once against a real repository before calling Phase 3 done.

- [ ] Open a workspace whose `origin` is a Bitbucket Cloud repository. The sidebar shows a collapsed `PULL REQUESTS` section.
- [ ] Expand it while signed out — exactly one `Sign in to Bitbucket` row, no error.
- [ ] Sign in with a correctly scoped token. The account appears in the VS Code Accounts menu.
- [ ] Sign in with a deliberately mistyped token — it is rejected at the input box, and nothing is stored.
- [ ] Sign in with a token missing `read:pullrequest:bitbucket` — the error names the missing scope rather than asking you to sign in again.
- [ ] Open pull requests are listed with their numbers, titles and approval chips; a draft is marked.
- [ ] Select one — description, reviewers, files and comments appear, and the graph scrolls to its head commit.
- [ ] The branch row for its source branch carries a `#123` badge.
- [ ] Type a pull request number, a word from a title, and a branch name into the sidebar search — each filters the section.
- [ ] Disconnect from the network and press refresh — the rows stay, marked stale.
- [ ] Open a workspace with a GitHub remote — no `PULL REQUESTS` section at all, and no error in the output channel.
- [ ] Switch repositories with the picker — the section reloads for the new repository.
- [ ] Push a commit to a pull request's source branch from the extension — the section refreshes on its own, with no manual refresh.

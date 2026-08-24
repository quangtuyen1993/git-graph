# Graph Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening the Git Graph panel paint immediately from a cached first screen instead of waiting for a full `git log`.

**Architecture:** Stale-while-revalidate. A `GraphCache` service persists one small snapshot per repository under `globalStorageUri` — the first ~60 graph rows plus the sidebar metadata, about 30KB whatever the repo size. On open the webview reads that snapshot and paints it, runs the normal refresh in parallel, then swaps in the fresh layout. The swap always happens, because the webview needs a live `layoutVersion` to scroll against; the validity key only decides whether the swap is silent or announced.

**Tech Stack:** TypeScript, VS Code Extension API, Svelte 4 webview, Vitest with a per-file `vi.mock('vscode', ...)`, esbuild (host) + Vite (webview).

**Spec:** `docs/superpowers/specs/2026-08-24-graph-cache-design.md`

## Global Constraints

- Engine floor is `"vscode": "^1.85.0"` (`package.json`). Do not use API added after that.
- `activationEvents` stays `[]`. Do not add `onStartupFinished`.
- Writes to the snapshot file must be **atomic**: temp file plus `rename()`. A plain `writeFile` truncates before writing, and a reader landing in that window sees half a file. This is the exact failure `ReviewStore` hit; do not repeat it.
- Reads must **never throw**. A missing file, malformed JSON, or wrong shape all return `null`. A corrupt cache degrades to "no cache", never to a failed activation.
- A snapshot is written **only after a fully successful refresh**. A partial or failed refresh must not persist, or one transient git error becomes what the user sees on every subsequent open.
- The repository id is stamped **host-side** from `activeRepo.getRepoId()`. Never take it from the message payload.
- `repoId` comes from the existing `repoIdFor()` in `src/extension/services/review-key.ts` — sha256 of the realpath, truncated to 12 hex characters.
- The snapshot stores a whole `GraphWindow` (`nodes`, `edges`, `startRow`, `endRow`, `totalRows`, `maxLane`). The webview declares that shape at `src/webview/App.svelte:60-67`; a trimmed object will not typecheck at the assignment.
- At most 20 snapshot files are kept, oldest `savedAt` evicted first.
- Tests mock `vscode` per file with `vi.mock('vscode', () => ({ ... }))`. There is no `@vscode/test-electron`; anything needing a real VS Code window is manual-only.
- Run `npm run check` before the commit that closes each phase.

## File Structure

**Create:**
- `src/extension/services/graph-cache.ts` — all snapshot persistence: atomic write, forgiving read, mtime cap. No `vscode` import, so it tests against a real temp directory.
- `src/extension/controllers/cache-method-handler.ts` — the `cache.*` namespace behind injected callbacks, matching `review-method-handler.ts`, so it tests without `vscode`.
- `src/webview/lib/skeleton-rows.ts` — the pure "which visible rows have no data yet" calculation, so it tests without rendering.
- `tests/extension/graph-cache.test.ts`, `tests/extension/graph-cache-namespace.test.ts`, `tests/webview/app-graph-cache.test.ts`, `tests/webview/skeleton-rows.test.ts`.

**Modify:**
- `src/extension/extension.ts` — construct the cache, register `cache.*` on the graph session.
- `src/webview/App.svelte` — post a snapshot after each successful refresh (Phase 1), read and paint one on mount (Phase 2), render skeleton rows (Phase 3).
- `src/webview/ReviewApp.svelte:74-81` — take `ai.providers` out of the mount `Promise.all` (Phase 4).

Splitting storage from the message namespace is deliberate: the store is pure filesystem and tests against a temp dir, while the handler is pure routing and tests against fakes. Fusing them would force every test to set up both.

---

## Phase 1 — GraphCache and the cache.* namespace

Tasks 1-3. Ships invisibly: snapshots are written but never read back, so the storage layer is proven before any UX depends on it.

### Task 1: GraphCache persistence

**Files:**
- Create: `src/extension/services/graph-cache.ts`
- Test: `tests/extension/graph-cache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GraphSnapshot`, `MAX_SNAPSHOTS`, and `class GraphCache` with `read(repoId)`, `write(repoId, snapshot)`, `prune()`, `snapshotPath(repoId)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/graph-cache.test.ts
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphCache, MAX_SNAPSHOTS, type GraphSnapshot } from '../../src/extension/services/graph-cache';

let root: string;
let cache: GraphCache;

function snapshot(over: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    headSha: 'a'.repeat(40),
    totalRows: 3,
    maxLane: 1,
    window: { nodes: [], edges: [], startRow: 0, endRow: 3, totalRows: 3, maxLane: 1 },
    branches: [], tags: [], stashes: [], worktrees: [],
    hasWorkingChanges: false,
    savedAt: '2026-08-24T00:00:00.000Z',
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-cache-'));
  cache = new GraphCache(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GraphCache', () => {
  it('round-trips a snapshot', async () => {
    await cache.write('repo-a', snapshot({ totalRows: 42 }));

    expect(await cache.read('repo-a')).toMatchObject({ totalRows: 42 });
  });

  it('returns null for a repository it has never seen', async () => {
    expect(await cache.read('never-seen')).toBeNull();
  });

  it('keeps repositories apart', async () => {
    await cache.write('repo-a', snapshot({ totalRows: 1 }));
    await cache.write('repo-b', snapshot({ totalRows: 2 }));

    expect((await cache.read('repo-a'))?.totalRows).toBe(1);
    expect((await cache.read('repo-b'))?.totalRows).toBe(2);
  });

  it('treats a corrupt snapshot as absent rather than throwing', async () => {
    await cache.write('repo-a', snapshot());
    await writeFile(cache.snapshotPath('repo-a'), '{ not json', 'utf8');

    expect(await cache.read('repo-a')).toBeNull();
  });

  it('treats a snapshot of the wrong shape as absent', async () => {
    await cache.write('repo-a', snapshot());
    await writeFile(cache.snapshotPath('repo-a'), JSON.stringify({ hello: true }), 'utf8');

    expect(await cache.read('repo-a')).toBeNull();
  });

  it('never leaves a half-written file for a concurrent reader', async () => {
    // 60 overlapping writes against a reader loop: a truncating writeFile would
    // let the reader observe an empty or partial file and return null.
    await cache.write('repo-a', snapshot());
    let sawNull = false;
    const reading = (async () => {
      for (let i = 0; i < 400; i += 1) {
        if ((await cache.read('repo-a')) === null) sawNull = true;
      }
    })();
    await Promise.all([
      reading,
      ...Array.from({ length: 60 }, (_, i) => cache.write('repo-a', snapshot({ totalRows: i }))),
    ]);

    expect(sawNull).toBe(false);
  });

  it('keeps only the newest snapshots once past the cap', async () => {
    for (let index = 0; index < MAX_SNAPSHOTS + 5; index += 1) {
      await cache.write(`repo-${String(index).padStart(3, '0')}`, snapshot({
        savedAt: new Date(Date.UTC(2026, 7, 24, 0, index)).toISOString(),
      }));
    }
    await cache.prune();

    const files = await readdir(root);
    expect(files).toHaveLength(MAX_SNAPSHOTS);
    expect(files).not.toContain('repo-000.json');
    expect(files).toContain(`repo-${String(MAX_SNAPSHOTS + 4).padStart(3, '0')}.json`);
  });

  it('leaves no temp files behind', async () => {
    await cache.write('repo-a', snapshot());

    expect((await readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('creates its directory on first write', async () => {
    const fresh = new GraphCache(join(root, 'nested', 'deeper'));

    await fresh.write('repo-a', snapshot());

    expect(await fresh.read('repo-a')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/graph-cache.test.ts`
Expected: FAIL — `Failed to resolve import ".../graph-cache"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/graph-cache.ts
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Branch, StashEntry, Tag, WorktreeEntry } from '../types/git.types';
import type { GraphEdge, GraphNode } from '../types/graph.types';

/** The window shape the webview declares (src/webview/App.svelte:60-67). */
export interface GraphWindow {
  nodes: GraphNode[];
  edges: GraphEdge[];
  startRow: number;
  endRow: number;
  totalRows: number;
  maxLane: number;
}

export interface GraphSnapshot {
  headSha: string;
  totalRows: number;
  maxLane: number;
  window: GraphWindow;
  branches: Branch[];
  tags: Tag[];
  stashes: StashEntry[];
  worktrees: WorktreeEntry[];
  hasWorkingChanges: boolean;
  savedAt: string;
}

export const MAX_SNAPSHOTS = 20;

/**
 * Enough of a check to reject a file that is valid JSON but not a snapshot.
 * It deliberately does not walk every branch and node: this guards against a
 * truncated or foreign file, not against a hand-edited one, and a deep
 * validation would cost more than rebuilding the graph it protects.
 */
function isSnapshot(value: unknown): value is GraphSnapshot {
  const candidate = value as GraphSnapshot | null;
  return !!candidate
    && typeof candidate.headSha === 'string'
    && typeof candidate.totalRows === 'number'
    && !!candidate.window
    && Array.isArray(candidate.window.nodes)
    && Array.isArray(candidate.window.edges);
}

export class GraphCache {
  private writeCounter = 0;

  constructor(private readonly rootDir: string) {}

  public snapshotPath(repoId: string): string {
    return join(this.rootDir, `${repoId}.json`);
  }

  /** Never throws: an unreadable snapshot is the same as no snapshot. */
  public async read(repoId: string): Promise<GraphSnapshot | null> {
    const raw = await readFile(this.snapshotPath(repoId), 'utf8').catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Atomic: a plain writeFile truncates before writing, so a reader landing in
   * that window sees a partial file. Write beside the target and rename in.
   */
  public async write(repoId: string, snapshot: GraphSnapshot): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    this.writeCounter += 1;
    const temporaryPath = `${this.snapshotPath(repoId)}.${this.writeCounter}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
      await rename(temporaryPath, this.snapshotPath(repoId));
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  /** Old repositories leave ~30KB each; without a cap the directory only grows. */
  public async prune(maxEntries: number = MAX_SNAPSHOTS): Promise<void> {
    const files = (await readdir(this.rootDir).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.json'));
    if (files.length <= maxEntries) return;

    const dated = await Promise.all(files.map(async (name) => ({
      name,
      savedAt: (await this.read(name.slice(0, -'.json'.length)))?.savedAt ?? '',
    })));
    dated.sort((left, right) => right.savedAt.localeCompare(left.savedAt));

    for (const stale of dated.slice(maxEntries)) {
      await rm(join(this.rootDir, stale.name), { force: true });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/graph-cache.test.ts`
Expected: PASS, 9 tests.

Note on the concurrency test: it must fail if `write` is changed to a plain `writeFile`. If it passes either way, the test is not doing its job — say so rather than moving on.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/graph-cache.ts tests/extension/graph-cache.test.ts
git commit -m "feat: persist a first-screen graph snapshot per repository"
```

---

### Task 2: The cache.* namespace

**Files:**
- Create: `src/extension/controllers/cache-method-handler.ts`
- Test: `tests/extension/graph-cache-namespace.test.ts`

**Interfaces:**
- Consumes: `GraphCache`, `GraphSnapshot` from Task 1.
- Produces: `GraphSnapshotInput` (a `GraphSnapshot` without the host-stamped `headSha` and `savedAt`), `CacheHandlerDeps`, and `createCacheHandler(deps)` returning `{ handle(method, params) }`.

The handler owns no filesystem code and no `vscode` import — it exists so the stamping rule (repo id and head sha come from the host, never from the message) is enforced in one testable place, the way `createReviewHandler` does it for review ids.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/graph-cache-namespace.test.ts
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCacheHandler, type GraphSnapshotInput } from '../../src/extension/controllers/cache-method-handler';
import { GraphCache } from '../../src/extension/services/graph-cache';

let root: string;
let cache: GraphCache;
let repoId: string | undefined;
let headSha: string;

const input: GraphSnapshotInput = {
  totalRows: 7,
  maxLane: 2,
  window: { nodes: [], edges: [], startRow: 0, endRow: 7, totalRows: 7, maxLane: 2 },
  branches: [], tags: [], stashes: [], worktrees: [],
  hasWorkingChanges: false,
};

function handler() {
  return createCacheHandler({
    cache,
    getRepoId: () => repoId,
    getHeadSha: async () => headSha,
    now: () => '2026-08-24T10:00:00.000Z',
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cache-ns-'));
  cache = new GraphCache(root);
  repoId = 'host-repo';
  headSha = 'b'.repeat(40);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('cache.* namespace', () => {
  it('stores under the host repo id and ignores one supplied in the payload', async () => {
    await handler().handle('cache.put', { repoId: 'attacker-repo', snapshot: input });

    expect(await readdir(root)).toEqual(['host-repo.json']);
  });

  it('stamps head sha and savedAt from the host, not the payload', async () => {
    await handler().handle('cache.put', {
      snapshot: { ...input, headSha: 'f'.repeat(40), savedAt: '1999-01-01T00:00:00.000Z' },
    });

    expect(await cache.read('host-repo')).toMatchObject({
      headSha: 'b'.repeat(40),
      savedAt: '2026-08-24T10:00:00.000Z',
      totalRows: 7,
    });
  });

  it('reads back the snapshot for the active repository', async () => {
    await handler().handle('cache.put', { snapshot: input });

    expect(await handler().handle('cache.get', {})).toMatchObject({ totalRows: 7 });
  });

  it('returns null when nothing has been cached yet', async () => {
    expect(await handler().handle('cache.get', {})).toBeNull();
  });

  it('returns null rather than throwing when no repository is active', async () => {
    repoId = undefined;

    expect(await handler().handle('cache.get', {})).toBeNull();
  });

  it('drops a put when no repository is active', async () => {
    repoId = undefined;

    await handler().handle('cache.put', { snapshot: input });

    expect(await readdir(root)).toEqual([]);
  });

  it('does not let a failing head-sha lookup break the refresh that triggered it', async () => {
    const failing = createCacheHandler({
      cache,
      getRepoId: () => repoId,
      getHeadSha: async () => { throw new Error('git is gone'); },
      now: () => '2026-08-24T10:00:00.000Z',
    });

    await expect(failing.handle('cache.put', { snapshot: input })).resolves.toEqual({ success: false });
    expect(await readdir(root)).toEqual([]);
  });

  it('does not let a failing write break the refresh that triggered it', async () => {
    const broken = createCacheHandler({
      cache: { read: async () => null, write: async () => { throw new Error('ENOSPC'); }, prune: async () => {} },
      getRepoId: () => repoId,
      getHeadSha: async () => headSha,
      now: () => '2026-08-24T10:00:00.000Z',
    });

    await expect(broken.handle('cache.put', { snapshot: input })).resolves.toEqual({ success: false });
  });

  it('prunes after a successful write', async () => {
    const prune = vi.fn(async () => {});
    const counted = createCacheHandler({
      cache: { read: async () => null, write: async () => {}, prune },
      getRepoId: () => repoId,
      getHeadSha: async () => headSha,
      now: () => '2026-08-24T10:00:00.000Z',
    });

    await counted.handle('cache.put', { snapshot: input });

    expect(prune).toHaveBeenCalled();
  });

  it('survives a repository that has been deleted underneath it', async () => {
    // active-repo's getRepoId() calls realpathSync and throws for a repo that
    // is gone — deliberately, since that is not the same as "no repo".
    const gone = createCacheHandler({
      cache,
      getRepoId: () => { throw new Error('ENOENT'); },
      getHeadSha: async () => headSha,
      now: () => '2026-08-24T10:00:00.000Z',
    });

    await expect(gone.handle('cache.get', {})).resolves.toBeNull();
    await expect(gone.handle('cache.put', { snapshot: input })).resolves.toEqual({ success: false });
  });

  it('rejects an unknown method', async () => {
    await expect(handler().handle('cache.nuke', {})).rejects.toThrow('Unknown method');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/graph-cache-namespace.test.ts`
Expected: FAIL — `Failed to resolve import ".../cache-method-handler"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/controllers/cache-method-handler.ts
import type { GraphCache, GraphSnapshot } from '../services/graph-cache';

/** What the webview sends: everything except the fields the host stamps. */
export type GraphSnapshotInput = Omit<GraphSnapshot, 'headSha' | 'savedAt'>;

type GraphCacheLike = Pick<GraphCache, 'read' | 'write' | 'prune'>;

export interface CacheHandlerDeps {
  cache: GraphCacheLike;
  /** The host's own view of the active repository. Never the payload's. */
  getRepoId: () => string | undefined;
  getHeadSha: () => Promise<string>;
  now: () => string;
}

export function createCacheHandler(deps: CacheHandlerDeps) {
  async function put(params: Record<string, unknown>): Promise<unknown> {
    const snapshot = params.snapshot as GraphSnapshotInput | undefined;
    if (!snapshot) return { success: false };

    try {
      // getRepoId() calls realpathSync and throws when the repository has been
      // deleted or unmounted, so it belongs inside the guard like everything
      // else here.
      const repoId = deps.getRepoId();
      if (!repoId) return { success: false };

      // headSha and savedAt are overwritten last so a payload carrying them
      // cannot decide what this snapshot claims to be.
      await deps.cache.write(repoId, {
        ...snapshot,
        headSha: await deps.getHeadSha(),
        savedAt: deps.now(),
      });
      await deps.cache.prune();
      return { success: true };
    } catch {
      // Caching is an optimisation. A full disk must not fail the refresh
      // that produced this snapshot.
      return { success: false };
    }
  }

  async function handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'cache.get': {
        try {
          const repoId = deps.getRepoId();
          return repoId ? await deps.cache.read(repoId) : null;
        } catch {
          return null;
        }
      }
      case 'cache.put':
        return put(p);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  return { handle };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/graph-cache-namespace.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/controllers/cache-method-handler.ts tests/extension/graph-cache-namespace.test.ts
git commit -m "feat: add the cache.* namespace with host-stamped repo identity"
```

---

### Task 3: Wire the namespace up and write a snapshot after each refresh

**Files:**
- Modify: `src/extension/extension.ts` (near the `createActiveRepo` call at line 84, and the `router.register` block at lines 253-259)
- Modify: `src/webview/App.svelte` (`refreshGraph`, lines 426-483)
- Test: `tests/webview/app-graph-cache.test.ts`

**Interfaces:**
- Consumes: `createCacheHandler`, `GraphSnapshotInput` (Task 2); `GraphCache` (Task 1).
- Produces: a `cache` namespace on the graph session's router, and a `cache.put` call at the end of a successful `refreshGraph`.

This is the end of Phase 1. Nothing changes on screen — the snapshot is written and never read.

- [ ] **Step 1: Write the failing test**

Note the shape of `renderApp`: it mirrors `tests/webview/app-favourites.test.ts`, which is the working example of mounting `App.svelte` against a mocked bridge.

```ts
// tests/webview/app-graph-cache.test.ts
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

const branch = {
  name: 'main', current: true, hash: 'a'.repeat(40),
  remote: null, upstream: null, ahead: 0, behind: 0,
};

const node = {
  hash: 'a'.repeat(40), parents: [], subject: 'first', author: 'ann',
  authorEmail: 'ann@example.com', date: '2026-08-24T09:00:00Z',
  refs: [], row: 0, lane: 0, color: 0,
};

function defaultResponses(): Record<string, unknown> {
  return {
    'ping.hello': { ok: true },
    'repo.list': { repos: [{ name: 'repo', path: '/repo', active: true }], submodules: [] },
    'git.branches': [branch],
    'git.tags': [], 'git.stashList': [], 'git.worktreeList': [], 'git.submoduleList': [],
    'git.status': { staged: [], unstaged: [], untracked: [], conflicted: [] },
    'graph.build': { totalRows: 1, maxLane: 0, layoutVersion: 1 },
    'graph.getWindow': { nodes: [node], edges: [], startRow: 0, endRow: 1, totalRows: 1, maxLane: 0 },
    'cache.get': null,
    'cache.put': { success: true },
    'ui.getState': null,
    'ui.setState': { success: true },
  };
}

async function renderApp(overrides: Record<string, unknown> = {}) {
  const responses = { ...defaultResponses(), ...overrides };
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    const response = responses[method];
    if (typeof response === 'function') return (response as () => unknown)();
    return response ?? null;
  });

  vi.resetModules();
  const { default: App } = await import('../../src/webview/App.svelte');
  return render(App);
}

function putCalls() {
  return send.mock.calls.filter(([method]) => method === 'cache.put');
}

describe('App graph cache — writing', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

  it('stores the painted screen after a successful refresh', async () => {
    await renderApp();

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][1]).toMatchObject({
      snapshot: {
        totalRows: 1,
        maxLane: 0,
        branches: [branch],
        hasWorkingChanges: false,
        window: { nodes: [node], startRow: 0 },
      },
    });
  });

  it('does not send a repo id the host would have to trust', async () => {
    await renderApp();

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][1]).not.toHaveProperty('repoId');
  });

  it('stores nothing when the refresh fails', async () => {
    await renderApp({ 'graph.build': () => { throw new Error('git exploded'); } });

    // Give the failed refresh time to finish unwinding before asserting absence.
    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', expect.anything()));
    await Promise.resolve();
    expect(putCalls()).toHaveLength(0);
  });

  it('survives a cache write that fails', async () => {
    const { container } = await renderApp({ 'cache.put': () => { throw new Error('ENOSPC'); } });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-graph-cache.test.ts`
Expected: FAIL — `expected [] to have a length of 1`; nothing sends `cache.put` yet.

- [ ] **Step 3: Register the namespace in `extension.ts`**

Add the import alongside the other controller imports:

```ts
import { createCacheHandler } from './controllers/cache-method-handler';
import { GraphCache } from './services/graph-cache';
```

Construct the cache next to the other services, after `const getRepoId = () => activeRepo.getRepoId();` (line 89):

```ts
  // One cache for the whole extension, rooted in global storage so it survives
  // window reloads. `joinPath` keeps this correct on remote/virtual filesystems.
  const graphCache = new GraphCache(
    vscode.Uri.joinPath(context.globalStorageUri, 'graph-cache').fsPath,
  );
```

Register it inside the same block as `graph` (after line 259) — this is `createSession`'s router, the graph webview's. The review session at line 427 registers its own `review`/`ai`/`git`/`ui` and deliberately does not get `cache`.

```ts
    const cacheHandler = createCacheHandler({
      cache: graphCache,
      getRepoId,
      getHeadSha: () => activeRepo.getGitService().getHeadHash(),
      now: () => new Date().toISOString(),
    });
    router.register('cache', (method: string, params: unknown) => cacheHandler.handle(method, params));
```

`ActiveRepo.getGitService()` returns `Git | undefined` (`src/extension/services/active-repo.ts:22`), so `getHeadSha` must handle the empty case rather than assert one:

```ts
      getHeadSha: async () => {
        const git = activeRepo.getGitService();
        if (!git) throw new Error('No repository');
        return git.getHeadHash();
      },
```

The handler turns that rejection into `{ success: false }`. Do not cast the `undefined` away.

- [ ] **Step 4: Send the snapshot from `App.svelte`**

At the end of the `try` block in `refreshGraph`, after `status = ...` (line 479-481) and before the `catch`:

```ts
      // Fire-and-forget: caching must never delay or fail the refresh that
      // produced it. The host stamps repoId, headSha and savedAt.
      void bridge.send('cache.put', {
        snapshot: {
          totalRows: build.totalRows,
          maxLane: build.maxLane,
          window: nextWindow,
          branches: nextBranches,
          tags: nextTags,
          stashes: nextStashes,
          worktrees: nextWorktrees,
          hasWorkingChanges: workingTreeStatus !== null
            && hasWorkingTreeChanges(workingTreeStatus),
        },
      }).catch(() => undefined);
```

It sits inside the `try` after the `graphRefreshGate.isLatest` guards, so a superseded refresh returns before reaching it and a failed one throws past it.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/webview/app-graph-cache.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: typecheck, lint and the full suite green. Report the totals.

- [ ] **Step 7: Commit**

```bash
git add src/extension/extension.ts src/webview/App.svelte tests/webview/app-graph-cache.test.ts
git commit -m "feat: persist the painted screen after every successful graph refresh"
```

---

## Phase 2 — Paint from the cache

Tasks 4-5. This is the phase the user sees.

### Task 4: Paint the cached screen on mount

**Files:**
- Modify: `src/webview/App.svelte` (`onMount` at line 274, and a new `paintFromCache`)
- Test: `tests/webview/app-graph-cache.test.ts` (extend)

**Interfaces:**
- Consumes: the `cache.get` RPC (Task 2), which resolves to `GraphSnapshot | null`.
- Produces: `paintFromCache()`, plus the module-level `paintedFromCache`, `cachedHeadSha`, `cachedTotalRows` that Task 5 reads.

The central test is the one that proves the point of the whole feature: with `graph.build` hanging forever, rows must still appear.

- [ ] **Step 1: Write the failing test**

Append to `tests/webview/app-graph-cache.test.ts`, reusing the `renderApp` helper from Task 3:

```ts
const snapshot = {
  headSha: 'a'.repeat(40),
  totalRows: 1,
  maxLane: 0,
  window: { nodes: [node], edges: [], startRow: 0, endRow: 1, totalRows: 1, maxLane: 0 },
  branches: [branch], tags: [], stashes: [], worktrees: [],
  hasWorkingChanges: false,
  savedAt: '2026-08-24T09:00:00.000Z',
};

describe('App graph cache — painting', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

  it('paints the cached screen while the real build is still running', async () => {
    const { container } = await renderApp({
      'cache.get': snapshot,
      // Never resolves: without the cache there would be nothing on screen.
      'graph.build': () => new Promise(() => {}),
    });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
    expect(container.querySelector('.col-message')?.textContent).toContain('first');
  });

  it('gives the scrollbar the cached height before the build returns', async () => {
    const { container } = await renderApp({
      'cache.get': { ...snapshot, totalRows: 500 },
      'graph.build': () => new Promise(() => {}),
    });

    await waitFor(() => {
      const height = (container.querySelector('.scroll-content') as HTMLElement)?.style.height;
      expect(height).toBe(`${500 * 32}px`);  // ROW_HEIGHT
    });
  });

  it('asks for the cache before it asks for the graph', async () => {
    await renderApp({ 'cache.get': snapshot });

    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.build', expect.anything()));
    const methods = send.mock.calls.map(([method]) => method);
    expect(methods.indexOf('cache.get')).toBeLessThan(methods.indexOf('graph.build'));
  });

  it('takes the current path when there is no cache', async () => {
    const { container } = await renderApp({ 'cache.get': null });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
  });

  it('does not let a late cache read overwrite a finished refresh', async () => {
    let releaseCache: (value: unknown) => void = () => {};
    const { container } = await renderApp({
      'cache.get': () => new Promise((resolve) => { releaseCache = resolve; }),
      'graph.getWindow': {
        nodes: [{ ...node, subject: 'fresh' }], edges: [], startRow: 0, endRow: 1, totalRows: 1, maxLane: 0,
      },
    });

    await waitFor(() => expect(container.querySelector('.col-message')?.textContent).toContain('fresh'));
    releaseCache({ ...snapshot, window: { ...snapshot.window, nodes: [{ ...node, subject: 'stale' }] } });

    await waitFor(() => expect(container.querySelector('.col-message')?.textContent).toContain('fresh'));
  });

  it('keeps working when the cache read rejects', async () => {
    const { container } = await renderApp({ 'cache.get': () => { throw new Error('unreadable'); } });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
  });
});
```

`ROW_HEIGHT` is 32 (`src/webview/lib/virtual-scroll.ts:1`) and `getTotalHeight` is `totalRows * ROW_HEIGHT`. If the assertion fails, check the real value rather than pasting in whatever the code produced.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-graph-cache.test.ts`
Expected: FAIL — the first test times out waiting for `.commit-row`, because nothing paints until `graph.build` resolves.

- [ ] **Step 3: Write minimal implementation**

Add the state next to `layoutVersion` (around line 156):

```ts
  // True while the screen shows a snapshot and the host has no layout yet.
  let paintedFromCache = false;
  let cachedHeadSha = '';
  let cachedTotalRows = 0;
```

Add `paintFromCache` next to `refreshGraph`:

```ts
  /**
   * Paint the last screen this repository showed, without waiting for git.
   * `layoutVersion !== null` means a real refresh already landed, so a cache
   * read that resolves late must drop its result rather than paint over it.
   */
  async function paintFromCache(): Promise<void> {
    const snapshot = await (bridge.send('cache.get') as Promise<GraphSnapshot | null>)
      .catch(() => null);
    if (!snapshot || layoutVersion !== null) return;

    branches = snapshot.branches;
    tags = snapshot.tags;
    stashes = snapshot.stashes;
    worktrees = snapshot.worktrees;
    hasWorkingChanges = snapshot.hasWorkingChanges;
    totalRows = snapshot.totalRows;
    maxLane = snapshot.maxLane;
    graphWindow = snapshot.window;
    currentStartRow = snapshot.window.startRow;
    cachedHeadSha = snapshot.headSha;
    cachedTotalRows = snapshot.totalRows;
    paintedFromCache = true;
    loading = false;
  }
```

Declare the snapshot type beside the existing `GraphWindow` interface (line 60), mirroring the host's:

```ts
  interface GraphSnapshot {
    headSha: string;
    totalRows: number;
    maxLane: number;
    window: GraphWindow;
    branches: Branch[];
    tags: typeof tags;
    stashes: typeof stashes;
    worktrees: typeof worktrees;
    hasWorkingChanges: boolean;
    savedAt: string;
  }
```

Start it as the first statement of `onMount` (line 274), unawaited:

```ts
  onMount(async () => {
    // Deliberately not awaited: the point is to paint before `ping.hello`,
    // `repo.list` and `graph.build` have finished. `cache.get` does not need
    // the repo list — the host knows its own active repository.
    void paintFromCache();
    try {
      await bridge.send('ping.hello');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/app-graph-cache.test.ts`
Expected: PASS, 10 tests (4 from Task 3, 6 new).

**On switching repositories:** painting from the cache stays a mount-only path. A switch happens with a graph already on screen, so there is nothing to fill in, and the existing refresh covers it; `cache.put` lands under the new repository because the host stamps the id from its own session, not from the payload. If a repository switch ever needs the cached-paint treatment too, that is a follow-up, not part of this plan.

- [ ] **Step 5: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-graph-cache.test.ts
git commit -m "feat: paint the cached graph on mount instead of waiting for git"
```

---

### Task 5: Swap silently when nothing changed

**Files:**
- Modify: `src/webview/App.svelte` (`refreshGraph`, and the toolbar/status markup)
- Test: `tests/webview/app-graph-cache.test.ts` (extend)

**Interfaces:**
- Consumes: `paintedFromCache`, `cachedHeadSha`, `cachedTotalRows` (Task 4).
- Produces: the `graphUpdated` flag and its `.graph-updated` badge.

The swap always happens — the webview needs a live `layoutVersion` to scroll against. The comparison only decides whether the user is told. Comparing head sha plus `totalRows` is one-sidedly imprecise (a branch added elsewhere changes neither), and that is accepted: being wrong here suppresses one line of notice, it never shows wrong pixels.

- [ ] **Step 1: Write the failing test**

```ts
describe('App graph cache — swapping', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.useRealTimers(); });

  it('says nothing when the refresh matches what was cached', async () => {
    const { container } = await renderApp({ 'cache.get': snapshot });

    await waitFor(() => expect(send).toHaveBeenCalledWith('cache.put', expect.anything()));
    expect(container.querySelector('.graph-updated')).toBeNull();
  });

  it('announces the swap when HEAD moved while the panel was closed', async () => {
    const moved = { ...branch, hash: 'c'.repeat(40) };
    const { container } = await renderApp({ 'cache.get': snapshot, 'git.branches': [moved] });

    await waitFor(() => expect(container.querySelector('.graph-updated')).toBeTruthy());
  });

  it('announces the swap when the commit count changed', async () => {
    const { container } = await renderApp({
      'cache.get': snapshot,
      'graph.build': { totalRows: 9, maxLane: 0, layoutVersion: 1 },
    });

    await waitFor(() => expect(container.querySelector('.graph-updated')).toBeTruthy());
  });

  it('says nothing on a plain first load with no cache', async () => {
    const { container } = await renderApp({ 'cache.get': null });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
    expect(container.querySelector('.graph-updated')).toBeNull();
  });

  it('takes the notice back down on its own', async () => {
    vi.useFakeTimers();
    const moved = { ...branch, hash: 'c'.repeat(40) };
    const { container } = await renderApp({ 'cache.get': snapshot, 'git.branches': [moved] });

    await vi.waitFor(() => expect(container.querySelector('.graph-updated')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(4000);

    expect(container.querySelector('.graph-updated')).toBeNull();
  });

  it('picks up a live layout version so scrolling works after a cache paint', async () => {
    const { container } = await renderApp({
      'cache.get': { ...snapshot, totalRows: 500 },
      'graph.build': { totalRows: 500, maxLane: 0, layoutVersion: 1 },
    });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
    await waitFor(() => expect(send).toHaveBeenCalledWith('cache.put', expect.anything()));
    send.mockClear();
    const scroller = container.querySelector('.scroll-area') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    scroller.scrollTop = 320 * 10;  // 100 rows down at ROW_HEIGHT 32
    await fireEvent.scroll(scroller);

    await waitFor(() => expect(send).toHaveBeenCalledWith('graph.getWindow', expect.objectContaining({
      layoutVersion: 1,
    })));
  });
});
```

Add `fireEvent` to the `@testing-library/svelte` import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-graph-cache.test.ts -t swapping`
Expected: FAIL — no `.graph-updated` element exists.

- [ ] **Step 3: Write minimal implementation**

State, next to `paintedFromCache`:

```ts
  let graphUpdated = false;
  let graphUpdatedTimer: ReturnType<typeof setTimeout> | undefined;
```

In `refreshGraph`, right after `status = ...` and before the `cache.put` from Task 3:

```ts
      // The swap itself is unconditional — the webview needs a live
      // layoutVersion to scroll against. This only decides whether to say so.
      if (paintedFromCache) {
        const freshHeadSha = nextBranches.find(candidate => candidate.current)?.hash ?? '';
        if (freshHeadSha !== cachedHeadSha || build.totalRows !== cachedTotalRows) {
          announceGraphUpdate();
        }
        paintedFromCache = false;
      }
```

The helper, and its cleanup:

```ts
  function announceGraphUpdate(): void {
    graphUpdated = true;
    clearTimeout(graphUpdatedTimer);
    graphUpdatedTimer = setTimeout(() => { graphUpdated = false; }, 3000);
  }
```

Add `clearTimeout(graphUpdatedTimer);` to the existing `onDestroy` handler.

Markup, beside the existing status text in the toolbar:

```svelte
{#if graphUpdated}
  <span class="graph-updated">Updated</span>
{/if}
```

```css
  .graph-updated {
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/app-graph-cache.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: green. Report the totals.

- [ ] **Step 6: Commit**

```bash
git add src/webview/App.svelte tests/webview/app-graph-cache.test.ts
git commit -m "feat: swap the cached graph silently unless the refs actually moved"
```

---

## Phase 3 — Skeleton rows for the gap

Task 6. Between the cache paint and the first real build the host holds no layout, so `graph.getWindow` cannot be called at all — `updateGraphWindow` already returns early when `layoutVersion` is `null` (`App.svelte:490-494`). Scrolling into that gap currently shows blank space; it should show placeholder rows.

### Task 6: Placeholder rows outside the cached window

**Files:**
- Create: `src/webview/lib/skeleton-rows.ts`
- Modify: `src/webview/App.svelte` (derived state near line 260, row markup near line 1541)
- Test: `tests/webview/skeleton-rows.test.ts`, `tests/webview/app-graph-cache.test.ts` (extend)

**Interfaces:**
- Consumes: `calculateVisibleRange` and `ROW_HEIGHT` from `src/webview/lib/virtual-scroll.ts`; `paintFromCache` state (Task 4).
- Produces: `skeletonRowsFor(window, range): number[]`.

The calculation lives in its own module so it can be tested as arithmetic rather than through a rendered component.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webview/skeleton-rows.test.ts
import { describe, expect, it } from 'vitest';
import { skeletonRowsFor } from '../../src/webview/lib/skeleton-rows';

const windowWith = (rows: number[]) => ({ nodes: rows.map((row) => ({ row })) });

describe('skeletonRowsFor', () => {
  it('returns nothing when the window covers the whole range', () => {
    expect(skeletonRowsFor(windowWith([0, 1, 2]), { startRow: 0, endRow: 3 })).toEqual([]);
  });

  it('returns the rows past the end of the window', () => {
    expect(skeletonRowsFor(windowWith([0, 1]), { startRow: 0, endRow: 4 })).toEqual([2, 3]);
  });

  it('returns the rows before the start of the window', () => {
    expect(skeletonRowsFor(windowWith([4, 5]), { startRow: 2, endRow: 6 })).toEqual([2, 3]);
  });

  it('handles a hole in the middle', () => {
    expect(skeletonRowsFor(windowWith([0, 3]), { startRow: 0, endRow: 4 })).toEqual([1, 2]);
  });

  it('treats a missing window as entirely uncovered', () => {
    expect(skeletonRowsFor(null, { startRow: 0, endRow: 2 })).toEqual([0, 1]);
  });

  it('returns nothing for an empty range', () => {
    expect(skeletonRowsFor(windowWith([]), { startRow: 5, endRow: 5 })).toEqual([]);
  });
});
```

And in `tests/webview/app-graph-cache.test.ts`:

```ts
describe('App graph cache — the scroll gap', () => {
  afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

  it('shows placeholder rows when scrolled past the cached window', async () => {
    const { container } = await renderApp({
      'cache.get': { ...snapshot, totalRows: 500 },
      'graph.build': () => new Promise(() => {}),
    });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
    const scroller = container.querySelector('.scroll-area') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    scroller.scrollTop = 320 * 10;
    await fireEvent.scroll(scroller);

    await waitFor(() => expect(container.querySelector('.commit-row.is-skeleton')).toBeTruthy());
  });

  it('does not ask the host for a window it cannot serve', async () => {
    const { container } = await renderApp({
      'cache.get': { ...snapshot, totalRows: 500 },
      'graph.build': () => new Promise(() => {}),
    });

    await waitFor(() => expect(container.querySelector('.commit-row')).toBeTruthy());
    send.mockClear();
    const scroller = container.querySelector('.scroll-area') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    scroller.scrollTop = 320 * 10;
    await fireEvent.scroll(scroller);

    await waitFor(() => expect(container.querySelector('.commit-row.is-skeleton')).toBeTruthy());
    expect(send.mock.calls.map(([method]) => method)).not.toContain('graph.getWindow');
  });

  it('drops the placeholders once the build lands', async () => {
    const { container } = await renderApp({ 'cache.get': { ...snapshot, totalRows: 500 } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('cache.put', expect.anything()));
    expect(container.querySelector('.commit-row.is-skeleton')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/skeleton-rows.test.ts`
Expected: FAIL — `Failed to resolve import ".../skeleton-rows"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/webview/lib/skeleton-rows.ts
export interface RowRange {
  startRow: number;
  endRow: number;
}

/**
 * The visible rows the current window has no node for. Nodes carry their
 * absolute row, so a window covering rows 0-59 leaves 60-79 with nothing to
 * draw while the host has no layout to fetch them from.
 */
export function skeletonRowsFor(
  window: { nodes: { row: number }[] } | null,
  range: RowRange,
): number[] {
  const covered = new Set((window?.nodes ?? []).map((node) => node.row));
  const rows: number[] = [];
  for (let row = range.startRow; row < range.endRow; row += 1) {
    if (!covered.has(row)) rows.push(row);
  }
  return rows;
}
```

In `App.svelte`, import it beside the other lib imports and add the derived state next to `graphColWidth` (line 260):

```ts
  // Only while the host has no layout: after a real build, a gap means the
  // window request is in flight and the existing loading path covers it.
  $: skeletonRows = layoutVersion === null
    ? skeletonRowsFor(graphWindow, calculateVisibleRange({ scrollTop, viewportHeight, totalRows }))
    : [];
```

Add the markup directly after the `{#each graphWindow.nodes as node (node.hash)}` block closes:

```svelte
{#each skeletonRows as row (row)}
  <div
    class="commit-row is-skeleton"
    style="top: {row * ROW_HEIGHT + (hasWorkingChanges ? ROW_HEIGHT : 0)}px; --graph-col-width: {graphColWidth}px"
    aria-hidden="true"
  >
    <div class="col-graph"></div>
    <div class="col-message"><span class="skeleton-bar" style="width: 45%"></span></div>
    <div class="col-date"><span class="skeleton-bar"></span></div>
    <div class="col-sha"><span class="skeleton-bar"></span></div>
    <div class="col-author"><span class="skeleton-bar"></span></div>
  </div>
{/each}
```

```css
  .commit-row.is-skeleton { cursor: default; pointer-events: none; }

  .skeleton-bar {
    display: block;
    height: 8px;
    border-radius: 4px;
    background: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.25));
    opacity: 0.5;
  }
```

No pulse animation: these rows are on screen for a few hundred milliseconds, and a moving placeholder next to real rows reads as a glitch rather than as progress.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/skeleton-rows.test.ts tests/webview/app-graph-cache.test.ts`
Expected: PASS, 6 + 19 tests.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: green. Report the totals.

- [ ] **Step 6: Commit**

```bash
git add src/webview/lib/skeleton-rows.ts src/webview/App.svelte tests/webview/skeleton-rows.test.ts tests/webview/app-graph-cache.test.ts
git commit -m "feat: show placeholder rows while the host has no layout to serve"
```

---

## Phase 4 (optional) — ai.providers off the critical path

Task 7. Independent of Phases 1-3; drop it if measurement says the four `which` spawns do not matter.

### Task 7: Fill the provider list in when it arrives

**Files:**
- Modify: `src/webview/ReviewApp.svelte` (`init`, lines 73-98)
- Test: `tests/webview/review-app.test.ts` (extend)

**Interfaces:**
- Consumes: the existing `ai.providers` RPC (`extension.ts:436` → `aiReview.detectProviders()`).
- Produces: `loadProviders()` and the module-level `savedProviderId`.

`detectProviders()` spawns `which` for claude, codex, kiro-cli and openai. Nothing visible waits on the answer, yet it sits in the same `Promise.all` as the branch list, so the whole review panel waits for four process spawns.

- [ ] **Step 1: Write the failing test**

```ts
  it('renders the diff before the provider probe finishes', async () => {
    // detectProviders spawns `which` four times; nothing visible depends on it.
    stub({ 'ai.providers': new Promise(() => {}) });
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
  });

  it('selects the first available provider once the probe returns', async () => {
    let release: (value: unknown) => void = () => {};
    stub({ 'ai.providers': new Promise((resolve) => { release = resolve; }) });
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    release([{ id: 'codex', name: 'Codex', available: true, group: 'cli' }]);

    await waitFor(() => {
      const picker = rendered.getByLabelText('Provider') as HTMLSelectElement;
      expect(picker.value).toBe('codex');
    });
  });
```

`stub()` returns any value in `overrides` directly from the mocked `send`, so a never-settling promise there is exactly what a slow probe looks like. Check the real accessible name of the provider `<select>` in `ReviewApp.svelte` before running — `getByLabelText('Provider')` must match the markup, and the other tests in this file use `getByLabelText('Base branch')` as the working example.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/review-app.test.ts -t "before the provider probe"`
Expected: FAIL — the test times out; `init`'s `Promise.all` never settles, so nothing renders.

- [ ] **Step 3: Write minimal implementation**

Add module state beside `providers`:

```ts
  let savedProviderId: string | null = null;
```

In `init`, drop `ai.providers` from the `Promise.all` (leaving five entries), and after `modelInput = savedModel ?? '';`:

```ts
      savedProviderId = savedProvider;
      // Provider detection spawns `which` per provider and nothing visible
      // waits on it, so it must not hold up the diff.
      void loadProviders();
```

```ts
  async function loadProviders(): Promise<void> {
    const detected = await (bridge.send('ai.providers') as Promise<Provider[]>)
      .catch(() => [] as Provider[]);
    providers = detected ?? [];
    const available = providers.filter(candidate => candidate.available);
    selectedProvider = savedProviderId && available.some(candidate => candidate.id === savedProviderId)
      ? savedProviderId
      : (available[0]?.id ?? '');
  }
```

Delete the three lines in `init` that previously derived `selectedProvider` — that logic now lives in `loadProviders` only. Leaving both is the duplicate-source-of-truth bug this task exists to avoid.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/review-app.test.ts`
Expected: PASS, all existing tests plus the 2 new ones.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: green. Report the totals.

- [ ] **Step 6: Commit**

```bash
git add src/webview/ReviewApp.svelte tests/webview/review-app.test.ts
git commit -m "perf: stop the provider probe blocking the review panel's first paint"
```

---

## Manual verification (F5)

The repo mocks the whole `vscode` module and has no `@vscode/test-electron`, so "it opens fast" cannot be asserted automatically. Run this by hand after Phase 2 and again after Phase 3.

1. First open on a large repo: a loading state, then the graph. Confirm `<globalStorage>/graph-cache/<id>.json` now exists.
2. Close the window, reopen: the graph appears **immediately**, no loading state.
3. Commit from a terminal, reopen: the cached screen paints first, then swaps and shows `Updated`.
4. Change nothing, reopen: no flicker, no row jump, no `Updated` badge.
5. Scroll hard immediately on open: placeholder rows, then real ones. No errors in the webview console.
6. Delete the `graph-cache` directory while the panel is open, then reopen: it still works, just as slow as before.
7. Switch repositories twice and reopen: each repository paints its own graph, never the other's.

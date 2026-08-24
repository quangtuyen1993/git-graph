# Review Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move AI review out of the graph webview's right panel into an extension-host-owned job system with a native TreeView in its own bottom Panel tab, so a review can never be lost, never run unseen, and never be paid for twice.

**Architecture:** Three new host services — `ReviewStore` (durable JSON index plus markdown bodies under `globalStorageUri`, keyed by source/target sha plus provider/model), `ReviewRunner` (owns every child process, streams output, cancels on demand), and `ReviewTreeProvider` (a native `TreeDataProvider`, not a second webview). The webview stops holding review results; it starts jobs and reads them back through a new `review.*` message namespace. Review bodies open as real `file://` markdown editor tabs, which VS Code restores for free.

**Tech Stack:** TypeScript, VS Code Extension API (`TreeDataProvider`, `viewsContainers.panel`), Node `child_process` with `AbortSignal`, Svelte 4 webview, Vitest with a per-file `vi.mock('vscode', ...)`, esbuild (host) + Vite (webview).

**Spec:** `docs/superpowers/specs/2026-08-24-review-panel-design.md`

## Global Constraints

- Engine floor is `"vscode": "^1.85.0"` (`package.json`). Do not use API added after that.
- `activationEvents` stays `[]`. VS Code infers `onView:` from the view contribution. Do **not** add `onStartupFinished` — the bottom-panel spec forbids it, and the whole file-vs-virtual-document decision depends on it.
- `source` is the **base**, `target` is the **head**. Diff reads `sourceBranch..targetBranch`. This matches `extension.ts:323-341`, which builds the payload with `baseBranch: sourceBranch, headBranch: targetBranch`. Do not rename these fields to sound more natural — swapping them reverses every review.
- View container id is `gitGraphProReview`, view id is `gitGraphPro.reviews`. Both strings appear in `package.json` and `extension.ts` and must match exactly.
- Review ids become filenames. Every `provider` and `model` segment goes through `slugSegment()` before entering an id. Skipping this lets a model named `anthropic/claude-sonnet-4` write outside its directory.
- Keep at most 50 entries per repo, evicting oldest first, and **never evict an entry whose status is `running`**.
- Tests mock `vscode` per file with `vi.mock('vscode', () => ({ ... }))`. There is no `@vscode/test-electron`; anything requiring a real VS Code window is manual-only.
- Run `npm run check` (test + coverage + typecheck + build) before the commit that closes each phase.

## File Structure

**Create:**
- `src/extension/services/review-key.ts` — pure id/slug/repoId helpers. No I/O, no `vscode` import, so it tests instantly.
- `src/extension/services/review-store.ts` — all filesystem persistence: index, bodies, eviction, orphan reconciliation.
- `src/extension/services/review-runner.ts` — process lifecycle: start, stream, finish, cancel, cancel-all.
- `src/extension/providers/review-tree-provider.ts` — `TreeDataProvider<ReviewEntry>` plus a pure `formatDescription()`.
- `resources/review.svg` — panel container icon (does not exist yet; the container renders blank without it).
- `src/extension/controllers/review-method-handler.ts` — the `review.*` message namespace, kept out of `extension.ts` so it tests without `vscode`.
- `src/extension/providers/review-view-registration.ts` — command/view wiring behind injected callbacks, for the same reason.
- `tests/extension/review-key.test.ts`, `review-store.test.ts`, `review-orphans.test.ts`, `ai-review-stream.test.ts`, `review-runner.test.ts`, `review-namespace.test.ts`, `review-contributions.test.ts`, `review-tree-provider.test.ts`, `review-view-registration.test.ts`, `tests/webview/app-review-jobs.test.ts`.

**Modify:**
- `src/extension/services/ai-review.service.ts` — thread `onChunk` and `signal` down to `spawnWithStdin`; add process-tree kill; export `ReviewCancelledError`.
- `src/extension/extension.ts` — `review.*` namespace, tree view + command registration, `deactivate()` kill-all, hoisted `RepositorySession`.
- `package.json` — second `viewsContainers.panel` entry, `views`, `commands`, `menus`.
- `src/webview/App.svelte` — start jobs and listen for completion instead of holding `aiReviewResult`.
- `src/webview/components/review/AIReviewPanel.svelte` — keep Compare, drop result rendering.
- `tests/extension/repository-session.test.ts` — the session exposes the active repo path to non-webview consumers.

Splitting key/store/runner three ways is deliberate: the key logic is pure and deserves exhaustive cheap tests, the store is all filesystem and tests against a temp dir, and the runner is all process control and tests against a fake spawn. Fusing them would force every test to set up all three.

---

## Phase 4 — Host-owned review jobs

Tasks 1-7. Ships alone and does not depend on the bottom-panel move. This is the phase that kills the data-loss bug.

### Task 1: Review key helpers

**Files:**
- Create: `src/extension/services/review-key.ts`
- Test: `tests/extension/review-key.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `slugSegment(value: string): string`, `buildReviewId(input: { sourceSha: string; targetSha: string; provider: string; model?: string }): string`, `repoIdFor(realRepoPath: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-key.test.ts
import { describe, expect, it } from 'vitest';
import { buildReviewId, repoIdFor, slugSegment } from '../../src/extension/services/review-key';

describe('slugSegment', () => {
  it('keeps word characters, dots and dashes untouched', () => {
    expect(slugSegment('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
  });

  it('replaces path separators so an id cannot escape its directory', () => {
    expect(slugSegment('anthropic/claude-sonnet-4')).toBe('anthropic-claude-sonnet-4');
    expect(slugSegment('../../etc/passwd')).toBe('etc-passwd');
  });

  it('collapses runs of unsafe characters into a single dash', () => {
    expect(slugSegment('gpt  4o::turbo')).toBe('gpt-4o-turbo');
  });
});

describe('buildReviewId', () => {
  const shas = { sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) };

  it('joins abbreviated shas with the provider and model', () => {
    expect(buildReviewId({ ...shas, provider: 'claude', model: 'sonnet' }))
      .toBe('aaaaaaa..bbbbbbb.claude.sonnet');
  });

  it('falls back to "default" when no model was chosen', () => {
    expect(buildReviewId({ ...shas, provider: 'claude' }))
      .toBe('aaaaaaa..bbbbbbb.claude.default');
    expect(buildReviewId({ ...shas, provider: 'claude', model: '' }))
      .toBe('aaaaaaa..bbbbbbb.claude.default');
  });

  it('sanitises the model so the id is always a safe filename', () => {
    expect(buildReviewId({ ...shas, provider: 'openai', model: 'anthropic/claude' }))
      .toBe('aaaaaaa..bbbbbbb.openai.anthropic-claude');
  });

  it('distinguishes two models reviewing the same commits', () => {
    const a = buildReviewId({ ...shas, provider: 'claude', model: 'sonnet' });
    const b = buildReviewId({ ...shas, provider: 'claude', model: 'opus' });
    expect(a).not.toBe(b);
  });
});

describe('repoIdFor', () => {
  it('is stable for the same path', () => {
    expect(repoIdFor('/repo')).toBe(repoIdFor('/repo'));
  });

  it('differs for different paths', () => {
    expect(repoIdFor('/repo')).not.toBe(repoIdFor('/other'));
  });

  it('is a short filesystem-safe token', () => {
    expect(repoIdFor('/repo/with spaces/and#hash')).toMatch(/^[0-9a-f]{12}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-key.test.ts`
Expected: FAIL — `Failed to resolve import ".../review-key"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/review-key.ts
import { createHash } from 'crypto';

/**
 * Reduce one id segment to characters that are safe in a filename. Model names
 * legitimately contain slashes (`anthropic/claude-sonnet-4`), and ids are used
 * directly as filenames, so skipping this writes outside the repo directory.
 */
export function slugSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '');
}

export function buildReviewId(input: {
  sourceSha: string;
  targetSha: string;
  provider: string;
  model?: string;
}): string {
  const source = input.sourceSha.slice(0, 7);
  const target = input.targetSha.slice(0, 7);
  const provider = slugSegment(input.provider);
  const model = slugSegment(input.model || 'default') || 'default';
  return `${source}..${target}.${provider}.${model}`;
}

/** Stable, filesystem-safe token for a repository, derived from its real path. */
export function repoIdFor(realRepoPath: string): string {
  return createHash('sha256').update(realRepoPath).digest('hex').slice(0, 12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-key.test.ts`
Expected: PASS, 9 tests.

Note on `slugSegment('../../etc/passwd')`: the leading-`.` strip in the second `replace` is what removes the `..`, giving `etc-passwd`. If you only strip dashes, the result starts with `..` and still traverses.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/review-key.ts tests/extension/review-key.test.ts
git commit -m "feat: add review id and repo id helpers"
```

---

### Task 2: ReviewStore persistence

**Files:**
- Create: `src/extension/services/review-store.ts`
- Test: `tests/extension/review-store.test.ts`

**Interfaces:**
- Consumes: `buildReviewId`, `repoIdFor` from Task 1 (not called here, but the id format is assumed).
- Produces: `ReviewStatus`, `ReviewEntry`, `MAX_ENTRIES_PER_REPO`, and `class ReviewStore` with `list`, `get`, `create`, `appendBody`, `finish`, `remove`, `bodyPath`, `readBody`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-store.test.ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, type ReviewEntry } from '../../src/extension/services/review-store';

const REPO = 'abc123abc123';
let root: string;
let store: ReviewStore;

function entry(id: string, over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    id,
    sourceBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetBranch: 'feat/x',
    targetSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status: 'running',
    startedAt: '2026-08-24T00:00:00.000Z',
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-store-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ReviewStore', () => {
  it('round-trips an entry through the index', async () => {
    await store.create(REPO, entry('one'));

    expect(await store.get(REPO, 'one')).toMatchObject({ id: 'one', status: 'running' });
    expect(await store.list(REPO)).toHaveLength(1);
  });

  it('returns an empty list for a repo it has never seen', async () => {
    expect(await store.list('never-seen')).toEqual([]);
  });

  it('lists newest first', async () => {
    await store.create(REPO, entry('old', { startedAt: '2026-08-24T00:00:00.000Z' }));
    await store.create(REPO, entry('new', { startedAt: '2026-08-24T01:00:00.000Z' }));

    expect((await store.list(REPO)).map(e => e.id)).toEqual(['new', 'old']);
  });

  it('appends streamed chunks to the body file', async () => {
    await store.create(REPO, entry('one'));
    await store.appendBody(REPO, 'one', 'first ');
    await store.appendBody(REPO, 'one', 'second');

    expect(await store.readBody(REPO, 'one')).toBe('first second');
  });

  it('patches status and finishedAt without losing other fields', async () => {
    await store.create(REPO, entry('one'));
    await store.finish(REPO, 'one', { status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' });

    const saved = await store.get(REPO, 'one');
    expect(saved).toMatchObject({ status: 'done', finishedAt: '2026-08-24T00:05:00.000Z' });
    expect(saved?.sourceBranch).toBe('main');
  });

  it('removes the entry and its body', async () => {
    await store.create(REPO, entry('one'));
    await store.appendBody(REPO, 'one', 'body');
    await store.remove(REPO, 'one');

    expect(await store.get(REPO, 'one')).toBeUndefined();
    await expect(readFile(store.bodyPath(REPO, 'one'), 'utf8')).rejects.toThrow();
  });

  it('evicts the oldest once past the cap', async () => {
    for (let i = 0; i < 52; i++) {
      await store.create(REPO, entry(`id-${i}`, {
        status: 'done',
        startedAt: new Date(Date.UTC(2026, 7, 24, 0, i)).toISOString(),
      }));
    }

    const ids = (await store.list(REPO)).map(e => e.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain('id-0');
    expect(ids).not.toContain('id-1');
    expect(ids).toContain('id-51');
  });

  it('never evicts a running entry', async () => {
    await store.create(REPO, entry('pinned', {
      status: 'running',
      startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    }));
    for (let i = 0; i < 55; i++) {
      await store.create(REPO, entry(`id-${i}`, {
        status: 'done',
        startedAt: new Date(Date.UTC(2026, 7, 24, 0, i)).toISOString(),
      }));
    }

    expect((await store.list(REPO)).map(e => e.id)).toContain('pinned');
  });

  it('rebuilds a corrupt index by scanning body files instead of throwing', async () => {
    await store.create(REPO, entry('one'));
    await store.appendBody(REPO, 'one', 'body');
    await writeFile(join(root, REPO, 'index.json'), '{ not json', 'utf8');

    const listed = await store.list(REPO);
    expect(listed.map(e => e.id)).toEqual(['one']);
    expect(listed[0].status).toBe('interrupted');
  });

  it('creates the repo directory on first write', async () => {
    await mkdir(root, { recursive: true });
    await store.create('brand-new-repo', entry('one'));

    expect(await store.get('brand-new-repo', 'one')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-store.test.ts`
Expected: FAIL — cannot resolve `review-store`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/review-store.ts
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

export type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface ReviewEntry {
  id: string;
  /** Base of the comparison. Diff reads sourceBranch..targetBranch. */
  sourceBranch: string;
  sourceSha: string;
  /** Head of the comparison. */
  targetBranch: string;
  targetSha: string;
  provider: string;
  model: string;
  status: ReviewStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export const MAX_ENTRIES_PER_REPO = 50;

export class ReviewStore {
  constructor(private readonly rootDir: string) {}

  public bodyPath(repoId: string, id: string): string {
    return join(this.rootDir, repoId, `${id}.md`);
  }

  public async list(repoId: string): Promise<ReviewEntry[]> {
    const entries = await this.readIndex(repoId);
    return [...entries].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public async get(repoId: string, id: string): Promise<ReviewEntry | undefined> {
    return (await this.readIndex(repoId)).find(e => e.id === id);
  }

  public async create(repoId: string, entry: ReviewEntry): Promise<void> {
    await mkdir(join(this.rootDir, repoId), { recursive: true });
    const entries = (await this.readIndex(repoId)).filter(e => e.id !== entry.id);
    entries.push(entry);
    await this.writeIndex(repoId, await this.evict(repoId, entries));
    await writeFile(this.bodyPath(repoId, entry.id), '', 'utf8');
  }

  public async appendBody(repoId: string, id: string, chunk: string): Promise<void> {
    await mkdir(join(this.rootDir, repoId), { recursive: true });
    await appendFile(this.bodyPath(repoId, id), chunk, 'utf8');
  }

  public async readBody(repoId: string, id: string): Promise<string> {
    return readFile(this.bodyPath(repoId, id), 'utf8').catch(() => '');
  }

  public async finish(repoId: string, id: string, patch: Partial<ReviewEntry>): Promise<void> {
    const entries = await this.readIndex(repoId);
    const index = entries.findIndex(e => e.id === id);
    if (index === -1) return;
    entries[index] = { ...entries[index], ...patch };
    await this.writeIndex(repoId, entries);
  }

  public async remove(repoId: string, id: string): Promise<void> {
    const entries = (await this.readIndex(repoId)).filter(e => e.id !== id);
    await this.writeIndex(repoId, entries);
    await rm(this.bodyPath(repoId, id), { force: true });
  }

  private indexPath(repoId: string): string {
    return join(this.rootDir, repoId, 'index.json');
  }

  private async readIndex(repoId: string): Promise<ReviewEntry[]> {
    const raw = await readFile(this.indexPath(repoId), 'utf8').catch(() => null);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ReviewEntry[];
    } catch {
      // fall through to the rebuild below
    }
    return this.rebuildIndex(repoId);
  }

  /**
   * A corrupt index must never take the view down with it. Body files carry the
   * ids, so the list is recoverable; everything else is unknown, and an entry we
   * cannot vouch for is reported as `interrupted` rather than `done`.
   */
  private async rebuildIndex(repoId: string): Promise<ReviewEntry[]> {
    const files = await readdir(join(this.rootDir, repoId)).catch(() => [] as string[]);
    const recovered: ReviewEntry[] = files
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const id = name.slice(0, -3);
        return {
          id,
          sourceBranch: 'unknown',
          sourceSha: '',
          targetBranch: 'unknown',
          targetSha: '',
          provider: 'unknown',
          model: 'unknown',
          status: 'interrupted' as const,
          startedAt: new Date(0).toISOString(),
        };
      });
    await this.writeIndex(repoId, recovered);
    return recovered;
  }

  private async writeIndex(repoId: string, entries: ReviewEntry[]): Promise<void> {
    await mkdir(join(this.rootDir, repoId), { recursive: true });
    await writeFile(this.indexPath(repoId), JSON.stringify(entries, null, 2), 'utf8');
  }

  /** Drop the oldest finished entries past the cap. A running review is never evicted. */
  private async evict(repoId: string, entries: ReviewEntry[]): Promise<ReviewEntry[]> {
    if (entries.length <= MAX_ENTRIES_PER_REPO) return entries;

    const running = entries.filter(e => e.status === 'running');
    const finished = entries
      .filter(e => e.status !== 'running')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const keepFinished = finished.slice(0, Math.max(0, MAX_ENTRIES_PER_REPO - running.length));
    for (const dropped of finished.slice(keepFinished.length)) {
      await rm(this.bodyPath(repoId, dropped.id), { force: true });
    }
    return [...running, ...keepFinished];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-store.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/review-store.ts tests/extension/review-store.test.ts
git commit -m "feat: persist reviews under globalStorage keyed by sha pair"
```

---

### Task 3: Orphan reconciliation

**Files:**
- Modify: `src/extension/services/review-store.ts`
- Test: `tests/extension/review-orphans.test.ts`

**Interfaces:**
- Consumes: `ReviewStore` from Task 2.
- Produces: `ReviewStore.reconcileOrphans(): Promise<string[]>` returning the ids it rewrote.

Why this exists: no child process survives the extension host, so any entry still marked `running` when we start up is a run that was killed mid-flight. Leaving it `running` makes the row spin forever; calling it `done` is a lie. It becomes `interrupted`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-orphans.test.ts
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, type ReviewEntry } from '../../src/extension/services/review-store';

let root: string;
let store: ReviewStore;

function entry(id: string, status: ReviewEntry['status']): ReviewEntry {
  return {
    id,
    sourceBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetBranch: 'feat/x',
    targetSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status,
    startedAt: '2026-08-24T00:00:00.000Z',
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-orphans-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ReviewStore.reconcileOrphans', () => {
  it('rewrites a stranded running entry as interrupted', async () => {
    await store.create('repo-a', entry('stranded', 'running'));

    expect(await store.reconcileOrphans()).toEqual(['stranded']);
    expect((await store.get('repo-a', 'stranded'))?.status).toBe('interrupted');
  });

  it('leaves finished entries alone', async () => {
    await store.create('repo-a', entry('finished', 'done'));
    await store.create('repo-a', entry('broken', 'failed'));

    expect(await store.reconcileOrphans()).toEqual([]);
    expect((await store.get('repo-a', 'finished'))?.status).toBe('done');
    expect((await store.get('repo-a', 'broken'))?.status).toBe('failed');
  });

  it('sweeps every repo, not just the first', async () => {
    await store.create('repo-a', entry('a', 'running'));
    await store.create('repo-b', entry('b', 'running'));

    expect((await store.reconcileOrphans()).sort()).toEqual(['a', 'b']);
  });

  it('stamps finishedAt so the row can show a relative time', async () => {
    await store.create('repo-a', entry('stranded', 'running'));
    await store.reconcileOrphans();

    expect((await store.get('repo-a', 'stranded'))?.finishedAt).toBeTruthy();
  });

  it('is a no-op when nothing has ever been stored', async () => {
    expect(await store.reconcileOrphans()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-orphans.test.ts`
Expected: FAIL — `store.reconcileOrphans is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `ReviewStore` in `src/extension/services/review-store.ts`:

```ts
  /**
   * Called once at activation. No child process outlives the extension host, so
   * an entry still marked `running` is the debris of a killed run. Reporting it
   * as `interrupted` is the honest state; it must never read as `done`.
   */
  public async reconcileOrphans(): Promise<string[]> {
    const repoIds = await readdir(this.rootDir).catch(() => [] as string[]);
    const rewritten: string[] = [];

    for (const repoId of repoIds) {
      const entries = await this.readIndex(repoId);
      let changed = false;
      for (const entry of entries) {
        if (entry.status !== 'running') continue;
        entry.status = 'interrupted';
        entry.finishedAt = new Date().toISOString();
        rewritten.push(entry.id);
        changed = true;
      }
      if (changed) await this.writeIndex(repoId, entries);
    }

    return rewritten;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-orphans.test.ts tests/extension/review-store.test.ts`
Expected: PASS, 15 tests total. Both files must pass — `reconcileOrphans` shares `readIndex`, so a regression shows up in Task 2's suite.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/review-store.ts tests/extension/review-orphans.test.ts
git commit -m "feat: mark stranded running reviews as interrupted on startup"
```

---

### Task 4: Streaming and cancellation in AIReviewService

**Files:**
- Modify: `src/extension/services/ai-review.service.ts:99` (`review`), `:297` (`spawnWithStdin`), and each `run*` helper
- Test: `tests/extension/ai-review-stream.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReviewRequest` gains `onChunk?: (text: string) => void` and `signal?: AbortSignal`; new exported `class ReviewCancelledError extends Error`; `spawnWithStdin(command, args, stdin, hooks?: { onChunk?: (text: string) => void; signal?: AbortSignal })`.

The runner must be able to tell "the user cancelled" apart from "the CLI failed" — one is `cancelled`, the other is `failed`. A distinct error class carries that without string-matching messages.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/ai-review-stream.test.ts
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }));

vi.mock('child_process', () => ({ spawn: hoisted.spawn }));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => 0 }) },
}));

import { AIReviewService, ReviewCancelledError } from '../../src/extension/services/ai-review.service';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = 4242;
  proc.kill = hoisted.kill;
  return proc;
}

beforeEach(() => {
  hoisted.spawn.mockReset();
  hoisted.kill.mockReset();
});

describe('AIReviewService streaming', () => {
  it('forwards each stdout chunk to onChunk as it arrives', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const chunks: string[] = [];

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p',
      onChunk: (text) => chunks.push(text),
    });

    proc.stdout.emit('data', Buffer.from('first '));
    proc.stdout.emit('data', Buffer.from('second'));
    proc.emit('close', 0);
    await promise;

    expect(chunks).toEqual(['first ', 'second']);
  });

  it('still resolves with the whole content when no onChunk is given', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({ diff: 'd', provider: 'claude', payloadText: 'p' });

    proc.stdout.emit('data', Buffer.from('all of it'));
    proc.emit('close', 0);

    expect((await promise).content).toBe('all of it');
  });

  it('rejects with ReviewCancelledError when the signal aborts', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);
  });

  it('kills the process group, not just the direct child', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const service = new AIReviewService();
    const promise = service.review({
      diff: 'd', provider: 'claude', payloadText: 'p', signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ReviewCancelledError);

    expect(processKill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    processKill.mockRestore();
  });

  it('spawns detached so the whole tree is signallable', async () => {
    const proc = fakeProcess();
    hoisted.spawn.mockReturnValue(proc);

    const service = new AIReviewService();
    const promise = service.review({ diff: 'd', provider: 'claude', payloadText: 'p' });
    proc.emit('close', 0);
    await promise;

    // detached is POSIX-only; on Windows the tree is killed with taskkill instead.
    expect(hoisted.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: process.platform !== 'win32' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/ai-review-stream.test.ts`
Expected: FAIL — `ReviewCancelledError` is not exported, and `onChunk` is never called.

- [ ] **Step 3: Write minimal implementation**

In `src/extension/services/ai-review.service.ts`, add the error class near the top, after the imports:

```ts
/** Thrown when a caller aborts a review. Distinct from a CLI failure. */
export class ReviewCancelledError extends Error {
  constructor() {
    super('Review cancelled');
    this.name = 'ReviewCancelledError';
  }
}
```

Extend `ReviewRequest`:

```ts
export interface ReviewRequest {
  diff: string;
  provider: string;
  model?: string;
  customPrompt?: string;
  /** Pre-assembled payload text. When present, `diff` is ignored. */
  payloadText?: string;
  /** Called with each stdout chunk as it arrives, for live progress. */
  onChunk?: (text: string) => void;
  /** Aborting kills the CLI process group and rejects with ReviewCancelledError. */
  signal?: AbortSignal;
}
```

Thread the hooks through `review()`. Replace the `switch` with one that passes a `hooks` object:

```ts
    const hooks = { onChunk: request.onChunk, signal: request.signal };

    let content: string;
    let model = request.model || '';

    switch (request.provider) {
      case 'claude':
        content = await this.runClaude(fullInput, model, hooks);
        break;
      case 'codex':
        content = await this.runCodex(fullInput, model, hooks);
        break;
      case 'kiro':
        content = await this.runKiro(fullInput, hooks);
        break;
      case 'openai':
        content = await this.runOpenAI(fullInput, model, hooks);
        break;
      case 'deepseek':
        content = await this.runDeepSeek(fullInput, model, hooks);
        break;
      default:
        throw new Error(`Unknown AI provider: ${request.provider}`);
    }
```

Give every `run*` helper a trailing `hooks: SpawnHooks` parameter and pass it as the fourth argument to `spawnWithStdin`. For example:

```ts
  private async runClaude(input: string, model: string, hooks: SpawnHooks): Promise<string> {
    const args = ['--print'];
    if (model && model !== 'default') args.push('--model', model);
    return this.spawnWithStdin('claude', args, input, hooks);
  }
```

Declare the hooks type beside `ReviewRequest`:

```ts
export interface SpawnHooks {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}
```

Rewrite `spawnWithStdin`:

```ts
  private spawnWithStdin(
    command: string,
    args: string[],
    stdin: string,
    hooks: SpawnHooks = {},
  ): Promise<string> {
    const resolvedCommand = this.commandPaths.get(command) || command;
    console.log(`[AIReview] Spawning: ${resolvedCommand} ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      // detached puts the CLI in its own process group so a cancel reaches the
      // grandchildren these tools spawn, not just the process we started.
      const proc = spawn(resolvedCommand, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.getEnv(),
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let cancelled = false;
      const startedAt = Date.now();

      const killTree = () => {
        if (proc.pid === undefined) return;
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
          return;
        }
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          proc.kill('SIGTERM');
        }
        setTimeout(() => {
          try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }, 5000).unref();
      };

      const onAbort = () => {
        cancelled = true;
        killTree();
        reject(new ReviewCancelledError());
      };
      hooks.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => hooks.signal?.removeEventListener('abort', onAbort);

      const idle = this.armInactivityTimeout(proc, (idleMs) => {
        cleanup();
        reject(new Error(
          `${command} produced no output for ${Math.round(idleMs / 1000)}s and was stopped. ` +
          `Raise gitGraphPro.aiReview.timeoutSeconds (0 disables the timeout).`
        ));
      });

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        hooks.onChunk?.(text);
        idle.bump();
      });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); idle.bump(); });

      if (stdin) {
        proc.stdin.write(stdin);
      }
      proc.stdin.end();

      proc.on('close', (code) => {
        idle.clear();
        cleanup();
        if (cancelled) return;
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[AIReview] ${command} exited ${code} after ${elapsed}s (${stdout.length} bytes)`);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
        }
      });

      proc.on('error', (err) => {
        idle.clear();
        cleanup();
        if (cancelled) return;
        reject(new Error(`Failed to run ${command}: ${err.message}`));
      });
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/ai-review-stream.test.ts && npx vitest run tests/extension/`
Expected: PASS. The whole extension suite must stay green — `spawnWithStdin` is shared by every provider.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/ai-review.service.ts tests/extension/ai-review-stream.test.ts
git commit -m "feat: stream review output and cancel the CLI process group"
```

---

### Task 5: ReviewRunner

**Files:**
- Create: `src/extension/services/review-runner.ts`
- Test: `tests/extension/review-runner.test.ts`

**Interfaces:**
- Consumes: `ReviewStore`, `ReviewEntry` (Task 2); `AIReviewService`, `ReviewCancelledError` (Task 4).
- Produces: `StartReviewInput`, `class ReviewRunner` with `start(input): Promise<string>`, `cancel(repoId, id): boolean`, `cancelAll(): void`, `isRunning(id): boolean`.

`start` resolves as soon as the entry exists, **not** when the review finishes. That is the whole point: the caller gets an id immediately and the row appears at once.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-runner.test.ts
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewStore } from '../../src/extension/services/review-store';
import { ReviewRunner, type StartReviewInput } from '../../src/extension/services/review-runner';
import { ReviewCancelledError } from '../../src/extension/services/ai-review.service';

const REPO = 'repo-a';
let root: string;
let store: ReviewStore;

const input: StartReviewInput = {
  repoId: REPO,
  sourceBranch: 'main',
  sourceSha: 'a'.repeat(40),
  targetBranch: 'feat/x',
  targetSha: 'b'.repeat(40),
  provider: 'claude',
  model: 'sonnet',
  payloadText: 'payload',
};

/** A service stand-in whose single review call is resolved by the test. */
function deferredService() {
  let settle!: (value: { content: string }) => void;
  let fail!: (err: Error) => void;
  const captured: { onChunk?: (t: string) => void; signal?: AbortSignal } = {};

  const service = {
    review: vi.fn((req: { onChunk?: (t: string) => void; signal?: AbortSignal }) => {
      captured.onChunk = req.onChunk;
      captured.signal = req.signal;
      return new Promise<{ content: string }>((resolve, reject) => {
        settle = resolve;
        fail = reject;
        req.signal?.addEventListener('abort', () => reject(new ReviewCancelledError()), { once: true });
      });
    }),
  };
  return { service, captured, settle: (c: string) => settle({ content: c }), fail: (e: Error) => fail(e) };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-runner-'));
  store = new ReviewStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ReviewRunner', () => {
  it('returns an id immediately and leaves the entry running', async () => {
    const { service } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});

    const id = await runner.start(input);

    expect(id).toBe('aaaaaaa..bbbbbbb.claude.sonnet');
    expect((await store.get(REPO, id))?.status).toBe('running');
    expect(runner.isRunning(id)).toBe(true);
  });

  it('streams chunks into the body file', async () => {
    const { service, captured, settle } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    captured.onChunk?.('hello ');
    captured.onChunk?.('world');
    settle('hello world');
    await waitFor(() => runner.isRunning(id) === false);

    expect(await store.readBody(REPO, id)).toBe('hello world');
  });

  it('marks the entry done when the CLI exits cleanly', async () => {
    const { service, settle } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    settle('the review');
    await waitFor(() => runner.isRunning(id) === false);

    const entry = await store.get(REPO, id);
    expect(entry?.status).toBe('done');
    expect(entry?.finishedAt).toBeTruthy();
  });

  it('marks the entry failed and records the error in the body', async () => {
    const { service, fail } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    fail(new Error('claude failed (exit 1): boom'));
    await waitFor(() => runner.isRunning(id) === false);

    const entry = await store.get(REPO, id);
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toContain('boom');
    expect(await store.readBody(REPO, id)).toContain('boom');
  });

  it('keeps the partial body when cancelled', async () => {
    const { service, captured } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});
    const id = await runner.start(input);

    captured.onChunk?.('half a review');
    expect(runner.cancel(REPO, id)).toBe(true);
    await waitFor(() => runner.isRunning(id) === false);

    expect((await store.get(REPO, id))?.status).toBe('cancelled');
    expect(await store.readBody(REPO, id)).toBe('half a review');
  });

  it('reports cancel of an unknown id as false', async () => {
    const { service } = deferredService();
    const runner = new ReviewRunner(store, service as never, () => {});

    expect(runner.cancel(REPO, 'nope')).toBe(false);
  });

  it('cancelAll stops every in-flight run', async () => {
    const first = deferredService();
    const runner = new ReviewRunner(store, first.service as never, () => {});
    const idA = await runner.start(input);
    const idB = await runner.start({ ...input, model: 'opus' });

    runner.cancelAll();
    await waitFor(() => !runner.isRunning(idA) && !runner.isRunning(idB));

    expect((await store.get(REPO, idA))?.status).toBe('cancelled');
    expect((await store.get(REPO, idB))?.status).toBe('cancelled');
  });

  it('notifies on every status transition so the tree can refresh', async () => {
    const { service, settle } = deferredService();
    const changes: string[] = [];
    const runner = new ReviewRunner(store, service as never, (_repo, id) => changes.push(id));

    const id = await runner.start(input);
    settle('done');
    await waitFor(() => runner.isRunning(id) === false);

    expect(changes.filter(c => c === id).length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-runner.test.ts`
Expected: FAIL — cannot resolve `review-runner`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/services/review-runner.ts
import { AIReviewService, ReviewCancelledError } from './ai-review.service';
import { buildReviewId } from './review-key';
import type { ReviewStore } from './review-store';

export interface StartReviewInput {
  repoId: string;
  sourceBranch: string;
  sourceSha: string;
  targetBranch: string;
  targetSha: string;
  provider: string;
  model: string;
  payloadText: string;
}

interface InFlight {
  repoId: string;
  controller: AbortController;
}

/**
 * Owns every review child process. The host holds these, not the webview, so a
 * run survives a webview reload and dies with the extension rather than leaking.
 */
export class ReviewRunner {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly store: ReviewStore,
    private readonly service: AIReviewService,
    private readonly onChange: (repoId: string, id: string) => void,
  ) {}

  public isRunning(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Resolves once the entry exists — not when the review finishes. */
  public async start(input: StartReviewInput): Promise<string> {
    const id = buildReviewId(input);
    const controller = new AbortController();

    await this.store.create(input.repoId, {
      id,
      sourceBranch: input.sourceBranch,
      sourceSha: input.sourceSha,
      targetBranch: input.targetBranch,
      targetSha: input.targetSha,
      provider: input.provider,
      model: input.model || 'default',
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    this.inFlight.set(id, { repoId: input.repoId, controller });
    this.onChange(input.repoId, id);

    void this.run(id, input, controller);
    return id;
  }

  public cancel(repoId: string, id: string): boolean {
    const running = this.inFlight.get(id);
    if (!running || running.repoId !== repoId) return false;
    running.controller.abort();
    return true;
  }

  public cancelAll(): void {
    for (const running of this.inFlight.values()) {
      running.controller.abort();
    }
  }

  private async run(id: string, input: StartReviewInput, controller: AbortController): Promise<void> {
    // Chunks are written straight through; the store appends, so an open editor
    // tab sees the review grow.
    const writes: Promise<void>[] = [];
    let writeError: string | undefined;
    const onChunk = (text: string) => {
      // A failed write (disk full, permissions) must not abort the run, but it
      // must not vanish either — it is reported on the finished entry.
      writes.push(this.store.appendBody(input.repoId, id, text).catch((err: unknown) => {
        writeError ??= err instanceof Error ? err.message : String(err);
      }));
    };

    try {
      await this.service.review({
        diff: '',
        payloadText: input.payloadText,
        provider: input.provider,
        model: input.model,
        onChunk,
        signal: controller.signal,
      });
      await Promise.all(writes);
      await this.store.finish(input.repoId, id, {
        status: writeError ? 'failed' : 'done',
        finishedAt: new Date().toISOString(),
        error: writeError,
      });
    } catch (err) {
      await Promise.all(writes);
      if (err instanceof ReviewCancelledError) {
        // The partial body stays on disk: half a review is often still useful.
        await this.store.finish(input.repoId, id, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await this.store.appendBody(input.repoId, id, `\n\n---\n\n**Review failed:** ${message}\n`);
        await this.store.finish(input.repoId, id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: message,
        });
      }
    } finally {
      this.inFlight.delete(id);
      this.onChange(input.repoId, id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-runner.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/review-runner.ts tests/extension/review-runner.test.ts
git commit -m "feat: run reviews as cancellable host-owned jobs"
```

---

### Task 6: `review.*` namespace and shutdown

**Files:**
- Modify: `src/extension/extension.ts:13` (activate signature area), `:317-386` (the `ai` namespace), and the module's `deactivate` export
- Test: `tests/extension/review-namespace.test.ts`

**Interfaces:**
- Consumes: `ReviewStore` (Task 2), `ReviewRunner` (Task 5), `repoIdFor` (Task 1), existing `buildReviewPayload` from `./services/review-payload`.
- Produces: message methods `review.start`, `review.list`, `review.get`, `review.cancel`, `review.delete`, `review.open`; event `review.changed`.

`ai.providers` and `ai.compare` stay exactly as they are — the webview still needs both. `ai.review` and `ai.reviewDiff` are removed in Task 7 once nothing calls them.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-namespace.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createReviewHandler } from '../../src/extension/controllers/review-method-handler';

function harness(over: Record<string, unknown> = {}) {
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    remove: vi.fn(async () => {}),
    bodyPath: vi.fn(() => '/tmp/body.md'),
  };
  const runner = { start: vi.fn(async () => 'new-id'), cancel: vi.fn(() => true) };
  const git = {
    revParse: vi.fn(async (ref: string) => (ref === 'main' ? 'a'.repeat(40) : 'b'.repeat(40))),
    getDiff: vi.fn(async () => 'diff --git a/x b/x'),
    diff: vi.fn(async () => ({ files: [] })),
    log: vi.fn(async () => []),
  };
  const handler = createReviewHandler({
    store: store as never,
    runner: runner as never,
    getGitService: () => git as never,
    getRepoId: () => 'repo-a',
    getMaxDiffChars: () => 0,
    openBody: vi.fn(async () => {}),
    ...over,
  });
  return { handler, store, runner, git };
}

describe('review namespace', () => {
  it('starts a run and returns its id without waiting for the CLI', async () => {
    const { handler, runner } = harness();

    const result = await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'new-id', cached: false });
    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('reuses a completed review for the same shas and model instead of spawning', async () => {
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'done' } as never);

    const result = await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(result).toEqual({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', cached: true });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('re-runs when the cached entry failed rather than serving the failure', async () => {
    const { handler, runner, store } = harness();
    store.get.mockResolvedValue({ id: 'aaaaaaa..bbbbbbb.claude.sonnet', status: 'failed' } as never);

    await handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    });

    expect(runner.start).toHaveBeenCalledOnce();
  });

  it('refuses an empty diff without creating an entry', async () => {
    const { handler, runner, git } = harness();
    git.getDiff.mockResolvedValue('   ');

    await expect(handler('review.start', {
      sourceBranch: 'main', targetBranch: 'main', provider: 'claude', model: 'sonnet',
    })).rejects.toThrow(/no differences/i);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it('cancels through the runner', async () => {
    const { handler, runner } = harness();

    expect(await handler('review.cancel', { id: 'x' })).toEqual({ cancelled: true });
    expect(runner.cancel).toHaveBeenCalledWith('repo-a', 'x');
  });

  it('lists entries for the active repo', async () => {
    const { handler, store } = harness();

    await handler('review.list', {});
    expect(store.list).toHaveBeenCalledWith('repo-a');
  });

  it('fails clearly when no repository is active', async () => {
    const { handler } = harness({ getGitService: () => undefined });

    await expect(handler('review.start', {
      sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
    })).rejects.toThrow(/no git repository/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-namespace.test.ts`
Expected: FAIL — cannot resolve `review-method-handler`.

- [ ] **Step 3: Write minimal implementation**

Create `src/extension/controllers/review-method-handler.ts`. Putting the namespace in its own controller matches `git-method-handler.ts` and `graph-method-handler.ts`, and keeps it testable without touching `vscode`:

```ts
// src/extension/controllers/review-method-handler.ts
import { buildReviewId } from '../services/review-key';
import { buildReviewPayload } from '../services/review-payload';
import type { ReviewRunner } from '../services/review-runner';
import type { ReviewStore } from '../services/review-store';

interface GitLike {
  revParse(ref: string): Promise<string>;
  getDiff(source: string, target: string): Promise<string>;
  diff(source: string, target: string): Promise<{ files: unknown[] }>;
  log(options: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]>;
}

export interface ReviewHandlerDeps {
  store: ReviewStore;
  runner: ReviewRunner;
  getGitService: () => GitLike | undefined;
  getRepoId: () => string | undefined;
  getMaxDiffChars: () => number;
  openBody: (repoId: string, id: string) => Promise<void>;
}

export function createReviewHandler(deps: ReviewHandlerDeps) {
  return async function handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const repoId = deps.getRepoId();
    if (!repoId) throw new Error('No git repository found');

    switch (method) {
      case 'review.list':
        return deps.store.list(repoId);

      case 'review.get':
        return deps.store.get(repoId, p.id as string) ?? null;

      case 'review.cancel':
        return { cancelled: deps.runner.cancel(repoId, p.id as string) };

      case 'review.delete':
        await deps.store.remove(repoId, p.id as string);
        return { success: true };

      case 'review.open':
        await deps.openBody(repoId, p.id as string);
        return { success: true };

      case 'review.start': {
        const git = deps.getGitService();
        if (!git) throw new Error('No git repository found');

        const sourceBranch = p.sourceBranch as string;
        const targetBranch = p.targetBranch as string;
        const provider = p.provider as string;
        const model = (p.model as string) || '';

        const [sourceSha, targetSha] = await Promise.all([
          git.revParse(sourceBranch),
          git.revParse(targetBranch),
        ]);

        // Same commits, same model: serve the stored answer. Only a completed
        // review is reusable — a failure or a cancellation should be retried.
        const id = buildReviewId({ sourceSha, targetSha, provider, model });
        const existing = await deps.store.get(repoId, id);
        if (existing?.status === 'done') {
          await deps.openBody(repoId, id);
          return { id, cached: true };
        }

        const diff = await git.getDiff(sourceBranch, targetBranch);
        if (!diff.trim()) {
          throw new Error(`No differences between ${sourceBranch} and ${targetBranch}`);
        }

        const [changed, commits] = await Promise.all([
          git.diff(sourceBranch, targetBranch).then(d => d.files).catch(() => undefined),
          git.log({ revisions: [`${sourceBranch}..${targetBranch}`], maxCount: 100 })
            .then(cs => cs.map(c => c.subject))
            .catch(() => undefined),
        ]);

        const payload = buildReviewPayload({
          baseBranch: sourceBranch,
          headBranch: targetBranch,
          diff,
          files: changed as never,
          commits,
          budget: deps.getMaxDiffChars(),
        });

        const startedId = await deps.runner.start({
          repoId,
          sourceBranch, sourceSha,
          targetBranch, targetSha,
          provider, model,
          payloadText: payload.text,
        });
        return { id: startedId, cached: false };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  };
}
```

If `GitService` has no `revParse`, add one next to `getDiff` in `src/extension/services/git.service.ts`:

```ts
  public async revParse(ref: string): Promise<string> {
    return (await this.cli.exec(['rev-parse', ref])).trim();
  }
```

Wire it in `src/extension/extension.ts` inside `activate`, after `aiReview` is constructed:

```ts
  const { ReviewStore } = await import('./services/review-store');
  const { ReviewRunner } = await import('./services/review-runner');
  const { createReviewHandler } = await import('./controllers/review-method-handler');
  const { repoIdFor } = await import('./services/review-key');

  const reviewStore = new ReviewStore(vscode.Uri.joinPath(context.globalStorageUri, 'reviews').fsPath);
  await reviewStore.reconcileOrphans();
```

Add `import { realpathSync } from 'fs';` to the imports at the top of `extension.ts`.

Inside the per-session wiring, register the namespace next to the others. **Name
`getRepoId`, `openBody` and `reviewHandler` as standalone consts** — Task 11 wires the
same three into the view, and inlining them here means duplicating them there:

```ts
    const reviewRunner = new ReviewRunner(reviewStore, aiReview, (_repoId, id) => {
      router.sendEvent('review.changed', { id });
      reviewTree?.refresh();            // undefined until Task 11 registers the view
      void syncTicker?.();              // undefined until Task 11 adds the clock
    });
    runners.push(reviewRunner);         // module-level array, drained in deactivate

    const getRepoId = (): string | undefined => {
      const repoPath = session.getGitService()?.getRepoPath();
      return repoPath ? repoIdFor(realpathSync(repoPath)) : undefined;
    };

    const openBody = async (repoId: string, id: string): Promise<void> => {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(reviewStore.bodyPath(repoId, id)),
      );
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
      await vscode.window.showTextDocument(doc, { preview: false });
    };

    const reviewHandler = createReviewHandler({
      store: reviewStore,
      runner: reviewRunner,
      getGitService: () => session.getGitService() as never,
      getRepoId,
      getMaxDiffChars: () =>
        vscode.workspace.getConfiguration('gitGraphPro.aiReview').get<number>('maxDiffChars') ?? 0,
      openBody,
    });
    router.register('review', reviewHandler);
```

Add the module-level runner registry and shutdown hook:

```ts
const runners: { cancelAll(): void }[] = [];

export function deactivate(): void {
  // Nothing must outlive the window. Without this, detached CLI process groups
  // keep running and keep spending after VS Code is gone.
  for (const runner of runners) runner.cancelAll();
  runners.length = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-namespace.test.ts && npm run typecheck`
Expected: PASS, 7 tests, and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/extension/controllers/review-method-handler.ts src/extension/extension.ts src/extension/services/git.service.ts tests/extension/review-namespace.test.ts
git commit -m "feat: add review.* namespace with sha-pair cache and shutdown kill"
```

---

### Task 7: Webview starts jobs instead of holding results

**Files:**
- Modify: `src/webview/App.svelte:184-186` (review state), `:1194-1205` (`handleAIReview`), `:1454-1470` (panel props)
- Modify: `src/extension/extension.ts` — delete the now-unused `ai.review` and `ai.reviewDiff` cases
- Test: `tests/webview/app-review-jobs.test.ts`

**Interfaces:**
- Consumes: `review.start`, `review.get`, event `review.changed` (Task 6).
- Produces: nothing for later tasks.

After this task Phase 4's acceptance holds: the result lives on disk, so clicking a commit or reloading the webview no longer destroys anything.

- [ ] **Step 1: Write the failing test**

```ts
// tests/webview/app-review-jobs.test.ts
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

function stub() {
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return [];
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      case 'review.start': return { id: 'rev-1', cached: false };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('App review jobs', () => {
  it('never calls the removed blocking ai.review method', async () => {
    stub();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    render(App);
    await waitFor(() => expect(send).toHaveBeenCalledWith('repo.list'));

    expect(send.mock.calls.map(c => c[0])).not.toContain('ai.review');
  });

  it('subscribes to review.changed so a finished run can surface', async () => {
    stub();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    render(App);

    await waitFor(() => expect(on.mock.calls.map(c => c[0])).toContain('review.changed'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-review-jobs.test.ts`
Expected: FAIL on the second test — nothing subscribes to `review.changed` yet.

- [ ] **Step 3: Write minimal implementation**

In `src/webview/App.svelte`, replace `handleAIReview` so it starts a job and stops holding the result:

```ts
  let aiReviewJobId: string | null = null;

  async function handleAIReview(event: CustomEvent<{ sourceBranch: string; targetBranch: string; provider: string; model: string }>) {
    const { sourceBranch, targetBranch, provider, model } = event.detail;
    aiReviewLoading = true;
    aiReviewError = '';
    try {
      const started = await bridge.send('review.start', { sourceBranch, targetBranch, provider, model }) as { id: string };
      aiReviewJobId = started.id;
    } catch (e) {
      aiReviewError = e instanceof Error ? e.message : String(e);
      aiReviewLoading = false;
    }
  }
```

Delete the `aiReviewResult` declaration at `:184` and every reference to it. In the `onMount` that registers bridge listeners, add:

```ts
    bridge.on('review.changed', (data) => {
      const changed = data as { id: string };
      if (changed.id === aiReviewJobId) aiReviewLoading = false;
    });
```

In `src/extension/extension.ts`, delete the `case 'ai.review':` and `case 'ai.reviewDiff':` blocks together with the now-unused `buildReviewPayload` import — the payload is built in the review handler now. Keep `ai.providers` and `ai.compare`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/ && npm run typecheck`
Expected: PASS. `app-toolbar.test.ts` and the other App suites must stay green.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/webview/App.svelte src/extension/extension.ts tests/webview/app-review-jobs.test.ts
git commit -m "feat: webview starts review jobs instead of holding results"
```

**Phase 4 acceptance:** start a review, click a commit row, reload the webview — the entry is still on disk and still progressing. Close the window mid-run and confirm with `ps aux | grep claude` that no process survives.

---

## Phase 5 — Review view

Tasks 8-11. Depends on Phase 4, and on Phase 2 of the bottom-panel plan for the panel container.

### Task 8: Panel container, icon and contributions

**Files:**
- Create: `resources/review.svg`
- Modify: `package.json` (`contributes.viewsContainers`, `contributes.views`, `contributes.commands`, `contributes.menus`)
- Test: `tests/extension/review-contributions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: view container id `gitGraphProReview`, view id `gitGraphPro.reviews`, commands `gitGraphPro.review.cancel|rerun|delete`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-contributions.test.ts
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';

const contributes = pkg.contributes as Record<string, never>;

describe('review contributions', () => {
  it('adds a Code Review container to the bottom Panel', () => {
    const panel = (contributes.viewsContainers as unknown as { panel: { id: string; icon: string }[] }).panel;
    const review = panel.find(c => c.id === 'gitGraphProReview');

    expect(review).toBeDefined();
    expect(review?.icon).toBe('resources/review.svg');
  });

  it('registers the reviews tree view in that container', () => {
    const views = contributes.views as unknown as Record<string, { id: string; type?: string }[]>;

    expect(views.gitGraphProReview?.[0]?.id).toBe('gitGraphPro.reviews');
    expect(views.gitGraphProReview?.[0]?.type).toBeUndefined(); // a tree, not a webview
  });

  it('declares cancel, rerun and delete commands', () => {
    const ids = (contributes.commands as unknown as { command: string }[]).map(c => c.command);

    expect(ids).toEqual(expect.arrayContaining([
      'gitGraphPro.review.cancel',
      'gitGraphPro.review.rerun',
      'gitGraphPro.review.delete',
    ]));
  });

  it('shows cancel only on a running row and rerun/delete only on finished rows', () => {
    const menus = (contributes.menus as unknown as Record<string, { command: string; when: string }[]>);
    const items = menus['view/item/context'];
    const find = (command: string) => items.find(i => i.command === command);

    expect(find('gitGraphPro.review.cancel')?.when).toContain('viewItem == running');
    expect(find('gitGraphPro.review.rerun')?.when).toContain('viewItem != running');
    expect(find('gitGraphPro.review.delete')?.when).toContain('viewItem != running');
  });

  it('keeps activationEvents empty so VS Code infers onView', () => {
    expect(pkg.activationEvents).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-contributions.test.ts`
Expected: FAIL — `viewsContainers` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `resources/review.svg` — a single-colour glyph that inherits the theme, matching how `icon.svg` is authored:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
  <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4 3.5V17H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 4h12v1.6H6V8Zm0 4h9v1.6H6V12Z"/>
</svg>
```

Add to `package.json` under `contributes` (alongside the `gitGraphPro` container that the bottom-panel plan adds):

```jsonc
"viewsContainers": {
  "panel": [
    { "id": "gitGraphPro",       "title": "Git Graph",   "icon": "resources/icon.svg" },
    { "id": "gitGraphProReview", "title": "Code Review", "icon": "resources/review.svg" }
  ]
},
"views": {
  "gitGraphPro":       [{ "type": "webview", "id": "gitGraphPro.graph", "name": "Git Graph",
                          "webviewOptions": { "retainContextWhenHidden": true } }],
  "gitGraphProReview": [{ "id": "gitGraphPro.reviews", "name": "Reviews" }]
},
"commands": [
  { "command": "gitGraphPro.open",          "title": "Git Graph Pro: Open" },
  { "command": "gitGraphPro.review.cancel", "title": "Cancel Review", "icon": "$(stop-circle)" },
  { "command": "gitGraphPro.review.rerun",  "title": "Re-run Review", "icon": "$(refresh)" },
  { "command": "gitGraphPro.review.delete", "title": "Delete Review", "icon": "$(trash)" }
],
"menus": {
  "view/item/context": [
    { "command": "gitGraphPro.review.cancel", "when": "view == gitGraphPro.reviews && viewItem == running", "group": "inline" },
    { "command": "gitGraphPro.review.rerun",  "when": "view == gitGraphPro.reviews && viewItem != running", "group": "inline" },
    { "command": "gitGraphPro.review.delete", "when": "view == gitGraphPro.reviews && viewItem != running", "group": "inline" }
  ],
  "commandPalette": [
    { "command": "gitGraphPro.review.cancel", "when": "false" },
    { "command": "gitGraphPro.review.rerun",  "when": "false" },
    { "command": "gitGraphPro.review.delete", "when": "false" }
  ]
}
```

The `commandPalette` entries hide the three row commands from the palette, where they have no row to act on and would throw.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-contributions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json resources/review.svg tests/extension/review-contributions.test.ts
git commit -m "feat: contribute the Code Review panel container and row commands"
```

---

### Task 9: Hoist RepositorySession to activate

**Files:**
- Modify: `src/extension/extension.ts`, `src/extension/providers/webview-provider.ts`
- Test: `tests/extension/repository-session.test.ts` (extend)

**Interfaces:**
- Consumes: existing `RepositorySession`.
- Produces: a single session instance created in `activate` and injected into both the webview provider and the tree provider.

The tree view needs the active repo, and it has no webview to hang off. If the bottom-panel plan's Task 1 and Task 5 are already done, that work created the single session — verify it and skip ahead. Otherwise do it here.

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/extension/repository-session.test.ts
  it('exposes the active repository path for consumers outside the webview', () => {
    const session = new RepositorySession([{ name: 'repo', path: '/repo' }]);

    expect(session.getActiveRepositoryPath()).toBe('/repo');
  });

  it('reports undefined before any repository is active', () => {
    const session = new RepositorySession([]);

    expect(session.getActiveRepositoryPath()).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/repository-session.test.ts`
Expected: FAIL — `getActiveRepositoryPath is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `RepositorySession` in `src/extension/controllers/repository-session.ts`:

```ts
  /** The active repo root, for consumers that have no webview to ask. */
  public getActiveRepositoryPath(): string | undefined {
    return this.getGitService()?.getRepoPath();
  }
```

In `src/extension/extension.ts`, construct the session once in `activate` and pass it into the webview provider rather than letting the provider build its own.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/controllers/repository-session.ts src/extension/extension.ts src/extension/providers/webview-provider.ts tests/extension/repository-session.test.ts
git commit -m "refactor: own one RepositorySession at extension scope"
```

---

### Task 10: ReviewTreeProvider

**Files:**
- Create: `src/extension/providers/review-tree-provider.ts`
- Test: `tests/extension/review-tree-provider.test.ts`

**Interfaces:**
- Consumes: `ReviewStore`, `ReviewEntry` (Task 2).
- Produces: `formatDescription(entry: ReviewEntry, now: number): string`, `statusIcon(status: ReviewStatus): string`, `class ReviewTreeProvider` with `refresh()`, `getTreeItem()`, `getChildren()`, `onDidChangeTreeData`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-tree-provider.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    public event = vi.fn();
    public fire = vi.fn();
    public dispose = vi.fn();
  },
  ThemeIcon: class { constructor(public readonly id: string) {} },
  TreeItem: class { constructor(public readonly label: string) {} },
  TreeItemCollapsibleState: { None: 0 },
}));

import {
  ReviewTreeProvider, formatDescription, statusIcon,
} from '../../src/extension/providers/review-tree-provider';
import type { ReviewEntry } from '../../src/extension/services/review-store';

function entry(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    id: 'aaaaaaa..bbbbbbb.claude.sonnet',
    sourceBranch: 'main',
    sourceSha: 'a'.repeat(40),
    targetBranch: 'feat/graph',
    targetSha: 'b'.repeat(40),
    provider: 'claude',
    model: 'sonnet',
    status: 'done',
    startedAt: new Date('2026-08-24T10:00:00Z').toISOString(),
    finishedAt: new Date('2026-08-24T10:05:00Z').toISOString(),
    ...over,
  };
}

describe('formatDescription', () => {
  it('counts elapsed time while a review runs', () => {
    const now = new Date('2026-08-24T10:02:14Z').getTime();

    expect(formatDescription(entry({ status: 'running', finishedAt: undefined }), now))
      .toBe('2m14s');
  });

  it('shows seconds only for a young run', () => {
    const now = new Date('2026-08-24T10:00:09Z').getTime();

    expect(formatDescription(entry({ status: 'running', finishedAt: undefined }), now))
      .toBe('9s');
  });

  it('shows a relative time once finished', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry(), now)).toBe('8m ago');
  });

  it('labels a failure rather than a time', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry({ status: 'failed' }), now)).toBe('failed · 8m ago');
  });

  it('labels an interrupted run', () => {
    const now = new Date('2026-08-24T10:13:00Z').getTime();

    expect(formatDescription(entry({ status: 'interrupted' }), now)).toBe('interrupted · 8m ago');
  });
});

describe('statusIcon', () => {
  it('spins only while running', () => {
    expect(statusIcon('running')).toBe('loading~spin');
    expect(statusIcon('done')).toBe('check');
    expect(statusIcon('failed')).toBe('error');
    expect(statusIcon('cancelled')).toBe('circle-slash');
    expect(statusIcon('interrupted')).toBe('warning');
  });
});

describe('ReviewTreeProvider', () => {
  it('labels a row base-arrow-head so the direction is unambiguous', async () => {
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    const item = provider.getTreeItem(entry());
    expect(item.label).toBe('main ← feat/graph');
  });

  it('puts the status in contextValue so menu when-clauses can bind to it', () => {
    const store = { list: vi.fn(async () => []) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    expect(provider.getTreeItem(entry({ status: 'running' })).contextValue).toBe('running');
    expect(provider.getTreeItem(entry({ status: 'done' })).contextValue).toBe('done');
  });

  it('returns nothing when no repository is active', async () => {
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => undefined);

    expect(await provider.getChildren()).toEqual([]);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('lists the active repo entries', async () => {
    const store = { list: vi.fn(async () => [entry()]) };
    const provider = new ReviewTreeProvider(store as never, () => 'repo-a');

    expect(await provider.getChildren()).toHaveLength(1);
    expect(store.list).toHaveBeenCalledWith('repo-a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-tree-provider.test.ts`
Expected: FAIL — cannot resolve `review-tree-provider`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/providers/review-tree-provider.ts
import * as vscode from 'vscode';
import type { ReviewEntry, ReviewStatus, ReviewStore } from '../services/review-store';

export function statusIcon(status: ReviewStatus): string {
  switch (status) {
    case 'running': return 'loading~spin';
    case 'done': return 'check';
    case 'failed': return 'error';
    case 'cancelled': return 'circle-slash';
    case 'interrupted': return 'warning';
  }
}

function elapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * A running row counts up so the user can see it is alive; a finished row shows
 * how long ago it landed. Anything other than `done` names its status first,
 * because "8m ago" alone reads as success.
 */
export function formatDescription(entry: ReviewEntry, now: number): string {
  if (entry.status === 'running') {
    return elapsed(now - Date.parse(entry.startedAt));
  }
  const finishedAt = entry.finishedAt ?? entry.startedAt;
  const relative = ago(now - Date.parse(finishedAt));
  return entry.status === 'done' ? relative : `${entry.status} · ${relative}`;
}

export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewEntry> {
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ReviewStore,
    private readonly getRepoId: () => string | undefined,
  ) {}

  public refresh(): void {
    this.changed.fire();
  }

  public getTreeItem(entry: ReviewEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(`${entry.sourceBranch} ← ${entry.targetBranch}`);
    item.description = formatDescription(entry, Date.now());
    item.iconPath = new vscode.ThemeIcon(statusIcon(entry.status));
    item.contextValue = entry.status;
    item.tooltip = `${entry.provider} · ${entry.model}\n${entry.sourceSha.slice(0, 7)}..${entry.targetSha.slice(0, 7)}`;
    item.command = {
      command: 'gitGraphPro.review.open',
      title: 'Open Review',
      arguments: [entry],
    };
    return item;
  }

  public async getChildren(): Promise<ReviewEntry[]> {
    const repoId = this.getRepoId();
    if (!repoId) return [];
    return this.store.list(repoId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/review-tree-provider.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extension/providers/review-tree-provider.ts tests/extension/review-tree-provider.test.ts
git commit -m "feat: add the reviews tree data provider"
```

---

### Task 11: Register the view, commands and the ticking refresh

**Files:**
- Modify: `src/extension/extension.ts`
- Test: `tests/extension/review-view-registration.test.ts`

**Interfaces:**
- Consumes: `ReviewTreeProvider` (Task 10), `ReviewRunner`, `ReviewStore`, the review handler (Task 6).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// tests/extension/review-view-registration.test.ts
import { describe, expect, it, vi } from 'vitest';
import { registerReviewView } from '../../src/extension/providers/review-view-registration';

function harness() {
  const disposables: unknown[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const tree = { refresh: vi.fn() };
  const runner = { cancel: vi.fn(() => true) };
  const store = { remove: vi.fn(async () => {}) };
  const deps = {
    tree: tree as never,
    runner: runner as never,
    store: store as never,
    getRepoId: () => 'repo-a',
    openBody: vi.fn(async () => {}),
    rerun: vi.fn(async () => {}),
    registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
      commands.set(id, fn);
      return { dispose: vi.fn() };
    },
    registerTreeView: vi.fn(() => ({ dispose: vi.fn() })),
    subscribe: (d: unknown) => disposables.push(d),
  };
  registerReviewView(deps);
  return { commands, tree, runner, store, deps, disposables };
}

const entry = { id: 'rev-1', status: 'done' } as never;

describe('registerReviewView', () => {
  it('registers the tree view under the contributed id', () => {
    const { deps } = harness();

    expect(deps.registerTreeView).toHaveBeenCalledWith('gitGraphPro.reviews', deps.tree);
  });

  it('cancel routes to the runner and refreshes the tree', async () => {
    const { commands, runner, tree } = harness();

    await commands.get('gitGraphPro.review.cancel')?.({ ...entry, status: 'running' });

    expect(runner.cancel).toHaveBeenCalledWith('repo-a', 'rev-1');
    expect(tree.refresh).toHaveBeenCalled();
  });

  it('delete removes from the store and refreshes', async () => {
    const { commands, store, tree } = harness();

    await commands.get('gitGraphPro.review.delete')?.(entry);

    expect(store.remove).toHaveBeenCalledWith('repo-a', 'rev-1');
    expect(tree.refresh).toHaveBeenCalled();
  });

  it('open shows the body document', async () => {
    const { commands, deps } = harness();

    await commands.get('gitGraphPro.review.open')?.(entry);

    expect(deps.openBody).toHaveBeenCalledWith('repo-a', 'rev-1');
  });

  it('every registration is disposed with the extension', () => {
    const { disposables } = harness();

    expect(disposables.length).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extension/review-view-registration.test.ts`
Expected: FAIL — cannot resolve `review-view-registration`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/extension/providers/review-view-registration.ts
import type { ReviewEntry, ReviewStore } from '../services/review-store';
import type { ReviewRunner } from '../services/review-runner';
import type { ReviewTreeProvider } from './review-tree-provider';

export interface ReviewViewDeps {
  tree: ReviewTreeProvider;
  runner: ReviewRunner;
  store: ReviewStore;
  getRepoId: () => string | undefined;
  openBody: (repoId: string, id: string) => Promise<void>;
  rerun: (entry: ReviewEntry) => Promise<void>;
  registerCommand: (id: string, fn: (...args: never[]) => unknown) => { dispose(): void };
  registerTreeView: (id: string, tree: ReviewTreeProvider) => { dispose(): void };
  subscribe: (disposable: { dispose(): void }) => void;
}

/**
 * Split out of extension.ts so the command wiring is testable without a real
 * vscode module — the registration functions arrive as plain callbacks.
 */
export function registerReviewView(deps: ReviewViewDeps): void {
  deps.subscribe(deps.registerTreeView('gitGraphPro.reviews', deps.tree));

  const withRepo = (fn: (repoId: string, entry: ReviewEntry) => Promise<void> | void) =>
    async (entry: ReviewEntry) => {
      const repoId = deps.getRepoId();
      if (!repoId) return;
      await fn(repoId, entry);
      deps.tree.refresh();
    };

  deps.subscribe(deps.registerCommand('gitGraphPro.review.cancel',
    withRepo((repoId, entry) => { deps.runner.cancel(repoId, entry.id); }) as never));

  deps.subscribe(deps.registerCommand('gitGraphPro.review.delete',
    withRepo(async (repoId, entry) => { await deps.store.remove(repoId, entry.id); }) as never));

  deps.subscribe(deps.registerCommand('gitGraphPro.review.open',
    withRepo(async (repoId, entry) => { await deps.openBody(repoId, entry.id); }) as never));

  deps.subscribe(deps.registerCommand('gitGraphPro.review.rerun',
    withRepo(async (_repoId, entry) => { await deps.rerun(entry); }) as never));
}
```

Wire it in `src/extension/extension.ts` after the review handler is registered:

```ts
  const { ReviewTreeProvider } = await import('./providers/review-tree-provider');
  const { registerReviewView } = await import('./providers/review-view-registration');

  const reviewTree = new ReviewTreeProvider(reviewStore, getRepoId);

  registerReviewView({
    tree: reviewTree,
    runner: reviewRunner,
    store: reviewStore,
    getRepoId,
    openBody,
    rerun: async (entry) => {
      await reviewStore.remove(getRepoId()!, entry.id);
      await reviewHandler('review.start', {
        sourceBranch: entry.sourceBranch,
        targetBranch: entry.targetBranch,
        provider: entry.provider,
        model: entry.model,
      });
    },
    registerCommand: (id, fn) => vscode.commands.registerCommand(id, fn),
    registerTreeView: (id, tree) => vscode.window.createTreeView(id, { treeDataProvider: tree }),
    subscribe: (d) => context.subscriptions.push(d),
  });
```

Add the ticking refresh so a running row's clock advances. One timer for the whole view, started only while something runs:

```ts
  let tick: ReturnType<typeof setInterval> | undefined;
  const syncTicker = async () => {
    const repoId = getRepoId();
    const running = repoId
      ? (await reviewStore.list(repoId)).some(e => e.status === 'running')
      : false;
    if (running && !tick) {
      tick = setInterval(() => reviewTree.refresh(), 1000);
    } else if (!running && tick) {
      clearInterval(tick);
      tick = undefined;
    }
  };
  context.subscriptions.push({ dispose: () => { if (tick) clearInterval(tick); } });
```

Call `void syncTicker()` from the runner's `onChange` callback so the timer starts on the first run and stops when the last one ends.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extension/ && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/extension/providers/review-view-registration.ts src/extension/extension.ts tests/extension/review-view-registration.test.ts
git commit -m "feat: register the reviews view with row commands and a live clock"
```

**Phase 5 acceptance — manual, F5:**
1. A Code Review tab sits beside Git Graph and Terminal, with an icon.
2. Start a review, click a commit in the graph: the row is still there, still running.
3. Hide the Panel, show it again: the row is intact and the clock is still climbing.
4. Cancel: the row reads `cancelled`; `ps aux | grep -E 'claude|codex'` shows nothing.
5. Close VS Code mid-run, reopen: the row reads `interrupted`, not `done`.
6. Re-run the same branches with no new commits: the document opens instantly, no process spawns.
7. Commit to the branch and re-run: a second entry appears and both are kept, because the target sha changed.

---

## Phase 6 — Launcher-only graph panel

### Task 12: Strip result rendering from the webview

**Files:**
- Modify: `src/webview/components/review/AIReviewPanel.svelte` (remove result rendering, `reviewResult`/`reviewLoading` props and the result section styles)
- Modify: `src/webview/App.svelte:158` (`rightPanelMode`), `:1454-1470` (panel props), and `:441`
- Test: `tests/webview/app-review-jobs.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Phase 5.
- Produces: nothing.

This is what makes the original bug structurally impossible: with no review result held in the webview, there is nothing for a commit click to destroy.

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/webview/app-review-jobs.test.ts
  it('holds no review result state that a commit click could destroy', async () => {
    stub();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    const { container } = render(App);
    await waitFor(() => expect(send).toHaveBeenCalledWith('repo.list'));

    expect(container.querySelector('.review-result')).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webview/app-review-jobs.test.ts`
Expected: FAIL — `AIReviewPanel.svelte:341` renders `<div class="review-result">`, so the element is present until this task removes it.

- [ ] **Step 3: Write minimal implementation**

In `AIReviewPanel.svelte`, delete the result section markup, the `reviewResult` and `reviewLoading` props, the `on:openReview` dispatch, and the styles that only served them. Keep the branch pickers, provider/model selectors, the changed-file list, `on:compare`, `on:openDiff` and `on:settingsChange`. Change the Review button's handler to dispatch `review` and then show a one-line "Started — see the Code Review panel" hint.

In `App.svelte`, delete `aiReviewResult`, `aiReviewLoading`, `aiReviewError` and `handleOpenReviewInEditor`, and remove the corresponding props from the `<AIReviewPanel>` usage.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webview/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

```bash
npm run check
git add src/webview/components/review/AIReviewPanel.svelte src/webview/App.svelte tests/webview/app-review-jobs.test.ts
git commit -m "refactor: graph panel launches reviews and no longer renders them"
```

**Phase 6 acceptance:** grep for `aiReviewResult` and `rightPanelMode === 'review'` result rendering — both gone. The `App.svelte:441` / `:1176` loss no longer has any state to lose.

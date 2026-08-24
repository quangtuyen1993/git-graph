# Review Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Biến tab Code Review (bottom Panel) thành workbench compare + review hoàn chỉnh: tự chọn 2 branch, review từng commit, compare khoảng 2 commit, entry point từ tab Git Graph.

**Architecture:** Host giữ toàn bộ nguồn sự thật (ReviewStore, ReviewTargetState, RouterRegistry broadcast); tab Code Review là Svelte webview thứ hai (vite input riêng) chỉ render; graph webview đẩy target qua method `review.setTarget` với host làm trung gian duy nhất.

**Tech Stack:** TypeScript, Svelte 4, Vite, vitest + @testing-library/svelte, VS Code extension API (mock toàn bộ trong test).

**Spec:** `docs/superpowers/specs/2026-08-24-review-workbench-design.md`

## Global Constraints

- Chiều diff KHÔNG đổi: luôn `base..head`, nhãn `base ← head`. Cấm đảo chiều.
- Id review GIỮ NGUYÊN cách ghép: `${base7}..${head7}.${provider}.${model}`.
- Không đường nào tự chạy review — chỉ nút Review do người dùng bấm.
- Mọi kiểu hỏng kết thúc thành lỗi nhìn thấy được, không mất im lặng.
- Empty-tree hash của git: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
- Lệnh kiểm tra cuối mỗi task: `npx vitest run <file>` cho task đó; cuối mỗi phase: `npm run check` (test + coverage + typecheck + build).
- Điều chỉnh so với spec (đã phát hiện khi đọc code): (1) repo CÓ hạ tầng test component (`@testing-library/svelte`) — ReviewApp phải có test component, không chỉ checklist thủ công; (2) `review.compare` được thêm vào handler ngay Phase 1 (Task 4) thay vì đợi Phase 3 rename `ai.compare` — ReviewApp dùng nó từ đầu, `ai.compare` của graph bị xoá ở Task 11.

---

## Phase 1 — Host: model + target state

### Task 1: Đổi tên model `source*/target*` → `base*/head*` + migration

Một refactor nguyên tử: `ReviewEntry`, `buildReviewId`, `StartReviewInput`, handler nội bộ, tree provider, extension rerun — compiler dẫn đường. Wire protocol (`review.start` params từ webview) GIỮ NGUYÊN `sourceBranch`/`targetBranch` trong task này; Task 4 mới đổi.

**Files:**
- Modify: `src/extension/services/review-store.ts`
- Modify: `src/extension/services/review-key.ts`
- Modify: `src/extension/services/review-runner.ts`
- Modify: `src/extension/controllers/review-method-handler.ts`
- Modify: `src/extension/providers/review-tree-provider.ts:70-74`
- Modify: `src/extension/extension.ts` (khối `rerun` trong `registerReviewView`, ~dòng 522-528)
- Test: `tests/extension/review-store.test.ts` (thêm migration tests; rename fields trong test cũ)
- Test: mechanical rename trong `tests/extension/review-key.test.ts`, `review-runner.test.ts`, `review-namespace.test.ts`, `review-orphans.test.ts`, `review-body-content.test.ts`, `review-tree-provider.test.ts`, `review-host-wiring.test.ts`, `review-view-registration.test.ts`

**Interfaces:**
- Produces: `ReviewTargetKind`, `ReviewEntry { id, kind, baseRef, baseSha, headRef, headSha, subject?, provider, model, status, startedAt, finishedAt?, error? }` (export từ review-store), `buildReviewId({ baseSha, headSha, provider, model? })`, `StartReviewInput { repoId, kind, baseRef, baseSha, headRef, headSha, subject?, provider, model, payloadText }`.
- Mọi task sau đều tiêu thụ các tên này — sai một tên là hỏng dây chuyền.

- [ ] **Step 1: Viết failing test cho migration trong `tests/extension/review-store.test.ts`**

Thêm vào cuối file (dùng cùng helper tạo store/tmpdir mà file test đang dùng — đọc phần đầu file để lấy đúng tên helper):

```ts
describe('index migration', () => {
  it('maps a legacy sourceBranch entry to baseRef/headRef with kind branch', async () => {
    const { store, root } = await makeStore(); // dùng helper sẵn có của file
    const legacy = [{
      id: 'aaaaaaa..bbbbbbb.claude.sonnet',
      sourceBranch: 'main', sourceSha: 'a'.repeat(40),
      targetBranch: 'feat/x', targetSha: 'b'.repeat(40),
      provider: 'claude', model: 'sonnet',
      status: 'done', startedAt: '2026-08-01T00:00:00.000Z',
    }];
    await mkdir(join(root, 'repo-a'), { recursive: true });
    await writeFile(join(root, 'repo-a', 'index.json'), JSON.stringify(legacy), 'utf8');

    const entries = await store.list('repo-a');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'aaaaaaa..bbbbbbb.claude.sonnet',
      kind: 'branch',
      baseRef: 'main', baseSha: 'a'.repeat(40),
      headRef: 'feat/x', headSha: 'b'.repeat(40),
    });
    // migration ghi lại file một lần: đọc thẳng từ đĩa phải thấy format mới
    const rewritten = JSON.parse(await readFile(join(root, 'repo-a', 'index.json'), 'utf8'));
    expect(rewritten[0].baseRef).toBe('main');
    expect(rewritten[0].sourceBranch).toBeUndefined();
  });

  it('drops an entry that is neither format instead of throwing', async () => {
    const { store, root } = await makeStore();
    await mkdir(join(root, 'repo-a'), { recursive: true });
    await writeFile(join(root, 'repo-a', 'index.json'),
      JSON.stringify([{ garbage: true }, null]), 'utf8');

    await expect(store.list('repo-a')).resolves.toEqual([]);
  });

  it('round-trips a commit-kind entry', async () => {
    const { store } = await makeStore();
    await store.create('repo-a', {
      id: 'aaaaaaa..bbbbbbb.claude.default',
      kind: 'commit',
      baseRef: 'a'.repeat(40), baseSha: 'a'.repeat(40),
      headRef: 'b'.repeat(40), headSha: 'b'.repeat(40),
      subject: 'fix: something (merge)',
      provider: 'claude', model: 'default',
      status: 'running', startedAt: new Date().toISOString(),
    });
    const entries = await store.list('repo-a');
    expect(entries[0].kind).toBe('commit');
    expect(entries[0].subject).toBe('fix: something (merge)');
  });
});
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx vitest run tests/extension/review-store.test.ts`
Expected: FAIL — type errors / thiếu field `kind`.

- [ ] **Step 3: Sửa `review-store.ts`**

Thay interface + thêm migration:

```ts
export type ReviewTargetKind = 'branch' | 'commit' | 'range';

export interface ReviewEntry {
  id: string;
  kind: ReviewTargetKind;
  /** Base of the comparison. Diff reads baseRef..headRef. */
  baseRef: string;
  baseSha: string;
  /** Head of the comparison. */
  headRef: string;
  headSha: string;
  /** Commit subject — only meaningful for kind 'commit'. */
  subject?: string;
  provider: string;
  model: string;
  status: ReviewStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
```

Trong `readIndex`, sau `JSON.parse` thành công và `Array.isArray(parsed)`:

```ts
if (Array.isArray(parsed)) {
  const { entries, changed } = migrateEntries(parsed);
  if (changed) await this.writeIndex(repoId, entries);
  return entries;
}
```

Thêm function module-level (không phải method — không cần `this`):

```ts
/**
 * Older indexes stored sourceBranch/targetBranch. Mapped in place, written
 * back once, so old cached reviews survive the rename. An entry in neither
 * format is dropped rather than thrown on — a corrupt row must not take the
 * whole index down.
 */
function migrateEntries(parsed: unknown[]): { entries: ReviewEntry[]; changed: boolean } {
  let changed = false;
  const entries: ReviewEntry[] = [];
  for (const raw of parsed) {
    const e = raw as Record<string, unknown> | null;
    if (e && typeof e.baseRef === 'string' && typeof e.id === 'string') {
      entries.push(raw as ReviewEntry);
      continue;
    }
    changed = true;
    if (e && typeof e.sourceBranch === 'string' && typeof e.id === 'string') {
      entries.push({
        id: e.id,
        kind: 'branch',
        baseRef: e.sourceBranch,
        baseSha: typeof e.sourceSha === 'string' ? e.sourceSha : '',
        headRef: typeof e.targetBranch === 'string' ? e.targetBranch : 'unknown',
        headSha: typeof e.targetSha === 'string' ? e.targetSha : '',
        provider: typeof e.provider === 'string' ? e.provider : 'unknown',
        model: typeof e.model === 'string' ? e.model : 'unknown',
        status: (e.status as ReviewStatus) ?? 'interrupted',
        startedAt: typeof e.startedAt === 'string' ? e.startedAt : new Date(0).toISOString(),
        ...(typeof e.finishedAt === 'string' ? { finishedAt: e.finishedAt } : {}),
        ...(typeof e.error === 'string' ? { error: e.error } : {}),
      });
    }
  }
  return { entries, changed };
}
```

Trong `rebuildIndex`, skeleton đổi thành:

```ts
return {
  id,
  kind: 'branch' as const,
  baseRef: 'unknown', baseSha: '',
  headRef: 'unknown', headSha: '',
  provider: 'unknown', model: 'unknown',
  status: 'interrupted' as const,
  startedAt: new Date(0).toISOString(),
};
```

- [ ] **Step 4: Sửa `review-key.ts`** — `buildReviewId` nhận `{ baseSha, headSha, provider, model? }`; thân hàm đổi `input.sourceSha`→`input.baseSha`, `input.targetSha`→`input.headSha`. Không đổi format chuỗi id.

- [ ] **Step 5: Sửa `review-runner.ts`**

```ts
import type { ReviewStore, ReviewTargetKind } from './review-store';

export interface StartReviewInput {
  repoId: string;
  kind: ReviewTargetKind;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  subject?: string;
  provider: string;
  model: string;
  payloadText: string;
}
```

Trong `start()`: `buildReviewId({ baseSha: input.baseSha, headSha: input.headSha, provider: input.provider, model: input.model })` và `store.create` với `{ id, kind: input.kind, baseRef: input.baseRef, baseSha: input.baseSha, headRef: input.headRef, headSha: input.headSha, ...(input.subject ? { subject: input.subject } : {}), provider, model: input.model || 'default', status: 'running', startedAt: ... }`.

- [ ] **Step 6: Sửa `review-method-handler.ts` (nội bộ, wire giữ nguyên)** — trong case `review.start`: đổi tên biến `sourceBranch/targetBranch` thành `baseRef/headRef` (vẫn đọc từ `p.sourceBranch`/`p.targetBranch`), `sourceSha/targetSha` → `baseSha/headSha`, `buildReviewId({ baseSha, headSha, provider, model })`, `runner.start({ repoId, kind: 'branch', baseRef, baseSha, headRef, headSha, provider, model, payloadText })`. `buildReviewPayload({ baseBranch: baseRef, headBranch: headRef, ... })`.

- [ ] **Step 7: Sửa `review-tree-provider.ts:70-74`** — `` `${entry.baseRef} ← ${entry.headRef}` `` và tooltip `` `${entry.baseSha.slice(0, 7)}..${entry.headSha.slice(0, 7)}` ``.

- [ ] **Step 8: Sửa `extension.ts` khối rerun** — `reviewHandler('review.start', { sourceBranch: entry.baseRef, targetBranch: entry.headRef, provider: entry.provider, model: entry.model })` (wire cũ, field mới).

- [ ] **Step 9: Rename trong các test còn lại** — grep toàn bộ `tests/`: `sourceBranch`→`baseRef`, `sourceSha`→`baseSha`, `targetBranch`→`headRef`, `targetSha`→`headSha` cho các object `ReviewEntry`/`StartReviewInput`; RIÊNG params gửi vào `handler('review.start', {...})` GIỮ `sourceBranch/targetBranch`. Entry literal nào thiếu `kind` thì thêm `kind: 'branch'`.

- [ ] **Step 10: Chạy toàn bộ + typecheck**

Run: `npx vitest run tests/extension && npm run typecheck`
Expected: PASS toàn bộ.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "refactor: rename review entry fields to base/head with index migration"
```

### Task 2: `review-target.ts` — resolve target + state theo repo

**Files:**
- Create: `src/extension/services/review-target.ts`
- Test: `tests/extension/review-target.test.ts`

**Interfaces:**
- Consumes: `ReviewTargetKind` từ `./review-store`.
- Produces:
  - `EMPTY_TREE_SHA: string`
  - `ReviewTarget { kind: ReviewTargetKind; baseRef: string; headRef: string; subject?: string }`
  - `ResolvedTarget { kind; baseRef; baseSha; headRef; headSha; subject? }` (mọi field string)
  - `TargetGit { revParse(ref): Promise<string>; getParents(hash): Promise<string[]>; log(o: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]> }`
  - `resolveReviewTarget(git: TargetGit, target: ReviewTarget): Promise<ResolvedTarget>`
  - `class ReviewTargetState { set(repoId: string, t: ReviewTarget): void; get(repoId: string): ReviewTarget | null }`

- [ ] **Step 1: Viết failing tests `tests/extension/review-target.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_TREE_SHA, ReviewTargetState, resolveReviewTarget,
} from '../../src/extension/services/review-target';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_P = 'c'.repeat(40);

function fakeGit(over: Record<string, unknown> = {}) {
  return {
    revParse: vi.fn(async (ref: string) => (ref === 'main' ? SHA_A : SHA_B)),
    getParents: vi.fn(async () => [SHA_P]),
    log: vi.fn(async () => [{ subject: 'fix: the thing' }]),
    ...over,
  };
}

describe('resolveReviewTarget', () => {
  it('resolves both refs for a branch target', async () => {
    const git = fakeGit();
    const resolved = await resolveReviewTarget(git, { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    expect(resolved).toMatchObject({ kind: 'branch', baseRef: 'main', baseSha: SHA_A, headRef: 'feat/x', headSha: SHA_B });
  });

  it('computes base from the first parent for a commit target and picks up the subject', async () => {
    const git = fakeGit();
    const resolved = await resolveReviewTarget(git, { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(resolved.baseSha).toBe(SHA_P);
    expect(resolved.baseRef).toBe(SHA_P);
    expect(resolved.subject).toBe('fix: the thing');
  });

  it('uses the empty tree as base for a root commit', async () => {
    const git = fakeGit({ getParents: vi.fn(async () => []) });
    const resolved = await resolveReviewTarget(git, { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(resolved.baseSha).toBe(EMPTY_TREE_SHA);
  });

  it('marks a merge commit in the subject', async () => {
    const git = fakeGit({ getParents: vi.fn(async () => [SHA_P, SHA_A]) });
    const resolved = await resolveReviewTarget(git, { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(resolved.baseSha).toBe(SHA_P); // first parent
    expect(resolved.subject).toBe('fix: the thing (merge)');
  });

  it('names the failing ref when rev-parse rejects', async () => {
    const git = fakeGit({ revParse: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(resolveReviewTarget(git, { kind: 'branch', baseRef: 'gone', headRef: 'feat/x' }))
      .rejects.toThrow(/"feat\/x"|"gone"/);
  });
});

describe('ReviewTargetState', () => {
  it('keeps targets separate per repo', () => {
    const state = new ReviewTargetState();
    state.set('repo-a', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
    state.set('repo-b', { kind: 'commit', baseRef: '', headRef: SHA_B });
    expect(state.get('repo-a')?.headRef).toBe('feat/x');
    expect(state.get('repo-b')?.kind).toBe('commit');
    expect(state.get('repo-c')).toBeNull();
  });
});
```

- [ ] **Step 2: Run để fail** — `npx vitest run tests/extension/review-target.test.ts` → FAIL (module chưa tồn tại).

- [ ] **Step 3: Implement `src/extension/services/review-target.ts`**

```ts
import type { ReviewTargetKind } from './review-store';

/** git's well-known empty tree — the base a root commit diffs against. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface ReviewTarget {
  kind: ReviewTargetKind;
  /** Branch name or sha. Empty for kind 'commit' — the base is computed. */
  baseRef: string;
  headRef: string;
  subject?: string;
}

export interface ResolvedTarget {
  kind: ReviewTargetKind;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  subject?: string;
}

export interface TargetGit {
  revParse(ref: string): Promise<string>;
  getParents(hash: string): Promise<string[]>;
  log(options: { revisions: string[]; maxCount: number }): Promise<{ subject: string }[]>;
}

async function revParseNamed(git: TargetGit, ref: string): Promise<string> {
  try {
    return await git.revParse(ref);
  } catch {
    // The original git error names neither the ref nor the operation the user
    // attempted; the row this surfaces on must say which ref went stale.
    throw new Error(`Cannot resolve "${ref}" — it may have been deleted or garbage-collected`);
  }
}

/**
 * Turns a user-facing target into the sha pair a review runs on. For a commit
 * the base is derived, never supplied: first parent, or the empty tree for a
 * root commit. A merge commit reviews against its first parent — the change it
 * brought into the mainline — and says so in the subject.
 */
export async function resolveReviewTarget(git: TargetGit, target: ReviewTarget): Promise<ResolvedTarget> {
  const headSha = await revParseNamed(git, target.headRef);

  if (target.kind === 'commit') {
    const parents = await git.getParents(headSha);
    const baseSha = parents[0] ?? EMPTY_TREE_SHA;
    let subject = target.subject
      ?? (await git.log({ revisions: [headSha], maxCount: 1 }).catch(() => []))[0]?.subject;
    if (subject && parents.length > 1 && !subject.endsWith('(merge)')) subject = `${subject} (merge)`;
    return {
      kind: 'commit', baseRef: baseSha, baseSha, headRef: headSha, headSha,
      ...(subject ? { subject } : {}),
    };
  }

  const baseSha = await revParseNamed(git, target.baseRef);
  return {
    kind: target.kind, baseRef: target.baseRef, baseSha,
    headRef: target.headRef, headSha,
    ...(target.subject ? { subject: target.subject } : {}),
  };
}

/**
 * The compare pair currently on the pickers. Host-owned and in-memory: a
 * webview rebuilt by hide/show asks for it back; a new window starts fresh by
 * design.
 */
export class ReviewTargetState {
  private readonly targets = new Map<string, ReviewTarget>();

  public set(repoId: string, target: ReviewTarget): void {
    this.targets.set(repoId, target);
  }

  public get(repoId: string): ReviewTarget | null {
    return this.targets.get(repoId) ?? null;
  }
}
```

- [ ] **Step 4: Run pass** — `npx vitest run tests/extension/review-target.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: review target resolution with per-repo target state"`

### Task 3: `RouterRegistry` — broadcast event tới mọi webview

**Files:**
- Create: `src/extension/controllers/router-registry.ts`
- Modify: `src/extension/extension.ts` (khai báo registry, attach trong `createSession`, broadcast trong `reviewRunner` onChange)
- Test: `tests/extension/router-registry.test.ts`

**Interfaces:**
- Produces: `class RouterRegistry { attach(router: { sendEvent(e: string, d?: unknown): void }): () => void; broadcast(event: string, data?: unknown): void }`

- [ ] **Step 1: Failing test `tests/extension/router-registry.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { RouterRegistry } from '../../src/extension/controllers/router-registry';

describe('RouterRegistry', () => {
  it('broadcasts to every attached router', () => {
    const registry = new RouterRegistry();
    const a = { sendEvent: vi.fn() };
    const b = { sendEvent: vi.fn() };
    registry.attach(a);
    registry.attach(b);

    registry.broadcast('review.changed', { id: 'x' });

    expect(a.sendEvent).toHaveBeenCalledWith('review.changed', { id: 'x' });
    expect(b.sendEvent).toHaveBeenCalledWith('review.changed', { id: 'x' });
  });

  it('stops sending to a detached router', () => {
    const registry = new RouterRegistry();
    const a = { sendEvent: vi.fn() };
    const detach = registry.attach(a);
    detach();

    registry.broadcast('review.changed');

    expect(a.sendEvent).not.toHaveBeenCalled();
  });

  it('detaching twice is harmless', () => {
    const registry = new RouterRegistry();
    const detach = registry.attach({ sendEvent: vi.fn() });
    detach();
    expect(() => detach()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run fail**, rồi implement:

```ts
interface EventSender {
  sendEvent(event: string, data?: unknown): void;
}

/**
 * Events like review.changed concern every attached webview (graph and the
 * review tab), not just whichever one happened to be created last. The host
 * broadcasts; each router delivers to its own webview.
 */
export class RouterRegistry {
  private readonly routers = new Set<EventSender>();

  public attach(router: EventSender): () => void {
    this.routers.add(router);
    return () => { this.routers.delete(router); };
  }

  public broadcast(event: string, data?: unknown): void {
    for (const router of this.routers) router.sendEvent(event, data);
  }
}
```

- [ ] **Step 3: Wire vào `extension.ts`**
  - Sau khai báo `activeRouter`: `const routers = new RouterRegistry();` (import từ `./controllers/router-registry`).
  - `reviewRunner` onChange: thay `activeRouter?.sendEvent('review.changed', { id })` bằng `routers.broadcast('review.changed', { id })` (giữ `reviewTree?.refresh()` và `syncTicker` cho tới Task 7).
  - Trong `createSession`: sau `activeRouter = router;` thêm `const detachRouter = routers.attach(router);`; trong `dispose` thêm `detachRouter();` trước `router.dispose()`.

- [ ] **Step 4: Run** — `npx vitest run tests/extension && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: broadcast host events to every attached webview router"`

### Task 4: Handler tổng quát hoá — `review.start` theo kind, `setTarget`/`getTarget`, `rerun`, `compare`

**Files:**
- Modify: `src/extension/controllers/review-method-handler.ts`
- Modify: `src/extension/extension.ts` (deps mới cho `reviewHandler`; khối rerun của `registerReviewView` gọi `review.rerun`)
- Modify: `src/webview/App.svelte:1306` (`handleAIReview` gửi wire mới)
- Modify: `src/webview/components/review/AIReviewPanel.svelte` (dispatch `review` — chỉ đổi tên field trong `handleReview`)
- Test: `tests/extension/review-namespace.test.ts`

**Interfaces:**
- Consumes: `resolveReviewTarget`, `ReviewTargetState`, `ReviewTarget` (Task 2); `RouterRegistry.broadcast` (Task 3).
- Produces — wire protocol mới (mọi task webview sau dùng đúng bộ này):
  - `review.start { kind?, baseRef?, headRef, provider, model }` → `{ id, cached }` (kind mặc định `'branch'`)
  - `review.setTarget { kind, baseRef?, headRef }` → `{ success: true }`; side effects: lưu state, focus view, broadcast event `review.target` với data `ReviewTarget`
  - `review.getTarget {}` → `ReviewTarget | null`
  - `review.rerun { id }` → như `review.start`
  - `review.compare { kind?, baseRef?, headRef }` → `{ files: FileChange[] }`
  - Deps mới của `createReviewHandler`: `targets: ReviewTargetState; focusReviewView: () => Promise<void>; broadcast: (event: string, data?: unknown) => void;` và `GitLike` thêm `getParents(hash: string): Promise<string[]>`.

- [ ] **Step 1: Failing tests — thêm vào `tests/extension/review-namespace.test.ts`**

Trong `harness()`: thêm vào `git` mock `getParents: vi.fn(async () => ['c'.repeat(40)])`; thêm deps mặc định:

```ts
const targets = new ReviewTargetState();
const focusReviewView = vi.fn(async () => {});
const broadcast = vi.fn();
// ...vào createReviewHandler: targets, focusReviewView, broadcast,
// ...vào return của harness: targets, focusReviewView, broadcast
```

(import `ReviewTargetState` từ `../../src/extension/services/review-target`.)

Sửa các test `review.start` hiện có sang wire mới: `{ kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider, model }` (hành vi giữ nguyên). Thêm test mới:

```ts
it('accepts legacy sourceBranch params for one release of compatibility', async () => {
  const { handler, runner } = harness();
  const result = await handler('review.start', {
    sourceBranch: 'main', targetBranch: 'feat/x', provider: 'claude', model: 'sonnet',
  });
  expect(result).toEqual({ id: 'new-id', cached: false });
  expect(runner.start).toHaveBeenCalledOnce();
});

it('reviews a single commit against its first parent', async () => {
  const { handler, runner, git } = harness();
  git.log.mockResolvedValue([{ subject: 'fix: y' }] as never);

  await handler('review.start', { kind: 'commit', headRef: 'b'.repeat(40), provider: 'claude', model: '' });

  const input = runner.start.mock.calls[0][0] as Record<string, unknown>;
  expect(input.kind).toBe('commit');
  expect(input.baseSha).toBe('c'.repeat(40));
  expect(input.subject).toBe('fix: y');
  // diff chạy trên cặp đã resolve
  expect(git.getDiff).toHaveBeenCalledWith('c'.repeat(40), 'b'.repeat(40));
});

it('setTarget stores, focuses the review view, and broadcasts', async () => {
  const { handler, targets, focusReviewView, broadcast } = harness();

  await handler('review.setTarget', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });

  expect(targets.get('repo-a')).toMatchObject({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
  expect(focusReviewView).toHaveBeenCalledOnce();
  expect(broadcast).toHaveBeenCalledWith('review.target',
    expect.objectContaining({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' }));
});

it('setTarget with a dead ref rejects with the ref name and stores nothing', async () => {
  const { handler, targets, git } = harness();
  git.revParse.mockRejectedValue(new Error('unknown revision'));

  await expect(handler('review.setTarget', { kind: 'branch', baseRef: 'gone', headRef: 'feat/x' }))
    .rejects.toThrow(/"/);
  expect(targets.get('repo-a')).toBeNull();
});

it('getTarget returns what setTarget stored, null before that', async () => {
  const { handler } = harness();
  expect(await handler('review.getTarget', {})).toBeNull();
  await handler('review.setTarget', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });
  expect(await handler('review.getTarget', {})).toMatchObject({ headRef: 'feat/x' });
});

it('rerun removes the entry and starts again from its stored target', async () => {
  const { handler, store, runner } = harness();
  store.get.mockResolvedValueOnce({
    id: 'old-id', kind: 'branch', baseRef: 'main', baseSha: 'a'.repeat(40),
    headRef: 'feat/x', headSha: 'b'.repeat(40), provider: 'claude', model: 'sonnet',
    status: 'failed', startedAt: '2026-08-01T00:00:00.000Z',
  } as never);

  const result = await handler('review.rerun', { id: 'old-id' });

  expect(store.remove).toHaveBeenCalledWith('repo-a', 'old-id');
  expect(runner.start).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ cached: false });
});

it('compare resolves the target and returns the changed files', async () => {
  const { handler, git } = harness();
  git.diff.mockResolvedValue({ files: [{ path: 'a.ts' }] } as never);

  const result = await handler('review.compare', { kind: 'branch', baseRef: 'main', headRef: 'feat/x' });

  expect(result).toEqual({ files: [{ path: 'a.ts' }] });
  expect(git.diff).toHaveBeenCalledWith('main', 'feat/x');
});
```

- [ ] **Step 2: Run fail** — `npx vitest run tests/extension/review-namespace.test.ts`.

- [ ] **Step 3: Implement handler**

Đầu file:

```ts
import { resolveReviewTarget } from '../services/review-target';
import type { ReviewTarget, ReviewTargetState } from '../services/review-target';
import type { ReviewTargetKind } from '../services/review-store';
```

`GitLike` thêm `getParents(hash: string): Promise<string[]>`. `ReviewHandlerDeps` thêm:

```ts
targets: ReviewTargetState;
focusReviewView: () => Promise<void>;
broadcast: (event: string, data?: unknown) => void;
```

Helper trong `createReviewHandler` (trên `handle`):

```ts
// Wire được nhận cả dạng mới lẫn dạng cũ (sourceBranch/targetBranch) trong
// một nhịp chuyển tiếp — graph webview cũ vẫn chạy được trước Task 10.
function targetFromParams(p: Record<string, unknown>): ReviewTarget {
  const kind = (p.kind as ReviewTargetKind) ?? 'branch';
  const baseRef = (p.baseRef as string) ?? (p.sourceBranch as string) ?? '';
  const headRef = (p.headRef as string) ?? (p.targetBranch as string);
  if (typeof headRef !== 'string' || !headRef) throw new Error('Missing head ref');
  if (kind !== 'commit' && !baseRef) throw new Error('Missing base ref');
  return { kind, baseRef, headRef };
}
```

Case `review.start` viết lại:

```ts
case 'review.start': {
  const git = deps.getGitService();
  if (!git) throw new Error('No git repository found');
  const provider = p.provider as string;
  const model = (p.model as string) || '';

  const resolved = await resolveReviewTarget(git, targetFromParams(p));

  const id = buildReviewId({ baseSha: resolved.baseSha, headSha: resolved.headSha, provider, model });
  const existing = await deps.store.get(repoId, id);
  if (existing?.status === 'done') {
    await deps.openBody(repoId, id);
    return { id, cached: true };
  }
  if (existing?.status === 'running' && deps.runner.isRunning(id)) {
    return { id, cached: false };
  }

  const diff = await git.getDiff(resolved.baseRef, resolved.headRef);
  if (!diff.trim()) {
    throw new Error(`No differences between ${resolved.baseRef} and ${resolved.headRef}`);
  }

  const [changed, commits] = await Promise.all([
    git.diff(resolved.baseRef, resolved.headRef).then(d => d.files).catch(() => undefined),
    resolved.kind === 'commit'
      ? Promise.resolve(resolved.subject ? [resolved.subject] : undefined)
      : git.log({ revisions: [`${resolved.baseRef}..${resolved.headRef}`], maxCount: 100 })
          .then(cs => cs.map(c => c.subject))
          .catch(() => undefined),
  ]);

  const payload = buildReviewPayload({
    baseBranch: resolved.baseRef,
    headBranch: resolved.headRef,
    diff,
    files: changed as never,
    commits,
    budget: deps.getMaxDiffChars(),
  });

  const startedId = await deps.runner.start({
    repoId,
    kind: resolved.kind,
    baseRef: resolved.baseRef, baseSha: resolved.baseSha,
    headRef: resolved.headRef, headSha: resolved.headSha,
    ...(resolved.subject ? { subject: resolved.subject } : {}),
    provider, model,
    payloadText: payload.text,
  });
  return { id: startedId, cached: false };
}
```

Case mới (trước `default`):

```ts
case 'review.setTarget': {
  const git = deps.getGitService();
  if (!git) throw new Error('No git repository found');
  const resolved = await resolveReviewTarget(git, targetFromParams(p));
  const stored: ReviewTarget = {
    kind: resolved.kind,
    baseRef: resolved.baseRef,
    headRef: resolved.headRef,
    ...(resolved.subject ? { subject: resolved.subject } : {}),
  };
  deps.targets.set(repoId, stored);
  await deps.focusReviewView();
  deps.broadcast('review.target', stored);
  return { success: true };
}

case 'review.getTarget':
  return deps.targets.get(repoId);

case 'review.rerun': {
  const id = assertSafeReviewId(p.id);
  const entry = await deps.store.get(repoId, id);
  if (!entry) throw new Error(`No review with id ${id}`);
  await deps.store.remove(repoId, id);
  return handle('review.start', {
    kind: entry.kind,
    // kind 'commit' tự tính lại base; kind khác dùng ref đã lưu
    ...(entry.kind === 'commit' ? {} : { baseRef: entry.baseRef }),
    headRef: entry.headRef,
    provider: entry.provider,
    model: entry.model === 'default' ? '' : entry.model,
  });
}

case 'review.compare': {
  const git = deps.getGitService();
  if (!git) throw new Error('No git repository found');
  const resolved = await resolveReviewTarget(git, targetFromParams(p));
  const result = await git.diff(resolved.baseRef, resolved.headRef);
  return { files: result.files };
}
```

(`handle` phải là named function — nó đã là `async function handle(...)` — để `review.rerun` tự gọi lại.)

- [ ] **Step 4: Wire deps trong `extension.ts`**

```ts
const { ReviewTargetState } = await import('./services/review-target');
// ... cạnh các dynamic import sẵn có

const reviewTargets = new ReviewTargetState();
const reviewHandler = createReviewHandler({
  // ...deps sẵn có...
  targets: reviewTargets,
  focusReviewView: async () => {
    await vscode.commands.executeCommand('gitGraphPro.reviews.focus');
  },
  broadcast: (event, data) => routers.broadcast(event, data),
});
```

Khối `rerun` trong `registerReviewView` thay bằng:

```ts
rerun: async (entry) => { await reviewHandler('review.rerun', { id: entry.id }); },
```

(bỏ cả đoạn getRepoId/try-catch cũ trong callback đó — handler tự resolve repo và tự báo lỗi; bọc `try { ... } catch (error) { console.error(...) }` như cũ để click không thành unhandled rejection.)

- [ ] **Step 5: Cập nhật webview sender** — `App.svelte` `handleAIReview`: `bridge.send('review.start', { kind: 'branch', baseRef: sourceBranch, headRef: targetBranch, provider, model })`. (`AIReviewPanel` dispatch giữ tên event field `sourceBranch/targetBranch` nội bộ — chỉ chỗ send đổi.)

- [ ] **Step 6: Run** — `npx vitest run tests/extension tests/webview && npm run typecheck` → PASS (test webview `app-review-jobs` vẫn pass vì handler nhận cả wire cũ; nếu nó assert đúng params gửi đi thì cập nhật expectation sang wire mới).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: kind-aware review.start with setTarget/getTarget/rerun/compare methods"`

**Nghiệm thu Phase 1:** `npm run check` xanh. Đây là điểm ship độc lập thứ nhất.

---

## Phase 2 — Tab Code Review webview

### Task 5: Tổng quát hoá `GitGraphWebviewProvider` cho 2 app

**Files:**
- Modify: `src/extension/providers/webview-provider.ts`
- Test: `tests/extension/webview-provider.test.ts`

**Interfaces:**
- Produces: constructor thứ 3 tuỳ chọn `spec: { asset: 'main' | 'review'; title: string }` mặc định `{ asset: 'main', title: 'Git Graph Pro' }`. HTML tham chiếu `dist/webview/assets/${asset}.js` và `.css`, `<title>` = title. `static viewType` giữ nguyên cho graph.

- [ ] **Step 1: Failing test — thêm vào `tests/extension/webview-provider.test.ts`** (dùng đúng harness/mocks sẵn có của file; test hiện có đã render html và assert `main.js`):

```ts
it('renders the review asset when constructed for the review app', () => {
  const provider = new GitGraphWebviewProvider(
    extensionUri as never,
    () => () => {},
    { asset: 'review', title: 'Code Review' },
  );
  const view = makeView(); // helper sẵn có của file
  provider.resolveWebviewView(view as never);

  expect(view.webview.html).toContain('assets/review.js');
  expect(view.webview.html).toContain('assets/review.css');
  expect(view.webview.html).toContain('<title>Code Review</title>');
  expect(view.webview.html).not.toContain('assets/main.js');
});
```

- [ ] **Step 2: Run fail, rồi implement**

```ts
export interface WebviewAppSpec {
  asset: 'main' | 'review';
  title: string;
}

// constructor:
constructor(
  private readonly extensionUri: vscode.Uri,
  private readonly createSession: CreateSession,
  private readonly spec: WebviewAppSpec = { asset: 'main', title: 'Git Graph Pro' },
) {}
```

Trong `getHtmlContent`: `assets/${this.spec.asset}.js`, `assets/${this.spec.asset}.css`, `<title>${this.spec.title}</title>`.

- [ ] **Step 3: Run pass** — `npx vitest run tests/extension/webview-provider.test.ts`.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: webview provider serves either the graph or the review bundle"`

### Task 6: Tách `ui.compareDiff` thành `services/compare-diff.ts`

Cả graph session lẫn review session (Task 7) đều cần mở diff editor cho một file giữa 2 ref. Logic hiện nằm inline trong `extension.ts` (case `'ui.compareDiff'`, ~dòng 337-390).

**Files:**
- Create: `src/extension/services/compare-diff.ts`
- Modify: `src/extension/extension.ts` (case `'ui.compareDiff'` delegate; thêm helper `compareDiffDeps`)
- Test: `tests/extension/compare-diff.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CompareDiffParams {
  path: string;
  oldPath?: string | null;
  sourceBranch: string; // wire name giữ nguyên — webview gửi sourceBranch/targetBranch
  targetBranch: string;
  status?: string;
}
export interface CompareDiffDeps {
  git: {
    showFile(ref: string, path: string): Promise<string | null>;
    branches(): Promise<{ name: string; current?: boolean }[]>;
    getRepoPath(): string;
  };
  setContent(uriKey: string, content: string): void;
  virtualUri(path: string, query: string): { toString(): string };
  fileUri(repoPath: string, path: string): unknown;
  executeDiff(left: unknown, right: unknown, title: string): Promise<void>;
  nextTag(): string; // "ts=..&session=..&request=.." — caller sở hữu counter
}
export function openCompareDiff(deps: CompareDiffDeps, params: CompareDiffParams): Promise<{ success: true }>;
```

- [ ] **Step 1: Failing test `tests/extension/compare-diff.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { openCompareDiff } from '../../src/extension/services/compare-diff';

function harness(over: Record<string, unknown> = {}) {
  const contents = new Map<string, string>();
  const executeDiff = vi.fn(async () => {});
  const deps = {
    git: {
      showFile: vi.fn(async (ref: string) => `content@${ref}`),
      branches: vi.fn(async () => [{ name: 'feat/x', current: true }]),
      getRepoPath: () => '/repo',
    },
    setContent: (key: string, content: string) => { contents.set(key, content); },
    virtualUri: (path: string, query: string) => ({ toString: () => `virt:${path}?${query}` }),
    fileUri: (repoPath: string, path: string) => `file:${repoPath}/${path}`,
    executeDiff,
    nextTag: () => 'ts=1&session=1&request=1',
    ...over,
  };
  return { deps, contents, executeDiff };
}

describe('openCompareDiff', () => {
  it('diffs base content against the working file when head is checked out', async () => {
    const { deps, executeDiff, contents } = harness();

    await openCompareDiff(deps as never, {
      path: 'src/a.ts', oldPath: null, sourceBranch: 'main', targetBranch: 'feat/x', status: 'modified',
    });

    const [left, right, title] = executeDiff.mock.calls[0];
    expect(String(left)).toContain('side=base');
    expect(right).toBe('file:/repo/src/a.ts');
    expect(title).toBe('a.ts (main → feat/x)');
    expect(contents.get(String(left))).toBe('content@main');
  });

  it('uses a virtual head uri when head is not the checked-out branch', async () => {
    const { deps, executeDiff } = harness({
      git: {
        showFile: vi.fn(async (ref: string) => `content@${ref}`),
        branches: vi.fn(async () => [{ name: 'other', current: true }]),
        getRepoPath: () => '/repo',
      },
    });

    await openCompareDiff(deps as never, {
      path: 'src/a.ts', sourceBranch: 'main', targetBranch: 'feat/x',
    });

    const [, right] = executeDiff.mock.calls[0];
    expect(String(right)).toContain('side=head');
  });

  it('skips base content for an added file and titles it as added', async () => {
    const { deps, executeDiff, contents } = harness();

    await openCompareDiff(deps as never, {
      path: 'src/new.ts', sourceBranch: 'main', targetBranch: 'feat/x', status: 'added',
    });

    const [left, , title] = executeDiff.mock.calls[0];
    expect(contents.get(String(left))).toBe('');
    expect(title).toBe('new.ts (added in feat/x)');
  });

  it('reads the old path on the base side of a rename', async () => {
    const showFile = vi.fn(async (_ref: string, path: string) => `content:${path}`);
    const { deps, contents, executeDiff } = harness({
      git: { showFile, branches: vi.fn(async () => [{ name: 'feat/x', current: true }]), getRepoPath: () => '/repo' },
    });

    await openCompareDiff(deps as never, {
      path: 'src/renamed.ts', oldPath: 'src/old.ts', sourceBranch: 'main', targetBranch: 'feat/x', status: 'renamed',
    });

    expect(showFile).toHaveBeenCalledWith('main', 'src/old.ts');
    const [left] = executeDiff.mock.calls[0];
    expect(contents.get(String(left))).toBe('content:src/old.ts');
  });
});
```

- [ ] **Step 2: Run fail, rồi implement `compare-diff.ts`** — chuyển nguyên văn logic từ `extension.ts` case `'ui.compareDiff'`, thay các thao tác vscode bằng deps:

```ts
export async function openCompareDiff(deps: CompareDiffDeps, params: CompareDiffParams): Promise<{ success: true }> {
  const { path: filePath, oldPath, sourceBranch: baseBranch, targetBranch: headBranch } = params;
  const status = params.status ?? 'modified';
  const tag = deps.nextTag();

  const baseContent = status !== 'added'
    ? await deps.git.showFile(baseBranch, oldPath ?? filePath) ?? ''
    : '';
  const baseUri = deps.virtualUri(oldPath ?? filePath, `ref=${baseBranch}&${tag}&side=base`);
  deps.setContent(baseUri.toString(), baseContent);

  const branchList = await deps.git.branches();
  const currentBranch = branchList.find(branch => branch.current)?.name;
  const headIsCheckedOut = !!currentBranch && currentBranch === headBranch;
  let headUri: unknown;
  if (headIsCheckedOut && status !== 'deleted') {
    headUri = deps.fileUri(deps.git.getRepoPath(), filePath);
  } else {
    const headContent = status !== 'deleted'
      ? await deps.git.showFile(headBranch, filePath) ?? ''
      : '';
    const virtualHead = deps.virtualUri(filePath, `ref=${headBranch}&${tag}&side=head`);
    deps.setContent(virtualHead.toString(), headContent);
    headUri = virtualHead;
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  let title: string;
  if (status === 'added') title = `${fileName} (added in ${headBranch})`;
  else if (status === 'deleted') title = `${fileName} (deleted in ${headBranch})`;
  else title = `${fileName} (${baseBranch} → ${headBranch})`;

  await deps.executeDiff(baseUri, headUri, title);
  return { success: true };
}
```

- [ ] **Step 3: Delegate trong `extension.ts`** — thêm helper cạnh `openBody`:

```ts
const makeCompareDiffDeps = (
  gitService: GitService,
  sessionTag: number,
  nextRequest: () => number,
): CompareDiffDeps => ({
  git: gitService,
  setContent: (key, content) => contentProvider.setContent(key, content),
  virtualUri: (path, query) => vscode.Uri.from({ scheme: GIT_GRAPH_SCHEME, path: `/${path}`, query }),
  fileUri: (repoPath, path) => vscode.Uri.joinPath(vscode.Uri.file(repoPath), path),
  executeDiff: async (left, right, title) => {
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  },
  nextTag: () => `ts=${Date.now()}&session=${sessionTag}&request=${nextRequest()}`,
});
```

Case `'ui.compareDiff'` trong graph session thay toàn bộ thân bằng:

```ts
case 'ui.compareDiff': {
  const gitService = session.getGitService();
  if (!gitService) throw new Error('No git repository found');
  return openCompareDiff(
    makeCompareDiffDeps(gitService, panelSessionId, () => ++virtualDocumentRequestSequence),
    p as never,
  );
}
```

(import `openCompareDiff`, `CompareDiffDeps` từ `./services/compare-diff`.)

- [ ] **Step 4: Run** — `npx vitest run tests/extension && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor: extract compare diff opening for reuse by the review webview"`

### Task 7: Review webview session + swap contributions + xoá TreeView

**Files:**
- Modify: `src/extension/extension.ts` (thêm `createReviewSession`, đăng ký provider thứ 2; XOÁ: import + dùng `ReviewTreeProvider`, `registerReviewView`, biến `reviewTree`, `syncTicker`, khối `tick`/interval, khối `registerReviewView({...})`)
- Modify: `package.json` (view webview; xoá 3 commands + menus)
- Delete: `src/extension/providers/review-tree-provider.ts`, `src/extension/providers/review-view-registration.ts`
- Delete: `tests/extension/review-tree-provider.test.ts`, `tests/extension/review-view-registration.test.ts`
- Modify: `tests/extension/review-contributions.test.ts`, `tests/extension/review-host-wiring.test.ts`

**Interfaces:**
- Consumes: `RouterRegistry` (Task 3), `reviewHandler` (Task 4), `WebviewAppSpec` (Task 5), `openCompareDiff`/`makeCompareDiffDeps` (Task 6).
- Produces: review webview nhận các method: `review.*` (toàn bộ), `ai.providers`, `git.branches`, `ui.getState`, `ui.setState`, `ui.compareDiff`. Task 8-9 chỉ được gọi đúng các method này.

- [ ] **Step 1: Sửa `package.json`**

`views.gitGraphProReview` thành:

```jsonc
"gitGraphProReview": [
  {
    "type": "webview",
    "id": "gitGraphPro.reviews",
    "name": "Reviews",
    "webviewOptions": { "retainContextWhenHidden": true }
  }
]
```

Xoá 3 entries `gitGraphPro.review.cancel/rerun/delete` khỏi `contributes.commands` và xoá toàn bộ block `menus["view/item/context"]` (3 items đó là nội dung duy nhất của nó).

- [ ] **Step 2: Viết lại `tests/extension/review-contributions.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';

const contributes = pkg.contributes as Record<string, never>;

describe('review contributions', () => {
  it('keeps the Code Review container in the bottom Panel', () => {
    const panel = (contributes.viewsContainers as unknown as { panel: { id: string; icon: string }[] }).panel;
    expect(panel.find(c => c.id === 'gitGraphProReview')).toBeDefined();
  });

  it('registers the reviews view as a webview that survives hiding', () => {
    const views = contributes.views as unknown as Record<string, {
      id: string; type?: string; webviewOptions?: { retainContextWhenHidden?: boolean };
    }[]>;
    const review = views.gitGraphProReview?.[0];

    expect(review?.id).toBe('gitGraphPro.reviews');
    expect(review?.type).toBe('webview');
    expect(review?.webviewOptions?.retainContextWhenHidden).toBe(true);
  });

  it('has no tree commands left — row actions live inside the webview', () => {
    const ids = (contributes.commands as unknown as { command: string }[]).map(c => c.command);
    expect(ids).not.toContain('gitGraphPro.review.cancel');
    expect(ids).not.toContain('gitGraphPro.review.rerun');
    expect(ids).not.toContain('gitGraphPro.review.delete');
    const menus = contributes.menus as unknown as Record<string, unknown> | undefined;
    expect(menus?.['view/item/context']).toBeUndefined();
  });
});
```

- [ ] **Step 3: `createReviewSession` trong `extension.ts`** (đặt cạnh `createSession`):

```ts
/**
 * The review tab's session. Deliberately thin: no RepositorySession, no file
 * watcher — the store and the target state live on the host and survive this
 * webview being rebuilt by hide/show. Every method resolves the repository
 * through activeRepo, same as the review handler.
 */
function createReviewSession(host: WebviewHost): () => void {
  const sessionTag = ++nextPanelSessionId;
  let requestSequence = 0;
  const router = new MessageRouter();
  const detachRouter = routers.attach(router);

  router.register('review', reviewHandler);

  router.register('ai', async (method: string) => {
    if (method === 'ai.providers') return aiReview.detectProviders();
    throw new Error(`Unknown method: ${method}`);
  });

  router.register('git', async (method: string) => {
    if (method === 'git.branches') {
      const gitService = activeRepo.getGitService();
      if (!gitService) throw new Error('No git repository found');
      return gitService.branches();
    }
    throw new Error(`Unknown method: ${method}`);
  });

  router.register('ui', async (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'ui.getState':
        return context.globalState.get(p.key as string) ?? null;
      case 'ui.setState':
        await context.globalState.update(p.key as string, p.value);
        return { success: true };
      case 'ui.compareDiff': {
        const gitService = activeRepo.getGitService();
        if (!gitService) throw new Error('No git repository found');
        return openCompareDiff(
          makeCompareDiffDeps(gitService as GitService, sessionTag, () => ++requestSequence),
          p as never,
        );
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  });

  router.setHost(host);

  const dispose = () => {
    detachRouter();
    router.dispose();
  };
  host.onDidDispose(dispose);
  return dispose;
}
```

Đăng ký sau khối đăng ký graph provider:

```ts
const reviewWebviewProvider = new GitGraphWebviewProvider(
  context.extensionUri,
  (host) => createReviewSession(host),
  { asset: 'review', title: 'Code Review' },
);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider('gitGraphPro.reviews', reviewWebviewProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  }),
);
```

- [ ] **Step 4: Xoá phần tree khỏi `extension.ts`** — xoá: dynamic import `ReviewTreeProvider` + `registerReviewView`; biến `reviewTree`, `syncTicker` và mọi tham chiếu (onChange của `reviewRunner` chỉ còn `routers.broadcast('review.changed', { id })`); khối `const treeProvider = ...` tới hết `registerReviewView({...})` (gồm cả `tick` interval và subscription dispose của nó). Xoá 2 file provider + 2 file test tương ứng.

- [ ] **Step 5: Cập nhật `tests/extension/review-host-wiring.test.ts`** — file này activate extension thật với vscode mock. Những chỗ phải đổi:
  - `createTreeView` mock không còn được gọi: xoá assertion nếu có; giữ mock trong `vi.mock('vscode')` cũng được (không hại).
  - Assertion về đăng ký view: `registerWebviewViewProvider` giờ được gọi 2 lần — một cho `gitGraphPro.graph`, một cho `gitGraphPro.reviews`. Thêm/chỉnh assertion:

```ts
const registered = hostMocks.registerWebviewViewProvider.mock.calls.map(c => c[0]);
expect(registered).toContain('gitGraphPro.reviews');
```

  - Test nào gọi command `gitGraphPro.review.rerun`/`cancel`/`delete` qua `registerCommand` mock: xoá — các đường đó nay đi qua `review.*` methods đã test ở `review-namespace.test.ts`.

- [ ] **Step 6: Run** — `npx vitest run tests/extension && npm run typecheck` → PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: review tab becomes a webview; retire the review tree view"`

### Task 8: Vite entry thứ 2 + `ReviewApp` skeleton

**Files:**
- Modify: `vite.config.ts`
- Create: `src/webview/review.html`, `src/webview/review-main.ts`, `src/webview/ReviewApp.svelte` (skeleton)
- Test: `tests/webview/review-app.test.ts` (skeleton render)

**Interfaces:**
- Consumes: wire protocol Task 4 + method roster Task 7.
- Produces: bundle `dist/webview/assets/review.js` + `review.css`; component `ReviewApp.svelte` mà Task 9 hoàn thiện.

- [ ] **Step 1: `vite.config.ts`** — input thành:

```ts
input: {
  main: resolve(__dirname, 'src/webview/index.html'),
  review: resolve(__dirname, 'src/webview/review.html'),
},
```

- [ ] **Step 2: `src/webview/review.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Review</title>
</head>
<body>
    <div id="app"></div>
    <script type="module" src="./review-main.ts"></script>
</body>
</html>
```

- [ ] **Step 3: `src/webview/review-main.ts`**

```ts
import ReviewApp from './ReviewApp.svelte';
import './styles/global.css';

const app = new ReviewApp({
  target: document.getElementById('app')!,
});

export default app;
```

- [ ] **Step 4: `ReviewApp.svelte` skeleton** — đủ để build và test smoke; Task 9 thay toàn bộ:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { bridge } from './lib/message-bridge';

  let ready = false;
  let error = '';

  onMount(async () => {
    try {
      await bridge.send('review.list');
      ready = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="review-app">
  <header class="toolbar" aria-label="Review toolbar">Code Review</header>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if ready}<p>ready</p>{/if}
</div>

<style>
  .review-app { height: 100%; display: flex; flex-direction: column; }
</style>
```

- [ ] **Step 5: Test smoke `tests/webview/review-app.test.ts`**

```ts
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import ReviewApp from '../../src/webview/ReviewApp.svelte';

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('ReviewApp skeleton', () => {
  it('mounts and reaches the host', async () => {
    send.mockResolvedValue([]);
    const { getByText } = render(ReviewApp);
    await waitFor(() => expect(getByText('ready')).toBeInTheDocument());
  });
});
```

- [ ] **Step 6: Run + build check**

Run: `npx vitest run tests/webview/review-app.test.ts && npm run build:webview && test -f dist/webview/assets/review.js && test -f dist/webview/assets/review.css && echo OK`
Expected: PASS + `OK`.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: second vite entry and ReviewApp skeleton for the review tab"`

### Task 9: `ReviewApp` hoàn chỉnh — picker, chip, compare, danh sách review

**Files:**
- Modify: `src/webview/ReviewApp.svelte` (thay toàn bộ skeleton)
- Test: `tests/webview/review-app.test.ts` (thay toàn bộ)

**Interfaces:**
- Consumes: `review.getTarget`, `review.list`, `review.compare`, `review.start`, `review.open`, `review.cancel { id }`, `review.delete { id }`, `review.rerun { id }`, `git.branches`, `ai.providers`, `ui.getState/setState` (keys `aiReview.provider`, `aiReview.model`), `ui.compareDiff { sourceBranch, targetBranch, path, oldPath, status }`; events `review.changed`, `review.target`.
- Produces: không — đây là lá cuối.

- [ ] **Step 1: Viết failing tests — thay toàn bộ `tests/webview/review-app.test.ts`**

```ts
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import ReviewApp from '../../src/webview/ReviewApp.svelte';

const SHA_B = 'b'.repeat(40);
const branches = [
  { name: 'main', current: false },
  { name: 'feat/x', current: true },
];
const doneEntry = {
  id: 'aaaaaaa..bbbbbbb.claude.default',
  kind: 'branch', baseRef: 'main', baseSha: 'a'.repeat(40),
  headRef: 'feat/x', headSha: SHA_B,
  provider: 'claude', model: 'default', status: 'done',
  startedAt: '2026-08-24T00:00:00.000Z', finishedAt: '2026-08-24T00:01:00.000Z',
};

function stub(overrides: Record<string, unknown> = {}) {
  send.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'git.branches': return branches;
      case 'ai.providers': return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      case 'ui.getState': return null;
      case 'ui.setState': return { success: true };
      case 'review.getTarget': return null;
      case 'review.list': return [];
      case 'review.compare': return { files: [
        { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 3, deletions: 1, binary: false },
      ] };
      case 'review.start': return { id: 'new-id', cached: false };
      default: return null;
    }
  });
}

function eventHandler(name: string): (data: unknown) => void {
  const call = on.mock.calls.find(c => c[0] === name);
  expect(call, `no listener for ${name}`).toBeDefined();
  return call![1] as (data: unknown) => void;
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); });

describe('ReviewApp', () => {
  it('defaults head to the current branch and base to main, then compares', async () => {
    stub();
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    const base = rendered.getByLabelText('Base branch') as HTMLSelectElement;
    const head = rendered.getByLabelText('Head branch') as HTMLSelectElement;
    expect(base.value).toBe('main');
    expect(head.value).toBe('feat/x');
    expect(send).toHaveBeenCalledWith('review.compare',
      expect.objectContaining({ kind: 'branch', baseRef: 'main', headRef: 'feat/x' }));
  });

  it('changing a picker re-compares with the new pair', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());
    send.mockClear();

    await fireEvent.change(rendered.getByLabelText('Base branch'), { target: { value: 'feat/x' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.compare',
      expect.objectContaining({ baseRef: 'feat/x' })));
  });

  it('clicking a changed file opens the diff editor', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    await fireEvent.click(rendered.getByText('src/a.ts'));

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.compareDiff', {
      sourceBranch: 'main', targetBranch: 'feat/x',
      path: 'src/a.ts', oldPath: null, status: 'modified',
    }));
  });

  it('Review button starts a review with the current target', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByText('src/a.ts')).toBeInTheDocument());

    await fireEvent.click(rendered.getByRole('button', { name: 'Review' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.start', {
      kind: 'branch', baseRef: 'main', headRef: 'feat/x', provider: 'claude', model: '',
    }));
  });

  it('a review.target event for a commit swaps the pickers for a chip', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());

    eventHandler('review.target')({
      kind: 'commit', baseRef: 'c'.repeat(40), headRef: SHA_B, subject: 'fix: y',
    });

    await waitFor(() => expect(rendered.getByText(`${SHA_B.slice(0, 7)} "fix: y"`)).toBeInTheDocument());
    expect(rendered.queryByLabelText('Base branch')).toBeNull();
    // ✕ quay về chế độ branch
    await fireEvent.click(rendered.getByRole('button', { name: 'Back to branch compare' }));
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());
  });

  it('renders review rows with kind-aware labels and a cancel button while running', async () => {
    stub({ 'review.list': [
      { ...doneEntry, id: 'r1', kind: 'commit', subject: 'fix: y', status: 'running', finishedAt: undefined },
      { ...doneEntry, id: 'r2', kind: 'range' },
    ] });
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByText(`${SHA_B.slice(0, 7)} "fix: y"`)).toBeInTheDocument());
    expect(rendered.getByText(`${'a'.repeat(7)}..${'b'.repeat(7)}`)).toBeInTheDocument();

    await fireEvent.click(rendered.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('review.cancel', { id: 'r1' }));
  });

  it('a review.changed event refreshes the list', async () => {
    stub();
    const rendered = render(ReviewApp);
    await waitFor(() => expect(rendered.getByLabelText('Base branch')).toBeInTheDocument());
    stub({ 'review.list': [doneEntry] });

    eventHandler('review.changed')({ id: doneEntry.id });

    await waitFor(() => expect(rendered.getByText('main ← feat/x')).toBeInTheDocument());
  });

  it('a failed compare shows the error instead of dying silently', async () => {
    stub();
    send.mockImplementation(async (method: string) => {
      if (method === 'review.compare') throw new Error('Cannot resolve "gone"');
      if (method === 'git.branches') return branches;
      if (method === 'ai.providers') return [{ id: 'claude', name: 'Claude', available: true, group: 'cli' }];
      if (method === 'review.list') return [];
      return null;
    });
    const rendered = render(ReviewApp);

    await waitFor(() => expect(rendered.getByRole('alert')).toHaveTextContent('Cannot resolve "gone"'));
  });
});
```

- [ ] **Step 2: Run fail** — `npx vitest run tests/webview/review-app.test.ts`.

- [ ] **Step 3: Implement `ReviewApp.svelte` đầy đủ**

```svelte
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { bridge } from './lib/message-bridge';
  import { LatestRequestGate, runLatestRequest } from './lib/latest-request';

  type ReviewTargetKind = 'branch' | 'commit' | 'range';
  type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

  interface Branch { name: string; current?: boolean }
  interface Provider { id: string; name: string; available: boolean; group: 'cli' | 'api' }
  interface FileChange {
    path: string; oldPath: string | null; status: string;
    additions: number; deletions: number; binary: boolean;
  }
  interface ReviewTarget { kind: ReviewTargetKind; baseRef: string; headRef: string; subject?: string }
  interface ReviewEntry {
    id: string; kind: ReviewTargetKind;
    baseRef: string; baseSha: string; headRef: string; headSha: string;
    subject?: string; provider: string; model: string; status: ReviewStatus;
    startedAt: string; finishedAt?: string; error?: string;
  }

  let branches: Branch[] = [];
  let providers: Provider[] = [];
  let reviews: ReviewEntry[] = [];
  let target: ReviewTarget = { kind: 'branch', baseRef: '', headRef: '' };
  let files: FileChange[] | null = null;
  let compareLoading = false;
  let selectedProvider = '';
  let modelInput = '';
  let error = '';
  let latestStartedId = '';
  let now = Date.now();

  const compareGate = new LatestRequestGate();
  const unsubscribers: Array<() => void> = [];

  onMount(() => {
    unsubscribers.push(bridge.on('review.changed', () => { void refreshReviews(); }));
    unsubscribers.push(bridge.on('review.target', (data) => {
      target = data as ReviewTarget;
      files = null;
      error = '';
      void compare();
    }));
    void init();
  });

  onDestroy(() => {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    if (ticker !== undefined) clearInterval(ticker);
  });

  async function init(): Promise<void> {
    try {
      const [branchList, providerList, savedProvider, savedModel, storedTarget] = await Promise.all([
        bridge.send('git.branches') as Promise<Branch[]>,
        bridge.send('ai.providers') as Promise<Provider[]>,
        bridge.send('ui.getState', { key: 'aiReview.provider' }) as Promise<string | null>,
        bridge.send('ui.getState', { key: 'aiReview.model' }) as Promise<string | null>,
        bridge.send('review.getTarget') as Promise<ReviewTarget | null>,
      ]);
      branches = branchList ?? [];
      providers = providerList ?? [];
      const available = providers.filter(p => p.available);
      selectedProvider = savedProvider && available.some(p => p.id === savedProvider)
        ? savedProvider
        : (available[0]?.id ?? '');
      modelInput = savedModel ?? '';
      target = storedTarget ?? defaultTarget();
      await refreshReviews();
      void compare();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function defaultTarget(): ReviewTarget {
    const head = branches.find(b => b.current)?.name ?? '';
    const base = ['main', 'master'].find(name =>
      name !== head && branches.some(b => b.name === name)) ?? '';
    return { kind: 'branch', baseRef: base, headRef: head };
  }

  async function refreshReviews(): Promise<void> {
    try {
      reviews = (await bridge.send('review.list') as ReviewEntry[]) ?? [];
    } catch {
      // Danh sách cũ trên màn hình vẫn đúng hơn là một danh sách trống.
    }
  }

  $: canCompare = !!target.headRef && !!target.baseRef;

  async function compare(): Promise<void> {
    if (!canCompare) { files = null; return; }
    compareLoading = true;
    try {
      await runLatestRequest(
        compareGate,
        () => bridge.send('review.compare', {
          kind: target.kind, baseRef: target.baseRef, headRef: target.headRef,
        }) as Promise<{ files: FileChange[] }>,
        (result) => { files = result.files; error = ''; },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      compareLoading = false;
    }
  }

  function setBranch(side: 'base' | 'head', name: string): void {
    target = side === 'base'
      ? { kind: 'branch', baseRef: name, headRef: target.headRef }
      : { kind: 'branch', baseRef: target.baseRef, headRef: name };
    files = null;
    void compare();
  }

  function swap(): void {
    target = { ...target, baseRef: target.headRef, headRef: target.baseRef };
    files = null;
    void compare();
  }

  function clearChip(): void {
    target = defaultTarget();
    files = null;
    error = '';
    void compare();
  }

  async function startReview(): Promise<void> {
    if (!canCompare || !selectedProvider) return;
    error = '';
    try {
      const started = await bridge.send('review.start', {
        kind: target.kind, baseRef: target.baseRef, headRef: target.headRef,
        provider: selectedProvider, model: modelInput,
      }) as { id: string };
      latestStartedId = started.id;
      await refreshReviews();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function saveSettings(): void {
    void bridge.send('ui.setState', { key: 'aiReview.provider', value: selectedProvider });
    void bridge.send('ui.setState', { key: 'aiReview.model', value: modelInput });
  }

  async function openFile(file: FileChange): Promise<void> {
    try {
      await bridge.send('ui.compareDiff', {
        sourceBranch: target.baseRef, targetBranch: target.headRef,
        path: file.path, oldPath: file.oldPath, status: file.status,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function rowAction(
    method: 'review.open' | 'review.cancel' | 'review.delete' | 'review.rerun',
    entry: ReviewEntry,
  ): Promise<void> {
    try {
      await bridge.send(method, { id: entry.id });
      if (method !== 'review.open') await refreshReviews();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function chipLabel(t: ReviewTarget): string {
    return t.kind === 'commit'
      ? `${t.headRef.slice(0, 7)}${t.subject ? ` "${t.subject}"` : ''}`
      : `${t.baseRef.slice(0, 7)}..${t.headRef.slice(0, 7)}`;
  }

  function entryLabel(entry: ReviewEntry): string {
    if (entry.kind === 'commit') {
      return `${entry.headSha.slice(0, 7)}${entry.subject ? ` "${entry.subject}"` : ''}`;
    }
    if (entry.kind === 'range') return `${entry.baseSha.slice(0, 7)}..${entry.headSha.slice(0, 7)}`;
    return `${entry.baseRef} ← ${entry.headRef}`;
  }

  function statusIcon(status: ReviewStatus): string {
    switch (status) {
      case 'running': return '⟳';
      case 'done': return '✓';
      case 'failed': return '✗';
      case 'cancelled': return '⊘';
      default: return '⚠';
    }
  }

  function timeLabel(entry: ReviewEntry): string {
    if (entry.status === 'running') {
      const seconds = Math.max(0, Math.floor((now - new Date(entry.startedAt).getTime()) / 1000));
      return seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
        : `${seconds}s`;
    }
    const ended = new Date(entry.finishedAt ?? entry.startedAt).getTime();
    const minutes = Math.floor((now - ended) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  }

  // Đồng hồ chỉ chạy khi có run đang chạy — không có interval mồ côi lúc im ắng.
  let ticker: ReturnType<typeof setInterval> | undefined;
  $: hasRunning = reviews.some(r => r.status === 'running');
  $: if (hasRunning && ticker === undefined) {
    ticker = setInterval(() => { now = Date.now(); }, 1000);
  } else if (!hasRunning && ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
    now = Date.now();
  }

  $: totalAdditions = files?.reduce((sum, f) => sum + f.additions, 0) ?? 0;
  $: totalDeletions = files?.reduce((sum, f) => sum + f.deletions, 0) ?? 0;
</script>

<div class="review-app">
  <header class="toolbar" aria-label="Review toolbar">
    {#if target.kind === 'branch'}
      <select aria-label="Base branch" value={target.baseRef}
        on:change={(e) => setBranch('base', e.currentTarget.value)}>
        <option value="" disabled>base…</option>
        {#each branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
      </select>
      <span class="arrow">←</span>
      <select aria-label="Head branch" value={target.headRef}
        on:change={(e) => setBranch('head', e.currentTarget.value)}>
        <option value="" disabled>head…</option>
        {#each branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
      </select>
      <button class="icon-btn" title="Swap base and head" aria-label="Swap base and head"
        on:click={swap} disabled={!canCompare}>⇄</button>
    {:else}
      <span class="chip">
        {chipLabel(target)}
        <button class="icon-btn" title="Back to branch compare" aria-label="Back to branch compare"
          on:click={clearChip}>✕</button>
      </span>
    {/if}
    <span class="spacer"></span>
    <select aria-label="Provider" bind:value={selectedProvider} on:change={saveSettings}>
      {#each providers as provider (provider.id)}
        <option value={provider.id} disabled={!provider.available}>{provider.name}</option>
      {/each}
    </select>
    <input aria-label="Model" placeholder="model (optional)"
      bind:value={modelInput} on:change={saveSettings} />
    <button class="review-btn" disabled={!canCompare || !selectedProvider} on:click={startReview}>
      Review
    </button>
  </header>

  {#if error}<div class="error" role="alert">{error}</div>{/if}

  <div class="body">
    <section class="pane files-pane" aria-label="Changed files">
      <h3>
        Changed files
        {#if files}
          ({files.length})
          <span class="add">+{totalAdditions}</span>
          <span class="del">−{totalDeletions}</span>
        {/if}
      </h3>
      {#if compareLoading}
        <p class="hint">Comparing…</p>
      {:else if !canCompare}
        <p class="hint">Pick a base and a head to compare.</p>
      {:else if files && files.length === 0}
        <p class="hint">No differences.</p>
      {:else if files}
        <ul>
          {#each files as file (file.path)}
            <li>
              <button class="file-row" on:click={() => openFile(file)}>
                <span class="path">{file.path}</span>
                {#if !file.binary}
                  <span class="add">+{file.additions}</span>
                  <span class="del">−{file.deletions}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="pane reviews-pane" aria-label="Reviews">
      <h3>Reviews</h3>
      {#if reviews.length === 0}
        <p class="hint">No reviews yet.</p>
      {/if}
      <ul>
        {#each reviews as entry (entry.id)}
          <li class="review-row" class:latest={entry.id === latestStartedId}>
            <button class="open" title="Open review" on:click={() => rowAction('review.open', entry)}>
              <span class="status status-{entry.status}">{statusIcon(entry.status)}</span>
              <span class="label">{entryLabel(entry)}</span>
              <span class="time">{timeLabel(entry)}</span>
            </button>
            {#if entry.status === 'running'}
              <button class="icon-btn" title="Cancel" aria-label="Cancel"
                on:click={() => rowAction('review.cancel', entry)}>✕</button>
            {:else}
              <button class="icon-btn" title="Re-run" aria-label="Re-run"
                on:click={() => rowAction('review.rerun', entry)}>↻</button>
              <button class="icon-btn" title="Delete" aria-label="Delete"
                on:click={() => rowAction('review.delete', entry)}>🗑</button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  </div>
</div>

<style>
  .review-app {
    height: 100%;
    display: flex;
    flex-direction: column;
    color: var(--vscode-foreground);
    font-size: 12px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    flex: none;
  }
  .toolbar select, .toolbar input {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 2px 4px;
    max-width: 180px;
  }
  .toolbar input { width: 140px; }
  .arrow { opacity: 0.7; }
  .spacer { flex: 1; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .icon-btn {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 2px;
  }
  .icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .icon-btn:disabled { opacity: 0.4; cursor: default; }
  .review-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    padding: 3px 12px;
    cursor: pointer;
  }
  .review-btn:disabled { opacity: 0.5; cursor: default; }
  .error {
    flex: none;
    padding: 4px 10px;
    color: var(--vscode-errorForeground);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  }
  .body { flex: 1; display: flex; min-height: 0; }
  .pane { flex: 1; min-width: 0; overflow-y: auto; padding: 6px 10px; }
  .files-pane { border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35)); }
  .pane h3 {
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
  }
  .pane ul { list-style: none; margin: 0; padding: 0; }
  .hint { opacity: 0.7; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .file-row, .review-row .open {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 3px 4px;
    border-radius: 3px;
    text-align: left;
  }
  .file-row:hover, .review-row .open:hover { background: var(--vscode-list-hoverBackground); }
  .file-row .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .review-row { display: flex; align-items: center; }
  .review-row .open { flex: 1; min-width: 0; }
  .review-row.latest { background: var(--vscode-list-inactiveSelectionBackground); border-radius: 3px; }
  .review-row .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .review-row .time { opacity: 0.7; flex: none; }
  .status { flex: none; width: 14px; text-align: center; }
  .status-running { color: var(--vscode-charts-blue, #3794ff); }
  .status-done { color: var(--vscode-charts-green, #89d185); }
  .status-failed { color: var(--vscode-errorForeground); }
  .status-cancelled, .status-interrupted { opacity: 0.7; }
</style>
```

- [ ] **Step 4: Run** — `npx vitest run tests/webview/review-app.test.ts` → PASS; rồi `npx vitest run tests && npm run typecheck` → PASS toàn bộ.
- [ ] **Step 5: Kiểm thủ công (F5)** — checklist spec mục 1-2, 6-8: picker mặc định; compare + mở diff + Review chạy; ẩn/hiện panel giữ state; cancel giết tiến trình (`ps` kiểm); reload cửa sổ còn danh sách, picker về mặc định.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: review tab workbench with pickers, compare list, and review rows"`

**Nghiệm thu Phase 2:** `npm run check` xanh + checklist thủ công trên. Ship độc lập được — right panel graph vẫn là launcher song song tới Phase 3.

---

## Phase 3 — Entry points từ graph + dọn right panel

### Task 10: 3 entry points trong graph webview

**Files:**
- Modify: `src/webview/App.svelte` — action `compareBranch` (~dòng 1257-1264), menu commit trong `handleRowContextMenu` (~dòng 617-631), switch commit trong `performContextMenuAction` (~dòng 1014), khai báo state (~dòng 205), markup commit-row (~dòng 1518-1528) + style
- Test: `tests/webview/app-review-jobs.test.ts` (viết lại — luồng cũ mở right panel sẽ chết ở Task 11)

**Interfaces:**
- Consumes: `review.setTarget` (Task 4).
- Produces: 3 action mới `reviewCommit`, `selectForCompare`, `compareWithSelected`; state `selectedForCompare: string | null`.

- [ ] **Step 1: Viết lại `tests/webview/app-review-jobs.test.ts`** — bỏ mô tả luồng right-panel cũ, thay bằng:

```ts
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { send, on } = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../../src/webview/lib/message-bridge', () => ({ bridge: { send, on } }));

import App from '../../src/webview/App.svelte';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const branches = [
  { name: 'main', current: true, hash: 'a'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
  { name: 'feature', current: false, hash: 'b'.repeat(40), remote: null, upstream: null, ahead: 0, behind: 0 },
];
const nodes = [
  { hash: SHA_1, abbreviatedHash: SHA_1.slice(0, 7), subject: 'first', author: 'a', authorEmail: '',
    authorDate: '2026-08-24T00:00:00.000Z', refs: [], row: 0, lane: 0, color: 0, parents: [] },
  { hash: SHA_2, abbreviatedHash: SHA_2.slice(0, 7), subject: 'second', author: 'a', authorEmail: '',
    authorDate: '2026-08-24T00:00:00.000Z', refs: [], row: 1, lane: 0, color: 0, parents: [] },
];

function stubApp() {
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
  send.mockImplementation(async (method: string) => {
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'repo', path: '/repo', active: true }] };
      case 'git.branches': return branches;
      case 'git.tags': case 'git.stashList': case 'git.worktreeList': case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'git.isOnCurrentBranch': return { onBranch: false };
      case 'graph.build': return { totalRows: 2, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes, edges: [], startRow: 0, endRow: 2, maxLane: 0, layoutVersion: 1 };
      case 'review.setTarget': return { success: true };
      default: return null;
    }
  });
}

afterEach(() => { cleanup(); send.mockReset(); on.mockClear(); vi.unstubAllGlobals(); });

async function contextMenuOnCommit(rendered: ReturnType<typeof render>, subject: string) {
  await waitFor(() => expect(rendered.getByText(subject)).toBeInTheDocument());
  await fireEvent.contextMenu(rendered.getByText(subject));
}

describe('review entry points from the graph', () => {
  it('branch context "Compare with..." sends review.setTarget with base=clicked, head=current', async () => {
    stubApp();
    const rendered = render(App);
    await waitFor(() => expect(rendered.getByRole('button', { name: 'feature' })).toBeInTheDocument());

    // Shift+F10 mở context menu qua bàn phím — pattern sẵn có của suite
    await fireEvent.keyDown(rendered.getByRole('button', { name: 'feature' }), { key: 'F10', shiftKey: true });
    await waitFor(() => expect(rendered.getByText('Compare with...')).toBeInTheDocument());
    await fireEvent.click(rendered.getByText('Compare with...'));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'branch', baseRef: 'feature', headRef: 'main',
    }));
  });

  it('"Review this commit" sends a commit target', async () => {
    stubApp();
    const rendered = render(App);
    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByText('Review this commit')).toBeInTheDocument());

    await fireEvent.click(rendered.getByText('Review this commit'));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'commit', headRef: SHA_1,
    }));
  });

  it('select-then-compare sends a range target and clears the selection', async () => {
    stubApp();
    const rendered = render(App);

    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByText('Select for compare')).toBeInTheDocument());
    await fireEvent.click(rendered.getByText('Select for compare'));

    await contextMenuOnCommit(rendered, 'second');
    const label = `Compare with selected ${SHA_1.slice(0, 7)}`;
    await waitFor(() => expect(rendered.getByText(label)).toBeInTheDocument());
    await fireEvent.click(rendered.getByText(label));

    await waitFor(() => expect(send).toHaveBeenCalledWith('review.setTarget', {
      kind: 'range', baseRef: SHA_1, headRef: SHA_2,
    }));

    // chọn xong thì marker được xoá: menu commit lại hiện "Select for compare"
    await contextMenuOnCommit(rendered, 'first');
    await waitFor(() => expect(rendered.getByText('Select for compare')).toBeInTheDocument());
  });
});
```

Lưu ý: nếu Shift+F10 không phải pattern của branch row (kiểm tra `tests/webview/app-sidebar-actions.test.ts` để lấy đúng cách mở context menu branch của suite này), dùng đúng pattern đó thay thế.

- [ ] **Step 2: Run fail** — `npx vitest run tests/webview/app-review-jobs.test.ts`.

- [ ] **Step 3: Implement trong `App.svelte`**

(a) State, cạnh `contextMenuTarget` (~dòng 205):

```ts
// Commit được đánh dấu bằng "Select for compare", chờ ghép cặp range.
// Chỉ bị thay khi chọn commit khác, bị xoá khi cặp đã gửi đi.
let selectedForCompare: string | null = null;
```

(b) Menu commit đơn (trong `handleRowContextMenu`, sau item `Copy SHA`):

```ts
{ label: '', action: '', divider: true },
{ label: 'Review this commit', action: 'reviewCommit' },
selectedForCompare && selectedForCompare !== hash
  ? { label: `Compare with selected ${selectedForCompare.slice(0, 7)}`, action: 'compareWithSelected' }
  : { label: 'Select for compare', action: 'selectForCompare' },
```

(c) Switch commit trong `performContextMenuAction` (thêm case trước `copySha`):

```ts
case 'reviewCommit':
  await bridge.send('review.setTarget', { kind: 'commit', headRef: hash });
  break;
case 'selectForCompare':
  selectedForCompare = hash;
  break;
case 'compareWithSelected':
  if (selectedForCompare) {
    await bridge.send('review.setTarget', { kind: 'range', baseRef: selectedForCompare, headRef: hash });
    selectedForCompare = null;
  }
  break;
```

Ba action này không refresh graph: thêm chúng vào điều kiện return cuối hàm — `return action !== 'copySha' && action !== 'copyShas' && action !== 'reviewCommit' && action !== 'selectForCompare' && action !== 'compareWithSelected';`

(d) Action `compareBranch` (case hiện có, ~dòng 1257) thay toàn bộ thân:

```ts
case 'compareBranch': {
  const currentBr = branches.find(b => b.current);
  let base = branchName;
  let head = currentBr?.name ?? '';
  if (!head || head === branchName) {
    // Right-click chính branch hiện tại: chọn base qua QuickPick, head = branch đó.
    const picked = await bridge.send('ui.pickBranch', {
      exclude: branchName, title: 'Compare with...', placeholder: 'Select the base branch',
    }) as string | null;
    if (!picked) break;
    base = picked;
    head = branchName;
  }
  await bridge.send('review.setTarget', { kind: 'branch', baseRef: base, headRef: head });
  break;
}
```

(e) Marker trên commit row (markup ~dòng 1521, cạnh `class:selected`):

```svelte
class:compare-selected={selectedForCompare === node.hash}
```

và style (khối `<style>` của App.svelte, cạnh style `.commit-row.selected`):

```css
.commit-row.compare-selected {
  outline: 1px dashed var(--vscode-focusBorder);
  outline-offset: -1px;
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/webview && npm run typecheck` → PASS.
- [ ] **Step 5: Kiểm thủ công (F5)** — checklist spec mục 3-5: cả 3 đường focus tab Code Review và điền đúng target/chip.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: graph context menus feed compare targets to the review tab"`

### Task 11: Dọn right panel — xoá AIReviewPanel, mode review, ai.compare

**Files:**
- Delete: `src/webview/components/review/AIReviewPanel.svelte`, `tests/webview/ai-review-panel.test.ts`
- Modify: `src/webview/App.svelte`
- Modify: `src/extension/extension.ts` (namespace `ai` của graph session)
- Modify: `src/webview/lib/message-bridge.ts` (UNBOUNDED list)
- Modify: `src/extension/controllers/review-method-handler.ts` (bỏ nhận wire cũ)
- Test: cập nhật test nào đang render right panel review

- [ ] **Step 1: Xoá khỏi `App.svelte`** (grep từng tên để chắc sạch):
  - import `AIReviewPanel` (dòng 18)
  - `rightPanelMode` (dòng 166) và mọi chỗ đọc/gán — right panel chỉ còn commit detail, title luôn `COMMIT`; khối `{#if rightPanelMode === 'review'}` trong markup (~dòng 1567-1589) thay bằng nội dung nhánh `:else` (chỉ `CommitDetail`)
  - listener `bridge.on('review.changed', ...)` (dòng 249)
  - state: `aiProviders`, `savedProvider`, `savedModel` + 3 lệnh load của chúng trong onMount (dòng 234-238); `compareSource`, `compareTarget`, `compareFiles`, `compareLoading`; `aiReviewLoading`, `aiReviewError`, `aiReviewJobId`
  - functions: `compareBranches()`, `handleAIReview()`, `handleCompareOpenDiff()`
  - case `'aiReview'` trong `performContextMenuAction` (đã unused)

- [ ] **Step 2: Xoá `ai.compare` khỏi graph session trong `extension.ts`** — namespace `ai` của graph session chỉ còn... không gì cả (graph không gọi `ai.providers` nữa sau Step 1): xoá luôn `router.register('ai', ...)` khỏi `createSession`. (`ai.providers` sống tiếp trong `createReviewSession`.)

- [ ] **Step 3: `message-bridge.ts`** — trong `UNBOUNDED_REQUEST_METHODS`: xoá `'ai.compare'`, thêm `'review.compare'` (giữ `'ai.providers'` — review tab dùng).

- [ ] **Step 4: Bỏ wire cũ trong handler** — trong `targetFromParams` (Task 4) xoá 2 fallback `p.sourceBranch`/`p.targetBranch`; xoá test `accepts legacy sourceBranch params` trong `review-namespace.test.ts`. Không còn sender nào dùng wire cũ.

- [ ] **Step 5: Quét test webview còn tham chiếu** — `grep -rn "AIReviewPanel\|ai.compare\|rightPanelMode\|aiReviewResult" tests/ src/` phải về 0 kết quả (ngoài file plan/spec). Test App nào stub `ai.compare`/`ai.providers` thì xoá dòng stub.

- [ ] **Step 6: Run** — `npx vitest run tests && npm run typecheck` → PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "refactor: retire the right-panel compare UI; the review tab owns compare"`

### Task 12: Nghiệm thu toàn cục

- [ ] **Step 1:** `npm run check` — test + coverage + typecheck + build, tất cả xanh.
- [ ] **Step 2: Kiểm thủ công (F5) — checklist đầy đủ từ spec:**
  1. Mở tab Code Review: picker mặc định head = branch hiện tại, base = main/master.
  2. Chọn 2 branch → file list; click file mở diff; Review → row running.
  3. Right-click branch trong graph → tab focus, picker điền đúng, compare tự chạy.
  4. Right-click commit → Review this commit → chip commit, diff đúng một commit.
  5. Select for compare + Compare with selected → chip range, diff đúng khoảng.
  6. Ẩn Panel rồi hiện lại: picker/chip/file list/danh sách review còn nguyên.
  7. Cancel run đang chạy từ nút inline: `ps` xác nhận tiến trình chết, row `cancelled`.
  8. Reload cửa sổ: danh sách review còn, picker về mặc định.
- [ ] **Step 3: Commit cuối nếu có sửa lặt vặt** — `git add -A && git commit -m "chore: final polish for review workbench"`

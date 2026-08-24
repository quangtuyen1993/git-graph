# Git Graph trong bottom Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển Git Graph Pro từ webview panel ở khu vực editor xuống bottom Panel của VS Code (một `WebviewView` duy nhất), và đổi cách mở submodule thành đổi repo qua dropdown kiểu GitLens.

**Architecture:** VS Code chỉ cho bottom Panel chứa `WebviewView` đăng ký tĩnh, mỗi view id đúng một instance — nên mô hình nhiều panel (1 root + N submodule) bị bỏ hẳn, thay bằng một session duy nhất có danh sách repo động. `MessageRouter` và hàm dựng session được tách khỏi type `vscode.WebviewPanel` qua interface `WebviewHost` mà cả `WebviewPanel` lẫn `WebviewView` đều thoả về structural typing, nên logic git/AI không phải sửa. Layout 3 cột giữ nguyên, thêm chế độ compact theo chiều cao cửa sổ.

**Tech Stack:** TypeScript, VS Code Extension API (`WebviewViewProvider`), Svelte 4 webview, Vitest + @testing-library/svelte, esbuild (host) + Vite (webview).

**Spec:** `docs/superpowers/specs/2026-08-24-git-graph-bottom-panel-design.md`

## Global Constraints

- Engine tối thiểu: `"vscode": "^1.85.0"` (`package.json`). Không dùng API mới hơn mốc này.
- `activationEvents` phải giữ nguyên `[]`. VS Code tự suy ra `onView:gitGraphPro.graph` từ contribution — **không** thêm `onStartupFinished`.
- View id là `gitGraphPro.graph`, view container id là `gitGraphPro`. Hai chuỗi này xuất hiện ở `package.json`, `webview-provider.ts` và command focus — phải khớp tuyệt đối.
- `retainContextWhenHidden: true` khai báo ở **cả hai** chỗ: `contributes.views[].webviewOptions` trong `package.json` và tham số thứ ba của `registerWebviewViewProvider`.
- Không đổi `ROW_HEIGHT` (32px ở `src/webview/lib/virtual-scroll.ts:1`). Ngoài phạm vi plan này.
- Sau mỗi task, `npm run check` (test + coverage + typecheck + build) phải xanh trước khi commit.
- Repo không có `@vscode/test-electron`; mọi test extension mock module `vscode`. Phần "view thật sự hiện ở bottom Panel" chỉ kiểm thủ công (Task 6).

---

## File Structure

**Sửa:**
- `src/extension/controllers/repository-session.ts` — danh sách repo từ tĩnh thành động; thêm `addRepository`; bỏ `allowRepositorySwitch`.
- `src/extension/providers/webview-provider.ts` — bỏ toàn bộ đường panel, chuyển thành `WebviewViewProvider`.
- `src/extension/controllers/message-router.ts` — `setPanel` → `setHost`.
- `src/extension/extension.ts` — `ui.openSubmodule` đổi ngữ nghĩa; đăng ký view provider; command focus.
- `src/webview/App.svelte` — dropdown gộp repo + submodule; theo dõi `window.innerHeight`; CSS compact.
- `src/webview/lib/panel-layout.ts` — thêm `calculateDensity`.
- `package.json` — contributions `viewsContainers.panel` + `views`.

**Tạo:**
- `src/extension/types/webview-host.types.ts` — interface `WebviewHost`.

**Test sửa:** `tests/extension/repository-session.test.ts`, `tests/extension/webview-provider.test.ts`, `tests/extension/extension-panel-session.test.ts`, `tests/extension/message-router.test.ts`, `tests/webview/app-toolbar.test.ts`, `tests/webview/app-panel-layout.test.ts`, `tests/webview/panel-layout.test.ts`, `tests/coverage-closure.test.ts`.

---

# PHASE 1 — Submodule chuyển sang repo-switch

Ship độc lập: sau phase này graph vẫn ở editor như cũ, chỉ đổi hành vi submodule.

---

### Task 1: Danh sách repo động trong `RepositorySession`

**Files:**
- Modify: `src/extension/controllers/repository-session.ts:1-90`
- Test: `tests/extension/repository-session.test.ts`

**Interfaces:**
- Consumes: `RepositoryInfo { name: string; path: string }` (đã có).
- Produces:
  - `RepositorySessionOptions` bỏ field `allowRepositorySwitch`, thêm `canonicalizePath?: (path: string) => Promise<string>`.
  - `RepositorySession.addRepository(repository: RepositoryInfo): Promise<RepositoryInfo>` — canonical hoá path, trả entry đã có nếu trùng, ngược lại thêm mới và trả entry mới (path đã canonical).
  - `repo.list` trả `{ repos: Array<RepositoryInfo & { active: boolean }> }` gồm cả repo được thêm động.

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `describe('RepositorySession', ...)` trong `tests/extension/repository-session.test.ts`:

```typescript
  it('adds repositories at runtime and deduplicates them by canonical path', async () => {
    const session = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }],
      createGitService: fakeGitServiceFactory,
      canonicalizePath: async (path) => (path === '/root/alias/sdk' ? '/root/packages/sdk' : path),
    });

    const added = await session.addRepository({ name: 'sdk', path: '/root/alias/sdk' });
    expect(added).toEqual({ name: 'sdk', path: '/root/packages/sdk' });

    const again = await session.addRepository({ name: 'sdk', path: '/root/packages/sdk' });
    expect(again).toBe(added);

    expect(await session.handleRepo('repo.list', {})).toEqual({
      repos: [
        { name: 'root', path: '/root', active: true },
        { name: 'sdk', path: '/root/packages/sdk', active: false },
      ],
    });

    await session.handleRepo('repo.switch', { path: '/root/packages/sdk' });

    expect(session.getCurrentRepository()?.path).toBe('/root/packages/sdk');
    expect(await session.handleGit('git.branches', {})).toEqual([{ name: '/root/packages/sdk' }]);
  });
```

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/extension/repository-session.test.ts`
Expected: FAIL — `session.addRepository is not a function`.

- [ ] **Step 3: Hiện thực**

Trong `src/extension/controllers/repository-session.ts`, thêm import ở đầu file:

```typescript
import { realpath } from 'fs/promises';
```

Thay khối `RepositorySessionOptions` + constructor + `handleRepo` bằng:

```typescript
export interface RepositorySessionOptions {
  initialRepository: RepositoryInfo | null;
  repositories: readonly RepositoryInfo[];
  createGitService?: (path: string) => GitService;
  canonicalizePath?: (path: string) => Promise<string>;
}

export class RepositorySession {
  private gitService: GitService | null;
  private currentRepository: RepositoryInfo | null;
  private readonly repositories: RepositoryInfo[];
  private readonly graphMethodHandler: GraphMethodHandler;
  private readonly createGitService: (path: string) => GitService;
  private readonly canonicalizePath: (path: string) => Promise<string>;

  constructor(options: RepositorySessionOptions) {
    this.createGitService = options.createGitService ?? ((path) => new GitService(path));
    this.canonicalizePath = options.canonicalizePath ?? realpath;
    this.repositories = [...options.repositories];
    this.currentRepository = options.initialRepository;
    this.gitService = this.currentRepository
      ? this.createGitService(this.currentRepository.path)
      : null;
    this.graphMethodHandler = new GraphMethodHandler(
      new GraphService(),
      () => this.gitService,
    );
  }

  /**
   * Makes a repository selectable without reopening anything. Submodules arrive
   * this way, so the path is canonicalised first: the same submodule reached
   * through a symlink must not enter the list twice.
   */
  public async addRepository(repository: RepositoryInfo): Promise<RepositoryInfo> {
    const canonicalPath = await this.canonicalizePath(repository.path);
    const existing = this.repositories.find((candidate) => candidate.path === canonicalPath);
    if (existing) return existing;

    const entry: RepositoryInfo = { name: repository.name, path: canonicalPath };
    this.repositories.push(entry);
    return entry;
  }
```

Trong `handleRepo`, đổi `this.options.repositories` thành `this.repositories` (2 chỗ: `repo.list` và `repo.switch`) và xoá khối kiểm tra:

```typescript
        if (!this.options.allowRepositorySwitch) {
          throw new Error('Cannot switch a fixed repository session');
        }

```

Các phương thức `getGitService`, `getCurrentRepository`, `handleGit`, `handleGraph`, `invalidate` giữ nguyên.

- [ ] **Step 4: Sửa hai test cũ đang truyền `allowRepositorySwitch`**

Trong `tests/extension/repository-session.test.ts`, test đầu tiên đổi tên và bỏ phần session cố định:

```typescript
  it('switches between configured repositories and rejects unknown paths', async () => {
    const root = new RepositorySession({
      initialRepository: { name: 'root', path: '/root' },
      repositories: [{ name: 'root', path: '/root' }, { name: 'other', path: '/other' }],
      createGitService: fakeGitServiceFactory,
    });

    expect(await root.handleGit('git.branches', {})).toEqual([{ name: '/root' }]);
    expect(await root.handleRepo('repo.list', {})).toEqual({
      repos: [
        { name: 'root', path: '/root', active: true },
        { name: 'other', path: '/other', active: false },
      ],
    });
    await expect(root.handleRepo('repo.switch', { path: '/unconfigured' }))
      .rejects.toThrow('Repo not found: /unconfigured');

    await root.handleRepo('repo.switch', { path: '/other' });

    expect(root.getCurrentRepository()?.path).toBe('/other');
    expect(await root.handleGit('git.branches', {})).toEqual([{ name: '/other' }]);
  });
```

Test thứ hai (`publishes graph windows only from the session that built them`) giữ nguyên cấu trúc, chỉ xoá hai dòng `allowRepositorySwitch: true,` và `allowRepositorySwitch: false,`.

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `npx vitest run tests/extension/repository-session.test.ts`
Expected: PASS — 3 test.

- [ ] **Step 6: Commit**

```bash
git add src/extension/controllers/repository-session.ts tests/extension/repository-session.test.ts
git commit -m "feat: let a repository session gain repositories at runtime"
```

---

### Task 2: `ui.openSubmodule` đổi repo thay vì mở panel mới

**Files:**
- Modify: `src/extension/extension.ts` (khối `repo` router, `ui.openSubmodule`, `createPanelSession`, `webviewProvider`)
- Modify: `src/extension/providers/webview-provider.ts`
- Test: `tests/extension/extension-panel-session.test.ts`, `tests/extension/webview-provider.test.ts`

**Interfaces:**
- Consumes: `RepositorySession.addRepository()` từ Task 1.
- Produces:
  - `ui.openSubmodule` trả `{ success: true, name: string, path: string }` (kết quả `repo.switch`) thay vì `{ success: true }`.
  - `CreatePanelSession` đổi thành `(panel: vscode.WebviewPanel) => void`; `PanelRequest` bị xoá.
  - `GitGraphWebviewProvider` chỉ còn `openPanel(): vscode.WebviewPanel`.

- [ ] **Step 1: Viết test thất bại**

Trong `tests/extension/extension-panel-session.test.ts`, thêm test (đặt cạnh các test `ui.*` đang có; dùng đúng helper dựng panel/session mà file đang dùng):

```typescript
  it('switches the session to a submodule instead of opening another panel', async () => {
    const panel = await activateAndOpenRoot();

    panel.receive({
      id: 'sub',
      type: 'request',
      method: 'ui.openSubmodule',
      params: { path: 'packages/sdk' },
    });

    const opened = await responseFor(panel, 'sub');
    expect(opened.result).toMatchObject({ success: true, name: 'sdk', path: '/real/sdk' });
    expect(hostMocks.createWebviewPanel).toHaveBeenCalledTimes(1);

    panel.receive({ id: 'list', type: 'request', method: 'repo.list', params: {} });

    const listed = await responseFor(panel, 'list');
    expect((listed.result as { repos: Array<{ name: string; path: string; active: boolean }> }).repos)
      .toContainEqual({ name: 'sdk', path: '/real/sdk', active: true });

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(2));
  });
```

Test này dựa trên helper sẵn có của file: `activateAndOpenRoot()`, `panel.receive()`, `responseFor()`. Mock mặc định trong `beforeEach` đã trả `resolveSubmodule` → `{ name: 'sdk', path: 'packages/sdk', absolutePath: '/real/sdk', state: 'clean' }`, và `vi.mock('fs/promises')` ở đầu file đã cho `realpath` trả về chính đường dẫn truyền vào — nên `addRepository` không chạm đĩa thật.

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/extension/extension-panel-session.test.ts`
Expected: FAIL — `ui.openSubmodule` vẫn gọi `openRepositoryPanel`, `createWebviewPanel` được gọi 2 lần và kết quả thiếu `name`/`path`.

- [ ] **Step 3: Gom việc đổi repo vào một chỗ trong `extension.ts`**

Thay khối `router.register('repo', ...)` hiện tại bằng:

```typescript
    /**
     * Every repository change goes through here: the switch itself, then the
     * watcher rebind. Queued, because two switches racing would leave the
     * watcher pointing at the loser's .git directory.
     */
    function queueRepositorySwitch(params: unknown): Promise<unknown> {
      const run = async () => {
        const result = await session.handleRepo('repo.switch', params);
        await bindGitWatcher();
        return result;
      };
      const result = repositorySwitchQueue.then(run, run);
      repositorySwitchQueue = result.then(() => undefined, () => undefined);
      return result;
    }

    router.register('repo', async (method: string, params: unknown) => {
      if (method === 'repo.switch') return queueRepositorySwitch(params);
      return session.handleRepo(method, params);
    });
```

- [ ] **Step 4: Đổi `ui.openSubmodule`**

Thay case `'ui.openSubmodule'` bằng:

```typescript
        case 'ui.openSubmodule': {
          const gitService = session.getGitService();
          if (!gitService) throw new Error('No git repository found');
          const submodule = await gitService.resolveSubmodule(p.path as string);
          const added = await session.addRepository({
            name: submodule.name,
            path: submodule.absolutePath,
          });
          return queueRepositorySwitch({ path: added.path });
        }
```

- [ ] **Step 5: Bỏ khái niệm nhiều panel**

Trong `src/extension/extension.ts`:
- Đổi chữ ký: `function createPanelSession(panel: vscode.WebviewPanel): void {` (bỏ tham số `request`).
- Thay khối tạo session bằng:

```typescript
    const session = new RepositorySession({
      initialRepository: repos[0] ?? null,
      repositories: repos,
    });
```

- Xoá import `type PanelRequest` khỏi dòng import `webview-provider`.
- Đổi khởi tạo provider thành:

```typescript
  webviewProvider = new GitGraphWebviewProvider(
    context.extensionUri,
    (panel) => createPanelSession(panel),
  );
```

Trong `src/extension/providers/webview-provider.ts`:
- Xoá `import { realpath } from 'fs/promises';`, `export type PanelRequest`, field `repositoryPanels`, method `openRepositoryPanel`, tham số constructor `canonicalizePath`.
- Đổi `export type CreatePanelSession = (panel: vscode.WebviewPanel) => void;`
- Trong `openPanel()`, đổi `this.createPanelSession(panel, { kind: 'root' })` thành `this.createPanelSession(panel)`.

- [ ] **Step 6: Rút gọn test provider cho đúng bề mặt còn lại**

Thay toàn bộ `describe('GitGraphWebviewProvider', ...)` trong `tests/extension/webview-provider.test.ts` bằng:

```typescript
describe('GitGraphWebviewProvider', () => {
  beforeEach(() => {
    vscodeMocks.createWebviewPanel.mockReset();
    vscodeMocks.createWebviewPanel.mockImplementation(() => createFakePanel());
  });

  it('reuses the single panel and rebuilds it after disposal', async () => {
    const createSession = vi.fn();
    const provider = new GitGraphWebviewProvider(
      { toString: () => '/extension' } as never,
      createSession,
    );

    const first = provider.openPanel() as unknown as FakePanel;
    const second = provider.openPanel() as unknown as FakePanel;

    expect(second).toBe(first);
    expect(first.reveal).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(first);
    expect(first.iconPath).toBeDefined();

    first.disposePanel();
    const rebuilt = provider.openPanel() as unknown as FakePanel;

    expect(rebuilt).not.toBe(first);
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 7: Chạy toàn bộ test**

Run: `npm run check`
Expected: PASS — không còn tham chiếu tới `openRepositoryPanel` hay `PanelRequest`.

- [ ] **Step 8: Commit**

```bash
git add src/extension/extension.ts src/extension/providers/webview-provider.ts tests/extension/extension-panel-session.test.ts tests/extension/webview-provider.test.ts
git commit -m "feat: open submodules by switching repository instead of spawning a panel"
```

---

### Task 3: Dropdown gộp repo và submodule

**Files:**
- Modify: `src/webview/App.svelte` (`switchRepo` ~285-306, `handleSidebarSubmoduleOpen` ~804, toolbar markup ~1268-1283)
- Test: `tests/webview/app-toolbar.test.ts`

**Interfaces:**
- Consumes: `ui.openSubmodule` trả `{ success, name, path }` (Task 2); `git.submoduleList` trả `Array<{ name, path, head, state }>` (không có `absolutePath` — webview không được biết đường dẫn tuyệt đối).
- Produces: `<select aria-label="Repository">` với hai `<optgroup>`: `Repositories` (value `repo:<absolutePath>`) và `Submodules` (value `submodule:<relativePath>`).

- [ ] **Step 1: Viết test thất bại**

Thêm vào `tests/webview/app-toolbar.test.ts`. Trước hết mở rộng `stubBridge()` để nhận override:

```typescript
function stubBridge(overrides: Record<string, unknown> = {}) {
  send.mockImplementation(async (method: string) => {
    if (method in overrides) return overrides[method];
    switch (method) {
      case 'ping.hello': return { ok: true };
      case 'repo.list': return { repos: [{ name: 'git-graph', path: '/repo', active: true }] };
      case 'git.branches': return [branch];
      case 'git.tags': return [];
      case 'git.stashList': return [];
      case 'git.worktreeList': return [];
      case 'git.submoduleList': return [];
      case 'git.status': return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      case 'graph.build': return { totalRows: 0, maxLane: 0, layoutVersion: 1 };
      case 'graph.getWindow': return { nodes: [], edges: [], startRow: 0, endRow: 0, maxLane: 0, layoutVersion: 1 };
      case 'ai.providers': return [];
      default: return null;
    }
  });
}
```

`renderApp()` đổi thành `async function renderApp(overrides: Record<string, unknown> = {})` và gọi `stubBridge(overrides)`.

Test mới:

```typescript
  it('offers submodules alongside repositories and opens them by switching', async () => {
    const { getByRole } = await renderApp({
      'git.submoduleList': [
        { name: 'sdk', path: 'packages/sdk', head: 'b'.repeat(40), state: 'initialized' },
        { name: 'legacy', path: 'vendor/legacy', head: null, state: 'uninitialized' },
      ],
    });

    const select = await waitFor(() => getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement);
    const values = Array.from(select.options).map((option) => option.value);

    expect(values).toEqual(['repo:/repo', 'submodule:packages/sdk']);

    await fireEvent.change(select, { target: { value: 'submodule:packages/sdk' } });

    await waitFor(() => expect(send).toHaveBeenCalledWith('ui.openSubmodule', { path: 'packages/sdk' }));
  });
```

Thêm `fireEvent` vào import `@testing-library/svelte` ở đầu file nếu chưa có.

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/webview/app-toolbar.test.ts`
Expected: FAIL — không tìm thấy combobox `Repository` (chỉ có 1 repo nên `<select>` chưa render).

- [ ] **Step 3: Gom việc đổi repo trong App.svelte**

Thay `switchRepo` (dòng ~285-306) bằng:

```typescript
  /**
   * One reset path for every repository change. The repo list is re-fetched
   * rather than patched locally: opening a submodule adds an entry the webview
   * has never seen.
   */
  async function applyRepositoryChange(
    request: () => Promise<{ name: string; path: string }>,
  ) {
    graphRefreshGate.issue();
    graphWindowRequestGate.issue();
    loading = false;
    try {
      const result = await request();
      branches = [];
      activeRepoName = result.name;
      const repoResult = await bridge.send('repo.list') as { repos: RepoEntry[] };
      repos = repoResult.repos;
      selectedBranchFilter = null;
      clearBranchHighlight();
      selectedHash = null;
      selectedHashes = new Set();
      rightPanelOpen = false;
      detailCommit = null;
      detailFiles = null;
      await refreshGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      setTimeout(() => { error = ''; }, 5000);
    }
  }

  async function switchRepo(path: string) {
    await applyRepositoryChange(
      () => bridge.send('repo.switch', { path }) as Promise<{ name: string; path: string }>,
    );
  }

  async function openSubmodule(path: string) {
    await applyRepositoryChange(
      () => bridge.send('ui.openSubmodule', { path }) as Promise<{ name: string; path: string }>,
    );
  }

  function selectRepoOption(value: string) {
    if (value.startsWith('submodule:')) return openSubmodule(value.slice('submodule:'.length));
    if (value.startsWith('repo:')) return switchRepo(value.slice('repo:'.length));
  }
```

Thay `handleSidebarSubmoduleOpen` (dòng ~804) bằng:

```typescript
  async function handleSidebarSubmoduleOpen(event: CustomEvent<{ path: string }>) {
    await openSubmodule(event.detail.path);
  }
```

- [ ] **Step 4: Đổi markup dropdown**

Thêm derived state cạnh các khối `$:` khác trong `<script>`:

```typescript
  // Uninitialised submodules have no repository on disk to show.
  $: openableSubmodules = submodules.filter((submodule) => submodule.state !== 'uninitialized');
  $: repoOptionCount = repos.length + openableSubmodules.length;
```

Thay khối `<div class="toolbar-group" class:static={repos.length <= 1}> … </div>` (dòng ~1268-1283) bằng:

```svelte
    <div class="toolbar-group" class:static={repoOptionCount <= 1}>
      <span class="toolbar-glyph"><Icon name="repo" /></span>
      {#if repoOptionCount > 1}
        <select
          class="toolbar-select"
          aria-label="Repository"
          on:change={(e) => selectRepoOption(e.currentTarget.value)}
        >
          <optgroup label="Repositories">
            {#each repos as repo (repo.path)}
              <option value="repo:{repo.path}" selected={repo.active}>{repo.name}</option>
            {/each}
          </optgroup>
          {#if openableSubmodules.length > 0}
            <optgroup label="Submodules">
              {#each openableSubmodules as submodule (submodule.path)}
                <option value="submodule:{submodule.path}">{submodule.name}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      {:else if activeRepoName}
        <span class="repo-name">{activeRepoName}</span>
      {/if}
    </div>
```

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `npx vitest run tests/webview/app-toolbar.test.ts tests/webview/app-sidebar-actions.test.ts`
Expected: PASS. Nếu `app-sidebar-actions.test.ts` khẳng định `ui.openSubmodule` được gọi thì vẫn xanh; nếu nó khẳng định không có `repo.list` nào theo sau, cập nhật kỳ vọng cho đúng hành vi mới.

- [ ] **Step 6: Chạy toàn bộ và commit**

```bash
npm run check
git add src/webview/App.svelte tests/webview/app-toolbar.test.ts
git commit -m "feat: pick submodules from the repository dropdown"
```

---

# PHASE 2 — Chuyển xuống bottom Panel

Phụ thuộc Phase 1. Đây là phase mang lại giá trị chính.

---

### Task 4: Tách `MessageRouter` khỏi `WebviewPanel`

**Files:**
- Create: `src/extension/types/webview-host.types.ts`
- Modify: `src/extension/controllers/message-router.ts`
- Modify: `src/extension/extension.ts` (`router.setPanel(panel)` → `router.setHost(panel)`)
- Test: `tests/extension/message-router.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface WebviewHost {
    readonly webview: vscode.Webview;
    readonly onDidDispose: vscode.Event<void>;
  }
  ```
  `MessageRouter.setHost(host: WebviewHost): void` thay cho `setPanel`.

- [ ] **Step 1: Viết test thất bại**

Trong `tests/extension/message-router.test.ts`, đổi mọi lời gọi `setPanel(` thành `setHost(` và thêm test:

```typescript
  it('accepts any host exposing a webview, not just panels', async () => {
    const posted: unknown[] = [];
    const router = new MessageRouter();
    router.setHost({
      webview: {
        postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      onDidDispose: () => ({ dispose: () => undefined }),
    } as never);

    router.sendEvent('graph.invalidated');

    expect(posted).toEqual([{ type: 'event', event: 'graph.invalidated', data: undefined }]);
  });
```

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/extension/message-router.test.ts`
Expected: FAIL — `router.setHost is not a function`.

- [ ] **Step 3: Tạo interface**

`src/extension/types/webview-host.types.ts`:

```typescript
import type * as vscode from 'vscode';

/**
 * The slice of a webview container this extension actually uses. Both
 * vscode.WebviewPanel and vscode.WebviewView satisfy it structurally, so the
 * session wiring does not care which one it is running inside.
 */
export interface WebviewHost {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
}
```

- [ ] **Step 4: Đổi `MessageRouter`**

Trong `src/extension/controllers/message-router.ts`: thêm `import type { WebviewHost } from '../types/webview-host.types';`, rồi đổi field và method:

```typescript
  private host: WebviewHost | undefined;

  public setHost(host: WebviewHost): void {
    this.receiveSubscription?.dispose();
    this.host = host;

    this.receiveSubscription = host.webview.onDidReceiveMessage((message: Request) => {
      if (message.type === 'request') {
        this.handleMessage(message);
      }
    });
  }
```

Đổi `this.panel` thành `this.host` ở `sendEvent`, `dispose`, và dòng cuối `handleMessage` (`this.host?.webview.postMessage(response);`). Trong `sendEvent`, `if (this.panel)` thành `if (this.host)` và `this.panel.webview.postMessage(msg)` thành `this.host.webview.postMessage(msg)`.

Trong `src/extension/extension.ts`, đổi `router.setPanel(panel);` thành `router.setHost(panel);`.

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extension/types/webview-host.types.ts src/extension/controllers/message-router.ts src/extension/extension.ts tests/extension/message-router.test.ts
git commit -m "refactor: route messages through a WebviewHost instead of a panel"
```

---

### Task 5: Provider dựng `WebviewView` và dọn session cũ khi resolve lại

**Files:**
- Modify: `src/extension/providers/webview-provider.ts`
- Modify: `src/extension/extension.ts` (`createPanelSession` trả hàm dispose)
- Test: `tests/extension/webview-provider.test.ts`

**Interfaces:**
- Consumes: `WebviewHost` (Task 4).
- Produces:
  - `export type CreateSession = (host: WebviewHost) => () => void;` — trả về hàm dispose idempotent.
  - `GitGraphWebviewProvider implements vscode.WebviewViewProvider`, có `static readonly viewType = 'gitGraphPro.graph'` và `resolveWebviewView(view: vscode.WebviewView): void`.
  - `openPanel()`, `rootPanel` bị xoá.

- [ ] **Step 1: Viết test thất bại**

Thay toàn bộ nội dung `tests/extension/webview-provider.test.ts` bằng:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: Array<{ toString(): string } | string>) => ({
      toString: () => parts.map(String).join('/'),
    }),
  },
}));

import { GitGraphWebviewProvider } from '../../src/extension/providers/webview-provider';

interface FakeView {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: ReturnType<typeof vi.fn>;
  };
  onDidDispose: (callback: () => void) => { dispose(): void };
  disposeView: () => void;
}

function createFakeView(): FakeView {
  const disposalCallbacks: Array<() => void> = [];
  return {
    webview: {
      html: '',
      options: undefined,
      cspSource: 'test-csp',
      asWebviewUri: vi.fn((uri: { toString(): string }) => uri),
    },
    onDidDispose(callback: () => void) {
      disposalCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    disposeView() {
      for (const callback of disposalCallbacks) callback();
    },
  };
}

describe('GitGraphWebviewProvider', () => {
  let createSession: ReturnType<typeof vi.fn>;
  let disposers: Array<ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    disposers = [];
    createSession = vi.fn(() => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return dispose;
    });
  });

  it('scripts the view and hands it a session', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);
    const view = createFakeView();

    provider.resolveWebviewView(view as never);

    expect(view.webview.options).toMatchObject({ enableScripts: true });
    expect(view.webview.html).toContain('<div id="app">');
    expect(createSession).toHaveBeenCalledWith(view);
  });

  it('disposes the previous session when the view is resolved again', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);

    provider.resolveWebviewView(createFakeView() as never);
    provider.resolveWebviewView(createFakeView() as never);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(disposers[1]).not.toHaveBeenCalled();
  });

  it('disposes the session when the view itself goes away', () => {
    const provider = new GitGraphWebviewProvider({ toString: () => '/extension' } as never, createSession);
    const view = createFakeView();

    provider.resolveWebviewView(view as never);
    view.disposeView();

    expect(disposers[0]).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/extension/webview-provider.test.ts`
Expected: FAIL — `provider.resolveWebviewView is not a function`.

- [ ] **Step 3: Viết lại provider**

Thay đầu file `src/extension/providers/webview-provider.ts` (giữ nguyên `getHtmlContent` và `getNonce` phía dưới):

```typescript
import * as vscode from 'vscode';
import type { WebviewHost } from '../types/webview-host.types';

export type CreateSession = (host: WebviewHost) => () => void;

export class GitGraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gitGraphPro.graph';

  private disposeSession: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly createSession: CreateSession,
  ) {}

  /**
   * Called again every time the user hides and re-shows the view, so the
   * previous session must go first: otherwise its file watcher survives and
   * every hide/show doubles the refresh traffic.
   */
  public resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeSession?.();
    this.disposeSession = undefined;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    view.webview.html = this.getHtmlContent(view.webview);

    const dispose = this.createSession(view);
    this.disposeSession = dispose;

    view.onDidDispose(() => {
      if (this.disposeSession === dispose) this.disposeSession = undefined;
      dispose();
    });
  }
```

Xoá `openPanel()`, `rootPanel`, `createPanel()` và mọi tham chiếu `panel.iconPath` (icon của view lấy từ `viewsContainers` trong `package.json`).

- [ ] **Step 4: Cho session trả hàm dispose**

Trong `src/extension/extension.ts`, đổi `createPanelSession` thành:

```typescript
  function createSession(host: WebviewHost): () => void {
```

(thêm `import type { WebviewHost } from './types/webview-host.types';` ở đầu file, và đổi `router.setHost(panel)` thành `router.setHost(host)`)

Thay khối `panel.onDidDispose(...)` ở cuối hàm bằng:

```typescript
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      watcherGeneration += 1;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      gitWatcher?.dispose();
      gitWatcher = undefined;
      router.dispose();
    };

    host.onDidDispose(dispose);

    return dispose;
  }
```

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `npx vitest run tests/extension/webview-provider.test.ts`
Expected: PASS — 3 test.

- [ ] **Step 6: Commit**

```bash
git add src/extension/providers/webview-provider.ts src/extension/extension.ts tests/extension/webview-provider.test.ts
git commit -m "feat: serve the graph from a WebviewViewProvider"
```

---

### Task 6: Đăng ký view ở bottom Panel

**Files:**
- Modify: `package.json` (`contributes`)
- Modify: `src/extension/extension.ts` (đăng ký provider, command focus, `ViewColumn.Active`)
- Test: `tests/extension/extension-panel-session.test.ts`

**Interfaces:**
- Consumes: `GitGraphWebviewProvider.viewType`, `createSession` (Task 5).
- Produces: view `gitGraphPro.graph` trong container `gitGraphPro` ở bottom Panel; command `gitGraphPro.open` focus view đó.

- [ ] **Step 1: Viết test thất bại**

Trong `tests/extension/extension-panel-session.test.ts`, thêm:

Trước hết sửa hạ tầng của file test.

Thêm `registerWebviewViewProvider: vi.fn(),` vào `hostMocks`, và thêm dòng
`registerWebviewViewProvider: hostMocks.registerWebviewViewProvider,` vào object `window`
trong `vi.mock('vscode', ...)`. Giữ nguyên `createWebviewPanel` để còn khẳng định nó
không được gọi nữa.

Thêm factory view cạnh `fakePanel()`:

```typescript
interface FakeView {
  webview: FakePanel['webview'] & { options: unknown };
  visible: boolean;
  onDidDispose(callback: () => void): { dispose(): void };
  onDidChangeVisibility(callback: () => void): { dispose(): void };
  receive(message: Request): void;
  setVisible(next: boolean): void;
  disposeView(): void;
}

function fakeView(visible = true): FakeView {
  const disposalCallbacks: Array<() => void> = [];
  const visibilityCallbacks: Array<() => void> = [];
  let receiveMessage: ((message: Request) => void) | undefined;
  const view: FakeView = {
    webview: {
      html: '',
      options: undefined,
      cspSource: 'test-csp',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage(callback) {
        receiveMessage = callback;
        return { dispose: vi.fn() };
      },
      postMessage: vi.fn(),
    },
    visible,
    onDidDispose(callback) {
      disposalCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    onDidChangeVisibility(callback) {
      visibilityCallbacks.push(callback);
      return { dispose: vi.fn() };
    },
    receive(message) {
      receiveMessage?.(message);
    },
    setVisible(next) {
      view.visible = next;
      for (const callback of visibilityCallbacks) callback();
    },
    disposeView() {
      for (const callback of disposalCallbacks) callback();
    },
  };
  return view;
}
```

Thay `activateAndOpenRoot()` bằng:

```typescript
async function activateAndResolveView(view: FakeView = fakeView()): Promise<FakeView> {
  const subscriptions: Array<{ dispose(): unknown }> = [];
  await activate({
    extensionUri: { toString: () => '/extension' },
    globalState: {
      get: (key: string) => hostMocks.globalState.get(key),
      update: async (key: string, value: unknown) => {
        hostMocks.globalState.set(key, value);
      },
    },
    subscriptions,
  } as never);
  const provider = hostMocks.registerWebviewViewProvider.mock.calls
    .find(([viewType]) => viewType === 'gitGraphPro.graph')?.[1] as {
      resolveWebviewView(view: unknown): void;
    };
  provider.resolveWebviewView(view);
  return view;
}
```

Test `switches the session to a submodule instead of opening another panel` (Task 2) đổi
`expect(hostMocks.createWebviewPanel).toHaveBeenCalledTimes(1)` thành
`expect(hostMocks.createWebviewPanel).not.toHaveBeenCalled()`.

Trong mọi test sẵn có của file, đổi `activateAndOpenRoot()` → `activateAndResolveView()`,
biến `panel` → `view`, `panel.disposePanel()` → `view.disposeView()`, và
`responseFor(panel, ...)` → `responseFor(view, ...)` (nới kiểu tham số đầu của
`responseFor` thành `FakePanel | FakeView`). Xoá `fakePanel()`, `FakePanel` và dòng
`hostMocks.createWebviewPanel.mockImplementation(...)` trong `beforeEach` khi không còn
ai dùng.

Test mới:

```typescript
  it('registers the graph as a panel view and focuses it from the open command', async () => {
    await activateAndResolveView();

    expect(hostMocks.registerWebviewViewProvider).toHaveBeenCalledWith(
      'gitGraphPro.graph',
      expect.anything(),
      { webviewOptions: { retainContextWhenHidden: true } },
    );
    expect(hostMocks.createWebviewPanel).not.toHaveBeenCalled();

    const openCommand = hostMocks.registerCommand.mock.calls
      .find(([command]) => command === 'gitGraphPro.open')?.[1] as () => void;
    openCommand();

    expect(hostMocks.executeCommand).toHaveBeenCalledWith('gitGraphPro.graph.focus');
  });
```

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/extension/extension-panel-session.test.ts`
Expected: FAIL — `registerWebviewViewProvider` chưa được gọi.

- [ ] **Step 3: Thêm contributions vào `package.json`**

Trong `"contributes"`, thêm sau `"commands"`:

```json
    "viewsContainers": {
      "panel": [
        {
          "id": "gitGraphPro",
          "title": "Git Graph",
          "icon": "resources/icon.svg"
        }
      ]
    },
    "views": {
      "gitGraphPro": [
        {
          "type": "webview",
          "id": "gitGraphPro.graph",
          "name": "Git Graph",
          "webviewOptions": {
            "retainContextWhenHidden": true
          }
        }
      ]
    },
```

`"activationEvents": []` giữ nguyên.

- [ ] **Step 4: Đăng ký provider và đổi command**

Trong `src/extension/extension.ts`, thay khối cuối `activate`:

```typescript
  webviewProvider = new GitGraphWebviewProvider(
    context.extensionUri,
    (host) => createSession(host),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitGraphWebviewProvider.viewType,
      webviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const openCommand = vscode.commands.registerCommand('gitGraphPro.open', () => {
    void vscode.commands.executeCommand('gitGraphPro.graph.focus');
  });
  context.subscriptions.push(openCommand);
```

Trong case `'ui.openReviewDocument'`, đổi `viewColumn: vscode.ViewColumn.Beside` thành `viewColumn: vscode.ViewColumn.Active` (không còn webview nào chiếm editor group để phải né).

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Kiểm thủ công (bắt buộc — không có test tự động cho phần này)**

Bấm F5 trong VS Code để mở Extension Development Host, mở một repo có submodule, rồi xác nhận từng mục. Mỗi mục phải đo được — nghĩa là một người bất kỳ có thể nói pass/fail mà không cần đoán:

1. View ở bottom Panel cạnh Terminal/Debug Console có tab đọc đúng chữ **"Git Graph"**. (Container view trong bottom Panel hiện ra dưới dạng tiêu đề chữ, không phải icon — icon chỉ là affordance của activity bar, nên đừng tìm icon.)
2. Chuyển sang tab Terminal rồi quay lại: scroll position, commit đang chọn, kết quả AI review còn nguyên (chứng minh `retainContextWhenHidden` có hiệu lực).
3. Chuột phải tab panel → Hide, rồi bật lại qua `Git Graph Pro: Open`. Mở `Developer: Open Webview Developer Tools`, tạo **đúng một** commit mới ở repo đang mở, và đếm số request `graph.build` xuất hiện — phải là 1. (Thay thế: đếm số lần `createFileSystemWatcher` được gọi trong log extension host — cũng phải là 1 lần rebind, không nhân đôi.) Không chấp nhận đánh giá "refresh không bị nhân đôi" bằng mắt thường — hai watcher bắn cách nhau ~0ms, mắt người không phân biệt được.
4. Click submodule ở sidebar: graph đổi ngay trong view; dropdown chứa cả repo cha lẫn submodule; chọn lại repo cha thì quay về được.
5. Mở diff từ một commit: diff hiện ở khu vực editor, không đè lên graph.
6. Chạy AI review rồi bấm mở kết quả: file `.md` mở ở editor.
7. Mở một workspace KHÔNG có git repo nào, và riêng một lần nữa với multi-root workspace. Activation giờ chuyển từ "user gõ lệnh" sang "VS Code khôi phục tab panel", nên extension có thể activate ở nơi chưa từng mở graph — kể cả workspace không có repo. Xác nhận empty state hợp lý (thông báo rõ ràng), không phải một mảng lỗi đỏ.
8. Layout qua một chu kỳ hide/show: kéo panel thấp xuống cho tới khi vào compact mode, chuyển sang tab Terminal, quay lại tab Git Graph: compact mode vẫn đúng và các dòng graph vẫn lấp đầy panel (không co lại thành normal rồi phải tự chỉnh).
9. Maximise panel bằng lệnh `workbench.action.toggleMaximizedPanel`: graph lấp đầy toàn bộ chiều cao, không có dải trống, không có thanh cuộn ngang.
10. Một submodule sâu hai cấp: mở nó, quay về repo cha, rồi quay tiếp về repo gốc (root) — đây chính là ca mà danh sách "repo đã ghé qua" (visited repository list) được thiết kế để xử lý.
11. Sau khi ghé một submodule, Hide view rồi mở lại. Kết quả **kỳ vọng**: quay về đúng repo của workspace, và submodule vừa ghé biến mất khỏi nhóm "Repositories" trong dropdown. Đây là hành vi được chấp nhận, không phải bug — session được dựng lại từ danh sách repo tại thời điểm activation mỗi lần view được resolve lại.
12. Chạy `gitGraphPro.open` khi panel đã **đóng hẳn** (dùng lệnh `workbench.action.closePanel`) — đây là trạng thái khác với việc view chỉ đang bị ẩn (Hide). Xác nhận panel mở lại và graph load bình thường.
13. Thử một theme sáng mà nền panel khác nền editor (ví dụ Quiet Light, Solarized Light) — webview vẫn tô `--vscode-editor-background`, nên ghi lại nếu thấy đường ráp (seam) rõ giữa panel và webview.
14. Chuyển sang tab Terminal, tạo **vài** commit ở repo đang mở, quay lại tab Git Graph: graph cập nhật đúng **một lần** VÀ mọi commit mới đều có mặt (không thiếu, không cần refresh tay).

Ghi lại mục nào fail; sửa trước khi commit.

- [ ] **Step 7: Commit**

```bash
git add package.json src/extension/extension.ts tests/extension/extension-panel-session.test.ts
git commit -m "feat: host the graph in the bottom panel"
```

---

# PHASE 3 — Compact density

Phụ thuộc Phase 2.

---

### Task 7: Chế độ compact theo chiều cao cửa sổ

**Files:**
- Modify: `src/webview/lib/panel-layout.ts`
- Modify: `src/webview/App.svelte` (state ~164, `onMount` tracker ~226-231, root `<div class="container">` ~1254, CSS `.toolbar` 1511, `.status` 1618, `.table-header` 1715)
- Test: `tests/webview/panel-layout.test.ts`, `tests/coverage-closure.test.ts`, `tests/webview/app-panel-layout.test.ts`

**Interfaces:**
- Produces: `calculateDensity(input: { viewportHeight: number }): 'normal' | 'compact'` — `'compact'` khi `viewportHeight < 320`.

- [ ] **Step 1: Viết test thất bại cho hàm thuần**

Thêm vào `tests/webview/panel-layout.test.ts`:

```typescript
import { calculateDensity } from '../../src/webview/lib/panel-layout';

describe('calculateDensity', () => {
  it('switches to compact only below the threshold', () => {
    expect(calculateDensity({ viewportHeight: 319 })).toBe('compact');
    expect(calculateDensity({ viewportHeight: 320 })).toBe('normal');
    expect(calculateDensity({ viewportHeight: 321 })).toBe('normal');
  });
});
```

(gộp import `calculateDensity` vào dòng import `panel-layout` sẵn có thay vì thêm dòng import mới)

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/webview/panel-layout.test.ts`
Expected: FAIL — `calculateDensity is not a function`.

- [ ] **Step 3: Hiện thực hàm thuần**

Thêm vào cuối `src/webview/lib/panel-layout.ts`:

```typescript
export type PanelDensity = 'normal' | 'compact';

/**
 * Below this height the chrome costs more than it explains: in the bottom
 * Panel the toolbar and column header eat a third of the visible rows.
 */
const compactHeightThreshold = 320;

export function calculateDensity({ viewportHeight }: { viewportHeight: number }): PanelDensity {
  return viewportHeight < compactHeightThreshold ? 'compact' : 'normal';
}
```

- [ ] **Step 4: Bổ sung coverage closure**

Trong `tests/coverage-closure.test.ts`, thêm `calculateDensity` vào dòng import `panel-layout` và thêm hai assertion vào test `covers colors, scroll ranges, panel sizing, and gravatar`:

```typescript
    expect(calculateDensity({ viewportHeight: 240 })).toBe('compact');
    expect(calculateDensity({ viewportHeight: 900 })).toBe('normal');
```

- [ ] **Step 5: Viết test thất bại cho App**

Thêm vào `tests/webview/app-panel-layout.test.ts`:

Thêm helper cạnh `setViewportWidth` sẵn có:

```typescript
function setViewportHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
  fireEvent(window, new Event('resize'));
}
```

Test mới, viết theo đúng phong cách các test khác trong file (`stubState()` + `render(App)`):

```typescript
  it('goes compact when the window is too short for full chrome', async () => {
    stubState();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn(), getState: () => null, setState: vi.fn() }));
    setViewportWidth(1400);
    setViewportHeight(260);
    const { container } = render(App);

    await waitFor(() => expect(container.querySelector('.container.compact')).not.toBeNull());

    setViewportHeight(800);

    await waitFor(() => expect(container.querySelector('.container.compact')).toBeNull());
  });
```

- [ ] **Step 6: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/webview/app-panel-layout.test.ts`
Expected: FAIL — không tìm thấy `.container.compact`.

- [ ] **Step 7: Hiện thực trong App.svelte**

Thêm `calculateDensity` vào dòng import `panel-layout` sẵn có, rồi thêm state cạnh `viewportWidth` (dòng ~164):

```typescript
  let windowHeight = typeof window === 'undefined' ? 800 : window.innerHeight;

  $: density = calculateDensity({ viewportHeight: windowHeight });
```

Trong `onMount` theo dõi viewport (dòng ~226), đổi tên và mở rộng tracker:

```typescript
  onMount(() => {
    const trackViewport = () => {
      viewportWidth = window.innerWidth;
      windowHeight = window.innerHeight;
    };
    trackViewport();
    window.addEventListener('resize', trackViewport);

    return () => {
      window.removeEventListener('resize', trackViewport);
      if (panelStateSaveTimer) clearTimeout(panelStateSaveTimer);
    };
  });
```

Đổi root element (dòng ~1254):

```svelte
<div class="container" class:compact={density === 'compact'}>
```

- [ ] **Step 8: Thêm CSS compact**

Thêm vào cuối khối `<style>` của `App.svelte`:

```css
  /* The bottom Panel opens around 250px tall. Chrome that reads as breathing
     room in an editor tab costs a whole commit row down here. */
  .container.compact .toolbar {
    height: 24px;
  }

  .container.compact .status {
    display: none;
  }

  .container.compact .table-header {
    display: none;
  }

  .container.compact .right-panel-header {
    height: 24px;
  }
```

- [ ] **Step 9: Chạy test để xác nhận pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 10: Kiểm thủ công**

F5 → kéo bottom Panel xuống còn ~250px: toolbar thấp lại, hàng nhãn cột biến mất, đếm được ít nhất 7 dòng commit, không có thanh cuộn ngang. Kéo cao lên >320px: mọi thứ trở lại bình thường.

- [ ] **Step 11: Commit**

```bash
git add src/webview/lib/panel-layout.ts src/webview/App.svelte tests/webview/panel-layout.test.ts tests/webview/app-panel-layout.test.ts tests/coverage-closure.test.ts
git commit -m "feat: reclaim vertical chrome when the panel is short"
```

---

# PHASE 4 (tuỳ chọn) — Hoãn refresh khi view ẩn

Phụ thuộc Phase 2. Bỏ được nếu đo thấy không đáng kể.

---

### Task 8: Chỉ gửi event refresh khi view đang hiện

**Files:**
- Modify: `src/extension/types/webview-host.types.ts`
- Modify: `src/extension/extension.ts` (hàm `invalidate` trong `bindGitWatcher`, `createSession`)
- Test: `tests/extension/extension-panel-session.test.ts`

**Interfaces:**
- Produces: `WebviewHost` thêm hai thành viên tuỳ chọn:
  ```typescript
  readonly visible?: boolean;
  readonly onDidChangeVisibility?: vscode.Event<void>;
  ```
  Khi host đang ẩn, `git.refsChanged` + `graph.invalidated` bị hoãn và gửi đúng một lần lúc hiện lại.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `tests/extension/extension-panel-session.test.ts`:

Thêm helper đọc event đã gửi, đặt cạnh `responseFor`:

```typescript
function sentEvents(view: FakeView): string[] {
  return view.webview.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === 'event')
    .map((message) => message.event as string);
}
```

Test mới (dùng `fakeView(false)` từ Task 6 để bắt đầu ở trạng thái ẩn):

```typescript
  it('holds refresh events until the hidden view comes back', async () => {
    const view = await activateAndResolveView(fakeView(false));

    await vi.waitFor(() => expect(hostMocks.createFileSystemWatcher).toHaveBeenCalledTimes(1));
    const watcher = hostMocks.createFileSystemWatcher.mock.results[0].value;

    vi.useFakeTimers();
    watcher.fireChange();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    expect(sentEvents(view)).toEqual([]);

    view.setVisible(true);

    expect(sentEvents(view)).toEqual(['git.refsChanged', 'graph.invalidated']);

    view.setVisible(true);

    expect(sentEvents(view)).toEqual(['git.refsChanged', 'graph.invalidated']);
  });
```

- [ ] **Step 2: Chạy test để xác nhận nó fail**

Run: `npx vitest run tests/extension/extension-panel-session.test.ts`
Expected: FAIL — event được gửi ngay dù view đang ẩn.

- [ ] **Step 3: Mở rộng `WebviewHost`**

Trong `src/extension/types/webview-host.types.ts`:

```typescript
export interface WebviewHost {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
  /** A WebviewView exposes visibility; treat a host without it as always visible. */
  readonly visible?: boolean;
  readonly onDidChangeVisibility?: vscode.Event<void>;
}
```

- [ ] **Step 4: Hoãn event trong `createSession`**

Trong `src/extension/extension.ts`, thêm gần đầu `createSession` (cạnh `let disposed = false;`):

```typescript
    let refreshPending = false;

    const isVisible = () => host.visible !== false;

    /**
     * The bottom Panel shares its space with the terminal, so the graph spends
     * most of its life hidden. Running git for a view nobody is looking at is
     * pure waste — remember that it went stale and catch up on the way back.
     */
    function requestRefresh(): void {
      if (!isVisible()) {
        refreshPending = true;
        return;
      }
      router.sendEvent('git.refsChanged');
      router.sendEvent('graph.invalidated');
    }

    const visibilitySubscription = host.onDidChangeVisibility?.(() => {
      if (!isVisible() || !refreshPending) return;
      refreshPending = false;
      requestRefresh();
    });
```

Trong `bindGitWatcher`, thay thân `invalidate`:

```typescript
        const invalidate = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            session.invalidate();
            requestRefresh();
          }, 500);
        };
```

Trong hàm `dispose`, thêm trước `router.dispose();`:

```typescript
      visibilitySubscription?.dispose();
```

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Kiểm thủ công**

F5 → chuyển sang tab Terminal, tạo vài commit ở repo đang mở, quay lại tab Git Graph: graph cập nhật đúng một lần, đủ mọi commit mới.

- [ ] **Step 7: Commit**

```bash
git add src/extension/types/webview-host.types.ts src/extension/extension.ts tests/extension/extension-panel-session.test.ts
git commit -m "perf: skip graph refreshes while the view is hidden"
```

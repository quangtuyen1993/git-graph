# Git Graph trong bottom Panel — Design

Ngày: 2026-08-24

## Mục tiêu

Chuyển Git Graph Pro từ webview panel ở khu vực editor xuống **bottom Panel** của
VS Code — cùng chỗ với Terminal, Debug Console, Problems, Output — và đổi cách mở
submodule sang **dropdown chọn repo** theo mô hình GitLens.

Kết quả mong muốn: graph nằm dưới cùng như một công cụ thường trực, khu vực editor
để trống hoàn toàn cho diff và cho tài liệu review.

## Ràng buộc kỹ thuật

VS Code không cho `window.createWebviewPanel` đặt vào bottom Panel; `ViewColumn`
chỉ trỏ tới editor group. Bottom Panel bắt buộc dùng `WebviewView` đăng ký tĩnh
trong `package.json` qua `viewsContainers.panel` + `views`, và **mỗi view id chỉ
tồn tại đúng một instance**.

Đây là ràng buộc quyết định toàn bộ thiết kế: mô hình hiện tại (1 root panel + N
panel cho submodule, quản lý qua `repositoryPanels` Map) không tồn tại được ở bottom
Panel. Thay vì mô phỏng nhiều panel, ta bỏ hẳn nó và chuyển sang một view duy nhất
với dropdown chọn repo.

## Quyết định thiết kế

| Quyết định | Lựa chọn |
|---|---|
| Chỗ chứa | Một `WebviewView` duy nhất ở bottom Panel |
| Đường editor cho repo gốc | Bỏ hẳn |
| Mở submodule | `repo.switch` trong cùng view, chọn qua dropdown |
| Layout | Giữ 3 cột, thêm chế độ compact theo chiều cao |
| Chiều cao dòng graph | Không đổi (giữ 32px) |

## Kiến trúc

### Contribution points (`package.json`)

```jsonc
"viewsContainers": {
  "panel": [{ "id": "gitGraphPro", "title": "Git Graph", "icon": "resources/icon.svg" }]
},
"views": {
  "gitGraphPro": [{
    "type": "webview",
    "id": "gitGraphPro.graph",
    "name": "Git Graph",
    "webviewOptions": { "retainContextWhenHidden": true }
  }]
}
```

`activationEvents` giữ nguyên `[]`. VS Code tự suy ra `onView:gitGraphPro.graph`
từ contribution, không thêm `onStartupFinished`.

### `WebviewHost`

`MessageRouter.setPanel()` và `createPanelSession()` đang gắn chặt vào
`vscode.WebviewPanel`. Rút ra interface tối thiểu mà cả hai type đều thoả về mặt
structural typing:

```ts
export interface WebviewHost {
  webview: vscode.Webview;
  onDidDispose: vscode.Event<void>;
}
```

Không cần adapter class. `MessageRouter.setPanel(panel)` đổi tên thành
`setHost(host)`, thân hàm không đổi. `createPanelSession(panel, request)` đổi thành
`createSession(host)`, toàn bộ logic bên trong (git watcher, `ui.*`, `ai.*`, virtual
document provider) giữ nguyên.

### Thành phần

**`providers/webview-provider.ts`** — `implements vscode.WebviewViewProvider`.
- `resolveWebviewView(view)`: set `options` (`enableScripts`, `localResourceRoots`),
  set `html`, tạo session. `retainContextWhenHidden` KHÔNG thuộc `WebviewOptions`
  (đó là thành viên của `WebviewPanelOptions`, dành cho `WebviewPanel`) nên không set
  ở đây — với `WebviewView`, kênh có hiệu lực là đối số thứ ba của
  `registerWebviewViewProvider` (cộng với khoá trang trí `webviewOptions` trong
  `package.json`, xem R2).
- Giữ `getHtmlContent()` và `getNonce()` nguyên vẹn.
- **Xoá:** `openPanel()`, `rootPanel`, `openRepositoryPanel()`, `repositoryPanels`,
  `canonicalizePath`, `PanelRequest`, `CreatePanelSession`.

**`controllers/repository-session.ts`** — danh sách repo trở thành động.
- `repositories` từ `readonly RepositoryInfo[]` thành list nội bộ có thể thêm.
- `addRepository(info: RepositoryInfo): Promise<RepositoryInfo>` — canonical hoá path
  bằng `realpath` trước khi so sánh, trả về entry đã có nếu trùng.
- `allowRepositorySwitch` bị xoá; switch luôn được phép.
- `repo.list` trả về: workspace repos + repo đã ghé + (webview tự gộp submodules).

**`extension.ts`**
- `ui.openSubmodule` đổi ngữ nghĩa: `resolveSubmodule()` lấy đường dẫn tuyệt đối →
  `session.addRepository()` → `session.handleRepo('repo.switch')` → `bindGitWatcher()`
  → trả về repo mới cho webview cập nhật dropdown.
- `gitGraphPro.open` → `vscode.commands.executeCommand('gitGraphPro.graph.focus')`.
- `registerWebviewViewProvider('gitGraphPro.graph', provider, { webviewOptions: { retainContextWhenHidden: true } })`.
- `ui.openReviewDocument`: `ViewColumn.Beside` → `ViewColumn.Active` (không còn
  webview nào chiếm editor group).

**`src/webview/App.svelte`**
- Dropdown repo (đã có ở dòng ~1268) đổ thêm dữ liệu: workspace repos, submodules
  của repo đang xem (đã fetch sẵn qua `git.submoduleList`), repo đã ghé.
- Chọn submodule trong dropdown và click submodule ở sidebar dùng chung một handler.
- Theo dõi `window.innerHeight` cho compact mode.

### Luồng dữ liệu — mở submodule

```
sidebar click / dropdown select
  → ui.openSubmodule { path }
  → GitService.resolveSubmodule(path)        // absolutePath, kiểm tra initialized
  → session.addRepository({ name, path })    // realpath, dedupe
  → session.handleRepo('repo.switch')        // invalidate graph cache, đổi GitService
  → bindGitWatcher()                         // watcher trỏ sang .git của submodule
  → webview refresh: repo.list + git.* + graph.*
```

Repo đã ghé luôn nằm trong `repo.list`, nên submodule lồng nhau vẫn quay ngược về
repo cha được — trường hợp mà nếu chỉ liệt kê "submodules của repo hiện tại" sẽ bị kẹt.

## Xử lý rủi ro

**R1 — `resolveWebviewView` chạy nhiều lần.** `WebviewPanel` sinh ra một lần rồi
chết; `WebviewView` thì user ẩn view (chuột phải trên tab panel → Hide) rồi bật lại
sẽ gọi resolve **lần nữa** trên cùng provider instance. Nếu không dọn session cũ,
`FileSystemWatcher` và `MessageRouter` rò rỉ và số watcher bắn event nhân đôi mỗi
lần ẩn/hiện. Provider giữ `disposeCurrentSession` và gọi trước khi dựng session mới,
song song với listener `view.onDidDispose` sẵn có.

**R2 — `retainContextWhenHidden` là bắt buộc.** Bottom Panel dùng chung không gian
với Terminal nên user chuyển tab liên tục. Thiếu cờ này thì mỗi lần quay lại: webview
reload sạch, mất scroll, mất commit đang chọn, mất kết quả AI review, chạy lại
`git log`. Khai báo ở cả `package.json` lẫn lúc register.

**R3 — Canonical path khi thêm repo động.** Không `realpath` thì cùng một submodule
vào list hai lần với hai đường dẫn khác nhau (symlink, đường dẫn tương đối). Logic
này đã tồn tại trong provider dưới dạng `canonicalizePath`, chỉ dời sang session.

**R4 — Thời điểm activate đổi.** Trước đây extension chỉ activate khi user gõ command.
Giờ VS Code khôi phục tab panel cuối cùng lúc mở window, nên nếu user ghim tab Git
Graph thì extension activate ngay khi khởi động VS Code, kéo theo `GitService.findRepo`
cho mọi workspace folder rồi `git log`. Chấp nhận được — đó chính là điều user muốn
khi ghim tab.

**R5 — Refresh khi view đang ẩn (Phase 4, tuỳ chọn).** Git watcher bắn
`git.refsChanged` + `graph.invalidated` sau mỗi thay đổi refs. Với editor tab thì
hiếm khi ẩn; với bottom Panel thì ẩn là trạng thái mặc định phần lớn thời gian → chạy
`git log` cho view không ai nhìn. Xử lý: `onDidChangeVisibility` đánh dấu dirty khi ẩn,
gửi một event khi hiện lại.

Ba rủi ro của phương án hybrid đã bị loại bỏ hoàn toàn bằng cách bỏ đường editor:
va chạm key `layout.*` trong `globalState` giữa hai chỗ chứa có kích thước khác nhau,
`vscode.diff` mở nhầm group khi panel submodule đang active, và rò rỉ session khi có
nhiều panel song song.

## Compact layout

**Không đụng `ROW_HEIGHT`.** 32px đang hardcode ở bốn nơi độc lập:
`virtual-scroll.ts:1`, `GraphCanvas.svelte:32`, props mặc định của `CommitNode` và
`BranchLine`, và CSS row. Cho nó động nghĩa là geometry SVG (đường nối branch, tâm
node) phải khớp DOM row ở mọi giá trị — lệch 1px là đường nối trượt khỏi node. Đây là
refactor riêng, ngoài phạm vi.

Compact mode thu hồi phần chrome. Ngân sách dọc ở panel cao 250px: toolbar 32px +
`.table-header` 24px = 56px chrome, còn ~194px ≈ 6.0 dòng. Sau compact: toolbar 24px,
ẩn `.table-header` → ~226px ≈ 7.0 dòng.

```ts
// src/webview/lib/panel-layout.ts
export function calculateDensity(
  input: { viewportHeight: number }
): 'normal' | 'compact'
```

Một ngưỡng duy nhất tại 320px. Hai ngưỡng trở lên buộc phải test tổ hợp mà không đáng.
`App.svelte` theo dõi `window.innerHeight` (hiện chỉ theo dõi `innerWidth`) và gắn
`class:compact` lên root; phần còn lại là CSS thuần: chỉ bốn selector đổi —
`.toolbar` (32→24px), `.status`, `.table-header` và `.right-panel-header`. Không đụng
đường viền chia cắt hay padding của `CommitDetail`; tiêu chí số dòng vẫn đạt vì
`box-sizing: border-box` áp dụng toàn cục. Kéo panel cao lên hoặc maximize thì thoát
compact tự động — không state nào phải nhớ.

**Chiều ngang thoải mái hơn trước.** Bottom Panel rộng bằng cả workbench thay vì một
editor column. `calculatePanelLayout` giữ nguyên không sửa: nó vốn viết để co lại khi
chật, giờ đơn giản là luôn dư chỗ. `defaultPanelWidths` (260/480) vẫn hợp lý.

## Testing

Repo không có `@vscode/test-electron`; mọi test extension đều mock module `vscode`.
Nghĩa là **"view có thật sự xuất hiện cạnh Terminal" không test tự động được** — phải
kiểm thủ công bằng F5 (Run Extension).

Test tự động:

| File | Thay đổi |
|---|---|
| `tests/extension/webview-provider.test.ts` | Fake `WebviewView` thay `WebviewPanel`; thêm case resolve hai lần chứng minh session cũ được dispose (R1) |
| `tests/extension/extension-panel-session.test.ts` | Đổi sang đường resolve view; case `ui.openSubmodule` trả repo mới và `gitDirectory` được gọi lại |
| `tests/extension/repository-session.test.ts` | Thêm repo động, dedupe theo `realpath`, switch sang repo ngoài list ban đầu |
| `tests/webview/panel-layout.test.ts`, `tests/coverage-closure.test.ts` | `calculateDensity` tại 319/320/321 |
| `tests/webview/app-toolbar.test.ts` | Dropdown gộp workspace repos + submodules + repo đã ghé |
| `tests/webview/app-panel-layout.test.ts` | Class compact theo `innerHeight` |
| `tests/webview/app-sidebar-actions.test.ts` | Click submodule là switch, không mở panel |

Checklist kiểm thủ công (F5):
1. View xuất hiện cạnh Terminal/Debug Console, có icon.
2. Chuyển sang Terminal rồi quay lại: scroll, commit đang chọn, kết quả AI review còn nguyên.
3. Chuột phải tab panel → Hide, rồi bật lại: graph load bình thường, không nhân đôi refresh khi có commit mới.
4. Click submodule ở sidebar: graph đổi trong cùng view; dropdown có cả cha lẫn con; quay về cha được.
5. Mở diff từ commit: diff hiện ở editor group, không đè lên graph.
6. AI review → "Open in editor": file `.md` mở ở editor.
7. Kéo panel xuống ~250px: compact bật, không có thanh cuộn ngang.

## Roadmap

### Phase 1 — Submodule chuyển sang repo-switch

- **Deliverable:** `ui.openSubmodule` = `resolveSubmodule` → `addRepository` → `repo.switch`
  → rebind watcher. Dropdown gộp workspace repos + submodules + repo đã ghé. Xoá
  `openRepositoryPanel`, `repositoryPanels`, `PanelRequest`, nhánh `allowRepositorySwitch: false`.
- **Phụ thuộc:** không.
- **Nghiệm thu:** click submodule → graph đổi trong cùng panel, không sinh panel thứ hai;
  dropdown có cả cha lẫn con; submodule cấp 2 quay ngược về được; `npm run check` xanh.
- **Ship độc lập:** có — vẫn chạy ở editor như cũ, chỉ đổi hành vi submodule.

### Phase 2 — Chuyển xuống bottom Panel

- **Deliverable:** interface `WebviewHost`, `MessageRouter.setHost`, `resolveWebviewView`,
  contributions `viewsContainers.panel` + `views` + `retainContextWhenHidden`,
  `gitGraphPro.open` → `gitGraphPro.graph.focus`, xoá `openPanel`, dispose session cũ khi
  re-resolve, `ViewColumn.Beside` → `Active`.
- **Phụ thuộc:** Phase 1.
- **Nghiệm thu:** checklist kiểm thủ công mục 1-6; `npm run check` xanh.
- **Ship độc lập:** có — đây là phase mang lại giá trị chính.

### Phase 3 — Compact density

- **Deliverable:** `calculateDensity`, theo dõi `window.innerHeight`, CSS compact.
- **Phụ thuộc:** Phase 2.
- **Nghiệm thu:** panel ~250px hiển thị ≥7 dòng commit, không có thanh cuộn ngang;
  kéo cao lên thì trở lại bình thường.
- **Ship độc lập:** có.

### Phase 4 (tuỳ chọn) — Hoãn refresh khi view ẩn

- **Deliverable:** `onDidChangeVisibility` → đánh dấu dirty khi ẩn, gửi một event khi hiện lại.
- **Phụ thuộc:** Phase 2.
- **Ship độc lập:** có; bỏ được nếu đo thấy không đáng kể.
